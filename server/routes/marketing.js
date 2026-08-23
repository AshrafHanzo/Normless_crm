/**
 * Influencer marketing — the creator roster and the seeding orders raised against it.
 *
 * Two teams share these rows, which is what the split permissions are about: marketing owns the
 * creator, the address and what is being sent; production owns the shipping partner, AWB and
 * tracking. Anyone on the page can read both halves; only `can_dispatch_marketing` can write the
 * production half.
 */

const express = require('express');
const db = require('../db/connection');
const { hasPermission } = require('../utils/permissions');
const inv = require('../services/inventory');
const { fetchProducts } = require('../services/shopify');
const { validatePhoneFields } = require('../utils/phone');
const { tableParams, pagination } = require('../utils/table');

const router = express.Router();

const CONTENT_TYPES = ['Gym content', 'GRWM content', 'Lifestyle content', 'Review content', 'Other'];
const COLLAB_TYPES = ['Barter', 'Paid', 'Barter / Paid'];
const PLATFORMS = ['Instagram', 'YouTube', 'Facebook', 'X'];
// Mirrors the sheet's own vocabulary, plus the two ends the sheet only implies.
// An order is raised by marketing, signed off by someone with the authority, then shipped by
// production. "Pending Approval" and "Dispatch Pending" name what each stage is waiting on.
const STATUSES = ['Pending Approval', 'Dispatch Pending', 'Dispatched', 'Delivered', 'Cancelled'];
const AWAITING_APPROVAL = 'Pending Approval';
const APPROVED = 'Dispatch Pending';
const CLOSED = ['Delivered', 'Cancelled'];
// "Offline" in the sheet means the creator collected in person — no courier, no AWB.
const SHIPPING_PARTNERS = ['Delhivery', 'DTDC', 'Blue Dart', 'India Post', 'Shiprocket', 'Offline'];
const NO_AWB_PARTNERS = ['Offline'];

// Client column key → SQL expression. Only these can be sorted on.
const INFLUENCER_SORTS = {
  name: 'LOWER(i.name)', content_type: 'i.content_type', profile_url: 'i.profile_url',
  collab_type: 'i.collab_type', location: 'i.location', total_content: 'i.total_content',
  payment_per_video: 'i.payment_per_video', order_count: 'COUNT(o.id)', created_at: 'i.created_at',
};
const MK_ORDER_SORTS = {
  ref_no: 'ref_no', name: 'LOWER(name)', total_qty: 'total_qty', order_date: 'order_date',
  status: 'status', shipping_partner: 'shipping_partner', awb: 'awb', fulfilled_date: 'fulfilled_date',
};

router.use(async (req, res, next) => {
  try {
    if (!await hasPermission(req, 'can_view_marketing')) {
      return res.status(403).json({ error: 'Access denied' });
    }
    next();
  } catch (err) { next(err); }
});

const isAdmin = (req) => req.user?.role === 'owner' || req.user?.role === 'admin';
const canDispatch = (req) => hasPermission(req, 'can_dispatch_marketing');
const canApprove = (req) => hasPermission(req, 'can_approve_marketing');

const parseJson = (raw, fallback) => { try { return JSON.parse(raw || 'null') ?? fallback; } catch { return fallback; } };
const trim = (v) => String(v ?? '').trim();
const nullable = (v) => (trim(v) ? trim(v) : null);
const pad = (n) => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');

/** "M010" — the internal reference the sheet uses for orders that never touched Shopify. */
const refLabel = (row) => (row?.ref_no ? `M${String(row.ref_no).padStart(3, '0')}` : '—');

/* ─────────────────────────────── influencers ─────────────────────────────── */

const INFLUENCER_COLUMNS = `id, name, content_type, platform, profile_url, collab_type, location,
  payment_per_video, total_content, email, contact_number, address, notes, active, created_by, created_at`;

/**
 * Instagram profile URLs are pasted from the app's share sheet, which tacks a tracking query
 * onto them (`?igsh=...`). Strip it so the same creator pasted twice reads as one profile.
 */
function cleanProfileUrl(raw) {
  const value = trim(raw);
  if (!value) return null;
  try {
    const url = new URL(value.startsWith('http') ? value : `https://${value}`);
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return value;
  }
}

/**
 * The handle, for display — "@sarandrips" reads better in a table than the full URL. Read from
 * the path rather than the last URL segment, because handles legitimately contain dots
 * ("tanmay._makwana") and would otherwise be mistaken for the domain.
 */
