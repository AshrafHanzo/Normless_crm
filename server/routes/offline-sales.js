/**
 * Offline sales — anything sold away from Shopify: the counter, an event, a phone call.
 *
 * The catalogue is Shopify's, because it is the same garment either way, and the price starts at
 * Shopify's for the same reason — but it is editable, since an offline sale is exactly where a
 * discount gets given. Everything after the price is ours to record: how it was paid, how it
 * shipped, and what it took off the shelf.
 */

const express = require('express');
const db = require('../db/connection');
const inv = require('../services/inventory');
const razorpay = require('../config/razorpay');
const { hasPermission } = require('../utils/permissions');
const { tableParams, pagination } = require('../utils/table');

const router = express.Router();

router.use(async (req, res, next) => {
  try {
    if (!await hasPermission(req, 'can_view_offline_sales')) return res.status(403).json({ error: 'Access denied' });
    next();
  } catch (err) { next(err); }
});

const canEdit = async (req, res, next) => {
  try {
    if (!await hasPermission(req, 'can_edit_offline_sales')) {
      return res.status(403).json({ error: 'You have read-only access to offline sales' });
    }
    next();
  } catch (err) { next(err); }
};

const isAdmin = (req) => req.user?.role === 'owner' || req.user?.role === 'admin';

const STATUSES = ['Draft', 'Confirmed', 'In Production', 'Dispatched', 'Delivered', 'Cancelled'];
const PAYMENT_METHODS = ['Cash', 'UPI', 'Card', 'Bank transfer', 'Payment link'];
const MOTS = ['Porter', 'Delhivery', 'DTDC', 'Blue Dart', 'India Post', 'Shiprocket', 'Self pickup'];
const NO_TRACKING_MOTS = ['Porter', 'Self pickup'];

const SALE_SORTS = {
  sale_no: 'sale_no', customer_name: 'LOWER(customer_name)', total: 'total',
  status: 'status', payment_status: 'payment_status', created_at: 'created_at',
};

const trim = (v) => { const t = String(v ?? '').trim(); return t || null; };
const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
const safeJson = (v, fallback) => { try { return typeof v === 'string' ? JSON.parse(v || 'null') ?? fallback : (v || fallback); } catch { return fallback; } };
const hydrate = (row) => ({ ...row, items: safeJson(row.items, []), ref: row.sale_no ? `OS${String(row.sale_no).padStart(4, '0')}` : '—' });

/**
 * Price each line, then the sale.
 *
 * Totals are worked out here and never taken from the client: a browser can send whatever it likes,
 * and the figure that gets paid has to be one the server stands behind.
 */
function priceSale(rawItems, { discount, shipping }) {
  const items = (Array.isArray(rawItems) ? rawItems : [])
    .map(it => {
      const qty = parseInt(it.qty, 10) || 0;
      const unit = money(it.unit_price);
      return {
        product: trim(it.product), variant: trim(it.variant),
        shopify_product_id: it.shopify_product_id || null,
        shopify_variant_id: it.shopify_variant_id || null,
        // How many of this line came off the RTO shelf instead of being printed, and which shelf
        // entry they came from. Carried through every save so a re-price never loses it.
        rto_qty: Math.min(parseInt(it.rto_qty, 10) || 0, parseInt(it.qty, 10) || 0),
        rto_id: it.rto_id || null,
        // Kept beside the charged price so a discount is visible as a discount rather than
        // disappearing into a number nobody can check.
        shopify_price: it.shopify_price != null ? money(it.shopify_price) : null,
        blank_type: trim(it.blank_type), color: trim(it.color), size: trim(it.size),
        qty, unit_price: unit, line_total: money(unit * qty),
      };
    })
    .filter(it => it.product && it.qty > 0);

  const subtotal = money(items.reduce((n, it) => n + it.line_total, 0));
  const disc = Math.min(money(discount), subtotal);
  const ship = money(shipping);
  return { items, subtotal, discount: disc, shipping: ship, total: money(subtotal - disc + ship), totalQty: items.reduce((n, it) => n + it.qty, 0) };
}

/**
 * What the RTO shelf could supply for these sales.
 *
 * The same matching rule as the order notices: a returned piece only fits a line for the same
 * design in the same colour and size. Reported per line, because a sale of three things may have
 * one of them already sitting in the building — and printing that one again is the waste this
 * whole shelf exists to prevent.
 */
