/**
 * WhatsApp templates on either line: list, write, edit and delete them at Meta.
 *
 * Mounted under each inbox (Normless's at /nl, Crewfit's at /tpl), so a template is always made on
 * the number whose inbox it was opened from. Writing, editing and deleting are the Settings grant.
 */

const express = require('express');
const db = require('../db/connection');
const wa = require('../services/whatsapp');
const copies = require('../services/nl-template-copies');

const router = express.Router();
const manager = (req, res, next) => (req.waSettings ? next()
    : res.status(403).json({ error: 'You don’t have access to WhatsApp settings' }));
const safeJson = (v) => { try { return JSON.parse(v || 'null'); } catch { return null; } };
const str = (v, max = 1000) => String(v ?? '').trim().slice(0, max);

const TEMPLATE_FIELDS = `id, name, language, category, status, body_text, variables, header_kind, meta_id, components,
                         rejected_reason, synced_at, var_map`;
/**
 * Ours: the templates this CRM made or copied (nl_…, nlcrm_…, normless_…, crewfit_…). Updatrr's
 * originals end in a 13-digit timestamp; Meta's samples (hello_world, jaspers_market_…) are neither.
 */
const isOurs = (name) => /^(nl_|nlcrm_|normless_|crewfit_)/.test(String(name)) && !/\d{13}$/.test(String(name));
const shapeTemplate = (t) => ({ ...t, components: safeJson(t.components) || [], var_map: safeJson(t.var_map) || [], ours: isOurs(t.name) });
const gaps = (text) => [...new Set((String(text).match(/\{\{\s*(\d+)\s*\}\}/g) || []).map(m => Number(m.replace(/\D/g, ''))))].sort((a, b) => a - b);

/**
 * Meta's template parts from the editor's form, checked against Meta's own limits so a mistake
 * is shown here rather than coming back as a rejection.
 */
