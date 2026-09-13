/**
 * GST sales report for Normless — every B2C supply under the GSTIN.
 *
 * Reproduces the workbook that was previously kept by hand ("GST Sales FY 26-27.xlsx"): one row
 * per fulfilled Shopify order, GST divided *out* of the order value rather than added on top,
 * split CGST/SGST for home-state buyers and IGST for everyone else. Since the August 2026 return
 * it also carries the Crewfit tax invoices issued to customers without a GSTIN, one row each on
 * the same NL series, slotted in by date — see services/invoice-numbers.js for the split.
 *
 * Every Shopify rule below was derived by diffing against that workbook over June 2026, the one
 * month where the hand-kept rows and the Shopify read window still overlap. All 765 fulfilled
 * orders matched the 765 sheet rows exactly on value, quantity, state and tax split, so the
 * mapping here is measured rather than assumed. The two that took the longest to pin down:
 *
 *   - "Gross Total" is subtotal_price, NOT total_price. Shipping (a flat ₹60) is excluded from
 *     the GST sales register.
 *   - "Date" is the order's creation date in IST, not the fulfillment date. Order #7541 was
 *     created 8 Jun and fulfilled 9 Jun, and the workbook files it under 8 Jun.
 */

const shopify = require('./shopify');
const workbook = require('./gst-workbook');
const crewfit = require('./crewfit-gst');
const { istDate, issueNormlessNumbers, shopifyItem } = require('./invoice-numbers');

// The accounting treatment the workbook applies to every Shopify line, regardless of what was
// actually bought — #7538 was track pants and is still filed as "Printed Graphic T Shirt" under
// HSN 61091000. Kept as constants so the figures stay consistent if the treatment ever changes.
const PARTICULARS = 'Printed Graphic T Shirt';
const GST_RATE = 0.05;
const GST_NUMBER = 'NA';
const HOME_STATE = 'Tamil Nadu'; // intra-state sales split into CGST + SGST; everything else is IGST

function fullName(addr) {
    if (!addr) return '';
    const joined = [addr.first_name, addr.last_name].filter(Boolean).join(' ').trim();
    return (addr.name || joined || '').trim();
}

/**
 * Collapse a Shopify order into the single register line the workbook keeps for it.
 * `invoiceNo` is supplied by the caller because numbering is persisted, not derived.
 */
function orderToRow(order, invoiceNo) {
    const date = istDate(order.created_at);
    const qty = (order.line_items || []).reduce((sum, li) => sum + (li.quantity || 0), 0);
    const gross = parseFloat(order.subtotal_price) || 0;
    const taxable = gross / (1 + GST_RATE);
    const gst = gross - taxable;
    const state = (order.shipping_address || {}).province || (order.billing_address || {}).province || '';
    const intraState = state.trim().toLowerCase() === HOME_STATE.toLowerCase();
    const seq = invoiceNo ? parseInt(invoiceNo.split('/')[1], 10) : null;

    return {
        order_name: order.name,
        date,
        particulars: PARTICULARS,
        // The workbook bills to the billing address — it matched all 765 June rows, where the
        // customer record and shipping name each disagreed on at least one.
        company: fullName(order.billing_address) || fullName(order.shipping_address)
            || [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ').trim(),
        invoice_no: invoiceNo,
        location: state,
        gst_number: GST_NUMBER,
        gst_pct: GST_RATE,
        qty,
        rate: qty ? gross / qty : 0,
        taxable,
        gst,
        gross,
        cgst: intraState ? gst / 2 : 0,
        sgst: intraState ? gst / 2 : 0,
        igst: intraState ? 0 : gst,
        hsn: workbook.DEFAULT_HSN,
        seq,
        kind: 'shopify',
        tiebreak: order.order_number || 0,
    };
}

/**
 * Orders created in [from, to] (IST) that belong in the register: fulfilled, or already holding
 * an invoice number. The second case is an order that went out and was later restocked — its
 * number was issued at supply and is filed; a credit note reverses it, a gap in the series
 * does not.
 *
 * Shopify only serves order *data* for the last 60 days under the read_orders scope — beyond that
 * the list comes back empty rather than erroring, which would silently produce a report claiming
 * the month had no sales. orders/count.json is not subject to that restriction, so it is used as
 * an independent expected total and any shortfall is raised instead of filed.
 */
async function fetchRegisterOrders(db, from, to) {
    const min = `${from}T00:00:00+05:30`;
    const max = `${to}T23:59:59.999+05:30`;

    const expected = await shopify.countOrders(min, max);
    const orders = await shopify.fetchOrdersInRange(min, max);

    if (orders.length < expected) {
        const err = new Error(
            `Shopify returned only ${orders.length} of ${expected} orders for this period. Orders older ` +
            `than 60 days are not readable with the current app scope (read_orders), so this report would ` +
            `be incomplete. Request the read_all_orders scope from Shopify to export older periods.`
        );
        err.code = 'INCOMPLETE_RANGE';
        err.expected = expected;
        err.received = orders.length;
        throw err;
    }

    const numbered = new Map((await db.query(
        'SELECT order_name, invoice_no FROM gst_invoice_numbers WHERE order_name = ANY($1)',
        [orders.map(o => o.name)])).rows.map(r => [r.order_name, r.invoice_no]));

    return {
        numbered,
        orders: orders
            .filter(o => o.fulfillment_status === 'fulfilled' || numbered.has(o.name))
            .sort((a, b) => (a.order_number || 0) - (b.order_number || 0)),
    };
}

/** Rows for a period. With `issue`, anything unnumbered is numbered first (needs a transaction). */
async function assemble(db, from, to, { issue }) {
    const { orders, numbered } = await fetchRegisterOrders(db, from, to);
    const numbers = issue
        ? await issueNormlessNumbers(db, orders.map(o => shopifyItem({ name: o.name, date: istDate(o.created_at) })))
        : numbered;
    const rows = [
        ...orders.map(o => orderToRow(o, numbers.get(o.name) || '')),
        ...await crewfit.normlessRows(db, from, to),
    ];
    return workbook.sortRows(rows);
}

/** Build the register rows for a period, issuing invoice numbers as needed. */
const buildRows = (db, from, to) => assemble(db, from, to, { issue: true });

/** The same rows, reading only the numbers already issued — for checks that must not file anything. */
const readRows = (db, from, to) => assemble(db, from, to, { issue: false });

/**
 * Totals for a period without touching the numbering — lets the UI show what a period contains
 * before committing to it. Issuing invoice numbers on a mere preview would burn them whenever
 * someone changed their mind about the dates, leaving permanent gaps in the filed sequence.
 */
async function previewPeriod(db, from, to) {
    const rows = await assemble(db, from, to, { issue: false });
    return { ...summarise(rows), period_label: workbook.periodLabel(from, to) };
}

function summarise(rows) {
    const crewfitRows = rows.filter(r => r.kind === 'crewfit');
    return {
        ...workbook.summarise(rows),
        unnumbered: rows.filter(r => !r.invoice_no).length,
        crewfit_count: crewfitRows.length,
        crewfit_gross: crewfitRows.reduce((s, r) => s + r.gross, 0),
    };
}

module.exports = {
    buildRows,
    readRows,
    previewPeriod,
    summarise,
    orderToRow,
    fetchRegisterOrders,
    buildWorkbook: workbook.buildWorkbook,
    periodLabel: workbook.periodLabel,
    COLUMNS: workbook.COLUMNS,
};