async function shelfFor(rows) {
  const shelf = await inv.rtoAvailable();
  if (!shelf.length) return {};
  const index = inv.availabilityIndex(shelf);
  const entries = (await db.query(
    `SELECT id, variant_id, product_title, variant, (qty - qty_used - qty_written_off) AS available
       FROM inventory_rto WHERE (qty - qty_used - qty_written_off) > 0
      ORDER BY created_at ASC`)).rows;
  const entryFor = (line) => entries.find(e => (line.variant_id && e.variant_id
    ? String(e.variant_id) === String(line.variant_id)
    : e.product_title === line.product_title && e.variant === line.variant));

  const out = {};
  for (const r of rows) {
    if (r.status === 'Cancelled') continue;
    // Only the part of a line that still has to be made can be filled from the shelf.
    const open = r.items
      .map((it, i) => ({ it, i, left: (parseInt(it.qty, 10) || 0) - (parseInt(it.rto_qty, 10) || 0) }))
      .filter(x => x.left > 0);
    if (!open.length) continue;

    // Matched a line at a time, so every hit keeps the index of the line it belongs to — that
    // index is what a later "use one" call needs in order to mark the right line.
    const lines = [];
    for (const x of open) {
      const hit = inv.matchLine({
        title: x.it.product, variant: x.it.variant,
        shopify_product_id: x.it.shopify_product_id, shopify_variant_id: x.it.shopify_variant_id,
      }, index);
      if (!hit) continue;
      const line = {
        product_title: x.it.product, variant: x.it.variant, qty: x.left,
        available: hit.available, variant_id: hit.variant_id,
        color: hit.color, size: hit.size, blank_type: hit.blank_type,
        item_index: x.i,
      };
      const entry = entryFor(line);
      if (entry) lines.push({ ...line, entry_id: entry.id, entry_available: entry.available });
    }
    if (lines.length) out[r.id] = lines;
  }
  return out;
}

/** Push a sale's current state at blank stock, without ever failing the save that caused it. */
async function applyStock(row) {
  try {
    return await inv.applyOfflineSale(row);
  } catch (err) {
    console.error('offline sale inventory apply failed:', err.message);
    return { error: 'Blank stock could not be updated for this sale' };
  }
}

