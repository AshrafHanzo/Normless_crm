/**
 * The WhatsApp inbox.
 *
 * Two halves that share nothing but the tables. The webhook is public — Meta calls it, nobody
 * signs in — and is therefore the most carefully guarded thing in the CRM: every POST is checked
 * against the app secret before a word of it is believed, and every message is keyed by the id
 * WhatsApp gave it so a retry cannot write the same message down twice. The inbox API behind it
 * is ordinary CRM work: list the threads, read one, send a reply.
 *
 * Who sees what: a rep sees the conversations assigned to them and the ones nobody has taken;
 * somebody with `can_manage_whatsapp` sees all of them and can move them between people. That
 * split is enforced in SQL on every route rather than hidden in the page, because the page is
 * not what protects a customer's conversation.
 *
 * Meta's rule about the 24-hour window is the one piece of WhatsApp's own policy that shows up
 * in the product: outside it only an approved template may be sent. The send route refuses
 * rather than letting Meta refuse, so the rep is told before they type the message.
 */

const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db/connection');
const { hasPermission } = require('../utils/permissions');
const wa = require('../services/whatsapp');
const flow = require('../services/wa-flow');
const ai = require('../services/wa-ai');
const routing = require('../services/wa-routing');
const orders = require('../services/wa-orders');
const extras = require('../services/wa-extras');
const billing = require('../services/wa-billing');
const connectSvc = require('../services/wa-connect');
const lines = require('../services/wa-line');
const nlShop = require('../services/nl-shop');
const nlBot = require('../services/nl-bot');
const openers = require('../services/wa-openers');
const nlHandover = require('../services/nl-handover');
const calls = require('../services/wa-calls');

const router = express.Router();

const trim = (v) => { const t = String(v ?? '').trim(); return t || null; };
const safeJson = (v, fallback) => {
    try { return typeof v === 'string' ? (JSON.parse(v || 'null') ?? fallback) : (v || fallback); }
    catch { return fallback; }
};

/* ════════════════════════════════════════════════════════════════════════════════════════════
   The webhook — public, and treated as hostile until it proves otherwise
   ════════════════════════════════════════════════════════════════════════════════════════════ */

const webhook = express.Router();

/**
 * Meta's one-off check when the webhook URL is saved in the app dashboard. It sends a token we
 * chose and a challenge; echoing the challenge back proves we own the endpoint.
 */
webhook.get('/', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token && token === process.env.WA_VERIFY_TOKEN) {
        console.log('whatsapp webhook verified by Meta');
        return res.status(200).send(String(challenge ?? ''));
    }
    console.warn('whatsapp webhook verification refused');
    res.sendStatus(403);
});

/**
 * Everything that happens on the number: messages in, and what became of messages out.
 *
 * Answered immediately and processed afterwards. Meta waits a few seconds for a 200 and resends
 * the whole batch if it does not get one — so doing the work first means a slow media download
 * turns one customer message into four.
 */
webhook.post('/', async (req, res) => {
    const check = wa.verifySignature(req.rawBody, req.get('X-Hub-Signature-256'));
    if (!check.ok) {
        console.warn('whatsapp webhook rejected:', check.reason);
        return res.sendStatus(403);
    }
    res.sendStatus(200);

    try {
        await handleEvent(req.body);
    } catch (err) {
        // Nothing to answer to any more — the log is the only place this can be seen.
        console.error('whatsapp webhook processing failed:', err.message);
    }
});

/**
 * One webhook body: any number of entries, each with any number of changes.
 *
 * Each change is handled on the line of the number it happened on — Crewfit's or Normless's —
 * so the thread, the reply and the media download all use that number. A change for a number
 * this CRM does not carry is dropped: guessing would put one brand's customer in the other's inbox.
 */
async function handleEvent(body) {
    await lines.ready();
    for (const entry of body?.entry || []) {
        for (const change of entry?.changes || []) {
            const value = change?.value || {};
            const line = lines.forWebhook(value?.metadata?.phone_number_id, entry?.id);
            if (!line?.id) {
                console.warn('whatsapp webhook for a number no line carries:', value?.metadata?.phone_number_id || entry?.id || '?');
                continue;
            }
            await lines.run(line, () => handleChange(change, value));
        }
    }
}

async function handleChange(change, value) {
    // Coexistence: the phone app's own traffic, the imported history, its contacts, and
    // the account's connection changing. Each is its own webhook field.
    if (change.field === 'smb_message_echoes') {
        for (const echo of value.message_echoes || []) await receiveEcho(echo);
        return;
    }
    // One at a time: Meta sends the chunks close together, and each one adds to the same
    // running count. Handled side by side, two chunks each read the old count and the
    // second write lost the first — the import said 3 messages where 4 had come in.
    // The queue runs each job on the line it was queued from, not the line of whatever
    // happened to be first in the queue.
    const line = lines.current();
    if (change.field === 'history') { await inTurn(() => lines.run(line, () => receiveHistory(value))); return; }
    if (change.field === 'smb_app_state_sync') { await inTurn(() => lines.run(line, () => receiveContacts(value))); return; }
    if (change.field === 'account_update') { await connectSvc.accountUpdate(value); return; }
    // Voice calls: their own field, with their own `statuses` that are not message ticks.
    if (change.field === 'calls') {
        await calls.receive(value, { threadFor: (phone, name) => threadFor(phone, name, null) });
        return;
    }
    const profileByPhone = new Map(
        (value.contacts || []).map(c => [c.wa_id, c?.profile?.name || null]));

    for (const message of value.messages || []) {
        await receiveMessage(message, profileByPhone.get(message.from) || null);
    }
    for (const status of value.statuses || []) {
        await receiveStatus(status);
    }
}

/** Is the work in hand on Crewfit's line? Leads, the menu, the assistant and billing are Crewfit's. */
const onCrewfit = () => lines.current().brand === 'crewfit';
const lineId = () => lines.current().id;

/** The text of a message, whatever kind it is — what the inbox list shows as a preview. */
function describe(message) {
    switch (message.type) {
        case 'text': return message.text?.body || '';
        case 'button': return message.button?.text || '';
        case 'interactive':
            if (message.interactive?.type === 'call_permission_reply') {
                return calls.describePermissionReply(message.interactive.call_permission_reply);
            }
            return message.interactive?.button_reply?.title
                || message.interactive?.list_reply?.title || '';
        case 'image': return message.image?.caption || '📷 Photo';
        case 'document': return message.document?.caption || `📄 ${message.document?.filename || 'Document'}`;
        case 'audio': return '🎤 Voice message';
        case 'video': return message.video?.caption || '🎬 Video';
        case 'sticker': return 'Sticker';
        case 'location': return `📍 ${message.location?.name || 'Location'}`;
        case 'contacts': return '👤 Contact card';
        default: return message.type;
    }
}

/** The reply a customer tapped, kept as structure so a flow can read it later. */
function interactivePayload(message) {
    if (message.type === 'interactive') {
        const i = message.interactive || {};
        const r = i.button_reply || i.list_reply;
        return r ? { kind: i.type, id: r.id, title: r.title, description: r.description || null } : null;
    }
    if (message.type === 'button') {
        return { kind: 'template_button', id: message.button?.payload || null, title: message.button?.text || null };
    }
    if (message.type === 'location') {
        const l = message.location || {};
        return { kind: 'location', latitude: l.latitude, longitude: l.longitude, name: l.name || null, address: l.address || null };
    }
    return null;
}

const MEDIA_TYPES = ['image', 'document', 'audio', 'video', 'sticker'];

/**
 * A customer's message, written down.
 *
 * The insert carries the WhatsApp id and does nothing on conflict, so a resent webhook stops
 * here: everything after this point — the unread count, the file download — happens once.
 */
