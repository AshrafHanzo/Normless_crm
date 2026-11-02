/**
 * Sample photos for a customer: our own work, by product, spread across colours.
 *
 * The pictures are the sample library's (routes/crewfit-catalog): production photos on orders,
 * which carry the order line's product and colour, and samples uploaded on purpose with a product
 * and a colour. A pick is newest first but takes one of each colour in turn, so the customer sees
 * the range rather than a row of black polos. The bot sends up to 7; the team up to 30.
 */

const path = require('path');
const fs = require('fs');
const db = require('../db/connection');
const wa = require('./whatsapp');

const SERVER_ROOT = path.join(__dirname, '..');
const MAX = 30;
// What the bot sends by itself when a customer asks: a handful, so the chat is not flooded. The
// team can send up to MAX from the inbox.
const BOT_MAX = 7;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Photos of a product (by catalogue name), optionally of some colours, one colour after another. */
async function pick({ product, colors = [], limit = MAX } = {}) {
    const { libraryImages } = require('../routes/crewfit-catalog');
    const want = norm(product);
    const only = new Set(colors.map(norm).filter(Boolean));
    // Production photos and uploaded samples only: a mockup on an order is that customer's design.
    const photos = (await libraryImages()).filter(i => i.url && i.source !== 'Mock' && norm(i.product) === want
        && /\.(jpe?g|png|webp)$/i.test(i.url) && fs.existsSync(path.join(SERVER_ROOT, i.url.replace(/^\//, ''))))
        .filter(i => !only.size || only.has(norm(i.color)));
    // Newest first within each colour, then one of each colour in turn.
    const byColor = new Map();
    for (const p of photos) {
        const k = norm(p.color) || 'other';
        if (!byColor.has(k)) byColor.set(k, []);
        byColor.get(k).push(p);
    }
    const queues = [...byColor.values()];
    const out = [];
    while (out.length < Math.min(limit, MAX) && queues.some(q => q.length)) {
        for (const q of queues) if (q.length && out.length < Math.min(limit, MAX)) out.push(q.shift());
    }
    return out;
}

/** Which colours we hold photos of, for a product: [{ color, count }]. */
async function colorsFor(product) {
    const { libraryImages } = require('../routes/crewfit-catalog');
    const counts = new Map();
    for (const i of await libraryImages()) {
        if (i.source === 'Mock' || norm(i.product) !== norm(product)) continue;
        const c = (i.color || '').trim() || 'Other';
        counts.set(c, (counts.get(c) || 0) + 1);
    }
    return [...counts.entries()].map(([color, count]) => ({ color, count })).sort((a, b) => b.count - a.count);
}

/**
 * Send photos to a chat, one WhatsApp image each, the colour as the caption. Each is recorded in the
 * thread. `senderType` is 'bot' or 'user'. Returns the messages written.
 */
async function send(conversation, photos, { senderType = 'user', user = null, intro = null } = {}) {
    const sent = [];
    if (intro) {
        const wamid = await wa.sendText(conversation.phone, intro);
        sent.push(await record(conversation.id, { wamid, senderType, user, body: intro }));
    }
    for (const p of photos) {
        const file = path.join(SERVER_ROOT, p.url.replace(/^\//, ''));
        const caption = [p.product, p.color].filter(Boolean).join(' · ');
        const ext = path.extname(file).toLowerCase();
        const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        try {
            const out = await wa.sendMedia(conversation.phone, { filePath: file, mime, filename: path.basename(file), caption });
            sent.push(await record(conversation.id, { wamid: out.wamid, senderType, user, body: caption, type: 'image', mediaUrl: p.url, mime }));
        } catch (err) {
            console.error('sample send failed:', p.url, err.message);
        }
    }
    if (sent.length) {
        await db.query(`UPDATE wa_conversations SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [conversation.id, `📷 ${photos.length} sample photo${photos.length === 1 ? '' : 's'}`]);
    }
    return sent;
}

async function record(conversationId, { wamid, senderType, user, body, type = 'text', mediaUrl = null, mime = null }) {
    return (await db.query(
        `INSERT INTO wa_messages (conversation_id, wamid, direction, sender_type, sender_user, type, body, media_url, media_mime, status)
         VALUES ($1,$2,'out',$3,$4,$5,$6,$7,$8,'sent')
         RETURNING id, wamid, direction, sender_type, sender_user, type, body, media_url, media_mime, media_name, status, error, sent_at`,
        [conversationId, wamid, senderType, user, type, body, mediaUrl, mime])).rows[0];
}

module.exports = { pick, colorsFor, send, MAX, BOT_MAX };
