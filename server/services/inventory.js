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
                `INSERT INTO shopify_variants (variant_id, shopify_product_id, variant, color, size, price, updated_at)
                 VALUES ($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP)
                 ON CONFLICT (variant_id) DO UPDATE SET
                   shopify_product_id = excluded.shopify_product_id, variant = excluded.variant,
                   color = excluded.color, size = excluded.size, price = excluded.price,
                   updated_at = CURRENT_TIMESTAMP`,
                [v.id, p.id, v.title, parts?.color || null, parts?.size || null,
                    v.price != null ? Number(v.price) : null]);
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
async function applyOrder(tx, order, index, state = holdState(order), resolved = null) {
    // Crewfit resolves its own lines — it has no Shopify product behind them — so the resolution
    // can be handed in. Everything below is the part that must not be written twice.
    const { wanted, unmapped } = resolved || deductionsFor(order, index);
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
 * Crewfit bulk orders
 *
 * Crewfit prints its oversized tees on the Normless blank — same shelf, same pool — so a bulk run
 * has to come off the count like any other. Nothing else it sells does: polos, kids' wear and the
 * rest are bought in per order and never touch this stock.
 *
 * Deducted when production starts, not when the order is raised. A bulk order sits for weeks
 * between the two, and the count is meant to say what is on the shelf — deducting at creation
 * would report blanks as gone while they are still sitting there, for an order that may never be
 * paid for.
 * ---------------------------------------------------------------------------------------- */

// Only this one. Matched loosely because the sheet has written it several ways over time.
const CREWFIT_BLANKS = [{ match: /oversize/i, blank: 'Oversized Tee' }];

// The pipeline in order. Blanks are held from the point the garments are actually pulled.
const CREWFIT_PIPELINE = ['Awaiting Payment', 'Pending', 'Consignment Ordered', 'Consignment Received',
    'Ongoing Production', 'Ready for Dispatch', 'Dispatch Pending', 'Dispatched'];
const CREWFIT_PRODUCTION_FROM = CREWFIT_PIPELINE.indexOf('Ongoing Production');

/** Crewfit writes XXL where the blank grid says 2XL. Same garment, two spellings. */
const SIZE_ALIASES = { XXL: '2XL', XXXL: '3XL', XXXXL: '4XL', '2XL': '2XL', '3XL': '3XL' };
const normSize = (raw) => {
    const s = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
    return SIZE_ALIASES[s] || s;
};

/** "Oversized T-Shirts: S-5, M-4, XXL-2" or "S-5, M-4" → [{ size, qty }]. */
function parseSizeBreakdown(text) {
    const raw = String(text || '');
    // A leading "Product name:" is dropped — the line already knows its own product.
    const body = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
    const out = [];
    for (const part of body.split(',')) {
        const m = part.trim().match(/^([A-Za-z0-9]+)\s*[-:x]\s*(\d+)$/i);
        if (!m) continue;
        const qty = parseInt(m[2], 10);
        if (qty > 0) out.push({ size: normSize(m[1]), qty });
    }
    return out;
}

/** The blank a Crewfit product line is printed on, or null when Crewfit buys it in. */
function crewfitBlankFor(product) {
    const name = String(product || '');
    return CREWFIT_BLANKS.find(b => b.match.test(name))?.blank || null;
}

/** Blank stock is held from the moment the garments are pulled for printing. */
function crewfitHoldState(order) {
    const status = order.status || '';
    if (status === 'Cancelled') {
        // Cancelled after it shipped: the blanks were printed on and are gone, so the count stays
        // down and someone is asked about it rather than stock reappearing that does not exist.
        if (order.dispatch_date) {
            return { hold: true, needs_review: true,
                review_reason: 'Crewfit order cancelled after it was dispatched — the printed garments cannot return to blank stock. Adjust by hand if they did come back.' };
        }
        return { hold: false };
    }
    const i = CREWFIT_PIPELINE.indexOf(status);
    return { hold: i >= 0 && i >= CREWFIT_PRODUCTION_FROM };
}

/**
 * What a Crewfit order should draw from blank stock, pooled by colour and size.
 *
 * Pooled rather than kept per line because that is how the shelf works: two lines of Black / L on
 * one order are four garments off one pile, and must not become two movements fighting over it.
 *
 * A colour Normless does not stock is reported rather than deducted. Crewfit runs colours the
 * shop never carries, and inventing a "Oversized Tee / Royal Blue" row to push negative would
 * describe a shelf that does not exist.
 */
async function crewfitDeductions(order) {
    // line_items is the per-line truth on newer orders; the flat columns are all the sheet-era
    // ones have, and they describe a single line.
    const parsed = (() => {
        if (Array.isArray(order.line_items)) return order.line_items;
        try { const v = JSON.parse(order.line_items || 'null'); return Array.isArray(v) && v.length ? v : null; } catch { return null; }
    })();
    const lines = parsed || [{ product: order.product, color: order.color, size_breakdown: order.size_breakdown }];

    const known = new Set((await db.query(
        `SELECT color, size FROM inventory_catalog WHERE blank_type = 'Oversized Tee'
         UNION SELECT color, size FROM inventory_items WHERE blank_type = 'Oversized Tee'`))
        .rows.map(r => `${r.color.toLowerCase()}|${r.size.toUpperCase()}`));

    const wanted = new Map();
    const unmapped = new Map();
    for (const li of (Array.isArray(lines) ? lines : [])) {
        const blank = crewfitBlankFor(li.product);
        if (!blank) continue;                       // bought in — not this shelf, and not a problem
        const color = String(li.color || '').trim();
        const sizes = parseSizeBreakdown(li.size_breakdown);
        if (!sizes.length) continue;

        for (const { size, qty } of sizes) {
            const ref = `${order.id}:${color}/${size}`;
            if (!color || !known.has(`${color.toLowerCase()}|${size}`)) {
                const prev = unmapped.get(ref);
                unmapped.set(ref, {
                    ref, order_number: `CF-${order.sl_no}`, title: li.product, variant: `${color || '—'} / ${size}`,
                    product_type: 'Crewfit', qty: (prev?.qty || 0) + qty,
                    reason: color ? `Normless does not stock Oversized Tee in ${color} / ${size}, so nothing was deducted`
                        : 'This line has no colour, so it cannot be matched to a blank',
                });
                continue;
            }
            const prev = wanted.get(ref);
            wanted.set(ref, { blank_type: blank, color, size, qty: (prev?.qty || 0) + qty, title: li.product });
        }
    }
    return { wanted, unmapped };
}

/** Apply one Crewfit order to blank stock. A no-op for orders that never reach production. */
async function applyCrewfitOrder(order) {
    const state = crewfitHoldState(order);
    const ref = `crewfit:${order.id}`;
    const already = await db.query('SELECT 1 FROM inventory_movements WHERE source_ref LIKE $1 LIMIT 1', [`${ref}:%`]);
    const { wanted, unmapped } = await crewfitDeductions(order);
    if (!state.hold && !already.rows.length) return { changed: 0, deducted: [], unmapped: [] };

    // deductionsFor keys its refs on the order id; prefix them so they live in this order's space.
    const prefixed = new Map([...wanted].map(([k, v]) => [`crewfit:${k}`, v]));
    const prefixedUnmapped = new Map([...unmapped].map(([k, v]) => [`crewfit:${k}`, { ...v, ref: `crewfit:${k}` }]));
    const pseudo = { shopify_id: ref, order_number: `CF-${order.sl_no}` };

    let changed = 0;
    await db.transaction(async (tx) => {
        changed = await applyOrder(tx, pseudo, null, state, { wanted: prefixed, unmapped: prefixedUnmapped });
    });
    return {
        changed,
        deducted: state.hold ? [...wanted.values()].map(w => ({ blank_type: w.blank_type, color: w.color, size: w.size, qty: w.qty })) : [],
        released: !state.hold,
        needs_review: !!state.needs_review,
        unmapped: [...unmapped.values()].map(u => ({ product: u.title, variant: u.variant, qty: u.qty, reason: u.reason })),
    };
}

/** Forget a Crewfit order's movements, giving back anything still held. Used on delete. */
async function releaseCrewfitOrder(orderId) {
    const ref = `crewfit:${orderId}`;
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

/** Every Crewfit order dated on or after `since`. The catch-up for orders that predate this. */
async function applyCrewfitSince(since) {
    const r = await db.query(
        `SELECT id, sl_no, status, product, color, size_breakdown, line_items, dispatch_date
           FROM crewfit_orders WHERE COALESCE(dispatch_date, order_date) >= $1 ORDER BY id ASC`, [since]);
    let changed = 0;
    for (const o of r.rows) changed += (await applyCrewfitOrder(o)).changed;
    return { orders: r.rows.length, changed };
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
 * Shoot samples and offline sales
 *
 * Both draw on the same shelf as everything else, and both go through the same movement engine, so
 * the only thing either has to decide is when a garment counts as printed.
 * ---------------------------------------------------------------------------------------- */

/** Marketing's item shape → the line-item shape the blank resolver reads. */
function sampleLines(row) {
    const items = typeof row.items === 'string' ? (() => { try { return JSON.parse(row.items || '[]'); } catch { return []; } })() : (row.items || []);
    return items.map(it => ({
        title: it.product, quantity: it.qty, variant: it.variant,
        shopify_product_id: it.shopify_product_id, shopify_variant_id: it.shopify_variant_id,
    }));
}

/**
 * A shoot sample holds its blank from the moment it is printed.
 *
 * Not when the request is raised — most are approved days later and some never are — and never at
 * all if it was filled from the RTO shelf, since in that case nothing is made.
 */
function sampleHoldState(row) {
    if (row.from_rto) return { hold: false };
    return { hold: ['In Production', 'With Marketing', 'Returned'].includes(row.status || '') };
}

const sampleRef = (id) => `sample:${id}`;

/** Apply one sample request to blank stock. A no-op for requests that never reach production. */
async function applySampleRequest(row) {
    const state = sampleHoldState(row);
    const ref = sampleRef(row.id);
    const already = await db.query('SELECT 1 FROM inventory_movements WHERE source_ref LIKE $1 LIMIT 1', [`${ref}:%`]);
    if (!state.hold && !already.rows.length) return { changed: 0, deducted: [], unmapped: [] };

    const index = await productIndex();
    const pseudo = {
        shopify_id: ref,
        order_number: row.ref_no ? `SH${String(row.ref_no).padStart(3, '0')}` : `SH#${row.id}`,
        line_items_json: JSON.stringify(sampleLines(row)),
    };
    const { wanted, unmapped } = deductionsFor(pseudo, index);
    let changed = 0;
    await db.transaction(async (tx) => { changed = await applyOrder(tx, pseudo, index, state); });
    return {
        changed,
        deducted: state.hold ? [...wanted.values()].map(w => ({ blank_type: w.blank_type, color: w.color, size: w.size, qty: w.qty })) : [],
        released: !state.hold,
        unmapped: [...unmapped.values()].map(u => ({ product: u.title, variant: u.variant, reason: u.reason })),
    };
}

/** Forget a request's movements, giving back anything still held. Used on delete. */
async function releaseSampleRequest(id) {
    const ref = sampleRef(id);
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

/**
 * Take pieces off the RTO shelf for something that never printed them.
 *
 * Unlike sending one to a Shopify order, there is no blank to credit: nothing was ever deducted,
 * because nothing was made. The garment simply leaves the shelf. The note says what took it, so
 * the shelf's own history still reads as a sentence.
 */
async function takeRtoPiece(rtoId, qty, ref, note, user) {
    const n = parseInt(qty, 10) || 1;
    return db.transaction(async (tx) => {
        const row = (await tx.query('SELECT * FROM inventory_rto WHERE id = $1 FOR UPDATE', [rtoId])).rows[0];
        if (!row) return { error: 'That shelf entry no longer exists', status: 404 };
        const available = row.qty - row.qty_used - row.qty_written_off;
        if (n > available) return { error: `Only ${available} left on the shelf`, status: 400 };

        await tx.query('UPDATE inventory_rto SET qty_used = qty_used + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [n, row.id]);
        await tx.query(
            `INSERT INTO inventory_rto_events (rto_id, kind, qty, order_number, note, created_by)
             VALUES ($1,'used',$2,$3,$4,$5)`,
            [row.id, n, ref, note, user || null]);
        return { rto_id: row.id, product_title: row.product_title, variant: row.variant, qty: n };
    });
}

/** A shoot borrows the piece and brings it back; the shelf gets it again on return. */
const takeRtoForSample = (rtoId, qty, ref, user) =>
    takeRtoPiece(rtoId, qty, ref, 'Lent for a shoot — no blank was spent', user);

/**
 * Put back everything a given reference took off the shelf.
 *
 * Only used when the thing that took them is being undone entirely — a deleted sale — so the
 * pieces genuinely never left. The events are removed rather than reversed, because a shelf
 * history reading "used, then un-used" describes a mistake in this app rather than a garment.
 */
async function giveBackRtoForRef(ref) {
    if (!ref) return 0;
    return db.transaction(async (tx) => {
        const rows = (await tx.query(
            `SELECT id, rto_id, qty FROM inventory_rto_events WHERE kind = 'used' AND order_number = $1`, [ref])).rows;
        for (const e of rows) {
            await tx.query(
                'UPDATE inventory_rto SET qty_used = GREATEST(qty_used - $1, 0), updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                [e.qty, e.rto_id]);
            await tx.query('DELETE FROM inventory_rto_events WHERE id = $1', [e.id]);
        }
        return rows.length;
    });
}

/**
 * A returned sample goes onto the RTO shelf.
 *
 * It is a finished garment that has been worn for photographs and can still be sold, which is what
 * the shelf holds. No blank moves: the one spent printing it is still spent.
 */
async function shelveSampleReturn(row, user) {
    const items = typeof row.items === 'string' ? (() => { try { return JSON.parse(row.items || '[]'); } catch { return []; } })() : (row.items || []);
    const ref = row.ref_no ? `SH${String(row.ref_no).padStart(3, '0')}` : `SH#${row.id}`;
    const added = [];
    for (const it of items) {
        const qty = parseInt(it.qty, 10) || 0;
        if (qty <= 0 || !it.product) continue;
        const parts = splitVariant(it.variant);
        const r = await db.query(
            `INSERT INTO inventory_rto (shopify_product_id, variant_id, product_title, variant, color, size,
                                        blank_type, qty, source_order_number, source_ref, reason, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Back from a shoot',$11)
             ON CONFLICT (source_ref) WHERE source_ref IS NOT NULL DO NOTHING RETURNING id`,
            [it.shopify_product_id || null, it.shopify_variant_id || null, it.product, it.variant || null,
                it.color || parts?.color || null, it.size || parts?.size || null, it.blank_type || null,
                qty, ref, `${sampleRef(row.id)}:${it.shopify_variant_id || it.product}`, user || null]);
        if (!r.rows[0]) continue;
        await db.query(
            `INSERT INTO inventory_rto_events (rto_id, kind, qty, order_number, note, created_by)
             VALUES ($1,'in',$2,$3,'Returned from a shoot',$4)`, [r.rows[0].id, qty, ref, user || null]);
        added.push({ product: it.product, variant: it.variant, qty });
    }
    return { added };
}

/**
 * An offline sale holds its blanks from the moment it stops being a draft.
 *
 * Unlike a bulk run there is no production stage to wait for — the garment is spoken for the
 * instant the sale is real, and most are handed over the same day. A cancelled sale gives them
 * back unless it had already been dispatched, in which case the garment has gone.
 */
function offlineHoldState(row) {
    const status = row.status || 'Draft';
    if (status === 'Cancelled') {
        if (row.dispatch_date || row.awb) {
            return { hold: true, needs_review: true,
                review_reason: 'Offline sale cancelled after it was dispatched — the garment has gone. Adjust by hand if it came back.' };
        }
        return { hold: false };
    }
    return { hold: status !== 'Draft' };
}

const offlineRef = (id) => `offline:${id}`;

/**
 * Marketing and offline sales share an item shape; both read as line items the same way.
 *
 * Anything taken off the RTO shelf is subtracted here rather than deducted and credited back: the
 * piece was already printed, so its blank was spent long ago and must not be spent twice. A line
 * filled entirely from the shelf drops out, because there is nothing left of it to make.
 */
function offlineLines(row) {
    const items = typeof row.items === 'string' ? (() => { try { return JSON.parse(row.items || '[]'); } catch { return []; } })() : (row.items || []);
    return items
        .map(it => ({
            title: it.product, quantity: (parseInt(it.qty, 10) || 0) - (parseInt(it.rto_qty, 10) || 0),
            variant: it.variant,
            shopify_product_id: it.shopify_product_id, shopify_variant_id: it.shopify_variant_id,
        }))
        .filter(it => it.quantity > 0);
}

async function applyOfflineSale(row) {
    const state = offlineHoldState(row);
    const ref = offlineRef(row.id);
    const already = await db.query('SELECT 1 FROM inventory_movements WHERE source_ref LIKE $1 LIMIT 1', [`${ref}:%`]);
    if (!state.hold && !already.rows.length) return { changed: 0, deducted: [], unmapped: [] };

    const index = await productIndex();
    const pseudo = {
        shopify_id: ref,
        order_number: row.sale_no ? `OS${String(row.sale_no).padStart(4, '0')}` : `OS#${row.id}`,
        line_items_json: JSON.stringify(offlineLines(row)),
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

/** Forget a sale's movements, giving back anything still held. Used on delete. */
async function releaseOfflineSale(id, saleRef) {
    const ref = offlineRef(id);
    // Pieces it took off the shelf are part of "anything still held" — the sale is going away,
    // so the garments are back to being unsold stock.
    await giveBackRtoForRef(saleRef);
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

/**
 * Orders still worth offering a shelf piece to.
 *
 * Not simply "unfulfilled". An order is marked fulfilled when it is handed over for delivery, and
 * printing happens around that same moment — so an order that has just flipped to fulfilled may
 * still be waiting to be printed. Dropping it from the match right then removes the prompt exactly
 * when it can still save a garment. Recent orders therefore stay in scope either way.
 *
 * Refunded and voided orders are excluded regardless: nothing is going out for those.
 */
const RTO_MATCH_DAYS = 3;
const OPEN_ORDER_SQL = `
    (UPPER(COALESCE(fulfillment_status,'')) NOT IN ('FULFILLED','RESTOCKED')
     OR created_at > NOW() - INTERVAL '${RTO_MATCH_DAYS} days')
    AND UPPER(COALESCE(financial_status,'')) NOT IN ('VOIDED','REFUNDED')
    AND cancelled_at IS NULL AND COALESCE(on_hold, false) = false`;

/** Whether an order has already been marked fulfilled — a match on one reads differently. */
const isFulfilled = (o) => ['FULFILLED', 'RESTOCKED'].includes(String(o.fulfillment_status || '').toUpperCase());

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
        `SELECT shopify_id, order_number, created_at, fulfillment_status, line_items_json
           FROM orders WHERE ${OPEN_ORDER_SQL} ORDER BY created_at DESC LIMIT 500`);
    const out = [];
    for (const o of orders.rows) {
        for (const m of matchesForOrder(o, index)) {
            out.push({
                order_number: o.order_number, shopify_id: o.shopify_id, created_at: o.created_at,
                source: 'shop',
                // Flagged rather than filtered: a fulfilled order may still be waiting to print,
                // and the two cases read differently to whoever acts on them.
                fulfilled: isFulfilled(o), ...m,
            });
        }
    }
    // Seeding orders draw on the same designs, so a returned piece serves them just as well.
    out.push(...await seedingRtoMatches(index));
    return out;
}

/**
 * Seeding orders that could be served from the shelf.
 *
 * They print on the same designs the shop sells, so a creator's parcel can just as well be filled
 * from a returned piece. Only orders that have not gone out yet: once a seeding order is dispatched
 * the garment has left, and unlike a shop order there is no gap between marking it and sending it.
 */
const SEEDING_OPEN = ['Pending Approval', 'Dispatch Pending'];

async function seedingRtoMatches(index) {
    const rows = (await db.query(
        `SELECT id, ref_no, name, status, items, order_date FROM marketing_orders
          WHERE status = ANY($1) ORDER BY order_date DESC LIMIT 200`, [SEEDING_OPEN])).rows;
    const out = [];
    for (const o of rows) {
        const pseudo = { line_items_json: JSON.stringify(marketingLines(o)) };
        for (const m of matchesForOrder(pseudo, index)) {
            out.push({
                order_number: o.ref_no ? `M${String(o.ref_no).padStart(3, '0')}` : `MK#${o.id}`,
                marketing_id: o.id, customer: o.name, created_at: o.order_date,
                source: 'seeding', status: o.status, fulfilled: false, ...m,
            });
        }
    }
    return out;
}

/* ---- Standing notices ---------------------------------------------------------------------
 * A match is turned into a row the first time it is seen, and that row stays until a person says
 * what they did with it. The live match alone was not enough: it evaporated the moment an order
 * was marked fulfilled, which here happens right before printing.
 * ------------------------------------------------------------------------------------------ */

/** One notice per order and garment. Falls back to text when the design predates the variant cache. */
const alertKey = (m) => `${m.source}:${m.order_number}:${m.variant_id || `${m.product_title}|${normVariant(m.variant)}`}`;

/**
 * Raise a notice for anything newly matched. Idempotent: an order already noticed is left exactly
 * as it is, including one a person has already answered — re-raising a resolved notice would ask
 * the same question forever.
 */
async function syncRtoAlerts() {
    const matches = await rtoMatches();
    if (!matches.length) return { raised: 0 };
    let raised = 0;
    for (const m of matches) {
        const r = await db.query(
            `INSERT INTO inventory_rto_alerts
               (source, order_ref, shopify_order_id, marketing_id, customer, order_date,
                shopify_product_id, variant_id, product_title, variant, color, size, blank_type, qty, match_key)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
             ON CONFLICT (match_key) DO NOTHING RETURNING id`,
            [m.source, m.order_number, m.shopify_id || null, m.marketing_id || null, m.customer || null,
                m.created_at || null, m.shopify_product_id || null, m.variant_id || null, m.product_title,
                m.variant || null, m.color || null, m.size || null, m.blank_type || null, m.qty || 1, alertKey(m)]);
        if (r.rows[0]) raised++;
    }
    return { raised };
}

/**
 * Notices still waiting on a decision, with what the shelf holds for each right now.
 *
 * The shelf count is looked up live rather than stored: a piece can be sent to a different order
 * between the notice being raised and someone reading it, and "1 waiting" would then be a lie.
 */
async function openRtoAlerts() {
    // An order can be cancelled or put on hold after its notice was raised, and a piece must not
    // go on being offered to something that is not shipping.
    const rows = (await db.query(
        `SELECT a.*, (o.cancelled_at IS NOT NULL) AS order_cancelled, COALESCE(o.on_hold, false) AS order_on_hold
           FROM inventory_rto_alerts a
           LEFT JOIN orders o ON a.source = 'shop' AND o.order_number = a.order_ref
          WHERE a.status = 'open' ORDER BY a.created_at DESC LIMIT 300`)).rows;
    if (!rows.length) return [];
    const index = availabilityIndex(await rtoAvailable());
    const withStock = rows.map(a => {
        const hit = (a.variant_id && index.byVariant.get(String(a.variant_id)))
            || index.byText.get(`${a.shopify_product_id}|${normVariant(a.variant)}`);
        return { ...a, available: hit ? hit.available : 0 };
    });
    // Read in the order someone would work the list: what can actually be sent first, then by
    // garment so the same design's orders sit together, then oldest order first — an order placed
    // in July has been waiting longer than one placed this morning.
    return withStock.sort((a, b) =>
        (b.available > 0) - (a.available > 0)
        || `${a.product_title}${a.variant}`.localeCompare(`${b.product_title}${b.variant}`)
        || new Date(a.order_date || a.created_at) - new Date(b.order_date || b.created_at));
}

/**
 * Every piece that has gone back out, which is not the same as every notice answered — a piece can
 * be sent straight from the shelf without a notice ever being raised for that order. The count of
 * pieces sent is the honest one, so it is what this reads.
 */
async function rtoSentLog(limit = 300) {
    return (await db.query(
        `SELECT e.id, e.qty, e.order_number, e.created_by, e.created_at,
                r.product_title, r.variant, r.blank_type, r.color, r.size
           FROM inventory_rto_events e JOIN inventory_rto r ON r.id = e.rto_id
          WHERE e.kind = 'used' ORDER BY e.created_at DESC, e.id DESC LIMIT $1`, [limit])).rows;
}

/** Answered notices — how often the shelf actually saved a garment, and how often it did not. */
async function rtoAlertHistory(limit = 100) {
    return (await db.query(
        `SELECT * FROM inventory_rto_alerts WHERE status <> 'open'
          ORDER BY resolved_at DESC NULLS LAST, id DESC LIMIT $1`, [limit])).rows;
}

/** Record what was done about a notice. */
async function resolveRtoAlert(id, { status, note, rtoId }, user) {
    const r = await db.query(
        `UPDATE inventory_rto_alerts
            SET status = $1, resolution_note = $2, rto_id = COALESCE($3, rto_id),
                resolved_by = $4, resolved_at = CURRENT_TIMESTAMP
          WHERE id = $5 AND status = 'open' RETURNING *`,
        [status, note || null, rtoId || null, user || null, id]);
    return r.rows[0] || null;
}

/**
 * Close whatever notices an order had when a piece is actually sent to it.
 *
 * Matched on the order reference alone: someone typing "#10634" into the send dialog has answered
 * every notice that order raised, whichever garment each was about.
 */
async function resolveAlertsForOrder(orderRef, rtoId, user) {
    const ref = String(orderRef || '').trim();
    if (!ref) return 0;
    const alt = ref.startsWith('#') ? ref.slice(1) : `#${ref}`;
    const r = await db.query(
        `UPDATE inventory_rto_alerts
            SET status = 'used', rto_id = COALESCE($1, rto_id), resolved_by = $2,
                resolved_at = CURRENT_TIMESTAMP, resolution_note = 'Sent from the RTO shelf'
          WHERE status = 'open' AND (order_ref = $3 OR order_ref = $4) RETURNING id`,
        [rtoId || null, user || null, ref, alt]);
    return r.rowCount;
}

/**
 * The number on the badges. Distinct orders, because that is what a person acts on — and only
 * those a piece is actually waiting for. A notice whose garment has since gone to another order
 * still needs answering, but it is not something to chase, and counting it made the badge claim
 * stock that is not there.
 */
async function rtoAlertCount() {
    const open = await openRtoAlerts();
    return new Set(open.filter(isActionable).map(a => a.order_ref)).size;
}

/** Notices left standing for a garment the shelf no longer holds. */
async function staleRtoAlertCount() {
    const open = await openRtoAlerts();
    return open.filter(a => a.available === 0).length;
}

/**
 * Open notices grouped by the garment rather than by the order.
 *
 * Four orders wanting the same shirt is one shirt and one decision, not four notices — the list
 * shows the piece, and picking who gets it happens in one place. A garment the shelf no longer
 * holds simply drops out: there is nothing to offer, so there is nothing to show. Its notices stay
 * open and the garment reappears here if another one is returned.
 */
/**
 * Whether a notice can still be acted on: a piece is on the shelf, and the order is still going
 * out. Every count on the tab runs through this — the badge, the card and the list disagreeing
 * about the same pile is what made the page impossible to trust.
 */
const isActionable = (a) => a.available > 0 && !a.order_cancelled && !a.order_on_hold;

async function rtoWaiting() {
    const open = await openRtoAlerts();
    const groups = new Map();
    for (const a of open) {
        if (!isActionable(a)) continue;
        const key = a.variant_id ? `v${a.variant_id}` : `t${a.product_title}|${normVariant(a.variant)}`;
        if (!groups.has(key)) {
            groups.set(key, {
                key, product_title: a.product_title, variant: a.variant, variant_id: a.variant_id,
                shopify_product_id: a.shopify_product_id, color: a.color, size: a.size,
                blank_type: a.blank_type, available: a.available, orders: [],
            });
        }
        groups.get(key).orders.push({
            alert_id: a.id, order_ref: a.order_ref, source: a.source,
            customer: a.customer, order_date: a.order_date, qty: a.qty,
        });
    }
    // Oldest order first within a garment, then the garment with the longest wait at the top.
    const out = [...groups.values()];
    for (const g of out) g.orders.sort((x, y) => new Date(x.order_date || 0) - new Date(y.order_date || 0));
    out.sort((a, b) => new Date(a.orders[0]?.order_date || 0) - new Date(b.orders[0]?.order_date || 0));
    return out;
}

/**
 * Answer every open notice an order raised, without a piece being sent.
 *
 * Takes an order number rather than a notice id: this is for a parcel that went out before anyone
 * looked at the shelf, where the person knows the order and not which notice it raised.
 */
async function markOrderNotUsed(orderRef, note, user) {
    const ref = String(orderRef || '').trim();
    if (!ref) return { cleared: 0 };
    const alt = ref.startsWith('#') ? ref.slice(1) : `#${ref}`;
    const r = await db.query(
        `UPDATE inventory_rto_alerts
            SET status = 'skipped', resolved_by = $1, resolved_at = CURRENT_TIMESTAMP,
                resolution_note = $2
          WHERE status = 'open' AND (order_ref = $3 OR order_ref = $4) RETURNING order_ref, product_title, variant`,
        [user || null, note || 'Shipped without checking the shelf', ref, alt]);
    return { cleared: r.rowCount, rows: r.rows };
}

/** Answer every notice whose garment is gone, in one go. */
async function clearStaleRtoAlerts(user) {
    const stale = (await openRtoAlerts()).filter(a => a.available === 0).map(a => a.id);
    if (!stale.length) return 0;
    const r = await db.query(
        `UPDATE inventory_rto_alerts
            SET status = 'skipped', resolved_by = $1, resolved_at = CURRENT_TIMESTAMP,
                resolution_note = 'Cleared — the piece was no longer on the shelf'
          WHERE id = ANY($2) AND status = 'open' RETURNING id`, [user || null, stale]);
    return r.rowCount;
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
    sampleHoldState, applySampleRequest, releaseSampleRequest, takeRtoForSample, shelveSampleReturn,
    offlineHoldState, applyOfflineSale, releaseOfflineSale, takeRtoPiece, giveBackRtoForRef,
    crewfitHoldState, crewfitBlankFor, parseSizeBreakdown, normSize, crewfitDeductions,
    applyCrewfitOrder, releaseCrewfitOrder, applyCrewfitSince,
    normVariant, moveBlank, rtoAvailable, rtoMatches, rtoAlertCount, rtoForOrderNumber, RTO_MATCH_DAYS,
    seedingRtoMatches, SEEDING_OPEN,
    syncRtoAlerts, openRtoAlerts, rtoAlertHistory, resolveRtoAlert, resolveAlertsForOrder,
    staleRtoAlertCount, clearStaleRtoAlerts, rtoWaiting, markOrderNotUsed, rtoSentLog, isActionable,
    availabilityIndex, matchLine, matchesForOrder, OPEN_ORDER_SQL,
};
