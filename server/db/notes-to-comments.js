/**
 * One-time move of crewfit_orders.notes into the order's comment thread.
 *
 * The notes box was one shared field with no author and no date: whoever wrote second either
 * overwrote the first person or left a paragraph nobody could attribute. Comments replace it, so
 * what is already written has to come across — losing it would be worse than the box was.
 *
 * Each note becomes one comment with no author, because there is nobody to name: the column never
 * recorded who typed it. It is dated to when the order was last touched, which is the closest
 * honest answer available. The `notes` column is left in place rather than cleared — a migration
 * that moves data should not also be the thing that destroys the original.
 *
 * Run with --apply to write. Without it, prints what it would move and changes nothing.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env'), quiet: true });
const db = require('./connection');

const APPLY = process.argv.includes('--apply');

(async () => {
    const rows = (await db.query(
        `SELECT o.id, o.sl_no, o.customer_name, o.notes,
                COALESCE(o.updated_at, o.created_at) AS dated
           FROM crewfit_orders o
          WHERE NULLIF(TRIM(o.notes), '') IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM crewfit_order_comments c WHERE c.order_id = o.id)
          ORDER BY o.sl_no`)).rows;

    console.log(`${rows.length} orders carry a note and have no comments yet\n`);
    for (const r of rows.slice(0, 15)) {
        console.log(`  CF-${String(r.sl_no).padEnd(4)} ${String(r.customer_name || '').slice(0, 20).padEnd(21)} ${r.notes.replace(/\s+/g, ' ').slice(0, 70)}`);
    }
    if (rows.length > 15) console.log(`  … and ${rows.length - 15} more`);

    if (!APPLY) { console.log('\nDry run — nothing written. Re-run with --apply.'); process.exit(0); }

    await db.transaction(async (tx) => {
        for (const r of rows) {
            await tx.query(
                `INSERT INTO crewfit_order_comments (order_id, body, created_by, created_at)
                 VALUES ($1, $2, NULL, $3)`,
                [r.id, r.notes.trim(), r.dated]);
        }
    });

    const n = (await db.query('SELECT COUNT(*)::int AS n FROM crewfit_order_comments')).rows[0].n;
    console.log(`\n✓ ${rows.length} notes moved · ${n} comments in total.`);
    console.log('The notes column is untouched; nothing else reads it now.');
    process.exit(0);
})().catch((e) => { console.error('\n✗', e.message); process.exit(1); });
