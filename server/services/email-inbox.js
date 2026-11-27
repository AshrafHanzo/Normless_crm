/**
 * contact@normless.store: the customer emails, read from Gmail over IMAP and answered over SMTP.
 *
 * Needs SUPPORT_MAIL_USER (the mailbox, e.g. contact@normless.store) and SUPPORT_MAIL_PASSWORD (a
 * Google app password for it) on the server. Without them nothing runs and the page says so.
 *
 * Every two minutes the inbox is read from where it last got to (by UID, so nothing is read twice
 * and nothing is marked read in Gmail). Each Gmail conversation is one thread here. Newsletters,
 * receipts and no-reply mail are passed over: only mail a person wrote comes in. Replies the team
 * sends from Gmail itself are picked up from Sent Mail, so the agent knows a person answered.
 * Attachments are saved under uploads/email/<thread>/ for the page and for support tickets.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const db = require('../db/connection');

const POLL_MS = 2 * 60_000;
const FIRST_LOOK_DAYS = 1;         // the first run reads only the last day, not the whole mailbox
const MAX_ATTACHMENT_MB = 15;
const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads', 'email');
const SENT_BOX = '[Gmail]/Sent Mail';

const user = () => String(process.env.SUPPORT_MAIL_USER || '').trim().toLowerCase();
const configured = () => !!(user() && process.env.SUPPORT_MAIL_PASSWORD);

/* ── Is this mail from a person? ──────────────────────────────────────────────────────────────── */

const MACHINE_FROM = /(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce|notifications?@|alerts?@|newsletter|marketing@|billing@|invoice)/i;
const MACHINE_DOMAINS = /@([a-z0-9-]+\.)*(shopify\.com|razorpay\.com|facebookmail\.com|google\.com|googlemail\.com|meta\.com|instagram\.com|delhivery\.com|amazonses\.com|stripe\.com|paypal\.com|linkedin\.com|zoho\.com|mailchimp\.com|sendgrid\.net)$/i;

function fromAPerson(parsed) {
    const from = String(parsed.from?.value?.[0]?.address || '').toLowerCase();
    if (!from || from === user()) return false;
    if (from.endsWith('@normless.store')) return false;
    if (MACHINE_FROM.test(from) || MACHINE_DOMAINS.test(from)) return false;
    const h = parsed.headers;
    const auto = String(h.get('auto-submitted') || '').toLowerCase();
    if (auto && auto !== 'no') return false;
    if (/bulk|list|junk/i.test(String(h.get('precedence') || ''))) return false;
    if (h.has('list-unsubscribe') || h.has('list-id') || h.has('x-autoreply') || h.has('x-autorespond')) return false;
    return true;
}

/** The new part of a reply: the quoted history under "On … wrote:" is cut. */
function freshText(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (/^On .{6,200}wrote:\s*$/.test(l) || /^On .{6,200}$/.test(l) && /wrote:\s*$/.test(lines[i + 1] || '')) break;
        if (/^-{2,}\s*(Original Message|Forwarded message)/i.test(l)) break;
        if (/^From: .+/.test(l) && /^(Sent|Date): /.test(lines[i + 1] || '')) break;
        if (/^>/.test(l)) continue;
        out.push(l);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 8000);
}

const normSubject = (s) => String(s || '').replace(/^\s*((re|fwd?|aw)\s*:\s*)+/i, '').trim();

/* ── Storing ───────────────────────────────────────────────────────────────────────────────── */

function saveAttachments(threadId, parsed) {
    const out = [];
    for (const a of parsed.attachments || []) {
        if (!a.content?.length || a.size > MAX_ATTACHMENT_MB * 1024 * 1024) continue;
        // Signature logos and tracking pixels come inline and unnamed; a photo the customer attached has a name.
        if (a.related && !a.filename) continue;
        const ext = (path.extname(a.filename || '') || ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'application/pdf': '.pdf' }[a.contentType] || '')).toLowerCase().replace(/[^a-z0-9.]/g, '');
        const name = `${crypto.createHash('sha1').update(a.content).digest('hex').slice(0, 16)}${ext}`;
        const dir = path.join(UPLOAD_ROOT, String(threadId));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, name), a.content);
        out.push({ url: `/uploads/email/${threadId}/${name}`, name: a.filename || name, mime: a.contentType, size: a.size });
    }
    return out;
}