async function receiveMessage(message, profileName) {
    const phone = wa.normalisePhone(message.from);
    if (!phone || !message.id) return;

    const { conversation } = await threadFor(phone, profileName, message.referral || null);

    const inserted = await db.query(
        `INSERT INTO wa_messages (conversation_id, wamid, direction, sender_type, type, body,
                                  interactive_payload, status, sent_at)
         VALUES ($1,$2,'in','customer',$3,$4,$5,'delivered',
                 COALESCE(TO_TIMESTAMP($6::bigint), CURRENT_TIMESTAMP))
         ON CONFLICT (wamid) DO NOTHING
         RETURNING id`,
        [conversation.id, message.id, message.type || 'text', describe(message),
            JSON.stringify(interactivePayload(message)), message.timestamp ? Number(message.timestamp) : null]);

    if (!inserted.rows[0]) return;     // Meta sent it twice; the first one is already here
    const messageId = inserted.rows[0].id;
    // Was this the opening message? Only then does a menu start; mid-conversation it would be
    // an interruption.
    const isFirst = (await db.query(
        `SELECT COUNT(*)::int n FROM wa_messages WHERE conversation_id = $1 AND direction = 'in' AND type <> 'call'`,
        [conversation.id])).rows[0].n <= 1;

    await db.query(
        `UPDATE wa_conversations
            SET last_inbound_at = CURRENT_TIMESTAMP, last_message_at = CURRENT_TIMESTAMP,
                last_message_preview = $2, unread_count = unread_count + 1,
                status = 'open', updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [conversation.id, (describe(message) || '').slice(0, 200)]);

    // The file itself, fetched after the row exists: a failed download leaves a message saying
    // a photo arrived, which is far better than losing the message with it.
    let mediaUrl = null;
    if (MEDIA_TYPES.includes(message.type)) {
        const media = message[message.type] || {};
        try {
            const file = await wa.downloadMedia(media.id, conversation.id);
            mediaUrl = file.url;
            await db.query(
                `UPDATE wa_messages SET media_url = $2, media_mime = $3, media_name = $4 WHERE id = $1`,
                [messageId, file.url, file.mime, media.filename || null]);
        } catch (err) {
            console.error('whatsapp media download failed:', err.message);
            await db.query(`UPDATE wa_messages SET error = $2 WHERE id = $1`,
                [messageId, 'The file could not be downloaded from WhatsApp']);
        }
    }

    wa.markRead(message.id);          // not awaited: blue ticks are not worth a delay

    // Allow / Don't allow on a call permission request: written down, never answered by a bot.
    if (message.interactive?.type === 'call_permission_reply') return;

    // STOP / START, or a marketing message's "Stop promotions" button, on either number: no more
    // offers or broadcasts to them (order updates still go).
    try { if (await require('../services/nl-automations').onOptOut(conversation.id, message)) return; }
    catch (err) { console.error('whatsapp opt-out error:', err.message); }

    // Normless has its own bot (nl-bot); Crewfit's menu, assistant and away message must never
    // answer a Normless customer.
    if (!onCrewfit()) {
        // A Confirm/Cancel tap on the COD confirmation is answered here, not by the bot.
        try {
            const nlAuto = require('../services/nl-automations');
            if (await nlAuto.onReply(conversation.id, interactivePayload(message))) return;
        }
        catch (err) { console.error('normless automation reply error:', err.message); }
        try { await nlBot.onInbound({ id: conversation.id, phone }); }
        catch (err) { console.error('normless bot error:', err.message); }
        return;
    }

    // The menu, if one is switched on. It answers the opening questions and hands over when it
    // stops being useful; a conversation a person has taken is never interrupted by it.
    try {
        const fresh = (await db.query(
            `SELECT c.*, k.phone, k.lead_id FROM wa_conversations c
               JOIN wa_contacts k ON k.id = c.contact_id WHERE c.id = $1`, [conversation.id])).rows[0];
        // A customer typing MENU (or whatever words the shop chose) gets the menu again, as long
        // as a person is not in the middle of answering them.
        const keyword = fresh?.mode === 'human' && !isFirst && await isMenuKeyword(describe(message));
        if (fresh?.mode === 'billing') {
            await billing.handle(fresh, { body: describe(message) });
        } else if (keyword) {
            await flow.start(fresh);
        } else if (fresh?.mode === 'flow') {
            const dealt = await flow.handle(fresh, {
                body: describe(message),
                interactive_payload: interactivePayload(message),
                media_url: mediaUrl,
            });
            // The menu gave up on this one. If the assistant is on, it takes over rather than
            // leaving the customer waiting for somebody to notice.
            const now = (await db.query('SELECT mode FROM wa_conversations WHERE id = $1', [conversation.id])).rows[0];
            if (dealt && now?.mode === 'human' && await ai.enabled()) {
                await db.query(`UPDATE wa_conversations SET mode = 'ai' WHERE id = $1`, [conversation.id]);
                await ai.reply({ ...fresh, mode: 'ai' });
            }
        } else if (fresh?.mode === 'ai') {
            await ai.reply(fresh);
        } else if (isFirst && fresh?.mode === 'human' && !fresh.flow_id) {
            const started = await flow.start(fresh, { evenIfOff: await extras.menuAfterHours() });
            // No menu switched on, but an assistant that is: it answers from the first message.
            if (!started && await ai.enabled()) {
                await db.query(`UPDATE wa_conversations SET mode = 'ai' WHERE id = $1`, [conversation.id]);
                await ai.reply({ ...fresh, mode: 'ai' });
            }
        }
    } catch (err) {
        // A broken menu must never swallow a customer's message: it is already written down.
        console.error('whatsapp flow error:', err.message);
    }

    // Crewfit's helper: a lead that sends its logo, a quantity, billing details or names a product is
    // marked Qualified; and while nobody has the chat, product questions are answered from the
    // catalogue (cf-assist). It stays out of chats the menu or a person is handling.
    await require('../services/cf-assist').onInbound(conversation.id, message, { text: describe(message), mediaUrl });

    // A customer now waiting for a person, outside working hours, is told when somebody is back.
    try {
        const now = (await db.query('SELECT mode FROM wa_conversations WHERE id = $1', [conversation.id])).rows[0];
        if (now?.mode === 'human') await extras.maybeSendAway(conversation);
    } catch (err) {
        console.error('whatsapp away message error:', err.message);
    }

    // A tapped menu option may send the conversation to a particular team.
    const tapped = interactivePayload(message)?.id;
    if (tapped) {
        try { await routing.reroute(conversation.id, 'menu_option', tapped); }
        catch (err) { console.error('whatsapp routing error:', err.message); }
    }
}

/** Is this message one of the words that bring the menu back? */
async function isMenuKeyword(text) {
    const r = await db.query(`SELECT value FROM wa_settings WHERE key = 'menu_keywords'`);
    const words = String(r.rows[0]?.value ?? 'menu').split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
    return words.includes(String(text || '').trim().toLowerCase());
}

/* ── Coexistence: the phone app's messages, and the history it brought with it ──────────────
   With the number on the WhatsApp Business app and the CRM together, staff still reply from the
   phone. Those replies arrive as "echoes" and are written into the thread so it reads whole.
   History arrives once, in chunks, after connecting: up to 180 days of one-to-one chats.

   Neither starts the menu, assigns anybody, counts as unread, or touches the 24-hour window —
   Meta does not count phone-app or historical messages towards it, and neither do we. */

let importChain = Promise.resolve();
const inTurn = (job) => {
    const run = importChain.then(job);
    importChain = run.catch(err => console.error('whatsapp import error:', err.message));
    return run;
};

/** The thread with a number, made without routing or a menu: for messages that are not new. */
async function quietThread(phone, name) {
    const line = lineId();
    return db.transaction(async (c) => {
        const contact = (await c.query(
            `INSERT INTO wa_contacts (line_id, phone, profile_name) VALUES ($3, $1, $2)
             ON CONFLICT (line_id, phone) DO UPDATE SET profile_name = COALESCE(wa_contacts.profile_name, EXCLUDED.profile_name)
             RETURNING id, lead_id, customer_id`, [phone, name || null, line])).rows[0];
        const locked = (await c.query('SELECT lead_id FROM wa_contacts WHERE id = $1 FOR UPDATE', [contact.id])).rows[0];
        if (!onCrewfit()) {
            if (!contact.customer_id) await linkCustomer(c, contact.id, phone);
        } else if (!locked?.lead_id) {
            // An old chat is not a new enquiry: it goes in as one already being talked to.
            const leadId = (await c.query(
                `INSERT INTO crewfit_leads (name, phone, source, status)
                 VALUES ($1, $2, 'whatsapp',
                         COALESCE((SELECT key FROM wa_lead_statuses WHERE key = 'enquiry'),
                                  (SELECT key FROM wa_lead_statuses WHERE is_default ORDER BY sort_order LIMIT 1), 'new'))
                 RETURNING id`, [name || null, phone])).rows[0].id;
            await c.query('UPDATE wa_contacts SET lead_id = $2 WHERE id = $1', [contact.id, leadId]);
        }
        return (await c.query(
            `INSERT INTO wa_conversations (contact_id, line_id) VALUES ($1, $2)
             ON CONFLICT (contact_id) DO UPDATE SET contact_id = EXCLUDED.contact_id
             RETURNING id`, [contact.id, line])).rows[0];
    });
}

/**
 * A Normless customer is somebody who has bought from the shop: the Shopify customer with this
 * number, matched on the last ten digits because Shopify keeps numbers however they were typed.
 */
async function linkCustomer(c, contactId, phone) {
    const last10 = String(phone).slice(-10);
    if (last10.length < 10) return;
    // By the profile's phone, or the customer on an order placed with this phone (nl-shop).
    const id = await nlShop.findCustomerId(last10);
    if (id) await c.query('UPDATE wa_contacts SET customer_id = $2 WHERE id = $1', [contactId, id]);
}

/** Move a thread's "last message" on, but never back to something older. */
async function touchThread(conversationId, at, preview) {
    await db.query(
        `UPDATE wa_conversations
            SET last_message_at = $2, last_message_preview = $3, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND (last_message_at IS NULL OR last_message_at <= $2)`,
        [conversationId, at, String(preview || '').slice(0, 200)]);
}

const tsOf = (m) => (m?.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date());

/** A message a member of staff sent from the phone app. */
async function receiveEcho(echo) {
    const phone = wa.normalisePhone(echo?.to);
    if (!phone || !echo?.id) return;
    const conv = await quietThread(phone, null);
    const body = describe(echo);
    const row = (await db.query(
        `INSERT INTO wa_messages (conversation_id, wamid, direction, sender_type, type, body, interactive_payload, status, sent_at)
         VALUES ($1,$2,'out','phone',$3,$4,$5,'sent',$6)
         ON CONFLICT (wamid) DO NOTHING RETURNING id`,
        [conv.id, echo.id, echo.type || 'text', body, JSON.stringify(interactivePayload(echo)), tsOf(echo)])).rows[0];
    if (!row) return;
    await touchThread(conv.id, tsOf(echo), body);
    if (MEDIA_TYPES.includes(echo.type) && echo[echo.type]?.id) {
        try {
            const file = await wa.downloadMedia(echo[echo.type].id, conv.id);
            await db.query(`UPDATE wa_messages SET media_url = $2, media_mime = $3, media_name = $4 WHERE id = $1`,
                [row.id, file.url, file.mime, echo[echo.type].filename || null]);
        } catch (err) {
            console.error('whatsapp echo media download failed:', err.message);
        }
    }
}

/** One chunk of imported history. Counted into history_import for the settings page. */
async function receiveHistory(value) {
    const conn = (await connectSvc.getSetting('connection')) || {};
    const business = conn.business_phone || wa.normalisePhone(value?.metadata?.display_phone_number || '');
    const progress = (await connectSvc.getSetting('history_import')) || {};

    for (const chunk of value?.history || []) {
        const errors = chunk.errors || value.errors || [];
        if (errors.some(e => Number(e.code) === 2593109)) {
            await connectSvc.putSetting('history_import', { ...progress, status: 'declined', error: 'The business chose not to share its chat history', updated_at: new Date().toISOString() });
            return;
        }
        let inserted = 0;
        for (const thread of chunk.threads || []) {
            const phone = wa.normalisePhone(thread.id);
            if (!phone) continue;
            const conv = await quietThread(phone, null);
            let latest = null;
            for (const m of thread.messages || []) {
                if (!m?.id) continue;
                const out = (business && wa.normalisePhone(m.from) === business) || (!!m.to && wa.normalisePhone(m.to) === phone);
                const body = m.type === 'media_placeholder' ? '📎 Media (from the phone app history)' : describe(m);
                const status = out ? String(m.history_context?.status || 'sent').toLowerCase() : 'delivered';
                const r = (await db.query(
                    `INSERT INTO wa_messages (conversation_id, wamid, direction, sender_type, type, body, status, sent_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                     ON CONFLICT (wamid) DO NOTHING RETURNING id`,
                    [conv.id, m.id, out ? 'out' : 'in', out ? 'phone' : 'customer', m.type || 'text', body,
                        ['sent', 'delivered', 'read', 'played'].includes(status) ? (status === 'played' ? 'read' : status) : 'sent', tsOf(m)])).rows[0];
                if (r) inserted++;
                if (!latest || tsOf(m) > latest.at) latest = { at: tsOf(m), body };
            }
            if (latest) await touchThread(conv.id, latest.at, latest.body);
        }
        const meta = chunk.metadata || {};
        Object.assign(progress, {
            status: Number(meta.progress) >= 100 ? 'done' : 'importing',
            phase: meta.phase ?? progress.phase, progress: meta.progress ?? progress.progress,
            chunks: (progress.chunks || 0) + 1,
            threads: (progress.threads || 0) + (chunk.threads || []).length,
            messages: (progress.messages || 0) + inserted,
            updated_at: new Date().toISOString(),
        });
    }
    await connectSvc.putSetting('history_import', progress);
}

/** The phone app's contacts: the names the shop saved its customers under. */
async function receiveContacts(value) {
    const progress = (await connectSvc.getSetting('contacts_import')) || {};
    let n = 0;
    for (const item of value?.state_sync || []) {
        if (item.type !== 'contact' || !item.contact) continue;
        const phone = wa.normalisePhone(item.contact.phone_number);
        if (!phone) continue;
        if (item.action === 'remove') continue;          // a deleted contact keeps its chats
        const name = item.contact.full_name || item.contact.first_name || null;
        // The name the shop saved them under beats the one they gave themselves on WhatsApp.
        const c = (await db.query(
            `INSERT INTO wa_contacts (line_id, phone, profile_name) VALUES ($3, $1, $2)
             ON CONFLICT (line_id, phone) DO UPDATE SET profile_name = COALESCE(EXCLUDED.profile_name, wa_contacts.profile_name)
             RETURNING lead_id`, [phone, name, lineId()])).rows[0];
        if (c?.lead_id && name) await db.query(`UPDATE crewfit_leads SET name = COALESCE(name, $2) WHERE id = $1`, [c.lead_id, name]);
        n++;
    }
    await connectSvc.putSetting('contacts_import', { ...progress, status: 'done', contacts: (progress.contacts || 0) + n, updated_at: new Date().toISOString() });
}

/** What became of something we sent: one tick, two, blue, or a refusal. */
async function receiveStatus(status) {
    if (!status?.id || !status?.status) return;
    const error = status.errors?.[0];
    await db.query(
        `UPDATE wa_messages
            SET status = $2,
                error = COALESCE($3, error)
          WHERE wamid = $1
            -- Statuses can arrive out of order; never walk a message backwards from read to sent.
            AND COALESCE(ARRAY_POSITION(ARRAY['sent','delivered','read','failed'], status), 0)
                <= ARRAY_POSITION(ARRAY['sent','delivered','read','failed'], $2::text)`,
        [status.id, status.status, error ? (error.title || error.message || 'Message failed') : null]);
}

/**
 * The person behind the number, the enquiry they become, and the thread with them.
 *
 * All three in one transaction, because WhatsApp delivers a burst of messages at once and each
 * one arrives here at the same moment. Read-then-insert loses that race: four messages found no
 * conversation, each made one, and a single customer appeared five times in the inbox with the
 * sentences of one enquiry split between them. The contact row is locked for the moment it takes
 * to settle, and the conversation insert leans on a unique index rather than on timing.
 */
async function threadFor(phone, profileName, referral) {
    const line = lineId();
    const crewfit = onCrewfit();
    return db.transaction(async (c) => {
        const contact = (await c.query(
            `INSERT INTO wa_contacts (line_id, phone, profile_name)
             VALUES ($3, $1, $2)
             ON CONFLICT (line_id, phone) DO UPDATE
                SET profile_name = COALESCE(EXCLUDED.profile_name, wa_contacts.profile_name)
             RETURNING id, phone, profile_name, lead_id, customer_id`,
            [phone, profileName, line])).rows[0];

        // Locked for the rest of the transaction, so two messages cannot both decide this number
        // has no lead yet and raise one each.
        const locked = (await c.query(
            `SELECT lead_id FROM wa_contacts WHERE id = $1 FOR UPDATE`, [contact.id])).rows[0];

        let leadId = locked?.lead_id || null;
        // Normless: no enquiry to raise — the customer is matched to Shopify's instead.
        if (!crewfit && !contact.customer_id) await linkCustomer(c, contact.id, phone);
        if (crewfit && !leadId) {
            // The enquiry exists whether or not anybody answers it: that is the point of writing
            // it down here rather than leaving it in a chat thread.
            leadId = (await c.query(
                `INSERT INTO crewfit_leads (name, phone, source, ad_referral, status)
                 VALUES ($1,$2,'whatsapp',$3,
                         COALESCE((SELECT key FROM wa_lead_statuses WHERE is_default ORDER BY sort_order LIMIT 1), 'new'))
                 RETURNING id`,
                [contact.profile_name, contact.phone, referral ? JSON.stringify(referral) : null])).rows[0].id;
            await c.query(`UPDATE wa_contacts SET lead_id = $2 WHERE id = $1`, [contact.id, leadId]);
        }

        const conversation = (await c.query(
            `INSERT INTO wa_conversations (contact_id, ad_referral, last_message_at, assigned_to, line_id)
             VALUES ($1,$2,CURRENT_TIMESTAMP,$3,$4)
             ON CONFLICT (contact_id) DO UPDATE
                -- Reopened rather than duplicated: the same person asking again is the same
                -- thread, and splitting it hides half the history. The ad that first brought
                -- them in is kept, not overwritten by a later message with no referral.
                SET ad_referral = COALESCE(wa_conversations.ad_referral, EXCLUDED.ad_referral),
                    status = 'open', updated_at = CURRENT_TIMESTAMP
             RETURNING *`,
            [contact.id, referral ? JSON.stringify(referral) : null,
                // Crewfit's teams and caps share out Crewfit's enquiries; Normless's wait unassigned.
                crewfit ? await routing.forNewConversation(c, { fromAd: !!referral }) : null, line])).rows[0];

        return { contact, conversation };
    });
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
   The inbox — behind the usual sign-in
   ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The router is mounted once per brand (index.js): /api/whatsapp for Crewfit and
 * /api/nl-whatsapp for Normless, each behind wa-line's scope, so req.waLine says whose inbox this
 * is. Each brand has its own pair of grants.
 */
const GRANTS = {
    crewfit: { view: 'can_view_whatsapp', manage: 'can_manage_whatsapp', dashboard: 'can_view_wa_dashboard', settings: 'can_manage_wa_settings' },
    normless: { view: 'can_view_wa_normless', manage: 'can_manage_wa_normless', dashboard: 'can_view_wa_nl_dashboard', settings: 'can_manage_wa_nl_settings' },
};
router.use(async (req, res, next) => {
    try {
        const grants = GRANTS[req.waLine?.brand];
        if (!grants) return res.status(404).json({ error: 'No such WhatsApp inbox' });
        if (!await hasPermission(req, grants.view)) return res.status(403).json({ error: 'Access denied' });
        req.waManager = await hasPermission(req, grants.manage);
        // Seeing the line's numbers and changing its settings are grants of their own.
        req.waDashboard = await hasPermission(req, grants.dashboard);
        req.waSettings = await hasPermission(req, grants.settings);
        lines.resume(req, next);
    } catch (err) { next(err); }
});

/**
 * What only Crewfit's inbox has: leads and their statuses, the catalogue, orders, quotes,
 * billing, mockups, the menu and its settings. Normless's inbox gets its own in later phases;
 * until then these answer 404 there rather than acting on a Normless chat with Crewfit's tools.
 */
const CREWFIT_ONLY = [
    /^\/leads\//, /^\/statuses$/, /^\/catalogue(-pdf)?$/, /^\/orders\//, /^\/flows/, /^\/admin(\/|$)/,
    /^\/settings$/, /^\/conversations\/\d+\/(product|orders|catalogue-pdf|billing|payment-qr|quotes|mockups)(\/|$)/,
];
router.use((req, res, next) => {
    if (req.waLine?.brand !== 'crewfit' && CREWFIT_ONLY.some(rx => rx.test(req.path))) {
        return res.status(404).json({ error: 'Not part of this inbox yet' });
    }
    next();
});

// Templates on either line: list, write, edit, delete (Normless's are also under /nl).
router.use('/tpl', require('./wa-templates'));

// Normless's own settings: bot, knowledge, handoff rules, menu, hours, team.
router.use('/nl', (req, res, next) => (req.waLine?.brand === 'normless' ? next()
    : res.status(404).json({ error: 'Not part of this inbox' })), require('./whatsapp-normless'));

/**
 * The demo chat: a made-up customer on a number no phone can have, so the team can see and click
 * through the inbox before the real number is connected. Nothing is ever sent to it, no ticket is
 * tied to it, and its Shopify panel is invented rather than read from (or written to) the shop.
 */
const DEMO_PHONE = '910000000000';
const isDemo = (conversation) => conversation?.phone === DEMO_PHONE;
const demoRefusal = (res) => res.status(400).json({ error: 'This is the demo chat — nothing is sent from it. Try it on a real customer once the number is connected.' });

/**
 * The conversations this person is allowed to open, as a SQL condition.
 *
 * A rep gets their own and anything unclaimed; a manager gets everything. Written once and used
 * by every route, so no route can forget it.
 */
function visibility(req, params) {
    // Only this brand's threads, always: the line is the first thing every query checks.
    params.push(req.waLine?.id ?? -1);
    const line = `c.line_id = $${params.length}`;
    if (req.waManager) return line;
    params.push(String(req.user?.username || '').toLowerCase());
    return `(${line} AND (LOWER(COALESCE(c.assigned_to,'')) = $${params.length} OR c.assigned_to IS NULL))`;
}

// Connecting the number is an account change: admins and owners only.
const adminOnly = (req, res, next) => (['admin', 'owner'].includes(req.user?.role)
    ? next() : res.status(403).json({ error: 'Only an admin can connect WhatsApp' }));

router.get('/connect', adminOnly, async (req, res) => {
    try { res.json(await connectSvc.status()); }
    catch (err) { console.error('whatsapp connect status error:', err); res.status(500).json({ error: 'Could not read the connection' }); }
});

router.post('/connect', adminOnly, async (req, res) => {
    try {
        const b = req.body || {};
        const out = await connectSvc.connect({
            code: b.code, wabaId: b.waba_id, phoneNumberId: b.phone_number_id, businessId: b.business_id, finishType: b.event,
        }, req.user?.username);
        res.status(201).json({ connection: out, ...(await connectSvc.status()) });
    } catch (err) {
        if (err instanceof connectSvc.ConnectError) return res.status(err.status).json({ error: err.message });
        console.error('whatsapp connect error:', err);
        res.status(500).json({ error: 'Could not finish connecting' });
    }
});

router.post('/connect/sync/:type', adminOnly, async (req, res) => {
    try {
        const type = req.params.type === 'contacts' ? 'smb_app_state_sync' : req.params.type === 'history' ? 'history' : null;
        if (!type) return res.status(400).json({ error: 'Unknown sync' });
        await connectSvc.requestSync(type, req.user?.username);
        res.json(await connectSvc.status());
    } catch (err) {
        if (err instanceof connectSvc.ConnectError) return res.status(err.status).json({ error: err.message });
        console.error('whatsapp sync request error:', err);
        res.status(500).json({ error: 'Could not ask Meta for the sync' });
    }
});

router.post('/connect/disconnect', adminOnly, async (req, res) => {
    try {
        await connectSvc.disconnect(req.user?.username);
        res.json(await connectSvc.status());
    } catch (err) {
        console.error('whatsapp disconnect error:', err);
        res.status(500).json({ error: 'Could not disconnect' });
    }
});

// Settings: the menu, templates, catalogue, team, assignment and statuses. Managers only.
router.use('/admin', (req, res, next) =>
    (req.waSettings ? next() : res.status(403).json({ error: 'You don’t have access to WhatsApp settings' })),
    require('./whatsapp-settings'));

/** Whether Meta still accepts our token — the inbox shows a banner when it does not. */
router.get('/health', async (req, res) => {
    try { res.json(await wa.checkToken({ fresh: req.query.fresh === '1' })); }
    catch (err) { res.json({ ok: false, reason: 'error', message: err.message }); }
});

/** Is the module switched on, and what can this person do in it? */
router.get('/config', (req, res) => {
    res.json({
        configured: wa.configured(),
        brand: req.waLine?.brand,
        canManage: !!req.waManager, canSettings: !!req.waSettings, canDashboard: !!req.waDashboard,
        canConnect: ['admin', 'owner'].includes(req.user?.role),
        windowHours: wa.WINDOW_HOURS,
        maxUploadMb: wa.MAX_MEDIA_MB,
    });
});

// Who spoke last: a chat whose last word is the customer's is one waiting for an answer.
const LAST_DIRECTION = `(SELECT m.direction FROM wa_messages m WHERE m.conversation_id = c.id
                          ORDER BY m.id DESC LIMIT 1)`;
// A Normless chat with a support ticket still open on it.
const HAS_OPEN_TICKET = `EXISTS (SELECT 1 FROM support_tickets t WHERE t.wa_conversation_id = c.id AND t.status <> 'Closed')`;

const LIST_FIELDS = `c.id, c.status, c.mode, c.assigned_to, c.unread_count, c.last_message_preview,
                     c.last_inbound_at, c.last_message_at, c.ad_referral,
                     k.phone, k.profile_name, k.lead_id, k.customer_id,
                     l.name AS lead_name, l.company AS lead_company, l.status AS lead_status,
                     l.product_interest, l.quantity,
                     NULLIF(TRIM(CONCAT(cu.first_name, ' ', cu.last_name)), '') AS customer_name,
                     ${LAST_DIRECTION} AS last_direction,
                     (SELECT t.ref_no FROM support_tickets t WHERE t.wa_conversation_id = c.id AND t.status <> 'Closed'
                       ORDER BY t.id DESC LIMIT 1) AS open_ticket_ref`;
const LIST_FROM = `FROM wa_conversations c
                   JOIN wa_contacts k ON k.id = c.contact_id
                   LEFT JOIN crewfit_leads l ON l.id = k.lead_id
                   LEFT JOIN customers cu ON cu.id = k.customer_id`;

const shapeConversation = (row) => ({
    ...row,
    ad_referral: safeJson(row.ad_referral, null),
    display_name: row.lead_name || row.customer_name || row.profile_name || wa.prettyPhone(row.phone),
    phone_pretty: wa.prettyPhone(row.phone),
    window_open: wa.windowOpen(row.last_inbound_at),
    window_left_ms: wa.windowLeftMs(row.last_inbound_at),
    is_demo: row.phone === DEMO_PHONE,
});

/** The thread list down the left of the page. */
/**
 * The number beside WhatsApp in the menu. Normless: chats waiting for a person (the bot handles the
 * rest, so that is what needs someone). Crewfit: unread messages. A chat this person muted counts
 * for neither — muting it is how they said so.
 */
router.get('/badge', async (req, res) => {
    try {
        const params = [];
        const vis = visibility(req, params);
        params.push(String(req.user?.username || '').toLowerCase());
        const me = `$${params.length}`;
        const notMuted = `NOT EXISTS (SELECT 1 FROM wa_conversation_mutes mu WHERE mu.conversation_id = c.id AND mu.username = ${me})`;
        const normless = req.waLine?.brand === 'normless';
        const r = await db.query(normless
            ? `SELECT COUNT(*)::int AS n ${LIST_FROM} WHERE ${vis} AND ${notMuted}
                  AND c.status = 'open' AND c.mode = 'human' AND ${LAST_DIRECTION} = 'in'`
            : `SELECT COALESCE(SUM(c.unread_count), 0)::int AS n ${LIST_FROM} WHERE ${vis} AND ${notMuted}`, params);
        res.json({ count: r.rows[0].n, kind: normless ? 'waiting' : 'unread' });
    } catch (err) {
        console.error('whatsapp badge error:', err.message);
        res.status(500).json({ error: 'Could not count' });
    }
});

/* ── Dashboard ───────────────────────────────────────────────────────────────────────────────
   The whole line's numbers are for managers and admins; on Crewfit, everyone has their own page. */

const dashboard = require('../services/wa-dashboard');

router.get('/dashboard', async (req, res) => {
    try {
        if (!req.waDashboard) return res.status(403).json({ error: 'You don’t have access to the WhatsApp dashboard' });
        const lineId = req.waLine.id;
        res.json(req.waLine.brand === 'normless' ? await dashboard.normless(lineId, req.query) : await dashboard.crewfit(lineId, req.query));
    } catch (err) {
        console.error('whatsapp dashboard error:', err);
        res.status(500).json({ error: 'Could not work out the dashboard' });
    }
});

router.get('/dashboard/messages', async (req, res) => {
    try {
        if (!req.waDashboard) return res.status(403).json({ error: 'You don’t have access to the WhatsApp dashboard' });
        res.json(await dashboard.messageLog(req.waLine.id, req.query));
    } catch (err) {
        console.error('whatsapp message log error:', err);
        res.status(500).json({ error: 'Could not read the message log' });
    }
});

router.get('/dashboard/me', async (req, res) => {
    try {
        if (req.waLine.brand !== 'crewfit') return res.status(404).json({ error: 'Not part of this inbox' });
        // Someone else's page: only for managers and admins (from the team table).
        const whose = req.query.user && req.waDashboard ? String(req.query.user) : req.user?.username;
        res.json({ ...(await dashboard.myPerformance(req.waLine.id, whose, req.query)), canSeeTeam: !!req.waDashboard });
    } catch (err) {
        console.error('whatsapp my performance error:', err);
        res.status(500).json({ error: 'Could not work out the numbers' });
    }
});

router.get('/conversations', async (req, res) => {
    try {
        const params = [];
        const where = [visibility(req, params)];

        const filter = String(req.query.filter || 'all');
        if (filter === 'mine') {
            params.push(String(req.user?.username || '').toLowerCase());
            where.push(`LOWER(COALESCE(c.assigned_to,'')) = $${params.length}`);
        } else if (filter === 'unassigned') {
            where.push('c.assigned_to IS NULL');
        } else if (filter === 'waiting') {
            // "Needs a person": a person is answering it, and the customer spoke last. On Crewfit,
            // only chats nobody has taken yet — the queue somebody picks up from.
            where.push(`c.status = 'open' AND c.mode = 'human' AND ${LAST_DIRECTION} = 'in'${req.waLine.brand === 'crewfit' ? ' AND c.assigned_to IS NULL' : ''}`);
        } else if (filter === 'bot') {
            where.push(`c.mode IN ('flow', 'ai')`);
        } else if (filter === 'ticket') {
            where.push(HAS_OPEN_TICKET);
        }
        if (filter === 'closed') {
            where.push(`c.status = 'closed'`);
        } else if (String(req.query.status || 'open') !== 'all') {
            params.push(String(req.query.status || 'open'));
            where.push(`c.status = $${params.length}`);
        }
        const leadStatus = trim(req.query.lead_status);
        if (leadStatus) {
            params.push(leadStatus);
            where.push(`l.status = $${params.length}`);
        }
        const search = trim(req.query.search);
        if (search) {
            params.push(`%${search.toLowerCase()}%`);
            const i = params.length;
            const digits = search.replace(/\D+/g, '');
            // No digits typed: a pattern no phone number (all digits) can match. It used to be a NUL
            // character, which Postgres refuses outright, so every search by name failed.
            params.push(digits ? `%${digits}%` : '%~%');
            // "CF-142", "cf142" or "142" also finds the customer of that order — by the order's
            // link to the lead, or by the number it was raised against.
            const orderNo = search.match(/^\s*(?:cf[-\s]?)?(\d{1,7})\s*$/i);
            let byOrder = '';
            if (orderNo) {
                params.push(Number(orderNo[1]));
                byOrder = `OR EXISTS (SELECT 1 FROM crewfit_orders o WHERE o.sl_no = $${params.length}
                              AND (o.wa_lead_id = k.lead_id
                                   OR RIGHT(REGEXP_REPLACE(COALESCE(o.whatsapp_number, o.contact_number, ''), '\\D', '', 'g'), 10) = RIGHT(k.phone, 10)))`;
            }
            where.push(`(LOWER(COALESCE(k.profile_name,'')) LIKE $${i}
                         OR LOWER(COALESCE(l.name,'')) LIKE $${i}
                         OR LOWER(COALESCE(l.company,'')) LIKE $${i}
                         OR k.phone LIKE $${i + 1} ${byOrder})`);
        }

        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 60, 1), 200);
        const rows = await db.query(
            `SELECT ${LIST_FIELDS} ${LIST_FROM}
              WHERE ${where.join(' AND ')}
              ORDER BY c.last_message_at DESC NULLS LAST, c.id DESC
              LIMIT ${limit}`, params);

        // The counts the filter chips show, over everything this person can see.
        const tallyParams = [];
        const vis = visibility(req, tallyParams);
        tallyParams.push(String(req.user?.username || '').toLowerCase());
        const me = `$${tallyParams.length}`;
        const tally = await db.query(
            `SELECT COUNT(*) FILTER (WHERE c.status = 'open') AS open,
                    COUNT(*) FILTER (WHERE c.status = 'open' AND c.assigned_to IS NULL) AS unassigned,
                    -- A chat this person muted adds nothing to their badge.
                    COALESCE(SUM(c.unread_count) FILTER (WHERE NOT EXISTS (SELECT 1 FROM wa_conversation_mutes mu
                              WHERE mu.conversation_id = c.id AND mu.username = ${me})), 0) AS unread,
                    COUNT(*) FILTER (WHERE c.status = 'open' AND c.mode = 'human' AND ${LAST_DIRECTION} = 'in'${req.waLine.brand === 'crewfit' ? ' AND c.assigned_to IS NULL' : ''})::int AS waiting,
                    -- Unread customer messages behind each of Crewfit's chips (muted chats left out).
                    COALESCE(SUM(c.unread_count) FILTER (WHERE c.assigned_to IS NULL AND NOT EXISTS (SELECT 1 FROM wa_conversation_mutes mu
                              WHERE mu.conversation_id = c.id AND mu.username = ${me})), 0)::int AS unread_unassigned,
                    COALESCE(SUM(c.unread_count) FILTER (WHERE LOWER(COALESCE(c.assigned_to, '')) = ${me} AND NOT EXISTS (SELECT 1 FROM wa_conversation_mutes mu
                              WHERE mu.conversation_id = c.id AND mu.username = ${me})), 0)::int AS unread_mine,
                    COUNT(*) FILTER (WHERE c.status = 'open' AND c.mode IN ('flow', 'ai'))::int AS bot,
                    COUNT(*) FILTER (WHERE c.status = 'open' AND LOWER(COALESCE(c.assigned_to, '')) = ${me})::int AS mine,
                    COUNT(*) FILTER (WHERE c.status = 'open' AND ${HAS_OPEN_TICKET})::int AS ticket,
                    COUNT(*) FILTER (WHERE c.status = 'closed')::int AS closed
               ${LIST_FROM} WHERE ${vis}`, tallyParams);

        const muted = await mutedFor(req, rows.rows.map(r => r.id));
        // How many chats are at each lead status (Crewfit), over everything this person can see.
        const statusParams = [];
        const statusVis = visibility(req, statusParams);
        const byStatus = req.waLine.brand === 'crewfit' ? (await db.query(
            `SELECT COALESCE(l.status, 'none') AS status, COUNT(*)::int AS n ${LIST_FROM} WHERE ${statusVis} GROUP BY 1`, statusParams)).rows : [];
        res.json({
            conversations: rows.rows.map(r => ({ ...shapeConversation(r), muted: muted.has(r.id) })),
            tally: { ...tally.rows[0], unread: Number(tally.rows[0].unread) || 0 },
            statusCounts: Object.fromEntries(byStatus.map(x => [x.status, x.n])),
        });
    } catch (err) {
        console.error('whatsapp conversations error:', err);
        res.status(500).json({ error: 'Could not load the conversations' });
    }
});

/** Which of these chats this person has muted. */
async function mutedFor(req, ids) {
    if (!ids.length) return new Set();
    const r = await db.query(
        `SELECT conversation_id FROM wa_conversation_mutes WHERE username = $1 AND conversation_id = ANY($2::int[])`,
        [String(req.user?.username || '').toLowerCase(), ids]);
    return new Set(r.rows.map(x => x.conversation_id));
}

/* ── Starting a chat ──────────────────────────────────────────────────────────────────────────
   For the times the team writes first: a new number from a phone call, or a customer whose order
   has a problem. The thread is made (or found) here; if the customer hasn't written in the last
   24 hours, the first message has to be an approved template, which the inbox sends next. */

router.post('/conversations/start', async (req, res) => {
    try {
        const phone = wa.normalisePhone(req.body?.phone);
        if (!phone || phone.length < 11 || phone.length > 15) return res.status(400).json({ error: 'Give the number with its country code, or a 10-digit Indian number' });
        if (phone === DEMO_PHONE) return res.status(400).json({ error: 'That is the demo chat' });
        const name = trim(req.body?.name);
        const me = req.user?.username || null;
        const existing = (await db.query(
            `SELECT c.id, c.assigned_to, c.status FROM wa_conversations c JOIN wa_contacts k ON k.id = c.contact_id
              WHERE k.line_id = $1 AND k.phone = $2`, [req.waLine.id, phone])).rows[0];
        // Someone else's open chat stays theirs; a rep who can't see it is told whose it is.
        if (existing?.assigned_to && existing.status === 'open' && !req.waManager
            && String(existing.assigned_to).toLowerCase() !== String(me).toLowerCase()) {
            return res.status(409).json({ error: `This customer is already talking to ${String(existing.assigned_to).split('@')[0]} — ask them, or a manager, to hand the chat over` });
        }
        const thread = existing || await quietThread(phone, name);
        if (name) {
            await db.query(`UPDATE wa_contacts SET profile_name = COALESCE(profile_name, $2)
                             WHERE id = (SELECT contact_id FROM wa_conversations WHERE id = $1)`, [thread.id, name]);
        }
        // Theirs now, with a person answering: the bot and the menu stay out of a chat a person began.
        await db.query(
            `UPDATE wa_conversations SET assigned_to = COALESCE(assigned_to, $2), mode = 'human', status = 'open',
                    last_message_at = COALESCE(last_message_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [thread.id, me]);
        if (!existing) {
            await orders.logActivity({ conversationId: thread.id, kind: 'assign', actor: me, body: `${String(me || '').split('@')[0]} started this chat` });
        }
        const conversation = await loadConversation(req, thread.id);
        res.status(existing ? 200 : 201).json({ conversation, existed: !!existing, openers: await openers.list(req.waLine) });
    } catch (err) {
        console.error('whatsapp start chat error:', err);
        res.status(500).json({ error: 'Could not start that chat' });
    }
});

