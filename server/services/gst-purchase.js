/**
 * GST purchase register for Normless.
 *
 * The counterpart to gst-report.js, and deliberately a different shape. Sales are *derived* from
 * Shopify; purchases have no upstream system at all — they are supplier bills that arrive as PDFs
 * and emails — so this module renders what has been entered by hand rather than computing a period
 * from source data.
 *
 * Two rules differ from the sales register and are easy to get backwards:
 *
 *   - Purchase amounts are GST-*exclusive*: tax is added on top (4800 + 18% = 5664). Sales amounts
 *     are GST-*inclusive* and have the tax divided out of them.
 *   - Intra vs inter-state is decided by the *supplier's* state, read from the first two digits of
 *     their GSTIN (33 = Tamil Nadu). Of the first 102 bills only Facebook (06) and Razorpay (29)
 *     were inter-state. Unregistered suppliers have no GSTIN, so those fall back to an explicit
 *     flag — "Mubas Clothings" is in Tiruppur and is correctly treated as intra-state.
 */

const ExcelJS = require('exceljs');

const HOME_STATE_CODE = '33'; // Tamil Nadu

const COLUMNS = [
    'Date', 'Particulars', 'Company Name', 'Invoice No.', 'Location', 'GST Number',
    'GST percentage', 'Quantity', 'Rate', 'Billing amount (Product or service cost)',
    'GST Total Value', 'Gross Total (Product or service cost + GST)',
    'CGST Value 9%,6%,3%', 'SGST Value 9%,6%,3%', 'Interstate sale IGST @ 18%',
];

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Excel's day number for a Y-M-D, computed from parts so no timezone can shift the date. */
function excelSerial(ymd) {
    const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / 86400000) + 25569;
}

/** True when the supplier is in the home state, i.e. the bill splits into CGST + SGST. */
function isIntraState(gstin, fallback = true) {
    const code = String(gstin || '').trim().slice(0, 2);
    if (!/^\d{2}$/.test(code)) return fallback; // unregistered supplier — caller decides
    return code === HOME_STATE_CODE;
}

/**
 * Complete a purchase line from whatever the user supplied.
 *
 * Amounts are only ever *filled in*, never corrected: if a bill states a GST value that isn't
 * exactly taxable x rate — 22 of the first 102 did, because Delhivery rounds to whole rupees —
 * the bill is what gets claimed, so an explicitly supplied figure is left alone.
 */
function computeLine(input) {
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    const pct = num(input.gst_pct) ?? 0;
    const qty = num(input.qty);
    let rate = num(input.rate);
    let taxable = num(input.taxable);
    let gst = num(input.gst_amount);
    let gross = num(input.gross);

    // Work out the taxable value from whichever pair the user actually has to hand. Many bills are
    // entered from a round gross (82 of the first 102 were round numbers), so that path matters
    // as much as qty x rate.
    if (taxable == null) {
        if (qty != null && rate != null) taxable = qty * rate;
        else if (gross != null && gst != null) taxable = gross - gst;
        else if (gross != null) taxable = gross / (1 + pct);
        else taxable = 0;
    }
    if (gst == null) gst = gross != null ? gross - taxable : taxable * pct;
    if (gross == null) gross = taxable + gst;
    // Rate is a derived display column in the source workbook, not an input.
    if (rate == null && qty) rate = taxable / qty;

    const intra = isIntraState(input.gstin, input.intra_state !== false);
    return {
        purchase_date: String(input.purchase_date).slice(0, 10),
        particulars: input.particulars || '',
        company_name: input.company_name || '',
        invoice_no: input.invoice_no || '',
        location: input.location || '',
        gstin: input.gstin || '',
        gst_pct: pct,
        qty: qty ?? null,
        rate: rate ?? null,
        taxable,
        gst_amount: gst,
        gross,
        cgst: intra ? gst / 2 : 0,
        sgst: intra ? gst / 2 : 0,
        igst: intra ? 0 : gst,
    };
}

