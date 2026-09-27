/**
 * The Telegram side of backups: signing in, finding somewhere to put the archives, and moving
 * bytes in and out.
 *
 * MTProto through GramJS, as a *user* account rather than a bot. That choice is forced by size:
 * the Bot API caps an upload at 50 MB, and this CRM's uploads folder alone is 924 MB — it would
 * take nineteen pieces per run and a bot cannot read them back out again reliably. A user session
 * gets 2 GB per document (4 GB on Premium) and unlimited total storage.
 *
 * Archives land in a dedicated private channel, created by us on first setup, rather than in
 * Saved Messages. Saved Messages is somewhere people keep their own things; filling it with
 * nightly archives buries them, and pruning old backups there risks deleting something personal.
 * A channel also survives the account being used normally and keeps message ids stable.
 *
 * Only ciphertext ever reaches this module — see crypto.js.
 */

const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { computeCheck } = require('telegram/Password');
const { CustomFile } = require('telegram/client/uploads');
// GramJS represents Telegram's 64-bit `long` with big-integer, not the language's own BigInt.
// Native BigInt happens to serialise correctly but lacks the methods (.eq, .compare) the library
// calls on these values elsewhere, so ids are built with the type the library expects.
const bigInt = require('big-integer');
const fs = require('fs');
const path = require('path');

// GramJS logs every MTProto packet at info level, which drowns the app's own output.
const { Logger } = require('telegram/extensions');
const LOG_LEVEL = process.env.TELEGRAM_LOG_LEVEL || 'error';

// Telegram's hard per-document ceiling. Not a setting — the server rejects anything larger.
const MAX_FILE_FREE = 2 * 1024 * 1024 * 1024;
const MAX_FILE_PREMIUM = 4 * 1024 * 1024 * 1024;

const CHANNEL_TITLE = 'Normless CRM Backups';
const CHANNEL_ABOUT = 'Encrypted automatic backups of the Normless / Crewfit CRM. Do not delete — these are the only off-server copies.';

function makeClient(sessionString, apiId, apiHash) {
    const client = new TelegramClient(new StringSession(sessionString || ''), Number(apiId), String(apiHash), {
        connectionRetries: 5,
        retryDelay: 2000,
        // A 924 MB upload on a slow line takes a while; do not give up on it early.
        timeout: 120,
        useWSS: false,
        baseLogger: new Logger(LOG_LEVEL),
    });
    return client;
}

/* ─────────────────────────── sign-in, in three steps ───────────────────────────

   The browser drives this over three separate HTTP requests, so the half-authenticated client
   has to stay alive between them. It is held here, in memory, keyed by a short-lived token.
   Deliberately not persisted: an interrupted sign-in should expire, not linger on disk.
------------------------------------------------------------------------------- */

const pending = new Map();
const PENDING_TTL_MS = 10 * 60 * 1000;

function reapPending() {
    const now = Date.now();
    for (const [k, v] of pending) {
        if (now - v.startedAt > PENDING_TTL_MS) {
            v.client?.disconnect?.().catch(() => {});
            pending.delete(k);
        }
    }
}

/** Step 1 — ask Telegram to send the login code. */
async function startLogin({ apiId, apiHash, phone }) {
    reapPending();
    const client = makeClient('', apiId, apiHash);
    await client.connect();

    let sent;
    try {
        sent = await client.sendCode({ apiId: Number(apiId), apiHash: String(apiHash) }, String(phone));
    } catch (err) {
        await client.disconnect().catch(() => {});
        throw new Error(friendlyError(err));
    }

    const token = require('crypto').randomBytes(16).toString('hex');
    pending.set(token, { client, apiId, apiHash, phone, phoneCodeHash: sent.phoneCodeHash, startedAt: Date.now() });
    return { token, viaApp: !!sent.isCodeViaApp };
}

/**
 * Step 2 — submit the code.
 *
 * An account with two-factor enabled answers SESSION_PASSWORD_NEEDED here. That is not a failure:
 * the sign-in is paused, the pending client is kept, and the caller is told to ask for the
 * password.
 */