/** The opener templates for this line, and submitting them to Meta. */
router.get('/openers', async (req, res) => {
    try { res.json({ openers: await openers.list(req.waLine), canSubmit: !!req.waSettings }); }
    catch (err) { console.error('whatsapp openers error:', err); res.status(500).json({ error: 'Could not read the templates' }); }
});
router.post('/openers', settingsOnly, async (req, res) => {
    try {
        if (!wa.configured() || !wa.wabaId()) return res.status(503).json({ error: 'Connect this WhatsApp number first' });
        res.json({ results: await openers.submit(req.waLine), openers: await openers.list(req.waLine) });
    } catch (err) {
        console.error('whatsapp openers submit error:', err);
        res.status(500).json({ error: 'Could not send those to Meta' });
    }
});

/* ── Marketing ───────────────────────────────────────────────────────────────────────────────
   The brand's promotional templates and broadcasts to many customers at once. Seeing them is for
   anyone on the inbox; making and sending them is the Settings grant. */

const marketing = require('../services/wa-marketing');
const mkError = (res, err, fallback) => {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    if (err instanceof wa.WhatsAppError) return res.status(502).json({ error: err.message });
    console.error('whatsapp marketing error:', err);
    res.status(500).json({ error: fallback });
};

router.get('/marketing', async (req, res) => {
    try {
        const ours = await marketing.listTemplates(req.waLine);
        const approved = (await db.query(
            `SELECT name, language, category, body_text, variables, components FROM wa_templates
              WHERE line_id = $1 AND status = 'APPROVED' AND category = 'MARKETING'
                -- Not for broadcasts: links through the old provider, and cart reminders (they're
                -- about one customer's own checkout).
                AND COALESCE(components, '') NOT LIKE '%prizmacommunicator%'
                AND name NOT ILIKE '%cart%' AND name NOT ILIKE '%reminder%'
              ORDER BY LOWER(name)`, [req.waLine.id])).rows
            .map(t => ({ ...t, components: (() => { try { return JSON.parse(t.components || '[]'); } catch { return []; } })() }));
        const statuses = req.waLine.brand === 'crewfit'
            ? (await db.query(`SELECT key, name FROM wa_lead_statuses ORDER BY sort_order`)).rows : [];
        res.json({ ours, approved, broadcasts: await marketing.list(req.waLine.id), statuses, canSend: !!req.waSettings, brand: req.waLine.brand });
    } catch (err) { mkError(res, err, 'Could not load marketing'); }
});

router.post('/marketing/templates', settingsOnly, async (req, res) => {
    try {
        if (!wa.configured() || !wa.wabaId()) return res.status(503).json({ error: 'Connect this WhatsApp number first' });
        res.json({ results: await marketing.submitTemplates(req.waLine), ours: await marketing.listTemplates(req.waLine) });
    } catch (err) { mkError(res, err, 'Could not send those to Meta'); }
});

router.post('/marketing/audience', settingsOnly, async (req, res) => {
    try {
        const people = await marketing.audience(req.waLine, req.body?.audience || {});
        res.json({ count: people.length, opted_out: people.optedOut || 0, sample: people.slice(0, 5) });
    } catch (err) { mkError(res, err, 'Could not work out that audience'); }
});

/** Shop photos for a broadcast's photo header (Normless). */
router.get('/marketing/products', async (req, res) => {
    try {
        if (req.waLine.brand !== 'normless') return res.json({ products: [] });
        const products = await require('../services/shopify').fetchProducts();
        res.json({ products: products.filter(p => p.image).map(p => ({ title: p.title, image: p.image, url: p.handle ? `https://normless.store/products/${p.handle}` : null })) });
    } catch (err) { mkError(res, err, 'Could not read the products from Shopify'); }
});

router.post('/marketing/test', settingsOnly, async (req, res) => {
    try {
        const wamid = await marketing.testSend(req.waLine, req.body || {}, req.body?.phone);
        res.json({ sent: !!wamid });
    } catch (err) { mkError(res, err, 'Could not send the test'); }
});

router.post('/marketing/broadcasts', settingsOnly, async (req, res) => {
    try { res.status(201).json({ broadcast: await marketing.create(req.waLine, req.body || {}, req.user?.username) }); }
    catch (err) { mkError(res, err, 'Could not make that broadcast'); }
});

router.get('/marketing/broadcasts/:id', async (req, res) => {
    try {
        const r = await marketing.report(req.waLine.id, req.params.id);
        if (!r) return res.status(404).json({ error: 'No such broadcast' });
        res.json({ broadcast: r });
    } catch (err) { mkError(res, err, 'Could not load that broadcast'); }
});

router.post('/marketing/broadcasts/:id/:action', settingsOnly, async (req, res) => {
    try {
        if (!['start', 'pause', 'cancel'].includes(req.params.action)) return res.status(404).json({ error: 'No such action' });
        const b = await marketing[req.params.action](req.waLine.id, req.params.id);
        if (!b) return res.status(409).json({ error: 'That broadcast can’t do that now' });
        res.json({ broadcast: await marketing.report(req.waLine.id, b.id) });
    } catch (err) { mkError(res, err, 'Could not change that broadcast'); }
});

/* ── Importing chats exported from the WhatsApp (Business) app ───────────────────────────────
   Before a number moves to the CRM, the chats that matter are exported from the phone (Chat ›
   ⋮ › More › Export chat › Include media) and brought in here: each lands in that customer's
   thread (a Crewfit lead is made, as for any new chat) in date order, with its photos and files.
   Importing the same export twice adds nothing. Nothing is sent to anybody. */

const chatImport = require('../services/wa-chat-import');
const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024, files: 1 } });
const takeExport = (req, res, next) => importUpload.single('file')(req, res, (err) => {
    if (!err) return lines.resume(req, next);
    res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That export is over 200MB — export it without media, or split it' : 'Could not read that file' });
});

/**
 * One customer's history written into their thread. Each message: { at (India time), inbound,
 * text, key (what makes it this message, for importing it again without doubling it), missing
 * (the kind of a file the source left out), file: { name, mime, read() → Buffer } }.
 * Importing again replaces what an earlier import put in over the same dates.
 */
async function importChat({ phone, name, messages, actor, source }) {
    messages = [...messages].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const brand = lines.current().brand;
    const thread = await quietThread(phone, name);
    const dir = path.join(__dirname, '..', 'uploads', 'whatsapp', 'imported', String(thread.id));
    const first = messages[0].at, last = messages[messages.length - 1].at;
    const replaced = (await db.query(
        `DELETE FROM wa_messages WHERE conversation_id = $1 AND wamid LIKE 'import:%' AND sent_at BETWEEN $2::timestamp AND $3::timestamp`,
        [thread.id, first, last])).rowCount;
    let imported = 0, media = 0, latest = null, missingMedia = 0;
    for (const m of messages) {
        const wamid = `import:${crypto.createHash('sha1').update([lineId(), phone, m.at, ...m.key].join('|')).digest('hex').slice(0, 32)}`;
        let mediaUrl = null, mime = null, mediaName = null, type = 'text';
        if (m.missing) {
            // A file the source left out: shown as a photo (or video…) that isn't here.
            type = m.missing;
            mediaName = `${{ image: 'Photo', video: 'Video', audio: 'Voice note', document: 'File' }[m.missing] || 'File'} not included in the export`;
            missingMedia++;
        }
        if (m.file) {
            mime = m.file.mime;
            type = chatImport.kindOf(mime);
            mediaName = m.file.name;
            if (m.file.read) {
                fs.mkdirSync(dir, { recursive: true });
                const file = `${crypto.createHash('sha1').update(wamid).digest('hex').slice(0, 12)}-${m.file.name.replace(/[^\w.-]+/g, '_')}`;
                const target = path.join(dir, file);
                if (!fs.existsSync(target)) fs.writeFileSync(target, await m.file.read());
                mediaUrl = `/uploads/whatsapp/imported/${thread.id}/${file}`;
            }
        }
        const r = await db.query(
            `INSERT INTO wa_messages (conversation_id, wamid, direction, sender_type, type, body, media_url, media_mime, media_name, status, sent_at, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
             ON CONFLICT (wamid) DO NOTHING RETURNING id`,
            [thread.id, wamid, m.inbound ? 'in' : 'out', m.inbound ? 'customer' : 'phone', type, m.text || null,
                mediaUrl, mediaUrl ? mime : null, mediaName, m.inbound ? 'delivered' : 'read', m.at]);
        if (r.rows[0]) { imported++; if (mediaUrl) media++; }
        latest = m;
        // Crewfit: what the customer sent (logo, quantity, GST, a product) qualifies the lead,
        // as it would have live. Nothing is sent.
        if (r.rows[0] && m.inbound && brand === 'crewfit') {
            await require('../services/cf-assist').qualify(thread.id, { type }, { text: m.text || '', mediaUrl }).catch(() => {});
        }
    }
    // The thread's "last message" moves on only if the history is newer than what it has.
    await db.query(
        `UPDATE wa_conversations SET last_message_preview = CASE WHEN last_message_at IS NULL OR last_message_at < $2::timestamp THEN $3 ELSE last_message_preview END,
                last_message_at = GREATEST(COALESCE(last_message_at, $2::timestamp), $2::timestamp), updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`, [thread.id, latest.at, String(latest.text || `📎 ${latest.file?.name || 'File'}`).slice(0, 200)]);
    if (imported) {
        await orders.logActivity({ conversationId: thread.id, kind: 'message', actor,
            body: `Imported ${imported} message${imported === 1 ? '' : 's'} from ${source} (${first.slice(0, 10)} to ${last.slice(0, 10)})` });
    }
    const lead = brand === 'crewfit' ? (await db.query(
        `SELECT l.id, l.status FROM wa_conversations c JOIN wa_contacts k ON k.id = c.contact_id JOIN crewfit_leads l ON l.id = k.lead_id WHERE c.id = $1`, [thread.id])).rows[0] : null;
    return { conversation_id: thread.id, imported, replaced, already: Math.max(0, messages.length - imported), media, missing_media: missingMedia,
        lead: lead ? { id: lead.id, status: lead.status } : null };
}

