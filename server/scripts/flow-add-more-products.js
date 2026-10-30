/**
 * Once: the "another product?" question added to menus that already exist.
 *
 * A menu somebody has edited is never overwritten by the starter, so this adds the one new step to
 * it by hand: after the quantity question, "Do you need another product as well?" — Add another
 * product goes back to the product list, That's all carries on to wherever quantity used to lead.
 * Every other step, and its wording, is left exactly as it is. A menu that already has the step, or
 * has no quantity question, is skipped.
 *
 *   node scripts/flow-add-more-products.js [--dry-run]
 */

const db = require('../db/connection');
const dryRun = process.argv.includes('--dry-run');

async function main() {
    const flows = (await db.query('SELECT id, key, name, definition FROM wa_flows ORDER BY id')).rows;
    for (const f of flows) {
        const def = JSON.parse(f.definition || '{}');
        const steps = def.steps || {};
        const qtyId = Object.keys(steps).find(k => steps[k].save_as === 'quantity');
        const productId = Object.keys(steps).find(k => steps[k].save_as === 'product_interest' && steps[k].type === 'list')
            || Object.keys(steps).find(k => steps[k].save_as === 'product_interest');
        if (!qtyId || !productId) { console.log(`${f.key}: no product and quantity questions — left alone`); continue; }
        if (steps.more || Object.values(steps).some(s => s.next?.more === productId)) { console.log(`${f.key}: already asks for another product`); continue; }

        const after = steps[qtyId].next?.['*'] || null;
        steps.more = {
            type: 'buttons',
            text: 'Got it. Do you need another product as well?',
            buttons: [{ id: 'more', title: 'Add another product' }, { id: 'done', title: 'That’s all' }],
            next: { more: productId, ...(after ? { '*': after } : {}) },
        };
        steps[qtyId].next = { ...(steps[qtyId].next || {}), '*': 'more' };
        console.log(`${f.key}: ${qtyId} → more → (${productId} | ${after || 'end'})${dryRun ? ' — dry run, not saved' : ''}`);
        if (!dryRun) await db.query('UPDATE wa_flows SET definition = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [f.id, JSON.stringify({ ...def, steps })]);
    }
}

setTimeout(() => main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); }), 1500);
