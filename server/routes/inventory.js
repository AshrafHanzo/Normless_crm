/**
 * Blank-garment inventory (Normless → Inventory).
 *
 * Reading is gated on can_view_inventory; anything that moves a count needs can_edit_inventory.
 * See services/inventory.js for how an order line is resolved to a blank.
 */

const express = require('express');
const db = require('../db/connection');
const inv = require('../services/inventory');
const { hasPermission } = require('../utils/permissions');

const router = express.Router();

router.use(async (req, res, next) => {
    try {
        if (!await hasPermission(req, 'can_view_inventory')) return res.status(403).json({ error: 'Access denied' });
        next();
    } catch (err) { next(err); }
});

const canEdit = async (req, res, next) => {
    try {
        if (!await hasPermission(req, 'can_edit_inventory')) {
            return res.status(403).json({ error: 'You have read-only access to inventory' });
        }
        next();
    } catch (err) { next(err); }
};

/** Sizes sort by garment order, not alphabetically — 2XL after XL, never between 2 and L. */
const sizeRank = (s) => {
    const i = inv.SIZE_ORDER.indexOf(String(s).toUpperCase());
    return i === -1 ? 99 : i;
};

// GET /api/inventory — the full grid, plus what needs attention
router.get('/', async (req, res) => {
    try {
        const items = (await db.query(
            `SELECT i.*, COALESCE(m.sold, 0)::int AS sold_30d
               FROM inventory_items i
               LEFT JOIN (
                 SELECT item_id, SUM(-delta) AS sold FROM inventory_movements
                  WHERE reason = 'order' AND delta < 0 AND created_at > NOW() - INTERVAL '30 days'
                  GROUP BY item_id
               ) m ON m.item_id = i.id`)).rows;

        items.sort((a, b) => a.blank_type.localeCompare(b.blank_type)
            || a.color.localeCompare(b.color) || sizeRank(a.size) - sizeRank(b.size));

        const unmapped = (await db.query(
            `SELECT product_title, product_type, variant, SUM(qty)::int AS qty, MAX(reason) AS reason,
                    COUNT(*)::int AS lines
               FROM inventory_unmapped GROUP BY product_title, product_type, variant
               ORDER BY SUM(qty) DESC LIMIT 50`)).rows;

        const review = (await db.query(
            `SELECT m.id, m.order_number, m.note, m.review_reason, m.delta,
                    i.blank_type, i.color, i.size
               FROM inventory_movements m JOIN inventory_items i ON i.id = m.item_id
              WHERE m.needs_review = true ORDER BY m.created_at DESC LIMIT 50`)).rows;

        // The grid is the catalogue, not just what has stock: a blank with no count yet still
        // needs a cell, otherwise a shop starting from zero has nowhere to enter its first one.
        const catalog = (await db.query('SELECT blank_type, color, size FROM inventory_catalog')).rows;

        res.json({
            items,
            catalog,
            unmapped,
            review,
            summary: {
                skus: items.length,
                units: items.reduce((s, i) => s + i.qty, 0),
                low: items.filter(i => i.reorder_level > 0 && i.qty <= i.reorder_level).length,
                negative: items.filter(i => i.qty < 0).length,
            },
            blankTypes: inv.BLANK_TYPES,
            sizes: inv.SIZE_ORDER,
        });
    } catch (err) {
        console.error('inventory list error:', err);
        res.status(500).json({ error: 'Failed to load inventory' });
    }
});

// GET /api/inventory/movements?item_id= — the ledger behind a count
router.get('/movements', async (req, res) => {
    try {
        const { item_id } = req.query;
        const r = await db.query(
            `SELECT m.*, i.blank_type, i.color, i.size FROM inventory_movements m
               JOIN inventory_items i ON i.id = m.item_id
              ${item_id ? 'WHERE m.item_id = $1' : ''}
              ORDER BY m.created_at DESC, m.id DESC LIMIT 200`, item_id ? [item_id] : []);
        res.json({ movements: r.rows });
    } catch (err) {
        console.error('inventory movements error:', err);
        res.status(500).json({ error: 'Failed to load movements' });
    }
});