/** "Purchase APR 2026" for a whole month, else a date range. Mirrors the source workbook's tabs. */
function periodLabel(from, to) {
    const [fy, fm, fd] = from.split('-').map(Number);
    const [ty, tm, td] = to.split('-').map(Number);
    const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
    if (fy === ty && fm === tm && fd === 1 && td === lastDay) {
        return `Purchase ${MONTHS[fm - 1].toUpperCase()} ${fy}`;
    }
    return `Purchase ${String(fd).padStart(2, '0')} ${MONTHS[fm - 1]} ${fy} - ${String(td).padStart(2, '0')} ${MONTHS[tm - 1]} ${ty}`;
}

/** Title shown in row 1, e.g. "Purchase Register - APR 2026". */
function registerTitle(from, to) {
    const [fy, fm, fd] = from.split('-').map(Number);
    const [ty, tm, td] = to.split('-').map(Number);
    const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
    if (fy === ty && fm === tm && fd === 1 && td === lastDay) {
        return `Purchase Register - ${MONTHS[fm - 1].toUpperCase()} ${fy}`;
    }
    return `Purchase Register - ${fd} ${MONTHS_LONG[fm - 1]} ${fy} to ${td} ${MONTHS_LONG[tm - 1]} ${ty}`;
}

function summarise(rows) {
    const sum = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    return {
        row_count: rows.length,
        total_qty: Math.round(sum('qty')),
        taxable_value: sum('taxable'),
        gst_total: sum('gst_amount'),
        gross_total: sum('gross'),
        cgst_total: sum('cgst'),
        sgst_total: sum('sgst'),
        igst_total: sum('igst'),
    };
}

/**
 * Render the purchase workbook in the layout of the hand-kept file: a title row, the merged
 * WITH IN TAMILNADU / OUTSIDE TAMILNADU banner over the tax columns, then the header and data.
 */
async function buildWorkbook(rows, { title, sheetName }) {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Normless CRM';
    wb.created = new Date();
    const ws = wb.addWorksheet(sheetName.slice(0, 31));

    ws.addRow([title]);
    const banner = ws.addRow([]);
    banner.getCell(13).value = 'WITH IN TAMILNADU';
    banner.getCell(15).value = 'OUTSIDE TAMILNADU';
    ws.addRow(COLUMNS);

    for (const r of rows) {
        ws.addRow([
            excelSerial(r.purchase_date), r.particulars, r.company_name, r.invoice_no,
            r.location, r.gstin, Number(r.gst_pct) || 0,
            r.qty == null ? '' : Number(r.qty), r.rate == null ? '' : Number(r.rate),
            Number(r.taxable) || 0, Number(r.gst_amount) || 0, Number(r.gross) || 0,
            Number(r.cgst) || 0, Number(r.sgst) || 0, Number(r.igst) || 0,
        ]);
    }

    ws.mergeCells('A1:B1');
    ws.mergeCells('M2:N2');

    const border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
    ws.getRow(1).font = { bold: true, size: 12 };
    const bannerRow = ws.getRow(2);
    bannerRow.font = { bold: true };
    bannerRow.alignment = { horizontal: 'center' };
    const header = ws.getRow(3);
    header.font = { bold: true };
    header.alignment = { horizontal: 'center', wrapText: true };
    header.eachCell(c => { c.border = border; });

    const widths = [13, 32, 38, 18, 30, 20, 15, 11, 14, 18, 15, 18, 15, 15, 18];
    widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    ws.getColumn(1).numFmt = 'mm-dd-yy';
    ws.getColumn(7).numFmt = '0%';
    // The source workbook prices these in rupees; keeping the symbol makes the export drop
    // straight into the same filing process.
    for (let c = 9; c <= 15; c++) ws.getColumn(c).numFmt = '"₹" #,##0.00';

    for (let i = 4; i <= ws.rowCount; i++) ws.getRow(i).eachCell({ includeEmpty: true }, c => { c.border = border; });
    ws.views = [{ state: 'frozen', ySplit: 3 }];

    return wb.xlsx.writeBuffer();
}

module.exports = {
    computeLine,
    isIntraState,
    buildWorkbook,
    summarise,
    periodLabel,
    registerTitle,
    excelSerial,
    COLUMNS,
    HOME_STATE_CODE,
};
