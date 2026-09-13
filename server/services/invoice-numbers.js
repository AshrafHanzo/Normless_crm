/**
 * The tax invoice series, and who draws from which.
 *
 * One GSTIN, two registers, three series — the split the auditor settled on when filing the
 * August 2026 return:
 *
 *   NL/<seq>/<fy>     Normless register. Every B2C supply: all Shopify orders, plus Crewfit
 *                     tax invoices for customers WITHOUT a GSTIN. One shared counter, so the
 *                     register reads consecutively whichever brand sold the goods.
 *   NLCF/<seq>/<fy>   Crewfit register. B2B only — the customer has a GSTIN and will claim
 *                     input credit against this exact number.
 *   PRO/<fy>/<seq>    Proformas. Not a tax document; kept on its own counter so acknowledging
 *                     an advance never consumes a tax invoice number.
 *
 * NL numbers are issued at the time of supply: the auto-sync numbers Shopify orders as they are
 * fulfilled, and a Crewfit B2C invoice is numbered the moment it is issued. Both go through
 * issueNormlessNumbers() under one advisory lock, so the two brands can neither collide nor
 * interleave out of order. Before this, Shopify numbers were only assigned when the monthly
 * register was generated, and the auditor slotted the Crewfit rows in by hand — shifting every
 * Shopify number after them.
 *
 * Same-day order follows the filed return: Crewfit invoices first, in issue order, then that
 * day's Shopify orders by order number.
 */

const NL = 'NL';
const NLCF = 'NLCF';
const PRO = 'PRO';

// Shopify orders created before this were numbered by the monthly register and are filed; an
// older order that turns up fulfilled but unnumbered is a gap to report, not one to fill quietly
// with a number from the wrong month.
const AUTO_NUMBER_FROM = '2026-09-01';

