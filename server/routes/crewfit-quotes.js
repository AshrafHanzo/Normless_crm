const express = require('express');
const PDFDocument = require('pdfkit');
const db = require('../db/connection');
const { SHIP_ZONES, SHIP_REGIONS, shippingFor } = require('../data/crewfitShipping');
const { renderQuote } = require('../services/invoice');
const razorpay = require('../config/razorpay');
const { isValidMobile } = require('../utils/phone');
const { tableParams, pagination } = require('../utils/table');

const router = express.Router();

// Client column key → SQL expression. Only these can be sorted on.
const QUOTE_SORTS = {
  customer_name: 'customer_name', status: 'status', grand_total: 'grand_total',
  zone_label: 'zone_label', created_at: 'created_at',
};

const trimText = (v) => { const t = String(v ?? '').trim(); return t || null; };

function safeJson(v, fallback) { try { return typeof v === 'string' ? JSON.parse(v) : (v || fallback); } catch { return fallback; } }
/**
 * A DATE column comes back as a Date at local midnight, and anything that serialises it through
 * UTC lands on the previous day. Read the local parts and hand on a plain 'YYYY-MM-DD' string,
 * which is what a date input wants anyway.
 */
const dateOnly = (v) => {
  if (!v) return null;
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
};
const parseQuote = (q) => ({ ...q, line_items: safeJson(q.line_items, []), delivery_date: dateOnly(q.delivery_date) });

// Tier labels look like "5–10" or "100+"; price is a number or the string "On request".
function parseTierRange(label) {
  const plus = String(label).match(/^(\d+)\+$/);
  if (plus) return { min: parseInt(plus[1], 10), max: Infinity };
  const range = String(label).match(/^(\d+)[–-](\d+)$/);
  if (range) return { min: parseInt(range[1], 10), max: parseInt(range[2], 10) };
  return null;
}
// Returns { price, exact }. exact=true means qty landed cleanly inside a priced tier.
// exact=false with a non-null price means we're suggesting the nearest tier's price as a
// starting point (below MOQ, or beyond the highest priced tier — e.g. an "On request" 100+
// bracket) — the SO can edit it before saving instead of being blocked outright.
function suggestPrice(tiers, qty) {
  const numeric = (tiers || [])
    .map(([label, price]) => ({ range: parseTierRange(label), price }))
    .filter(t => t.range && typeof t.price === 'number');
  for (const t of numeric) {
    if (qty >= t.range.min && qty <= t.range.max) return { price: t.price, exact: true };
  }
  if (!numeric.length) return { price: null, exact: false };
  const below = numeric.filter(t => qty < t.range.min);
  if (below.length) return { price: below[0].price, exact: false }; // closest tier above qty (below MOQ)
  return { price: numeric[numeric.length - 1].price, exact: false }; // closest tier below qty (past the top tier)
}

// Quotes raised before the fabric spec was snapshotted onto their line items have nothing to
// print, so fill those in from the catalog. Only the gaps: a snapshot always wins, otherwise
// editing a product would rewrite the spec on quotes already sent out.
async function withFabric(lineItems) {
  const missing = (lineItems || []).filter(li => li.product_id && !li.gsm && !li.material);
  if (!missing.length) return lineItems;
  const ids = [...new Set(missing.map(li => li.product_id))];
  const r = await db.query('SELECT id, gsm, material FROM crewfit_products WHERE id = ANY($1::int[])', [ids]);
  const byId = new Map(r.rows.map(p => [p.id, p]));
  return lineItems.map(li => {
    const p = (!li.gsm && !li.material) ? byId.get(li.product_id) : null;
    return p ? { ...li, gsm: p.gsm, material: p.material } : li;
  });
}

