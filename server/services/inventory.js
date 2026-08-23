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

        const blank = blankTypeFor(row);
        for (const v of p.variants || []) {
            const parts = splitVariant(v.title);
            // Every variant is cached, blank-backed or not: an RTO piece belongs to a design, and
            // a design with no blank behind it (a cap, an accessory) can still come back.
            await db.query(
                `INSERT INTO shopify_variants (variant_id, shopify_product_id, variant, color, size, updated_at)
                 VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP)
                 ON CONFLICT (variant_id) DO UPDATE SET
                   shopify_product_id = excluded.shopify_product_id, variant = excluded.variant,
                   color = excluded.color, size = excluded.size, updated_at = CURRENT_TIMESTAMP`,
                [v.id, p.id, v.title, parts?.color || null, parts?.size || null]);
            // Record every colour/size this blank is sold in, so the grid can show a cell to count
            // into before any stock exists.
            if (blank && parts) {
                await db.query(
                    `INSERT INTO inventory_catalog (blank_type, color, size) VALUES ($1,$2,$3)
                     ON CONFLICT DO NOTHING`, [blank, parts.color, parts.size]);
            }
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
async function applyOrder(tx, order, index, state = holdState(order)) {
    const { wanted, unmapped } = deductionsFor(order, index);
    let changed = 0;

    const existing = new Map((await tx.query(
        'SELECT id, item_id, delta, source_ref, needs_review FROM inventory_movements WHERE source_ref LIKE $1',
        [`${order.shopify_id}:%`])).rows.map(m => [m.source_ref, m]));

    for (const [ref, want] of wanted) {
        const targetDelta = state.hold ? -want.qty : 0;
        const itemId = await itemIdFor(tx, want);
        const prev = existing.get(ref);
        const prevDelta = prev ? prev.delta : 0;
        // The review flag has to be part of "nothing changed". An order refunded after it shipped
        // keeps the same deduction — the garment is printed and gone — and the only thing that
        // moves is the flag asking a human about it. Comparing deltas alone would drop it.
        const sameReview = !!prev?.needs_review === !!state.needs_review;
        if (prev && prevDelta === targetDelta && prev.item_id === itemId && sameReview) { existing.delete(ref); continue; }

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
             -- dismissed is deliberately not touched: the sync re-reports every unresolved line on
             -- every run, so resetting it here would undo the dismissal within thirty seconds.
             ON CONFLICT (source_ref) DO UPDATE SET qty = excluded.qty, reason = excluded.reason`,
            [ref, u.order_number, u.title, u.product_type, u.variant, u.qty, u.reason]);
    }
    return changed;
}

/**
 * Move one blank's stock and record why.
 *
 * A stock-take is stored as the correction it implies — "counted 40, was 37" becomes +3 — so the
 * ledger still explains the number rather than having it appear from nowhere. Returns null when
 * nothing changed, so a bulk save can skip untouched cells instead of writing 53 no-op rows.
 */
async function setStock(tx, { blank_type, color, size, qty, mode = 'add', note }, user) {
    await tx.query(
        `INSERT INTO inventory_items (blank_type, color, size, qty) VALUES ($1,$2,$3,0)
         ON CONFLICT (blank_type, color, size) DO NOTHING`, [blank_type, color, size]);
    const cur = (await tx.query(
        'SELECT id, qty FROM inventory_items WHERE blank_type=$1 AND color=$2 AND size=$3',
        [blank_type, color, size])).rows[0];

    const delta = mode === 'set' ? qty - cur.qty : qty;
    if (delta === 0) return null;

    await tx.query('UPDATE inventory_items SET qty = qty + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [delta, cur.id]);
    await tx.query(
        `INSERT INTO inventory_movements (item_id, delta, reason, note, created_by) VALUES ($1,$2,$3,$4,$5)`,
        [cur.id, delta, mode === 'set' ? 'opening' : 'restock', note || null, user || null]);
    return { id: cur.id, delta, from: cur.qty, to: cur.qty + delta };
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

/* ------------------------------------------------------------------------------------------
 * Marketing seeding orders
 *
 * A shop order is deducted when it is placed; a seeding order is deducted when it is dispatched.
 * They are not the same moment on purpose — a seeding order is raised, waits for approval, and may
 * never be sent, so holding stock against it from the day it was typed would misreport the shelf
 * for weeks.
 *
 * Everything after that is the shop path exactly: one movement per (order, item), corrected rather
 * than repeated, so this can run on every save without deducting twice.
 * ---------------------------------------------------------------------------------------- */

// The pseudo shopify_id these movements are filed under. The trailing colon in the lookups means
// marketing:2 can never match marketing:20.
const marketingRef = (id) => `marketing:${id}`;

/** Marketing's item shape → the line-item shape the blank resolver reads. */
function marketingLines(order) {
    const items = typeof order.items === 'string' ? (() => { try { return JSON.parse(order.items || '[]'); } catch { return []; } })() : (order.items || []);
    return items.map(it => ({
        title: it.product, quantity: it.qty, variant: it.variant,
        shopify_product_id: it.shopify_product_id, shopify_variant_id: it.shopify_variant_id,
    }));
}

/**
 * Whether a seeding order's blanks should currently be held out.
 *
 * Held once it has left the building, released while it has not. Cancelling one that already
 * shipped is the exception: the garment carries a print and is gone, so the stock stays deducted
 * and a human is asked about it rather than the count quietly going back up.
 */
function marketingHoldState(order) {
    const status = order.status || '';
    if (status === 'Dispatched' || status === 'Delivered') return { hold: true };
    if (status === 'Cancelled' && (order.awb || order.fulfilled_date)) {
        return { hold: true, needs_review: true,
            review_reason: 'Seeding order cancelled after it had shipped — the printed garment cannot return to blank stock. Adjust by hand if it did come back.' };
    }
    return { hold: false };
}

/**
 * Apply one seeding order to blank stock. Safe to call on every save: an order that has never been
 * dispatched and has no movements does nothing at all, rather than writing a row of zeroes.
 */
async function applyMarketingOrder(order) {
    const state = marketingHoldState(order);
    const ref = marketingRef(order.id);
    const already = await db.query('SELECT 1 FROM inventory_movements WHERE source_ref LIKE $1 LIMIT 1', [`${ref}:%`]);
    if (!state.hold && !already.rows.length) return { changed: 0, deducted: [], unmapped: [] };

    const index = await productIndex();
    const pseudo = {
        shopify_id: ref,
        order_number: order.ref_no ? `MK-${order.ref_no}` : `MK#${order.id}`,
        line_items_json: JSON.stringify(marketingLines(order)),
    };
    const { wanted, unmapped } = deductionsFor(pseudo, index);
    let changed = 0;
    await db.transaction(async (tx) => { changed = await applyOrder(tx, pseudo, index, state); });
    return {
        changed,
        deducted: state.hold ? [...wanted.values()].map(w => ({ blank_type: w.blank_type, color: w.color, size: w.size, qty: w.qty })) : [],
        released: !state.hold,
        needs_review: !!state.needs_review,
        unmapped: [...unmapped.values()].map(u => ({ product: u.title, variant: u.variant, reason: u.reason })),
    };
}

/** Forget a seeding order's movements entirely, giving back anything still held. Used on delete. */
async function releaseMarketingOrder(orderId) {
    const ref = marketingRef(orderId);
    return db.transaction(async (tx) => {
        const rows = (await tx.query(
            'SELECT id, item_id, delta FROM inventory_movements WHERE source_ref LIKE $1', [`${ref}:%`])).rows;
        for (const m of rows) {
            if (m.delta !== 0) {
                await tx.query('UPDATE inventory_items SET qty = qty - $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [m.delta, m.item_id]);
            }
            await tx.query('DELETE FROM inventory_movements WHERE id = $1', [m.id]);
        }
        await tx.query('DELETE FROM inventory_unmapped WHERE source_ref LIKE $1', [`${ref}:%`]);
        return rows.length;
    });
}

/** Every seeding order dispatched on or after `since`. The catch-up for orders that predate this. */
async function applyMarketingSince(since) {
    const r = await db.query(
        `SELECT id, ref_no, status, items, awb, fulfilled_date FROM marketing_orders
          WHERE COALESCE(fulfilled_date, order_date) >= $1 ORDER BY id ASC`, [since]);
    let changed = 0;
    for (const o of r.rows) changed += (await applyMarketingOrder(o)).changed;
    return { orders: r.rows.length, changed };
}

/* ------------------------------------------------------------------------------------------
 * RTO — printed garments that came back
 *
 * These are not blanks. A returned "Natty Forever / Black / L" can only go out again to another
 * order for that same design and variant, which is the whole reason the shelf is worth keeping:
 * matched against open orders, it says "don't print this one, it is already in the box".
 *
 * Reusing a piece credits the blank back. The order that reused it deducted a blank when it was
 * placed, but no blank was consumed — the garment already existed — so the count would drift low
 * once per reuse if nothing gave it back.
 * ---------------------------------------------------------------------------------------- */

/** "Red /XL" and "Red / XL" are the same variant; compare on a single spelling of it. */
function normVariant(v) {
    const parts = splitVariant(v);
    return parts ? `${parts.color} / ${parts.size}`.toLowerCase() : String(v || '').trim().toLowerCase();
}

/** Move a blank's count and say why. Returns the movement id so the entry can be undone. */
async function moveBlank(tx, { blank_type, color, size }, delta, reason, note, user) {
    await tx.query(
        `INSERT INTO inventory_items (blank_type, color, size, qty) VALUES ($1,$2,$3,0)
         ON CONFLICT (blank_type, color, size) DO NOTHING`, [blank_type, color, size]);
    const item = (await tx.query(
        'SELECT id FROM inventory_items WHERE blank_type=$1 AND color=$2 AND size=$3',
        [blank_type, color, size])).rows[0];
    await tx.query('UPDATE inventory_items SET qty = qty + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [delta, item.id]);
    const m = await tx.query(
        `INSERT INTO inventory_movements (item_id, delta, reason, note, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`, [item.id, delta, reason, note || null, user || null]);
    return m.rows[0].id;
}

/** What is on the RTO shelf right now, one row per design + variant. */
async function rtoAvailable() {
    const r = await db.query(
        `SELECT variant_id, shopify_product_id, product_title, variant, color, size, blank_type,
                SUM(qty - qty_used - qty_written_off)::int AS available,
                MIN(created_at) AS oldest
           FROM inventory_rto
          GROUP BY variant_id, shopify_product_id, product_title, variant, color, size, blank_type
         HAVING SUM(qty - qty_used - qty_written_off) > 0
          ORDER BY product_title, variant`);
    return r.rows;
}

/** Index of what is available, keyed both ways so a line item matches however it is identified. */
function availabilityIndex(rows) {
    const byVariant = new Map();
    const byText = new Map();
    for (const r of rows) {
        if (r.variant_id) byVariant.set(String(r.variant_id), r);
        if (r.shopify_product_id) byText.set(`${r.shopify_product_id}|${normVariant(r.variant)}`, r);
    }
    return { byVariant, byText };
}

/** The shelf entry that could serve this order line, or null. */
function matchLine(item, index) {
    if (item.shopify_variant_id && index.byVariant.has(String(item.shopify_variant_id))) {
        return index.byVariant.get(String(item.shopify_variant_id));
    }
    return index.byText.get(`${item.shopify_product_id}|${normVariant(item.variant)}`) || null;
}

/** Lines of one order that are sitting on the RTO shelf. Takes an order row. */
function matchesForOrder(order, index) {
    const out = [];
    for (const it of safeItems(order)) {
        const hit = matchLine(it, index);
        if (!hit) continue;
        out.push({
            product_title: it.title, variant: it.variant, qty: parseInt(it.quantity, 10) || 0,
            available: hit.available, variant_id: hit.variant_id,
            color: hit.color, size: hit.size, blank_type: hit.blank_type,
        });
    }
    return out;
}

/** Statuses that still expect a garment to go out. Shopify writes them upper case. */
const OPEN_ORDER_SQL = `
    UPPER(COALESCE(fulfillment_status,'')) NOT IN ('FULFILLED','RESTOCKED')
    AND UPPER(COALESCE(financial_status,'')) NOT IN ('VOIDED','REFUNDED')`;

/**
 * Open orders that could be served from the shelf instead of a fresh print.
 * `available` is what the shelf holds, not a reservation — two orders wanting the same design
 * both see it, because deciding which one gets it is a human's call.
 */
async function rtoMatches() {
    const rows = await rtoAvailable();
    if (!rows.length) return [];
    const index = availabilityIndex(rows);
    const orders = await db.query(
        `SELECT shopify_id, order_number, created_at, line_items_json
           FROM orders WHERE ${OPEN_ORDER_SQL} ORDER BY created_at DESC LIMIT 500`);
    const out = [];
    for (const o of orders.rows) {
        for (const m of matchesForOrder(o, index)) {
            out.push({ order_number: o.order_number, shopify_id: o.shopify_id, created_at: o.created_at, ...m });
        }
    }
    return out;
}

/** Just the number, for the badges. Distinct orders, because that is what a person acts on. */
async function rtoAlertCount() {
    const matches = await rtoMatches();
    return new Set(matches.map(m => m.order_number)).size;
}

/** Shelf matches for a single order number — the scan-screen prompt. */
async function rtoForOrderNumber(orderNumber) {
    const rows = await rtoAvailable();
    if (!rows.length) return [];
    const alt = String(orderNumber).startsWith('#') ? String(orderNumber).slice(1) : `#${orderNumber}`;
    const o = (await db.query(
        'SELECT shopify_id, order_number, line_items_json FROM orders WHERE order_number IN ($1,$2) LIMIT 1',
        [String(orderNumber), alt])).rows[0];
    if (!o) return [];
    return matchesForOrder(o, availabilityIndex(rows));
}

module.exports = {
    BLANK_TYPES, SIZE_ORDER, TYPE_TO_BLANK, SKU_TO_BLANK,
    refreshProductCache, productIndex, blankTypeFor, splitVariant, safeItems,
    deductionsFor, holdState, applyOrder, applyOrders, applySince, setStock,
    marketingHoldState, applyMarketingOrder, releaseMarketingOrder, applyMarketingSince,
    normVariant, moveBlank, rtoAvailable, rtoMatches, rtoAlertCount, rtoForOrderNumber,
    availabilityIndex, matchesForOrder, OPEN_ORDER_SQL,
};
