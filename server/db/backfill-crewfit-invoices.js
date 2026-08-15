/**
 * One-time migration: promote Crewfit tax documents out of crewfit_orders.invoices (JSONB) into
 * the crewfit_invoices table, and classify each one under the advance/final split the auditor
 * settled on.
 *
 *   - a "balance" invoice becomes the order's TAX INVOICE, re-stated at the FULL order value
 *     (it was issued at full payment, which is exactly when the tax invoice is now due)
 *   - an "advance" invoice becomes a PROFORMA, marked `reclassified` — it was sent as a tax
 *     invoice before the split existed, and the number cannot be recalled from the customer
 *   - an order that is fully paid with no invoice at all is reported, not invented: issuing its
 *     number is a business action, not a migration's job
 *
 * Also derives place_of_supply per order and proposes an HSN per catalog product.
 *
 * Run with --apply to write. Without it, prints exactly what it would do and changes nothing.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env'), quiet: true });
const db = require('../db/connection');

const APPLY = process.argv.includes('--apply');

// GST state codes — the first two digits of a GSTIN identify the state, which is the most
// reliable place of supply we have for a B2B order.
const STATE_BY_CODE = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka',
  '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
};
const STATE_NAMES = [...new Set(Object.values(STATE_BY_CODE))];

// PIN prefix (first three digits) → state. Far more reliable than looking for a state name in the
// address: order #5 reads "Near Kerala furniture, Madurai ... Tamilnadu", and a name match filed a
// Tamil Nadu sale under Kerala. Narrow ranges come first because several sit inside broader ones
// (605 Puducherry inside Tamil Nadu, 682 Lakshadweep inside Kerala, 814–835 Jharkhand inside Bihar).
const PIN_RANGES = [
  [160, 160, 'Chandigarh'], [403, 403, 'Goa'], [605, 605, 'Puducherry'], [682, 682, 'Lakshadweep'],
  [737, 737, 'Sikkim'], [744, 744, 'Andaman and Nicobar Islands'], [248, 263, 'Uttarakhand'],
  [814, 835, 'Jharkhand'], [110, 110, 'Delhi'], [121, 136, 'Haryana'], [140, 152, 'Punjab'],
  [171, 177, 'Himachal Pradesh'], [180, 194, 'Jammu and Kashmir'], [201, 285, 'Uttar Pradesh'],
  [301, 345, 'Rajasthan'], [360, 396, 'Gujarat'], [400, 445, 'Maharashtra'],
  [450, 488, 'Madhya Pradesh'], [490, 497, 'Chhattisgarh'], [500, 509, 'Telangana'],
  [515, 535, 'Andhra Pradesh'], [560, 591, 'Karnataka'], [600, 643, 'Tamil Nadu'],
  [670, 695, 'Kerala'], [700, 743, 'West Bengal'], [751, 770, 'Odisha'], [781, 788, 'Assam'],
  [790, 792, 'Arunachal Pradesh'], [793, 794, 'Meghalaya'], [795, 795, 'Manipur'],
  [796, 796, 'Mizoram'], [797, 798, 'Nagaland'], [799, 799, 'Tripura'], [800, 855, 'Bihar'],
];
const stateForPin = (pin) => (PIN_RANGES.find(([lo, hi]) => pin >= lo && pin <= hi) || [])[2] || null;

/** Six digits, tolerating the space people write mid-pincode ("600 018"). Last one wins. */
function pinIn(text) {
  const hits = String(text).match(/\b(\d{3})\s?(\d{3})\b/g) || [];
  if (!hits.length) return null;
  return parseInt(hits[hits.length - 1].replace(/\s/g, '').slice(0, 3), 10);
}

/** A state name, but only near the end where addresses actually put it, and ignoring spacing
 *  so "Tamilnadu" matches "Tamil Nadu". */
function trailingState(addr) {
  const tail = String(addr).slice(-40).toLowerCase().replace(/[^a-z]/g, '');
  return STATE_NAMES.find(s => tail.includes(s.toLowerCase().replace(/[^a-z]/g, ''))) || null;
}