router.post('/import/preview', settingsOnly, takeExport, async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Choose an exported chat (.zip or .txt)' });
        const x = await chatImport.read(req.file.buffer, req.file.originalname);
        const businessNames = [req.waLine.brand === 'crewfit' ? 'Crewfit' : 'Normless', req.waLine.name].filter(Boolean);
        res.json({
            file: req.file.originalname, contact: x.contact, senders: x.senders,
            customer: chatImport.guessCustomer(x.senders, x.contact, businessNames),
            count: x.messages.length, media: x.media.size,
            first: x.messages[0].at, last: x.messages[x.messages.length - 1].at,
        });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Could not read that export' });
    }
});

router.post('/import/commit', settingsOnly, takeExport, async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Choose an exported chat (.zip or .txt)' });
        const phone = wa.normalisePhone(req.body?.phone);
        if (!phone || phone.length < 11 || phone.length > 15) return res.status(400).json({ error: 'Give the customer’s WhatsApp number with its country code, or a 10-digit Indian number' });
        const x = await chatImport.read(req.file.buffer, req.file.originalname);
        const customer = trim(req.body?.customer);
        if (!customer || !x.senders.some(s => s.name === customer)) return res.status(400).json({ error: 'Say which name in the chat is the customer' });
        const name = trim(req.body?.name) || (/\d{6,}/.test(customer) ? null : customer);

        const result = await importChat({
            phone, name, actor: req.user?.username, source: 'a WhatsApp app export',
            messages: x.messages.map(m => ({
                at: m.at, inbound: m.sender === customer, text: m.text,
                key: [m.sender, m.raw ?? m.text, m.attachment || ''],
                missing: m.omitted || null,
                file: m.attachment ? { name: m.attachment, mime: chatImport.mimeOf(m.attachment), read: x.media.has(m.attachment) ? () => x.media.get(m.attachment).async('nodebuffer') : null } : null,
            })),
        });
        res.status(201).json(result);
    } catch (err) {
        console.error('whatsapp chat import error:', err);
        res.status(500).json({ error: err.message || 'Could not import that chat' });
    }
});

/** One thread's header: who it is, what we know about them, who it belongs to. */
async function loadConversation(req, id) {
    const params = [id];
    const r = await db.query(
        `SELECT ${LIST_FIELDS}, c.flow_id, c.flow_step, c.flow_data, c.created_at,
                l.branding, l.notes AS lead_notes, l.email AS lead_email, l.logo_url,
                l.billing_name, l.billing_address, l.delivery_address, l.contact_person,
                l.billing_mobile, l.billing_email, l.gst_number,
                TO_CHAR(l.needed_by, 'YYYY-MM-DD') AS needed_by, l.quoted_amount, l.received_amount
           ${LIST_FROM}
          WHERE c.id = $1 AND ${visibility(req, params)}`, params);
    if (!r.rows[0]) return null;
    return { ...shapeConversation(r.rows[0]), muted: (await mutedFor(req, [r.rows[0].id])).size > 0 };
}

router.get('/conversations/:id', async (req, res) => {
    try {
        const conversation = await loadConversation(req, req.params.id);
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
        res.json({ conversation });
    } catch (err) {
        console.error('whatsapp conversation error:', err);
        res.status(500).json({ error: 'Could not load that conversation' });
    }
});

/** The messages themselves. `after` asks for what is new, which is what the page polls with. */
router.get('/conversations/:id/messages', async (req, res) => {
    try {
        const conversation = await loadConversation(req, req.params.id);
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

        const after = parseInt(req.query.after, 10);
        const params = [conversation.id];
        let where = 'conversation_id = $1';
        if (Number.isFinite(after)) {
            params.push(after);
            where += ` AND id > $${params.length}`;
        }
        // In the order they were said — imported history arrives after newer messages, so the
        // save order is not the conversation's order. The latest 500; polling asks for new ids.
        const rows = await db.query(Number.isFinite(after)
            ? `SELECT id, wamid, direction, sender_type, sender_user, type, body, media_url,
                      media_mime, media_name, interactive_payload, status, error, sent_at
                 FROM wa_messages WHERE ${where} ORDER BY id ASC LIMIT 500`
            : `SELECT * FROM (SELECT id, wamid, direction, sender_type, sender_user, type, body, media_url,
                      media_mime, media_name, interactive_payload, status, error, sent_at
                 FROM wa_messages WHERE ${where} ORDER BY COALESCE(sent_at, created_at) DESC, id DESC LIMIT 500) t
               ORDER BY COALESCE(sent_at, '-infinity'::timestamp) ASC, id ASC`, params);
        res.json({
            messages: rows.rows.map(m => ({ ...m, interactive_payload: safeJson(m.interactive_payload, null) })),
        });
    } catch (err) {
        console.error('whatsapp messages error:', err);
        res.status(500).json({ error: 'Could not load those messages' });
    }
});

/* ── Sending ─────────────────────────────────────────────────────────────────────────────── */

const SEND_ROOT = path.join(__dirname, '..', 'uploads', 'whatsapp', 'outgoing');
const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => { fs.mkdirSync(SEND_ROOT, { recursive: true }); cb(null, SEND_ROOT); },
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname || '').toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 10);
            cb(null, `${Date.now()}-${crypto.randomBytes(5).toString('hex')}${ext}`);
        },
    }),
    limits: { fileSize: wa.MAX_MEDIA_MB * 1024 * 1024, files: 1 },
});

const takeFile = (req, res, next) => upload.single('file')(req, res, (err) => {
    if (!err) return lines.resume(req, next);
    const known = { LIMIT_FILE_SIZE: `Files must be under ${wa.MAX_MEDIA_MB}MB` };
    res.status(400).json({ error: known[err.code] || err.message || 'Could not read that file' });
});

/**
 * Reply to a customer.
 *
 * The window is checked here rather than left to Meta: a rep who types a paragraph deserves to
 * be told before they send it, not after.
 */
router.post('/conversations/:id/messages', takeFile, async (req, res) => {
    try {
        const conversation = await loadConversation(req, req.params.id);
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
        if (isDemo(conversation)) return demoRefusal(res);
        if (!wa.configured()) return res.status(503).json({ error: 'WhatsApp is not configured on this server' });
        if (!wa.windowOpen(conversation.last_inbound_at)) {
            return res.status(409).json({
                error: 'This chat is past WhatsApp’s 24-hour window — only an approved template can be sent now.',
                window_closed: true,
            });
        }

        const body = trim(req.body?.body);
        const file = req.file;
        if (!body && !file) return res.status(400).json({ error: 'Nothing to send' });

        let wamid = null;
        let type = 'text';
        let mediaUrl = null;
        try {
            if (file) {
                const sent = await wa.sendMedia(conversation.phone, {
                    filePath: file.path,
                    mime: file.mimetype,
                    filename: file.originalname,
                    caption: body || '',
                });
                wamid = sent.wamid;
                type = sent.kind;
                mediaUrl = `/uploads/whatsapp/outgoing/${path.basename(file.path)}`;
            } else {
                wamid = await wa.sendText(conversation.phone, body);
            }
        } catch (err) {
            if (err instanceof wa.WhatsAppError) {
                return res.status(502).json({ error: err.message, window_closed: err.code === 131047 });
            }
            throw err;
        }

        const row = await db.query(
            `INSERT INTO wa_messages (conversation_id, wamid, direction, sender_type, sender_user,
                                      type, body, media_url, media_mime, media_name, status)
             VALUES ($1,$2,'out','user',$3,$4,$5,$6,$7,$8,'sent')
             RETURNING id, wamid, direction, sender_type, sender_user, type, body, media_url,
                       media_mime, media_name, status, error, sent_at`,
            [conversation.id, wamid, req.user?.username || null, type, body,
                mediaUrl, file?.mimetype || null, file?.originalname || null]);

        await db.query(
            `UPDATE wa_conversations
                SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = $2,
                    status = 'open', updated_at = CURRENT_TIMESTAMP,
                    -- Answering a thread claims it: an unassigned conversation somebody has
                    -- replied to is not unassigned any more, and the Normless bot stops answering.
                    assigned_to = COALESCE(assigned_to, $3),
                    mode = CASE WHEN line_id = (SELECT id FROM wa_lines WHERE brand = 'normless') THEN 'human' ELSE mode END
              WHERE id = $1`,
            [conversation.id, (body || `Sent ${type}`).slice(0, 200), req.user?.username || null]);

        res.status(201).json({ message: row.rows[0] });
    } catch (err) {
        console.error('whatsapp send error:', err);
        res.status(500).json({ error: 'Could not send that message' });
    }
});

/** Opening a thread clears its unread badge. */
router.post('/conversations/:id/read', async (req, res) => {
    try {
        const conversation = await loadConversation(req, req.params.id);
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
        await db.query(`UPDATE wa_conversations SET unread_count = 0 WHERE id = $1`, [conversation.id]);
        res.json({ ok: true });
    } catch (err) {
        console.error('whatsapp read error:', err);
        res.status(500).json({ error: 'Could not mark that as read' });
    }
});

/** Assign, close, reopen. Reassigning somebody else's thread needs the manager grant. */
router.patch('/conversations/:id', async (req, res) => {
    try {
        const conversation = await loadConversation(req, req.params.id);
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

        const sets = [];
        const params = [conversation.id];
        if ('assigned_to' in (req.body || {})) {
            const next = trim(req.body.assigned_to);
            const mine = String(req.user?.username || '').toLowerCase();
            const taking = next && next.toLowerCase() === mine;
            if (!req.waManager && !taking) {
                return res.status(403).json({ error: 'Only a manager can hand a conversation to someone else' });
            }
            params.push(next);
            sets.push(`assigned_to = $${params.length}`);
        }
        if ('status' in (req.body || {})) {
            const next = String(req.body.status) === 'closed' ? 'closed' : 'open';
            params.push(next);
            sets.push(`status = $${params.length}`);
        }
        if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });

        // Normless: a person given a chat is introduced to the customer by name and the bot steps
        // back; a closed chat goes back to the bot for the customer's next message.
        if (req.waLine.brand === 'normless') {
            const next = 'assigned_to' in req.body ? trim(req.body.assigned_to) : undefined;
            if (next && next.toLowerCase() !== String(conversation.assigned_to || '').toLowerCase() && !conversation.is_demo) {
                await nlHandover.assign(conversation, next, { actor: req.user?.username });
            } else if (next) {
                await db.query(`UPDATE wa_conversations SET assigned_to = $2, mode = 'human', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [conversation.id, next]);
            } else if (next === null) {
                await db.query(`UPDATE wa_conversations SET assigned_to = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [conversation.id]);
            }
            if ('status' in req.body) {
                const closing = String(req.body.status) === 'closed';
                await db.query(
                    `UPDATE wa_conversations SET status = $2,
                            mode = CASE WHEN $2 = 'closed' THEN 'ai' ELSE mode END,
                            assigned_to = CASE WHEN $2 = 'closed' THEN NULL ELSE assigned_to END,
                            nl_handoff_at = CASE WHEN $2 = 'closed' THEN NULL ELSE nl_handoff_at END,
                            updated_at = CURRENT_TIMESTAMP
                      WHERE id = $1`, [conversation.id, closing ? 'closed' : 'open']);
                // The customer is told the chat is closed, and how to pick it up again — once, and
                // only when WhatsApp lets us write to them (within 24 hours of their last message).
                if (closing && conversation.status !== 'closed' && !conversation.is_demo && conversation.window_open) {
                    try {
                        const note = 'Our team has closed this chat. If you need anything else, just send us a message here and we’ll be happy to help.';
                        const wamid = await wa.sendText(conversation.phone, note);
                        await db.query(
                            `INSERT INTO wa_messages (conversation_id, wamid, direction, sender_type, sender_user, type, body, status)
                             VALUES ($1,$2,'out','auto',$3,'text',$4,'sent')`, [conversation.id, wamid, req.user?.username || null, note]);
                        await db.query(`UPDATE wa_conversations SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = $2 WHERE id = $1`, [conversation.id, note.slice(0, 200)]);
                    } catch (err) { console.error('normless close message failed:', err.message); }
                }
                await orders.logActivity({ conversationId: conversation.id, kind: 'status', actor: req.user?.username,
                    body: closing ? `${String(req.user?.username || '').split('@')[0]} closed the chat — the bot answers if they write again`
                        : `${String(req.user?.username || '').split('@')[0]} reopened the chat` });
            }
            return res.json({ conversation: await loadConversation(req, conversation.id) });
        }

        await db.query(
            `UPDATE wa_conversations SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            params);
        const who = String(req.user?.username || '').split('@')[0];
        if ('assigned_to' in req.body) {
            const next = trim(req.body.assigned_to);
            await orders.logActivity({ conversationId: conversation.id, kind: 'assign', actor: req.user?.username,
                body: next ? `${who} handed the chat to ${next.split('@')[0]}` : `${who} put the chat back in Unassigned` });
        }
        if ('status' in req.body) {
            await orders.logActivity({ conversationId: conversation.id, kind: 'status', actor: req.user?.username,
                body: String(req.body.status) === 'closed' ? `${who} marked the chat done` : `${who} reopened the chat` });
        }
        res.json({ conversation: await loadConversation(req, conversation.id) });
    } catch (err) {
        console.error('whatsapp update error:', err);
        res.status(500).json({ error: 'Could not update that conversation' });
    }
});

/** Mute or unmute a chat for the person asking: no sound, no notification, no badge from it. */
router.put('/conversations/:id/mute', async (req, res) => {
    try {
        const conversation = await loadConversation(req, req.params.id);
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
        const me = String(req.user?.username || '').toLowerCase();
        if (req.body?.muted) {
            await db.query(`INSERT INTO wa_conversation_mutes (conversation_id, username) VALUES ($1, $2)
                            ON CONFLICT DO NOTHING`, [conversation.id, me]);
        } else {
            await db.query(`DELETE FROM wa_conversation_mutes WHERE conversation_id = $1 AND username = $2`, [conversation.id, me]);
        }
        res.json({ muted: !!req.body?.muted });
    } catch (err) {
        console.error('whatsapp mute error:', err);
        res.status(500).json({ error: 'Could not change that' });
    }
});

/* ── Voice calls ─────────────────────────────────────────────────────────────────────────────
   Signalling only: the browser makes the WebRTC offer or answer, these routes pass it to Meta,
   and the audio goes straight between the browser and the customer's phone. See wa-calls.js
   for Meta's rules. */

const callError = (res, err, fallback) => {
    if (err instanceof wa.WhatsAppError) {
        return res.status(err.code === 138006 ? 409 : 502).json({ error: err.message, code: err.code, need_permission: err.code === 138006 });
    }
    console.error(fallback, err);
    return res.status(500).json({ error: fallback });
};

/** A call row as the browser sees it. The SDP is handed only to the person on the call. */
const shapeCall = (row, req, conversation = null) => {
    const me = String(req.user?.username || '').toLowerCase();
    const mine = [row.started_by, row.answered_by].some(u => String(u || '').toLowerCase() === me);
    return {
        id: row.id, conversation_id: row.conversation_id, direction: row.direction, status: row.status,
        started_by: row.started_by, answered_by: row.answered_by, answered_at: row.answered_at,
        ended_at: row.ended_at, duration_sec: row.duration_sec, error: row.error, created_at: row.created_at,
        recording_url: row.recording_url || null,
        mine,
        ...(mine ? { answer_sdp: row.direction === 'out' ? row.answer_sdp : undefined } : {}),
        ...(row.direction === 'in' && row.status === 'ringing' ? { offer_sdp: row.offer_sdp } : {}),
        ...(conversation ? { display_name: conversation.display_name, phone_pretty: conversation.phone_pretty } : {}),
    };
};

/** A call this person may act on: on a chat they can see, on this line. */
async function loadCall(req, id) {
    const params = [id];
    const r = await db.query(
        `SELECT w.*, c.id AS cid FROM wa_calls w JOIN wa_conversations c ON c.id = w.conversation_id
          WHERE w.id = $1 AND ${visibility(req, params)}`, params);
    return r.rows[0] || null;
}

/** Is calling switched on for this number? Asked by the inbox once, cached on the server. */
router.get('/calls/settings', async (req, res) => {
    const recording = await recordingSettings(req.waLine.id).catch(() => RECORDING_DEFAULTS);
    try {
        if (!wa.configured()) return res.json({ enabled: false, status: 'NOT_CONFIGURED', canManage: !!req.waManager, canSettings: !!req.waSettings, recording });
        const s = await calls.getSettings({ fresh: req.query.fresh === '1' });
        res.json({ enabled: s.status === 'ENABLED', status: s.status || 'NOT_SET',
            callback_permission: s.callback_permission_status || null, canManage: !!req.waManager, canSettings: !!req.waSettings, recording });
    } catch (err) {
        res.json({ enabled: false, status: 'ERROR', error: err.message, canManage: !!req.waManager, canSettings: !!req.waSettings, recording });
    }
});

/* ── Call recordings ──────────────────────────────────────────────────────────────────────────
   Recorded in the browser that is on the call (both voices, mixed), uploaded when it ends and
   attached to the call's line in the chat. Calls taken on a phone or a SIM are never recorded:
   their sound never passes through the CRM. The customer is told in the chat when a recorded
   call connects, if WhatsApp lets us write to them then. */

const RECORDING_DEFAULTS = {
    record: true, notice_in_chat: true,
    notice: 'This call is being recorded for quality and training.',
};
async function recordingSettings(lineIdValue) {
    const row = (await db.query('SELECT settings FROM wa_lines WHERE id = $1', [lineIdValue])).rows[0];
    let saved = {};
    try { saved = JSON.parse(row?.settings || '{}')?.calls || {}; } catch { /* defaults */ }
    return { ...RECORDING_DEFAULTS, ...saved };
}

router.put('/calls/recording', settingsOnly, async (req, res) => {
    try {
        const b = req.body || {};
        const value = {
            record: !!b.record, notice_in_chat: !!b.notice_in_chat,
            notice: String(b.notice || RECORDING_DEFAULTS.notice).trim().slice(0, 300) || RECORDING_DEFAULTS.notice,
        };
        await db.transaction(async (c) => {
            const row = (await c.query('SELECT settings FROM wa_lines WHERE id = $1 FOR UPDATE', [req.waLine.id])).rows[0];
            let all = {};
            try { all = JSON.parse(row?.settings || '{}') || {}; } catch { all = {}; }
            all.calls = value;
            await c.query('UPDATE wa_lines SET settings = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [req.waLine.id, JSON.stringify(all)]);
        });
        res.json({ recording: value });
    } catch (err) {
        console.error('whatsapp recording settings error:', err);
        res.status(500).json({ error: 'Could not save that' });
    }
});

const CALL_ROOT = path.join(__dirname, '..', 'uploads', 'whatsapp', 'calls');
const callUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => { fs.mkdirSync(CALL_ROOT, { recursive: true }); cb(null, CALL_ROOT); },
        filename: (req, file, cb) => cb(null, `call-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${/ogg/.test(file.mimetype) ? '.ogg' : /mp4|aac|m4a/.test(file.mimetype) ? '.m4a' : '.webm'}`),
    }),
    limits: { fileSize: 80 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => cb(null, /^audio\/|^video\/webm/.test(file.mimetype)),
});

/** The browser that was on the call sends its recording when the call ends. */
router.post('/calls/:id/recording', (req, res, next) => callUpload.single('audio')(req, res, (err) => {
    if (!err) return lines.resume(req, next);
    res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That recording is too long to keep' : 'Could not read the recording' });
}), async (req, res) => {
    try {
        const row = await loadCall(req, req.params.id);
        const drop = () => { if (req.file) fs.promises.unlink(req.file.path).catch(() => {}); };
        if (!row) { drop(); return res.status(404).json({ error: 'Call not found' }); }
        if (!req.file) return res.status(400).json({ error: 'No recording came with that' });
        const me = String(req.user?.username || '').toLowerCase();
        if (![row.started_by, row.answered_by].some(u => String(u || '').toLowerCase() === me)) { drop(); return res.status(403).json({ error: 'Only the person on the call can add its recording' }); }
        if (row.recording_url) { drop(); return res.json({ recording_url: row.recording_url }); }
        const url = `/uploads/whatsapp/calls/${path.basename(req.file.path)}`;
        const mime = String(req.file.mimetype || 'audio/webm').split(';')[0];
        await db.query(
            `UPDATE wa_calls SET recording_url = $2, recording_mime = $3, recording_bytes = $4, recorded_by = $5, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [row.id, url, mime, req.file.size, req.user?.username || null]);
        // On the call's own line in the chat, so it plays where the call is.
        if (row.message_id) {
            await db.query(`UPDATE wa_messages SET media_url = $2, media_mime = $3, media_name = 'Call recording' WHERE id = $1`, [row.message_id, url, mime]);
        }
        res.status(201).json({ recording_url: url });
    } catch (err) {
        console.error('whatsapp call recording error:', err);
        res.status(500).json({ error: 'Could not keep the recording' });
    }
});