async function computeQuote({ items, zoneId, shippingCharge: shippingOverride }) {
  const ids = [...new Set((items || []).map(it => parseInt(it.product_id, 10)).filter(Number.isFinite))];
  let products = [];
  if (ids.length) {
    const r = await db.query('SELECT id, name, tiers, gsm, material FROM crewfit_products WHERE id = ANY($1::int[])', [ids]);
    products = r.rows.map(p => ({ ...p, tiers: safeJson(p.tiers, []) }));
  }
  const lineItems = (items || []).map(it => {
    const product = products.find(p => p.id === parseInt(it.product_id, 10));
    const qty = Math.max(0, parseInt(it.qty, 10) || 0);
    const suggested = product ? suggestPrice(product.tiers, qty) : { price: null, exact: false };
    // The SO can type their own price per piece — e.g. after reviewing a suggested/estimated
    // one, or for a negotiated rate — which always wins over the tier-computed price.
    const manualPrice = it.price_per_piece !== undefined && it.price_per_piece !== null && it.price_per_piece !== '' && !isNaN(Number(it.price_per_piece))
      ? Number(it.price_per_piece) : null;
    const pricePerPiece = manualPrice != null ? manualPrice : suggested.price;
    const lineTotal = pricePerPiece != null ? pricePerPiece * qty : 0;
    return {
      product_id: product?.id ?? null, product_name: product?.name || 'Unknown product',
      // Free text on purpose: placements and print methods vary per job and per customer, and a
      // fixed picklist would just get worked around in the notes.
      printing_placement: trimText(it.printing_placement),
      printing_type: trimText(it.printing_type),
      // Snapshotted, not looked up when the PDF is built: a quote must keep saying what was
      // actually quoted even after the catalog entry is edited.
      gsm: product?.gsm || null, material: product?.material || null,
      qty, price_per_piece: pricePerPiece,
      is_estimated: manualPrice == null && !suggested.exact && pricePerPiece != null,
      is_manual: manualPrice != null,
      needs_quote: pricePerPiece == null,
      line_total: lineTotal,
    };
  }).filter(li => li.qty > 0);

  const totalQty = lineItems.reduce((s, li) => s + li.qty, 0);
  const productTotal = lineItems.reduce((s, li) => s + li.line_total, 0);
  const zoneLabel = SHIP_ZONES[zoneId] ? zoneId : null;
  // The zone table gives the usual rate; a typed figure wins, because a bulky consignment or a
  // negotiated courier price is a fact about this job that no table knows.
  const suggestedShipping = zoneLabel ? (shippingFor(zoneLabel, totalQty) || 0) : 0;
  const manualShipping = shippingOverride !== undefined && shippingOverride !== null && shippingOverride !== ''
    && Number.isFinite(Number(shippingOverride)) && Number(shippingOverride) >= 0
    ? Math.round(Number(shippingOverride) * 100) / 100 : null;
  const shippingCharge = manualShipping != null ? manualShipping : suggestedShipping;
  const needsManualQuote = lineItems.length === 0 || lineItems.some(li => li.needs_quote)
    || (!zoneLabel && manualShipping == null);
  // Same 5% GST-on-(product+shipping) rule used for real orders (CrewfitOrderDrawer's default _gstPct).
  const GST_PCT = 5;
  const gstAmount = Math.round((productTotal + shippingCharge) * GST_PCT / 100);
  const grandTotal = productTotal + shippingCharge + gstAmount;
  return {
    lineItems, totalQty, productTotal, shippingCharge, suggestedShipping,
    shippingIsManual: manualShipping != null && manualShipping !== suggestedShipping,
    gstPct: GST_PCT, gstAmount, grandTotal, needsManualQuote, zoneLabel,
  };
}