// Last resort for addresses written without a pincode. Reported separately in the output because
// a city name is weaker evidence than a GSTIN or a PIN, and place of supply picks the tax head.
const CITY_STATE = {
  chennai: 'Tamil Nadu', coimbatore: 'Tamil Nadu', madurai: 'Tamil Nadu', trichy: 'Tamil Nadu',
  tiruchirappalli: 'Tamil Nadu', salem: 'Tamil Nadu', erode: 'Tamil Nadu', tirupur: 'Tamil Nadu',
  vellore: 'Tamil Nadu', thanjavur: 'Tamil Nadu', bengaluru: 'Karnataka', bangalore: 'Karnataka',
  mumbai: 'Maharashtra', pune: 'Maharashtra', hyderabad: 'Telangana', kolkata: 'West Bengal',
  ahmedabad: 'Gujarat', kochi: 'Kerala', cochin: 'Kerala', trivandrum: 'Kerala',
};
function cityState(addr) {
  const hay = String(addr).toLowerCase();
  const hit = Object.keys(CITY_STATE).find(c => hay.includes(c));
  return hit ? { state: CITY_STATE[hit], city: hit } : null;
}

// Orders whose address names neither a state, a pincode nor a city, resolved by hand and
// confirmed before this ran. #15/#17 are "Valasaravakkam" and #21 is "CH- 87" — all Chennai.
const CONFIRMED_STATE = { 15: 'Tamil Nadu', 17: 'Tamil Nadu', 21: 'Tamil Nadu' };

// Proposed HSN per catalog product. Tees and polos are different headings, and these are a
// starting point for the auditor to confirm — every one is editable in the catalog afterwards.
const HSN_RULES = [
  [/hood|sweat/i, '61102000'], // sweatshirts/pullovers, of cotton
  [/polo|collar/i, '61051000'], // men's shirts, knitted, of cotton
  [/./, '61091000'],           // t-shirts/singlets, of cotton — the Normless default
];
const hsnFor = (name) => HSN_RULES.find(([re]) => re.test(name))[1];

const J = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : (v || []); } catch { return []; } };
const money = (v) => Number(v || 0);

/** GSTIN first, then the pincode, then a state name at the tail of the address. */
function placeOfSupply(order) {
  const code = (order.gst_number || '').slice(0, 2);
  if (STATE_BY_CODE[code]) return { state: STATE_BY_CODE[code], from: `GSTIN ${code}` };

  const addr = order.billing_address || order.delivery_location || '';
  const pin = pinIn(addr);
  const byPin = pin ? stateForPin(pin) : null;
  if (byPin) return { state: byPin, from: `PIN ${pin}xxx` };

  const byName = trailingState(addr);
  if (byName) return { state: byName, from: 'address tail' };

  const byCity = cityState(addr);
  if (byCity) return { state: byCity.state, from: `city ${byCity.city}`, weak: true };

  // Confirmed by hand: three addresses name only a Chennai suburb ("Valasaravakkam", "CH- 87").
  // Listed explicitly rather than adding suburbs to the city map, which would over-fit the
  // lookup to this one dataset.
  if (CONFIRMED_STATE[order.sl_no]) return { state: CONFIRMED_STATE[order.sl_no], from: 'confirmed by hand', weak: true };
  return { state: null, from: 'UNKNOWN' };
}

/** Indian financial year label for a YYYY-MM-DD date: 2026-08-14 → "26-27". */
function fyOf(ymd) {
  const [y, m] = ymd.split('-').map(Number);
  const s = m >= 4 ? y : y - 1;
  return `${String(s % 100).padStart(2, '0')}-${String((s + 1) % 100).padStart(2, '0')}`;
}
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

