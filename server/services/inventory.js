/**
 * Blank-garment inventory for Normless.
 *
 * Stock is held per BLANK — a plain garment in one colour and one size — never per design. The
 * store sells 78 Oversize designs that are all printed on the same blank, so a sale of any of them
 * in Black / L draws from the single "Oversized Tee / Black / L" pool.
 *
 * A line item is resolved through the product it belongs to, not its title: titles are design
 * names ("Natty Forever") and say nothing about the garment. SKUs are not used as the key either —
 * 22 variants across 8 products have none — so the chain is
 *
 *     line item → shopify_product_id → product_type → blank type
 *     line item → variant "Black / L" → colour + size
 *
 * with one exception: three products are typed Oversize but carry HDE SKUs and are hoodies, which
 * come off a different blank. Those are detected by SKU prefix and pooled separately.
 */

const db = require('../db/connection');

// Shopify product_type → the blank it is printed on.
const TYPE_TO_BLANK = {
    Oversize: 'Oversized Tee',
    Tanks: 'Tank',
    Joggers: 'Track Pant',
};
// SKU prefixes that override the product type. HDE products are typed "Oversize" in Shopify but
// are hoodies; without this they would eat oversized-tee stock.
const SKU_TO_BLANK = { HDE: 'Hoodie' };

const BLANK_TYPES = ['Oversized Tee', 'Tank', 'Track Pant', 'Hoodie'];
const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'];

/** Blank type for a cached product row, or null if we can't tell. */
function blankTypeFor(product) {
    if (!product) return null;
    if (product.sku_prefix && SKU_TO_BLANK[product.sku_prefix]) return SKU_TO_BLANK[product.sku_prefix];
    return TYPE_TO_BLANK[product.product_type] || null;
}

/** "Black / L" → { color: 'Black', size: 'L' }. Anything else is unusable. */
function splitVariant(variant) {
    const parts = String(variant || '').split('/').map(s => s.trim()).filter(Boolean);
    if (parts.length !== 2) return null;
    return { color: parts[0], size: parts[1] };
}

/**
 * Refresh the local product cache from Shopify. Called on demand rather than per order — 86
 * products, and an order line only needs to know what kind of garment it was.
 */
async function refreshProductCache() {
    const domain = process.env.SHOPIFY_STORE_DOMAIN;
    const token = process.env.SHOPIFY_ACCESS_TOKEN;
    if (!domain || !token) throw new Error('Shopify credentials are not configured');

    const res = await fetch(`https://${domain}/admin/api/2026-04/products.json?limit=250&fields=id,title,product_type,variants`,
        { headers: { 'X-Shopify-Access-Token': token } });
    if (!res.ok) throw new Error(`Shopify products request failed (${res.status})`);
    const { products = [] } = await res.json();

    for (const p of products) {
        // The prefix of whichever variant actually has a SKU — they agree within a product.
        const sku = (p.variants || []).map(v => v.sku).find(Boolean) || '';
        const prefix = sku.split('/')[0] || null;
        const row = { product_type: p.product_type, sku_prefix: prefix };
        await db.query(
            `INSERT INTO shopify_products (shopify_id, title, product_type, sku_prefix, blank_type, updated_at)
             VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP)
             ON CONFLICT (shopify_id) DO UPDATE SET
               title = excluded.title, product_type = excluded.product_type,
               sku_prefix = excluded.sku_prefix, blank_type = excluded.blank_type,
               updated_at = CURRENT_TIMESTAMP`,
            [p.id, p.title, p.product_type || null, prefix, blankTypeFor(row)]);

        // Record every colour/size this blank is sold in, so the grid can show a cell to count
        // into before any stock exists.
        const blank = blankTypeFor(row);
        if (!blank) continue;
        for (const v of p.variants || []) {
            const parts = splitVariant(v.title);
            if (!parts) continue;
            await db.query(
                `INSERT INTO inventory_catalog (blank_type, color, size) VALUES ($1,$2,$3)
                 ON CONFLICT DO NOTHING`, [blank, parts.color, parts.size]);
        }
    }
    return products.length;
}

