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

const router = express.Router();

const EXCHANGE_CENTER = 'https://normless.store/apps/aftership-returns-center';

/** What a section holds before anybody has saved it. The policy facts are Normless's own. */
const DEFAULTS = {
    bot: { enabled: false, tone: 'friendly', language: 'en' },
    faqs: [
        { q: 'Is the COD advance refundable?', a: 'No — any advance on a partial COD order is non-refundable.' },
        { q: 'Do you ship outside India?', a: 'Yes. Charges are shown at checkout; delivery takes 7–21 business days.' },
        { q: 'How long does a refund take?', a: 'Approved refunds are processed within 10 business days.' },
    ],
    handoff: {
        refund: true, damaged: true, asks_person: true, unsure: true, no_order: true, upset: true,
        big_order: false, big_order_amount: 5000,
    },
    menu: {
        greeting: 'Hi {name}, welcome to Normless. What can we help with?',
        options: ['Track my order', 'Size help', 'Exchange or return', 'Something else'],
        exchange_url: EXCHANGE_CENTER,
    },
    hours: {
        days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '18:00',
        away: 'Thanks for messaging Normless! Our team replies 9 am – 6 pm, Monday to Saturday. We have your message and will get back to you then.',
    },
};
const SECTIONS = Object.keys(DEFAULTS);

const safeJson = (v) => { try { return JSON.parse(v || 'null'); } catch { return null; } };
const manager = (req, res, next) => (req.waManager ? next()
    : res.status(403).json({ error: 'Only a WhatsApp manager can change these settings' }));

async function readSettings(lineId) {
    const r = await db.query('SELECT settings FROM wa_lines WHERE id = $1', [lineId]);
    const saved = safeJson(r.rows[0]?.settings) || {};
    return Object.fromEntries(SECTIONS.map(k => [k,
        Array.isArray(DEFAULTS[k]) ? (Array.isArray(saved[k]) ? saved[k] : DEFAULTS[k]) : { ...DEFAULTS[k], ...(saved[k] || {}) }]));
}

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
        const options = (Array.isArray(v?.options) ? v.options : []).map(o => str(o, 24)).filter(Boolean).slice(0, 10);
        if (!options.length) throw new Error('The menu needs at least one option');
        return { greeting: str(v?.greeting, 1000) || DEFAULTS.menu.greeting, options, exchange_url: str(v?.exchange_url, 500) || EXCHANGE_CENTER };
    },
    hours: (v) => {
        const time = (t, d) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(t)) ? String(t) : d);
        const days = [...new Set((Array.isArray(v?.days) ? v.days : []).map(Number).filter(d => d >= 0 && d <= 6))].sort();
        return { days, start: time(v?.start, '09:00'), end: time(v?.end, '18:00'), away: str(v?.away, 1000) || DEFAULTS.hours.away };
    },
};

router.get('/settings', async (req, res) => {
    try {
        res.json({ settings: await readSettings(req.waLine.id), canEdit: !!req.waManager });
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
            `SELECT u.username, u.role, u.last_login,
                    (u.role IN ('owner','admin') OR COALESCE(u.can_manage_wa_normless, false)) AS is_manager,
                    (SELECT COUNT(*)::int FROM wa_conversations v
                      WHERE v.line_id = $1 AND v.status = 'open' AND LOWER(v.assigned_to) = LOWER(u.username)) AS open_chats
               FROM admin_users u
              WHERE COALESCE(u.is_active, true) = true
                AND (u.role IN ('owner','admin') OR COALESCE(u.can_view_wa_normless, false) = true)
              ORDER BY LOWER(u.username)`, [req.waLine.id]);
        res.json({ members: r.rows });
    } catch (err) {
        console.error('normless team error:', err);
        res.status(500).json({ error: 'Could not load the team' });
    }
});

module.exports = router;
module.exports.DEFAULTS = DEFAULTS;
