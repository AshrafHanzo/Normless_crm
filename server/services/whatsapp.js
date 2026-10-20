/**
 * Talking to WhatsApp.
 *
 * Meta's Cloud API, directly — no inbox provider in between. Everything the CRM sends to a
 * customer and every file a customer sends us passes through here, so three rules live in this
 * one file rather than being remembered at each call site:
 *
 *   1. The access token never leaves it. It is not returned, not logged, not put in an error
 *      message; a token in a log file is a token somebody else can send messages with.
 *   2. Replies are only free for 24 hours after the customer's last message. Outside that window
 *      WhatsApp accepts nothing but an approved template, and a send that would be refused is
 *      stopped here with a message the person at the keyboard can act on.
 *   3. Meta's failures are described in their own words. "Message undeliverable" tells a rep
 *      nothing; "this number is not on WhatsApp" tells them to phone instead.
 *
 * Nothing here touches the database. The routes decide what to write down; this knows how to
 * speak to Meta and nothing else.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const API_VERSION = process.env.WA_API_VERSION || 'v21.0';
const GRAPH = `https://graph.facebook.com/${API_VERSION}`;
// Whose number: Crewfit's or Normless's, whichever line this work is running on (wa-line).
// A number connected from the CRM is used over the .env values, so connecting needs no deploy.
const lines = require('./wa-line');
const TOKEN = () => lines.current().token;
const PHONE_ID = () => lines.current().phoneNumberId;
const WABA_ID = () => lines.current().wabaId;

/** Where a file a customer sent us is kept. Served like every other upload in the CRM. */
const MEDIA_ROOT = path.join(__dirname, '..', 'uploads', 'whatsapp');
const MEDIA_URL = '/uploads/whatsapp';
const MAX_MEDIA_MB = 25;                    // WhatsApp's own ceiling for documents and video
const WINDOW_HOURS = 24;

/** Is the module usable at all? The page says so rather than failing one send at a time. */
const configured = () => Boolean(TOKEN() && PHONE_ID());

/**
 * A number as WhatsApp writes it: digits only, country code included.
 *
 * Indian numbers are typed every way there is — 98765 43210, +91 98765-43210, 098765 43210 — and
 * all of them are the same customer. A bare ten-digit number is assumed Indian, which is true of
 * every number this business has ever dealt with and is the only guess that can be made.
 */
function normalisePhone(value) {
    const digits = String(value ?? '').replace(/\D+/g, '');
    if (!digits) return null;
    if (digits.length === 10) return `91${digits}`;
    if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
    if (digits.length === 12 && digits.startsWith('91')) return digits;
    return digits;
}

/** The same number, written the way a person reads it. */
const prettyPhone = (phone) => {
    const d = String(phone || '');
    return d.startsWith('91') && d.length === 12 ? `+91 ${d.slice(2, 7)} ${d.slice(7)}` : `+${d}`;
};

/** Is a free-form reply still allowed on this conversation? */
function windowOpen(lastInboundAt) {
    if (!lastInboundAt) return false;
    return Date.now() - new Date(lastInboundAt).getTime() < WINDOW_HOURS * 3600 * 1000;
}

/** How long is left of it, for the warning the UI shows before it closes. */
function windowLeftMs(lastInboundAt) {
    if (!lastInboundAt) return 0;
    return Math.max(0, WINDOW_HOURS * 3600 * 1000 - (Date.now() - new Date(lastInboundAt).getTime()));
}

/**
 * What Meta's error codes mean to somebody trying to answer a customer.
 *
 * The full detail goes to the server log for us; the rep gets the sentence that tells them what
 * to do next.
 */
const ERRORS = {
    131047: 'This chat is older than 24 hours — WhatsApp only allows an approved template now.',
    131051: 'That message type cannot be sent to this number.',
    131026: 'That number is not on WhatsApp.',
    131053: 'WhatsApp could not accept that file.',
    132000: 'The template does not match what Meta approved.',
    130429: 'WhatsApp is rate-limiting us — wait a moment and send again.',
    131056: 'Too many messages to this number in a short time. Wait a little.',
    190: 'The WhatsApp access token for this number has expired — connect the number again from WhatsApp › Settings › Connect, or put a permanent System User token in the server’s .env (deploy/whatsapp-setup.md, step 7).',
};