/** shopify_id → cached product row. */
async function productIndex() {
    const r = await db.query('SELECT shopify_id, title, product_type, sku_prefix, blank_type FROM shopify_products');
    return new Map(r.rows.map(p => [String(p.shopify_id), p]));
}

function safeItems(order) {
    try {
        const v = order.line_items_json;
        return (typeof v === 'string' ? JSON.parse(v || '[]') : (v || [])) || [];
    } catch { return []; }
}

/**
 * What one order should take out of stock: one entry per (variant), because a single order can
 * list the same variant on two lines and they must not become two competing movements.
 */
function deductionsFor(order, index) {
    const wanted = new Map();   // source_ref → { blank_type, color, size, qty, title }
    const unmapped = new Map(); // source_ref → why not
    for (const it of safeItems(order)) {
        const qty = parseInt(it.quantity, 10) || 0;
        if (qty <= 0) continue;
        const ref = `${order.shopify_id}:${it.shopify_variant_id || it.title}`;
        const product = index.get(String(it.shopify_product_id));
        const blank = blankTypeFor(product);
        const parts = splitVariant(it.variant);

        if (!blank || !parts) {
            const reason = !product ? 'Product not in the local catalog cache'
                : !blank ? `Product type "${product.product_type || '—'}" is not linked to a blank`
                    : `Variant "${it.variant || '—'}" is not in "Colour / Size" form`;
            const prev = unmapped.get(ref);
            unmapped.set(ref, { ref, order_number: order.order_number, title: it.title,
                product_type: product?.product_type || null, variant: it.variant,
                qty: (prev?.qty || 0) + qty, reason });
            continue;
        }
        const prev = wanted.get(ref);
        wanted.set(ref, { blank_type: blank, color: parts.color, size: parts.size,
            qty: (prev?.qty || 0) + qty, title: it.title });
    }
    return { wanted, unmapped };
}

/**
 * Whether this order's stock should currently be held out.
 *
 * Deduction happens when the order is placed, so a cancelled or voided order that never shipped
 * gives its blanks back — nothing was printed. A refund on an order that already shipped does
 * NOT: that garment carries a print and cannot go back to blank stock, so it is flagged for a
 * human instead of silently restoring stock that does not exist.
 */
function holdState(order) {
    const fin = (order.financial_status || '').toLowerCase();
    const ful = (order.fulfillment_status || '').toLowerCase();
    const reversed = ['voided', 'refunded'].includes(fin);
    if (!reversed) return { hold: true };
    if (ful === 'fulfilled') {
        return { hold: true, needs_review: true, review_reason: `Order is ${fin} but was already fulfilled — the printed garment cannot return to blank stock. Adjust by hand if it did.` };
    }
    return { hold: false };
}

/** Find or create the stock row for a blank. */
async function itemIdFor(tx, { blank_type, color, size }) {
    const ins = await tx.query(
        `INSERT INTO inventory_items (blank_type, color, size, qty)
         VALUES ($1,$2,$3,0) ON CONFLICT (blank_type, color, size) DO NOTHING RETURNING id`,
        [blank_type, color, size]);
    if (ins.rows[0]) return ins.rows[0].id;
    const sel = await tx.query(
        'SELECT id FROM inventory_items WHERE blank_type=$1 AND color=$2 AND size=$3',
        [blank_type, color, size]);
    return sel.rows[0].id;
}

/**
 * Apply one order to stock, idempotently.
 *
 * The sync re-imports every order on each run, so this is written to be safe to call any number
 * of times: each (order, variant) owns exactly one movement row, and re-processing moves stock
 * only by the difference between what that row says now and what it should say.
 */