/** Indian financial year label (Apr–Mar) for a YYYY-MM-DD date, e.g. 2026-07-15 → "26-27". */
function financialYear(ymd) {
    const [y, m] = ymd.split('-').map(Number);
    const start = m >= 4 ? y : y - 1;
    return `${String(start % 100).padStart(2, '0')}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** The IST calendar date of a timestamp, as YYYY-MM-DD. */
function istDate(iso) {
    const t = new Date(iso);
    return new Date(t.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

const todayIst = () => istDate(new Date());

/** Render a number the way it is filed: NL unpadded, NLCF padded to four, PRO on the legacy layout. */
function formatNumber(series, seq, fy) {
    if (series === NL) return `${NL}/${seq}/${fy}`;
    if (series === NLCF) return `${NLCF}/${String(seq).padStart(4, '0')}/${fy}`;
    if (series === PRO) return `${PRO}/${fy}/${String(seq).padStart(4, '0')}`;
    throw new Error(`unknown series ${series}`);
}

/** { series, seq, fy } from any number this system has ever issued, or null. */
function parseNumber(str) {
    const s = String(str || '').trim();
    let m = /^(NL|NLCF)\/(\d+)\/(\d{2}-\d{2})$/.exec(s);
    if (m) return { series: m[1], seq: parseInt(m[2], 10), fy: m[3] };
    // PRO/26-27/0001 and the retired CREWFIT/26-27/0001 put the year before the counter.
    m = /^(PRO|CREWFIT)\/(\d{2}-\d{2})\/(\d+)$/.exec(s);
    if (m) return { series: m[1], seq: parseInt(m[3], 10), fy: m[2] };
    return null;
}

/** Next B2B (NLCF) number. Sequence-backed, so it is safe without a transaction. */
async function nextCrewfitB2bNumber(db) {
    const r = await db.query("SELECT nextval('crewfit_invoice_seq') AS n");
    return formatNumber(NLCF, parseInt(r.rows[0].n, 10), financialYear(todayIst()));
}

const KIND_RANK = { crewfit: 0, shopify: 1 };

/**
 * Issue NL numbers for whichever of `items` lack one, and return every item's number.
 *
 *   items: [{ order_name: '#10062' | 'CF-8', date: 'YYYY-MM-DD', kind: 'shopify'|'crewfit', tiebreak }]
 *
 * `tx` must be a transaction handle: the advisory lock taken here is what keeps two callers — the
 * sync numbering a batch of fulfilments, and an operator issuing a Crewfit invoice — from being
 * handed the same number. Numbers are permanent once issued: an item that already has one keeps
 * it, so re-running over the same period is a no-op.
 */
async function issueNormlessNumbers(tx, items) {
    const numbers = new Map();
    if (!items.length) return numbers;

    await tx.query("SELECT pg_advisory_xact_lock(hashtext('gst_invoice_numbers'))");

    const names = items.map(i => i.order_name);
    const existing = await tx.query(
        'SELECT order_name, invoice_no FROM gst_invoice_numbers WHERE order_name = ANY($1)', [names]);
    for (const row of existing.rows) numbers.set(row.order_name, row.invoice_no);

    const pending = items.filter(i => !numbers.has(i.order_name)).sort((a, b) =>
        (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
        || (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9)
        || (a.tiebreak || 0) - (b.tiebreak || 0));
    if (!pending.length) return numbers;

    // Next free number per FY: whichever is higher, the hand-kept seed or what has been issued.
    const nextSeq = new Map();
    const seqFor = async (fy) => {
        if (!nextSeq.has(fy)) {
            const r = await tx.query(
                `SELECT GREATEST(
                     COALESCE((SELECT seed FROM gst_sequences WHERE fy = $1), 0),
                     COALESCE((SELECT MAX(seq) FROM gst_invoice_numbers WHERE fy = $1), 0)
                 ) AS last`, [fy]);
            nextSeq.set(fy, parseInt(r.rows[0].last, 10) + 1);
        }
        return nextSeq.get(fy);
    };

    for (const item of pending) {
        const fy = financialYear(item.date);
        const seq = await seqFor(fy);
        nextSeq.set(fy, seq + 1);
        const invoiceNo = formatNumber(NL, seq, fy);
        await tx.query(
            `INSERT INTO gst_invoice_numbers (fy, seq, invoice_no, order_name, order_date)
             VALUES ($1, $2, $3, $4, $5)`,
            [fy, seq, invoiceNo, item.order_name, item.date]);
        numbers.set(item.order_name, invoiceNo);
    }
    return numbers;
}

/**
 * A Shopify order as a numbering item. `name` is Shopify's order name ("#10062", or
 * "EXC-#11075-1" for an exchange) — the same string the sync keeps in orders.order_number.
 */
const shopifyItem = ({ name, date }) => ({
    order_name: name, date, kind: 'shopify', tiebreak: parseInt(String(name).replace(/\D/g, ''), 10) || 0,
});

// Real-time numbering is switched on by db/number-september-2026.js once the transition month
// is numbered as one batch; until then a freshly deployed sync must not run ahead of it.
const SWITCH = 'invoice_numbering';

/**
 * Number every fulfilled Shopify order that has none yet. Called by the auto-sync after each
 * cycle, so a number exists from the day the goods go out rather than from the day someone
 * generates the register. Returns how many were issued.
 */
async function numberFulfilledOrders(db) {
    const on = await db.query('SELECT value FROM sync_state WHERE key = $1', [SWITCH]);
    if (on.rows[0]?.value !== 'on') return 0;
    // created_at is a naive timestamp holding the IST wall-clock Shopify reports, so its date
    // part is already the register's "Date".
    const r = await db.query(
        `SELECT o.order_number AS name, TO_CHAR(o.created_at, 'YYYY-MM-DD') AS date
           FROM orders o
          WHERE UPPER(COALESCE(o.fulfillment_status, '')) = 'FULFILLED'
            AND o.created_at::date >= $1
            AND NOT EXISTS (SELECT 1 FROM gst_invoice_numbers g WHERE g.order_name = o.order_number)
          ORDER BY regexp_replace(o.order_number, '\\D', '', 'g')::bigint`, [AUTO_NUMBER_FROM]);
    if (!r.rows.length) return 0;
    await db.transaction((tx) => issueNormlessNumbers(tx, r.rows.map(shopifyItem)));
    return r.rows.length;
}

module.exports = {
    NL, NLCF, PRO, AUTO_NUMBER_FROM, SWITCH,
    financialYear, istDate, todayIst, formatNumber, parseNumber,
    nextCrewfitB2bNumber, issueNormlessNumbers, numberFulfilledOrders, shopifyItem,
};