function buildComponents(b, { imageHandle = null } = {}) {
    const components = [];
    const header = str(b.header, 60);
    // A photo header: the photo is chosen per message (the product's), Meta only needs a sample.
    if (b.header_format === 'IMAGE') {
        if (!imageHandle) throw new Error('Could not upload a sample photo for the header');
        components.push({ type: 'HEADER', format: 'IMAGE', example: { header_handle: [imageHandle] } });
    } else if (header && b.header_format !== '') {
        const hv = gaps(header);
        if (hv.length > 1 || (hv.length && hv[0] !== 1)) throw new Error('The header can have one gap at most, written {{1}}');
        const example = str(b.header_example, 200);
        if (hv.length && !example) throw new Error('Give an example for the gap in the header');
        components.push({ type: 'HEADER', format: 'TEXT', text: header, ...(hv.length ? { example: { header_text: [example] } } : {}) });
    }
    const body = str(b.body, 1024);
    if (!body) throw new Error('The message has nothing to say');
    const nums = gaps(body);
    if (nums.some((n, i) => n !== i + 1)) throw new Error('Number the gaps {{1}}, {{2}} … in order, with none skipped');
    const examples = (Array.isArray(b.examples) ? b.examples : []).map(v => str(v, 200));
    if (examples.slice(0, nums.length).filter(Boolean).length < nums.length) throw new Error('Meta needs an example for every gap before it will review the template');
    components.push({ type: 'BODY', text: body, ...(nums.length ? { example: { body_text: [examples.slice(0, nums.length)] } } : {}) });
    const footer = str(b.footer, 60);
    if (footer) {
        if (gaps(footer).length) throw new Error('The footer can’t have gaps');
        components.push({ type: 'FOOTER', text: footer });
    }
    const buttons = (Array.isArray(b.buttons) ? b.buttons : []).map(x => ({
        type: ['QUICK_REPLY', 'URL', 'PHONE_NUMBER', 'COPY_CODE'].includes(x?.type) ? x.type : 'QUICK_REPLY',
        text: str(x?.text, 25), url: str(x?.url, 2000), phone_number: str(x?.phone_number, 20), example: str(x?.example, 2000),
    })).filter(x => x.text || x.type === 'COPY_CODE');
    if (buttons.length > 10) throw new Error('Ten buttons at most');
    if (buttons.filter(x => x.type === 'URL').length > 2) throw new Error('Two link buttons at most');
    if (buttons.filter(x => x.type === 'PHONE_NUMBER').length > 1) throw new Error('One call button at most');
    if (buttons.length) {
        components.push({
            type: 'BUTTONS',
            buttons: buttons.map(x => {
                if (x.type === 'URL') {
                    if (!/^https:\/\//.test(x.url)) throw new Error(`The link on “${x.text}” must start with https://`);
                    const dynamic = /\{\{1\}\}$/.test(x.url);
                    if (dynamic && !x.example) throw new Error(`Give a full example link for “${x.text}”`);
                    return { type: 'URL', text: x.text, url: x.url, ...(dynamic ? { example: [x.example] } : {}) };
                }
                if (x.type === 'COPY_CODE') return { type: 'COPY_CODE', example: x.example || 'NORMLESS10' };
                if (x.type === 'PHONE_NUMBER') {
                    if (!/^\+?\d{8,15}$/.test(x.phone_number.replace(/\s/g, ''))) throw new Error(`Give a phone number with the country code for “${x.text}”`);
                    return { type: 'PHONE_NUMBER', text: x.text, phone_number: x.phone_number.replace(/\s/g, '') };
                }
                return { type: 'QUICK_REPLY', text: x.text };
            }),
        });
    }
    return { components, body, variables: nums.length };
}

router.get('/templates', async (req, res) => {
    try {
        const r = await db.query(`SELECT ${TEMPLATE_FIELDS} FROM wa_templates WHERE line_id = $1 ORDER BY LOWER(name), language`, [req.waLine.id]);
        res.json({ templates: r.rows.map(shapeTemplate), canEdit: !!req.waSettings, connected: wa.configured() && !!wa.wabaId() });
    } catch (err) {
        console.error('normless templates error:', err);
        res.status(500).json({ error: 'Could not load the templates' });
    }
});

router.post('/templates', manager, async (req, res) => {
    try {
        if (!wa.configured() || !wa.wabaId()) return res.status(503).json({ error: 'Connect Normless’s WhatsApp number first' });
        const b = req.body || {};
        const name = str(b.name, 512);
        if (!/^[a-z0-9_]{1,512}$/.test(name)) return res.status(400).json({ error: 'Names are lower-case letters, numbers and underscores only' });
        const category = ['UTILITY', 'MARKETING'].includes(b.category) ? b.category : 'UTILITY';
        const language = str(b.language, 10) || 'en';
        let built;
        try { built = buildComponents(b, { imageHandle: b.header_format === 'IMAGE' ? await copies.sampleHandle() : null }); }
        catch (err) { return res.status(err instanceof wa.WhatsAppError ? 502 : 400).json({ error: err.message }); }
        let created;
        try {
            created = await wa.graph(`/${wa.wabaId()}/message_templates`, { method: 'POST', body: { name, language, category, components: built.components } });
        } catch (err) {
            if (err instanceof wa.WhatsAppError) return res.status(502).json({ error: err.message });
            throw err;
        }
        const r = await db.query(
            `INSERT INTO wa_templates (name, language, category, status, body_text, variables, header_kind, synced_at, line_id, meta_id, components)
             VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP,$8,$9,$10)
             ON CONFLICT (line_id, name, language) DO UPDATE SET category = EXCLUDED.category, status = EXCLUDED.status,
                 body_text = EXCLUDED.body_text, variables = EXCLUDED.variables, header_kind = EXCLUDED.header_kind,
                 meta_id = EXCLUDED.meta_id, components = EXCLUDED.components, synced_at = CURRENT_TIMESTAMP
             RETURNING ${TEMPLATE_FIELDS}`,
            [name, language, category, created?.status || 'PENDING', built.body, built.variables,
                built.components.find(c => c.type === 'HEADER')?.format || null, req.waLine.id, created?.id || null, JSON.stringify(built.components)]);
        res.status(201).json({ template: shapeTemplate(r.rows[0]) });
    } catch (err) {
        console.error('normless template create error:', err);
        res.status(500).json({ error: 'Could not send that to Meta' });
    }
});

/** Edit one. Meta re-reviews it; an approved template can be edited once a day, ten times a month. */
router.put('/templates/:id', manager, async (req, res) => {
    try {
        const t = (await db.query(`SELECT ${TEMPLATE_FIELDS} FROM wa_templates WHERE id = $1 AND line_id = $2`, [req.params.id, req.waLine.id])).rows[0];
        if (!t) return res.status(404).json({ error: 'That template is gone — sync again' });
        if (!t.meta_id) return res.status(400).json({ error: 'Sync templates from Meta first, then edit' });
        let built;
        try { built = buildComponents(req.body || {}, { imageHandle: req.body?.header_format === 'IMAGE' ? await copies.sampleHandle() : null }); }
        catch (err) { return res.status(err instanceof wa.WhatsAppError ? 502 : 400).json({ error: err.message }); }
        try {
            await wa.graph(`/${t.meta_id}`, { method: 'POST', body: { components: built.components } });
        } catch (err) {
            if (err instanceof wa.WhatsAppError) return res.status(502).json({ error: err.message });
            throw err;
        }
        const r = await db.query(
            `UPDATE wa_templates SET body_text = $2, variables = $3, components = $4, status = 'PENDING',
                    header_kind = $5, rejected_reason = NULL, synced_at = CURRENT_TIMESTAMP
              WHERE id = $1 RETURNING ${TEMPLATE_FIELDS}`,
            [t.id, built.body, built.variables, JSON.stringify(built.components), built.components.find(c => c.type === 'HEADER')?.format || null]);
        res.json({ template: shapeTemplate(r.rows[0]) });
    } catch (err) {
        console.error('normless template edit error:', err);
        res.status(500).json({ error: 'Could not send that to Meta' });
    }
});

router.delete('/templates/:id', manager, async (req, res) => {
    try {
        const t = (await db.query(`SELECT id, name, meta_id FROM wa_templates WHERE id = $1 AND line_id = $2`, [req.params.id, req.waLine.id])).rows[0];
        if (!t) return res.status(404).json({ error: 'That template is already gone' });
        try {
            const qs = new URLSearchParams({ name: t.name, ...(t.meta_id ? { hsm_id: t.meta_id } : {}) });
            await wa.graph(`/${wa.wabaId()}/message_templates?${qs}`, { method: 'DELETE' });
        } catch (err) {
            if (err instanceof wa.WhatsAppError) return res.status(502).json({ error: err.message });
            throw err;
        }
        await db.query('DELETE FROM wa_templates WHERE id = $1', [t.id]);
        res.json({ ok: true });
    } catch (err) {
        console.error('normless template delete error:', err);
        res.status(500).json({ error: 'Could not delete that at Meta' });
    }
});


module.exports = router;
module.exports.buildComponents = buildComponents;
module.exports.isOurs = isOurs;