/** One received email into its thread. Returns the thread id when it is new mail from a customer. */
async function storeInbound(msg, parsed) {
    const messageId = parsed.messageId || `<uid-${msg.uid}@${user()}>`;
    if ((await db.query('SELECT 1 FROM email_messages WHERE message_id = $1', [messageId])).rows[0]) return null;
    if (!fromAPerson(parsed)) return null;
    const from = parsed.from.value[0];
    const email = String(from.address).toLowerCase();
    const at = parsed.date || msg.internalDate || new Date();
    const gm = msg.threadId ? String(msg.threadId) : null;

    let thread = gm ? (await db.query('SELECT * FROM email_threads WHERE gm_thread = $1', [gm])).rows[0] : null;
    if (!thread) {
        const refs = [parsed.inReplyTo, ...[].concat(parsed.references || [])].filter(Boolean);
        if (refs.length) {
            thread = (await db.query(
                `SELECT t.* FROM email_threads t JOIN email_messages m ON m.thread_id = t.id WHERE m.message_id = ANY($1) LIMIT 1`, [refs])).rows[0];
        }
    }
    // A new email from someone with an open thread this week goes into that thread, so they get one
    // consistent conversation (the reply still answers their latest email, with its subject).
    if (!thread) {
        thread = (await db.query(
            `SELECT * FROM email_threads WHERE LOWER(customer_email) = $1 AND status = 'open'
               AND last_message_at > now() - INTERVAL '7 days' ORDER BY last_message_at DESC LIMIT 1`, [email])).rows[0];
    }
    if (!thread) {
        thread = (await db.query(
            `INSERT INTO email_threads (gm_thread, subject, customer_email, customer_name, last_inbound_at, last_message_at)
             VALUES ($1,$2,$3,$4,$5,$5) RETURNING *`,
            [gm, normSubject(parsed.subject) || '(no subject)', email, from.name || null, at])).rows[0];
    }
    const attachments = saveAttachments(thread.id, parsed);
    await db.query(
        `INSERT INTO email_messages (thread_id, message_id, direction, sender_type, from_email, from_name, to_email, subject, body, attachments, status, created_at)
         VALUES ($1,$2,'in','customer',$3,$4,$5,$6,$7,$8,'received',$9) ON CONFLICT (message_id) DO NOTHING`,
        [thread.id, messageId, email, from.name || null, user(), parsed.subject || null,
            freshText(parsed.text || ''), JSON.stringify(attachments), at]);
    await db.query(
        `UPDATE email_threads SET status = 'open', last_inbound_at = GREATEST(COALESCE(last_inbound_at, $2), $2),
                last_message_at = GREATEST(COALESCE(last_message_at, $2), $2),
                ai_state = CASE WHEN ai_state = 'asked' THEN ai_state ELSE NULL END
          WHERE id = $1`, [thread.id, at]);
    // A photo that comes after the ticket is proof for it.
    if (attachments.length) await require('./email-agent').attachmentsArrived(thread.id).catch(() => {});
    return thread.id;
}

/** A reply the team sent from Gmail itself, in a thread we know. */
async function storeSent(msg, parsed) {
    const gm = msg.threadId ? String(msg.threadId) : null;
    if (!gm || !parsed.messageId) return;
    const thread = (await db.query('SELECT id FROM email_threads WHERE gm_thread = $1', [gm])).rows[0];
    if (!thread) return;
    const at = parsed.date || msg.internalDate || new Date();
    const r = await db.query(
        `INSERT INTO email_messages (thread_id, message_id, direction, sender_type, sender_user, from_email, to_email, subject, body, attachments, status, created_at)
         VALUES ($1,$2,'out','user','gmail',$3,$4,$5,$6,'[]','sent',$7) ON CONFLICT (message_id) DO NOTHING RETURNING id`,
        [thread.id, parsed.messageId, user(), parsed.to?.value?.[0]?.address || null, parsed.subject || null, freshText(parsed.text || ''), at]);
    if (r.rows[0]) await db.query('UPDATE email_threads SET last_message_at = GREATEST(last_message_at, $2) WHERE id = $1', [thread.id, at]);
}

/* ── Reading the mailbox ───────────────────────────────────────────────────────────────────── */

async function readBox(client, box, handle) {
    const lock = await client.getMailboxLock(box);
    const fresh = [];
    try {
        const validity = String(client.mailbox.uidValidity);
        const st = (await db.query('SELECT * FROM email_sync_state WHERE mailbox = $1', [box])).rows[0];
        let uids;
        if (!st || st.uid_validity !== validity) {
            uids = await client.search({ since: new Date(Date.now() - FIRST_LOOK_DAYS * 86400000) }, { uid: true }) || [];
        } else {
            uids = (await client.search({ uid: `${Number(st.last_uid) + 1}:*` }, { uid: true }) || []).filter(u => u > Number(st.last_uid));
        }
        let last = st && st.uid_validity === validity ? Number(st.last_uid) : 0;
        if (uids.length) {
            const { simpleParser } = require('mailparser');
            for await (const msg of client.fetch(uids, { uid: true, source: true, threadId: true, internalDate: true }, { uid: true })) {
                try {
                    const parsed = await simpleParser(msg.source);
                    const id = await handle(msg, parsed);
                    if (id) fresh.push(id);
                } catch (err) {
                    console.error(`email ${box} uid ${msg.uid}:`, err.message);
                }
                last = Math.max(last, msg.uid);
            }
        } else if (!st || st.uid_validity !== validity) {
            last = Math.max(0, Number(client.mailbox.uidNext || 1) - 1);
        }
        await db.query(
            `INSERT INTO email_sync_state (mailbox, uid_validity, last_uid, last_run_at, last_error) VALUES ($1,$2,$3,now(),NULL)
             ON CONFLICT (mailbox) DO UPDATE SET uid_validity = $2, last_uid = $3, last_run_at = now(), last_error = NULL`,
            [box, validity, last]);
    } finally {
        lock.release();
    }
    return fresh;
}

