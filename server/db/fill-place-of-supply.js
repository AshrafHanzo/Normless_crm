/**
 * One-time fill of crewfit_orders.place_of_supply for orders saved while the field had no way
 * of being set (it was neither on the form nor in the editable columns), and of the invoices
 * issued against them. A blank place of supply is filed as inter-state, so every one of these
 * would go into the return as IGST whether or not the customer is in Tamil Nadu.
 *
 * Invoices already in a filed return (before September 2026) are left as filed and listed
 * instead — correcting a filed tax head is the auditor's call, not a migration's.
 *
 * Run with --apply to write. Without it, prints what it would do and changes nothing.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env'), quiet: true });
const db = require('./connection');
const { derivePlaceOfSupply } = require('../utils/place-of-supply');

const APPLY = process.argv.includes('--apply');
const FILED_THROUGH = '2026-08-31';
const HOME = 'Tamil Nadu';

(async () => {
    const orders = (await db.query(
        `SELECT id, sl_no, customer_name, gst_number, billing_address, delivery_location
           FROM crewfit_orders WHERE NULLIF(TRIM(place_of_supply), '') IS NULL ORDER BY sl_no`)).rows;

    console.log(`${orders.length} orders without a place of supply\n`);
    console.log('order   state                      read from        customer');
    const plan = orders.map(o => {
        const d = derivePlaceOfSupply(o);
        const state = d.state || HOME;
        console.log(`CF-${String(o.sl_no).padEnd(4)} ${state.padEnd(26)} ${(d.state ? d.from : 'default (nothing to go on)').padEnd(16)} ${o.customer_name || ''}${d.weak ? '   ⚠ weak evidence' : ''}`);
        return { ...o, state };
    });

    const invoices = (await db.query(
        `SELECT i.id, i.number, i.order_id, TO_CHAR(i.issue_date,'YYYY-MM-DD') AS issue_date
           FROM crewfit_invoices i
          WHERE NULLIF(TRIM(i.place_of_supply), '') IS NULL AND i.status <> 'cancelled'
            AND i.doc_type = 'tax_invoice' AND i.order_id = ANY($1)`, [orders.map(o => o.id)])).rows;
    const stateFor = new Map(plan.map(p => [p.id, p.state]));
    const fillable = invoices.filter(i => i.issue_date > FILED_THROUGH);
    const filed = invoices.filter(i => i.issue_date <= FILED_THROUGH);

    console.log(`\n${fillable.length} invoices from September on will take the order's state.`);
    if (filed.length) {
        console.log(`\n${filed.length} invoices are already in a filed return with a blank place of supply (filed as IGST) — left as filed, for the auditor:`);
        for (const i of filed) console.log(`  ${i.number.padEnd(22)} ${i.issue_date}  should be ${stateFor.get(i.order_id)}`);
    }

    if (!APPLY) { console.log('\nDry run — nothing written. Re-run with --apply.'); process.exit(0); }

    await db.transaction(async (tx) => {
        for (const p of plan) await tx.query('UPDATE crewfit_orders SET place_of_supply = $1 WHERE id = $2', [p.state, p.id]);
        for (const i of fillable) await tx.query('UPDATE crewfit_invoices SET place_of_supply = $1 WHERE id = $2', [stateFor.get(i.order_id), i.id]);
    });
    console.log(`\n✓ ${plan.length} orders and ${fillable.length} invoices updated.`);
    process.exit(0);
})().catch((e) => { console.error('\n✗', e.message); process.exit(1); });