class WhatsAppError extends Error {
    constructor(message, { code = null, status = null, detail = null } = {}) {
        super(message);
        this.name = 'WhatsAppError';
        this.code = code;
        this.status = status;
        this.detail = detail;
    }
}

/** One call to Meta. The token goes in here and nowhere else. */
async function graph(pathname, { method = 'GET', body = null, raw = false } = {}) {
    if (!configured()) throw new WhatsAppError('WhatsApp is not configured on this server');
    const res = await fetch(`${GRAPH}${pathname}`, {
        method,
        headers: {
            Authorization: `Bearer ${TOKEN()}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
    });
    if (raw) {
        if (!res.ok) throw new WhatsAppError(`WhatsApp refused that download (${res.status})`, { status: res.status });
        return res;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = data?.error || {};
        const code = err.code ?? null;
        // Logged without the token: the URL carries no secret, the Authorization header is not
        // in this object, and err.message is Meta's own text.
        console.error('whatsapp api error:', res.status, code, err.message || '');
        throw new WhatsAppError(ERRORS[code] || err.message || `WhatsApp refused that (${res.status})`,
            { code, status: res.status, detail: err.error_data?.details || null });
    }
    return data;
}

/**
 * Is the token still good? Asked of Meta at most every five minutes, so the inbox can say
 * "the token has expired" before somebody types a reply, not after.
 */
const tokenChecks = new Map();       // per line: two numbers, two tokens
async function checkToken({ fresh = false } = {}) {
    if (!configured()) return { ok: false, reason: 'not_configured', message: 'WhatsApp is not connected for this brand yet' };
    const key = lines.current().brand;
    const tokenCheck = tokenChecks.get(key) || { at: 0, result: null };
    if (!fresh && tokenCheck.result && Date.now() - tokenCheck.at < 5 * 60 * 1000) return tokenCheck.result;
    let result;
    try {
        const data = await graph(`/${PHONE_ID()}?fields=display_phone_number,verified_name`);
        result = { ok: true, number: data?.display_phone_number || null, name: data?.verified_name || null };
    } catch (err) {
        result = {
            ok: false, code: err.code || null,
            reason: err.code === 190 ? 'token_expired' : 'error',
            message: err.code === 190
                ? `The WhatsApp access token for ${lines.current().name}'s number has expired, so nothing can be sent or received. Connect the number again from WhatsApp › Settings › Connect, or put a permanent System User token in the server’s .env (deploy/whatsapp-setup.md, step 7) and restart the server.`
                : err.message,
        };
    }
    tokenChecks.set(key, { at: Date.now(), result });
    return result;
}

/** Plain text to a customer. Returns the id WhatsApp filed it under. */
async function sendText(phone, text, { preview = true } = {}) {
    const data = await graph(`/${PHONE_ID()}/messages`, {
        method: 'POST',
        body: {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: phone,
            type: 'text',
            text: { body: String(text || '').slice(0, 4096), preview_url: preview },
        },
    });
    return data?.messages?.[0]?.id || null;
}

/**
 * A file to a customer, by uploading it to Meta first.
 *
 * Two steps because Meta will not take a file and a message in one request: the file is uploaded,
 * which gives an id that is good for thirty days, and the message then refers to that id.
 */
async function sendMedia(phone, { filePath, mime, filename, caption = '' }) {
    if (String(mime).startsWith('image/')) ({ filePath, mime, filename } = await whatsappImage(filePath, mime, filename));
    const id = await uploadMedia({ filePath, mime, filename });
    const kind = mime.startsWith('image/') ? 'image'
        : mime.startsWith('video/') ? 'video'
            : mime.startsWith('audio/') ? 'audio' : 'document';
    const payload = { id };
    if (caption && kind !== 'audio') payload.caption = String(caption).slice(0, 1024);
    if (kind === 'document' && filename) payload.filename = filename;
    const data = await graph(`/${PHONE_ID()}/messages`, {
        method: 'POST',
        body: { messaging_product: 'whatsapp', recipient_type: 'individual', to: phone, type: kind, [kind]: payload },
    });
    return { wamid: data?.messages?.[0]?.id || null, kind };
}

/**
 * A photo WhatsApp will take.
 *
 * Meta accepts JPEG and PNG images up to 5MB and answers anything else — a WebP, a 9MB phone
 * photo, a PNG saved with a .jpg name — with a bare "invalid parameter". So anything that is not
 * plainly a small JPEG or PNG is re-encoded as a JPEG, longest side 2048px, before it goes.
 */
const IMAGE_OK = ['image/jpeg', 'image/png'];
const IMAGE_MAX = 4.5 * 1024 * 1024;
async function whatsappImage(filePath, mime, filename) {
    const size = (await fsp.stat(filePath)).size;
    const head = (await fsp.readFile(filePath)).subarray(0, 8);
    const isJpeg = head[0] === 0xff && head[1] === 0xd8;
    const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
    const realMime = isJpeg ? 'image/jpeg' : isPng ? 'image/png' : null;
    if (realMime && IMAGE_OK.includes(realMime) && size <= IMAGE_MAX) return { filePath, mime: realMime, filename };
    let buffer;
    try {
        buffer = await require('./resize').toBuffer(filePath, 2048, 82);
    } catch (err) {
        throw new WhatsAppError('WhatsApp only takes JPG or PNG photos, and this one could not be converted — save it as a JPG and upload it again.');
    }
    const out = path.join(MEDIA_ROOT, 'outgoing', `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.jpg`);
    await fsp.mkdir(path.dirname(out), { recursive: true });
    await fsp.writeFile(out, buffer);
    return { filePath: out, mime: 'image/jpeg', filename: String(filename || 'photo').replace(/\.[a-z0-9]+$/i, '') + '.jpg' };
}

/** Put a file on Meta's servers so a message can point at it. */
async function uploadMedia({ filePath, mime, filename }) {
    if (!configured()) throw new WhatsAppError('WhatsApp is not configured on this server');
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mime);
    form.append('file', new Blob([await fsp.readFile(filePath)], { type: mime }), filename || path.basename(filePath));
    const res = await fetch(`${GRAPH}/${PHONE_ID()}/media`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN()}` },
        body: form,
        signal: AbortSignal.timeout(60000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.id) {
        const err = data?.error || {};
        console.error('whatsapp upload error:', res.status, err.code, err.message || '');
        throw new WhatsAppError(ERRORS[err.code] || err.message || 'WhatsApp would not accept that file',
            { code: err.code ?? null, status: res.status });
    }
    return data.id;
}

/* ── Tappable replies ─────────────────────────────────────────────────────────────────────────
   WhatsApp's own limits, not ours: three buttons, twenty characters a title, ten rows in a list,
   and a body under 1024. A message that breaks any of them is refused outright, so everything is
   cut to fit here — one place, rather than hoping each flow was written carefully. */

const CAP = { buttons: 3, buttonTitle: 20, rows: 10, rowTitle: 24, rowDesc: 72, body: 1024, section: 24 };
const cut = (v, n) => String(v ?? '').trim().slice(0, n);

/** Up to three buttons under a message. */
async function sendButtons(phone, text, buttons) {
    const action = {
        buttons: (buttons || []).slice(0, CAP.buttons).map(b => ({
            type: 'reply', reply: { id: cut(b.id, 256), title: cut(b.title, CAP.buttonTitle) },
        })),
    };
    const data = await graph(`/${PHONE_ID()}/messages`, {
        method: 'POST',
        body: {
            messaging_product: 'whatsapp', recipient_type: 'individual', to: phone, type: 'interactive',
            interactive: { type: 'button', body: { text: cut(text, CAP.body) }, action },
        },
    });
    return data?.messages?.[0]?.id || null;
}

/** A menu of up to ten choices, behind one tap. */
async function sendList(phone, text, { button = 'Choose', sections = [] }) {
    let left = CAP.rows;
    const trimmed = [];
    for (const section of sections) {
        if (left <= 0) break;
        const rows = (section.rows || []).slice(0, left).map(r => ({
            id: cut(r.id, 200), title: cut(r.title, CAP.rowTitle),
            ...(r.description ? { description: cut(r.description, CAP.rowDesc) } : {}),
        }));
        left -= rows.length;
        if (rows.length) trimmed.push({ title: cut(section.title || ' ', CAP.section), rows });
    }
    const data = await graph(`/${PHONE_ID()}/messages`, {
        method: 'POST',
        body: {
            messaging_product: 'whatsapp', recipient_type: 'individual', to: phone, type: 'interactive',
            interactive: {
                type: 'list', body: { text: cut(text, CAP.body) },
                action: { button: cut(button, CAP.buttonTitle), sections: trimmed },
            },
        },
    });
    return data?.messages?.[0]?.id || null;
}

/* ── Approved templates ───────────────────────────────────────────────────────────────────────
   The only thing WhatsApp will carry once a customer has been quiet for a day. The text is
   Meta's, approved in advance; all we supply are the values that go in the gaps. */

/** Everything the business account has, as Meta has it. */
async function fetchTemplates() {
    const waba = WABA_ID();
    if (!waba) throw new WhatsAppError('This number has no WhatsApp business account id — connect it from WhatsApp settings');
    const out = [];
    let after = null;
    do {
        const page = await graph(`/${waba}/message_templates?limit=100${after ? `&after=${after}` : ''}`);
        for (const t of page?.data || []) {
            const body = (t.components || []).find(c => c.type === 'BODY');
            const header = (t.components || []).find(c => c.type === 'HEADER');
            const text = body?.text || '';
            // {{1}}, {{2}} … how many values a rep has to supply before this can be sent.
            const variables = new Set((text.match(/\{\{\s*(\d+)\s*\}\}/g) || [])
                .map(m => m.replace(/\D/g, ''))).size;
            out.push({
                name: t.name, language: t.language, category: t.category, status: t.status,
                body_text: text, variables, header_kind: header?.format || null,
            });
        }
        after = page?.paging?.cursors?.after && page?.paging?.next ? page.paging.cursors.after : null;
    } while (after);
    return out;
}

/**
 * Send one of them.
 *
 * Values go in positionally, which is how Meta reads them: the first value fills {{1}}. A missing
 * value is refused by Meta rather than sent with a gap in it, so they are checked before sending.
 */
async function sendTemplate(phone, { name, language = 'en_US', variables = [] }) {
    const components = variables.length
        ? [{ type: 'body', parameters: variables.map(v => ({ type: 'text', text: String(v ?? '').slice(0, 1024) })) }]
        : [];
    const data = await graph(`/${PHONE_ID()}/messages`, {
        method: 'POST',
        body: {
            messaging_product: 'whatsapp', recipient_type: 'individual', to: phone, type: 'template',
            template: { name, language: { code: language }, ...(components.length ? { components } : {}) },
        },
    });
    return data?.messages?.[0]?.id || null;
}

/**
 * Ask Meta to approve a new template. It comes back PENDING; a sync later shows the verdict.
 *
 * Meta wants an example for every {{n}} in the body before it will review one, so the examples
 * are sent with it — the wording a reviewer reads is the wording a customer would.
 */
async function createTemplate({ name, language, category, body, examples = [], buttons = [] }) {
    const waba = WABA_ID();
    if (!waba) throw new WhatsAppError('This number has no WhatsApp business account id — connect it from WhatsApp settings');
    const components = [{
        type: 'BODY', text: body,
        ...(examples.length ? { example: { body_text: [examples] } } : {}),
    }];
    if (buttons.length) {
        components.push({ type: 'BUTTONS', buttons: buttons.map(text => ({ type: 'QUICK_REPLY', text })) });
    }
    const data = await graph(`/${waba}/message_templates`, {
        method: 'POST', body: { name, language, category, components },
    });
    return { id: data?.id || null, status: data?.status || 'PENDING' };
}

/** The approved text with the values filled in, for the record of what was actually said. */
function renderTemplate(bodyText, variables = []) {
    return String(bodyText || '').replace(/\{\{\s*(\d+)\s*\}\}/g,
        (_, n) => String(variables[Number(n) - 1] ?? `{{${n}}}`));
}

/**
 * Fetch something a customer sent.
 *
 * It arrives as an id, not a file: the id is exchanged for a URL, and that URL only answers to
 * our own access token, which is why media cannot simply be linked to from the browser. It is
 * downloaded once, kept with the rest of the CRM's uploads, and served from there afterwards.
 */
async function downloadMedia(mediaId, conversationId) {
    const meta = await graph(`/${mediaId}`);
    const size = Number(meta?.file_size || 0);
    if (size > MAX_MEDIA_MB * 1024 * 1024) {
        throw new WhatsAppError(`That file is larger than ${MAX_MEDIA_MB}MB`);
    }
    const res = await graph(new URL(meta.url).pathname + new URL(meta.url).search, { raw: true })
        .catch(async () => {
            // The URL Meta hands back is a full address on a different host, so it is fetched
            // directly rather than through the Graph helper — still with our token.
            const direct = await fetch(meta.url, {
                headers: { Authorization: `Bearer ${TOKEN()}` },
                signal: AbortSignal.timeout(60000),
            });
            if (!direct.ok) throw new WhatsAppError(`Could not download that file (${direct.status})`);
            return direct;
        });

    const mime = meta.mime_type || res.headers.get('content-type') || 'application/octet-stream';
    const ext = (mime.split('/')[1] || 'bin').split(';')[0].replace(/[^a-z0-9]/gi, '').slice(0, 8);
    const dir = path.join(MEDIA_ROOT, String(conversationId));
    await fsp.mkdir(dir, { recursive: true });
    const name = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}.${ext}`;
    const buf = Buffer.from(await res.arrayBuffer());
    await fsp.writeFile(path.join(dir, name), buf);
    return { url: `${MEDIA_URL}/${conversationId}/${name}`, mime, bytes: buf.length, sha256: meta.sha256 || null };
}