let syncing = false;
/** Read new mail. Returns the threads that got a customer's email. */
async function sync() {
    if (!configured() || syncing) return [];
    syncing = true;
    const { ImapFlow } = require('imapflow');
    const client = new ImapFlow({
        host: 'imap.gmail.com', port: 993, secure: true, logger: false,
        auth: { user: user(), pass: String(process.env.SUPPORT_MAIL_PASSWORD).replace(/\s+/g, '') },
    });
    try {
        await client.connect();
        const fresh = await readBox(client, 'INBOX', storeInbound);
        try { await readBox(client, SENT_BOX, storeSent); } catch (err) { console.error('email sent box:', err.message); }
        return [...new Set(fresh)];
    } catch (err) {
        console.error('email sync failed:', err.message);
        await db.query(
            `INSERT INTO email_sync_state (mailbox, last_run_at, last_error) VALUES ('INBOX', now(), $1)
             ON CONFLICT (mailbox) DO UPDATE SET last_run_at = now(), last_error = $1`, [String(err.message).slice(0, 500)]).catch(() => {});
        return [];
    } finally {
        syncing = false;
        try { await client.logout(); } catch { /* already closed */ }
    }
}

/* ── Sending ───────────────────────────────────────────────────────────────────────────────── */

let transporter = null;
function transport() {
    if (!configured()) return null;
    if (!transporter) {
        transporter = nodemailer.createTransport({
            host: 'smtp.gmail.com', port: 465, secure: true,
            auth: { user: user(), pass: String(process.env.SUPPORT_MAIL_PASSWORD).replace(/\s+/g, '') },
        });
    }
    return transporter;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const asHtml = (text) => `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.55;color:#1a1c22">${
    String(text).split(/\n{2,}/).map(p => `<p style="margin:0 0 12px">${esc(p).replace(/\n/g, '<br>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</p>`).join('')}</div>`;

/**
 * Reply in a thread, as the Normless team. who: { type: 'ai' | 'user', user }. Returns the stored
 * message; a failure is stored too (status 'failed') and thrown.
 */
async function reply(threadId, text, who, files = []) {
    const t = transport();
    if (!t) throw Object.assign(new Error('The contact@ mailbox is not connected on the server yet.'), { status: 400 });
    const thread = (await db.query('SELECT * FROM email_threads WHERE id = $1', [threadId])).rows[0];
    if (!thread) throw Object.assign(new Error('No such email thread'), { status: 404 });
    const ids = (await db.query(
        `SELECT message_id FROM email_messages WHERE thread_id = $1 AND message_id IS NOT NULL ORDER BY created_at, id`, [threadId])).rows.map(r => r.message_id);
    const lastIn = (await db.query(
        `SELECT message_id, subject FROM email_messages WHERE thread_id = $1 AND direction = 'in' ORDER BY created_at DESC, id DESC LIMIT 1`, [threadId])).rows[0];
    const subject = `Re: ${normSubject(lastIn?.subject || thread.subject) || 'Your message to Normless'}`;
    const body = String(text).trim();
    let messageId = null, error = null;
    try {
        const info = await t.sendMail({
            from: `"Normless" <${user()}>`, to: thread.customer_email, subject, text: body, html: asHtml(body),
            ...(files.length ? { attachments: files.map(f => ({ path: f.path, filename: f.filename, contentType: f.mime })) } : {}),
            ...(lastIn?.message_id ? { inReplyTo: lastIn.message_id, references: ids.slice(-20) } : {}),
        });
        messageId = info.messageId || null;
    } catch (err) {
        error = err.message;
    }
    const row = (await db.query(
        `INSERT INTO email_messages (thread_id, message_id, direction, sender_type, sender_user, from_email, to_email, subject, body, attachments, status, error)
         VALUES ($1,$2,'out',$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [threadId, messageId, who.type, who.user || null, user(), thread.customer_email, subject, body,
            JSON.stringify(files.map(f => ({ url: f.url, name: f.filename, mime: f.mime }))), error ? 'failed' : 'sent', error])).rows[0];
    await db.query('UPDATE email_threads SET last_message_at = now() WHERE id = $1', [threadId]);
    if (error) throw Object.assign(new Error(`Gmail didn't send it: ${error}`), { status: 502 });
    return row;
}

/** Can we log in? For the page's "Connected" line. */
async function state() {
    const rows = (await db.query('SELECT * FROM email_sync_state')).rows;
    const inbox = rows.find(r => r.mailbox === 'INBOX');
    return { configured: configured(), mailbox: user() || null, last_run_at: inbox?.last_run_at || null, last_error: inbox?.last_error || null };
}

let timer = null;
function start(onFresh) {
    if (timer || !configured()) return;
    const tick = async () => {
        const fresh = await sync();
        if (fresh.length && onFresh) onFresh(fresh);
    };
    timer = setInterval(tick, POLL_MS);
    setTimeout(tick, 30_000);
}

module.exports = { sync, reply, state, start, configured, freshText, fromAPerson, normSubject, user };
