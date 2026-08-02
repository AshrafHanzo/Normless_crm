/**
 * Crewfit bulk-order importer.
 *
 * Creates the crewfit_orders table (idempotent), pulls the Google Sheet as CSV,
 * normalizes the messy dropdown values into clean picklists, computes real
 * deadline dates, and upserts by Sl No.
 *
 * Usage:
 *   node server/db/import-crewfit.js                 # fetch sheet -> Postgres
 *   node server/db/import-crewfit.js --dry-run       # fetch sheet, print, no DB
 *   node server/db/import-crewfit.js --file x.csv    # use a local CSV instead
 *   node server/db/import-crewfit.js --dry-run --file x.csv
 */
const path = require('path');
const fs = require('fs');
const axios = require('axios');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const SHEET_ID = process.env.CREWFIT_SHEET_ID || '1GcZ3gc9OwM_o0pV74PcrwXDSkbnfiyBfzeWpgZwurFU';
const SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const fileArg = args.indexOf('--file');
const LOCAL_FILE = fileArg >= 0 ? args[fileArg + 1] : null;

/* ---------- CSV parser (handles quotes + newlines inside fields) ---------- */
function parseCSV(t) {
    const rows = []; let f = '', row = [], q = false;
    for (let i = 0; i < t.length; i++) {
        const c = t[i];
        if (q) {
            if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; }
            else f += c;
        } else {
            if (c === '"') q = true;
            else if (c === ',') { row.push(f); f = ''; }
            else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
            else if (c === '\r') { /* skip */ }
            else f += c;
        }
    }
    if (f.length || row.length) { row.push(f); rows.push(row); }
    return rows;
}

/* ---------- Normalizers ---------- */
const clean = (s) => (s || '').trim();

function normStatus(v) {
    const s = clean(v).toLowerCase();
    if (!s) return 'Pending';
    if (s.includes('dispatch') && s.includes('ready')) return 'Ready for Dispatch';
    if (s.includes('dispatch')) return 'Dispatched';
    if (s.includes('production') || s.includes('ongoing')) return 'Ongoing Production';
    if (s.includes('consignment') && s.includes('received')) return 'Consignment Received';
    if (s.includes('consignment') || s.includes('ordered')) return 'Consignment Ordered';
    if (s.includes('cancel')) return 'Cancelled';
    return 'Pending';
}
function normPayment(v) {
    const s = clean(v).toLowerCase();
    if (s.includes('full')) return 'Fully Paid';
    if (s.includes('50') || s.includes('advance') || s.includes('half')) return '50% Paid';
    if (s.includes('pend')) return 'Pending';
    return s ? clean(v) : 'Pending';
}
function normLayout(v) {
    const s = clean(v).toLowerCase();
    if (s.includes('done') || s.includes('complete')) return 'Done';
    return 'Pending';
}
function normCustomerType(v) {
    const s = clean(v).toLowerCase();
    if (!s) return null;
    if (s.includes('retur')) return 'Returning'; // catches Returing/returning typos
    if (s.includes('new')) return 'New';
    return clean(v);
}
function normSO(v) {
    const s = clean(v).toLowerCase();
    if (!s) return null;
    if (s.includes('anu')) return 'Anu';
    if (s.includes('sadam') || s.includes('salman')) return 'Sadam';
    return clean(v).replace(/\b\w/g, c => c.toUpperCase());
}
function normVendor(v) {
    const s = clean(v).toLowerCase();
    if (!s) return null;
    if (s.includes('mubas')) return 'Mubas Clothings';
    if (s.includes('pti') || s.includes('plain t')) return 'PTI';
    if (s.includes('ashna')) return 'Ashna Garments';
    if (s.includes('print') && s.includes('wear')) return 'Print Wear';
    if (s.includes('dutees')) return 'Dutees';
    if (s.includes('tpr')) return 'TPR Garments';
    if (/^\d/.test(s)) return null; // stray dates entered as vendor
    return clean(v);
}
function splitMot(v) {
    const raw = clean(v);
    if (!raw) return { mot: null, tracking: null };
    const urlMatch = raw.match(/https?:\/\/\S+/i);
    const tracking = urlMatch ? urlMatch[0] : null;
    const s = raw.toLowerCase();
    let mot = null;
    if (s.includes('st courier') || s === 'st') mot = 'ST Courier';
    else if (s.includes('porter')) mot = 'Porter';
    else if (s.includes('self') && s.includes('pick')) mot = 'Self Pickup';
    else if (s.includes('dtdc')) mot = 'DTDC';
    else if (s.includes('professional')) mot = 'Professional Couriers';
    else if (s.includes('delhivery')) mot = 'Delhivery';
    else if (s.includes('krs')) mot = 'KRS Travels';
    else if (s.includes('avk')) mot = 'AVK Cargo';
    else if (!urlMatch) mot = raw;
    return { mot, tracking };
}

