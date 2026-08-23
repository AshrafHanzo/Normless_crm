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

/** Undoing something that already moved stock is an owner/admin act, not a general edit right. */
const isAdmin = (req) => req.user?.role === 'owner' || req.user?.role === 'admin';

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
               FROM inventory_unmapped WHERE NOT dismissed
              GROUP BY product_title, product_type, variant
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

// POST /api/inventory/unmapped/dismiss { product_title, variant } — or {} for all.
// Dismissing only forgets the warning, never the sale: the order itself is untouched, and if the
// same line is seen again it comes back, because the stock behind it still was never deducted.
router.post('/unmapped/dismiss', canEdit, async (req, res) => {
    try {
        const { product_title, variant, all } = req.body || {};
        // Flagged, not deleted: the sync re-reports every unresolved line on each run, so a deleted
        // row would simply come back. The record is also the only trace that the sale went
        // uncounted, which is worth keeping.
        if (all) {
            const r = await db.query('UPDATE inventory_unmapped SET dismissed = true WHERE NOT dismissed RETURNING id');
            return res.json({ success: true, dismissed: r.rowCount });
        }
        if (!product_title) return res.status(400).json({ error: 'product_title is required' });
        const r = await db.query(
            `UPDATE inventory_unmapped SET dismissed = true
              WHERE product_title = $1 AND COALESCE(variant,'') = COALESCE($2,'') AND NOT dismissed RETURNING id`,
            [product_title, variant || '']);
        res.json({ success: true, dismissed: r.rowCount });
    } catch (err) {
        console.error('inventory dismiss error:', err);
        res.status(500).json({ error: 'Failed to dismiss' });
    }
});

