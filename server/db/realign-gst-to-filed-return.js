/**
 * One-time realignment of the invoice series to the GST return the auditor actually filed.
 *
 * For August 2026 the auditor reworked the two registers the app produced, by hand:
 *
 *   - Crewfit tax invoices for customers WITHOUT a GSTIN were moved into the Normless register,
 *     one row per invoice, slotted in by date ahead of that day's Shopify orders, on the shared
 *     NL/<seq>/<fy> series — which shifted every later Shopify number by up to 20.
 *   - The Crewfit register kept only the B2B invoices (customer has a GSTIN), renumbered onto a
 *     new NLCF/<seq>/<fy> series starting at 0001.
 *
 * The filed return is the truth, so the database is brought to it here rather than the other way
 * round. Numbers are read straight from the auditor's two workbooks — nothing is recomputed.
 *
 *   node server/db/realign-gst-to-filed-return.js "<Normless xlsx>" "<Crewfit xlsx>" [--apply]
 *
 * Without --apply it prints the full mapping and changes nothing. With it, every change runs in
 * one transaction, and the prior state of every touched row is written to a JSON file first.
 *
 * Also moves the September B2B invoices issued so far onto the NLCF series (continuing the filed
 * numbering) and resets crewfit_invoice_seq to follow. September B2C invoices are left alone: they
 * take NL numbers together with September's Shopify orders in number-september.js.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env'), quiet: true });
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const db = require('./connection');
const { formatNumber, parseNumber } = require('../services/invoice-numbers');

const APPLY = process.argv.includes('--apply');
const [normlessFile, crewfitFile] = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (!normlessFile || !crewfitFile) {
    console.error('usage: node realign-gst-to-filed-return.js "<Normless xlsx>" "<Crewfit xlsx>" [--apply]');
    process.exit(1);
}

const FY = '26-27';
const SHEET_NL = 'AUG 26 - 27';
const SHEET_CF = 'Aug 26-27';

const cell = (v) => (v && typeof v === 'object' && !(v instanceof Date)) ? (v.result ?? v.text ?? '') : v;
const ymd = (v) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

/** Every data row of a sheet as { order, date, invoice_no, gross }. */
async function readSheet(file, sheetName) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const ws = wb.getWorksheet(sheetName);
    if (!ws) throw new Error(`${file}: no sheet named "${sheetName}"`);
    const rows = [];
    ws.eachRow((row, i) => {
        if (i === 1) return;
        const v = row.values.slice(1).map(cell);
        if (!v[0]) return;
        rows.push({ line: i, order: String(v[0]).trim(), date: ymd(v[1]), invoice_no: String(v[4]).trim(), gross: Number(v[12]) });
    });
    return rows;
}