/* ---------- Dates ---------- */
function parseDMY(v) {
    const s = clean(v);
    const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (!m) return null;
    let [, d, mo, y] = m;
    if (y.length === 2) y = '20' + y;
    const dd = String(d).padStart(2, '0'), mm = String(mo).padStart(2, '0');
    if (+mm > 12) return null;
    return `${y}-${mm}-${dd}`;
}
function addDays(iso, n) {
    if (!iso) return null;
    const dt = new Date(iso + 'T00:00:00Z');
    dt.setUTCDate(dt.getUTCDate() + n);
    return dt.toISOString().slice(0, 10);
}
// deadline may be a date, or "4 to 5 days" / "5 days" relative to the order date
function computeDeadline(deadlineRaw, orderIso) {
    const s = clean(deadlineRaw);
    if (!s) return null;
    const asDate = parseDMY(s);
    if (asDate) return asDate;
    const range = s.match(/(\d+)\s*(?:to|-|–|—)\s*(\d+)\s*days?/i);
    if (range && orderIso) return addDays(orderIso, parseInt(range[2], 10));
    const single = s.match(/(\d+)\s*days?/i);
    if (single && orderIso) return addDays(orderIso, parseInt(single[1], 10));
    return null;
}
function parseMoney(v) {
    const s = clean(v).replace(/[₹,\s]/g, '');
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
}
function parseIntSafe(v) {
    const n = parseInt(clean(v).replace(/[^\d]/g, ''), 10);
    return isNaN(n) ? null : n;
}

/* ---------- Map a raw row to a normalized order ---------- */
function extractProduct(desc) {
    if (!desc) return null;
    const m = desc.match(/product:?\*?\s*([^\n]+)/i);
    if (!m) return null;
    const s = m[1].replace(/[*_]/g, '').trim();
    return s ? s.slice(0, 120) : null;
}

function mapRow(h, r) {
    const g = (name) => { const i = h.findIndex(x => x.trim().toLowerCase() === name.toLowerCase()); return i >= 0 ? clean(r[i]) : ''; };
    const orderIso = parseDMY(g('Date'));
    const { mot, tracking } = splitMot(g('MOT'));
    return {
        sl_no: parseIntSafe(g('Sl No')),
        order_date: orderIso,
        customer_name: g('Customer Name') || null,
        contact_number: g('Contact number') || null,
        description: g('Order description') || null,
        product: extractProduct(g('Order description')),
        mock_folder: g('Mock Folder') || null,
        layout_status: normLayout(g('Layout Status')),
        color: g('Color') || null,
        size_breakdown: g('Size') || null,
        qty: parseIntSafe(g('Qty')),
        advance_or_order_date: parseDMY(g('Advance Payment Date / Order Date')) || (g('Advance Payment Date / Order Date') || null),
        deadline_text: g('Deadline Date') || null,
        deadline_at: computeDeadline(g('Deadline Date'), orderIso),
        total_cost: parseMoney(g('Total Cost')),
        notes: g('Notes') || null,
        customer_type: normCustomerType(g('Customer Type')),
        so: normSO(g('SO')),
        payment_status: normPayment(g('Payment Status')),
        status: normStatus(g('Status')),
        vendor: normVendor(g('Vendor')),
        dispatch_date: parseDMY(g('Dispatch Date')),
        mot,
        tracking_link: tracking,
    };
}

