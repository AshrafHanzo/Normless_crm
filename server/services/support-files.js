/**
 * Proof photos put on a support ticket by the CRM itself: the ones a customer sent in the WhatsApp
 * chat or attached to an email. Copied under uploads/support/<ticket>/ like the ones the team
 * uploads, so a ticket keeps its photos whatever happens to the chat, and deleting one from the
 * ticket deletes only the ticket's copy.
 *
 * Each copy is named after where it came from (wa-<message id>, mail-<hash>), so adding the same
 * photo twice does nothing. Never throws: a ticket without its photo is still a ticket.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/connection');

const ROOT = path.join(__dirname, '..', 'uploads');
const MAX_IMAGES = 8;            // the same cap as the Support page's upload
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heif' };

const isImage = (mime) => !!EXT[String(mime || '').toLowerCase().split(';')[0]];
const safeJson = (v) => { try { return typeof v === 'string' ? (JSON.parse(v || '[]') || []) : (v || []); } catch { return []; } };

/**
 * files: [{ key, mime, buffer } | { key, mime, url }] where url is one of ours under /uploads/.
 * Returns how many were added.
 */
async function addImages(ticketId, files) {
    try {
        const row = (await db.query('SELECT images FROM support_tickets WHERE id = $1', [ticketId])).rows[0];
        if (!row) return 0;
        const images = safeJson(row.images);
        const dir = path.join(ROOT, 'support', String(ticketId));
        let added = 0;
        for (const f of files) {
            if (images.length >= MAX_IMAGES) break;
            const mime = String(f.mime || '').toLowerCase().split(';')[0];
            if (!isImage(mime)) continue;
            const name = `${String(f.key).replace(/[^a-z0-9-]/gi, '')}${EXT[mime]}`;
            const url = `/uploads/support/${ticketId}/${name}`;
            if (images.includes(url)) continue;
            let buf = f.buffer;
            if (!buf && f.url) {
                const src = path.join(ROOT, path.normalize(String(f.url).replace(/^\/uploads\//, '')));
                if (!src.startsWith(ROOT + path.sep) || !fs.existsSync(src)) continue;
                buf = fs.readFileSync(src);
            }
            if (!buf?.length) continue;
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, name), buf);
            images.push(url);
            added++;
        }
        if (added) {
            await db.query('UPDATE support_tickets SET images = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [JSON.stringify(images), ticketId]);
        }
        return added;
    } catch (err) {
        console.error('support ticket photos:', err.message);
        return 0;
    }
}

/** The photos a customer sent in a WhatsApp chat from a week before the ticket on, onto it. */
async function addChatPhotos(ticketId, conversationId) {
    const r = await db.query(
        `SELECT id, media_url, media_mime FROM wa_messages
          WHERE conversation_id = $1 AND direction = 'in' AND media_url IS NOT NULL AND media_mime LIKE 'image/%'
            AND created_at > (SELECT created_at - INTERVAL '7 days' FROM support_tickets WHERE id = $2)
          ORDER BY id DESC LIMIT ${MAX_IMAGES}`, [conversationId, ticketId]);
    return addImages(ticketId, r.rows.reverse().map(m => ({ key: `wa-${m.id}`, mime: m.media_mime, url: m.media_url })));
}

const hashKey = (buf) => `mail-${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16)}`;

module.exports = { addImages, addChatPhotos, isImage, hashKey, MAX_IMAGES };
