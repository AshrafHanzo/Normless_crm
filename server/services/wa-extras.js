/**
 * Two things the inbox and the menu both send without a person typing them: the catalogue PDF,
 * and the "we are closed" message outside working hours.
 */

const fs = require('fs');
const path = require('path');
const db = require('../db/connection');
const wa = require('./whatsapp');

/* ── The catalogue PDF ───────────────────────────────────────────────────────────────────────
   The current version from the Catalog page (crewfit_catalog_files), the same file a rep would
   download there. */

const PDF_DIR = path.join(__dirname, '..', 'storage', 'crewfit', 'catalog');

async function currentCatalogue() {
    const row = (await db.query('SELECT * FROM crewfit_catalog_files ORDER BY version DESC LIMIT 1')).rows[0];
    if (!row) return null;
    const full = path.join(PDF_DIR, path.basename(row.file_path));
    if (!fs.existsSync(full)) return null;
    return { path: full, filename: row.file_name, mime: 'application/pdf', version: row.version, title: row.title };
}

/** Send it and write it into the thread. Returns the message row. */
async function sendCatalogue(conversation, { senderType = 'user', user = null, caption = '' } = {}) {
    const file = await currentCatalogue();
    if (!file) {
        const err = new Error('No catalogue PDF has been uploaded yet — add one on the Catalog page');
        err.status = 404;
        throw err;
    }
    const text = caption || 'Here is our latest Crewfit catalogue 📘';
    const out = await wa.sendMedia(conversation.phone, { filePath: file.path, mime: file.mime, filename: file.filename, caption: text });
    // The catalogue itself lives in private storage; the thread keeps a copy it can open, one per
    // version, so the rep can see exactly what the customer was sent.
    const copyName = `catalogue-v${file.version}.pdf`;
    const copyPath = path.join(__dirname, '..', 'uploads', 'whatsapp', 'outgoing', copyName);
    if (!fs.existsSync(copyPath)) {
        fs.mkdirSync(path.dirname(copyPath), { recursive: true });
        fs.copyFileSync(file.path, copyPath);
    }
    const row = (await db.query(
        `INSERT INTO wa_messages (conversation_id, wamid, direction, sender_type, sender_user, type, body,
                                  media_name, media_mime, media_url, status)
         VALUES ($1,$2,'out',$3,$4,'document',$5,$6,'application/pdf',$7,'sent')
         RETURNING id, wamid, direction, sender_type, sender_user, type, body, media_url,
                   media_mime, media_name, status, error, sent_at`,
        [conversation.id, out.wamid, senderType, user, text, file.filename, `/uploads/whatsapp/outgoing/${copyName}`])).rows[0];
    await db.query(
        `UPDATE wa_conversations SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = $2,
                updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [conversation.id, `📄 ${file.filename}`.slice(0, 200)]);
    return row;
}

/* ── Working hours ───────────────────────────────────────────────────────────────────────────
   Kept as one JSON setting. Times are the shop's own (India), whatever timezone the server is
   on. Outside them, a customer reaching for a person is told when somebody will be back —
   once, not on every message: a second "we are closed" twenty seconds later is noise. */

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DEFAULT_HOURS = {
    enabled: false,
    days: [1, 2, 3, 4, 5, 6],
    start: '09:30',
    end: '19:00',
    message: 'Thanks for reaching Crewfit! 🙏 Our sales team is not available right now — we work {days}, {hours}. We have your message and will reply as soon as we are back.',
    // Outside hours a new chat gets the menu even when it is switched off for the day, so the
    // customer is answered and the basics are collected by the time somebody is in.
    menuAfterHours: true,
};
const AWAY_EVERY_HOURS = 12;

async function workHours() {
    const r = await db.query(`SELECT value FROM wa_settings WHERE key = 'work_hours'`);
    let saved = {};
    try { saved = JSON.parse(r.rows[0]?.value || '{}') || {}; } catch { saved = {}; }
    return { ...DEFAULT_HOURS, ...saved };
}

/** Now, as the shop's clock reads it. */
function shopNow(date = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(date).map(p => [p.type, p.value]));
    return { day: DAY_NAMES.indexOf(parts.weekday), minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute) };
}

const toMinutes = (hhmm) => { const [h, m] = String(hhmm || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };

function isOpen(hours, date = new Date()) {
    if (!hours.enabled) return true;
    const { day, minutes } = shopNow(date);
    return hours.days.includes(day) && minutes >= toMinutes(hours.start) && minutes < toMinutes(hours.end);
}

const clock12 = (hhmm) => {
    const total = toMinutes(hhmm);
    const h = Math.floor(total / 60); const m = total % 60;
    return `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'am' : 'pm'}`;
};

/** "Mon–Sat" for a run of days, "Mon, Wed, Fri" otherwise. */
function describeDays(days) {
    const sorted = [...days].sort((a, b) => a - b);
    if (!sorted.length) return 'by appointment';
    const run = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
    return run && sorted.length > 2 ? `${DAY_NAMES[sorted[0]]}–${DAY_NAMES[sorted[sorted.length - 1]]}` : sorted.map(d => DAY_NAMES[d]).join(', ');
}

const awayText = (hours) => String(hours.message || DEFAULT_HOURS.message)
    .replace(/\{days\}/g, describeDays(hours.days))
    .replace(/\{hours\}/g, `${clock12(hours.start)} – ${clock12(hours.end)}`);

/**
 * A customer is waiting for a person. Outside hours, tell them when one will be there.
 * Returns the message sent, or null.
 */
async function maybeSendAway(conversation) {
    const hours = await workHours();
    if (isOpen(hours)) return null;
    const conv = (await db.query(
        `SELECT c.id, c.away_sent_at, c.last_inbound_at, k.phone FROM wa_conversations c
           JOIN wa_contacts k ON k.id = c.contact_id WHERE c.id = $1`, [conversation.id])).rows[0];
    if (!conv || !wa.windowOpen(conv.last_inbound_at)) return null;
    if (conv.away_sent_at && Date.now() - new Date(conv.away_sent_at).getTime() < AWAY_EVERY_HOURS * 3600 * 1000) return null;

    const text = awayText(hours);
    const wamid = await wa.sendText(conv.phone, text);
    await db.query(
        `INSERT INTO wa_messages (conversation_id, wamid, direction, sender_type, type, body, status)
         VALUES ($1,$2,'out','auto','text',$3,'sent')`, [conv.id, wamid, text]);
    await db.query(
        `UPDATE wa_conversations SET away_sent_at = CURRENT_TIMESTAMP, last_message_at = CURRENT_TIMESTAMP,
                last_message_preview = $2 WHERE id = $1`, [conv.id, text.slice(0, 200)]);
    return text;
}

/** Should a new chat get the menu even though it is switched off? Only outside hours. */
async function menuAfterHours() {
    const hours = await workHours();
    return hours.enabled && hours.menuAfterHours !== false && !isOpen(hours);
}

module.exports = { menuAfterHours, currentCatalogue, sendCatalogue, workHours, isOpen, awayText, maybeSendAway, DEFAULT_HOURS, describeDays };