// GET /api/offline-sales
router.get('/', async (req, res) => {
  try {
    const { status, payment_status, search } = req.query;
    const t = tableParams(req.query, { sortable: SALE_SORTS, defaultSort: 'created_at', tiebreak: 'id' });
    const where = [];
    const vals = [];
    const add = (sql, v) => { vals.push(v); where.push(sql.replace('?', `$${vals.length}`)); };
    if (status) add('status = ?', status);
    if (payment_status) add('payment_status = ?', payment_status);
    // One value against three columns: bind it once and point all three at that placeholder,
    // rather than pushing the same string three times and juggling the indexes.
    if (search) {
      vals.push(`%${search}%`);
      const i = `$${vals.length}`;
      where.push(`(customer_name ILIKE ${i} OR contact_number ILIKE ${i} OR CAST(sale_no AS TEXT) ILIKE ${i})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = parseInt((await db.query(`SELECT COUNT(*) AS n FROM offline_sales ${whereSql}`, vals)).rows[0]?.n) || 0;
    const rows = (await db.query(
      `SELECT * FROM offline_sales ${whereSql} ${t.orderBy} LIMIT $${vals.length + 1} OFFSET $${vals.length + 2}`,
      [...vals, t.limit, t.offset])).rows.map(hydrate);

    const sums = (await db.query(
      `SELECT COUNT(*)::int AS n,
              COALESCE(SUM(total) FILTER (WHERE status <> 'Cancelled'), 0) AS sold,
              COALESCE(SUM(total) FILTER (WHERE payment_status <> 'Paid' AND status <> 'Cancelled'), 0) AS outstanding,
              COALESCE(SUM(total_qty) FILTER (WHERE status <> 'Cancelled'), 0)::int AS units
         FROM offline_sales`)).rows[0] || {};

    // Never let a shelf lookup take the list down with it; the sales matter more than the hint.
    let onShelf = {};
    try { onShelf = await shelfFor(rows); }
    catch (err) { console.error('offline sale RTO check failed:', err.message); }

    res.json({
      sales: rows,
      onShelf,
      pagination: pagination(total, t),
      statuses: STATUSES, paymentMethods: PAYMENT_METHODS, mots: MOTS,
      canEdit: await hasPermission(req, 'can_edit_offline_sales'),
      paymentsEnabled: razorpay.isConfigured,
      summary: { sales: sums.n || 0, sold: Number(sums.sold) || 0, outstanding: Number(sums.outstanding) || 0, units: sums.units || 0 },
    });
  } catch (err) {
    console.error('offline sales list error:', err);
    res.status(500).json({ error: 'Failed to load offline sales' });
  }
});

/**
 * GET /api/offline-sales/catalog — the Shopify products, with their prices and what is on the shelf.
 *
 * Served from the local cache rather than Shopify itself: it is the same catalogue the inventory
 * grid is built from, and a sale being rung up should not wait on an API call.
 */
router.get('/catalog', async (req, res) => {
  try {
    const rows = (await db.query(
      `SELECT p.shopify_id, p.title, p.product_type, p.blank_type,
              v.variant_id, v.variant, v.color, v.size, v.price
         FROM shopify_products p
         LEFT JOIN shopify_variants v ON v.shopify_product_id = p.shopify_id
        ORDER BY p.title, v.variant`)).rows;
    const byId = new Map();
    for (const r of rows) {
      if (!byId.has(r.shopify_id)) {
        byId.set(r.shopify_id, {
          shopify_id: r.shopify_id, title: r.title, product_type: r.product_type,
          blank_type: r.blank_type, variants: [],
        });
      }
      if (r.variant_id) {
        byId.get(r.shopify_id).variants.push({
          variant_id: r.variant_id, variant: r.variant, color: r.color, size: r.size,
          price: r.price != null ? Number(r.price) : null,
        });
      }
    }
    // Availability by variant, so picking a colour and size can say "there is one of these on
    // the shelf" at the moment the choice is made rather than after the sale is saved.
    const shelf = {};
    for (const r of await inv.rtoAvailable()) {
      if (r.variant_id) shelf[String(r.variant_id)] = r.available;
    }
    res.json({ products: [...byId.values()].filter(p => p.variants.length), shelf });
  } catch (err) {
    console.error('offline sales catalog error:', err);
    res.status(500).json({ error: 'Failed to load the product catalog' });
  }
});

// POST /api/offline-sales
router.post('/', canEdit, async (req, res) => {
  try {
    const b = req.body || {};
    if (!trim(b.customer_name)) return res.status(400).json({ error: 'Customer name is required' });
    const priced = priceSale(b.items, b);
    if (!priced.items.length) return res.status(400).json({ error: 'Add at least one product with a quantity' });
    const status = STATUSES.includes(b.status) ? b.status : 'Draft';

    const r = await db.query(
      `INSERT INTO offline_sales (sale_no, customer_name, contact_number, email, address, items, total_qty,
                                  subtotal, discount, shipping, total, status, notes, created_by)
       VALUES ((SELECT COALESCE(MAX(sale_no), 0) + 1 FROM offline_sales), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [trim(b.customer_name), trim(b.contact_number), trim(b.email), trim(b.address),
        JSON.stringify(priced.items), priced.totalQty, priced.subtotal, priced.discount,
        priced.shipping, priced.total, status, trim(b.notes), req.user?.username || null]);
    const stock = await applyStock(r.rows[0]);
    res.status(201).json({ ...hydrate(r.rows[0]), inventory: stock });
  } catch (err) {
    console.error('offline sale create error:', err);
    res.status(500).json({ error: 'Failed to create the sale' });
  }
});

// PUT /api/offline-sales/:id
router.put('/:id', canEdit, async (req, res) => {
  try {
    const b = req.body || {};
    const current = (await db.query('SELECT * FROM offline_sales WHERE id = $1', [req.params.id])).rows[0];
    if (!current) return res.status(404).json({ error: 'Sale not found' });
    if (b.status && !STATUSES.includes(b.status)) return res.status(400).json({ error: 'Unknown status' });
    if (b.mot && !MOTS.includes(b.mot)) return res.status(400).json({ error: 'Unknown delivery method' });

    const priced = priceSale(b.items ?? safeJson(current.items, []), {
      discount: b.discount ?? current.discount, shipping: b.shipping ?? current.shipping,
    });
    if (!priced.items.length) return res.status(400).json({ error: 'Add at least one product with a quantity' });

    const status = b.status || current.status;
    const mot = b.mot !== undefined ? trim(b.mot) : current.mot;
    const awb = b.awb !== undefined ? trim(b.awb) : current.awb;
    if (status === 'Dispatched' && !awb && !NO_TRACKING_MOTS.includes(mot)) {
      return res.status(400).json({ error: 'Add a tracking ID, or set the delivery method to Porter or Self pickup' });
    }

    const r = await db.query(
      `UPDATE offline_sales SET customer_name=$1, contact_number=$2, email=$3, address=$4, items=$5,
              total_qty=$6, subtotal=$7, discount=$8, shipping=$9, total=$10, status=$11, notes=$12,
              mot=$13, awb=$14, tracking_link=$15, dispatch_date=$16, updated_at=CURRENT_TIMESTAMP
        WHERE id=$17 RETURNING *`,
      [trim(b.customer_name) || current.customer_name, trim(b.contact_number), trim(b.email), trim(b.address),
        JSON.stringify(priced.items), priced.totalQty, priced.subtotal, priced.discount, priced.shipping,
        priced.total, status, trim(b.notes), mot, awb,
        b.tracking_link !== undefined ? trim(b.tracking_link) : current.tracking_link,
        status === 'Dispatched' ? (b.dispatch_date || current.dispatch_date || new Date().toISOString().slice(0, 10)) : (b.dispatch_date || current.dispatch_date),
        req.params.id]);
    const stock = await applyStock(r.rows[0]);
    res.json({ ...hydrate(r.rows[0]), inventory: stock });
  } catch (err) {
    console.error('offline sale update error:', err);
    res.status(500).json({ error: 'Failed to update the sale' });
  }
});

/**
 * POST /api/offline-sales/:id/take-from-rto { rto_id, item_index, qty }
 *
 * Fill part of a sale from a piece already on the shelf. Nothing is printed for it, so no blank is
 * spent — and none is credited either: the blank behind that garment was spent when it was first
 * made. If the sale had already deducted for the line, re-applying gives that deduction back,
 * which is the whole saving.
 */
router.post('/:id/take-from-rto', canEdit, async (req, res) => {
  try {
    const sale = (await db.query('SELECT * FROM offline_sales WHERE id = $1', [req.params.id])).rows[0];
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    if (sale.status === 'Cancelled') return res.status(409).json({ error: 'This sale is cancelled' });

    const items = safeJson(sale.items, []);
    const idx = parseInt(req.body?.item_index, 10);
    const line = items[idx];
    if (!line) return res.status(400).json({ error: 'That line is no longer on the sale' });

    const want = parseInt(req.body?.qty, 10) || 1;
    const left = (parseInt(line.qty, 10) || 0) - (parseInt(line.rto_qty, 10) || 0);
    if (want > left) return res.status(400).json({ error: `Only ${left} of that line still needs making` });

    const ref = sale.sale_no ? `OS${String(sale.sale_no).padStart(4, '0')}` : `OS#${sale.id}`;
    const took = await inv.takeRtoPiece(req.body?.rto_id, want, ref,
      'Sold over the counter — no blank was spent', req.user?.username);
    if (took.error) return res.status(took.status || 400).json({ error: took.error });

    items[idx] = { ...line, rto_qty: (parseInt(line.rto_qty, 10) || 0) + want, rto_id: took.rto_id };
    const r = await db.query(
      'UPDATE offline_sales SET items = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
      [JSON.stringify(items), sale.id]);
    const stock = await applyStock(r.rows[0]);
    res.json({ ...hydrate(r.rows[0]), inventory: stock, took });
  } catch (err) {
    console.error('offline sale take-from-rto error:', err);
    res.status(500).json({ error: 'Failed to take that piece from the shelf' });
  }
});

/**
 * POST /api/offline-sales/:id/payment — record what was taken, or raise a link to send.
 *
 * Both, because both happen: cash over the counter and a link on WhatsApp are equally normal here,
 * and pretending one is the other loses the only record of how the money actually arrived.
 */
router.post('/:id/payment', canEdit, async (req, res) => {
  try {
    const sale = (await db.query('SELECT * FROM offline_sales WHERE id = $1', [req.params.id])).rows[0];
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    const mode = req.body?.mode === 'link' ? 'link' : 'record';

    if (mode === 'link') {
      const amount = Number(req.body?.amount ?? sale.total);
      if (!(amount > 0)) return res.status(400).json({ error: 'Amount must be greater than zero' });
      if (amount < 1) return res.status(400).json({ error: 'Razorpay will not take less than ₹1' });
      const link = await razorpay.client().paymentLink.create({
        amount: Math.round(amount * 100),
        currency: 'INR',
        accept_partial: false,
        description: `Offline sale ${sale.sale_no ? `OS${String(sale.sale_no).padStart(4, '0')}` : ''}`.trim().slice(0, 2048),
        customer: {
          name: sale.customer_name || 'Customer',
          ...(sale.contact_number ? { contact: `+91${String(sale.contact_number).replace(/\D/g, '').slice(-10)}` } : {}),
          ...(sale.email ? { email: sale.email } : {}),
        },
        notify: { sms: false, email: false },
        reminder_enable: true,
        notes: { source: 'normless-offline', sale_id: String(sale.id) },
      });
      const r = await db.query(
        `UPDATE offline_sales SET razorpay_payment_link_id=$1, razorpay_short_url=$2,
                payment_method='Payment link', updated_at=CURRENT_TIMESTAMP WHERE id=$3 RETURNING *`,
        [link.id, link.short_url, sale.id]);
      return res.json({ ...hydrate(r.rows[0]), link: link.short_url });
    }

    const method = req.body?.method;
    if (!PAYMENT_METHODS.includes(method)) return res.status(400).json({ error: 'Pick how the money was taken' });
    const paid = Number(req.body?.amount ?? sale.total);
    if (!(paid > 0)) return res.status(400).json({ error: 'Amount must be greater than zero' });
    // Anything short of the total is a part payment, and saying so is the point of recording it.
    const state = paid + 0.001 >= Number(sale.total) ? 'Paid' : 'Partial';

    const r = await db.query(
      `UPDATE offline_sales SET payment_status=$1, payment_method=$2, payment_ref=$3, paid_amount=$4,
              paid_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=$5 RETURNING *`,
      [state, method, trim(req.body?.reference), paid, sale.id]);
    res.json(hydrate(r.rows[0]));
  } catch (err) {
    console.error('offline sale payment error:', err);
    res.status(500).json({ error: err?.error?.description || err.message || 'Failed to record the payment' });
  }
});

/** POST /api/offline-sales/:id/payment/sync — ask Razorpay whether the link has been paid. */
router.post('/:id/payment/sync', canEdit, async (req, res) => {
  try {
    const sale = (await db.query('SELECT * FROM offline_sales WHERE id = $1', [req.params.id])).rows[0];
    if (!sale) return res.status(404).json({ error: 'Sale not found' });
    if (!sale.razorpay_payment_link_id) return res.status(400).json({ error: 'No payment link on this sale' });

    const link = await razorpay.client().paymentLink.fetch(sale.razorpay_payment_link_id);
    if (link.status !== 'paid') return res.json({ ...hydrate(sale), settled: false, link_status: link.status });

    const paid = (link.amount_paid || 0) / 100;
    const r = await db.query(
      `UPDATE offline_sales SET payment_status='Paid', payment_method='Payment link',
              paid_amount=$1, paid_at=COALESCE(paid_at, CURRENT_TIMESTAMP), payment_ref=COALESCE(payment_ref,$2),
              updated_at=CURRENT_TIMESTAMP WHERE id=$3 RETURNING *`,
      [paid, link.id, sale.id]);
    res.json({ ...hydrate(r.rows[0]), settled: true });
  } catch (err) {
    console.error('offline sale payment sync error:', err);
    res.status(500).json({ error: err?.error?.description || 'Failed to check the payment link' });
  }
});

// DELETE /api/offline-sales/:id — owner/admin only, and it gives back anything still held.
router.delete('/:id', canEdit, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Only the account owner can do this' });
  try {
    const sale = (await db.query('SELECT sale_no FROM offline_sales WHERE id = $1', [req.params.id])).rows[0];
    const ref = sale?.sale_no ? `OS${String(sale.sale_no).padStart(4, '0')}` : `OS#${req.params.id}`;
    await inv.releaseOfflineSale(req.params.id, ref);
    const r = await db.query('DELETE FROM offline_sales WHERE id = $1 RETURNING id', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Sale not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('offline sale delete error:', err);
    res.status(500).json({ error: 'Failed to delete the sale' });
  }
});

module.exports = router;
