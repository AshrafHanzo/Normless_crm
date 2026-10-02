/**
 * One-off: bring the open rows of the customer support sheet into the CRM.
 *
 * Only what is still open. A closed ticket is history the sheet already records, and copying nine
 * hundred settled rows in would bury the twenty-odd that somebody still has to do something about
 * — which is the whole reason this moved out of a spreadsheet.
 *
 * Marketing rows are not touched: seeding orders are raised and tracked on the Marketing page, and
 * were only ever in the same workbook because it was one workbook.
 *
 * Dry run by default — nothing is written without --apply.
 *
 *     node server/db/import-support-tickets.js "Customer Support ... - CS - EFF 09042025.csv"
 *     node server/db/import-support-tickets.js "<file>.csv" --apply
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const db = require('./connection');

const APPLY = process.argv.includes('--apply');
const FILE = process.argv.slice(2).find(a => !a.startsWith('--'));

/** A CSV reader that understands quoted fields with commas and newlines inside them. */
function parseCsv(text) {
    const rows = [];
    let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
            } else field += c;
            continue;
        }
        if (c === '"') { quoted = true; continue; }
        if (c === ',') { row.push(field); field = ''; continue; }
        if (c === '\r') continue;
        if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
        field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    const head = rows.shift().map(h => h.trim().replace(/^﻿/, ''));
    return rows.map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

