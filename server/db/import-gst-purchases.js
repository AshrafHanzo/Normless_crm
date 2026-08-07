/**
 * One-time import of the hand-kept purchase register into gst_purchases + gst_suppliers.
 *
 *   node server/db/import-gst-purchases.js "GST Purchase FY 26-27.xlsx" [--dry]
 *
 * Money is imported exactly as written, never recomputed. 22 of the 102 original rows carry a GST
 * value that isn't taxable x rate — Delhivery rounds to whole rupees — and those figures have
 * already been filed, so reproducing them matters more than making them internally tidy. The
 * script reports the discrepancies instead of silently fixing them.
 *
 * Safe to re-run: bills conflict on the (supplier, invoice no) index and are skipped.
 */

const path = require('path');
const ExcelJS = require('exceljs');
const db = require('../db/connection');
const { isIntraState } = require('../services/gst-purchase');

const HEADER_ROWS = 3; // title, WITH IN TAMILNADU banner, column headers

/** Excel serial → YYYY-MM-DD, via UTC so the local timezone can't shift the day. */
const serialToYmd = (n) => new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000).toISOString().slice(0, 10);

function cellDate(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'number') return serialToYmd(v);
    const s = String(v).trim();
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

function cellNum(v) {
    if (v == null || v === '' || v === '-') return null;
    if (typeof v === 'number') return v;
    if (typeof v === 'object' && v.result !== undefined) return cellNum(v.result); // formula cell
    const n = Number(String(v).replace(/[₹,\s]/g, ''));
    return Number.isFinite(n) ? n : null;
}

function cellText(v) {
    if (v == null) return '';
    if (typeof v === 'object') {
        if (v.richText) return v.richText.map(t => t.text).join('');
        if (v.result !== undefined) return String(v.result);
        if (v.text) return String(v.text);
    }
    return String(v).trim();
}

async function parseWorkbook(file) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);

    const rows = [];
    wb.eachSheet((ws) => {
        ws.eachRow((row, n) => {
            if (n <= HEADER_ROWS) return;
            const at = (i) => row.getCell(i).value;
            const date = cellDate(at(1));
            const company = cellText(at(3));
            if (!date || !company) return; // blank or stray row

            rows.push({
                sheet: ws.name,
                purchase_date: date,
                particulars: cellText(at(2)),
                company_name: company,
                invoice_no: cellText(at(4)),
                location: cellText(at(5)),
                gstin: cellText(at(6)),
                gst_pct: cellNum(at(7)) ?? 0,
                qty: cellNum(at(8)),
                rate: cellNum(at(9)),
                taxable: cellNum(at(10)) ?? 0,
                gst_amount: cellNum(at(11)) ?? 0,
                gross: cellNum(at(12)) ?? 0,
                cgst: cellNum(at(13)) ?? 0,
                sgst: cellNum(at(14)) ?? 0,
                igst: cellNum(at(15)) ?? 0,
            });
        });
    });
    return rows;
}

/** Most frequent non-empty value, used to pick a supplier's default particulars/rate. */
function commonest(values) {
    const counts = new Map();
    for (const v of values) {
        if (v === null || v === undefined || v === '') continue;
        counts.set(v, (counts.get(v) || 0) + 1);
    }
    let best = null, n = 0;
    for (const [v, c] of counts) if (c > n) { best = v; n = c; }
    return best;
}

function buildSuppliers(rows) {
    const byKey = new Map();
    for (const r of rows) {
        const key = `${r.company_name.toLowerCase()}|${r.gstin || ''}`;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(r);
    }
    return [...byKey.values()].map((group) => {
        const first = group[0];
        return {
            name: first.company_name,
            gstin: first.gstin || null,
            location: commonest(group.map(r => r.location)) || '',
            default_particulars: commonest(group.map(r => r.particulars)),
            default_gst_pct: commonest(group.map(r => r.gst_pct)),
            default_rate: commonest(group.map(r => r.rate)),
            // With no GSTIN the state code is unknowable, so trust how the bills were actually
            // split — Mubas Clothings is unregistered but Tiruppur-based and rightly intra-state.
            intra_state: first.gstin ? isIntraState(first.gstin) : group.some(r => r.cgst > 0),
            bills: group.length,
        };
    }).sort((a, b) => b.bills - a.bills);
}

async function main() {
    const file = path.resolve(process.argv[2] || 'GST Purchase FY 26-27.xlsx');
    const dry = process.argv.includes('--dry');

    const rows = await parseWorkbook(file);
    const suppliers = buildSuppliers(rows);
    console.log(`Parsed ${rows.length} bills / ${suppliers.length} suppliers from ${path.basename(file)}`);

    const odd = rows.filter(r => Math.abs(r.taxable * r.gst_pct - r.gst_amount) > 0.05);
    if (odd.length) {
        console.log(`\n${odd.length} bill(s) state a GST value that isn't taxable x rate — imported as written:`);
        for (const r of odd.slice(0, 5)) {
            console.log(`  ${r.company_name.slice(0, 28).padEnd(30)} ${r.invoice_no.padEnd(18)} ` +
                `stated ${r.gst_amount}  vs computed ${(r.taxable * r.gst_pct).toFixed(2)}`);
        }
        if (odd.length > 5) console.log(`  …and ${odd.length - 5} more`);
    }

    if (dry) {
        console.log('\n--dry: nothing written. Suppliers that would be created:');
        for (const s of suppliers) console.log(`  ${String(s.bills).padStart(3)} bills  ${s.name}  [${s.gstin || 'unregistered'}]  intra=${s.intra_state}`);
        return;
    }

    let supplierCount = 0, billCount = 0, skipped = 0;
    await db.transaction(async (client) => {
        const idByKey = new Map();
        for (const s of suppliers) {
            const res = await client.query(
                `INSERT INTO gst_suppliers (name, gstin, location, default_particulars, default_gst_pct, default_rate, intra_state)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)
                 ON CONFLICT (LOWER(name), COALESCE(NULLIF(gstin, ''), '')) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
                 RETURNING id`,
                [s.name, s.gstin, s.location, s.default_particulars, s.default_gst_pct, s.default_rate, s.intra_state]
            );
            idByKey.set(`${s.name.toLowerCase()}|${s.gstin || ''}`, res.rows[0].id);
            supplierCount++;
        }

        for (const r of rows) {
            const supplierId = idByKey.get(`${r.company_name.toLowerCase()}|${r.gstin || ''}`) || null;
            const res = await client.query(
                `INSERT INTO gst_purchases (purchase_date, particulars, company_name, invoice_no, location, gstin,
                     gst_pct, qty, rate, taxable, gst_amount, gross, cgst, sgst, igst, supplier_id, source, created_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'import','import')
                 ON CONFLICT DO NOTHING RETURNING id`,
                [r.purchase_date, r.particulars, r.company_name, r.invoice_no, r.location, r.gstin || null,
                 r.gst_pct, r.qty, r.rate, r.taxable, r.gst_amount, r.gross, r.cgst, r.sgst, r.igst, supplierId]
            );
            if (res.rows.length) billCount++; else skipped++;
        }
    });

    console.log(`\n✅ ${supplierCount} suppliers, ${billCount} bills imported` +
        (skipped ? `, ${skipped} already present (skipped)` : ''));
}

main()
    .then(() => process.exit(0))
    .catch((err) => { console.error('Import failed:', err.message); process.exit(1); });
