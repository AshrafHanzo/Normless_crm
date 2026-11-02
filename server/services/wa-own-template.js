/**
 * The CRM's own templates — ones a feature needs for a chat past the 24-hour window ("May we call
 * you?", "your mockup is ready") — on the line in force.
 *
 * Meta's record is read each time, since approval happens there, and the inbox's own list follows
 * it. `create` submits the template the first time it is needed, so nobody has to write it in
 * Settings first. Returns { name, language, status, created } or null.
 */

const db = require('../db/connection');
const wa = require('./whatsapp');
const lines = require('./wa-line');

async function ensure({ name, body, components, category = 'UTILITY', language = 'en', create = false, graph = wa.graph }) {
    const line = lines.current();
    const found = await graph(`/${wa.wabaId()}/message_templates?name=${name}&fields=name,status,language`);
    const t = (found?.data || []).find(x => x.name === name);
    if (t) {
        await db.query(`UPDATE wa_templates SET status = $3, synced_at = CURRENT_TIMESTAMP WHERE line_id = $1 AND name = $2`, [line.id, name, t.status]);
        return { name, language: t.language, status: t.status, created: false };
    }
    if (!create) return null;
    const made = await graph(`/${wa.wabaId()}/message_templates`, { method: 'POST', body: { name, language, category, components } });
    // Listed with the other templates, so Settings › Templates shows where it stands.
    await db.query(
        `INSERT INTO wa_templates (name, language, category, status, body_text, variables, synced_at, line_id, meta_id, components)
         VALUES ($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP,$7,$8,$9)
         ON CONFLICT (line_id, name, language) DO UPDATE SET status = EXCLUDED.status, meta_id = EXCLUDED.meta_id, synced_at = CURRENT_TIMESTAMP`,
        [name, language, category, made?.status || 'PENDING', body, (body.match(/\{\{\d+\}\}/g) || []).length, line.id, made?.id || null, JSON.stringify(components)]);
    return { name, language, status: made?.status || 'PENDING', created: true };
}

module.exports = { ensure };