/** Tell the customer, in the chat, that the call is being recorded. Once per call. */
router.post('/calls/:id/notice', async (req, res) => {
    try {
        const row = await loadCall(req, req.params.id);
        if (!row) return res.status(404).json({ error: 'Call not found' });
        const settings = await recordingSettings(req.waLine.id);
        if (!settings.record || !settings.notice_in_chat) return res.json({ sent: false, reason: 'off' });
        const claimed = (await db.query(
            `UPDATE wa_calls SET notice_sent_at = CURRENT_TIMESTAMP WHERE id = $1 AND notice_sent_at IS NULL RETURNING id`, [row.id])).rows[0];
        if (!claimed) return res.json({ sent: false, reason: 'already' });
        const conv = (await db.query(
            `SELECT c.id, c.last_inbound_at, k.phone FROM wa_conversations c JOIN wa_contacts k ON k.id = c.contact_id WHERE c.id = $1`,
            [row.conversation_id])).rows[0];
        // Outside the 24-hour window WhatsApp would refuse a plain message; the person on the call
        // is reminded to say it out loud instead.
        if (!conv || isDemo(conv) || !wa.windowOpen(conv.last_inbound_at)) return res.json({ sent: false, reason: 'window' });
        const wamid = await wa.sendText(conv.phone, settings.notice);
        await db.query(
            `INSERT INTO wa_messages (conversation_id, wamid, direction, sender_type, sender_user, type, body, status)
             VALUES ($1,$2,'out','auto',NULL,'text',$3,'sent')`, [conv.id, wamid, settings.notice]);
        res.json({ sent: true });
    } catch (err) {
        console.error('whatsapp recording notice error:', err.message);
        res.json({ sent: false, reason: 'error' });
    }
});

router.put('/calls/settings', async (req, res) => {
    if (!req.waSettings) return res.status(403).json({ error: 'Only someone with WhatsApp settings access can switch calling on or off' });
    try {
        const s = await calls.setEnabled(!!req.body?.enabled);
        res.json({ enabled: s.status === 'ENABLED', status: s.status, callback_permission: s.callback_permission_status || null, canManage: true });
    } catch (err) { callError(res, err, 'Could not change the calling setting'); }
});

/**
 * What the inbox polls for: customer calls ringing on chats this person can see, and any call
 * of their own still going.
 */
router.get('/calls/live', async (req, res) => {
    try {
        await calls.sweepStale();
        const params = [];
        const vis = visibility(req, params);
        params.push(String(req.user?.username || '').toLowerCase());
        const me = `$${params.length}`;
        const r = await db.query(
            `SELECT w.*, k.phone, k.profile_name, l.name AS lead_name,
                    NULLIF(TRIM(CONCAT(cu.first_name, ' ', cu.last_name)), '') AS customer_name
               FROM wa_calls w
               JOIN wa_conversations c ON c.id = w.conversation_id
               JOIN wa_contacts k ON k.id = c.contact_id
               LEFT JOIN crewfit_leads l ON l.id = k.lead_id
               LEFT JOIN customers cu ON cu.id = k.customer_id
              WHERE ${vis} AND w.ended_at IS NULL
                -- A customer's call rings for the person their chat is with; a chat nobody has
                -- rings for everyone who can see it.
                AND ((w.direction = 'in' AND w.status = 'ringing' AND (c.assigned_to IS NULL OR LOWER(c.assigned_to) = ${me}))
                     OR LOWER(COALESCE(w.started_by, '')) = ${me} OR LOWER(COALESCE(w.answered_by, '')) = ${me})
              ORDER BY w.id DESC LIMIT 10`, params);
        res.json({
            calls: r.rows.map(row => shapeCall(row, req, {
                display_name: row.lead_name || row.customer_name || row.profile_name || wa.prettyPhone(row.phone),
                phone_pretty: wa.prettyPhone(row.phone),
            })),
        });
    } catch (err) {
        console.error('whatsapp live calls error:', err);
        res.status(500).json({ error: 'Could not check for calls' });
    }
});

/** The calls on one chat, for the thread's call lines. */
router.get('/conversations/:id/calls', async (req, res) => {
    try {
        const conversation = await loadConversation(req, req.params.id);
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
        const r = await db.query(`SELECT * FROM wa_calls WHERE conversation_id = $1 ORDER BY id DESC LIMIT 200`, [conversation.id]);
        res.json({ calls: r.rows.map(row => shapeCall(row, req)) });
    } catch (err) {
        console.error('whatsapp calls error:', err);
        res.status(500).json({ error: 'Could not load the calls' });
    }
});

/** May we ring this customer? */
router.get('/conversations/:id/call-permission', async (req, res) => {
    try {
        const conversation = await loadConversation(req, req.params.id);
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
        if (isDemo(conversation)) return demoRefusal(res);
        res.json({ ...(await calls.permission(conversation.phone)), window_open: conversation.window_open });
    } catch (err) { callError(res, err, 'Could not check the call permission'); }
});

/** Ask the customer, in the chat, whether we may call them. Only inside the 24-hour window. */
router.post('/conversations/:id/call-permission', async (req, res) => {
    try {
        const conversation = await loadConversation(req, req.params.id);
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
        if (isDemo(conversation)) return demoRefusal(res);
        if (!conversation.window_open) {
            return res.status(409).json({ error: 'This chat is past the 24-hour window — the customer has to write first (or call us) before we can ask to call.', window_closed: true });
        }
        const text = trim(req.body?.body) || 'May we give you a quick WhatsApp call about this?';
        const wamid = await calls.sendPermissionRequest(conversation.phone, text);
        const row = await db.query(
            `INSERT INTO wa_messages (conversation_id, wamid, direction, sender_type, sender_user, type, body, status)
             VALUES ($1,$2,'out','user',$3,'interactive',$4,'sent')
             RETURNING id, wamid, direction, sender_type, sender_user, type, body, status, error, sent_at`,
            [conversation.id, wamid, req.user?.username || null, `📞 Asked to call: ${text}`]);
        await db.query(`UPDATE wa_conversations SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = $2 WHERE id = $1`,
            [conversation.id, '📞 Asked permission to call']);
        res.status(201).json({ message: row.rows[0] });
    } catch (err) { callError(res, err, 'Could not send the call permission request'); }
});

/** Ring the customer. `sdp` is the browser's offer, with its ICE candidates gathered in. */
router.post('/conversations/:id/calls', async (req, res) => {
    try {
        const conversation = await loadConversation(req, req.params.id);
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
        if (isDemo(conversation)) return demoRefusal(res);
        const sdp = String(req.body?.sdp || '');
        if (!/^v=0/.test(sdp)) return res.status(400).json({ error: 'No call offer was sent' });
        const row = await calls.startOutbound({ conversation, username: req.user?.username || null, sdp });
        await db.query(`UPDATE wa_conversations SET assigned_to = COALESCE(assigned_to, $2) WHERE id = $1`,
            [conversation.id, req.user?.username || null]);
        res.status(201).json({ call: shapeCall(row, req) });
    } catch (err) { callError(res, err, 'Could not place the call'); }
});

/** One call's state — the caller polls this for WhatsApp's answer and for the call ending. */
router.get('/calls/:id', async (req, res) => {
    try {
        const row = await loadCall(req, req.params.id);
        if (!row) return res.status(404).json({ error: 'Call not found' });
        res.json({ call: shapeCall(row, req) });
    } catch (err) {
        console.error('whatsapp call error:', err);
        res.status(500).json({ error: 'Could not load that call' });
    }
});

/** Pick up a ringing customer call (step 1: claim it and hand WhatsApp our answer). */
router.post('/calls/:id/pre-accept', async (req, res) => {
    try {
        const row = await loadCall(req, req.params.id);
        if (!row) return res.status(404).json({ error: 'Call not found' });
        const sdp = String(req.body?.sdp || '');
        if (!/^v=0/.test(sdp)) return res.status(400).json({ error: 'No call answer was sent' });
        const claimed = await calls.preAccept({ callId: row.id, username: req.user?.username || null, sdp });
        if (!claimed) {
            const now = await loadCall(req, row.id);
            return res.status(409).json({ error: now?.answered_by ? `${String(now.answered_by).split('@')[0]} already took this call` : 'This call has ended' });
        }
        res.json({ call: shapeCall(claimed, req) });
    } catch (err) { callError(res, err, 'Could not answer the call'); }
});

/** Step 2: our side is connected; WhatsApp joins the customer in. */
router.post('/calls/:id/accept', async (req, res) => {
    try {
        const row = await loadCall(req, req.params.id);
        if (!row) return res.status(404).json({ error: 'Call not found' });
        if (String(row.answered_by || '').toLowerCase() !== String(req.user?.username || '').toLowerCase()) {
            return res.status(409).json({ error: 'Somebody else took this call' });
        }
        if (row.ended_at) return res.status(409).json({ error: 'This call has ended' });
        res.json({ call: shapeCall(await calls.accept({ callRow: row }), req) });
    } catch (err) { callError(res, err, 'Could not connect the call'); }
});

router.post('/calls/:id/reject', async (req, res) => {
    try {
        const row = await loadCall(req, req.params.id);
        if (!row) return res.status(404).json({ error: 'Call not found' });
        if (row.direction !== 'in' || row.ended_at) return res.json({ ok: true });
        await calls.reject({ callRow: row, username: req.user?.username || null });
        res.json({ ok: true });
    } catch (err) { callError(res, err, 'Could not decline the call'); }
});

router.post('/calls/:id/hangup', async (req, res) => {
    try {
        const row = await loadCall(req, req.params.id);
        if (!row) return res.status(404).json({ error: 'Call not found' });
        if (!row.ended_at) await calls.hangUp({ callRow: row });
        res.json({ call: shapeCall((await loadCall(req, row.id)) || row, req) });
    } catch (err) { callError(res, err, 'Could not hang up'); }
});

/** Who a conversation can be handed to. */
router.get('/agents', async (req, res) => {
    try {
        const r = await db.query(
            `SELECT username, role FROM admin_users
              WHERE COALESCE(is_active, true) = true
                AND (role IN ('owner','admin') OR COALESCE(${GRANTS[req.waLine.brand].view}, false) = true)
              ORDER BY LOWER(username)`);
        res.json({ agents: r.rows });
    } catch (err) {
        console.error('whatsapp agents error:', err);
        res.status(500).json({ error: 'Could not load the team' });
    }
});

/** The stages a lead can be in, for the inbox's filter and the side panel. */
router.get('/statuses', async (req, res) => {
    try {
        const r = await db.query(
            `SELECT key, name, color, description, stage, sort_order, is_default
               FROM wa_lead_statuses ORDER BY sort_order, name`);
        res.json({ statuses: r.rows });
    } catch (err) {
        console.error('whatsapp statuses error:', err);
        res.status(500).json({ error: 'Could not load the statuses' });
    }
});

/**
 * The lead behind a conversation, as the side panel edits it.
 *
 * Only through a conversation this person can see: a lead is somebody's customer, and a rep who
 * cannot open the thread has no business changing what it says about them.
 */
router.patch('/leads/:id', async (req, res) => {
    try {
        const params0 = [req.params.id];
        const seen = await db.query(
            `SELECT c.id FROM wa_conversations c JOIN wa_contacts k ON k.id = c.contact_id
              WHERE k.lead_id = $1 AND ${visibility(req, params0)} LIMIT 1`, params0);
        const conversationId = seen.rows[0]?.id;
        if (!conversationId) return res.status(404).json({ error: 'Lead not found' });

        const body = req.body || {};
        if ('status' in body) {
            const ok = await db.query('SELECT 1 FROM wa_lead_statuses WHERE key = $1', [String(body.status)]);
            if (!ok.rows[0]) return res.status(400).json({ error: 'That status no longer exists — reload the page' });
        }
        const sets = [];
        const params = [req.params.id];
        for (const key of ['name', 'company', 'email', 'product_interest', 'quantity', 'branding', 'status', 'notes', 'needed_by',
            'billing_name', 'billing_address', 'delivery_address', 'contact_person', 'billing_mobile', 'billing_email', 'gst_number']) {
            if (key in body) {
                params.push(trim(body[key]));
                sets.push(`${key} = $${params.length}`);
            }
        }
        for (const key of ['quoted_amount', 'received_amount']) {
            if (key in body) {
                const v = body[key] === '' || body[key] == null ? null : Number(body[key]);
                if (v != null && (!Number.isFinite(v) || v < 0)) return res.status(400).json({ error: 'Amounts have to be numbers' });
                params.push(v);
                sets.push(`${key} = $${params.length}`);
            }
        }
        if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });
        const r = await db.query(
            `UPDATE crewfit_leads SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP
              WHERE id = $1 RETURNING *`, params);
        if (!r.rows[0]) return res.status(404).json({ error: 'Lead not found' });

        if ('status' in body) {
            const name = (await db.query('SELECT name FROM wa_lead_statuses WHERE key = $1', [body.status])).rows[0]?.name;
            await orders.logActivity({ conversationId, kind: 'status', actor: req.user?.username,
                body: `${String(req.user?.username || '').split('@')[0]} set the status to ${name || body.status}` });
            // A new status may hand the conversation to another team: a mockup request to Design.
            const moved = await routing.reroute(conversationId, 'lead_status', body.status);
            if (moved) await orders.logActivity({ conversationId, kind: 'assign', body: `Assignment rules handed the chat to ${moved.split('@')[0]}` });
        }
        res.json({ lead: r.rows[0], conversation: await loadConversation(req, conversationId) });
    } catch (err) {
        console.error('whatsapp lead error:', err);
        res.status(500).json({ error: 'Could not update that enquiry' });
    }
});

/* ── The catalogue ───────────────────────────────────────────────────────────────────────────
   The products a rep can drop into a chat, straight off the Crewfit catalog. Sent as a text
   message with the published price tiers, because that is what a customer can read on any phone
   and what the quotes page already stands behind. */

const productText = (p) => {
    const tiers = safeJson(p.tiers, []);
    const lines = [`*${p.name}*`];
    const spec = [p.material, p.gsm ? `${p.gsm} GSM` : null, p.fit].filter(Boolean).join(' · ');
    if (spec) lines.push(spec);
    if (p.blurb) lines.push('', p.blurb);
    const priced = tiers.filter(([label]) => label);
    if (priced.length) {
        lines.push('', 'Price per piece:');
        for (const [label, price] of priced) {
            lines.push(`• ${label} pcs: ${typeof price === 'number' ? `₹${price}` : 'on request'}`);
        }
        lines.push('Before GST and branding.');
    } else if (p.from_price) {
        lines.push('', `From ₹${Number(p.from_price)} a piece, before GST and branding.`);
    }
    return lines.join('\n');
};

