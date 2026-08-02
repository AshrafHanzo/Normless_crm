const express = require('express');
const db = require('../db/connection');
const { SHIP_ZONES, SHIP_REGIONS, shippingFor } = require('../data/crewfitShipping');

const router = express.Router();

function safeJson(v, fallback) { try { return typeof v === 'string' ? JSON.parse(v) : (v || fallback); } catch { return fallback; } }
const parseQuote = (q) => ({ ...q, line_items: safeJson(q.line_items, []) });

// Tier labels look like "5–10" or "100+"; price is a number or the string "On request".
function parseTierRange(label) {
  const plus = String(label).match(/^(\d+)\+$/);
  if (plus) return { min: parseInt(plus[1], 10), max: Infinity };
  const range = String(label).match(/^(\d+)[–-](\d+)$/);
  if (range) return { min: parseInt(range[1], 10), max: parseInt(range[2], 10) };
  return null;
}
// Returns the per-piece price for a qty, or null when it needs a manual quote (out of tier
// range, or an "On request" tier — e.g. 100+ pieces).
function priceForQty(tiers, qty) {
  for (const [label, price] of (tiers || [])) {
    const r = parseTierRange(label);
    if (r && qty >= r.min && qty <= r.max) return typeof price === 'number' ? price : null;
  }
  return null;
}

async function computeQuote({ items, zoneId }) {
  const ids = [...new Set((items || []).map(it => parseInt(it.product_id, 10)).filter(Number.isFinite))];
  let products = [];
  if (ids.length) {
    const r = await db.query('SELECT id, name, tiers FROM crewfit_products WHERE id = ANY($1::int[])', [ids]);
    products = r.rows.map(p => ({ ...p, tiers: safeJson(p.tiers, []) }));
  }
  const lineItems = (items || []).map(it => {
    const product = products.find(p => p.id === parseInt(it.product_id, 10));
    const qty = Math.max(0, parseInt(it.qty, 10) || 0);
    const pricePerPiece = product ? priceForQty(product.tiers, qty) : null;
    const lineTotal = pricePerPiece != null ? pricePerPiece * qty : 0;
    return {
      product_id: product?.id ?? null, product_name: product?.name || 'Unknown product',
      qty, price_per_piece: pricePerPiece, needs_quote: pricePerPiece == null,
      line_total: lineTotal,
    };
  }).filter(li => li.qty > 0);

  const totalQty = lineItems.reduce((s, li) => s + li.qty, 0);
  const productTotal = lineItems.reduce((s, li) => s + li.line_total, 0);
  const zoneLabel = SHIP_ZONES[zoneId] ? zoneId : null;
  const shippingCharge = zoneLabel ? (shippingFor(zoneLabel, totalQty) || 0) : 0;
  const needsManualQuote = lineItems.length === 0 || lineItems.some(li => li.needs_quote) || !zoneLabel;
  const grandTotal = productTotal + shippingCharge;
  return { lineItems, totalQty, productTotal, shippingCharge, grandTotal, needsManualQuote, zoneLabel };
}

// GET /api/crewfit/quotes/meta — products (with tiers) + shipping zones for the calculator UI
router.get('/meta', async (req, res) => {
  try {
    const r = await db.query('SELECT id, name, category, tiers FROM crewfit_products WHERE active = true ORDER BY sort_order');
    const products = r.rows.map(p => ({ ...p, tiers: safeJson(p.tiers, []) }));
    res.json({ products, zones: SHIP_REGIONS });
  } catch (err) {
    console.error('quotes meta error:', err); res.status(500).json({ error: 'Failed to load calculator data' });
  }
});

// POST /api/crewfit/quotes/calculate — pure calculation, no DB write. Powers the live preview.
router.post('/calculate', async (req, res) => {
  try {
    const result = await computeQuote(req.body || {});
    res.json(result);
  } catch (err) {
    console.error('quote calculate error:', err); res.status(500).json({ error: 'Calculation failed' });
  }
});

// GET /api/crewfit/quotes — recent quotes, newest first
router.get('/', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM crewfit_quotes ORDER BY created_at DESC LIMIT 200');
    res.json({ quotes: r.rows.map(parseQuote) });
  } catch (err) {
    console.error('list quotes error:', err); res.status(500).json({ error: 'Failed to load quotes' });
  }
});

// POST /api/crewfit/quotes — recompute pricing server-side (never trust a client-submitted
// total for something that becomes a real payment link), save it, and generate a Razorpay
// Payment Link the SO can send to the customer.
router.post('/', async (req, res) => {
  try {
    const { customer_name, contact_number, items, zoneId, notes } = req.body || {};
    if (!customer_name || !contact_number) return res.status(400).json({ error: 'Customer name and phone are required' });

    const result = await computeQuote({ items, zoneId });
    if (!result.lineItems.length) return res.status(400).json({ error: 'Add at least one product with a valid quantity' });
    if (result.needsManualQuote) {
      return res.status(400).json({ error: 'One or more items need a manual quote — quantity is outside the automatic pricing range (e.g. below MOQ or 100+ pieces), or no shipping zone was picked. This can\'t become an automatic payment link yet.' });
    }

    let paymentLinkId = null, shortUrl = null, status = 'Draft';
    if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
      const Razorpay = require('razorpay');
      const rzp = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
      const link = await rzp.paymentLink.create({
        amount: Math.round(result.grandTotal * 100),
        currency: 'INR',
        accept_partial: false,
        description: `Crewfit order — ${customer_name} (${result.totalQty} pcs)`,
        customer: { name: customer_name, contact: contact_number },
        notify: { sms: false, email: false },
        reminder_enable: true,
        notes: { source: 'crewfit-quick-calc' },
      });
      paymentLinkId = link.id; shortUrl = link.short_url; status = 'Sent';
    } else {
      console.warn('RAZORPAY_KEY_ID/SECRET not set — saving quote without a payment link');
    }

    const ins = await db.query(
      `INSERT INTO crewfit_quotes
         (customer_name, contact_number, zone_id, zone_label, line_items, product_total, shipping_charge, grand_total, notes, status, razorpay_payment_link_id, razorpay_short_url, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [customer_name, contact_number, zoneId || null, result.zoneLabel, JSON.stringify(result.lineItems),
        result.productTotal, result.shippingCharge, result.grandTotal, notes || null,
        status, paymentLinkId, shortUrl, req.user?.username || null]
    );
    res.status(201).json(parseQuote(ins.rows[0]));
  } catch (err) {
    console.error('create quote error:', err);
    res.status(500).json({ error: err.error?.description || err.message || 'Failed to create quote' });
  }
});

module.exports = router;