(async () => {
  const orders = (await db.query(`
    SELECT id, sl_no, customer_name, billing_name, billing_address, delivery_location, gst_number,
           order_date, dispatch_date, status, payment_status, line_items, invoices,
           product_total, shipping, gst_amount, grand_total
      FROM crewfit_orders ORDER BY sl_no`)).rows;

  const plan = [];       // rows to insert into crewfit_invoices
  const states = [];     // place_of_supply per order
  const unresolved = []; // things a human has to decide

  for (const o of orders) {
    const invoices = J(o.invoices);
    const pos = placeOfSupply(o);
    states.push({ sl: o.sl_no, name: o.customer_name, gstin: o.gst_number, ...pos });
    if (!pos.state) unresolved.push(`#${o.sl_no} ${o.customer_name}: no place of supply could be derived`);

    const qty = J(o.line_items).reduce((s, it) => s + (parseInt(it.qty, 10) || 0), 0);
    const fullTaxable = money(o.product_total) + money(o.shipping);
    const fullGst = money(o.gst_amount);
    const fullGross = money(o.grand_total);

    const balance = invoices.find(i => i.type === 'balance');
    const advances = invoices.filter(i => i.type === 'advance');

    if (balance) {
      // Re-stated at the full order value: the register carries one tax invoice per order.
      plan.push({
        order_id: o.id, sl: o.sl_no, doc_type: 'tax_invoice', number: balance.number,
        issue_date: balance.date, status: 'issued', qty,
        taxable: fullTaxable, gst_pct: balance.gst_pct, gst_amount: fullGst, gross: fullGross,
        place_of_supply: pos.state, gstin: o.gst_number,
        note: `Re-stated from the balance invoice to the full order value (was ${balance.amount})`,
        was: `balance ${balance.amount}`,
      });
    } else if (o.payment_status === 'Fully Paid') {
      unresolved.push(`#${o.sl_no} ${o.customer_name} (${fullGross}): fully paid with no invoice — needs a new number issued from the app, not by this migration`);
    }

    for (const a of advances) {
      plan.push({
        order_id: o.id, sl: o.sl_no, doc_type: 'proforma', number: a.number,
        issue_date: a.date, status: 'reclassified', qty: null,
        taxable: money(a.taxable_value), gst_pct: a.gst_pct, gst_amount: money(a.gst_amount), gross: money(a.amount),
        place_of_supply: pos.state, gstin: o.gst_number,
        note: 'Issued as a tax invoice before the advance/final split; reclassified as a proforma receipt',
        was: `advance ${a.amount}`,
      });
    }
  }

  const products = (await db.query('SELECT id, name, hsn FROM crewfit_products ORDER BY sort_order')).rows;

  // ---- report -------------------------------------------------------------
  console.log(`\n=== Documents (${plan.length}) ===`);
  console.log('sl  | type        | number             | date       | status       | gross    | was');
  for (const p of plan) {
    console.log(
      String(p.sl).padStart(3), '|', p.doc_type.padEnd(11), '|', p.number.padEnd(18), '|',
      p.issue_date, '|', p.status.padEnd(12), '|', String(p.gross).padStart(8), '|', p.was);
  }
  const tax = plan.filter(p => p.doc_type === 'tax_invoice');
  console.log(`\ntax invoices: ${tax.length}   proformas (reclassified): ${plan.length - tax.length}`);
  console.log(`tax invoice total (gross): ${tax.reduce((s, p) => s + p.gross, 0)}`);

  console.log(`\n=== Place of supply (${states.length} orders) ===`);
  for (const s of states) {
    console.log(String(s.sl).padStart(3), '|', String(s.state || '??').padEnd(12), '|',
      String(s.from).padEnd(16), '|', s.weak ? 'CHECK |' : '      |', s.name);
  }
  const weak = states.filter(s => s.weak);
  if (weak.length) console.log(`\n  ${weak.length} derived from a city name only (no GSTIN, no pincode) — worth an eyeball: ${weak.map(s => '#' + s.sl).join(', ')}`);

  console.log(`\n=== Proposed HSN (${products.length} products) ===`);
  for (const p of products) console.log('  ', String(p.name).padEnd(30), '→', hsnFor(p.name), p.hsn ? `(currently ${p.hsn})` : '');

  if (unresolved.length) {
    console.log(`\n=== Needs a decision (${unresolved.length}) ===`);
    unresolved.forEach(u => console.log('  -', u));
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to commit.');
    process.exit(0);
  }

  // ---- apply --------------------------------------------------------------
  await db.transaction(async (tx) => {
    for (const p of plan) {
      const fy = fyOf(ymd(p.issue_date));
      const series = p.doc_type === 'tax_invoice' ? 'CREWFIT' : 'PRO';
      const seq = parseInt(String(p.number).split('/').pop(), 10) || null;
      await tx.query(
        `INSERT INTO crewfit_invoices
           (order_id, doc_type, number, series, fy, seq, issue_date, status, note, qty,
            taxable, gst_pct, gst_amount, gross, place_of_supply, gstin)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (number) DO NOTHING`,
        [p.order_id, p.doc_type, p.number, series, fy, seq, ymd(p.issue_date), p.status, p.note, p.qty,
          p.taxable, p.gst_pct, p.gst_amount, p.gross, p.place_of_supply, p.gstin]
      );
    }
    for (const s of states) {
      if (s.state) await tx.query('UPDATE crewfit_orders SET place_of_supply = $1 WHERE sl_no = $2 AND place_of_supply IS NULL', [s.state, s.sl]);
    }
    for (const p of products) {
      if (!p.hsn) await tx.query('UPDATE crewfit_products SET hsn = $1 WHERE id = $2', [hsnFor(p.name), p.id]);
    }
  });

  const n = (await db.query('SELECT doc_type, count(*)::int AS n FROM crewfit_invoices GROUP BY doc_type')).rows;
  console.log('\nAPPLIED. crewfit_invoices now holds:', JSON.stringify(n));
  process.exit(0);
})().catch(e => { console.error('backfill failed:', e.message); process.exit(1); });