// POST /api/inventory/stock { blank_type, color, size, qty, mode, note }
// mode: 'set' (a stock-take) | 'add' (a delivery, or a correction)
router.post('/stock', canEdit, async (req, res) => {
    try {
        const { blank_type, color, size, qty, mode = 'add', note } = req.body || {};
        if (!blank_type || !color || !size) return res.status(400).json({ error: 'blank_type, color and size are required' });
        const n = Number(qty);
        if (!Number.isFinite(n)) return res.status(400).json({ error: 'qty must be a number' });
        if (!['set', 'add'].includes(mode)) return res.status(400).json({ error: 'mode must be "set" or "add"' });

        const out = await db.transaction(async (tx) => {
            await inv.setStock(tx, { blank_type, color, size, qty: n, mode, note }, req.user?.username);
            return (await tx.query(
                'SELECT * FROM inventory_items WHERE blank_type=$1 AND color=$2 AND size=$3',
                [blank_type, color, size])).rows[0];
        });
        res.json({ success: true, item: out });
    } catch (err) {
        console.error('inventory stock error:', err);
        res.status(500).json({ error: 'Failed to update stock' });
    }
});

// POST /api/inventory/stock/bulk { mode, note, entries: [{ blank_type, color, size, qty }] }
// One transaction for the whole grid: a stock-take that half-applied would be worse than one that
// failed outright, because you cannot tell by looking which cells took.
router.post('/stock/bulk', canEdit, async (req, res) => {
    try {
        const { mode = 'set', note, entries } = req.body || {};
        if (!Array.isArray(entries) || !entries.length) return res.status(400).json({ error: 'entries must be a non-empty array' });
        if (entries.length > 1000) return res.status(400).json({ error: 'Too many entries in one save' });
        if (!['set', 'add'].includes(mode)) return res.status(400).json({ error: 'mode must be "set" or "add"' });

        for (const e of entries) {
            if (!e?.blank_type || !e?.color || !e?.size) return res.status(400).json({ error: 'Every entry needs blank_type, color and size' });
            if (!Number.isFinite(Number(e.qty))) return res.status(400).json({ error: `Quantity for ${e.blank_type} ${e.color} ${e.size} is not a number` });
        }

        const changes = await db.transaction(async (tx) => {
            const applied = [];
            for (const e of entries) {
                const r = await inv.setStock(tx, {
                    blank_type: e.blank_type, color: e.color, size: e.size,
                    qty: Number(e.qty), mode, note: note || (mode === 'set' ? 'Bulk stock count' : 'Bulk stock received'),
                }, req.user?.username);
                if (r) applied.push({ ...e, ...r });
            }
            return applied;
        });

        res.json({ success: true, changed: changes.length, skipped: entries.length - changes.length });
    } catch (err) {
        console.error('inventory bulk stock error:', err);
        res.status(500).json({ error: 'Failed to save the stock counts' });
    }
});

// PUT /api/inventory/items/:id { reorder_level }
router.put('/items/:id', canEdit, async (req, res) => {
    try {
        const level = parseInt(req.body?.reorder_level, 10);
        if (!Number.isFinite(level) || level < 0) return res.status(400).json({ error: 'reorder_level must be 0 or more' });
        const r = await db.query(
            'UPDATE inventory_items SET reorder_level=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2 RETURNING *',
            [level, req.params.id]);
        if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true, item: r.rows[0] });
    } catch (err) {
        console.error('inventory item update error:', err);
        res.status(500).json({ error: 'Failed to update item' });
    }
});

// POST /api/inventory/sync-catalog — refresh what each Shopify product is
router.post('/sync-catalog', canEdit, async (req, res) => {
    try {
        const n = await inv.refreshProductCache();
        res.json({ success: true, products: n });
    } catch (err) {
        console.error('inventory catalog sync error:', err);
        res.status(500).json({ error: err.message || 'Failed to refresh the product catalog' });
    }
});

// POST /api/inventory/process { since } — apply orders placed on or after `since`.
// Safe to run repeatedly: each (order, variant) owns one movement and is only ever corrected.
router.post('/process', canEdit, async (req, res) => {
    try {
        const since = req.body?.since;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(since || '')) return res.status(400).json({ error: 'since must be a YYYY-MM-DD date' });
        const out = await inv.applySince(since);
        res.json({ success: true, ...out });
    } catch (err) {
        console.error('inventory process error:', err);
        res.status(500).json({ error: err.message || 'Failed to process orders' });
    }
});

// POST /api/inventory/review/:id/clear — acknowledge a flagged movement
router.post('/review/:id/clear', canEdit, async (req, res) => {
    try {
        const r = await db.query('UPDATE inventory_movements SET needs_review=false WHERE id=$1 RETURNING id', [req.params.id]);
        if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('inventory review clear error:', err);
        res.status(500).json({ error: 'Failed to clear the flag' });
    }
});

module.exports = router;
