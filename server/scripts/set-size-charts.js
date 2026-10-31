/**
 * Once: each product's size chart, from the catalogue PDF's pages.
 *
 * The pages are rendered elsewhere (pdftoppm -jpeg -scale-to-x 1600 -f 3 -l 13 catalogue.pdf page)
 * and copied to a folder on the server; this files each one under its product as chart_url. A
 * product that already has a chart is left alone, so an uploaded one is never replaced. The print
 * placement page goes to the setting the menu shows when it asks about branding.
 *
 *   node scripts/set-size-charts.js <folder of page-NN.jpg> [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const db = require('../db/connection');

// Catalogue V6: page → product, by the product's name in the catalogue.
const PAGES = {
    'page-03.jpg': 'Poly Cotton Polos',
    'page-04.jpg': 'Mars fabric polo',
    'page-05.jpg': 'Classic Cotton Polos',
    'page-06.jpg': 'Tipping Polo',
    'page-07.jpg': 'Regular Fit T-Shirt',
    'page-08.jpg': 'Oversized T-Shirts',
    'page-09.jpg': 'Unisex Oversized Tees',
    'page-10.jpg': 'Toddlers & Kids Round Neck',
    'page-11.jpg': 'Toddlers & Kids Collar Neck',
    'page-12.jpg': 'Caps',
};
const PLACEMENT = 'page-13.jpg';

const folder = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
const OUT = path.join(__dirname, '..', 'uploads', 'crewfit', 'products');

async function main() {
    if (!folder || !fs.existsSync(folder)) throw new Error('Give the folder holding page-NN.jpg');
    fs.mkdirSync(OUT, { recursive: true });
    for (const [file, name] of Object.entries(PAGES)) {
        const src = path.join(folder, file);
        const p = (await db.query('SELECT id, chart_url FROM crewfit_products WHERE LOWER(name) = LOWER($1)', [name])).rows[0];
        if (!fs.existsSync(src)) { console.log(`${file}: missing`); continue; }
        if (!p) { console.log(`${file}: no product named ${name}`); continue; }
        if (p.chart_url) { console.log(`${name}: already has a size chart`); continue; }
        const stored = `${p.id}-chart-${file}`;
        console.log(`${name}: ${file}${dryRun ? ' (dry run)' : ''}`);
        if (dryRun) continue;
        fs.copyFileSync(src, path.join(OUT, stored));
        await db.query('UPDATE crewfit_products SET chart_url = $2 WHERE id = $1', [p.id, `/uploads/crewfit/products/${stored}`]);
    }
    const placement = path.join(folder, PLACEMENT);
    if (fs.existsSync(placement) && !dryRun) {
        fs.copyFileSync(placement, path.join(OUT, 'print-placement.jpg'));
        await db.query(`INSERT INTO wa_settings (key, value) VALUES ('print_placement_url', '/uploads/crewfit/products/print-placement.jpg')
                        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
        console.log('Print placement guide saved');
    }
}

setTimeout(() => main().then(() => process.exit(0), (err) => { console.error(err.message); process.exit(1); }), 1500);