function handleFrom(url) {
  const cleaned = cleanProfileUrl(url);
  if (!cleaned) return null;
  try {
    const segment = new URL(cleaned).pathname.split('/').filter(Boolean)[0];
    return segment ? `@${segment}` : null;
  } catch {
    return null;
  }
}

const hydrateInfluencer = (row) => ({ ...row, handle: handleFrom(row.profile_url) });

function validateInfluencer(body) {
  if (!trim(body.name)) return 'Name is required';
  if (body.collab_type && !COLLAB_TYPES.includes(body.collab_type)) return 'Unknown collab type';
  if (body.total_content !== undefined && body.total_content !== '' && !(Number(body.total_content) >= 0)) {
    return 'Total content must be a number';
  }
  return validatePhoneFields(body);
}

const influencerValues = (body) => [
  trim(body.name),
  nullable(body.content_type),
  nullable(body.platform) || 'Instagram',
  cleanProfileUrl(body.profile_url),
  COLLAB_TYPES.includes(body.collab_type) ? body.collab_type : 'Barter',
  nullable(body.location),
  nullable(body.payment_per_video),
  parseInt(body.total_content, 10) || 0,
  nullable(body.email),
  nullable(body.contact_number),
  nullable(body.address),
  nullable(body.notes),
  body.active === undefined ? true : !!body.active,
];

// GET /api/marketing/influencers
router.get('/influencers', async (req, res) => {
  try {
    const { search, collab_type: collabType, content_type: contentType, active } = req.query;
    const where = [], vals = [];
    if (search) {
      vals.push(`%${search}%`);
      where.push(`(i.name ILIKE $${vals.length} OR i.profile_url ILIKE $${vals.length}
        OR i.location ILIKE $${vals.length} OR i.notes ILIKE $${vals.length} OR i.email ILIKE $${vals.length})`);
    }
    if (collabType) { vals.push(collabType); where.push(`i.collab_type = $${vals.length}`); }
    if (contentType) { vals.push(contentType); where.push(`i.content_type = $${vals.length}`); }
    if (active === 'true' || active === 'false') { vals.push(active === 'true'); where.push(`i.active = $${vals.length}`); }
    const t = tableParams(req.query, { sortable: INFLUENCER_SORTS, defaultSort: 'name', defaultDir: 'asc', tiebreak: 'i.id' });
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const countRes = await db.query(`SELECT COUNT(*)::int AS n FROM marketing_influencers i ${whereSql}`, vals);

    // The order count is what tells marketing whether a creator has actually been seeded yet.
    const r = await db.query(
      `SELECT i.id, i.name, i.content_type, i.platform, i.profile_url, i.collab_type, i.location,
              i.payment_per_video, i.total_content, i.email, i.contact_number, i.address, i.notes,
              i.active, i.created_by, i.created_at,
              COUNT(o.id)::int AS order_count,
              TO_CHAR(MAX(o.order_date), 'YYYY-MM-DD') AS last_order_date
       FROM marketing_influencers i
       LEFT JOIN marketing_orders o ON o.influencer_id = i.id
       ${whereSql}
       GROUP BY i.id
       ${t.orderBy} LIMIT ${t.limit} OFFSET ${t.offset}`, vals
    );
    res.json({
      influencers: r.rows.map(hydrateInfluencer),
      pagination: pagination(countRes.rows[0]?.n || 0, t),
    });
  } catch (err) {
    console.error('Error loading influencers:', err);
    res.status(500).json({ error: 'Failed to load influencers' });
  }
});