async function applyOrder(tx, order, index) {
    const { wanted, unmapped } = deductionsFor(order, index);
    const state = holdState(order);
    let changed = 0;

    const existing = new Map((await tx.query(
        'SELECT id, item_id, delta, source_ref FROM inventory_movements WHERE source_ref LIKE $1',
        [`${order.shopify_id}:%`])).rows.map(m => [m.source_ref, m]));

    for (const [ref, want] of wanted) {
        const targetDelta = state.hold ? -want.qty : 0;
        const itemId = await itemIdFor(tx, want);
        const prev = existing.get(ref);
        const prevDelta = prev ? prev.delta : 0;
        if (prev && prevDelta === targetDelta && prev.item_id === itemId) { existing.delete(ref); continue; }

        if (prev && prev.item_id !== itemId) {
            // The variant was remapped (a product retyped in Shopify) — undo it where it landed.
            await tx.query('UPDATE inventory_items SET qty = qty - $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [prevDelta, prev.item_id]);
            await tx.query('UPDATE inventory_movements SET item_id = $1, delta = 0 WHERE id = $2', [itemId, prev.id]);
        }
        const applyFrom = prev && prev.item_id === itemId ? prevDelta : 0;
        await tx.query('UPDATE inventory_items SET qty = qty + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [targetDelta - applyFrom, itemId]);

        if (prev) {
            await tx.query(
                `UPDATE inventory_movements SET delta=$1, item_id=$2, order_number=$3, note=$4,
                        needs_review=$5, review_reason=$6 WHERE id=$7`,
                [targetDelta, itemId, order.order_number, want.title, !!state.needs_review, state.review_reason || null, prev.id]);
        } else {
            await tx.query(
                `INSERT INTO inventory_movements (item_id, delta, reason, source_ref, order_number, note, needs_review, review_reason)
                 VALUES ($1,$2,'order',$3,$4,$5,$6,$7)
                 -- The unique index is partial (source_ref IS NOT NULL), so the conflict target
                 -- has to carry the same predicate or Postgres won't match it to an index.
                 ON CONFLICT (source_ref) WHERE source_ref IS NOT NULL DO NOTHING`,
                [itemId, targetDelta, ref, order.order_number, want.title, !!state.needs_review, state.review_reason || null]);
        }
        existing.delete(ref);
        changed++;
    }

    // Lines that were on the order last time and are not any more — an edited order. Give back.
    for (const [, stale] of existing) {
        if (stale.delta !== 0) {
            await tx.query('UPDATE inventory_items SET qty = qty - $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [stale.delta, stale.item_id]);
            changed++;
        }
        await tx.query('DELETE FROM inventory_movements WHERE id = $1', [stale.id]);
    }

    for (const [ref, u] of unmapped) {
        await tx.query(
            `INSERT INTO inventory_unmapped (source_ref, order_number, product_title, product_type, variant, qty, reason)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (source_ref) DO UPDATE SET qty = excluded.qty, reason = excluded.reason`,
            [ref, u.order_number, u.title, u.product_type, u.variant, u.qty, u.reason]);
    }
    return changed;
}

/** Apply a batch of orders. Used by the sync and by the "process history" action. */
async function applyOrders(orders) {
    if (!orders.length) return { orders: 0, changed: 0 };
    const index = await productIndex();
    let changed = 0;
    await db.transaction(async (tx) => {
        for (const o of orders) changed += await applyOrder(tx, o, index);
    });
    return { orders: orders.length, changed };
}

/** Orders placed on or after `since`, oldest first. */
async function applySince(since) {
    const r = await db.query(
        `SELECT shopify_id, order_number, financial_status, fulfillment_status, line_items_json, created_at
           FROM orders WHERE created_at >= $1 ORDER BY created_at ASC`, [since]);
    return applyOrders(r.rows);
}

module.exports = {
    BLANK_TYPES, SIZE_ORDER, TYPE_TO_BLANK, SKU_TO_BLANK,
    refreshProductCache, productIndex, blankTypeFor, splitVariant,
    deductionsFor, holdState, applyOrder, applyOrders, applySince,
};
