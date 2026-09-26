/**
 * The production pick list: what has been ordered and not yet sent.
 *
 * Grouped by design, colour and size rather than listed per order, because that is the shape the
 * work actually takes — twelve orders for the same tee in Black / L is one print run of twelve,
 * not twelve jobs. The orders each group came from are carried along so a piece can still be
 * traced back to the customer waiting for it.
 *
 * Only orders that are genuinely waiting to go out: anything fulfilled, cancelled, refunded,
 * voided or ON HOLD is left out. A held order is one somebody deliberately stopped, and printing
 * for it is the mistake this list exists to prevent.
 */

const db = require('../db/connection');
const inv = require('./inventory');

// The blank names the warehouse uses, in the words the floor uses for them.
const TYPE_LABEL = {
    'Oversized Tee': 'Oversized',
    Hoodie: 'Hoodie',
    'Track Pant': 'Joggers',
    Tank: 'Tanks',
    Accessories: 'Accessories',
};

// Sizes read in wearing order, not alphabetically — 2XL after XL, never between 2 and L.
const SIZE_RANK = (s) => {
    const i = inv.SIZE_ORDER.findIndex(x => x.toUpperCase() === String(s || '').toUpperCase());
    return i === -1 ? 99 : i;
};

/**
 * Orders still waiting to go out, in [from, to] by creation date (IST) when given.
 *
 * `created_at` is a naive timestamp holding the IST wall clock Shopify reports, so its date part
 * is already the day the shop means.
 */
async function openOrders(from, to) {
    const where = [
        `UPPER(COALESCE(fulfillment_status,'')) NOT IN ('FULFILLED','RESTOCKED')`,
        `UPPER(COALESCE(financial_status,'')) NOT IN ('VOIDED','REFUNDED')`,
        'cancelled_at IS NULL',
        'COALESCE(on_hold, false) = false',
    ];
    const vals = [];
    if (from) { vals.push(from); where.push(`created_at::date >= $${vals.length}`); }
    if (to) { vals.push(to); where.push(`created_at::date <= $${vals.length}`); }

    const r = await db.query(
        `SELECT order_number, line_items_json, TO_CHAR(created_at,'YYYY-MM-DD') AS date
           FROM orders WHERE ${where.join(' AND ')}
          ORDER BY created_at`, vals);
    return r.rows;
}

/**
 * One row per design + colour + size, with the quantity to make and who it is for.
 *
 * A line whose product is not in the cache still appears — with an unknown type — because a
 * garment missing from the list is a garment nobody prints.
 */
async function build({ from, to } = {}) {
    const orders = await openOrders(from, to);
    const index = await inv.productIndex();

    const groups = new Map();
    for (const order of orders) {
        for (const item of inv.safeItems(order)) {
            const qty = parseInt(item.quantity, 10) || 0;
            if (qty <= 0) continue;
            const product = index.get(String(item.shopify_product_id));
            const parts = inv.splitVariant(item.variant);
            const type = TYPE_LABEL[inv.blankTypeFor(product)] || 'Other';
            const edition = item.title || '—';
            const color = parts?.color || (item.variant || '').trim() || '—';
            const size = parts?.size || 'One size';

            const key = `${type}|${edition}|${color}|${size}`;
            const g = groups.get(key) || { type, edition, color, size, qty: 0, orders: [] };
            g.qty += qty;
            if (!g.orders.includes(order.order_number)) g.orders.push(order.order_number);
            groups.set(key, g);
        }
    }

    // Read down the page the way the floor works: a garment type at a time, then the design, then
    // its colours, then sizes in wearing order.
    const rows = [...groups.values()].sort((a, b) =>
        a.type.localeCompare(b.type)
        || a.edition.localeCompare(b.edition)
        || a.color.localeCompare(b.color)
        || SIZE_RANK(a.size) - SIZE_RANK(b.size));

    return {
        rows,
        summary: {
            orders: orders.length,
            units: rows.reduce((n, r) => n + r.qty, 0),
            lines: rows.length,
            editions: new Set(rows.map(r => `${r.type}|${r.edition}`)).size,
        },
        period: { from: from || null, to: to || null },
    };
}

const COLUMNS = ['Product type', 'Edition', 'Colour', 'Size', 'Qty', 'Orders'];
const toRow = (r) => [r.type, r.edition, r.color, r.size, r.qty, r.orders.join(' ')];

module.exports = { build, COLUMNS, toRow, TYPE_LABEL, SIZE_RANK };
