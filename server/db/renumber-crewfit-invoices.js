/**
 * One-time renumbering of the Crewfit document series, so each starts at 0001 with no gaps.
 *
 * Before this, the two kinds of document shared one sequence: tax invoices ran 0014–0027 with
 * holes, and the holes were the advance documents now reclassified as proformas. Numbers
 * 0001–0006 were lost entirely with deleted orders.
 *
 * After:
 *   CREWFIT/<fy>/0001…  tax invoices only, in date order, consecutive
 *   PRO/<fy>/0001…      proformas only, in date order, consecutive
 *
 * Every row keeps its old number in `note`, because a renumbered tax series has to be explainable:
 * an auditor comparing a customer's copy against the register needs the mapping.
 *
 * Numbers are assigned in two passes through a temporary value. A direct update would collide —
 * tax invoice 0027 wants 0010, which a proforma still holds until it moves.
 *
 * Run with --apply to write. Without it, prints the mapping and changes nothing.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env'), quiet: true });
const db = require('../db/connection');

const APPLY = process.argv.includes('--apply');
const pad = (n) => String(n).padStart(4, '0');

(async () => {
    const rows = (await db.query(`
        SELECT i.id, i.number, i.doc_type, i.status, i.fy, i.gstin,
               TO_CHAR(i.issue_date,'YYYY-MM-DD') AS issue_date, i.gross, i.note,
               o.sl_no, o.customer_name
          FROM crewfit_invoices i
          LEFT JOIN crewfit_orders o ON o.id = i.order_id
         WHERE i.status <> 'cancelled'
         ORDER BY i.issue_date, i.id`)).rows;

    // Date order, so the series reads chronologically the way an auditor expects.
    const byDate = (a, b) => (a.issue_date < b.issue_date ? -1 : a.issue_date > b.issue_date ? 1 : a.id - b.id);
    const taxInvoices = rows.filter(r => r.doc_type === 'tax_invoice').sort(byDate);
    const proformas = rows.filter(r => r.doc_type === 'proforma').sort(byDate);

    const plan = [
        ...taxInvoices.map((r, i) => ({ ...r, series: 'CREWFIT', seq: i + 1, next: `CREWFIT/${r.fy}/${pad(i + 1)}` })),
        ...proformas.map((r, i) => ({ ...r, series: 'PRO', seq: i + 1, next: `PRO/${r.fy}/${pad(i + 1)}` })),
    ];
    const changed = plan.filter(p => p.number !== p.next);

    const show = (list, title) => {
        console.log(`\n=== ${title} (${list.length}) ===`);
        console.log('old                  ->  new                  date        gross     order');
        for (const p of list) {
            console.log(p.number.padEnd(20), '-> ', p.next.padEnd(20), p.issue_date,
                String(p.gross).padStart(8), ' CF-' + p.sl_no,
                p.number === p.next ? '(unchanged)' : '', p.gstin ? '[B2B — must be re-sent]' : '');
        }
    };
    show(plan.filter(p => p.doc_type === 'tax_invoice'), 'Tax invoices');
    show(plan.filter(p => p.doc_type === 'proforma'), 'Proformas');

    console.log(`\n${changed.length} of ${plan.length} documents change number.`);
    const b2b = changed.filter(p => p.gstin);
    console.log(`B2B documents needing a corrected copy: ${b2b.length ? b2b.map(p => `${p.next} (CF-${p.sl_no})`).join(', ') : 'none'}`);
    console.log(`Next tax invoice will be CREWFIT/26-27/${pad(taxInvoices.length + 1)}; next proforma PRO/26-27/${pad(proformas.length + 1)}.`);

    if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply to commit.'); process.exit(0); }

    await db.transaction(async (tx) => {
        // Pass 1: park every number on a value nothing can collide with.
        for (const p of plan) {
            await tx.query('UPDATE crewfit_invoices SET number = $1 WHERE id = $2', [`TMP-${p.id}`, p.id]);
        }
        // Pass 2: assign the final numbers, recording where each came from.
        for (const p of plan) {
            const note = p.number === p.next ? p.note
                : [p.note, `Renumbered from ${p.number} when the series was reset to start at 0001`].filter(Boolean).join('. ');
            await tx.query(
                `UPDATE crewfit_invoices SET number = $1, series = $2, seq = $3, note = $4,
                        updated_at = CURRENT_TIMESTAMP WHERE id = $5`,
                [p.next, p.series, p.seq, note, p.id]);
        }
        // The sequences must continue past what has been issued, or the next document collides.
        await tx.query('SELECT setval($1, $2, true)', ['crewfit_invoice_seq', taxInvoices.length]);
        await tx.query('SELECT setval($1, $2, true)', ['crewfit_proforma_seq', proformas.length]);

        // The order's legacy `invoices` JSONB is no longer read by the app, but leaving stale
        // numbers in it would be a trap for anyone who looks at the row later.
        const remap = new Map(plan.map(p => [p.number, p.next]));
        const orders = (await tx.query("SELECT id, invoices FROM crewfit_orders WHERE invoices IS NOT NULL AND invoices::text <> '[]'")).rows;
        for (const o of orders) {
            let list; try { list = typeof o.invoices === 'string' ? JSON.parse(o.invoices) : o.invoices; } catch { continue; }
            if (!Array.isArray(list)) continue;
            const next = list.map(i => (remap.has(i.number) ? { ...i, number: remap.get(i.number) } : i));
            await tx.query('UPDATE crewfit_orders SET invoices = $1 WHERE id = $2', [JSON.stringify(next), o.id]);
        }
    });

    const after = (await db.query(
        `SELECT series, MIN(seq) AS lo, MAX(seq) AS hi, COUNT(*)::int AS n
           FROM crewfit_invoices WHERE status <> 'cancelled' GROUP BY series ORDER BY series`)).rows;
    console.log('\nAPPLIED.');
    after.forEach(s => console.log(`  ${s.series}: ${s.n} documents, ${pad(s.lo)}–${pad(s.hi)}`));
    process.exit(0);
})().catch(e => { console.error('renumber failed:', e.message); process.exit(1); });