const trim = (v) => { const t = String(v ?? '').trim(); return t || null; };
/** The sheet writes dates as M/D/YYYY. */
const date = (v) => {
    const m = String(v || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    const [, mm, dd, yyyy] = m;
    return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
};
// "#5687", "10611" and "#11484 " are all the same shape of thing.
const orderKey = (v) => { const d = String(v || '').match(/\d{3,}/); return d ? `#${d[0]}` : null; };
// Waybills are written "RAWB - 4454…", sometimes two of them in one cell.
const awb = (v) => trim(String(v || '').replace(/\b[FR]AWB\b\s*-?\s*/gi, '').trim()) || null;

const SOURCE = { whatsapp: 'WhatsApp', email: 'Email', instagram: 'Instagram', phone: 'Phone' };
// The sheet's reason wording, mapped onto the list the CRM offers. Anything unrecognised is kept
// as written rather than dropped — a reason nobody can read is still better than a blank.
const REASON = {
    'size change': 'Size Change', 'address update': 'Address update',
    'initiate return': 'Initiate Return', 'initiate replacement': 'Initiate Replacement',
    'initiate refund': 'Initiate Refund', 'failed shipment': 'Failed Shipment',
    'order cancelled': 'Order Cancelled', 'manual order': 'Other',
};

async function main() {
    if (!FILE || !fs.existsSync(FILE)) {
        console.error('Pass the exported CS sheet as a .csv — the file was not found.');
        process.exit(1);
    }
    const rows = parseCsv(fs.readFileSync(FILE, 'utf8'));

    // Still open: the sheet's own answer, in its own column. Rows with nothing but the aging
    // formula in them are the spreadsheet's empty tail, not tickets.
    const open = rows.filter((r) => {
        const closed = (r['Ticket Status'] || '').toLowerCase() === 'closed';
        const hasSomething = orderKey(r['Order ID']) || trim(r['Comments']) || trim(r['Nature of request']);
        return !closed && hasSomething;
    });

    const tickets = open.map((r) => ({
        order_number: orderKey(r['Order ID']),
        customer_name: null,
        customer_phone: trim(r['Customer Phone No']),
        customer_email: trim(r['Email']),
        source: SOURCE[(r['Query Source'] || '').toLowerCase()] || (trim(r['Query Source']) ? 'Other' : null),
        nature: trim(r['Nature of request']),
        reason: REASON[(r['Reason'] || '').toLowerCase()] || trim(r['Reason']),
        payment_status: trim(r['RR Payment Status']),
        request: trim(r['Comments']),
        // The sheet left rows open with the work marked Completed. Finished work is a finished
        // ticket here, so they land in Closed — with the day the sheet says it was settled.
        status: trim(r['Overall status']) === 'Completed' ? 'Closed' : 'Open',
        progress: ['Pending', 'In Progress', 'Completed'].includes(trim(r['Overall status'])) ? trim(r['Overall status']) : 'Pending',
        action: trim(r['Operations comment']),
        // The sheet's second free-text column, which operations used for what they actually did.
        ops_note: trim(r['Comment']),
        forward_awb: awb(r['FAWB']),
        return_awb: awb(r['RAWB']),
        assigned_to: trim(r['Assigned to']),
        raised_on: date(r['Request Date']) || date(r['Date']),
        resolved_on: trim(r['Overall status']) === 'Completed' ? date(r['Resolved Date']) : null,
    })).filter(t => t.raised_on || t.order_number);

    for (const t of tickets) if (!t.raised_on) t.raised_on = '2026-09-26';   // undated jottings, latest sheet date

    // The sheet never held the customer's name. We do — fill it in from the order where the order
    // is still one we hold, so a ticket arrives with somebody's name on it rather than a number.
    const numbers = tickets.map(t => t.order_number).filter(Boolean);
    const known = new Map((await db.query(
        `SELECT o.order_number, c.first_name, c.last_name, c.email, c.phone
           FROM orders o LEFT JOIN customers c ON c.shopify_id = o.customer_shopify_id
          WHERE o.order_number = ANY($1)`, [numbers])).rows.map(r => [r.order_number, r]));
    let named = 0;
    for (const t of tickets) {
        const c = known.get(t.order_number);
        if (!c) continue;
        const name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
        if (name && !t.customer_name) { t.customer_name = name; named++; }
        t.customer_email = t.customer_email || trim(c.email);
        t.customer_phone = t.customer_phone || trim(c.phone);
    }
    const unknown = tickets.filter(t => t.order_number && !known.has(t.order_number)).map(t => t.order_number);

    console.log(`Rows in the sheet      : ${rows.length}`);
    console.log(`Still open             : ${tickets.length}`);
    console.log(`  with no request text : ${tickets.filter(t => !t.request).length}`);
    console.log(`  with an order number : ${tickets.filter(t => t.order_number).length}`);
    console.log(`  named from the order : ${named}`);
    if (unknown.length) console.log(`  order not in the CRM : ${unknown.join(' ')}   (check these numbers)`);
    console.log('');
    for (const t of tickets) {
        console.log(`  ${t.raised_on}  ${(t.order_number || '—').padEnd(8)} ${(t.nature || '—').padEnd(28)} ${(t.action || '—').padEnd(24)} ${(t.request || '').slice(0, 44)}`);
    }

    // Already imported? Matched on the order and the day it was raised, which is what makes two
    // rows the same ticket. Re-running must never double the list.
    const existing = new Set((await db.query(
        `SELECT COALESCE(order_number,'') || '|' || TO_CHAR(raised_on,'YYYY-MM-DD') AS k FROM support_tickets`
    )).rows.map(r => r.k));
    const fresh = tickets.filter(t => !existing.has(`${t.order_number || ''}|${t.raised_on}`));
    console.log(`\nAlready in the CRM     : ${tickets.length - fresh.length}`);
    console.log(`To insert              : ${fresh.length}`);

    if (!APPLY) { console.log('\nDry run — nothing written. Re-run with --apply.'); await db.close(); return; }

    let n = 0;
    for (const t of fresh) {
        const cols = Object.keys(t).filter(c => t[c] !== null);
        await db.transaction(async (tx) => {
            await tx.query(`SELECT pg_advisory_xact_lock(hashtext('support_ticket_ref'))`);
            const next = (await tx.query('SELECT COALESCE(MAX(ref_no), 0) + 1 AS n FROM support_tickets')).rows[0].n;
            await tx.query(
                `INSERT INTO support_tickets (ref_no, created_by, ${cols.join(', ')})
                 VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')})`,
                [next, 'sheet import', ...cols.map(c => t[c])]);
        });
        n++;
    }
    console.log(`\n✅ Imported ${n} open ticket${n === 1 ? '' : 's'}.`);
    await db.close();
}

main().catch(async (e) => { console.error(e); try { await db.close(); } catch { /* already closed */ } process.exit(1); });
