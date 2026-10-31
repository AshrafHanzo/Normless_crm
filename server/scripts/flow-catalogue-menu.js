/**
 * Once: Crewfit's live menu moved onto the catalogue-driven design (services/wa-flow.js
 * CREWFIT_FLOW): products and colours from the catalogue, "how many pieces" as a number, size
 * charts, sample photos, the catalogue PDF and the price list from the menu.
 *
 * The greeting keeps the words it has now. The menu as it was is kept in wa_settings
 * (flow_backup_<key>), so it can be put back.
 *
 *   node scripts/flow-catalogue-menu.js [--dry-run]
 */

const db = require('../db/connection');
const { CREWFIT_FLOW } = require('../services/wa-flow');
const dryRun = process.argv.includes('--dry-run');

async function main() {
    const row = (await db.query('SELECT id, definition FROM wa_flows WHERE key = $1', [CREWFIT_FLOW.key])).rows[0];
    if (!row) { console.log('No live menu — the starter will be created on start-up'); return; }
    const old = JSON.parse(row.definition || '{}');
    const steps = JSON.parse(JSON.stringify(CREWFIT_FLOW.steps));
    if (old.steps?.greet?.text) steps.greet.text = old.steps.greet.text;
    const def = { start: CREWFIT_FLOW.start, steps };
    console.log(`${CREWFIT_FLOW.key}: ${Object.keys(old.steps || {}).length} steps → ${Object.keys(steps).length} steps; greeting kept${dryRun ? ' (dry run)' : ''}`);
    console.log('  path:', 'greet → product (catalogue) → color → quantity (number) → more → branding → logo → summary; info → catalogue | size chart | samples | prices');
    if (dryRun) return;
    await db.query(`INSERT INTO wa_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [`flow_backup_${CREWFIT_FLOW.key}`, row.definition]);
    await db.query('UPDATE wa_flows SET definition = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [row.id, JSON.stringify(def)]);
    console.log('Saved. The old menu is in wa_settings flow_backup_' + CREWFIT_FLOW.key);
}

setTimeout(() => main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); }), 1500);