const buildDDL = (useSqlite) => `
CREATE TABLE IF NOT EXISTS crewfit_orders (
    id ${useSqlite ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : 'INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY'},
    sl_no INTEGER UNIQUE,
    order_date DATE,
    customer_name TEXT,
    contact_number TEXT,
    description TEXT,
    product TEXT,
    mock_folder TEXT,
    layout_status TEXT DEFAULT 'Pending',
    color TEXT,
    size_breakdown TEXT,
    qty INTEGER,
    advance_or_order_date TEXT,
    deadline_text TEXT,
    deadline_at DATE,
    total_cost NUMERIC,
    notes TEXT,
    customer_type TEXT,
    so TEXT,
    payment_status TEXT DEFAULT 'Pending',
    status TEXT DEFAULT 'Pending',
    vendor TEXT,
    dispatch_date DATE,
    mot TEXT,
    tracking_link TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_crewfit_status ON crewfit_orders(status);
CREATE INDEX IF NOT EXISTS idx_crewfit_deadline ON crewfit_orders(deadline_at);
`;

async function getCsv() {
    if (LOCAL_FILE) return fs.readFileSync(LOCAL_FILE, 'utf8');
    const res = await axios.get(SHEET_CSV_URL, { maxRedirects: 5, responseType: 'text' });
    return res.data;
}

function tally(orders, key) {
    const m = {};
    for (const o of orders) { const v = o[key] || '(blank)'; m[v] = (m[v] || 0) + 1; }
    return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([v, c]) => `${v}:${c}`).join('  ');
}

async function main() {
    const csv = await getCsv();
    const rows = parseCSV(csv);
    const headers = rows[0];
    const dataRows = rows.slice(1).filter(r => r.some(c => c && c.trim()));
    const orders = dataRows.map(r => mapRow(headers, r)).filter(o => o.sl_no != null && o.customer_name);

    console.log(`Parsed ${orders.length} orders.`);
    console.log('\nStatus       :', tally(orders, 'status'));
    console.log('Payment      :', tally(orders, 'payment_status'));
    console.log('Layout       :', tally(orders, 'layout_status'));
    console.log('CustomerType :', tally(orders, 'customer_type'));
    console.log('SO           :', tally(orders, 'so'));
    console.log('Vendor       :', tally(orders, 'vendor'));
    console.log('MOT          :', tally(orders, 'mot'));
    console.log('Deadlines computed:', orders.filter(o => o.deadline_at).length, '/', orders.length);
    console.log('\nSample normalized order:', JSON.stringify({ ...orders[orders.length - 1], description: '…(trimmed)…' }, null, 2));

    if (DRY) { console.log('\n[dry-run] No database changes.'); return; }

    // Shared PostgreSQL connection.
    const db = require('./connection');
    await db.exec(buildDDL(false));

    const cols = ['sl_no','order_date','customer_name','contact_number','description','product','mock_folder','layout_status','color','size_breakdown','qty','advance_or_order_date','deadline_text','deadline_at','total_cost','notes','customer_type','so','payment_status','status','vendor','dispatch_date','mot','tracking_link'];
    let n = 0;
    for (const o of orders) {
        const vals = cols.map(c => o[c] === '' ? null : o[c]);
        const ph = cols.map((_, i) => `$${i + 1}`).join(',');
        const upd = cols.filter(c => c !== 'sl_no').map(c => `${c}=EXCLUDED.${c}`).join(',');
        await db.query(
            `INSERT INTO crewfit_orders (${cols.join(',')}) VALUES (${ph})
             ON CONFLICT (sl_no) DO UPDATE SET ${upd}, updated_at=CURRENT_TIMESTAMP`,
            vals
        );
        n++;
    }
    console.log(`\n✅ Imported/updated ${n} Crewfit orders into Postgres.`);
    if (db.close) await db.close();
}

main().catch(e => { console.error('❌ Import failed:', e.message); process.exit(1); });
