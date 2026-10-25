/**
 * Normless's WhatsApp settings.
 *
 * Mounted at /api/nl-whatsapp/nl. Everything a manager sets for the Normless bot and inbox —
 * whether the bot answers, how it speaks, the extra answers it may give, when it must hand over,
 * the welcome menu, the team's hours — is kept on Normless's own line (wa_lines.settings), never
 * in Crewfit's wa_settings, so neither brand's settings can leak into the other's chats.
 *
 * What the bot knows about the shop is not set here at all: products, sizes, stock, size charts
 * and the refund and shipping policies are read from Shopify, and this only reports what it found.
 */

const express = require('express');
const db = require('../db/connection');
const shopify = require('../services/shopify');
const wa = require('../services/whatsapp');
const nlBot = require('../services/nl-bot');
const { displayName } = require('../services/nl-handover');

const router = express.Router();

const { DEFAULTS, readSettings } = require('../services/nl-settings');

const manager = (req, res, next) => (req.waManager ? next()
    : res.status(403).json({ error: 'Only a WhatsApp manager can change these settings' }));
const safeJson = (v) => { try { return JSON.parse(v || 'null'); } catch { return null; } };

/** Each section is cleaned to the shape it should have; anything else is dropped. */
const str = (v, max = 1000) => String(v ?? '').trim().slice(0, max);
const CLEAN = {
    bot: (v) => ({
        enabled: !!v?.enabled,
        tone: ['friendly', 'formal', 'playful'].includes(v?.tone) ? v.tone : 'friendly',
        language: ['en', 'customer'].includes(v?.language) ? v.language : 'en',
    }),
    faqs: (v) => (Array.isArray(v) ? v : []).map(f => ({ q: str(f?.q, 200), a: str(f?.a, 1000) })).filter(f => f.q && f.a).slice(0, 50),
    handoff: (v) => ({
        ...Object.fromEntries(['refund', 'damaged', 'asks_person', 'unsure', 'no_order', 'upset', 'big_order'].map(k => [k, !!v?.[k]])),
        big_order_amount: Math.max(0, Math.round(Number(v?.big_order_amount) || 0)),
    }),
    menu: (v) => {
        const given = new Map((Array.isArray(v?.items) ? v.items : []).map(i => [i?.key, i]));
        const items = DEFAULTS.menu.items.map(d => ({
            key: d.key, label: str(given.get(d.key)?.label, 24) || d.label, enabled: given.has(d.key) ? !!given.get(d.key).enabled : d.enabled,
        }));
        if (!items.some(i => i.enabled)) throw new Error('Keep at least one menu option switched on');
        return {
            enabled: v?.enabled !== false, greeting: str(v?.greeting, 1000) || DEFAULTS.menu.greeting,
            items, exchange_url: str(v?.exchange_url, 500) || DEFAULTS.menu.exchange_url,
        };
    },
    hours: (v) => {
        const time = (t, d) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(t)) ? String(t) : d);
        const days = [...new Set((Array.isArray(v?.days) ? v.days : []).map(Number).filter(d => d >= 0 && d <= 6))].sort();
        return { days, start: time(v?.start, '09:00'), end: time(v?.end, '18:00'), away: str(v?.away, 1000) || DEFAULTS.hours.away };
    },
};

router.get('/settings', async (req, res) => {
    try {
        res.json({
            settings: await readSettings(req.waLine.id), canEdit: !!req.waManager,
            // Whether the bot can actually answer: it needs Anthropic's key on the server.
            botReady: !!process.env.ANTHROPIC_API_KEY, botModel: nlBot.MODEL,
        });
    } catch (err) {
        console.error('normless whatsapp settings error:', err);
        res.status(500).json({ error: 'Could not read the settings' });
    }
});

