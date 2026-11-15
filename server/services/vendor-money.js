/**
 * The money rules for vendor orders, in one place.
 *
 *   total  = the agreed total (total_override) if one was entered, else rate × quantity
 *   paid   = the sum of the payments allocated to the order (kept in vendor_orders.paid_amount)
 *   status = Not Paid · Part Paid · Paid · Overpaid — worked out, never typed, once there is a total
 *
 * An order with no total (most of Crewfit's history: quantities only, no rates) can't be worked
 * out, so its Paid / Not Paid stays the hand-set flag it has always been.
 */

const db = require('../db/connection');

const TOTAL_SQL = 'COALESCE(o.total_override, o.total_amount)';
const PAID_STATUSES = ['Not Paid', 'Part Paid', 'Paid', 'Overpaid'];
const MANUAL_STATUSES = ['Not Paid', 'Paid'];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Status for an order that has a total. */
function statusFor(total, paid) {
    const t = round2(total), p = round2(paid);
    if (p <= 0) return 'Not Paid';
    if (p < t) return 'Part Paid';
    if (p === t) return 'Paid';
    return 'Overpaid';
}

/**
 * Bring paid_amount and payment_status up to date for these orders, from their allocations.
 * Pass a transaction client to run inside one.
 */
async function recompute(orderIds, c = db) {
    const ids = [...new Set((orderIds || []).map(Number).filter(Boolean))];
    if (!ids.length) return;
    const rows = (await c.query(
        `SELECT o.id, ${TOTAL_SQL} AS total, o.payment_status,
                COALESCE((SELECT SUM(a.amount) FROM vendor_payment_allocations a WHERE a.order_id = o.id), 0) AS paid
         FROM vendor_orders o WHERE o.id = ANY($1::int[])`, [ids])).rows;
    for (const r of rows) {
        const total = Number(r.total) || 0;
        const status = total > 0 ? statusFor(total, r.paid) : r.payment_status;
        await c.query('UPDATE vendor_orders SET paid_amount = $1, payment_status = $2 WHERE id = $3',
            [round2(r.paid), status, r.id]);
    }
}

/** What a vendor is owed, in one row: billed, paid, balance and unallocated credit. */
async function vendorMoney(vendorId, c = db) {
    const r = (await c.query(
        `SELECT
            COALESCE((SELECT SUM(${TOTAL_SQL}) FROM vendor_orders o WHERE o.vendor_id = $1 AND ${TOTAL_SQL} > 0), 0) AS billed,
            COALESCE((SELECT SUM(GREATEST(${TOTAL_SQL} - o.paid_amount, 0)) FROM vendor_orders o
                      WHERE o.vendor_id = $1 AND ${TOTAL_SQL} > 0), 0) AS due,
            COALESCE((SELECT SUM(amount) FROM vendor_payments WHERE vendor_id = $1), 0) AS paid,
            COALESCE((SELECT SUM(a.amount) FROM vendor_payment_allocations a
                      JOIN vendor_payments p ON p.id = a.payment_id WHERE p.vendor_id = $1), 0) AS allocated`,
        [vendorId])).rows[0];
    const onAccount = round2(Number(r.paid) - Number(r.allocated));
    return {
        billed: round2(r.billed),
        paid: round2(r.paid),
        on_account: onAccount,
        // What is still owed on priced orders, less any credit not yet put against one.
        balance: round2(Number(r.due) - onAccount),
    };
}

module.exports = { TOTAL_SQL, PAID_STATUSES, MANUAL_STATUSES, statusFor, recompute, vendorMoney, round2 };