router.get('/catalogue', async (req, res) => {
    try {
        const r = await db.query(
            `SELECT id, name, category, fit, gsm, material, from_price, blurb, tiers, image_url
               FROM crewfit_products
              WHERE COALESCE(active, true) AND COALESCE(wa_visible, true)
              ORDER BY sort_order, name`);
        res.json({ products: r.rows.map(p => ({ ...p, tiers: safeJson(p.tiers, []), preview: productText(p) })) });
    } catch (err) {
        console.error('whatsapp catalogue error:', err);
        res.status(500).json({ error: 'Could not load the catalogue' });
    }
});

/** Send one product into a chat. */
router.post('/conversations/:id/product', async (req, res) => {
    try {
        if (!wa.configured()) return res.status(503).json({ error: 'WhatsApp is not configured on this server' });
        const conversation = await loadConversation(req, req.params.id);
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
        if (!wa.windowOpen(conversation.last_inbound_at)) {
            return res.status(409).json({ error: 'This chat is past WhatsApp’s 24-hour window — only an approved template can be sent now.' });
        }
        const p = (await db.query(
            `SELECT * FROM crewfit_products WHERE id = $1 AND COALESCE(active, true) AND COALESCE(wa_visible, true)`,
            [req.body?.product_id])).rows[0];
        if (!p) return res.status(404).json({ error: 'That product is not in the WhatsApp catalogue' });

        const body = productText(p);
        // With its photo when it has one: the details ride along as the caption.
        const photo = p.image_url && path.join(__dirname, '..', String(p.image_url).replace(/^\/+/, ''));
        const hasPhoto = photo && photo.startsWith(path.join(__dirname, '..', 'uploads') + path.sep) && fs.existsSync(photo);
        const mime = hasPhoto ? (/\.png$/i.test(photo) ? 'image/png' : /\.webp$/i.test(photo) ? 'image/webp' : 'image/jpeg') : null;
        let wamid;
        try {
            wamid = hasPhoto
                ? (await wa.sendMedia(conversation.phone, { filePath: photo, mime, filename: path.basename(photo), caption: body.slice(0, 1024) })).wamid
                : await wa.sendText(conversation.phone, body);
        } catch (err) {
            if (err instanceof wa.WhatsAppError) return res.status(502).json({ error: err.message });
            throw err;
        }
        const row = await db.query(
            `INSERT INTO wa_messages (conversation_id, wamid, direction, sender_type, sender_user, type, body,
                                      media_url, media_mime, status)
             VALUES ($1,$2,'out','user',$3,$4,$5,$6,$7,'sent')
             RETURNING id, wamid, direction, sender_type, sender_user, type, body, media_url,
                       media_mime, media_name, status, error, sent_at`,
            [conversation.id, wamid, req.user?.username || null, hasPhoto ? 'image' : 'text', body,
                hasPhoto ? p.image_url : null, mime]);
        await db.query(
            `UPDATE wa_conversations SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = $2,
                    status = 'open', assigned_to = COALESCE(assigned_to, $3), updated_at = CURRENT_TIMESTAMP
              WHERE id = $1`,
            [conversation.id, `Sent ${p.name}`.slice(0, 200), req.user?.username || null]);
        res.status(201).json({ message: row.rows[0] });
    } catch (err) {
        console.error('whatsapp product send error:', err);
        res.status(500).json({ error: 'Could not send that product' });
    }
});

/* ── Orders ──────────────────────────────────────────────────────────────────────────────────
   The Crewfit orders behind a conversation: the ones raised from it, and any other order on the
   same number. Each can send its payment links, invoices and tracking straight into the chat. */

async function ordersFor(conversation) {
    const last10 = String(conversation.phone || '').slice(-10);
    const r = await db.query(
        `SELECT o.id, o.sl_no, o.status, o.payment_status, o.grand_total, o.advance, o.balance,
                o.tracking_link, o.mot, o.order_date, o.product, o.qty, o.wa_lead_id,
                o.tracking_sent_at, o.photos_sent_at,
                COALESCE((SELECT JSON_AGG(JSON_BUILD_OBJECT('kind', p.kind, 'status', p.status, 'amount', p.amount,
                                   'url', p.razorpay_short_url, 'sent_at', p.sent_at) ORDER BY p.id)
                            FROM crewfit_payments p WHERE p.order_id = o.id AND p.status IN ('Created','Paid')), '[]') AS payments,
                COALESCE((SELECT JSON_AGG(JSON_BUILD_OBJECT('type', i.doc_type, 'number', i.number) ORDER BY i.id)
                            FROM crewfit_invoices i WHERE i.order_id = o.id AND i.status <> 'cancelled'), '[]') AS documents,
                -- When each order message last went, so the inbox can ask before sending it again.
                COALESCE((SELECT JSON_OBJECT_AGG(a.detail, a.last) FROM (
                            SELECT detail, MAX(created_at) AS last FROM wa_activity
                             WHERE order_id = o.id AND kind = 'message' AND detail IS NOT NULL GROUP BY detail) a), '{}') AS sent
           FROM crewfit_orders o
          WHERE ($1::int IS NOT NULL AND o.wa_lead_id = $1)
             OR ($2 <> '' AND (RIGHT(REGEXP_REPLACE(COALESCE(o.whatsapp_number,''), '\\D', '', 'g'), 10) = $2
                            OR RIGHT(REGEXP_REPLACE(COALESCE(o.contact_number,''), '\\D', '', 'g'), 10) = $2))
          ORDER BY o.sl_no DESC LIMIT 20`,
        [conversation.lead_id || null, last10.length === 10 ? last10 : '']);
    return r.rows;
}

router.get('/conversations/:id/orders', async (req, res) => {
    try {
        const conversation = await loadConversation(req, req.params.id);
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
        res.json({
            orders: await ordersFor(conversation),
            canEdit: await hasPermission(req, 'can_edit_crewfit_orders'),
            messages: Object.entries(orders.MESSAGES).map(([key, m]) => ({ key, label: m.label })),
        });
    } catch (err) {
        console.error('whatsapp orders error:', err);
        res.status(500).json({ error: 'Could not load the orders' });
    }
});

/**
 * Send one order message — summary, payment link, proforma, invoice, photos, tracking — into
 * this chat. Making payment links and issuing invoices are order-editing powers, so they need
 * that grant as well as the inbox.
 */
router.post('/conversations/:id/orders/:orderId/send', async (req, res) => {
    try {
        if (!await hasPermission(req, 'can_edit_crewfit_orders')) {
            return res.status(403).json({ error: 'Sending payment links and invoices needs edit access to bulk orders' });
        }
        const conversation = await loadConversation(req, req.params.id);
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
        const mine = (await ordersFor(conversation)).some(o => String(o.id) === String(req.params.orderId));
        if (!mine) return res.status(404).json({ error: 'That order is not on this customer' });
        const out = await orders.send(req.params.orderId, String(req.body?.kind || ''), { user: req.user?.username });
        res.status(201).json(out);
    } catch (err) {
        if (err instanceof orders.SendError) return res.status(err.status).json({ error: err.message });
        console.error('whatsapp order send error:', err);
        res.status(500).json({ error: 'Could not send that' });
    }
});

/** The whole catalogue PDF — the current version from the Catalog page. */
router.post('/conversations/:id/catalogue-pdf', async (req, res) => {
    try {
        if (!wa.configured()) return res.status(503).json({ error: 'WhatsApp is not configured on this server' });
        const conversation = await loadConversation(req, req.params.id);
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
        if (!wa.windowOpen(conversation.last_inbound_at)) {
            return res.status(409).json({ error: 'This chat is past WhatsApp’s 24-hour window — only an approved template can be sent now.' });
        }
        const message = await extras.sendCatalogue(conversation, { user: req.user?.username });
        await orders.logActivity({ conversationId: conversation.id, kind: 'message', actor: req.user?.username, body: 'Sent the catalogue PDF' });
        res.status(201).json({ message });
    } catch (err) {
        if (err instanceof wa.WhatsAppError) return res.status(502).json({ error: err.message });
        if (err.status) return res.status(err.status).json({ error: err.message });
        console.error('whatsapp catalogue pdf error:', err);
        res.status(500).json({ error: 'Could not send the catalogue' });
    }
});

/** Ask the customer for their billing details, and read the answers into the lead. */
router.post('/conversations/:id/billing', async (req, res) => {
    try {
        if (!wa.configured()) return res.status(503).json({ error: 'WhatsApp is not configured on this server' });
        const conversation = await loadConversation(req, req.params.id);
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
        if (!wa.windowOpen(conversation.last_inbound_at)) {
            return res.status(409).json({ error: 'This chat is past WhatsApp’s 24-hour window — the customer has to write first.' });
        }
        await billing.start({ ...conversation }, req.user?.username);
        await orders.logActivity({ conversationId: conversation.id, kind: 'message', actor: req.user?.username, body: 'Asked for billing details' });
        res.status(201).json({ conversation: await loadConversation(req, conversation.id) });
    } catch (err) {
        if (err instanceof wa.WhatsAppError) return res.status(502).json({ error: err.message });
        console.error('whatsapp billing start error:', err);
        res.status(500).json({ error: 'Could not ask for the details' });
    }
});

/** The payment QR on its own — for a customer with no order raised yet. */
router.post('/conversations/:id/payment-qr', async (req, res) => {
    try {
        if (!wa.configured()) return res.status(503).json({ error: 'WhatsApp is not configured on this server' });
        const conversation = await loadConversation(req, req.params.id);
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
        if (!wa.windowOpen(conversation.last_inbound_at)) {
            return res.status(409).json({ error: 'This chat is past WhatsApp’s 24-hour window — only an approved template can be sent now.' });
        }
        const s = (await db.query(`SELECT value FROM wa_settings WHERE key = 'payment_qr'`)).rows[0]?.value;
        const file = s && path.join(__dirname, '..', String(s).replace(/^\/+/, ''));
        if (!file || !file.startsWith(path.join(__dirname, '..', 'uploads') + path.sep) || !fs.existsSync(file)) {
            return res.status(404).json({ error: 'No payment QR has been uploaded yet — add it in WhatsApp settings › Order messages' });
        }
        const amount = Number(req.body?.amount) || null;
        const caption = [
            amount ? `Scan the QR code to pay *₹${amount.toLocaleString('en-IN')}*.` : 'Scan the QR code to complete your payment.',
            '', '📸 Once paid, please share the *payment screenshot* here so we can confirm it.',
        ].join('\n');
        const out = await wa.sendMedia(conversation.phone, { filePath: file, mime: 'image/jpeg', filename: 'Crewfit-payment-QR.jpg', caption });
        const row = (await db.query(
            `INSERT INTO wa_messages (conversation_id, wamid, direction, sender_type, sender_user, type, body, media_url, media_mime, status)
             VALUES ($1,$2,'out','user',$3,'image',$4,$5,'image/jpeg','sent')
             RETURNING id, wamid, direction, sender_type, sender_user, type, body, media_url, media_mime, media_name, status, error, sent_at`,
            [conversation.id, out.wamid, req.user?.username || null, caption, s])).rows[0];
        await db.query(`UPDATE wa_conversations SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = 'Sent the payment QR',
                               assigned_to = COALESCE(assigned_to, $2) WHERE id = $1`, [conversation.id, req.user?.username || null]);
        await orders.logActivity({ conversationId: conversation.id, kind: 'message', actor: req.user?.username, body: 'Sent the payment QR' });
        res.status(201).json({ message: row });
    } catch (err) {
        if (err instanceof wa.WhatsAppError) return res.status(502).json({ error: err.message });
        console.error('whatsapp payment qr error:', err);
        res.status(500).json({ error: 'Could not send the QR' });
    }
});

/** The catalogue PDF on file, so the reply box can say which version it will send. */
router.get('/catalogue-pdf', async (req, res) => {
    try {
        const f = await extras.currentCatalogue();
        res.json({ catalogue: f ? { filename: f.filename, version: f.version, title: f.title } : null });
    } catch (err) {
        console.error('whatsapp catalogue pdf info error:', err);
        res.status(500).json({ error: 'Could not read the catalogue' });
    }
});

/* ── Quotes ──────────────────────────────────────────────────────────────────────────────────
   Built with the same calculator and PDF as the Quotes page, sent as a WhatsApp document. */

async function quotesFor(conversation) {
    const last10 = String(conversation.phone || '').slice(-10);
    const r = await db.query(
        `SELECT q.id, q.customer_name, q.status, q.grand_total, q.product_total, q.shipping_charge, q.gst_amount,
                q.line_items, q.zone_label, q.converted_order_id AS order_id, q.created_at,
                (SELECT MAX(created_at) FROM wa_activity a WHERE a.kind = 'message' AND a.detail = 'quote:' || q.id) AS sent_at
           FROM crewfit_quotes q
          WHERE ($1::int IS NOT NULL AND q.wa_lead_id = $1)
             OR ($2 <> '' AND RIGHT(REGEXP_REPLACE(COALESCE(q.contact_number,''), '\\D', '', 'g'), 10) = $2)
          ORDER BY q.id DESC LIMIT 20`,
        [conversation.lead_id || null, last10.length === 10 ? last10 : '']);
    return r.rows.map(q => ({ ...q, line_items: safeJson(q.line_items, []) }));
}

router.get('/conversations/:id/quotes', async (req, res) => {
    try {
        const conversation = await loadConversation(req, req.params.id);
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
        res.json({ quotes: await quotesFor(conversation), canQuote: await hasPermission(req, 'can_view_crewfit_calculator') });
    } catch (err) {
        console.error('whatsapp quotes error:', err);
        res.status(500).json({ error: 'Could not load the quotes' });
    }
});

/** The quotation PDF into the chat, with the totals as the caption. */
router.post('/conversations/:id/quotes/:quoteId/send', async (req, res) => {
    try {
        if (!await hasPermission(req, 'can_view_crewfit_calculator')) {
            return res.status(403).json({ error: 'Sending quotes needs access to Crewfit quotes' });
        }
        if (!wa.configured()) return res.status(503).json({ error: 'WhatsApp is not configured on this server' });
        const conversation = await loadConversation(req, req.params.id);
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
        if (!(await quotesFor(conversation)).some(q => String(q.id) === String(req.params.quoteId))) {
            return res.status(404).json({ error: 'That quote is not on this customer' });
        }
        if (!wa.windowOpen(conversation.last_inbound_at)) {
            return res.status(409).json({ error: 'This chat is past WhatsApp’s 24-hour window — the customer has to write first.' });
        }
        const { quotePdfBuffer } = require('./crewfit-quotes');
        const pdf = await quotePdfBuffer(req.params.quoteId);
        if (!pdf) return res.status(404).json({ error: 'Quote not found' });
        const stored = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}.pdf`;
        fs.mkdirSync(SEND_ROOT, { recursive: true });
        fs.writeFileSync(path.join(SEND_ROOT, stored), pdf.buffer);
        const inr = (v) => `₹${Number(v || 0).toLocaleString('en-IN')}`;
        const q = pdf.quote;
        const caption = [
            `Hi ${String(q.customer_name || '').split(/\s+/)[0] || 'there'}! Here is your Crewfit quotation 📄`, '',
            ...(q.line_items || []).map(li => `• ${li.product_name} × ${li.qty} — ${inr(li.price_per_piece)}/pc`),
            '', `Shipping: ${inr(q.shipping_charge)} · GST (5%): ${inr(q.gst_amount)}`,
            `*Grand total: ${inr(q.grand_total)}*`, '',
            'Reply *OK* to confirm and we will take your billing details to start the order 🙌',
        ].join('\n');
        let out;
        try {
            out = await wa.sendMedia(conversation.phone, { filePath: path.join(SEND_ROOT, stored), mime: 'application/pdf', filename: pdf.filename, caption });
        } catch (err) {
            if (err instanceof wa.WhatsAppError) return res.status(502).json({ error: err.message });
            throw err;
        }
        const row = (await db.query(
            `INSERT INTO wa_messages (conversation_id, wamid, direction, sender_type, sender_user, type, body, media_url, media_mime, media_name, status)
             VALUES ($1,$2,'out','user',$3,'document',$4,$5,'application/pdf',$6,'sent')
             RETURNING id, wamid, direction, sender_type, sender_user, type, body, media_url, media_mime, media_name, status, error, sent_at`,
            [conversation.id, out.wamid, req.user?.username || null, caption, `/uploads/whatsapp/outgoing/${stored}`, pdf.filename])).rows[0];
        await db.query(`UPDATE wa_conversations SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = $2,
                               assigned_to = COALESCE(assigned_to, $3), updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [conversation.id, `📄 Quote #${q.id} — ${inr(q.grand_total)}`, req.user?.username || null]);
        await db.query(`UPDATE crewfit_quotes SET status = CASE WHEN status = 'Draft' THEN 'Sent' ELSE status END WHERE id = $1`, [q.id]);
        await orders.logActivity({ conversationId: conversation.id, kind: 'message', actor: req.user?.username,
            body: `Sent quote #${q.id} — ${inr(q.grand_total)}`, detail: `quote:${q.id}` });
        res.status(201).json({ message: row });
    } catch (err) {
        console.error('whatsapp quote send error:', err);
        res.status(500).json({ error: 'Could not send the quote' });
    }
});

/**
 * The chat for a Crewfit order — the Bulk Orders page's "WhatsApp" button. Made if the customer
 * has never written to us, so the conversation is there to start from.
 */
router.get('/orders/:orderId/conversation', async (req, res) => {
    try {
        const order = (await db.query('SELECT * FROM crewfit_orders WHERE id = $1', [req.params.orderId])).rows[0];
        if (!order) return res.status(404).json({ error: 'Order not found' });
        let conv;
        try { conv = await orders.threadForOrder(order); }
        catch (err) {
            if (err instanceof orders.SendError) return res.status(400).json({ error: err.message });
            throw err;
        }
        const conversation = await loadConversation(req, conv.id);
        if (!conversation) return res.status(403).json({ error: 'That chat is assigned to someone else — ask a manager to hand it to you' });
        res.json({ conversation });
    } catch (err) {
        console.error('whatsapp order conversation error:', err);
        res.status(500).json({ error: 'Could not open the chat for that order' });
    }
});

/* ── Design mockups ───────────────────────────────────────────────────────────────────────────
   A designer uploads the mockup against the enquiry and sends it from the lead panel, with a
   request to approve it. Images go as images; a PDF mockup as a document. */