router.put('/settings/:section', manager, async (req, res) => {
    try {
        const section = req.params.section;
        if (!CLEAN[section]) return res.status(404).json({ error: 'No such setting' });
        let value;
        try { value = CLEAN[section](req.body?.value); }
        catch (err) { return res.status(400).json({ error: err.message }); }
        // One section at a time, merged under a row lock so two managers saving different
        // sections at once cannot undo each other.
        await db.transaction(async (c) => {
            const row = (await c.query('SELECT settings FROM wa_lines WHERE id = $1 FOR UPDATE', [req.waLine.id])).rows[0];
            const all = safeJson(row?.settings) || {};
            all[section] = value;
            all.updated_by = req.user?.username || null;
            all.updated_at = new Date().toISOString();
            await c.query('UPDATE wa_lines SET settings = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [req.waLine.id, JSON.stringify(all)]);
        });
        res.json({ settings: await readSettings(req.waLine.id) });
    } catch (err) {
        console.error('normless whatsapp settings save error:', err);
        res.status(500).json({ error: 'Could not save that' });
    }
});

/**
 * What the bot will know, as Shopify has it right now: the policies, and the products with their
 * size charts. A failure to reach Shopify is reported per part rather than failing the page.
 */
async function knowledge(force) {
    const out = { checked_at: new Date().toISOString() };
    try {
        const policies = await shopify.fetchPolicies({ force });
        out.policies = policies.map(p => ({ title: p.title, url: p.url, updated_at: p.updated_at, chars: p.text.length }));
    } catch (err) { out.policies_error = err.message; }
    try {
        const products = await shopify.fetchProducts({ force });
        const byType = new Map();
        for (const p of products) {
            const t = p.product_type || 'Other';
            const row = byType.get(t) || { type: t, products: 0, with_chart: 0 };
            row.products++;
            if (p.size_chart) row.with_chart++;
            byType.set(t, row);
        }
        out.products = {
            count: products.length,
            with_chart: products.filter(p => p.size_chart).length,
            in_stock: products.filter(p => p.variants.some(v => v.available == null || v.available > 0)).length,
            by_type: [...byType.values()].sort((a, b) => b.products - a.products),
            missing_chart: products.filter(p => !p.size_chart).map(p => ({ title: p.title, type: p.product_type || 'Other', handle: p.handle })),
        };
    } catch (err) { out.products_error = err.message; }
    return out;
}

router.get('/knowledge', async (req, res) => {
    try { res.json(await knowledge(false)); }
    catch (err) { console.error('normless knowledge error:', err); res.status(500).json({ error: 'Could not read Shopify' }); }
});

router.post('/knowledge/sync', manager, async (req, res) => {
    try { res.json(await knowledge(true)); }
    catch (err) { console.error('normless knowledge sync error:', err); res.status(500).json({ error: 'Could not read Shopify' }); }
});

/** Who answers Normless's chats: everyone with the Normless inbox grant, and their open chats. */
router.get('/team', async (req, res) => {
    try {
        const r = await db.query(
            `SELECT u.username, u.role, u.last_login, u.wa_display_name,
                    COALESCE(u.can_view_wa_normless, false) AS in_queue,
                    (u.role IN ('owner','admin') OR COALESCE(u.can_manage_wa_normless, false)) AS is_manager,
                    (SELECT COUNT(*)::int FROM wa_conversations v
                      WHERE v.line_id = $1 AND v.status = 'open' AND LOWER(v.assigned_to) = LOWER(u.username)) AS open_chats
               FROM admin_users u
              WHERE COALESCE(u.is_active, true) = true
                AND (u.role IN ('owner','admin') OR COALESCE(u.can_view_wa_normless, false) = true)
              ORDER BY LOWER(u.username)`, [req.waLine.id]);
        res.json({ members: r.rows.map(m => ({ ...m, display_name: displayName(m), default_name: displayName({ username: m.username }) })) });
    } catch (err) {
        console.error('normless team error:', err);
        res.status(500).json({ error: 'Could not load the team' });
    }
});

/** The name customers see for a person ("this is Priya from the Normless team"). Blank resets it. */
router.put('/team/:username', manager, async (req, res) => {
    try {
        const name = str(req.body?.display_name, 40) || null;
        const r = await db.query(
            `UPDATE admin_users SET wa_display_name = $2 WHERE LOWER(username) = LOWER($1) RETURNING username, wa_display_name`,
            [req.params.username, name]);
        if (!r.rows[0]) return res.status(404).json({ error: 'No such person' });
        res.json({ username: r.rows[0].username, display_name: displayName(r.rows[0]) });
    } catch (err) {
        console.error('normless team name error:', err);
        res.status(500).json({ error: 'Could not save that' });
    }
});

/* ── The bot, tried out from Settings without sending anything ─────────────────────────────── */

router.post('/bot/try', async (req, res) => {
    try {
        const turns = (Array.isArray(req.body?.turns) ? req.body.turns : [])
            .map(t => ({ role: t?.role === 'bot' ? 'bot' : 'customer', text: str(t?.text, 2000) })).filter(t => t.text).slice(-20);
        if (!turns.length || turns[turns.length - 1].role !== 'customer') return res.status(400).json({ error: 'Ask something as the customer first' });
        const out = await nlBot.tryIt(req.waLine.id, turns);
        if (out.error) return res.status(400).json(out);
        res.json(out);
    } catch (err) {
        console.error('normless bot try error:', err);
        res.status(502).json({ error: `The bot couldn't answer: ${err.message}` });
    }
});

/* ── Templates: create, edit, delete — what Meta approves for Normless's account ────────────── */

const TEMPLATE_FIELDS = `id, name, language, category, status, body_text, variables, header_kind, meta_id, components,
                         rejected_reason, synced_at`;
const shapeTemplate = (t) => ({ ...t, components: safeJson(t.components) || [] });
const gaps = (text) => [...new Set((String(text).match(/\{\{\s*(\d+)\s*\}\}/g) || []).map(m => Number(m.replace(/\D/g, ''))))].sort((a, b) => a - b);

/**
 * Meta's template parts from the editor's form, checked against Meta's own limits so a mistake
 * is shown here rather than coming back as a rejection.
 */
function buildComponents(b) {
    const components = [];
    const header = str(b.header, 60);
    if (header) {
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
        type: ['QUICK_REPLY', 'URL', 'PHONE_NUMBER'].includes(x?.type) ? x.type : 'QUICK_REPLY',
        text: str(x?.text, 25), url: str(x?.url, 2000), phone_number: str(x?.phone_number, 20), example: str(x?.example, 2000),
    })).filter(x => x.text);
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
        res.json({ templates: r.rows.map(shapeTemplate), canEdit: !!req.waManager, connected: wa.configured() && !!wa.wabaId() });
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
        try { built = buildComponents(b); } catch (err) { return res.status(400).json({ error: err.message }); }
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
                built.components.find(c => c.type === 'HEADER') ? 'TEXT' : null, req.waLine.id, created?.id || null, JSON.stringify(built.components)]);
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
        try { built = buildComponents(req.body || {}); } catch (err) { return res.status(400).json({ error: err.message }); }
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
            [t.id, built.body, built.variables, JSON.stringify(built.components), built.components.find(c => c.type === 'HEADER') ? 'TEXT' : null]);
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
module.exports.DEFAULTS = DEFAULTS;
module.exports.buildComponents = buildComponents;
