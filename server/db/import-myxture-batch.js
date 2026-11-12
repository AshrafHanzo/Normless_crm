/**
 * Record a Myxture bulk-order sheet that was uploaded to their portal by hand, as a batch, so its
 * orders count as sent and never show up as ready again.
 *
 *   node server/db/import-myxture-batch.js "<sheet.csv>"            # dry run: shows the matching
 *   node server/db/import-myxture-batch.js "<sheet.csv>" --apply    # writes it
 *
 * Each row is matched to an order line by order number and size, the colour in the Design file
 * (GTA-6-Beige → Beige) deciding between two lines of the same size. A product the sheet names
 * that isn't mapped to Myxture yet is mapped from the row — product type, fabric, design file —
 * so the jerseys start appearing in the tab from then on.
 *
 * Safe to run twice: lines already in a batch are skipped.
 */
const fs = require('fs');
const path = require('path');
const db = require('./connection');
const inv = require('../services/inventory');
const mx = require('../services/myxture');
const { parseCsv } = require('../utils/csv');

const file = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!file) { console.error('Usage: node server/db/import-myxture-batch.js <sheet.csv> [--apply]'); process.exit(1); }

const norm = (s) => String(s || '').trim().toLowerCase();

(async () => {
    const rows = parseCsv(fs.readFileSync(path.resolve(file), 'utf8'));
    const head = rows.shift().map(h => h.trim());
    const col = (name) => head.indexOf(name);
    for (const c of ['Order number', 'Product type', 'Variant 1', 'Variant 2', 'Qty', 'Design file']) {
        if (col(c) === -1) throw new Error(`Column "${c}" is missing — is this the Myxture bulk-order sheet?`);
    }
    const data = rows.filter(r => r.some(v => String(v).trim()))
        .map(r => ({
            order: String(r[col('Order number')]).trim().replace(/^#/, ''),
            product_type: String(r[col('Product type')]).trim(),
            fabric: String(r[col('Variant 1')]).trim(),
            size: mx.normSize(r[col('Variant 2')]),
            qty: parseInt(r[col('Qty')], 10) || 1,
            design_file: String(r[col('Design file')]).trim(),
        }));

    const existingMaps = new Map((await mx.mappings({ activeOnly: false })).map(m => [String(m.shopify_product_id), m]));
    const newMaps = new Map();
    const lines = new Map();          // order|line_key → line
    const problems = [];

    for (const row of data) {
        const o = (await db.query(
            'SELECT shopify_id, order_number, line_items_json FROM orders WHERE order_number = ANY($1)',
            [[`#${row.order}`, row.order]])).rows[0];
        if (!o) { problems.push(`${row.order}: order not found in the CRM`); continue; }

        const colour = norm(row.design_file.split('-').pop());
        const items = inv.safeItems(o).map(i => ({ ...i, ...mx.splitVariant(i.variant) }));
        let cands = items.filter(i => i.size === row.size);
        if (cands.length > 1) {
            const byColour = cands.filter(i => norm(`${i.title} ${i.variant}`).includes(colour));
            if (byColour.length) cands = byColour;
        }
        if (cands.length > 1) {
            const jerseys = cands.filter(i => /jersey/i.test(i.title));
            if (jerseys.length) cands = jerseys;
        }
        if (cands.length !== 1) {
            problems.push(`${row.order} ${row.size} ${row.design_file}: ${cands.length ? 'more than one' : 'no'} matching line`);
            continue;
        }
        const item = cands[0];
        const pid = String(item.shopify_product_id || '');

        // The mapping: a design file ending in the variant's own colour becomes a {color} template,
        // so one Shopify product sold in Beige and Black maps to both files.
        if (pid && !existingMaps.has(pid)) {
            const templ = item.color && norm(item.color) === colour
                ? row.design_file.slice(0, row.design_file.length - colour.length) + '{color}'
                : row.design_file;
            const prev = newMaps.get(pid);
            if (prev && prev.design_file !== templ) {
                problems.push(`${row.order}: product ${item.title} maps to both ${prev.design_file} and ${templ}`);
            } else if (!prev) {
                newMaps.set(pid, { shopify_product_id: pid, title: item.title, product_type: row.product_type,
                    fabric: row.fabric, design_file: templ });
            }
        }

        const key = `${o.shopify_id}|${mx.lineKeyOf(item)}`;
        const prev = lines.get(key);
        if (prev) { prev.qty += row.qty; continue; }
        lines.set(key, {
            order_shopify_id: String(o.shopify_id), order_number: o.order_number, line_key: mx.lineKeyOf(item),
            shopify_product_id: item.shopify_product_id || null, shopify_variant_id: item.shopify_variant_id || null,
            title: item.title, variant: item.variant, color: item.color, size: item.size || row.size, qty: row.qty,
            product_type: row.product_type, fabric: row.fabric, design_file: row.design_file,
        });
    }

    // Already in a batch — a second run, or exported from the tab since.
    const sent = new Set((await db.query(
        `SELECT l.order_shopify_id || '|' || l.line_key AS k FROM myxture_batch_lines l
           JOIN myxture_batches b ON b.id = l.batch_id WHERE b.voided_at IS NULL`)).rows.map(r => r.k));
    const toAdd = [...lines.entries()].filter(([k]) => !sent.has(k)).map(([, l]) => l);

    console.log(`\nSheet rows: ${data.length}   matched lines: ${lines.size}   already in a batch: ${lines.size - toAdd.length}`);
    console.log('\nNew product mappings:');
    if (!newMaps.size) console.log('  (none)');
    for (const m of newMaps.values()) console.log(`  ${m.shopify_product_id}  ${m.title}  →  ${m.product_type} / ${m.fabric} / ${m.design_file}`);
    console.log('\nLines to record:');
    for (const l of toAdd) console.log(`  ${l.order_number}  ${l.title} (${l.variant})  x${l.qty}  →  ${l.design_file}`);
    if (problems.length) { console.log('\nNot matched:'); for (const p of problems) console.log('  ' + p); }

    if (!APPLY) { console.log('\nDry run — nothing written. Re-run with --apply to record it.'); process.exit(0); }
    if (problems.length) { console.log('\nFix the rows above first; nothing written.'); process.exit(1); }

    await db.transaction(async (c) => {
        for (const m of newMaps.values()) {
            await c.query(
                `INSERT INTO myxture_products (shopify_product_id, title, product_type, fabric, design_file, updated_by)
                 VALUES ($1,$2,$3,$4,$5,'import') ON CONFLICT (shopify_product_id) DO NOTHING`,
                [m.shopify_product_id, m.title, m.product_type, m.fabric, m.design_file]);
        }
        if (!toAdd.length) return;
        await c.query("SELECT pg_advisory_xact_lock(hashtext('myxture_batch'))");
        const no = (await c.query('SELECT COALESCE(MAX(batch_no), 0) + 1 AS n FROM myxture_batches')).rows[0].n;
        const b = (await c.query(
            `INSERT INTO myxture_batches (batch_no, source, note, created_by)
             VALUES ($1, 'import', $2, 'import') RETURNING id`,
            [no, `Uploaded to the portal by hand: ${path.basename(file)}`])).rows[0];
        for (const l of toAdd) await mx.insertLine(c, b.id, l);
        console.log(`\nRecorded ${mx.batchRef(no)} with ${toAdd.length} lines.`);
    });
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