const MOCK_DIR = path.join(__dirname, '..', 'uploads', 'whatsapp', 'mockups');
const mockUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => { fs.mkdirSync(MOCK_DIR, { recursive: true }); cb(null, MOCK_DIR); },
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname || '').toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 6);
            cb(null, `${req.params.id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
        },
    }),
    limits: { fileSize: 15 * 1024 * 1024, files: 10 },
    fileFilter: (req, file, cb) => (/^image\//.test(file.mimetype) || file.mimetype === 'application/pdf'
        ? cb(null, true) : cb(new Error('Mockups are images or PDFs'))),
});

const mockupRows = async (conversationId) => (await db.query(
    `SELECT id, url, file_name, mime, uploaded_by, sent_at, sent_by, created_at FROM wa_mockups
      WHERE conversation_id = $1 ORDER BY id`, [conversationId])).rows;

router.get('/conversations/:id/mockups', async (req, res) => {
    try {
        const conversation = await loadConversation(req, req.params.id);
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
        res.json({ mockups: await mockupRows(conversation.id) });
    } catch (err) {
        console.error('whatsapp mockups error:', err);
        res.status(500).json({ error: 'Could not load the mockups' });
    }
});

router.post('/conversations/:id/mockups', (req, res, next) => mockUpload.array('files', 10)(req, res, (err) => {
    if (!err) return lines.resume(req, next);
    res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Each mockup must be under 15MB' : err.message });
}), async (req, res) => {
    try {
        const conversation = await loadConversation(req, req.params.id);
        if (!conversation) {
            for (const f of req.files || []) fs.promises.unlink(f.path).catch(() => {});
            return res.status(404).json({ error: 'Conversation not found' });
        }
        if (!req.files?.length) return res.status(400).json({ error: 'Choose the mockup files' });
        for (const f of req.files) {
            await db.query(
                `INSERT INTO wa_mockups (conversation_id, url, file_name, mime, uploaded_by) VALUES ($1,$2,$3,$4,$5)`,
                [conversation.id, `/uploads/whatsapp/mockups/${f.filename}`, f.originalname, f.mimetype, req.user?.username || null]);
        }
        await orders.logActivity({ conversationId: conversation.id, kind: 'order', actor: req.user?.username,
            body: `${String(req.user?.username || '').split('@')[0]} uploaded ${req.files.length} mockup${req.files.length > 1 ? 's' : ''}` });
        res.status(201).json({ mockups: await mockupRows(conversation.id) });
    } catch (err) {
        console.error('whatsapp mockup upload error:', err);
        res.status(500).json({ error: 'Could not save the mockups' });
    }
});

router.delete('/conversations/:id/mockups/:mockupId', async (req, res) => {
    try {
        const conversation = await loadConversation(req, req.params.id);
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
        const row = (await db.query('DELETE FROM wa_mockups WHERE id = $1 AND conversation_id = $2 RETURNING url',
            [req.params.mockupId, conversation.id])).rows[0];
        // Removed from the list; the file stays if it was sent, since the thread shows it.
        if (row && !(await db.query('SELECT 1 FROM wa_messages WHERE media_url = $1 LIMIT 1', [row.url])).rows[0]) {
            fs.promises.unlink(path.join(MOCK_DIR, path.basename(row.url))).catch(() => {});
        }
        res.json({ mockups: await mockupRows(conversation.id) });
    } catch (err) {
        console.error('whatsapp mockup delete error:', err);
        res.status(500).json({ error: 'Could not remove that mockup' });
    }
});

/** Send the chosen mockups and ask the customer to approve them. */
router.post('/conversations/:id/mockups/send', async (req, res) => {
    try {
        if (!wa.configured()) return res.status(503).json({ error: 'WhatsApp is not configured on this server' });
        const conversation = await loadConversation(req, req.params.id);
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
        if (!wa.windowOpen(conversation.last_inbound_at)) {
            return res.status(409).json({ error: 'This chat is past WhatsApp’s 24-hour window — send the “Design mockups” template from the order, or wait for the customer to write.' });
        }
        const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Boolean);
        const rows = (await mockupRows(conversation.id)).filter(m => !ids.length || ids.includes(m.id));
        if (!rows.length) return res.status(400).json({ error: 'Upload a mockup first' });

        const first = String(conversation.lead_name || conversation.profile_name || '').trim().split(/\s+/)[0] || 'there';
        const ask = [`Hi ${first}! 🎨`, '',
            `Here is the design mockup for your order. Please check the placement, colours and spelling.`, '',
            'Reply *OK* to approve it, or tell us what you would like changed. Production starts once it is approved. 🙌'].join('\n');
        const sent = [];
        try {
            for (const [i, m] of rows.entries()) {
                const file = path.join(MOCK_DIR, path.basename(m.url));
                const caption = i === rows.length - 1 ? ask : '';
                const out = await wa.sendMedia(conversation.phone, { filePath: file, mime: m.mime || 'image/jpeg', filename: m.file_name || path.basename(file), caption });
                sent.push((await db.query(
                    `INSERT INTO wa_messages (conversation_id, wamid, direction, sender_type, sender_user, type, body, media_url, media_mime, media_name, status)
                     VALUES ($1,$2,'out','user',$3,$4,$5,$6,$7,$8,'sent')
                     RETURNING id, wamid, direction, sender_type, sender_user, type, body, media_url, media_mime, media_name, status, error, sent_at`,
                    [conversation.id, out.wamid, req.user?.username || null, out.kind, caption || null, m.url, m.mime, m.file_name])).rows[0]);
                await db.query('UPDATE wa_mockups SET sent_at = CURRENT_TIMESTAMP, sent_by = $2 WHERE id = $1', [m.id, req.user?.username || null]);
            }
        } catch (err) {
            if (err instanceof wa.WhatsAppError) return res.status(502).json({ error: err.message, messages: sent });
            throw err;
        }
        await db.query(`UPDATE wa_conversations SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = 'Sent the design mockup',
                               updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [conversation.id]);
        await orders.logActivity({ conversationId: conversation.id, kind: 'message', actor: req.user?.username,
            body: `Sent ${rows.length} mockup${rows.length > 1 ? 's' : ''} for approval`, detail: 'mockups' });
        res.status(201).json({ messages: sent, mockups: await mockupRows(conversation.id) });
    } catch (err) {
        console.error('whatsapp mockup send error:', err);
        res.status(500).json({ error: 'Could not send the mockups' });
    }
});

/** The enquiry's timeline: status moves, hand-offs, orders, payments, messages sent for it. */
/* ── Normless: the shop's customer behind a chat ─────────────────────────────────────────────
   A Normless chat is nearly always about an order: where it is, the wrong size, a torn seam. So
   the side panel shows who the customer is in Shopify, what they bought, where each parcel is,
   what the refund policy says about it, and the support tickets already raised — and a ticket
   can be raised from the chat with the customer's photos already on it. */

const NORMLESS_ONLY = /^\/conversations\/\d+\/(customer|ticket)(\/|$)/;
router.use((req, res, next) => (NORMLESS_ONLY.test(req.path) && req.waLine?.brand !== 'normless'
    ? res.status(404).json({ error: 'Not part of this inbox' }) : next()));

const { paymentKind } = require('../services/nl-shop');

/** The demo chat's panel: the design's own example, invented, so no real customer is shown. */
function demoCustomer() {
    const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
    return {
        demo: true,
        customer: { id: null, name: 'Demo Customer', first_name: 'Demo', email: 'demo@example.com', orders_count: 3, total_spent: 2497, created_at: ago(220) },
        orders: [
            {
                order_number: '#DEMO-1', created_at: ago(4), total_price: 699, payment: paymentKind('PAID'), state: 'Shipped', shipped_at: ago(3),
                items: [{ title: 'Acid Wash Tank Midnight', variant: 'Black / L', quantity: 1, price: '699.00' }],
                dispatch: { awb: 'DEMO00000000', courier: 'Delhivery', tracking_url: null }, tickets: [-1],
            },
            {
                order_number: '#DEMO-2', created_at: ago(1), total_price: 1348, payment: paymentKind('PARTIALLY_PAID'), state: 'Not shipped yet', shipped_at: null,
                items: [{ title: 'AMG Petronas', variant: 'Black / M', quantity: 1, price: '699.00' }, { title: 'CR7 Minimal Classic Tee', variant: 'White / M', quantity: 1, price: '649.00' }],
                dispatch: null, tickets: [],
            },
        ],
        tickets: [{ id: -1, ref_no: 0, order_number: '#DEMO-1', nature: 'Return & Replacement', reason: 'Size Change', status: 'Closed', progress: 'Completed', action: 'Replacement Initiated', raised_on: ago(40).slice(0, 10) }],
        media: { photos: 1, videos: 1 },
    };
}

router.get('/conversations/:id/customer', async (req, res) => {
    try {
        const conversation = await loadConversation(req, req.params.id);
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
        if (isDemo(conversation)) return res.json(demoCustomer());
        res.json(await nlShop.customerFor(conversation));
    } catch (err) {
        console.error('whatsapp customer error:', err);
        res.status(500).json({ error: 'Could not load the customer' });
    }
});

/**
 * Tie a support ticket raised from this chat to it, and copy the customer's photos onto it.
 *
 * The ticket itself is raised through the Support API, with Support's own permission; this only
 * adds what the chat knows. Photos are copied rather than linked, so the ticket keeps its proof
 * even if the chat's files are ever cleared. Videos stay in the chat, which the ticket now links to.
 */