/** Blue ticks on the customer's phone, so they can see somebody has read it. */
async function markRead(wamid) {
    try {
        await graph(`/${PHONE_ID()}/messages`, {
            method: 'POST',
            body: { messaging_product: 'whatsapp', status: 'read', message_id: wamid },
        });
    } catch (err) {
        // Never worth failing anything over: the message is read whether or not Meta agrees.
        console.warn('whatsapp mark-read failed:', err.message);
    }
}

/**
 * Is this webhook really from Meta?
 *
 * The body is signed with the app secret. Without this check the endpoint is a public hole that
 * anyone who finds the URL can post invented customer messages into.
 */
function verifySignature(rawBody, header) {
    const secret = process.env.WA_APP_SECRET;
    if (!secret) return { ok: false, reason: 'WA_APP_SECRET is not set' };
    if (!rawBody || !header) return { ok: false, reason: 'unsigned request' };
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(String(header));
    // Same length first: timingSafeEqual throws on a mismatch, and the throw itself would leak
    // that much about the signature.
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    return { ok, reason: ok ? null : 'signature did not match' };
}

module.exports = {
    configured, checkToken, phoneNumberId: PHONE_ID, wabaId: WABA_ID, graph, GRAPH, normalisePhone, prettyPhone, windowOpen, windowLeftMs,
    sendText, sendMedia, sendButtons, sendList, createTemplate, downloadMedia, markRead, verifySignature, CAP,
    fetchTemplates, sendTemplate, renderTemplate, whatsappImage,
    WhatsAppError, MEDIA_ROOT, MAX_MEDIA_MB, WINDOW_HOURS,
};
