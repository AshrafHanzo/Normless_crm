/**
 * Check the app's Normless register against the workbook the auditor actually filed, row by row.
 *
 *   node server/db/verify-gst-against-filed.js "<xlsx>" "<sheet name>" <from> <to>
 *
 * Reads only — no invoice numbers are issued — so it is safe to run at any time. The point is
 * the transition: after realign-gst-to-filed-return.js, the app must reproduce the filed August
 * 2026 sheet exactly (945 rows, same numbers, same values), or the next return will disagree with
 * the last one. Rows the app has that the sheet lacks (orders fulfilled after the return was
 * generated) are listed separately: they are unbilled supplies for the auditor, not a mismatch.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env'), quiet: true });
const ExcelJS = require('exceljs');
const db = require('./connection');
const gst = require('../services/gst-report');

const [file, sheetName, from, to] = process.argv.slice(2);
if (!file || !sheetName || !from || !to) {
    console.error('usage: node verify-gst-against-filed.js "<xlsx>" "<sheet>" <from YYYY-MM-DD> <to YYYY-MM-DD>');
    process.exit(1);
}

const cell = (v) => (v && typeof v === 'object' && !(v instanceof Date)) ? (v.result ?? v.text ?? '') : v;
const num = (v) => (v === '-' || v == null || v === '') ? 0 : Number(v);
const close = (a, b) => Math.abs(num(a) - num(b)) < 0.01;

(async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const ws = wb.getWorksheet(sheetName);
    if (!ws) throw new Error(`no sheet "${sheetName}"`);
    const filed = [];
    ws.eachRow((row, i) => {
        if (i === 1) return;
        const v = row.values.slice(1).map(cell);
        if (!v[0]) return;
        filed.push({
            order: String(v[0]).trim(), date: (v[1] instanceof Date ? v[1].toISOString() : String(v[1])).slice(0, 10),
            invoice_no: String(v[4]).trim(), location: String(v[5] || '').trim(), qty: num(v[8]),
            taxable: v[10], gst: v[11], gross: v[12], cgst: v[13], sgst: v[14], igst: v[15], hsn: String(v[16] || ''),
        });
    });

    const rows = await gst.readRows(db, from, to);
    const byOrder = new Map(rows.map(r => [r.order_name, r]));
    console.log(`filed: ${filed.length} rows · app: ${rows.length} rows`);

    let mismatches = 0;
    for (const f of filed) {
        const r = byOrder.get(f.order);
        if (!r) { mismatches++; console.log(`✗ ${f.order}: in the return, not in the app's register`); continue; }
        const diffs = [];
        if (r.invoice_no !== f.invoice_no) diffs.push(`number ${r.invoice_no} ≠ ${f.invoice_no}`);
        if (r.date !== f.date) diffs.push(`date ${r.date} ≠ ${f.date}`);
        if (r.qty !== f.qty) diffs.push(`qty ${r.qty} ≠ ${f.qty}`);
        if (!close(r.gross, f.gross)) diffs.push(`gross ${r.gross} ≠ ${f.gross}`);
        if (!close(r.taxable, f.taxable)) diffs.push(`taxable ${r.taxable.toFixed(2)} ≠ ${num(f.taxable).toFixed(2)}`);
        if (!close(r.cgst, f.cgst) || !close(r.igst, f.igst)) diffs.push(`tax split cgst ${r.cgst.toFixed(2)}/igst ${r.igst.toFixed(2)} ≠ ${num(f.cgst).toFixed(2)}/${num(f.igst).toFixed(2)} (app location "${r.location}", filed "${f.location}")`);
        if (String(r.hsn) !== f.hsn) diffs.push(`hsn ${r.hsn} ≠ ${f.hsn}`);
        if (diffs.length) { mismatches++; console.log(`✗ ${f.order} ${f.invoice_no}: ${diffs.join('; ')}`); }
        byOrder.delete(f.order);
    }
    const extra = [...byOrder.values()];
    if (extra.length) {
        console.log(`\n${extra.length} rows the app has that the return does not (fulfilled after it was generated — unbilled, for the auditor):`);
        for (const r of extra) console.log(`  ${r.order_name.padEnd(8)} ${r.date}  ${String(r.invoice_no || '(no number)').padEnd(16)} ${r.gross}`);
    }
    console.log(mismatches ? `\n✗ ${mismatches} of ${filed.length} filed rows differ` : `\n✓ All ${filed.length} filed rows reproduce exactly.`);
    process.exit(mismatches ? 1 : 0);
})().catch((e) => { console.error('\n✗', e.message); process.exit(1); });