(async () => {
    const nl = await readSheet(normlessFile, SHEET_NL);
    const cf = await readSheet(crewfitFile, SHEET_CF);
    console.log(`Normless sheet: ${nl.length} rows · Crewfit sheet: ${cf.length} rows`);

    // Every filed number parses and is unique — the sheet is the new series, so it must be sound.
    const seen = new Map();
    for (const r of [...nl, ...cf]) {
        const p = parseNumber(r.invoice_no);
        if (!p || p.fy !== FY) throw new Error(`line ${r.line}: cannot read invoice number "${r.invoice_no}"`);
        if (seen.has(r.invoice_no)) throw new Error(`"${r.invoice_no}" filed twice (${seen.get(r.invoice_no)} and ${r.order})`);
        seen.set(r.invoice_no, r.order);
        r.seq = p.seq; r.series = p.series;
    }
    const nlSeqs = nl.map(r => r.seq).sort((a, b) => a - b);
    for (let i = 1; i < nlSeqs.length; i++) if (nlSeqs[i] !== nlSeqs[i - 1] + 1) throw new Error(`NL series has a gap between ${nlSeqs[i - 1]} and ${nlSeqs[i]}`);
    if (nl.some(r => r.series !== 'NL') || cf.some(r => r.series !== 'NLCF')) throw new Error('unexpected series in a sheet');

    /* ── Shopify orders: current number → filed number ─────────────────────────────── */
    const shop = nl.filter(r => r.order.startsWith('#'));
    const current = new Map((await db.query(
        'SELECT id, order_name, seq, invoice_no FROM gst_invoice_numbers WHERE fy = $1', [FY])).rows.map(r => [r.order_name, r]));
    const shopChanges = [];
    for (const r of shop) {
        const cur = current.get(r.order);
        if (!cur) throw new Error(`${r.order} is in the return but has no number in the database`);
        if (cur.invoice_no !== r.invoice_no) shopChanges.push({ id: cur.id, order: r.order, from: cur.invoice_no, to: r.invoice_no, seq: r.seq });
    }
    console.log(`\nShopify orders: ${shop.length} filed, ${shopChanges.length} change number, ${shop.length - shopChanges.length} already match`);
    if (shopChanges.length) {
        console.log(`  first: ${shopChanges[0].order} ${shopChanges[0].from} -> ${shopChanges[0].to}`);
        console.log(`  last:  ${shopChanges.at(-1).order} ${shopChanges.at(-1).from} -> ${shopChanges.at(-1).to}`);
    }

    /* ── Crewfit tax invoices: which register, which number ────────────────────────── */
    const invoices = (await db.query(
        `SELECT i.id, i.number, i.series, i.seq, i.gross, i.gstin, i.note, TO_CHAR(i.issue_date,'YYYY-MM-DD') AS issue_date,
                o.sl_no, o.billing_name, o.customer_name
           FROM crewfit_invoices i JOIN crewfit_orders o ON o.id = i.order_id
          WHERE i.doc_type = 'tax_invoice' AND i.status <> 'cancelled' AND i.fy = $1
          ORDER BY i.issue_date, i.seq`, [FY])).rows;
    const bySl = new Map(invoices.map(i => [`CF-${i.sl_no}`, i]));

    const cfChanges = [];
    const filedCf = [...nl.filter(r => r.order.startsWith('CF-')), ...cf];
    for (const r of filedCf) {
        const inv = bySl.get(r.order);
        if (!inv) throw new Error(`${r.order} is in the return but has no tax invoice in the database`);
        if (Math.abs(Number(inv.gross) - r.gross) > 0.5) throw new Error(`${r.order}: filed gross ${r.gross} but the invoice says ${inv.gross}`);
        const b2b = r.series === 'NLCF';
        if (b2b !== !!(inv.gstin || '').trim()) console.warn(`  ⚠ ${r.order} filed as ${b2b ? 'B2B' : 'B2C'} but GSTIN in the database is "${inv.gstin || ''}"`);
        cfChanges.push({ id: inv.id, order: r.order, from: inv.number, to: r.invoice_no, series: r.series, seq: r.seq, date: inv.issue_date, gross: r.gross, why: 'filed Aug 26-27 return' });
    }

    // September B2B invoices continue the NLCF series after the filed ones, in issue order.
    let nextNlcf = Math.max(...cf.map(r => r.seq)) + 1;
    const filedIds = new Set(cfChanges.map(c => c.id));
    for (const inv of invoices) {
        if (filedIds.has(inv.id) || inv.series === 'NLCF' || inv.series === 'NL') continue;
        if (!(inv.gstin || '').trim()) continue; // B2C — numbered with September's Shopify orders later
        const to = formatNumber('NLCF', nextNlcf, FY);
        cfChanges.push({ id: inv.id, order: `CF-${inv.sl_no}`, from: inv.number, to, series: 'NLCF', seq: nextNlcf, date: inv.issue_date, gross: Number(inv.gross), why: 'B2B, continues the filed NLCF series' });
        nextNlcf++;
    }

    console.log(`\nCrewfit tax invoices: ${cfChanges.length} renumbered`);
    console.log('  order   date        from                  -> to                   gross   note');
    for (const c of cfChanges) {
        console.log(`  ${c.order.padEnd(7)} ${c.date}  ${c.from.padEnd(21)} -> ${c.to.padEnd(20)} ${String(c.gross).padStart(7)}   ${c.why}`);
    }
    const untouched = invoices.filter(i => !cfChanges.some(c => c.id === i.id));
    console.log(`\n${untouched.length} B2C invoices left on the old series for number-september.js: ${untouched.map(i => i.number.split('/').pop()).join(', ')}`);
    console.log(`crewfit_invoice_seq will be set to ${nextNlcf - 1}`);

    if (!APPLY) { console.log('\nDry run — nothing written. Re-run with --apply.'); process.exit(0); }

    /* ── Apply ─────────────────────────────────────────────────────────────────────── */
    const backupDir = path.join(__dirname, '..', 'storage', 'gst');
    fs.mkdirSync(backupDir, { recursive: true });
    const backup = path.join(backupDir, `realign-backup-${Date.now()}.json`);
    fs.writeFileSync(backup, JSON.stringify({ shopChanges, cfChanges, invoices }, null, 2));
    console.log(`\nPrior state saved to ${backup}`);

    await db.transaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtext('gst_invoice_numbers'))");

        // The (fy, seq) index forbids a straight shift, so park the moving rows on negative seqs
        // first; the filed numbers are unique, so the second pass can't collide with a row that stays.
        for (const c of shopChanges) await tx.query('UPDATE gst_invoice_numbers SET seq = -seq WHERE id = $1', [c.id]);
        for (const c of shopChanges) {
            await tx.query('UPDATE gst_invoice_numbers SET seq = $1, invoice_no = $2 WHERE id = $3', [c.seq, c.to, c.id]);
        }

        // Crewfit documents: the number on the row, plus a line in gst_invoice_numbers for the NL
        // ones so the shared counter sees them. Old numbers stay in the note for the audit trail.
        for (const c of cfChanges) await tx.query('UPDATE crewfit_invoices SET number = $1 WHERE id = $2', [`tmp:${c.id}`, c.id]);
        for (const c of cfChanges) {
            await tx.query(
                `UPDATE crewfit_invoices SET number = $1, series = $2, seq = $3,
                        note = CONCAT_WS(E'\\n', NULLIF(note, ''), $4), updated_at = CURRENT_TIMESTAMP
                  WHERE id = $5`,
                [c.to, c.series, c.seq, `Renumbered from ${c.from} — ${c.why}`, c.id]);
            if (c.series === 'NL') {
                await tx.query(
                    `INSERT INTO gst_invoice_numbers (fy, seq, invoice_no, order_name, order_date)
                     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (fy, order_name) DO UPDATE SET seq = $2, invoice_no = $3`,
                    [FY, c.seq, c.to, c.order, c.date]);
            }
        }
        await tx.query('SELECT setval($1, $2, true)', ['crewfit_invoice_seq', nextNlcf - 1]);
    });

    // Read back: every filed number must now resolve to exactly the document it was filed against.
    const check = new Map((await db.query('SELECT order_name, invoice_no FROM gst_invoice_numbers WHERE fy = $1', [FY])).rows.map(r => [r.order_name, r.invoice_no]));
    const cfNow = new Map((await db.query(`SELECT 'CF-' || o.sl_no AS k, i.number FROM crewfit_invoices i JOIN crewfit_orders o ON o.id=i.order_id WHERE i.doc_type='tax_invoice' AND i.status<>'cancelled'`)).rows.map(r => [r.k, r.number]));
    let bad = 0;
    for (const r of nl) if ((r.order.startsWith('#') ? check.get(r.order) : cfNow.get(r.order)) !== r.invoice_no) { bad++; console.error(`  ✗ ${r.order} expected ${r.invoice_no}`); }
    for (const r of cf) if (cfNow.get(r.order) !== r.invoice_no) { bad++; console.error(`  ✗ ${r.order} expected ${r.invoice_no}`); }
    console.log(bad ? `\n✗ ${bad} rows do not match the return` : `\n✓ All ${nl.length + cf.length} filed rows now match the database.`);
    process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('\n✗', e.message); process.exit(1); });