async function submitCode({ token, code }) {
    const p = pending.get(token);
    if (!p) throw new Error('This sign-in expired. Start again.');

    try {
        await p.client.invoke(new Api.auth.SignIn({
            phoneNumber: String(p.phone),
            phoneCodeHash: p.phoneCodeHash,
            phoneCode: String(code).trim(),
        }));
    } catch (err) {
        if (String(err?.errorMessage || err?.message || '').includes('SESSION_PASSWORD_NEEDED')) {
            return { needsPassword: true };
        }
        throw new Error(friendlyError(err));
    }
    return finishLogin(token);
}

/** Step 2b — the two-factor password, checked via SRP so it never crosses the wire in the clear. */
async function submitPassword({ token, password }) {
    const p = pending.get(token);
    if (!p) throw new Error('This sign-in expired. Start again.');
    try {
        const info = await p.client.invoke(new Api.account.GetPassword());
        await p.client.invoke(new Api.auth.CheckPassword({ password: await computeCheck(info, String(password)) }));
    } catch (err) {
        throw new Error(friendlyError(err));
    }
    return finishLogin(token);
}

/** Step 3 — hand back the session string the caller will encrypt and store. */
async function finishLogin(token) {
    const p = pending.get(token);
    if (!p) throw new Error('This sign-in expired. Start again.');
    const me = await p.client.getMe();
    const session = p.client.session.save();
    await p.client.disconnect().catch(() => {});
    pending.delete(token);
    return {
        session,
        user: {
            id: String(me.id),
            username: me.username || null,
            phone: me.phone || null,
            name: [me.firstName, me.lastName].filter(Boolean).join(' ') || null,
            premium: !!me.premium,
        },
    };
}

function cancelLogin(token) {
    const p = pending.get(token);
    if (p) { p.client?.disconnect?.().catch(() => {}); pending.delete(token); }
}

/* ─────────────────────────── connected operations ─────────────────────────── */

/**
 * Run `fn` against a connected client, then disconnect.
 *
 * A fresh connection per operation rather than a long-lived one: a backup runs a few times a day,
 * and a socket held open for hours between runs is a socket that has silently died by the time it
 * is needed. Connecting costs about a second.
 */
async function withClient({ session, apiId, apiHash }, fn) {
    if (!session) throw new Error('Telegram is not connected');
    const client = makeClient(session, apiId, apiHash);
    try {
        await client.connect();
        if (!(await client.checkAuthorization())) {
            throw new Error('The saved Telegram session is no longer valid — reconnect the account.');
        }
        return await fn(client);
    } finally {
        await client.disconnect().catch(() => {});
    }
}

/** Who the stored session belongs to, and whether it still works. */
async function whoAmI(creds) {
    return withClient(creds, async (client) => {
        const me = await client.getMe();
        return {
            id: String(me.id),
            username: me.username || null,
            phone: me.phone || null,
            name: [me.firstName, me.lastName].filter(Boolean).join(' ') || null,
            premium: !!me.premium,
            maxFileSize: me.premium ? MAX_FILE_PREMIUM : MAX_FILE_FREE,
        };
    });
}

/** Create the backup channel. Returns its id and access hash. */
async function createChannel(creds, title = CHANNEL_TITLE) {
    return withClient(creds, async (client) => {
        const res = await client.invoke(new Api.channels.CreateChannel({
            title, about: CHANNEL_ABOUT, broadcast: true, megagroup: false,
        }));
        const chan = res.chats?.[0];
        if (!chan) throw new Error('Telegram did not return the new channel');
        return { id: String(chan.id), accessHash: String(chan.accessHash), title: chan.title };
    });
}

/** The channel as an entity GramJS can send to. */
function channelPeer(cfg) {
    return new Api.InputPeerChannel({
        channelId: bigInt(String(cfg.channel_id)),
        accessHash: bigInt(String(cfg.channel_access_hash)),
    });
}

/**
 * Upload one file and return the message id it landed in.
 *
 * `forceDocument` keeps Telegram from re-encoding anything it mistakes for a photo or video —
 * which for an encrypted archive would silently destroy it.
 */
