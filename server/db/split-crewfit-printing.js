/**
 * One-time rename inside crewfit_orders.line_items: `printing` → `printing_placement`.
 *
 * Printing used to be one field. Now that the floor does DTF and embroidery, where the artwork
 * goes and how it is applied are separate questions, and the order form asks both — matching the
 * quote, which has always had the two. The reading code falls back to the old key, but leaving two
 * spellings of the same fact in the data is how drift starts, so the stored lines are brought over
 * in one go.
 *
 * `printing_type` is deliberately left blank on old lines: nobody recorded it, and guessing it
 * would put an invention in the order history. The form asks for it the next time the order is
 * edited.
 *
 * Run with --apply to write. Without it, prints what it would change and changes nothing.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env'), quiet: true });
const db = require('./connection');

const APPLY = process.argv.includes('--apply');
const parse = (v) => { try { return typeof v === 'string' ? JSON.parse(v || '[]') : (v || []); } catch { return []; } };

(async () => {
    const rows = (await db.query(
        'SELECT id, sl_no, line_items FROM crewfit_orders WHERE line_items IS NOT NULL ORDER BY sl_no')).rows;

    const changes = [];
    for (const row of rows) {
        const items = parse(row.line_items);
        if (!Array.isArray(items) || !items.length) continue;
        if (!items.some(it => it && Object.prototype.hasOwnProperty.call(it, 'printing'))) continue;

        const next = items.map(it => {
            if (!it || !Object.prototype.hasOwnProperty.call(it, 'printing')) return it;
            const { printing, ...rest } = it;
            // A line already carrying a placement keeps it — the new field wins over the old one.
            return { ...rest, printing_placement: rest.printing_placement ?? printing ?? '' };
        });
        changes.push({ id: row.id, sl_no: row.sl_no, next, was: items.map(it => it?.printing).join(' | ') });
    }

    console.log(`${rows.length} orders with line items · ${changes.length} still using the old key`);
    for (const c of changes.slice(0, 10)) console.log(`  CF-${String(c.sl_no).padEnd(4)} ${c.was}`);
    if (changes.length > 10) console.log(`  … and ${changes.length - 10} more`);

    if (!APPLY) { console.log('\nDry run — nothing written. Re-run with --apply.'); process.exit(0); }

    await db.transaction(async (tx) => {
        for (const c of changes) {
            await tx.query('UPDATE crewfit_orders SET line_items = $1 WHERE id = $2', [JSON.stringify(c.next), c.id]);
        }
    });

    const left = (await db.query(
        `SELECT COUNT(*)::int AS n FROM crewfit_orders WHERE line_items::text LIKE '%"printing"%'`)).rows[0].n;
    const moved = (await db.query(
        `SELECT COUNT(*)::int AS n FROM crewfit_orders WHERE line_items::text LIKE '%printing_placement%'`)).rows[0].n;
    console.log(`\n✓ ${changes.length} orders updated · ${moved} now carry a placement · ${left} still on the old key`);
    process.exit(left ? 1 : 0);
})().catch((e) => { console.error('\n✗', e.message); process.exit(1); });
