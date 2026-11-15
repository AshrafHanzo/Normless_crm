/**
 * Goods in against vendor orders: what each delivery brought, and what is still to come.
 *
 * An order's lines are matched by product, colour and size (a quantity-only line has neither
 * colour nor size). For each:  accepted = received − rejected,  pending = ordered − accepted.
 * Rejected pieces are still owed — a reprint, or a deduction agreed with the vendor.
 *
 * Status follows the deliveries while the order is in the ordering stages: some in → Partly
 * Received, everything in → Consignment Received, nothing in → back to Consignment Ordered.
 * It can still be set by hand.
 */

const db = require('../db/connection');

const keyOf = (product, color, size) => [product, color, size].map(v => String(v || '').trim().toLowerCase()).join('|');
const posInt = (v) => { const n = parseInt(v, 10); return n > 0 ? n : 0; };
const ORDERING = ['Pending', 'Consignment Ordered', 'Partly Received', 'Consignment Received'];

/** The order's lines, one per product (+ colour + size), with how many were ordered. */
function orderLines(items) {
    const out = [];
    for (const item of items || []) {
        if (item.kind === 'simple') {
            out.push({ key: keyOf(item.product_type), product: item.product_type, color: null, size: null, ordered: posInt(item.qty) });
            continue;
        }
        for (const c of item.colors || []) {
            for (const [size, qty] of Object.entries(c.sizes || {})) {
                if (posInt(qty)) out.push({ key: keyOf(item.product_type, c.color, size), product: item.product_type, color: c.color || null, size, ordered: posInt(qty) });
            }
        }
    }
    return out;
}

/**
 * Received vs pending for each line, from the order's items and its receipts. Anything received
 * that no longer matches a line (the order was edited after) is listed with ordered 0.
 */
function progress(items, receipts) {
    const lines = orderLines(items).map(l => ({ ...l, received: 0, rejected: 0 }));
    const byKey = new Map(lines.map(l => [l.key, l]));
    for (const r of receipts || []) {
        for (const x of r.lines || []) {
            const key = keyOf(x.product, x.color, x.size);
            if (!byKey.has(key)) {
                const extra = { key, product: x.product, color: x.color || null, size: x.size || null, ordered: 0, received: 0, rejected: 0, unmatched: true };
                byKey.set(key, extra); lines.push(extra);
            }
            const l = byKey.get(key);
            l.received += posInt(x.received);
            l.rejected += posInt(x.rejected);
        }
    }
    for (const l of lines) {
        l.accepted = l.received - l.rejected;
        l.pending = Math.max(l.ordered - l.accepted, 0);
        l.extra = Math.max(l.accepted - l.ordered, 0);
    }
    const sum = (k) => lines.reduce((s, l) => s + l[k], 0);
    return {
        lines,
        totals: { ordered: sum('ordered'), received: sum('received'), rejected: sum('rejected'), accepted: sum('accepted'), pending: sum('pending') },
    };
}

/**
 * Check a delivery's lines against the order. Only the order's own lines can be received.
 * Returns { error } or { lines, received, rejected }.
 */
function cleanLines(input, items) {
    const known = new Map(orderLines(items).map(l => [l.key, l]));
    const lines = [];
    for (const x of Array.isArray(input) ? input : []) {
        const received = posInt(x.received), rejected = posInt(x.rejected);
        if (!received && !rejected) continue;
        const line = known.get(keyOf(x.product, x.color, x.size));
        if (!line) return { error: `${[x.product, x.color, x.size].filter(Boolean).join(' · ')} isn’t on this order` };
        if (rejected > received) return { error: `More rejected than received for ${[line.product, line.color, line.size].filter(Boolean).join(' · ')}` };
        lines.push({ product: line.product, color: line.color, size: line.size, received, rejected });
    }
    if (!lines.length) return { error: 'Enter how many pieces came in' };
    return { lines, received: lines.reduce((s, l) => s + l.received, 0), rejected: lines.reduce((s, l) => s + l.rejected, 0) };
}

/** Bring the order's received/rejected sums and (in the ordering stages) its status up to date. */
async function refresh(orderId, c = db) {
    const o = (await c.query('SELECT id, status, items FROM vendor_orders WHERE id = $1', [orderId])).rows[0];
    if (!o) return;
    const receipts = (await c.query('SELECT lines FROM vendor_receipts WHERE order_id = $1', [orderId])).rows
        .map(r => ({ lines: JSON.parse(r.lines || '[]') }));
    let items = [];
    try { items = JSON.parse(o.items || '[]'); } catch { /* old row */ }
    const { totals } = progress(items, receipts);
    let status = o.status;
    if (ORDERING.includes(o.status) && o.status !== 'Pending') {
        status = !receipts.length ? 'Consignment Ordered'
            : totals.pending === 0 && totals.ordered > 0 ? 'Consignment Received' : 'Partly Received';
    } else if (o.status === 'Pending' && receipts.length) {
        status = totals.pending === 0 && totals.ordered > 0 ? 'Consignment Received' : 'Partly Received';
    }
    await c.query('UPDATE vendor_orders SET received_qty = $1, rejected_qty = $2, status = $3 WHERE id = $4',
        [totals.received, totals.rejected, status, orderId]);
}

module.exports = { orderLines, progress, cleanLines, refresh, keyOf };
