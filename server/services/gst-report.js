/**
 * GST sales report for Normless (Shopify retail).
 *
 * Reproduces the workbook that was previously kept by hand ("GST Sales FY 26-27.xlsx"): one row
 * per fulfilled Shopify order, GST divided *out* of the order value rather than added on top,
 * split CGST/SGST for home-state buyers and IGST for everyone else.
 *
 * Every rule below was derived by diffing against that workbook over June 2026, the one month
 * where the hand-kept rows and the Shopify read window still overlap. All 765 fulfilled orders
 * matched the 765 sheet rows exactly on value, quantity, state and tax split, so the mapping here
 * is measured rather than assumed. The two that took the longest to pin down:
 *
 *   - "Gross Total" is subtotal_price, NOT total_price. Shipping (a flat ₹60) is excluded from
 *     the GST sales register.
 *   - "Date" is the order's creation date in IST, not the fulfillment date. Order #7541 was
 *     created 8 Jun and fulfilled 9 Jun, and the workbook files it under 8 Jun.
 */

const ExcelJS = require('exceljs');
const shopify = require('./shopify');

// The accounting treatment the workbook applies to every line, regardless of what was actually
// bought — #7538 was track pants and is still filed as "Printed Graphic T Shirt" under HSN
// 61091000. Kept as constants so the figures stay consistent if the treatment ever changes.
const PARTICULARS = 'Printed Graphic T Shirt';
const HSN_CODE = 61091000;
const UQC = 'NOS';
const GST_RATE = 0.05;
const GST_NUMBER = 'NA';
const HOME_STATE = 'Tamil Nadu'; // intra-state sales split into CGST + SGST; everything else is IGST
const INVOICE_PREFIX = 'NL';

const COLUMNS = [
    'Order ID#', 'Date', 'Particulars', 'Company Name', 'Invoice No.', 'Location', 'GST Number',
    'GST percentage', 'Quantity', 'Rate', 'Billing amount (Product or service cost)',
    'GST Total Value', 'Gross Total (Product or service cost + GST)', 'CGST Value 2.5%',
    'SGST Value 2.5%', 'Interstate sale IGST @ 5%', 'HSN/ SAC CODE', 'UNIQUE QTY CODE', 'TOTAL QTY',
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Excel's day number for a Y-M-D, computed from parts so no timezone can shift the date. */
function excelSerial(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / 86400000) + 25569;
}

/** The IST calendar date of a Shopify timestamp, as YYYY-MM-DD. */
function istDate(iso) {
    const t = new Date(iso);
    const ist = new Date(t.getTime() + (5.5 * 3600 * 1000));
    return ist.toISOString().slice(0, 10);
}