// Used by the Razorpay webhook (the optional payment-link path) — turns a paid quote row
// directly into a real crewfit_orders row with no manual review step, since payment already
// cleared. The manual "customer said ok" path instead opens the order form pre-filled (see
// client CrewfitQuotes.jsx) so the SO can review before it's actually created.
async function convertQuoteToOrder(quote) {
  const lineItems = safeJson(quote.line_items, []);
  const totalQty = lineItems.reduce((s, li) => s + (Number(li.qty) || 0), 0);
  const orderLineItems = lineItems.map(li => ({
    product: li.product_name, color: '',
    printing: [li.printing_placement, li.printing_type].filter(Boolean).join(' · ') || 'Front & Back',
    qty: li.qty, unit_price: li.price_per_piece, product_total: li.line_total, size_breakdown: '',
  }));
  const productNames = [...new Set(lineItems.map(li => li.product_name))].join(', ');
  const paid = quote.status === 'Paid';

  const nextRow = await db.query('SELECT COALESCE(MAX(sl_no), 0) + 1 AS next FROM crewfit_orders');
  const orderIns = await db.query(
    // A quote paid through Razorpay converts straight to a paid order, so its 7-day deadline
    // starts here; an unpaid one gets its deadline when the advance actually lands.
    `INSERT INTO crewfit_orders
       (sl_no, customer_name, contact_number, product, qty, line_items, product_total, shipping, gst_amount, grand_total, total_cost,
        status, payment_status, layout_status, customer_type, order_date, deadline_at, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'Pending','New',CURRENT_DATE,
             ${paid ? "CURRENT_DATE + INTERVAL '7 days'" : 'NULL'},$14)
     RETURNING id`,
    [nextRow.rows[0].next, quote.customer_name, quote.contact_number, productNames, totalQty,
      JSON.stringify(orderLineItems), quote.product_total, quote.shipping_charge, quote.gst_amount, quote.grand_total, quote.grand_total,
      paid ? 'Pending' : 'Awaiting Payment', paid ? 'Fully Paid' : 'Pending',
      `Auto-created from quote #${quote.id}${paid ? ' (paid via Razorpay)' : ''}`]
  );
  return orderIns.rows[0].id;
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

// GET /api/crewfit/quotes — sorted + paged on the server
router.get('/', async (req, res) => {
  try {
    const { search = '', status = '' } = req.query;
    const t = tableParams(req.query, { sortable: QUOTE_SORTS, defaultSort: 'created_at' });

    const where = [], vals = [];
    if (status) { vals.push(status); where.push(`status = $${vals.length}`); }
    if (search.trim()) {
      vals.push(`%${search.trim()}%`);
      where.push(`(customer_name ILIKE $${vals.length} OR contact_number ILIKE $${vals.length} OR notes ILIKE $${vals.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countRes = await db.query(`SELECT COUNT(*)::int AS n FROM crewfit_quotes ${whereSql}`, vals);
    const total = countRes.rows[0]?.n || 0;

    const r = await db.query(
      `SELECT * FROM crewfit_quotes ${whereSql} ${t.orderBy} LIMIT ${t.limit} OFFSET ${t.offset}`, vals);
    res.json({ quotes: r.rows.map(parseQuote), pagination: pagination(total, t) });
  } catch (err) {
    console.error('list quotes error:', err); res.status(500).json({ error: 'Failed to load quotes' });
  }
});

// POST /api/crewfit/quotes — recompute pricing server-side and save the quote as a Draft.
// No payment link involved — this is just a priced, saveable quote to send the customer.
router.post('/', async (req, res) => {
  try {
    const {
      customer_name, contact_number, items, zoneId, notes, shippingCharge,
      // Optional buyer paperwork. A quote is often raised before any of it exists, so nothing here
      // is required — whatever is missing is simply left off the printed quotation.
      company_name, contact_person, email, gstin, delivery_address, delivery_date,
    } = req.body || {};
    if (!customer_name || !contact_number) return res.status(400).json({ error: 'Customer name and phone are required' });
    if (!isValidMobile(contact_number)) return res.status(400).json({ error: 'Phone must be exactly 10 digits' });

    const result = await computeQuote({ items, zoneId, shippingCharge });
    if (!result.lineItems.length) return res.status(400).json({ error: 'Add at least one product with a valid quantity' });
    if (result.needsManualQuote) {
      return res.status(400).json({ error: 'One or more items still need a price per piece (or no shipping zone was picked) — enter a price for each highlighted item.' });
    }

    const ins = await db.query(
      `INSERT INTO crewfit_quotes
         (customer_name, contact_number, zone_id, zone_label, line_items, product_total, shipping_charge,
          gst_amount, grand_total, notes, status, created_by,
          company_name, contact_person, email, gstin, delivery_address, delivery_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Draft',$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [customer_name, contact_number, zoneId || null, result.zoneLabel, JSON.stringify(result.lineItems),
        result.productTotal, result.shippingCharge, result.gstAmount, result.grandTotal, notes || null,
        req.user?.username || null,
        trimText(company_name), trimText(contact_person), trimText(email), trimText(gstin),
        trimText(delivery_address), delivery_date || null]
    );
    res.status(201).json(parseQuote(ins.rows[0]));
  } catch (err) {
    console.error('create quote error:', err);
    res.status(500).json({ error: err.message || 'Failed to create quote' });
  }
});

// DELETE /api/crewfit/quotes/:id — deleting a quote never touches an order it was already
// converted to (converted_order_id lives only on the quote row); it just removes the quote record.
router.delete('/:id', async (req, res) => {
  try {
    const r = await db.query('DELETE FROM crewfit_quotes WHERE id = $1 RETURNING id', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Quote not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('delete quote error:', err); res.status(500).json({ error: 'Failed to delete quote' });
  }
});

// PUT /api/crewfit/quotes/:id — status bookkeeping (e.g. mark 'Sent' once the WhatsApp
// message actually goes out).
router.put('/:id', async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!['Draft', 'Sent'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const r = await db.query(
      `UPDATE crewfit_quotes SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND status NOT IN ('Paid','Converted') RETURNING *`,
      [status, req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Quote not found or already converted' });
    res.json(parseQuote(r.rows[0]));
  } catch (err) {
    console.error('update quote error:', err); res.status(500).json({ error: 'Failed to update quote' });
  }
});

// POST /api/crewfit/quotes/:id/link-order — the "customer said ok" step. The order itself is
// created through the normal order form (pre-filled from this quote, so the SO can review/edit
// before saving — see CrewfitQuotes.jsx); this just records the link back to the quote once
// that save succeeds.
router.post('/:id/link-order', async (req, res) => {
  try {
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ error: 'orderId is required' });
    const r = await db.query(
      `UPDATE crewfit_quotes SET status = 'Converted', converted_order_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND converted_order_id IS NULL RETURNING *`,
      [orderId, req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Quote not found or already linked to an order' });
    res.json(parseQuote(r.rows[0]));
  } catch (err) {
    console.error('link-order error:', err); res.status(500).json({ error: 'Failed to link quote to order' });
  }
});

// POST /api/crewfit/quotes/:id/payment-link — optional: generate a Razorpay Payment Link for
// an existing quote, for cases where you do want to collect payment up front instead of the
// usual "confirm now, invoice later" flow. Not part of the default quote flow.
router.post('/:id/payment-link', async (req, res) => {
  try {
    if (!razorpay.isConfigured) {
      return res.status(400).json({ error: `Razorpay (${razorpay.MODE} mode) is not configured on this server — set ${razorpay.missingVars().join(' and ')}` });
    }
    const r = await db.query('SELECT * FROM crewfit_quotes WHERE id = $1', [req.params.id]);
    const quote = r.rows[0];
    if (!quote) return res.status(404).json({ error: 'Quote not found' });
    if (quote.converted_order_id) return res.status(400).json({ error: 'This quote was already converted to an order' });

    const rzp = razorpay.client();
    const link = await rzp.paymentLink.create({
      amount: Math.round(Number(quote.grand_total) * 100),
      currency: 'INR',
      accept_partial: false,
      description: `Crewfit order — ${quote.customer_name}`,
      customer: { name: quote.customer_name, contact: quote.contact_number },
      notify: { sms: false, email: false },
      reminder_enable: true,
      notes: { source: 'crewfit-quote', quote_id: String(quote.id) },
    });

    const upd = await db.query(
      `UPDATE crewfit_quotes SET razorpay_payment_link_id = $1, razorpay_short_url = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *`,
      [link.id, link.short_url, quote.id]
    );
    res.json(parseQuote(upd.rows[0]));
  } catch (err) {
    console.error('quote payment-link error:', err);
    res.status(500).json({ error: err.error?.description || err.message || 'Failed to generate payment link' });
  }
});

// GET /api/crewfit/quotes/:id/pdf — a shareable PDF of the quote (not a tax invoice).
router.get('/:id/pdf', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM crewfit_quotes WHERE id = $1', [req.params.id]);
    const quote = r.rows[0];
    if (!quote) return res.status(404).json({ error: 'Quote not found' });
    const parsed = parseQuote(quote);
    parsed.line_items = await withFabric(parsed.line_items);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Quote-${quote.id}-${quote.customer_name.replace(/[^a-z0-9]+/gi, '-')}.pdf"`);
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    doc.pipe(res);
    renderQuote(doc, parsed);
    doc.end();
  } catch (err) {
    console.error('quote pdf error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate quote PDF' });
  }
});

module.exports = router;
module.exports.convertQuoteToOrder = convertQuoteToOrder;