async function uploadFile(creds, cfg, { filePath, caption, onProgress }) {
    return withClient(creds, async (client) => {
        const name = path.basename(filePath);
        const size = fs.statSync(filePath).size;
        const file = new CustomFile(name, size, filePath);

        const msg = await client.sendFile(channelPeer(cfg), {
            file,
            caption: caption ? caption.slice(0, 1024) : undefined,
            forceDocument: true,
            // Parallel connections for the upload. More is faster up to a point; past four it
            // mostly buys rate-limit warnings.
            workers: 4,
            progressCallback: onProgress ? (downloaded, total) => {
                try { onProgress(Number(downloaded), Number(total) || size); } catch { /* reporting must never fail an upload */ }
            } : undefined,
        });
        return { messageId: msg.id, size };
    });
}

/** Download the document from a message id back to `outPath`. */
async function downloadMessage(creds, cfg, { messageId, outPath, onProgress }) {
    return withClient(creds, async (client) => {
        const msgs = await client.getMessages(channelPeer(cfg), { ids: [Number(messageId)] });
        const msg = msgs?.[0];
        if (!msg || !msg.media) throw new Error(`Backup message ${messageId} is gone from the channel`);

        const buf = await client.downloadMedia(msg, {
            outputFile: outPath,
            progressCallback: onProgress ? (d, t) => { try { onProgress(Number(d), Number(t)); } catch { /* ignore */ } } : undefined,
        });
        // downloadMedia writes to outputFile and returns undefined for a path target; when it
        // hands back a buffer instead, write it ourselves so the caller always gets a file.
        if (buf && Buffer.isBuffer(buf)) fs.writeFileSync(outPath, buf);
        return outPath;
    });
}

/** Delete messages from the channel — how retention actually frees anything. */
async function deleteMessages(creds, cfg, messageIds) {
    if (!messageIds?.length) return 0;
    return withClient(creds, async (client) => {
        let done = 0;
        // Telegram caps a delete call at 100 ids.
        for (let i = 0; i < messageIds.length; i += 100) {
            const batch = messageIds.slice(i, i + 100).map(Number);
            await client.invoke(new Api.channels.DeleteMessages({ channel: channelPeer(cfg), id: batch }));
            done += batch.length;
        }
        return done;
    });
}

/**
 * Telegram's errors are shouty constants; these are the ones a person setting this up will
 * actually hit, in words that say what to do about it.
 */
function friendlyError(err) {
    const m = String(err?.errorMessage || err?.message || err || '');
    if (m.includes('PHONE_NUMBER_INVALID')) return 'That phone number is not valid. Include the country code, e.g. +919876543210.';
    if (m.includes('PHONE_CODE_INVALID')) return 'That code is wrong. Check the digits and try again.';
    if (m.includes('PHONE_CODE_EXPIRED')) return 'That code expired. Start the sign-in again.';
    if (m.includes('PHONE_CODE_EMPTY')) return 'Enter the code Telegram sent you.';
    if (m.includes('PASSWORD_HASH_INVALID')) return 'That two-factor password is wrong.';
    if (m.includes('API_ID_INVALID')) return 'The API ID / API hash pair is not valid. Check both at my.telegram.org.';
    if (m.includes('PHONE_NUMBER_BANNED')) return 'Telegram has banned this number.';
    if (m.includes('AUTH_KEY_UNREGISTERED')) return 'This session was signed out from Telegram. Reconnect the account.';
    const flood = m.match(/FLOOD_WAIT_(\d+)/);
    if (flood) {
        const s = parseInt(flood[1], 10);
        return `Telegram is rate-limiting this account. Wait ${s > 90 ? `${Math.ceil(s / 60)} minutes` : `${s} seconds`} and try again.`;
    }
    return m || 'Telegram request failed';
}

module.exports = {
    startLogin, submitCode, submitPassword, cancelLogin,
    withClient, whoAmI, createChannel, uploadFile, downloadMessage, deleteMessages,
    friendlyError, channelPeer,
    MAX_FILE_FREE, MAX_FILE_PREMIUM, CHANNEL_TITLE,
};