// POST /api/inventory/reorder-levels { entries: [{ blank_type, color, size, reorder_level }] }
// The level a blank should not fall below. Set per cell because demand is per cell — Red / M
// outsells Brown / XS many times over, so one number across the grid would be wrong everywhere.
router.post('/reorder-levels', canEdit, async (req, res) => {
    try {
        const { entries } = req.body || {};
        if (!Array.isArray(entries) || !entries.length) return res.status(400).json({ error: 'entries must be a non-empty array' });
        if (entries.length > 1000) return res.status(400).json({ error: 'Too many entries in one save' });
        for (const e of entries) {
            if (!e?.blank_type || !e?.color || !e?.size) return res.status(400).json({ error: 'Every entry needs blank_type, color and size' });
            const n = Number(e.reorder_level);
            if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: `Reorder level for ${e.blank_type} ${e.color} ${e.size} must be 0 or more` });
        }
        const changed = await db.transaction(async (tx) => {
            let n = 0;
            for (const e of entries) {
                // The row may not exist yet — a level can be set on a blank before it is counted.
                await tx.query(
                    `INSERT INTO inventory_items (blank_type, color, size, qty) VALUES ($1,$2,$3,0)
                     ON CONFLICT (blank_type, color, size) DO NOTHING`, [e.blank_type, e.color, e.size]);
                const r = await tx.query(
                    `UPDATE inventory_items SET reorder_level = $1, updated_at = CURRENT_TIMESTAMP
                      WHERE blank_type = $2 AND color = $3 AND size = $4 AND reorder_level <> $1`,
                    [Number(e.reorder_level), e.blank_type, e.color, e.size]);
                n += r.rowCount;
            }
            return n;
        });
        res.json({ success: true, changed });
    } catch (err) {
        console.error('inventory reorder level error:', err);
        res.status(500).json({ error: 'Failed to save reorder levels' });
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
        // Seeding orders come off the same shelf, so the catch-up covers them too — otherwise a
        // shop starting today would have to remember two separate actions.
        const marketing = await inv.applyMarketingSince(since);
        const crewfit = await inv.applyCrewfitSince(since);
        res.json({ success: true, ...out, marketing, crewfit });
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

/* ==========================================================================================
 * RTO — printed garments that came back
 * ========================================================================================== */

/** Resolve a product + variant to the blank behind it, so a reuse knows what to credit. */
async function resolveBlank(shopify_product_id, variant) {
    const parts = inv.splitVariant(variant);
    if (!parts || !shopify_product_id) return { blank_type: null, color: parts?.color || null, size: parts?.size || null };
    const p = (await db.query('SELECT product_type, sku_prefix FROM shopify_products WHERE shopify_id = $1', [shopify_product_id])).rows[0];
    return { blank_type: inv.blankTypeFor(p), color: parts.color, size: parts.size };
}

// GET /api/inventory/products — the cached catalogue, for putting a piece on the shelf by hand
router.get('/products', async (req, res) => {
    try {
        const r = await db.query(
            `SELECT p.shopify_id, p.title, p.product_type, p.blank_type,
                    v.variant_id, v.variant, v.color, v.size
               FROM shopify_products p
               LEFT JOIN shopify_variants v ON v.shopify_product_id = p.shopify_id
              ORDER BY p.title, v.variant`);
        const byId = new Map();
        for (const row of r.rows) {
            if (!byId.has(row.shopify_id)) {
                byId.set(row.shopify_id, { shopify_id: row.shopify_id, title: row.title,
                    product_type: row.product_type, blank_type: row.blank_type, variants: [] });
            }
            if (row.variant_id) {
                byId.get(row.shopify_id).variants.push({ variant_id: row.variant_id, variant: row.variant, color: row.color, size: row.size });
            }
        }
        res.json({ products: [...byId.values()] });
    } catch (err) {
        console.error('inventory products error:', err);
        res.status(500).json({ error: 'Failed to load products' });
    }
});

// GET /api/inventory/rto — the shelf, its history, and what it could serve
router.get('/rto', async (req, res) => {
    try {
        const [shelf, matches] = await Promise.all([inv.rtoAvailable(), inv.rtoMatches()]);
        const entries = (await db.query(
            `SELECT r.*, (r.qty - r.qty_used - r.qty_written_off) AS available
               FROM inventory_rto r ORDER BY r.created_at DESC, r.id DESC LIMIT 200`)).rows;
        const byOrder = new Map();
        for (const m of matches) {
            if (!byOrder.has(m.order_number)) byOrder.set(m.order_number, { order_number: m.order_number, created_at: m.created_at, lines: [] });
            byOrder.get(m.order_number).lines.push(m);
        }
        res.json({
            shelf, entries, matches: [...byOrder.values()],
            summary: {
                pieces: shelf.reduce((n, r) => n + r.available, 0),
                designs: shelf.length,
                matched_orders: byOrder.size,
                used: entries.reduce((n, r) => n + r.qty_used, 0),
            },
        });
    } catch (err) {
        console.error('inventory rto error:', err);
        res.status(500).json({ error: 'Failed to load RTO stock' });
    }
});

// GET /api/inventory/rto/alerts — the number behind the badges. Deliberately small and cheap.
router.get('/rto/alerts', async (req, res) => {
    try {
        const matches = await inv.rtoMatches();
        const orders = [...new Set(matches.map(m => m.order_number))];
        res.json({ orders: orders.length, order_numbers: orders.slice(0, 20), lines: matches.length });
    } catch (err) {
        console.error('inventory rto alerts error:', err);
        res.status(500).json({ error: 'Failed to load RTO alerts' });
    }
});

// GET /api/inventory/rto/order/:orderNumber — what came back, ready to be ticked off
router.get('/rto/order/:orderNumber', async (req, res) => {
    try {
        const raw = String(req.params.orderNumber || '').trim();
        // A scanner reads a label, not a field: pull the order number out of whatever it produces.
        const digits = raw.match(/\d{4,}/);
        const id = digits ? digits[0] : raw.replace(/^#/, '');
        const order = (await db.query(
            `SELECT o.shopify_id, o.order_number, o.created_at, o.financial_status, o.fulfillment_status,
                    o.total_price, o.line_items_json, c.first_name, c.last_name, c.email
               FROM orders o LEFT JOIN customers c ON c.shopify_id = o.customer_shopify_id
              WHERE o.order_number IN ($1, $2) LIMIT 1`, [id, `#${id}`])).rows[0];
        if (!order) return res.status(404).json({ error: `No order found for "${raw}"` });

        const already = new Set((await db.query(
            'SELECT source_ref FROM inventory_rto WHERE source_ref LIKE $1', [`${order.shopify_id}:%`])).rows.map(r => r.source_ref));

        const items = [];
        for (const it of inv.safeItems(order)) {
            const ref = `${order.shopify_id}:${it.shopify_variant_id || it.title}`;
            const blank = await resolveBlank(it.shopify_product_id, it.variant);
            items.push({
                source_ref: ref, shopify_product_id: it.shopify_product_id, variant_id: it.shopify_variant_id || null,
                product_title: it.title, variant: it.variant, qty: parseInt(it.quantity, 10) || 0,
                image: it.image || null, ...blank, on_shelf: already.has(ref),
            });
        }
        res.json({ order: { ...order, line_items_json: undefined }, items });
    } catch (err) {
        console.error('inventory rto order lookup error:', err);
        res.status(500).json({ error: 'Failed to look up the order' });
    }
});

// POST /api/inventory/rto { items: [...] } — put returned pieces on the shelf.
// Nothing moves in blank stock here: the blank was consumed when the garment was printed, and it
// is still consumed — the piece is just back in the building.
router.post('/rto', canEdit, async (req, res) => {
    try {
        const items = req.body?.items;
        if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items must be a non-empty array' });
        if (items.length > 200) return res.status(400).json({ error: 'Too many items in one save' });
        for (const it of items) {
            if (!it?.product_title) return res.status(400).json({ error: 'Every item needs a product' });
            const n = parseInt(it.qty, 10);
            if (!Number.isFinite(n) || n <= 0) return res.status(400).json({ error: `Quantity for ${it.product_title} must be 1 or more` });
        }

        const out = await db.transaction(async (tx) => {
            const added = [];
            for (const it of items) {
                const qty = parseInt(it.qty, 10);
                const blank = it.blank_type ? { blank_type: it.blank_type, color: it.color, size: it.size }
                    : await resolveBlank(it.shopify_product_id, it.variant);
                const r = await tx.query(
                    `INSERT INTO inventory_rto (shopify_product_id, variant_id, product_title, variant, color, size,
                                                blank_type, qty, source_order_number, source_ref, reason, note, location, created_by)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
                     -- Scanning the same returned parcel twice must not shelf it twice.
                     ON CONFLICT (source_ref) WHERE source_ref IS NOT NULL DO NOTHING
                     RETURNING id`,
                    [it.shopify_product_id || null, it.variant_id || null, it.product_title, it.variant || null,
                        blank.color || null, blank.size || null, blank.blank_type || null, qty,
                        it.source_order_number || null, it.source_ref || null, it.reason || null,
                        it.note || null, it.location || null, req.user?.username || null]);
                if (!r.rows[0]) continue;   // already on the shelf
                await tx.query(
                    `INSERT INTO inventory_rto_events (rto_id, kind, qty, order_number, note, created_by)
                     VALUES ($1,'in',$2,$3,$4,$5)`,
                    [r.rows[0].id, qty, it.source_order_number || null, it.reason || null, req.user?.username || null]);
                added.push(r.rows[0].id);

                // A refund on a fulfilled order is flagged for review because a printed garment
                // cannot go back to blank stock. If it physically came back, that question is now
                // answered — the piece is on the RTO shelf.
                if (it.source_ref) {
                    await tx.query(
                        `UPDATE inventory_movements SET needs_review = false,
                                review_reason = COALESCE(review_reason,'') || ' — returned; on the RTO shelf'
                          WHERE source_ref = $1 AND needs_review = true`, [it.source_ref]);
                }
            }
            return added;
        });
        res.json({ success: true, added: out.length, skipped: items.length - out.length });
    } catch (err) {
        console.error('inventory rto add error:', err);
        res.status(500).json({ error: 'Failed to add to RTO' });
    }
});

// POST /api/inventory/rto/:id/use { order_number, qty } — sent out again.
// This is where the blank comes back: the order that reused it deducted one when it was placed,
// but nothing was printed for it, so the count would drift low once per reuse.
router.post('/rto/:id/use', canEdit, async (req, res) => {
    try {
        const qty = parseInt(req.body?.qty ?? 1, 10);
        const orderNumber = String(req.body?.order_number || '').trim();
        if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'qty must be 1 or more' });
        if (!orderNumber) return res.status(400).json({ error: 'Which order is it going to?' });

        const out = await db.transaction(async (tx) => {
            const row = (await tx.query('SELECT * FROM inventory_rto WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
            if (!row) return { error: 'Not found', status: 404 };
            const available = row.qty - row.qty_used - row.qty_written_off;
            if (qty > available) return { error: `Only ${available} left on the shelf`, status: 400 };

            await tx.query('UPDATE inventory_rto SET qty_used = qty_used + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [qty, row.id]);
            await tx.query(
                `INSERT INTO inventory_rto_events (rto_id, kind, qty, order_number, created_by)
                 VALUES ($1,'used',$2,$3,$4)`, [row.id, qty, orderNumber, req.user?.username || null]);

            let credited = null;
            if (row.blank_type && row.color && row.size) {
                await inv.moveBlank(tx, row, qty, 'rto_reuse',
                    `Dispatched from RTO for ${orderNumber} — no blank was used`, req.user?.username);
                credited = { blank_type: row.blank_type, color: row.color, size: row.size, qty };
            }
            return { credited };
        });
        if (out.error) return res.status(out.status).json({ error: out.error });
        res.json({ success: true, ...out });
    } catch (err) {
        console.error('inventory rto use error:', err);
        res.status(500).json({ error: 'Failed to record the reuse' });
    }
});

// DELETE /api/inventory/rto/:id — a mistaken entry.
//
// Anyone who may edit inventory can remove an entry nothing has left yet, because that is simply
// undoing a typo. Once pieces have gone out, deleting means unwinding stock that has already moved
// — so it is an owner/admin act, and every effect is reversed rather than orphaned.
router.delete('/rto/:id', canEdit, async (req, res) => {
    try {
        const out = await db.transaction(async (tx) => {
            const row = (await tx.query('SELECT * FROM inventory_rto WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
            if (!row) return { error: 'Not found', status: 404 };
            const touched = row.qty_used || row.qty_written_off;
            if (touched && !isAdmin(req)) {
                return { error: 'Pieces have already left this entry — only an admin can delete it now', status: 403 };
            }

            const reversed = [];
            if (touched) {
                // Every reuse credited a blank back. Deleting the entry says that never happened,
                // so the credit is taken off again — as its own movement, because the ledger is a
                // history and not a mutable record of the present.
                const used = (await tx.query(
                    "SELECT COALESCE(SUM(qty),0)::int AS qty FROM inventory_rto_events WHERE rto_id = $1 AND kind = 'used'",
                    [row.id])).rows[0].qty;
                if (used > 0 && row.blank_type && row.color && row.size) {
                    await inv.moveBlank(tx, row, -used, 'adjustment',
                        `RTO entry #${row.id} deleted — reversing ${used} blank${used > 1 ? 's' : ''} credited on reuse`,
                        req.user?.username);
                    reversed.push(`${used} blank credit${used > 1 ? 's' : ''} reversed`);
                }
                // Write-offs recorded against this entry go with it; a damaged row pointing at a
                // deleted shelf entry would say a piece was ruined that officially never arrived.
                const dmg = (await tx.query('SELECT id, qty, movement_id FROM inventory_damaged WHERE rto_id = $1', [row.id])).rows;
                for (const d of dmg) {
                    if (d.movement_id) {
                        await inv.moveBlank(tx, row, d.qty, 'adjustment',
                            `RTO entry #${row.id} deleted — reversing write-off #${d.id}`, req.user?.username);
                    }
                    await tx.query('DELETE FROM inventory_damaged WHERE id = $1', [d.id]);
                }
                if (dmg.length) reversed.push(`${dmg.length} write-off${dmg.length > 1 ? 's' : ''} removed`);
            }

            await tx.query('DELETE FROM inventory_rto_events WHERE rto_id = $1', [row.id]);
            await tx.query('DELETE FROM inventory_rto WHERE id = $1', [row.id]);
            return { reversed };
        });
        if (out.error) return res.status(out.status).json({ error: out.error });
        res.json({ success: true, reversed: out.reversed });
    } catch (err) {
        console.error('inventory rto delete error:', err);
        res.status(500).json({ error: 'Failed to remove the entry' });
    }
});

/* ==========================================================================================
 * Damaged
 * ========================================================================================== */

// GET /api/inventory/damaged
router.get('/damaged', async (req, res) => {
    try {
        const rows = (await db.query('SELECT * FROM inventory_damaged ORDER BY created_at DESC, id DESC LIMIT 300')).rows;
        const agg = (await db.query(
            `SELECT kind, SUM(qty)::int AS qty FROM inventory_damaged GROUP BY kind`)).rows;
        const month = (await db.query(
            `SELECT SUM(qty)::int AS qty FROM inventory_damaged WHERE created_at > NOW() - INTERVAL '30 days'`)).rows[0];
        const byStage = (await db.query(
            `SELECT COALESCE(stage,'—') AS stage, SUM(qty)::int AS qty FROM inventory_damaged
              GROUP BY 1 ORDER BY 2 DESC`)).rows;
        res.json({
            rows, byStage,
            summary: {
                total: agg.reduce((n, r) => n + r.qty, 0),
                blanks: agg.find(a => a.kind === 'blank')?.qty || 0,
                finished: agg.find(a => a.kind === 'finished')?.qty || 0,
                last30: month?.qty || 0,
            },
        });
    } catch (err) {
        console.error('inventory damaged error:', err);
        res.status(500).json({ error: 'Failed to load damaged stock' });
    }
});

// POST /api/inventory/damaged — write one off.
//   kind 'blank'    → a blank ruined before or during printing; it leaves blank stock.
//   kind 'finished' → a printed piece; blank stock is untouched because that blank was already
//                     spent, and if the piece came off the RTO shelf it leaves the shelf instead.
router.post('/damaged', canEdit, async (req, res) => {
    try {
        const b = req.body || {};
        const kind = b.kind === 'finished' ? 'finished' : 'blank';
        const qty = parseInt(b.qty, 10);
        if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'qty must be 1 or more' });
        if (!b.reason) return res.status(400).json({ error: 'Say what went wrong — a write-off with no reason teaches nothing' });
        if (kind === 'blank' && (!b.blank_type || !b.color || !b.size)) {
            return res.status(400).json({ error: 'Pick the blank, colour and size that was ruined' });
        }
        if (kind === 'finished' && !b.product_title && !b.rto_id) {
            return res.status(400).json({ error: 'Pick the product that was ruined' });
        }

        const out = await db.transaction(async (tx) => {
            let rto = null;
            if (b.rto_id) {
                rto = (await tx.query('SELECT * FROM inventory_rto WHERE id = $1 FOR UPDATE', [b.rto_id])).rows[0];
                if (!rto) return { error: 'That RTO entry no longer exists', status: 404 };
                const available = rto.qty - rto.qty_used - rto.qty_written_off;
                if (qty > available) return { error: `Only ${available} left on that shelf entry`, status: 400 };
                await tx.query('UPDATE inventory_rto SET qty_written_off = qty_written_off + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [qty, rto.id]);
                await tx.query(
                    `INSERT INTO inventory_rto_events (rto_id, kind, qty, note, created_by)
                     VALUES ($1,'damaged',$2,$3,$4)`, [rto.id, qty, b.reason, req.user?.username || null]);
            }

            let movementId = null;
            if (kind === 'blank') {
                movementId = await inv.moveBlank(tx,
                    { blank_type: b.blank_type, color: b.color, size: b.size }, -qty, 'damaged',
                    [b.stage, b.reason].filter(Boolean).join(' — '), req.user?.username);
            }

            const r = await tx.query(
                `INSERT INTO inventory_damaged (kind, blank_type, color, size, shopify_product_id, variant_id,
                                                product_title, variant, rto_id, qty, stage, reason, note, movement_id, created_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
                [kind, b.blank_type || rto?.blank_type || null, b.color || rto?.color || null, b.size || rto?.size || null,
                    b.shopify_product_id || rto?.shopify_product_id || null, b.variant_id || rto?.variant_id || null,
                    b.product_title || rto?.product_title || null, b.variant || rto?.variant || null,
                    b.rto_id || null, qty, b.stage || null, b.reason, b.note || null, movementId, req.user?.username || null]);
            return { row: r.rows[0] };
        });
        if (out.error) return res.status(out.status).json({ error: out.error });
        res.json({ success: true, row: out.row });
    } catch (err) {
        console.error('inventory damaged add error:', err);
        res.status(500).json({ error: 'Failed to record the damage' });
    }
});

// DELETE /api/inventory/damaged/:id — undo a write-off, including whatever stock it moved
router.delete('/damaged/:id', canEdit, async (req, res) => {
    try {
        const out = await db.transaction(async (tx) => {
            const row = (await tx.query('SELECT * FROM inventory_damaged WHERE id = $1', [req.params.id])).rows[0];
            if (!row) return { error: 'Not found', status: 404 };
            if (row.movement_id) {
                // Put the blank back the same way it left, as its own movement — the ledger keeps
                // both halves rather than pretending the write-off never happened.
                await inv.moveBlank(tx, row, row.qty, 'adjustment',
                    `Damage entry #${row.id} removed`, req.user?.username);
            }
            if (row.rto_id) {
                await tx.query('UPDATE inventory_rto SET qty_written_off = GREATEST(qty_written_off - $1, 0), updated_at = CURRENT_TIMESTAMP WHERE id = $2', [row.qty, row.rto_id]);
                await tx.query(
                    `INSERT INTO inventory_rto_events (rto_id, kind, qty, note, created_by)
                     VALUES ($1,'removed',$2,$3,$4)`, [row.rto_id, row.qty, `Damage entry #${row.id} removed`, req.user?.username || null]);
            }
            await tx.query('DELETE FROM inventory_damaged WHERE id = $1', [row.id]);
            return {};
        });
        if (out.error) return res.status(out.status).json({ error: out.error });
        res.json({ success: true });
    } catch (err) {
        console.error('inventory damaged delete error:', err);
        res.status(500).json({ error: 'Failed to remove the entry' });
    }
});

module.exports = router;
