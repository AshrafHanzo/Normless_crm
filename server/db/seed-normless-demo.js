/**
 * The Normless WhatsApp demo chat — add it, or take it away.
 *
 *   node server/db/seed-normless-demo.js           add (or refresh) the demo chat
 *   node server/db/seed-normless-demo.js --remove  delete it, its messages and its photo
 *
 * One made-up customer on +91 00000 00000, a number no phone can have, in Normless's inbox only:
 * a damaged-tank claim the bot handed to a person, as in the design. The inbox refuses to send
 * anything to it or tie a ticket to it, and its Shopify panel is invented by the server rather
 * than read from the shop, so it never shows or touches a real customer.
 */

const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const db = require('./connection');

const DEMO_PHONE = '910000000000';
const UPLOADS = path.join(__dirname, '..', 'uploads', 'whatsapp');

/** A plain red square as a PNG, standing in for the customer's photo of the damage. */
function placeholderPng() {
    const w = 96, h = 96;
    const crcTable = Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type), data]);
        const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
        return Buffer.concat([len, td, c]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
    const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, Buffer.from([190, 70, 70]))]);
    const raw = Buffer.concat(Array.from({ length: h }, () => row));
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function remove(lineId) {
    const conv = (await db.query(
        `SELECT c.id FROM wa_conversations c JOIN wa_contacts k ON k.id = c.contact_id
          WHERE k.line_id = $1 AND k.phone = $2`, [lineId, DEMO_PHONE])).rows[0];
    if (conv) {
        await db.query('DELETE FROM wa_activity WHERE conversation_id = $1', [conv.id]);
        fs.rmSync(path.join(UPLOADS, String(conv.id)), { recursive: true, force: true });
    }
    // Messages and notes go with the conversation, the conversation with the contact.
    await db.query('DELETE FROM wa_contacts WHERE line_id = $1 AND phone = $2', [lineId, DEMO_PHONE]);
    return conv?.id || null;
}

async function add(lineId) {
    await remove(lineId);
    const contact = (await db.query(
        `INSERT INTO wa_contacts (line_id, phone, profile_name) VALUES ($1, $2, 'Demo Customer') RETURNING id`,
        [lineId, DEMO_PHONE])).rows[0];
    const at = (minAgo) => new Date(Date.now() - minAgo * 60000);
    const conv = (await db.query(
        `INSERT INTO wa_conversations (contact_id, line_id, mode, status, last_inbound_at, last_message_at, last_message_preview, unread_count, created_at)
         VALUES ($1, $2, 'human', 'open', $3, $3, 'Okay, I''ll wait for your team', 1, $4) RETURNING id`,
        [contact.id, lineId, at(2), at(16)])).rows[0];

    fs.mkdirSync(path.join(UPLOADS, String(conv.id)), { recursive: true });
    fs.writeFileSync(path.join(UPLOADS, String(conv.id), 'demo-seam.png'), placeholderPng());

    const messages = [
        [16, 'in', 'customer', 'text', 'Hi, got my order yesterday. The tank has a hole near the side seam', null],
        [15, 'out', 'bot', 'text', 'Sorry about that! I found your order #DEMO-1 — Acid Wash Tank Midnight, size L, delivered yesterday.\n\nFor a damaged product please send clear photos of the damage and your unboxing video here. Our team checks every claim.', null],
        [12, 'in', 'customer', 'image', 'Photo of the damage', `/uploads/whatsapp/${conv.id}/demo-seam.png`],
        [11, 'out', 'bot', 'text', 'Thanks — I have the photo. A person from our team will check it and reply right here, between 9 am and 6 pm.', null],
        [2, 'in', 'customer', 'text', "Okay, I'll wait for your team", null],
    ];
    for (const [minAgo, direction, sender, type, body, media] of messages) {
        await db.query(
            `INSERT INTO wa_messages (conversation_id, wamid, direction, sender_type, type, body, media_url, media_mime, status, sent_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [conv.id, `demo.${conv.id}.${minAgo}`, direction, sender, type, body, media, media ? 'image/png' : null,
                direction === 'in' ? 'delivered' : 'read', at(minAgo)]);
    }
    await db.query(
        `INSERT INTO wa_activity (conversation_id, kind, body, actor, created_at)
         VALUES ($1, 'handoff', 'Bot handed this over: damaged product — photo received, inside the 24h window', NULL, $2)`,
        [conv.id, at(11)]);
    return conv.id;
}

(async () => {
    try {
        const line = (await db.query(`SELECT id FROM wa_lines WHERE brand = 'normless'`)).rows[0];
        if (!line) throw new Error('No Normless line yet — start the server once so it is created');
        if (process.argv.includes('--remove')) {
            const id = await remove(line.id);
            console.log(id ? `Removed the demo chat (${id}).` : 'There was no demo chat.');
        } else {
            console.log(`Demo chat ready: open WhatsApp in the Normless menu (conversation ${await add(line.id)}).`);
        }
        process.exit(0);
    } catch (err) {
        console.error('Demo chat failed:', err.message);
        process.exit(1);
    }
})();
