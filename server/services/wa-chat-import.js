/**
 * Reading a chat exported from the WhatsApp (Business) app: Chat › ⋮ › More › Export chat.
 *
 * The export is a .zip (with media) or a bare .txt. The text has one message per line, starting
 * with its date and time and the sender's name; a message that runs over several lines simply
 * continues on the next. Android and iPhone write it differently:
 *
 *   Android  26/10/26, 10:56 am - Arjun Mehta: Hi, need 50 polos
 *            26/10/26, 10:57 am - Arjun Mehta: IMG-20261026-WA0001.jpg (file attached)
 *   iPhone   [26/10/26, 10:56:12 AM] Arjun Mehta: Hi, need 50 polos
 *            [26/10/26, 10:57:03 AM] Arjun Mehta: <attached: 00000012-PHOTO-2026-10-26-10-57-03.jpg>
 *
 * Phones in India write the day first; if any date in the file can only be month-first, the
 * whole file is read that way. Times are India time. System lines ("Messages are end-to-end
 * encrypted", "X changed their number") have no sender and are skipped.
 */

const path = require('path');
const JSZip = require('jszip');

const clean = (s) => String(s).replace(/[‎‏‪-‮﻿]/g, '').replace(/[  ]/g, ' ');
const ANDROID = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?\s?m\.?)?\s+-\s+(.*)$/i;
const IOS = /^\[(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?\s?m\.?)?\]\s+(.*)$/i;
const ATTACHED = [
    /^(.+?\.[a-z0-9]{2,5}) \(file attached\)\s*([\s\S]*)$/i,          // Android
    /^<attached: (.+?\.[a-z0-9]{2,5})>\s*([\s\S]*)$/i,                 // iPhone
];
const OMITTED = /^<(media omitted|image omitted|video omitted|audio omitted|document omitted|sticker omitted|gif omitted)>$/i;

const MIME = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic',
    mp4: 'video/mp4', '3gp': 'video/3gpp', mov: 'video/quicktime',
    opus: 'audio/ogg', ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac',
    pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ai: 'application/postscript', eps: 'application/postscript', cdr: 'application/octet-stream', psd: 'image/vnd.adobe.photoshop', svg: 'image/svg+xml',
    vcf: 'text/vcard', txt: 'text/plain', zip: 'application/zip',
};
const mimeOf = (file) => MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';
const kindOf = (mime) => (mime.startsWith('image/') && !/photoshop|svg/.test(mime) ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'document');

/** The contact's name (or number) from the export's file name. */
function contactFromFileName(name) {
    const base = path.basename(String(name || '')).replace(/\.(zip|txt)$/i, '');
    const m = base.match(/WhatsApp Chat (?:with|-)\s*(.+)$/i);
    const who = (m ? m[1] : base).replace(/\s*\(\d+\)$/, '').trim();
    const digits = who.replace(/[^\d+]/g, '');
    const phone = /^\+?\d[\d\s-]{8,}$/.test(who) ? digits.replace(/^\+/, '') : null;
    return { name: phone ? null : who || null, phone };
}

/** Lines into messages: { at: 'YYYY-MM-DD HH:MM:SS', sender, text, attachment }. */
function parseText(raw) {
    const lines = clean(raw).split(/\r?\n/);
    const heads = [];
    let monthFirst = false;
    for (const line of lines) {
        const m = line.match(ANDROID) || line.match(IOS);
        if (m) heads.push(m);
    }
    // Day first unless some date can only be month first (e.g. 10/26/26).
    if (heads.some(m => Number(m[2]) > 12)) monthFirst = true;

    const out = [];
    let cur = null;
    for (const line of lines) {
        const m = line.match(ANDROID) || line.match(IOS);
        if (!m) {
            if (cur) cur.text += `\n${line}`;
            continue;
        }
        let [, a, b, y, hh, mm, ss, ampm, rest] = m;
        const day = Number(monthFirst ? b : a), month = Number(monthFirst ? a : b);
        let year = Number(y); if (year < 100) year += 2000;
        let hour = Number(hh);
        if (ampm) {
            const pm = /^p/i.test(ampm);
            if (pm && hour < 12) hour += 12;
            if (!pm && hour === 12) hour = 0;
        }
        const at = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${mm}:${String(ss || '00').padStart(2, '0')}`;
        const colon = rest.indexOf(': ');
        if (colon < 0) { cur = null; continue; }                      // a system line
        cur = { at, sender: rest.slice(0, colon).trim(), text: rest.slice(colon + 2) };
        out.push(cur);
    }
    for (const msg of out) {
        msg.text = msg.text.replace(/\s+$/, '');
        for (const rx of ATTACHED) {
            const a = msg.text.match(rx);
            if (a) { msg.attachment = a[1].trim(); msg.text = a[2].trim(); break; }
        }
        if (OMITTED.test(msg.text.trim())) { msg.omitted = true; msg.text = `[${msg.text.trim().slice(1, -1)}]`; }
        msg.text = msg.text.replace(/<This message was edited>$/i, '').trim();
    }
    return out.filter(msg => msg.text || msg.attachment);
}

/**
 * An uploaded export (.zip or .txt) read whole: its messages, the media inside it, who the
 * customer is by the file name, and everybody who wrote in it.
 */
async function read(buffer, fileName) {
    let text = null;
    const media = new Map();
    if (/\.zip$/i.test(fileName) || buffer.slice(0, 2).toString() === 'PK') {
        const zip = await JSZip.loadAsync(buffer);
        const txt = Object.values(zip.files).find(f => !f.dir && /\.txt$/i.test(f.name) && /chat/i.test(f.name))
            || Object.values(zip.files).find(f => !f.dir && /\.txt$/i.test(f.name));
        if (!txt) throw new Error('No chat text inside that zip — export the chat again from WhatsApp');
        text = await txt.async('string');
        for (const f of Object.values(zip.files)) {
            if (!f.dir && f !== txt) media.set(path.basename(f.name), f);
        }
    } else {
        text = buffer.toString('utf8');
    }
    const messages = parseText(text);
    if (!messages.length) throw new Error('No messages found — is this a WhatsApp chat export?');
    const counts = {};
    for (const m of messages) counts[m.sender] = (counts[m.sender] || 0) + 1;
    const senders = Object.entries(counts).sort((x, y) => y[1] - x[1]).map(([name, n]) => ({ name, n }));
    return { messages, media, senders, contact: contactFromFileName(fileName) };
}

/** Which sender is the customer: the one named in the file, else the one who isn't us. */
function guessCustomer(senders, contact, businessNames = []) {
    const lower = (s) => String(s || '').toLowerCase().trim();
    const byFile = contact?.name && senders.find(s => lower(s.name) === lower(contact.name));
    if (byFile) return byFile.name;
    const byPhone = contact?.phone && senders.find(s => s.name.replace(/\D/g, '').endsWith(contact.phone.slice(-10)));
    if (byPhone) return byPhone.name;
    const notUs = senders.filter(s => !businessNames.some(b => lower(b) && lower(s.name).includes(lower(b))));
    return notUs.length === 1 ? notUs[0].name : null;
}

module.exports = { read, parseText, contactFromFileName, guessCustomer, mimeOf, kindOf };