// GET /api/marketing/influencers/:id — one creator, for opening a profile straight from an order
// whose influencer is not on the currently loaded (paged, filtered) roster page.
router.get('/influencers/:id', async (req, res) => {
  try {
    const r = await db.query(`SELECT ${INFLUENCER_COLUMNS} FROM marketing_influencers WHERE id = $1`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Influencer not found' });
    res.json({ influencer: r.rows[0] });
  } catch (err) {
    console.error('Error loading influencer:', err);
    res.status(500).json({ error: 'Failed to load influencer' });
  }
});

// POST /api/marketing/influencers
router.post('/influencers', async (req, res) => {
  const bad = validateInfluencer(req.body || {});
  if (bad) return res.status(400).json({ error: bad });
  try {
    const r = await db.query(
      `INSERT INTO marketing_influencers
         (name, content_type, platform, profile_url, collab_type, location, payment_per_video,
          total_content, email, contact_number, address, notes, active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING ${INFLUENCER_COLUMNS}`,
      [...influencerValues(req.body), req.user?.username || null]
    );
    res.json({ success: true, influencer: hydrateInfluencer({ ...r.rows[0], order_count: 0 }) });
  } catch (err) {
    console.error('Error creating influencer:', err);
    res.status(500).json({ error: 'Failed to create influencer' });
  }
});

// PUT /api/marketing/influencers/:id
router.put('/influencers/:id', async (req, res) => {
  const bad = validateInfluencer(req.body || {});
  if (bad) return res.status(400).json({ error: bad });
  try {
    const r = await db.query(
      `UPDATE marketing_influencers SET
         name=$1, content_type=$2, platform=$3, profile_url=$4, collab_type=$5, location=$6,
         payment_per_video=$7, total_content=$8, email=$9, contact_number=$10, address=$11,
         notes=$12, active=$13, updated_at = CURRENT_TIMESTAMP
       WHERE id=$14 RETURNING ${INFLUENCER_COLUMNS}`,
      [...influencerValues(req.body), req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Influencer not found' });
    res.json({ success: true, influencer: hydrateInfluencer(r.rows[0]) });
  } catch (err) {
    console.error('Error updating influencer:', err);
    res.status(500).json({ error: 'Failed to update influencer' });
  }
});

// DELETE /api/marketing/influencers/:id
router.delete('/influencers/:id', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Only the account owner can do this' });
  try {
    const r = await db.query('DELETE FROM marketing_influencers WHERE id = $1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Influencer not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting influencer:', err);
    res.status(500).json({ error: 'Failed to delete influencer' });
  }
});

/* ───────────────────────────────── orders ───────────────────────────────── */

const ORDER_COLUMNS = `id, ref_no, influencer_id, name, email, contact_number, address, collab_type,
  items, total_qty, TO_CHAR(order_date, 'YYYY-MM-DD') AS order_date, status, notes,
  TO_CHAR(fulfilled_date, 'YYYY-MM-DD') AS fulfilled_date, shopify_order_number,
  shipping_partner, awb, tracking_link, created_by, created_at, approved_by, approved_at`;

const hydrateOrder = (row) => ({ ...row, items: parseJson(row.items, []), ref: refLabel(row) });

/** Drop rows the warehouse couldn't act on, and normalise quantities coming from text inputs. */
function cleanItems(items) {
  return (Array.isArray(items) ? items : [])
    .map(it => ({
      product: trim(it.product),
      variant: trim(it.variant),
      sku: trim(it.sku),
      qty: parseInt(it.qty, 10) || 0,
      image: trim(it.image) || null,
      shopify_product_id: it.shopify_product_id || null,
      shopify_variant_id: it.shopify_variant_id || null,
    }))
    .filter(it => it.product && it.qty > 0);
}

const totalQty = (items) => items.reduce((sum, it) => sum + it.qty, 0);

/**
 * Push an order's current state at blank stock.
 *
 * Never allowed to fail the request that triggered it: the order really did just change, and
 * refusing the save because a stock write went wrong would leave the two further apart, not closer.
 */
async function applyStock(row) {
  try {
    return await inv.applyMarketingOrder(row);
  } catch (err) {
    console.error('marketing inventory apply failed:', err.message);
    return { error: 'Stock could not be updated for this order' };
  }
}

/**
 * Delhivery's public tracker is a predictable URL, and it is the partner on nearly every row of
 * the sheet — so a typed AWB produces its own tracking link rather than being pasted twice.
 */
function trackingFor(partner, awb, provided) {
  if (trim(provided)) return trim(provided);
  const number = trim(awb);
  if (!number) return null;
  if (partner === 'Delhivery') return `https://www.delhivery.com/track-v2/package/${number}`;
  return null;
}

function validateOrder(body) {
  if (!trim(body.name)) return 'Influencer name is required';
  if (!isDate(body.order_date)) return 'A valid order date is required';
  if (body.fulfilled_date && !isDate(body.fulfilled_date)) return 'Fulfilled date must be a valid date';
  if (body.fulfilled_date && body.fulfilled_date < body.order_date) return 'Fulfilled date cannot be before the order date';
  if (!cleanItems(body.items).length) return 'Add at least one item with a quantity';
  if (body.status && !STATUSES.includes(body.status)) return 'Unknown status';
  if (body.shipping_partner && !SHIPPING_PARTNERS.includes(body.shipping_partner)) return 'Unknown shipping partner';
  return validatePhoneFields(body);
}

// GET /api/marketing/orders
router.get('/orders', async (req, res) => {
  try {
    const { status, influencer_id: influencerId, search, open } = req.query;
    const where = [], vals = [];
    if (status) { vals.push(status); where.push(`status = $${vals.length}`); }
    if (influencerId) { vals.push(influencerId); where.push(`influencer_id = $${vals.length}`); }
    if (open === 'true') where.push(`status NOT IN ('Delivered','Cancelled')`);
    if (search) {
      vals.push(`%${search}%`);
      where.push(`(name ILIKE $${vals.length} OR email ILIKE $${vals.length} OR items ILIKE $${vals.length}
        OR awb ILIKE $${vals.length} OR shopify_order_number ILIKE $${vals.length} OR address ILIKE $${vals.length})`);
    }
    const t = tableParams(req.query, { sortable: MK_ORDER_SORTS, defaultSort: 'order_date' });
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const r = await db.query(
      `SELECT ${ORDER_COLUMNS} FROM marketing_orders
       ${whereSql} ${t.orderBy} LIMIT ${t.limit} OFFSET ${t.offset}`, vals
    );
    const orders = r.rows.map(hydrateOrder);
    // The creator's live profile link, attached separately rather than joined: marketing_orders
    // and marketing_influencers share column names (name, collab_type), so a join would make the
    // filters and sorts above ambiguous. Everything else about the recipient stays the snapshot
    // taken when the order was raised.
    const ids = [...new Set(orders.map(o => o.influencer_id).filter(Boolean))];
    if (ids.length) {
      const links = new Map((await db.query(
        'SELECT id, profile_url FROM marketing_influencers WHERE id = ANY($1)', [ids])).rows.map(i => [i.id, i.profile_url]));
      orders.forEach(o => { o.profile_url = links.get(o.influencer_id) || null; });
    }
    // Summary describes every order that matches the filters, not just the page in view — a
    // count that changed as you paged would be meaningless.
    const sums = await db.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status NOT IN ('Delivered','Cancelled','Dispatched'))::int AS awaiting,
              COUNT(*) FILTER (WHERE status = 'Dispatched')::int AS in_transit,
              COALESCE(SUM(total_qty) FILTER (WHERE status <> 'Cancelled'), 0)::int AS units
       FROM marketing_orders ${whereSql}`, vals);
    const s = sums.rows[0] || {};

    res.json({
      orders,
      canDispatch: await canDispatch(req),
      canApprove: await canApprove(req),
      pagination: pagination(s.total || 0, t),
      summary: {
        total: s.total || 0,
        awaitingDispatch: s.awaiting || 0,
        inTransit: s.in_transit || 0,
        unitsSent: s.units || 0,
      },
    });
  } catch (err) {
    console.error('Error loading influencer orders:', err);
    res.status(500).json({ error: 'Failed to load influencer orders' });
  }
});

// POST /api/marketing/orders — raised by marketing; the dispatch half stays empty until production fills it
router.post('/orders', async (req, res) => {
  const body = req.body || {};
  const bad = validateOrder(body);
  if (bad) return res.status(400).json({ error: bad });
  try {
    const items = cleanItems(body.items);
    const r = await db.query(
      `INSERT INTO marketing_orders
         (ref_no, influencer_id, name, email, contact_number, address, collab_type, items,
          total_qty, order_date, status, notes, created_by)
       VALUES ((SELECT COALESCE(MAX(ref_no), 0) + 1 FROM marketing_orders),
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING ${ORDER_COLUMNS}`,
      [body.influencer_id || null, trim(body.name), nullable(body.email), nullable(body.contact_number),
       nullable(body.address), nullable(body.collab_type), JSON.stringify(items), totalQty(items),
       // A new order always starts unapproved; a client cannot ask to skip the stage.
       body.order_date || todayStr(), AWAITING_APPROVAL,
       nullable(body.notes), req.user?.username || null]
    );
    res.json({ success: true, order: hydrateOrder(r.rows[0]) });
  } catch (err) {
    console.error('Error creating influencer order:', err);
    res.status(500).json({ error: 'Failed to create influencer order' });
  }
});

// PUT /api/marketing/orders/:id — the marketing half. Dispatch fields are ignored here.
router.put('/orders/:id', async (req, res) => {
  const body = req.body || {};
  const bad = validateOrder(body);
  if (bad) return res.status(400).json({ error: bad });
  try {
    const existing = (await db.query('SELECT status FROM marketing_orders WHERE id = $1', [req.params.id])).rows[0];
    if (!existing) return res.status(404).json({ error: 'Order not found' });

    const items = cleanItems(body.items);
    const r = await db.query(
      `UPDATE marketing_orders SET
         influencer_id=$1, name=$2, email=$3, contact_number=$4, address=$5, collab_type=$6,
         items=$7, total_qty=$8, order_date=$9, notes=$10, updated_at = CURRENT_TIMESTAMP
       WHERE id=$11 RETURNING ${ORDER_COLUMNS}`,
      [body.influencer_id || null, trim(body.name), nullable(body.email), nullable(body.contact_number),
       nullable(body.address), nullable(body.collab_type), JSON.stringify(items), totalQty(items),
       body.order_date, nullable(body.notes), req.params.id]
    );
    // Editing the items of an order that has already gone out moves stock by the difference.
    // A no-op for anything not dispatched, so it costs nothing to always ask.
    const stock = await applyStock(r.rows[0]);
    res.json({ success: true, order: hydrateOrder(r.rows[0]), inventory: stock });
  } catch (err) {
    console.error('Error updating influencer order:', err);
    res.status(500).json({ error: 'Failed to update influencer order' });
  }
});

/**
 * POST /api/marketing/orders/:id/approve — release an order for dispatch.
 *
 * Held separately from the marketing edit route: whoever raises an order should not be the one
 * who signs it off, which is the only reason the stage exists.
 */
router.post('/orders/:id/approve', async (req, res) => {
  if (!await canApprove(req)) {
    return res.status(403).json({ error: 'You do not have permission to approve influencer orders' });
  }
  try {
    const current = (await db.query('SELECT status FROM marketing_orders WHERE id = $1', [req.params.id])).rows[0];
    if (!current) return res.status(404).json({ error: 'Order not found' });
    if (current.status !== AWAITING_APPROVAL) {
      return res.status(409).json({ error: `This order is already ${current.status.toLowerCase()} — only an order awaiting approval can be approved.` });
    }
    const r = await db.query(
      `UPDATE marketing_orders SET status = $1, approved_by = $2, approved_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING ${ORDER_COLUMNS}`,
      [APPROVED, req.user?.username || null, req.params.id]);
    res.json({ success: true, order: hydrateOrder(r.rows[0]) });
  } catch (err) {
    console.error('Error approving influencer order:', err);
    res.status(500).json({ error: 'Failed to approve the order' });
  }
});

// POST /api/marketing/orders/:id/unapprove — send it back for a second look.
router.post('/orders/:id/unapprove', async (req, res) => {
  if (!await canApprove(req)) {
    return res.status(403).json({ error: 'You do not have permission to approve influencer orders' });
  }
  try {
    const current = (await db.query('SELECT status, awb FROM marketing_orders WHERE id = $1', [req.params.id])).rows[0];
    if (!current) return res.status(404).json({ error: 'Order not found' });
    // Once it has shipped the approval is a matter of record, not a decision still open.
    if (current.status !== APPROVED) {
      return res.status(409).json({ error: 'Only an approved order that has not shipped can be sent back.' });
    }
    const r = await db.query(
      `UPDATE marketing_orders SET status = $1, approved_by = NULL, approved_at = NULL,
              updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING ${ORDER_COLUMNS}`,
      [AWAITING_APPROVAL, req.params.id]);
    res.json({ success: true, order: hydrateOrder(r.rows[0]) });
  } catch (err) {
    console.error('Error unapproving influencer order:', err);
    res.status(500).json({ error: 'Failed to send the order back' });
  }
});

// POST /api/marketing/orders/:id/dispatch — the production half
router.post('/orders/:id/dispatch', async (req, res) => {
  if (!await canDispatch(req)) {
    return res.status(403).json({ error: 'Only the production team can update dispatch details' });
  }
  const body = req.body || {};
  if (body.shipping_partner && !SHIPPING_PARTNERS.includes(body.shipping_partner)) {
    return res.status(400).json({ error: 'Unknown shipping partner' });
  }
  if (body.fulfilled_date && !isDate(body.fulfilled_date)) {
    return res.status(400).json({ error: 'Fulfilled date must be a valid date' });
  }
  if (body.status && !STATUSES.includes(body.status)) return res.status(400).json({ error: 'Unknown status' });

  try {
    const current = (await db.query(
      'SELECT status, awb, shipping_partner, fulfilled_date FROM marketing_orders WHERE id = $1', [req.params.id]
    )).rows[0];
    if (!current) return res.status(404).json({ error: 'Order not found' });

    // Approval is the whole point of the stage, so it cannot be skipped by filling in an AWB.
    if (current.status === AWAITING_APPROVAL) {
      return res.status(409).json({ error: 'This order has not been approved yet — it cannot be dispatched until someone signs it off.' });
    }

    const partner = body.shipping_partner !== undefined ? nullable(body.shipping_partner) : current.shipping_partner;
    const awb = body.awb !== undefined ? nullable(body.awb) : current.awb;

    // An AWB is the proof the parcel left, so it moves the order to Dispatched by itself — the
    // same rule Crewfit orders use. Offline hand-overs have no AWB, so they rely on an explicit
    // status pick instead of being stuck at Requested forever.
    let status = body.status || current.status;
    if (awb && !CLOSED.includes(status) && status !== 'Dispatched' && !body.status) status = 'Dispatched';
    if (status === 'Dispatched' && !awb && !NO_AWB_PARTNERS.includes(partner)) {
      return res.status(400).json({ error: 'Add an AWB, or set the partner to Offline, before marking this dispatched' });
    }

    // Dispatching without a date recorded would leave the sheet's "Order Fulfilled Date" blank.
    let fulfilled = body.fulfilled_date !== undefined ? nullable(body.fulfilled_date) : current.fulfilled_date;
    if (status === 'Dispatched' && !fulfilled) fulfilled = todayStr();

    const r = await db.query(
      `UPDATE marketing_orders SET
         status=$1, fulfilled_date=$2, shopify_order_number=$3, shipping_partner=$4, awb=$5,
         tracking_link=$6, updated_at = CURRENT_TIMESTAMP
       WHERE id=$7 RETURNING ${ORDER_COLUMNS}`,
      [status, fulfilled, nullable(body.shopify_order_number), partner, awb,
       trackingFor(partner, awb, body.tracking_link), req.params.id]
    );

    // A seeded garment comes off the same shelf as a sold one, so dispatching takes its blank out
    // of stock — and moving the order back out of Dispatched puts it back.
    const stock = await applyStock(r.rows[0]);
    res.json({ success: true, order: hydrateOrder(r.rows[0]), inventory: stock });
  } catch (err) {
    console.error('Error updating dispatch details:', err);
    res.status(500).json({ error: 'Failed to update dispatch details' });
  }
});

// DELETE /api/marketing/orders/:id
router.delete('/orders/:id', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Only the account owner can do this' });
  try {
    // Before the row goes: a deleted order cannot keep holding stock, and its movements would be
    // orphaned pointing at an order number nobody can look up.
    const released = await inv.releaseMarketingOrder(req.params.id);
    const r = await db.query('DELETE FROM marketing_orders WHERE id = $1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Order not found' });
    res.json({ success: true, stock_released: released });
  } catch (err) {
    console.error('Error deleting influencer order:', err);
    res.status(500).json({ error: 'Failed to delete influencer order' });
  }
});

/* ───────────────────────────────── meta ───────────────────────────────── */

// GET /api/marketing/meta — pick-lists for both forms
router.get('/meta', async (req, res) => {
  try {
    const locations = (await db.query(
      `SELECT DISTINCT location FROM marketing_influencers WHERE location IS NOT NULL AND location <> '' ORDER BY location`
    )).rows.map(r => r.location);
    res.json({
      contentTypes: CONTENT_TYPES, collabTypes: COLLAB_TYPES, platforms: PLATFORMS,
      statuses: STATUSES, shippingPartners: SHIPPING_PARTNERS, noAwbPartners: NO_AWB_PARTNERS,
      locations,
      canDispatch: await canDispatch(req),
      canApprove: await canApprove(req),
      isAdmin: isAdmin(req),
    });
  } catch (err) {
    console.error('Error loading marketing meta:', err);
    res.status(500).json({ error: 'Failed to load options' });
  }
});

// GET /api/marketing/products — the live Shopify catalogue, for the item picker
router.get('/products', async (req, res) => {
  try {
    const products = await fetchProducts({ force: req.query.refresh === 'true' });
    res.json({ products });
  } catch (err) {
    console.error('Error loading Shopify products:', err.message);
    // Not fatal: the form falls back to typing the item name by hand, which is what the sheet did.
    res.json({ products: [], error: 'Could not reach Shopify — type the item name instead.' });
  }
});

module.exports = router;