/** Indian financial year label (Apr–Mar) for a YYYY-MM-DD date, e.g. 2026-07-15 → "26-27". */
function financialYear(ymd) {
    const [y, m] = ymd.split('-').map(Number);
    const start = m >= 4 ? y : y - 1;
    return `${String(start % 100).padStart(2, '0')}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** "Jul 26-27" for a whole calendar month, otherwise "01 Jul 2026 – 15 Jul 2026". */
function periodLabel(from, to) {
    const [fy, fm, fd] = from.split('-').map(Number);
    const [ty, tm, td] = to.split('-').map(Number);
    const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
    if (fy === ty && fm === tm && fd === 1 && td === lastDay) {
        return `${MONTHS[fm - 1]} ${financialYear(from)}`;
    }
    return `${String(fd).padStart(2, '0')} ${MONTHS[fm - 1]} ${fy} – ${String(td).padStart(2, '0')} ${MONTHS[tm - 1]} ${ty}`;
}

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
    };
}

/**
 * Fulfilled orders created in [from, to] (IST), oldest first.
 *
 * Shopify only serves order *data* for the last 60 days under the read_orders scope — beyond that
 * the list comes back empty rather than erroring, which would silently produce a report claiming
 * the month had no sales. orders/count.json is not subject to that restriction, so it is used as
 * an independent expected total and any shortfall is raised instead of filed.
 */
async function fetchFulfilledOrders(from, to) {
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

    return orders
        .filter(o => o.fulfillment_status === 'fulfilled')
        .sort((a, b) => (a.order_number || 0) - (b.order_number || 0));
}

/**
 * Assign — or reuse — an invoice number per order, inside a transaction.
 *
 * Numbers are permanent once issued: regenerating a period must reproduce the numbers already
 * filed with the return, so an order that already has one keeps it and only genuinely new orders
 * extend the sequence.
 */
async function assignInvoiceNumbers(db, orders) {
    const numbers = new Map();
    if (!orders.length) return numbers;

    const names = orders.map(o => o.name);
    const existing = await db.query(
        'SELECT order_name, fy, invoice_no FROM gst_invoice_numbers WHERE order_name = ANY($1)',
        [names]
    );
    for (const row of existing.rows) numbers.set(row.order_name, row.invoice_no);

    // Next free number per FY: whichever is higher, the hand-kept seed or what we've issued.
    const nextSeq = new Map();
    const seqFor = async (fy) => {
        if (!nextSeq.has(fy)) {
            const r = await db.query(
                `SELECT GREATEST(
                     COALESCE((SELECT seed FROM gst_sequences WHERE fy = $1), 0),
                     COALESCE((SELECT MAX(seq) FROM gst_invoice_numbers WHERE fy = $1), 0)
                 ) AS last`, [fy]
            );
            nextSeq.set(fy, parseInt(r.rows[0].last, 10) + 1);
        }
        return nextSeq.get(fy);
    };

    for (const order of orders) {
        if (numbers.has(order.name)) continue;
        const date = istDate(order.created_at);
        const fy = financialYear(date);
        const seq = await seqFor(fy);
        nextSeq.set(fy, seq + 1);
        const invoiceNo = `${INVOICE_PREFIX}/${seq}/${fy}`;
        await db.query(
            `INSERT INTO gst_invoice_numbers (fy, seq, invoice_no, order_name, order_date)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (fy, order_name) DO NOTHING`,
            [fy, seq, invoiceNo, order.name, date]
        );
        numbers.set(order.name, invoiceNo);
    }

    return numbers;
}

/** Build the register rows for a period, issuing invoice numbers as needed. */
async function buildRows(db, from, to) {
    const orders = await fetchFulfilledOrders(from, to);
    const numbers = await assignInvoiceNumbers(db, orders);
    return orders.map(o => orderToRow(o, numbers.get(o.name) || ''));
}

/**
 * Totals for a period without touching the numbering — lets the UI show what a period contains
 * before committing to it. Issuing invoice numbers on a mere preview would burn them whenever
 * someone changed their mind about the dates, leaving permanent gaps in the filed sequence.
 */
async function previewPeriod(from, to) {
    const orders = await fetchFulfilledOrders(from, to);
    const rows = orders.map(o => orderToRow(o, ''));
    return { ...summarise(rows), invoice_from: null, invoice_to: null, period_label: periodLabel(from, to) };
}

function summarise(rows) {
    const sum = (key) => rows.reduce((a, r) => a + r[key], 0);
    return {
        row_count: rows.length,
        total_qty: rows.reduce((a, r) => a + r.qty, 0),
        taxable_value: sum('taxable'),
        gst_total: sum('gst'),
        gross_total: sum('gross'),
        invoice_from: rows.length ? rows[0].invoice_no : null,
        invoice_to: rows.length ? rows[rows.length - 1].invoice_no : null,
    };
}

/**
 * Render the workbook. Formatting mirrors the hand-kept file — yellow bold header, thin borders,
 * 2-decimal money, whole-number percentage — so it drops into the same filing process.
 */
async function buildWorkbook(rows, label) {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Normless CRM';
    wb.created = new Date();
    const ws = wb.addWorksheet(label.slice(0, 31));

    ws.addRow(COLUMNS);
    for (const r of rows) {
        ws.addRow([
            r.order_name, excelSerial(r.date), r.particulars, r.company, r.invoice_no, r.location,
            r.gst_number, r.gst_pct, r.qty, r.rate, r.taxable, r.gst, r.gross,
            r.cgst, r.sgst, r.igst, HSN_CODE, r.uqc || UQC, r.qty,
        ]);
    }

    const border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    const header = ws.getRow(1);
    header.font = { bold: true, size: 12, name: 'Calibri' };
    header.alignment = { horizontal: 'center', wrapText: true };
    header.eachCell(c => {
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
        c.border = border;
    });

    ws.columns.forEach(c => { c.width = 19.89; });
    ws.getColumn(2).numFmt = 'mm-dd-yy';   // stored as a serial, same as the original
    ws.getColumn(8).numFmt = '0%';
    for (let c = 10; c <= 16; c++) ws.getColumn(c).numFmt = '0.00';
    ws.getColumn(17).numFmt = '0';

    for (let i = 2; i <= ws.rowCount; i++) ws.getRow(i).eachCell(c => { c.border = border; });
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    return wb.xlsx.writeBuffer();
}

module.exports = {
    buildRows,
    buildWorkbook,
    previewPeriod,
    summarise,
    periodLabel,
    financialYear,
    fetchFulfilledOrders,
    orderToRow,
    excelSerial,
    istDate,
    COLUMNS,
};
