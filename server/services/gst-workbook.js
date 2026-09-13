/**
 * The GST sales register workbook — the 19-column sheet the auditor files from.
 *
 * Shared by the Normless and Crewfit registers (services/gst-report.js, services/crewfit-gst.js)
 * so both drop into the same filing process. Formatting mirrors the workbook that was kept by
 * hand before this existed: yellow bold header, thin borders, 2-decimal money, whole-number
 * percentage.
 */

const ExcelJS = require('exceljs');
const { financialYear } = require('./invoice-numbers');

const COLUMNS = [
    'Order ID#', 'Date', 'Particulars', 'Company Name', 'Invoice No.', 'Location', 'GST Number',
    'GST percentage', 'Quantity', 'Rate', 'Billing amount (Product or service cost)',
    'GST Total Value', 'Gross Total (Product or service cost + GST)', 'CGST Value 2.5%',
    'SGST Value 2.5%', 'Interstate sale IGST @ 5%', 'HSN/ SAC CODE', 'UNIQUE QTY CODE', 'TOTAL QTY',
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Cotton T-shirts — what every Shopify row is filed under, and the fallback for a Crewfit line
// whose catalog product has no HSN of its own.
const DEFAULT_HSN = 61091000;
const UQC = 'NOS';

/** Excel's day number for a Y-M-D, computed from parts so no timezone can shift the date. */
function excelSerial(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / 86400000) + 25569;
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

function summarise(rows) {
    const sum = (key) => rows.reduce((a, r) => a + r[key], 0);
    return {
        row_count: rows.length,
        total_qty: rows.reduce((a, r) => a + r.qty, 0),
        taxable_value: sum('taxable'),
        gst_total: sum('gst'),
        gross_total: sum('gross'),
        // Unnumbered rows sort last, so the range is read off the numbered ones.
        invoice_from: rows.find(r => r.invoice_no)?.invoice_no || null,
        invoice_to: [...rows].reverse().find(r => r.invoice_no)?.invoice_no || null,
    };
}

/**
 * Order the rows the way the return reads: by invoice number where one is issued, and by date
 * behind that for anything still unnumbered (a preview, before the sync has caught up). The
 * same-day tiebreak matches the filed return — Crewfit invoices ahead of the day's Shopify orders.
 */
const KIND_RANK = { crewfit: 0, shopify: 1 };
function sortRows(rows) {
    return [...rows].sort((a, b) => {
        if (a.seq && b.seq) return a.seq - b.seq;
        if (a.seq || b.seq) return a.seq ? -1 : 1;
        return (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
            || (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9)
            || (a.tiebreak || 0) - (b.tiebreak || 0);
    });
}

/** Render the workbook. */
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
            r.cgst, r.sgst, r.igst, Number(r.hsn) || DEFAULT_HSN, r.uqc || UQC, r.qty,
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

module.exports = { COLUMNS, DEFAULT_HSN, UQC, excelSerial, financialYear, periodLabel, summarise, sortRows, buildWorkbook };
