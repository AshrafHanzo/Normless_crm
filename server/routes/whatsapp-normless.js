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
const copies = require('../services/nl-template-copies');

const router = express.Router();

const { DEFAULTS, readSettings } = require('../services/nl-settings');

const manager = (req, res, next) => (req.waSettings ? next()
    : res.status(403).json({ error: 'You don’t have access to WhatsApp settings' }));
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
    assignment: (v) => {
        const user = (u) => str(u, 120).toLowerCase();
        const caps = Object.entries(v?.caps && typeof v.caps === 'object' ? v.caps : {})
            .map(([u, n]) => [user(u), Math.round(Number(n))]).filter(([u, n]) => u && n > 0 && n <= 1000);
        return {
            mode: ['least_busy', 'round_robin', 'manual'].includes(v?.mode) ? v.mode : 'least_busy',
            off: [...new Set((Array.isArray(v?.off) ? v.off : []).map(user).filter(Boolean))].slice(0, 200),
            caps: Object.fromEntries(caps.slice(0, 200)),
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
            settings: await readSettings(req.waLine.id), canEdit: !!req.waSettings,
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

// Templates (list, write, edit, delete) are shared with Crewfit's inbox: routes/wa-templates.
router.use(require('./wa-templates'));
const { buildComponents } = require('./wa-templates');

/* ── Automatic messages ──────────────────────────────────────────────────────────────────────
   Which template goes out on which event, and what fills it. */

const auto = require('../services/nl-automations');
const tplSet = require('../services/nl-template-set');
const links = require('../services/nl-links');
router.get('/automations', async (req, res) => {
    try {
        const cfg = await auto.config(req.waLine.id);
        res.json({
            events: auto.EVENTS, config: cfg.events, started_at: cfg.started_at,
            sources: tplSet.SOURCES, links: tplSet.LINKS, cartHours: auto.CART_HOURS,
            set: tplSet.SET.map(t => ({ event: t.event, name: t.name, category: t.category, vars: t.vars, link: t.link?.source || null,
                components: tplSet.components(t, null) })),
            // What fills each gap of the other templates (Updatrr's wording), and the copies of
            // Updatrr's linked templates still to be submitted with our links.
            suggest: copies.suggestions((await db.query(`SELECT name, body_text, components FROM wa_templates WHERE line_id = $1`, [req.waLine.id])).rows),
            copies: (await copies.plan(req.waLine.id)).map(t => ({ name: t.name, from: t.from, exists: t.exists })),
            recommended: copies.recommended((await db.query(`SELECT name, language, status FROM wa_templates WHERE line_id = $1`, [req.waLine.id])).rows),
            buttonBase: links.BUTTON_BASE(),
            // The webhook address carries its secret, so only a manager sees it.
            webhook: req.waSettings ? `${links.PUBLIC_BASE()}/api/hooks/carts/abandoned?api_key=${cfg.webhook_secret}` : null,
            carts: await auto.cartStats(req.waLine.id),
            recent: await auto.recent(req.waLine.id, { limit: 60 }),
            canEdit: !!req.waSettings,
        });
    } catch (err) {
        console.error('normless automations error:', err);
        res.status(500).json({ error: 'Could not read the automatic messages' });
    }
});

router.put('/automations', manager, async (req, res) => {
    try {
        const cfg = await auto.saveEvents(req.waLine.id, req.body?.events || {});
        res.json({ config: cfg.events, started_at: cfg.started_at });
    } catch (err) {
        console.error('normless automations save error:', err);
        res.status(500).json({ error: 'Could not save that' });
    }
});

/** Submit copies of Updatrr's linked templates, with our /go/ links, to Meta. */
router.post('/automations/copy-updatrr', manager, async (req, res) => {
    try {
        if (!wa.configured() || !wa.wabaId()) return res.status(503).json({ error: 'Connect Normless’s WhatsApp number first' });
        res.json({ results: await copies.submit(req.waLine.id) });
    } catch (err) {
        console.error('normless template copy error:', err.message);
        res.status(err instanceof wa.WhatsAppError ? 502 : 500).json({ error: err.message });
    }
});

/** Submit the CRM's own template for an event to Meta. */
router.post('/automations/:event/template', manager, async (req, res) => {
    try {
        if (!wa.configured() || !wa.wabaId()) return res.status(503).json({ error: 'Connect Normless’s WhatsApp number first' });
        res.status(201).json(await auto.createSetTemplate(req.waLine.id, req.params.event));
    } catch (err) {
        console.error('normless set template error:', err.message);
        res.status(err instanceof wa.WhatsAppError ? 502 : 400).json({ error: err.message });
    }
});

module.exports = router;
module.exports.DEFAULTS = DEFAULTS;
module.exports.buildComponents = buildComponents;
