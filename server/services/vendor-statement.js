/**
 * A vendor's running ledger: each priced order raises what is owed, each payment brings it down.
 * Orders with no total are listed but move nothing. Shared by the team's Statement tab and the
 * vendor's own page, so both read the same figures.
 */

const db = require('../db/connection');
const money = require('./vendor-money');
const { refLabel } = require('./vendor-order');

const parseItems = (raw) => { try { return JSON.parse(raw || '[]'); } catch { return []; } };

async function statement(vendorId) {
    const orders = (await db.query(
        `SELECT o.id, o.ref_no, o.brand, TO_CHAR(o.order_date, 'YYYY-MM-DD') AS date, o.title, o.quote_ref, o.items,
                ${money.TOTAL_SQL} AS total, o.created_at
         FROM vendor_orders o WHERE o.vendor_id = $1`, [vendorId])).rows;
    const payments = (await db.query(
        `SELECT p.id, TO_CHAR(p.paid_on, 'YYYY-MM-DD') AS date, p.amount, p.mode, p.reference, p.source, p.created_at,
                COALESCE((SELECT string_agg('VO-' || LPAD(o.ref_no::text, 3, '0'), ', ' ORDER BY o.id)
                          FROM vendor_payment_allocations a JOIN vendor_orders o ON o.id = a.order_id
                          WHERE a.payment_id = p.id), '') AS against
         FROM vendor_payments p WHERE p.vendor_id = $1`, [vendorId])).rows;

    const entries = [
        ...orders.map(o => {
            const items = parseItems(o.items).map(i => i.product_type).filter(Boolean).join(', ');
            return {
                kind: 'order', id: o.id, date: o.date, at: o.created_at, ref: refLabel(o), brand: o.brand,
                text: [o.title || items || 'Order', o.quote_ref ? `quote ${o.quote_ref}` : null].filter(Boolean).join(' · '),
                billed: Number(o.total) > 0 ? Number(o.total) : null, paid: null,
            };
        }),
        ...payments.map(p => ({
            kind: 'payment', id: p.id, date: p.date, at: p.created_at, ref: p.reference || null, mode: p.mode,
            text: `Payment${p.mode ? ` · ${p.mode}` : ''}${p.against ? ` · for ${p.against}` : ' · on account'}`,
            billed: null, paid: Number(p.amount),
            missing_reference: p.source === 'manual' && p.mode !== 'Cash' && !String(p.reference || '').trim(),
        })),
    ].sort((a, b) => (a.date === b.date
        ? (a.kind === b.kind ? new Date(a.at) - new Date(b.at) : (a.kind === 'order' ? -1 : 1))
        : a.date.localeCompare(b.date)));

    let balance = 0;
    for (const e of entries) {
        balance = money.round2(balance + (e.billed || 0) - (e.paid || 0));
        e.balance = balance;
        delete e.at;
    }
    return { entries, balance };
}

module.exports = { statement };
