/**
 * One-time numbering of September 2026 — the month the NL series went shared and real-time.
 *
 * Before the switch, Shopify orders were numbered at month-end and Crewfit B2C invoices sat on
 * their own CREWFIT series. Both halves of September issued so far are numbered here in ONE
 * batch, sorted the way the auditor filed August by hand — by date, Crewfit invoices ahead of
 * that day's Shopify orders — so the month reads as if the shared series had been live all along.
 * From the next sync cycle on, services/invoice-numbers.js keeps it current.
 *
 * Run after realign-gst-to-filed-return.js (which moves the B2B invoices to NLCF and leaves the
 * B2C ones on the old series for this script to pick up). --apply writes; otherwise a dry run.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env'), quiet: true });
const db = require('./connection');
const numbering = require('../services/invoice-numbers');

const APPLY = process.argv.includes('--apply');

(async () => {
    const b2c = (await db.query(
        `SELECT i.id, i.number, i.seq, i.gstin, TO_CHAR(i.issue_date,'YYYY-MM-DD') AS issue_date, i.gross, o.sl_no, o.billing_name
           FROM crewfit_invoices i JOIN crewfit_orders o ON o.id = i.order_id
          WHERE i.doc_type = 'tax_invoice' AND i.status <> 'cancelled' AND i.series = 'CREWFIT'
          ORDER BY i.seq`)).rows;
    const stray = b2c.filter(i => (i.gstin || '').trim());
    if (stray.length) throw new Error(`B2B invoices still on the old series — run realign-gst-to-filed-return.js first: ${stray.map(i => i.number).join(', ')}`);

    const shop = (await db.query(
        `SELECT o.order_number AS name, TO_CHAR(o.created_at, 'YYYY-MM-DD') AS date
           FROM orders o
          WHERE UPPER(COALESCE(o.fulfillment_status, '')) = 'FULFILLED'
            AND o.created_at::date >= $1
            AND NOT EXISTS (SELECT 1 FROM gst_invoice_numbers g WHERE g.order_name = o.order_number)
          ORDER BY regexp_replace(o.order_number, '\\D', '', 'g')::bigint`, [numbering.AUTO_NUMBER_FROM])).rows;

    const items = [
        ...b2c.map(i => ({ order_name: `CF-${i.sl_no}`, date: i.issue_date, kind: 'crewfit', tiebreak: i.id })),
        ...shop.map(numbering.shopifyItem),
    ];
    const last = (await db.query(`SELECT MAX(seq) AS n FROM gst_invoice_numbers WHERE fy = '26-27'`)).rows[0].n;
    console.log(`${b2c.length} Crewfit B2C invoices + ${shop.length} fulfilled Shopify orders since ${numbering.AUTO_NUMBER_FROM}; NL series currently ends at ${last}`);

    if (!APPLY) {
        // Same sort the issuer applies, so the dry run shows the exact order the numbers will fall in.
        const rank = { crewfit: 0, shopify: 1 };
        const sorted = [...items].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || rank[a.kind] - rank[b.kind] || a.tiebreak - b.tiebreak);
        let seq = parseInt(last, 10);
        console.log('\nCrewfit rows and their neighbours:');
        sorted.forEach((it, i) => {
            it.next = numbering.formatNumber('NL', ++seq, '26-27');
            if (it.kind === 'crewfit') {
                const prev = sorted[i - 1], next = sorted[i + 1];
                console.log(`  ${it.order_name.padEnd(7)} ${it.date}  -> ${it.next.padEnd(16)} between ${prev ? `${prev.order_name} (${prev.date})` : 'start'} and ${next ? `${next.order_name} (${next.date})` : 'end'}`);
            }
        });
        console.log(`\nShopify orders would take ${sorted.filter(i => i.kind === 'shopify').length} numbers up to ${sorted.at(-1)?.next}.`);
        console.log('\nDry run — nothing written. Re-run with --apply.');
        process.exit(0);
    }

    await db.transaction(async (tx) => {
        const numbers = await numbering.issueNormlessNumbers(tx, items);
        for (const i of b2c) {
            const number = numbers.get(`CF-${i.sl_no}`);
            const { seq } = numbering.parseNumber(number);
            await tx.query(
                `UPDATE crewfit_invoices SET number = $1, series = 'NL', seq = $2,
                        note = CONCAT_WS(E'\\n', NULLIF(note, ''), $3), updated_at = CURRENT_TIMESTAMP
                  WHERE id = $4`,
                [number, seq, `Renumbered from ${i.number} — B2C, filed in the Normless register`, i.id]);
            console.log(`  ${`CF-${i.sl_no}`.padEnd(7)} ${i.number}  ->  ${number}`);
        }
    });
    // From here the sync keeps the series current on its own.
    await db.query(
        `INSERT INTO sync_state (key, value, updated_at) VALUES ($1, 'on', NOW())
         ON CONFLICT (key) DO UPDATE SET value = 'on', updated_at = NOW()`, [numbering.SWITCH]);
    console.log('✓ Real-time invoice numbering switched on for the sync.');

    const now = (await db.query(`SELECT MAX(seq) AS n, COUNT(*) FILTER (WHERE order_date >= $1) AS m FROM gst_invoice_numbers WHERE fy = '26-27'`, [numbering.AUTO_NUMBER_FROM])).rows[0];
    console.log(`\n✓ NL series now ends at ${now.n}; ${now.m} numbers dated ${numbering.AUTO_NUMBER_FROM} or later.`);
    process.exit(0);
})().catch((e) => { console.error('\n✗', e.message); process.exit(1); });
