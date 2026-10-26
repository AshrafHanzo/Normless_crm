/**
 * What a sent template looks like on the customer's phone, kept on the message in the chat: its
 * footer and its buttons (links, quick replies, call, copy code) and whether it had a photo. The
 * inbox draws template messages from this, so the team sees exactly what the customer saw.
 */

const db = require('../db/connection');

const safeJson = (v, f) => { try { return typeof v === 'string' ? (JSON.parse(v || 'null') ?? f) : (v ?? f); } catch { return f; } };

async function lookOf(lineId, name, language) {
    const t = (await db.query(
        `SELECT components FROM wa_templates WHERE line_id = $1 AND name = $2 ${language ? 'AND language = $3' : ''} LIMIT 1`,
        language ? [lineId, name, language] : [lineId, name])).rows[0];
    const comps = safeJson(t?.components, []);
    const header = comps.find(c => c.type === 'HEADER');
    return {
        kind: 'template', name,
        header: header?.format || null,
        footer: comps.find(c => c.type === 'FOOTER')?.text || null,
        buttons: (comps.find(c => c.type === 'BUTTONS')?.buttons || []).map(b => ({ type: b.type, text: b.type === 'COPY_CODE' ? 'Copy offer code' : b.text })),
    };
}

/** Put the look on the message just written for `wamid`. Never throws: it is decoration. */
async function stamp(wamid, lineId, name, language) {
    if (!wamid || !lineId || !name) return;
    try {
        const look = await lookOf(lineId, name, language);
        await db.query(`UPDATE wa_messages SET interactive_payload = $2 WHERE wamid = $1 AND interactive_payload IS NULL`, [wamid, JSON.stringify(look)]);
    } catch (err) {
        console.error('template look:', err.message);
    }
}

module.exports = { lookOf, stamp };