const TICKET_IMAGE_TYPES = /^image\/(jpeg|png|webp)$/;
const TICKET_MAX_IMAGES = 8;
router.post('/conversations/:id/ticket', async (req, res) => {
    try {
        if (!await hasPermission(req, 'can_edit_support')) {
            return res.status(403).json({ error: 'Raising a support ticket needs edit access to Support' });
        }
        const conversation = await loadConversation(req, req.params.id);
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
        if (isDemo(conversation)) return demoRefusal(res);
        const ticketId = parseInt(req.body?.ticket_id, 10) || 0;
        const ticket = (await db.query('SELECT id, ref_no, images FROM support_tickets WHERE id = $1', [ticketId])).rows[0];
        if (!ticket) return res.status(404).json({ error: 'That ticket is gone' });

        const ids = (Array.isArray(req.body?.message_ids) ? req.body.message_ids : []).map(Number).filter(Boolean);
        const picked = ids.length ? (await db.query(
            `SELECT id, media_url, media_mime FROM wa_messages
              WHERE conversation_id = $1 AND id = ANY($2) AND media_url IS NOT NULL ORDER BY id`,
            [conversation.id, ids])).rows.filter(m => TICKET_IMAGE_TYPES.test(m.media_mime || '')) : [];

        let images = safeJson(ticket.images, []);
        const dir = path.join(__dirname, '..', 'uploads', 'support', String(ticket.id));
        const uploadsRoot = path.join(__dirname, '..', 'uploads');
        let copied = 0;
        for (const m of picked) {
            if (images.length >= TICKET_MAX_IMAGES) break;
            // Only files under the WhatsApp uploads: the stored URL decides the path, so it is
            // checked rather than trusted.
            const from = path.join(uploadsRoot, String(m.media_url).replace(/^\/uploads\//, ''));
            if (!from.startsWith(path.join(uploadsRoot, 'whatsapp') + path.sep)) continue;
            const name = `${Date.now()}-wa${m.id}${path.extname(from).toLowerCase().replace(/[^a-z0-9.]/g, '') || '.jpg'}`;
            try {
                await fsp.mkdir(dir, { recursive: true });
                await fsp.copyFile(from, path.join(dir, name));
                images = [...images, `/uploads/support/${ticket.id}/${name}`];
                copied++;
            } catch (err) {
                console.error('whatsapp ticket photo copy failed:', err.message);
            }
        }
        await db.query(
            `UPDATE support_tickets SET wa_conversation_id = $2, images = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [ticket.id, conversation.id, JSON.stringify(images)]);
        const ref = `CS-${String(ticket.ref_no ?? 0).padStart(4, '0')}`;
        await orders.logActivity({
            conversationId: conversation.id, kind: 'ticket', actor: req.user?.username,
            body: `${String(req.user?.username || '').split('@')[0]} raised ${ref}${copied ? ` with ${copied} photo${copied === 1 ? '' : 's'} from the chat` : ''}`,
        });
        res.json({ ok: true, ref, copied, images });
    } catch (err) {
        console.error('whatsapp ticket link error:', err);
        res.status(500).json({ error: 'The ticket was raised, but could not be tied to this chat' });
    }
});

router.get('/conversations/:id/activity', async (req, res) => {
    try {
        const conversation = await loadConversation(req, req.params.id);
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
        const r = await db.query(
            `SELECT id, kind, body, actor, order_id, created_at FROM wa_activity
              WHERE conversation_id = $1 ORDER BY id DESC LIMIT 50`, [conversation.id]);
        res.json({ activity: r.rows });
    } catch (err) {
        console.error('whatsapp activity error:', err);
        res.status(500).json({ error: 'Could not load the activity' });
    }
});

/* ── Quick replies ───────────────────────────────────────────────────────────────────────────
   Anyone answering can use them and save new ones from the reply box. Changing or removing one
   is for whoever wrote it, or a manager — they are shared, so one rep cannot quietly rewrite
   what everybody else sends. */

router.get('/quick-replies', async (req, res) => {
    try {
        const r = await db.query(
            `SELECT id, title, body, sort_order, created_by FROM wa_quick_replies
              WHERE line_id = $1 ORDER BY sort_order, LOWER(title)`, [req.waLine.id]);
        res.json({ quickReplies: r.rows });
    } catch (err) {
        console.error('whatsapp quick replies error:', err);
        res.status(500).json({ error: 'Could not load the saved replies' });
    }
});

/** Changing the line's setup — the menu, its settings, templates — is the Settings grant. */
function settingsOnly(req, res, next) {
    return req.waSettings ? next() : res.status(403).json({ error: 'You don’t have access to WhatsApp settings' });
}

const manager = (req, res, next) =>
    (req.waManager ? next() : res.status(403).json({ error: 'Only a manager can change the saved replies' }));

router.post('/quick-replies', async (req, res) => {
    try {
        const title = trim(req.body?.title);
        const body = trim(req.body?.body);
        if (!title || !body) return res.status(400).json({ error: 'A saved reply needs a name and some words' });
        const r = await db.query(
            `INSERT INTO wa_quick_replies (title, body, sort_order, created_by, line_id)
             VALUES ($1,$2,COALESCE((SELECT MAX(sort_order) + 1 FROM wa_quick_replies WHERE line_id = $4), 0),$3,$4)
             RETURNING id, title, body, sort_order, created_by`,
            [title, body, req.user?.username || null, req.waLine.id]);
        res.status(201).json({ quickReply: r.rows[0] });
    } catch (err) {
        console.error('whatsapp quick reply create error:', err);
        res.status(500).json({ error: 'Could not save that reply' });
    }
});

const ownReply = async (req, res, next) => {
    try {
        const r = await db.query('SELECT created_by FROM wa_quick_replies WHERE id = $1 AND line_id = $2',
            [req.params.id, req.waLine.id]);
        if (!r.rows[0]) return res.status(404).json({ error: 'That saved reply is gone' });
        if (req.waManager) return next();
        if (String(r.rows[0].created_by || '').toLowerCase() !== String(req.user?.username || '').toLowerCase()) {
            return res.status(403).json({ error: 'Only whoever saved it, or a manager, can change this reply' });
        }
        next();
    } catch (err) { next(err); }
};

router.patch('/quick-replies/:id', ownReply, async (req, res) => {
    try {
        const sets = [];
        const params = [req.params.id];
        for (const key of ['title', 'body']) {
            if (key in (req.body || {})) {
                params.push(trim(req.body[key]));
                sets.push(`${key} = $${params.length}`);
            }
        }
        if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });
        const r = await db.query(
            `UPDATE wa_quick_replies SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP
              WHERE id = $1 AND line_id = ${req.waLine.id} RETURNING id, title, body, sort_order, created_by`, params);
        if (!r.rows[0]) return res.status(404).json({ error: 'That saved reply is gone' });
        res.json({ quickReply: r.rows[0] });
    } catch (err) {
        console.error('whatsapp quick reply update error:', err);
        res.status(500).json({ error: 'Could not change that reply' });
    }
});

router.delete('/quick-replies/:id', ownReply, async (req, res) => {
    try {
        await db.query('DELETE FROM wa_quick_replies WHERE id = $1 AND line_id = $2', [req.params.id, req.waLine.id]);
        res.json({ ok: true });
    } catch (err) {
        console.error('whatsapp quick reply delete error:', err);
        res.status(500).json({ error: 'Could not remove that reply' });
    }
});

/* ── Internal notes ──────────────────────────────────────────────────────────────────────────
   Kept in their own table, and read and written by routes that cannot send anything: there is no
   path from here to the customer's phone, which is the only guarantee worth having. */

router.get('/conversations/:id/notes', async (req, res) => {
    try {
        const conversation = await loadConversation(req, req.params.id);
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
        const r = await db.query(
            `SELECT id, author, body, created_at FROM wa_notes
              WHERE conversation_id = $1 ORDER BY id DESC LIMIT 100`, [conversation.id]);
        res.json({ notes: r.rows });
    } catch (err) {
        console.error('whatsapp notes error:', err);
        res.status(500).json({ error: 'Could not load the notes' });
    }
});

router.post('/conversations/:id/notes', async (req, res) => {
    try {
        const conversation = await loadConversation(req, req.params.id);
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
        const body = trim(req.body?.body);
        if (!body) return res.status(400).json({ error: 'The note is empty' });
        const r = await db.query(
            `INSERT INTO wa_notes (conversation_id, author, body) VALUES ($1,$2,$3)
             RETURNING id, author, body, created_at`,
            [conversation.id, req.user?.username || null, body]);
        res.status(201).json({ note: r.rows[0] });
    } catch (err) {
        console.error('whatsapp note create error:', err);
        res.status(500).json({ error: 'Could not save that note' });
    }
});

/* ── The menu ────────────────────────────────────────────────────────────────────────────────
   Reading it needs the inbox; changing it or switching it on needs the manager grant, because a
   flow speaks to customers in the shop's name. */

router.get('/flows', async (req, res) => {
    try {
        const r = await db.query(
            `SELECT id, key, name, definition, is_active, updated_by, updated_at
               FROM wa_flows ORDER BY id`);
        res.json({ flows: r.rows.map(f => ({ ...f, definition: safeJson(f.definition, null) })) });
    } catch (err) {
        console.error('whatsapp flows error:', err);
        res.status(500).json({ error: 'Could not load the menus' });
    }
});

router.put('/flows/:key', settingsOnly, async (req, res) => {
    try {
        const sets = [];
        const params = [req.params.key];

        if ('definition' in (req.body || {})) {
            const definition = req.body.definition;
            const problem = validateFlow(definition);
            if (problem) return res.status(400).json({ error: problem });
            params.push(JSON.stringify(definition));
            sets.push(`definition = $${params.length}`);
        }
        if ('is_active' in (req.body || {})) {
            const on = !!req.body.is_active;
            // One menu at a time: two flows both claiming new conversations would answer the
            // same customer twice.
            if (on) await db.query('UPDATE wa_flows SET is_active = false WHERE key <> $1', [req.params.key]);
            params.push(on);
            sets.push(`is_active = $${params.length}`);
        }
        if ('name' in (req.body || {})) {
            params.push(trim(req.body.name));
            sets.push(`name = $${params.length}`);
        }
        if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });

        params.push(req.user?.username || null);
        const r = await db.query(
            `UPDATE wa_flows SET ${sets.join(', ')}, updated_by = $${params.length},
                    updated_at = CURRENT_TIMESTAMP
              WHERE key = $1 RETURNING id, key, name, definition, is_active, updated_by, updated_at`,
            params);
        if (!r.rows[0]) return res.status(404).json({ error: 'No such menu' });
        res.json({ flow: { ...r.rows[0], definition: safeJson(r.rows[0].definition, null) } });
    } catch (err) {
        console.error('whatsapp flow update error:', err);
        res.status(500).json({ error: 'Could not save that menu' });
    }
});

/**
 * What a flow has to be before it is allowed to speak to a customer.
 *
 * Checked on the way in rather than discovered halfway through a conversation, where the
 * customer is the one who finds out. WhatsApp's own caps are enforced too: it refuses a message
 * with four buttons outright, and a menu that cannot send is a conversation that stops dead.
 */
function validateFlow(definition) {
    if (!definition || typeof definition !== 'object') return 'A menu needs to be an object';
    const steps = definition.steps;
    if (!steps || typeof steps !== 'object' || !Object.keys(steps).length) return 'A menu needs at least one step';
    if (!definition.start || !steps[definition.start]) return 'The menu has to say which step it starts on';

    const KINDS = ['text', 'buttons', 'list', 'ask_text', 'ask_media', 'summary', 'send_catalogue'];
    for (const [id, step] of Object.entries(steps)) {
        if (!KINDS.includes(step?.type)) return `Step "${id}" has an unknown type`;
        if (!['summary', 'send_catalogue'].includes(step.type) && !trim(step.text)) return `Step "${id}" has nothing to say`;
        if (step.type === 'buttons') {
            const buttons = step.buttons || [];
            if (!buttons.length) return `Step "${id}" needs at least one button`;
            if (buttons.length > wa.CAP.buttons) return `Step "${id}" has ${buttons.length} buttons — WhatsApp allows ${wa.CAP.buttons}`;
            for (const b of buttons) {
                if (!trim(b?.id) || !trim(b?.title)) return `A button in step "${id}" is missing its id or title`;
                if (String(b.title).length > wa.CAP.buttonTitle) return `Button "${b.title}" is longer than WhatsApp's ${wa.CAP.buttonTitle} characters`;
            }
        }
        if (step.type === 'list') {
            const rows = (step.sections || []).flatMap(sec => sec.rows || []);
            if (!rows.length) return `Step "${id}" needs at least one row`;
            if (rows.length > wa.CAP.rows) return `Step "${id}" has ${rows.length} rows — WhatsApp allows ${wa.CAP.rows}`;
            for (const row of rows) {
                if (!trim(row?.id) || !trim(row?.title)) return `A row in step "${id}" is missing its id or title`;
                if (String(row.title).length > wa.CAP.rowTitle) return `Row "${row.title}" is longer than WhatsApp's ${wa.CAP.rowTitle} characters`;
            }
        }
        for (const [reply, target] of Object.entries(step.next || {})) {
            if (!steps[target]) return `Step "${id}" sends "${reply}" to "${target}", which does not exist`;
        }
    }
    return null;
}

/**
 * Who is answering this conversation: the menu, or a person.
 *
 * "Take over" is the button a rep reaches for when a customer is going round in circles, and it
 * has to work immediately — so it is a plain column change, not a request to the menu to stop.
 */
router.post('/conversations/:id/mode', async (req, res) => {
    try {
        const conversation = await loadConversation(req, req.params.id);
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
        const next = String(req.body?.mode || '');
        if (!['human', 'flow', 'ai'].includes(next)) return res.status(400).json({ error: 'Unknown mode' });

        // Normless: "Take over" stops the bot and gives the chat to whoever clicked; "Hand back to
        // the bot" lets it answer again.
        if (req.waLine.brand === 'normless') {
            if (next === 'human') {
                if (conversation.is_demo) await db.query(`UPDATE wa_conversations SET mode = 'human', assigned_to = $2 WHERE id = $1`, [conversation.id, req.user?.username]);
                else await nlHandover.assign(conversation, req.user?.username, { actor: req.user?.username });
            } else if (next === 'ai') {
                // Back to whichever machine is answering: the AI bot, or the menu without a key.
                const who = await nlBot.engine(req.waLine.id);
                if (!who) return res.status(400).json({ error: 'Neither the bot nor the menu is switched on — turn one on in WhatsApp › Settings' });
                await db.query(
                    `UPDATE wa_conversations SET mode = $2, assigned_to = NULL, nl_handoff_at = NULL, flow_step = NULL, flow_data = '{}', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                    [conversation.id, who]);
                await orders.logActivity({ conversationId: conversation.id, kind: 'status', actor: req.user?.username,
                    body: `${String(req.user?.username || '').split('@')[0]} handed the chat back to the ${who === 'ai' ? 'bot' : 'menu'}` });
                // The menu speaks first, so the customer sees the options again.
                if (who === 'flow' && !conversation.is_demo && conversation.window_open) {
                    const { readSettings } = require('../services/nl-settings');
                    await require('../services/nl-flow').start(conversation, await readSettings(req.waLine.id)).catch(err => console.error('normless menu start failed:', err.message));
                }
            } else {
                return res.status(400).json({ error: 'Normless has no menu flow' });
            }
            return res.json({ conversation: await loadConversation(req, conversation.id) });
        }
        // Taking over from the billing questions keeps what was collected; it is already on the lead.

        if (next === 'human') {
            await db.query(
                `UPDATE wa_conversations SET mode = 'human', flow_step = NULL,
                        assigned_to = COALESCE(assigned_to, $2), updated_at = CURRENT_TIMESTAMP
                  WHERE id = $1`, [conversation.id, req.user?.username || null]);
        } else if (next === 'ai') {
            if (!await ai.enabled()) {
                return res.status(400).json({ error: 'The assistant is switched off — turn it on at the top of the page' });
            }
            await db.query(
                `UPDATE wa_conversations SET mode = 'ai', flow_step = NULL, updated_at = CURRENT_TIMESTAMP
                  WHERE id = $1`, [conversation.id]);
        } else {
            if (!wa.configured()) return res.status(503).json({ error: 'WhatsApp is not configured on this server' });
            if (!wa.windowOpen(conversation.last_inbound_at)) {
                return res.status(409).json({ error: 'The 24-hour window has closed — the menu cannot be started now.' });
            }
            const started = await flow.start({ ...conversation, lead_id: conversation.lead_id });
            if (!started) return res.status(400).json({ error: 'No menu is switched on' });
        }
        res.json({ conversation: await loadConversation(req, conversation.id) });
    } catch (err) {
        console.error('whatsapp mode error:', err);
        res.status(500).json({ error: 'Could not change who is answering' });
    }
});

/* ── Settings ────────────────────────────────────────────────────────────────────────────────
   Just now this is one switch, but it is the switch that decides whether a machine is talking to
   customers in the shop's name, so it is a stored row rather than an environment variable
   somebody has to deploy to change. */

router.get('/settings', async (req, res) => {
    try {
        const r = await db.query('SELECT key, value FROM wa_settings');
        const settings = Object.fromEntries(r.rows.map(x => [x.key, x.value]));
        res.json({
            settings,
            aiEnabled: settings.ai_enabled === 'true',
            // Without a key the switch cannot do anything, and the page should say so rather
            // than offer a toggle that silently achieves nothing.
            aiAvailable: !!process.env.ANTHROPIC_API_KEY,
            aiModel: ai.MODEL,
        });
    } catch (err) {
        console.error('whatsapp settings error:', err);
        res.status(500).json({ error: 'Could not read the settings' });
    }
});

router.put('/settings', settingsOnly, async (req, res) => {
    try {
        if ('ai_enabled' in (req.body || {})) {
            const on = !!req.body.ai_enabled;
            if (on && !process.env.ANTHROPIC_API_KEY) {
                return res.status(400).json({ error: 'No ANTHROPIC_API_KEY is set on the server, so the assistant cannot answer' });
            }
            await db.query(
                `INSERT INTO wa_settings (key, value, updated_by, updated_at)
                 VALUES ('ai_enabled', $1, $2, CURRENT_TIMESTAMP)
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value,
                     updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`,
                [on ? 'true' : 'false', req.user?.username || null]);
        }
        const r = await db.query('SELECT key, value FROM wa_settings');
        res.json({ settings: Object.fromEntries(r.rows.map(x => [x.key, x.value])) });
    } catch (err) {
        console.error('whatsapp settings update error:', err);
        res.status(500).json({ error: 'Could not change that' });
    }
});

/* ── Templates ───────────────────────────────────────────────────────────────────────────────
   What can still be said after the 24-hour window shuts. Meta approves the wording in advance;
   the inbox keeps a copy so a rep can pick one without a round trip, and a send records the
   words that actually went out rather than the template's name. */

router.get('/templates', async (req, res) => {
    try {
        const r = await db.query(
            `SELECT id, name, language, category, status, body_text, variables, header_kind, var_map, synced_at
               FROM wa_templates WHERE status = 'APPROVED' AND line_id = $1 ORDER BY LOWER(name)`, [req.waLine.id]);
        res.json({ templates: r.rows.map(t => ({ ...t, var_map: safeJson(t.var_map, []) })) });
    } catch (err) {
        console.error('whatsapp templates error:', err);
        res.status(500).json({ error: 'Could not load the templates' });
    }
});

router.post('/templates/sync', settingsOnly, async (req, res) => {
    try {
        if (!wa.configured()) return res.status(503).json({ error: 'WhatsApp is not configured on this server' });
        const templates = await wa.fetchTemplates();
        const startedAt = new Date();
        for (const t of templates) {
            await db.query(
                `INSERT INTO wa_templates (name, language, category, status, body_text, variables, header_kind, synced_at, line_id, meta_id, components, rejected_reason)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP,$8,$9,$10,$11)
                 ON CONFLICT (line_id, name, language) DO UPDATE
                    SET category = EXCLUDED.category, status = EXCLUDED.status,
                        body_text = EXCLUDED.body_text, variables = EXCLUDED.variables,
                        header_kind = EXCLUDED.header_kind, synced_at = CURRENT_TIMESTAMP,
                        meta_id = EXCLUDED.meta_id, components = EXCLUDED.components,
                        rejected_reason = EXCLUDED.rejected_reason`,
                [t.name, t.language, t.category, t.status, t.body_text, t.variables, t.header_kind, req.waLine.id,
                    t.meta_id, JSON.stringify(t.components || []), t.rejected_reason]);
        }
        // Anything Meta no longer has was deleted or rejected there; offering it would only
        // produce a refusal at the worst moment. Everything still on the account was just
        // stamped, so what the sync did not touch is what Meta no longer carries.
        if (templates.length) {
            await db.query('DELETE FROM wa_templates WHERE synced_at < $1 AND line_id = $2', [startedAt, req.waLine.id]);
        }
        const r = await db.query(`SELECT COUNT(*)::int n FROM wa_templates WHERE status = 'APPROVED' AND line_id = $1`, [req.waLine.id]);
        res.json({ synced: templates.length, approved: r.rows[0].n });
    } catch (err) {
        if (err instanceof wa.WhatsAppError) return res.status(502).json({ error: err.message });
        console.error('whatsapp template sync error:', err);
        res.status(500).json({ error: 'Could not read the templates from Meta' });
    }
});

/** Send one. This is the only thing allowed through a closed window. */
router.post('/conversations/:id/template', async (req, res) => {
    try {
        const conversation = await loadConversation(req, req.params.id);
        if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
        if (isDemo(conversation)) return demoRefusal(res);
        if (!wa.configured()) return res.status(503).json({ error: 'WhatsApp is not configured on this server' });

        const name = trim(req.body?.name);
        const language = trim(req.body?.language) || 'en_US';
        const variables = Array.isArray(req.body?.variables) ? req.body.variables.map(v => String(v ?? '')) : [];
        if (!name) return res.status(400).json({ error: 'Which template?' });

        const t = (await db.query(
            `SELECT * FROM wa_templates WHERE name = $1 AND language = $2 AND line_id = $3`, [name, language, req.waLine.id])).rows[0];
        if (!t) return res.status(404).json({ error: 'That template is not on this account — sync them again' });
        if (t.status !== 'APPROVED') return res.status(400).json({ error: `Meta has that template as ${t.status}` });
        // Meta refuses a template with a gap in it; better to say which gap, here.
        if (variables.filter(v => v.trim()).length < t.variables) {
            return res.status(400).json({ error: `That template needs ${t.variables} value${t.variables === 1 ? '' : 's'} filling in` });
        }

        let wamid;
        try {
            wamid = await wa.sendTemplate(conversation.phone, { name, language, variables });
        } catch (err) {
            if (err instanceof wa.WhatsAppError) return res.status(502).json({ error: err.message });
            throw err;
        }

        // What the customer will read, not the template's name: a thread nobody can follow is
        // no record at all.
        const body = wa.renderTemplate(t.body_text, variables);
        const row = await db.query(
            `INSERT INTO wa_messages (conversation_id, wamid, direction, sender_type, sender_user,
                                      type, body, status)
             VALUES ($1,$2,'out','user',$3,'template',$4,'sent')
             RETURNING id, wamid, direction, sender_type, sender_user, type, body, media_url,
                       media_mime, media_name, status, error, sent_at`,
            [conversation.id, wamid, req.user?.username || null, body]);
        // Its footer and buttons, so the chat shows it the way the customer sees it.
        await require('../services/wa-template-look').stamp(wamid, req.waLine.id, name, language);
        row.rows[0].interactive_payload = await require('../services/wa-template-look').lookOf(req.waLine.id, name, language);
        await db.query(
            `UPDATE wa_conversations SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = $2,
                    status = 'open', assigned_to = COALESCE(assigned_to, $3), updated_at = CURRENT_TIMESTAMP
              WHERE id = $1`,
            [conversation.id, body.slice(0, 200), req.user?.username || null]);

        res.status(201).json({ message: row.rows[0] });
    } catch (err) {
        console.error('whatsapp template send error:', err);
        res.status(500).json({ error: 'Could not send that template' });
    }
});

/* ── The numbers ─────────────────────────────────────────────────────────────────────────────
   Five questions worth asking of a WhatsApp line: how much is coming in, where from, how fast
   anybody answers, how much of it the robots dealt with, and how much turned into money.

   First response is measured from the customer's first message to the first reply by a *person*;
   a menu answering in half a second is not somebody answering. Everything is scoped to what the
   caller is allowed to see, so a rep's figures are their own. */

router.get('/report', async (req, res) => {
    try {
        const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
        const scope = [];
        const vis = visibility(req, scope);

        const perDay = await db.query(
            `SELECT TO_CHAR(c.created_at, 'YYYY-MM-DD') AS day, COUNT(*)::int AS enquiries
               ${LIST_FROM} WHERE ${vis} AND c.created_at > CURRENT_DATE - $${scope.length + 1}::int
               GROUP BY 1 ORDER BY 1`, [...scope, days]);

        const sources = await db.query(
            `SELECT COALESCE(NULLIF(c.ad_referral::json->>'headline', ''), 
                             CASE WHEN c.ad_referral IS NULL THEN 'Messaged us directly' ELSE 'An ad' END) AS source,
                    COUNT(*)::int AS enquiries
               ${LIST_FROM} WHERE ${vis} AND c.created_at > CURRENT_DATE - $${scope.length + 1}::int
               GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, [...scope, days]);

        // The gap between a customer arriving and a person replying, per rep.
        const response = await db.query(
            `WITH firsts AS (
                SELECT c.id, c.assigned_to,
                       MIN(m.sent_at) FILTER (WHERE m.direction = 'in') AS asked,
                       MIN(m.sent_at) FILTER (WHERE m.direction = 'out' AND m.sender_type = 'user') AS answered
                  ${LIST_FROM}
                  JOIN wa_messages m ON m.conversation_id = c.id
                 WHERE ${vis} AND c.created_at > CURRENT_DATE - $${scope.length + 1}::int
                 GROUP BY c.id, c.assigned_to
             )
             SELECT COALESCE(assigned_to, 'unassigned') AS rep,
                    COUNT(*) FILTER (WHERE answered IS NOT NULL)::int AS answered,
                    COUNT(*) FILTER (WHERE answered IS NULL)::int AS unanswered,
                    ROUND(AVG(EXTRACT(EPOCH FROM (answered - asked)) / 60.0)
                          FILTER (WHERE answered IS NOT NULL AND answered > asked))::int AS minutes
               FROM firsts GROUP BY 1 ORDER BY 2 DESC`, [...scope, days]);

        const whoAnswered = await db.query(
            `SELECT COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM wa_messages m WHERE m.conversation_id = c.id AND m.sender_type IN ('bot','ai')))::int AS robots,
                    COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM wa_messages m WHERE m.conversation_id = c.id AND m.sender_type = 'user'))::int AS people,
                    COUNT(*)::int AS total
               ${LIST_FROM} WHERE ${vis} AND c.created_at > CURRENT_DATE - $${scope.length + 1}::int`,
            [...scope, days]);

        // What the enquiries became. A lead is only counted as won when somebody marked it so.
        const outcomes = req.waLine.brand !== 'crewfit' ? { rows: [] } : await db.query(
            `SELECT l.status, COUNT(*)::int AS n
               FROM crewfit_leads l
              WHERE l.source = 'whatsapp' AND l.created_at > CURRENT_DATE - $1::int
              GROUP BY 1 ORDER BY 2 DESC`, [days]);

        res.json({
            days,
            perDay: perDay.rows,
            sources: sources.rows,
            response: response.rows,
            whoAnswered: whoAnswered.rows[0],
            outcomes: outcomes.rows,
        });
    } catch (err) {
        console.error('whatsapp report error:', err);
        res.status(500).json({ error: 'Could not work out the numbers' });
    }
});

module.exports = router;
module.exports.webhook = webhook;
module.exports.importChat = importChat;      // scripts/import-wa-backup.js
