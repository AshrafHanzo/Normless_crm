const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const db = require('../db/connection');
const { renderInvoice, renderShippingLabel, nextInvoiceNumber } = require('../services/invoice');

const router = express.Router();

// Design mock / production photo uploads, stored on local disk under server/uploads/crewfit/<orderId>/
// and served statically at /uploads/crewfit/... (mounted in server/index.js).
const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads', 'crewfit');
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_ROOT, String(req.params.id));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '');
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPG, PNG or WEBP images are allowed'));
  },
});
// multer's own errors land in next(err) — surface them as a normal 400 instead of a 500 crash.
const uploadImages = (req, res, next) => upload.array('images', 5)(req, res, (err) => {
  if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
  next();
});

// Clean dropdown picklists (source of truth for the UI).
const META = {
  statuses: ['Awaiting Payment', 'Pending', 'Consignment Ordered', 'Consignment Received', 'Ongoing Production', 'Ready for Dispatch', 'Dispatch Pending', 'Dispatched', 'Cancelled'],
  payments: ['Pending', '50% Paid', 'Fully Paid'],
  layouts: ['Pending', 'Done'],
  customerTypes: ['New', 'Returning'],
  sos: ['Anu', 'Sadam'],
  vendors: ['Mubas Clothings', 'PTI', 'Ashna Garments', 'Print Wear', 'Dutees', 'TPR Garments'],
  mots: ['ST Courier', 'Porter', 'Self Pickup', 'DTDC', 'Professional Couriers', 'Delhivery', 'KRS Travels', 'AVK Cargo'],
  photoStatuses: ['None', 'Partial', 'Complete'],
};
const CLOSED = ['Dispatched', 'Cancelled'];

// Calendar dates must be formatted from local parts, never via toISOString(). These are DATE
// columns, so pg hands back a Date at *local* midnight — in IST that is 18:30 UTC the previous
// day, and toISOString() would report the wrong date. The same trap applies to "today": before
// 05:30 IST, new Date().toISOString() still reads as yesterday.
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const toDateStr = (v) => {
  if (!v) return null;
  if (v instanceof Date) return ymd(v);
  return String(v).slice(0, 10);
};
const todayStr = () => ymd(new Date());
const addDaysStr = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };

function safeJson(v, fallback) { try { return typeof v === 'string' ? JSON.parse(v) : (v || fallback); } catch { return fallback; } }
const parseOrder = (o) => ({ ...o, deadline_at: toDateStr(o.deadline_at), order_date: toDateStr(o.order_date), dispatch_date: toDateStr(o.dispatch_date), line_items: safeJson(o.line_items, []), invoices: safeJson(o.invoices, []) });

async function fetchAll() {
  const r = await db.query('SELECT * FROM crewfit_orders ORDER BY sl_no DESC');
  return r.rows.map(parseOrder);
}

// 'None' / 'Partial' / 'Complete' — how many line items have at least one image of this kind.
function photoStatus(items, field) {
  if (!items.length) return 'None';
  const n = items.filter(it => (it[field] || []).length > 0).length;
  if (n === 0) return 'None';
  return n === items.length ? 'Complete' : 'Partial';
}

// GET /api/crewfit/meta — dropdown options (merges defaults with values seen in data)
router.get('/meta', async (req, res) => {
  try {
    const rows = (await db.query('SELECT DISTINCT so, vendor, mot FROM crewfit_orders')).rows;
    const merge = (base, key) => Array.from(new Set([...base, ...rows.map(r => r[key]).filter(Boolean)]));
    res.json({ ...META, sos: merge(META.sos, 'so'), vendors: merge(META.vendors, 'vendor'), mots: merge(META.mots, 'mot') });
  } catch (err) {
    console.error('crewfit meta error:', err); res.status(500).json({ error: 'Failed to load meta' });
  }
});

// GET /api/crewfit/stats — dashboard KPIs
router.get('/stats', async (req, res) => {
  try {
    const orders = await fetchAll();
    const byStatus = {}; let totalValue = 0, active = 0, pendingPayments = 0;
    for (const o of orders) {
      byStatus[o.status] = (byStatus[o.status] || 0) + 1;
      totalValue += Number(o.total_cost) || 0;
      if (!CLOSED.includes(o.status)) { active++; if (o.payment_status !== 'Fully Paid') pendingPayments += Number(o.total_cost) || 0; }
    }
    res.json({ total: orders.length, active, dispatched: byStatus['Dispatched'] || 0, totalValue, pendingPayments, byStatus });
  } catch (err) {
    console.error('crewfit stats error:', err); res.status(500).json({ error: 'Failed to load stats' });
  }
});

// GET /api/crewfit/analytics?startDate&endDate — revenue, fulfillment time, customers & retention.
// All aggregation happens in JS over fetchAll() (mirrors /stats and /reminders) since per-product
// figures live inside the line_items JSON blob and can't be GROUP BY'd in SQL anyway.
router.get('/analytics', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    let orders = await fetchAll();
    if (startDate && endDate) {
      orders = orders.filter(o => o.order_date && o.order_date >= startDate && o.order_date <= endDate);
    }

    const nonCancelled = orders.filter(o => o.status !== 'Cancelled');
    const dispatched = orders.filter(o => o.status === 'Dispatched');
    const dayDiff = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
    // Orders imported from the old sheet only ever got `total_cost` populated, not the newer
    // grand_total/advance/product_total breakdown fields added later — fall back so historical
    // orders aren't silently excluded from revenue.
    const orderValue = (o) => Number(o.grand_total) || Number(o.total_cost) || 0;

    // --- Revenue ---
    const totalRevenue = nonCancelled.reduce((s, o) => s + orderValue(o), 0);
    const collectedRevenue = nonCancelled.reduce((s, o) => {
      const val = orderValue(o);
      if (o.payment_status === 'Fully Paid') return s + val;
      if (o.payment_status === '50% Paid') return s + (Number(o.advance) || Math.round(val / 2));
      return s;
    }, 0);
    const pendingRevenue = Math.max(0, totalRevenue - collectedRevenue);
    const avgOrderValue = nonCancelled.length ? totalRevenue / nonCancelled.length : 0;

    // --- Customers & retention (keyed by phone, falling back to name) ---
    const custKey = (o) => (o.contact_number || o.customer_name || '').trim().toLowerCase();
    const custMap = new Map();
    nonCancelled.forEach(o => {
      const key = custKey(o);
      if (!key) return;
      const c = custMap.get(key) || { customer_name: o.customer_name, contact_number: o.contact_number, orders: 0, revenue: 0 };
      c.orders += 1; c.revenue += orderValue(o);
      custMap.set(key, c);
    });
    const customers = Array.from(custMap.values());
    const totalCustomers = customers.length;
    const repeatCustomers = customers.filter(c => c.orders > 1).length;
    const repeatRate = totalCustomers ? (repeatCustomers / totalCustomers) * 100 : 0;
    const topCustomers = [...customers].sort((a, b) => b.revenue - a.revenue).slice(0, 8);

    const typeCounts = {};
    nonCancelled.forEach(o => { const t = o.customer_type || 'Unknown'; typeCounts[t] = (typeCounts[t] || 0) + 1; });
    const customerTypeBreakdown = Object.entries(typeCounts).map(([type, count]) => ({ type, count }));

    // --- Fulfillment / delivery time ---
    const fulfilled = dispatched.filter(o => o.order_date && o.dispatch_date);
    const fulfillmentDays = fulfilled.map(o => dayDiff(o.order_date, o.dispatch_date));
    const avgFulfillmentDays = fulfillmentDays.length ? fulfillmentDays.reduce((s, d) => s + d, 0) / fulfillmentDays.length : null;
    const onTimeEligible = fulfilled.filter(o => o.deadline_at);
    const onTimeCount = onTimeEligible.filter(o => o.dispatch_date <= o.deadline_at).length;
    const onTimeRate = onTimeEligible.length ? (onTimeCount / onTimeEligible.length) * 100 : null;
    const fulfillmentBuckets = [
      { label: '≤ 3 days', min: 0, max: 3 },
      { label: '4–7 days', min: 4, max: 7 },
      { label: '8–14 days', min: 8, max: 14 },
      { label: '15+ days', min: 15, max: Infinity },
    ].map(b => ({ label: b.label, count: fulfillmentDays.filter(d => d >= b.min && d <= b.max).length }));

    // --- Status / payment breakdowns ---
    const statusBreakdown = META.statuses
      .map(s => ({ status: s, count: orders.filter(o => o.status === s).length }))
      .filter(s => s.count > 0);
    const paymentBreakdown = META.payments.map(p => {
      const rows = nonCancelled.filter(o => o.payment_status === p);
      return { status: p, count: rows.length, amount: rows.reduce((s, o) => s + orderValue(o), 0) };
    }).filter(p => p.count > 0);

    // --- Sales officer performance ---
    const soMap = new Map();
    nonCancelled.forEach(o => {
      const key = o.so || 'Unassigned';
      const s = soMap.get(key) || { so: key, orders: 0, revenue: 0, fulfillmentDays: [] };
      s.orders += 1; s.revenue += orderValue(o);
      if (o.status === 'Dispatched' && o.order_date && o.dispatch_date) s.fulfillmentDays.push(dayDiff(o.order_date, o.dispatch_date));
      soMap.set(key, s);
    });
    const soPerformance = Array.from(soMap.values())
      .map(s => ({
        so: s.so, orders: s.orders, revenue: s.revenue,
        avgFulfillmentDays: s.fulfillmentDays.length ? Math.round(s.fulfillmentDays.reduce((a, b) => a + b, 0) / s.fulfillmentDays.length) : null,
      }))
      .sort((a, b) => b.revenue - a.revenue);

    // --- Top products (aggregated from each order's line_items) ---
    const prodMap = new Map();
    nonCancelled.forEach(o => {
      const items = o.line_items || [];
      items.forEach(it => {
        if (!it.product) return;
        const p = prodMap.get(it.product) || { product: it.product, qty: 0, revenue: 0 };
        p.qty += parseInt(it.qty) || 0;
        // Legacy single-product orders often have no per-line product_total (only the order-level
        // total_cost) — attribute the whole order value to that one line rather than losing it.
        p.revenue += Number(it.product_total) || (items.length === 1 ? orderValue(o) : 0);
        prodMap.set(it.product, p);
      });
    });
    const topProducts = Array.from(prodMap.values()).sort((a, b) => b.revenue - a.revenue).slice(0, 8);

    // --- Revenue trend (daily, zero-filled — default last 30 days) ---
    const revByDate = {};
    nonCancelled.forEach(o => {
      if (!o.order_date) return;
      const d = revByDate[o.order_date] || { date: o.order_date, revenue: 0, order_count: 0 };
      d.revenue += orderValue(o); d.order_count += 1;
      revByDate[o.order_date] = d;
    });
    const rangeStart = startDate && endDate ? startDate : addDaysStr(-29);
    const rangeEnd = startDate && endDate ? endDate : todayStr();
    const revenueSeries = [];
    for (let d = new Date(rangeStart); d <= new Date(rangeEnd); d.setDate(d.getDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      revenueSeries.push(revByDate[key] || { date: key, revenue: 0, order_count: 0 });
    }

    res.json({
      range: { startDate: startDate || null, endDate: endDate || null },
      kpis: {
        totalOrders: orders.length,
        activeOrders: orders.filter(o => !CLOSED.includes(o.status)).length,
        dispatchedOrders: dispatched.length,
        cancelledOrders: orders.length - nonCancelled.length,
        totalRevenue, collectedRevenue, pendingRevenue, avgOrderValue,
        totalCustomers, repeatCustomers, repeatRate,
        avgFulfillmentDays, onTimeRate,
      },
      revenueSeries,
      statusBreakdown,
      paymentBreakdown,
      customerTypeBreakdown,
      fulfillmentBuckets,
      soPerformance,
      topProducts,
      topCustomers,
    });
  } catch (err) {
    console.error('crewfit analytics error:', err); res.status(500).json({ error: 'Failed to load analytics' });
  }
});

// GET /api/crewfit/reminders — the follow-up engine (2-day lead)
router.get('/reminders', async (req, res) => {
  try {
    const orders = await fetchAll();
    const today = todayStr(), soon = addDaysStr(2);
    const active = orders.filter(o => !CLOSED.includes(o.status));
    // Once an order has reached "Ready for Dispatch" (or beyond, i.e. Dispatched — already excluded
    // via `active`), the production deadline is no longer the thing to chase — it's just awaiting
    // photos/balance/tracking, which have their own reminder groups below.
    const overdue = active.filter(o => o.deadline_at && o.deadline_at < today && !['Ready for Dispatch', 'Dispatch Pending'].includes(o.status));
    // Every product on the order needs its post-production photo uploaded before the balance can
    // be collected — partial photo sets (some products photographed, others not) don't count.
    const hasAllProdPhotos = (o) => {
      const items = o.line_items || [];
      return items.length > 0 && items.every(it => (it.prodImages || []).length > 0);
    };
    const awaitingBalance = active.filter(o => o.status === 'Ready for Dispatch' && o.payment_status !== 'Fully Paid');
    const photosPending = awaitingBalance.filter(o => !hasAllProdPhotos(o));
    const readyToCollect = awaitingBalance.filter(o => hasAllProdPhotos(o));
    // Balance collected but not shipped yet — the only thing left is a tracking ID, which is
    // what flips the order to Dispatched. Porter orders sit here until the Porter button is used.
    const dispatchPending = active.filter(o => o.status === 'Dispatch Pending');
    // Dispatched orders are excluded from `active` (they're closed) — pull straight from `orders` instead.
    // Scoped to the last 14 days so the backlog of pre-existing dispatches (never tracked before this
    // field existed) doesn't flood the queue with old orders that were surely already followed up on.
    const trackingCutoff = addDaysStr(-14);
    const trackingPending = orders.filter(o => o.status === 'Dispatched' && !o.tracking_sent_at && o.dispatch_date && o.dispatch_date >= trackingCutoff);
    const dueSoon = active.filter(o => o.deadline_at && o.deadline_at >= today && o.deadline_at <= soon);
    const layoutPending = active.filter(o => o.layout_status === 'Pending');
    const noDeadline = active.filter(o => !o.deadline_at);

    const groups = [
      { key: 'overdue', label: 'Production Overdue', icon: '🚨', tone: 'danger', orders: overdue },
      { key: 'photosPending', label: 'Ready for dispatch — take production photos', icon: '📸', tone: 'warning', orders: photosPending },
      { key: 'readyToCollect', label: 'Ready to dispatch — collect balance', icon: '💵', tone: 'warning', orders: readyToCollect },
      { key: 'dispatchPending', label: 'Dispatch pending — courier it & add tracking ID', icon: '🚚', tone: 'info', orders: dispatchPending },
      { key: 'trackingPending', label: 'Dispatched — send tracking to customer', icon: '📨', tone: 'primary', orders: trackingPending },
      { key: 'dueSoon', label: 'Due within 2 days', icon: '⏰', tone: 'warning', orders: dueSoon },
      { key: 'layoutPending', label: 'Layout pending', icon: '🎨', tone: 'primary', orders: layoutPending },
      { key: 'noDeadline', label: 'No deadline set', icon: '📅', tone: 'muted', orders: noDeadline },
    ].map(g => ({ ...g, count: g.orders.length }));

    const badge = new Set([...overdue, ...photosPending, ...readyToCollect, ...dispatchPending, ...trackingPending, ...dueSoon, ...layoutPending].map(o => o.id)).size;
    res.json({ groups, badge, activeCount: active.length });
  } catch (err) {
    console.error('crewfit reminders error:', err); res.status(500).json({ error: 'Failed to load reminders' });
  }
});

// GET /api/crewfit/orders — list with filters + pagination
router.get('/orders', async (req, res) => {
  try {
    const {
      status, payment_status, layout_status, so, vendor, search,
      mock_status, prod_status, startDate, endDate,
      page = 1, limit = 25,
    } = req.query;
    let orders = await fetchAll();
    orders = orders.map(o => ({
      ...o,
      mock_photo_status: photoStatus(o.line_items || [], 'mockImages'),
      prod_photo_status: photoStatus(o.line_items || [], 'prodImages'),
    }));

    const eq = (k, v) => { if (v) orders = orders.filter(o => (o[k] || '') === v); };
    eq('status', status); eq('payment_status', payment_status); eq('layout_status', layout_status); eq('so', so); eq('vendor', vendor);
    if (mock_status) orders = orders.filter(o => o.mock_photo_status === mock_status);
    if (prod_status) orders = orders.filter(o => o.prod_photo_status === prod_status);
    if (startDate && endDate) orders = orders.filter(o => o.order_date && o.order_date >= startDate && o.order_date <= endDate);
    if (search) {
      const raw = search.trim();
      // "45", "CF-45", "CF 45", "cf45", "#45" all mean the same thing: order sl_no 45. Treat these
      // as an exact order-number lookup instead of a fuzzy substring match — otherwise a short
      // number like "45" also matches as a substring inside unrelated customers' phone numbers,
      // which is why searches used to come back with a "random" list of unrelated orders.
      const orderNoMatch = raw.match(/^#?\s*(?:cf)?[\s-]*(\d{1,6})$/i);
      if (orderNoMatch) {
        const n = parseInt(orderNoMatch[1], 10);
        orders = orders.filter(o => Number(o.sl_no) === n);
      } else {
        const norm = (v) => (v || '').toString().toLowerCase().replace(/[^a-z0-9]/g, '');
        const s = norm(raw);
        orders = orders.filter(o => [o.customer_name, o.contact_number, o.description, o.product, o.vendor, o.so]
          .map(norm).some(x => x.includes(s)));
      }
    }

    const total = orders.length;
    const lim = Math.max(1, parseInt(limit) || 25);
    const pg = Math.max(1, parseInt(page) || 1);
    const start = (pg - 1) * lim;
    const paged = orders.slice(start, start + lim);
    res.json({ orders: paged, pagination: { total, page: pg, limit: lim, totalPages: Math.max(1, Math.ceil(total / lim)) } });
  } catch (err) {
    console.error('crewfit orders error:', err); res.status(500).json({ error: 'Failed to load orders' });
  }
});

// GET /api/crewfit/orders/:id
router.get('/orders/:id', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM crewfit_orders WHERE id = $1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(parseOrder(r.rows[0]));
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

const EXTRA = ['printing', 'delivery_location', 'billing_name', 'contact_person', 'billing_mobile', 'billing_email',
  'gst_number', 'billing_address', 'unit_price', 'product_total', 'shipping', 'gst_amount', 'grand_total', 'advance', 'balance',
  'line_items', 'whatsapp_number', 'tracking_sent_at', 'photos_sent_at'];
const EDITABLE = ['status', 'payment_status', 'layout_status', 'customer_type', 'so', 'vendor', 'mot', 'tracking_link',
  'deadline_at', 'deadline_text', 'dispatch_date', 'order_date', 'notes', 'total_cost', 'qty', 'color', 'size_breakdown',
  'customer_name', 'contact_number', 'mock_folder', 'description', 'product', ...EXTRA];

// PUT /api/crewfit/orders/:id — inline field / dropdown updates
router.put('/orders/:id', async (req, res) => {
  try {
    const current = (await db.query('SELECT status, payment_status, tracking_link, dispatch_date, mot, deadline_at FROM crewfit_orders WHERE id = $1', [req.params.id])).rows[0];
    if (!current) return res.status(404).json({ error: 'Not found' });

    const body = { ...req.body };
    // Status can only become "Dispatched" via a tracking ID being present — never a direct manual
    // pick — except Porter, which doesn't issue tracking IDs at all.
    const effectiveTracking = body.tracking_link !== undefined ? body.tracking_link : current.tracking_link;
    const effectiveMot = body.mot !== undefined ? body.mot : current.mot;
    if (body.status === 'Dispatched' && !effectiveTracking && effectiveMot !== 'Porter') {
      return res.status(400).json({ error: 'Add a tracking ID before marking this order as Dispatched' });
    }
    if (effectiveTracking && !['Dispatched', 'Cancelled'].includes(current.status)) {
      body.status = 'Dispatched';
      if (!body.dispatch_date && !current.dispatch_date) body.dispatch_date = todayStr();
    }
    // Payment-driven status moves only fire when the caller isn't deliberately setting a status
    // itself. The drawer saves the whole form (status included, unchanged), so "undefined" alone
    // isn't enough — an unchanged status counts as "no explicit pick" too.
    const statusUntouched = body.status === undefined || body.status === current.status;
    // Orders confirmed from a quote start life as "Awaiting Payment" — the moment the SO
    // records the advance (payment_status moves off "Pending"), it moves into the real
    // production pipeline automatically.
    if (current.status === 'Awaiting Payment' && statusUntouched
      && body.payment_status !== undefined && body.payment_status && body.payment_status !== 'Pending') {
      body.status = 'Pending';
    }
    // The production clock starts when the advance lands, not when the order was keyed in.
    // Seed a 7-day deadline the first time payment is recorded — only when none exists and
    // the caller isn't setting one, so an SO's own date is never overwritten.
    if (!current.deadline_at && body.deadline_at === undefined
      && current.payment_status === 'Pending' && body.payment_status && body.payment_status !== 'Pending') {
      body.deadline_at = addDaysStr(7);
    }
    // Production is done and the balance has just been collected — the order is cleared to ship.
    // It parks in "Dispatch Pending" (print the label, hand it to the courier) and only becomes
    // "Dispatched" once a tracking ID lands, per the rule above.
    if (current.status === 'Ready for Dispatch' && statusUntouched
      && body.payment_status === 'Fully Paid' && current.payment_status !== 'Fully Paid') {
      body.status = 'Dispatch Pending';
    }

    const fields = Object.keys(body).filter(k => EDITABLE.includes(k));
    if (!fields.length) return res.status(400).json({ error: 'No editable fields provided' });
    const set = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
    const vals = fields.map(f => f === 'line_items' ? JSON.stringify(body[f] || []) : (body[f] === '' ? null : body[f]));
    vals.push(req.params.id);
    await db.query(`UPDATE crewfit_orders SET ${set}, updated_at = CURRENT_TIMESTAMP WHERE id = $${fields.length + 1}`, vals);
    const r = await db.query('SELECT * FROM crewfit_orders WHERE id = $1', [req.params.id]);
    res.json(parseOrder(r.rows[0]));
  } catch (err) {
    console.error('crewfit update error:', err); res.status(500).json({ error: 'Failed to update order' });
  }
});

// POST /api/crewfit/orders — create
router.post('/orders', async (req, res) => {
  try {
    const body = { ...req.body };
    if (body.status === 'Dispatched' && !body.tracking_link && body.mot !== 'Porter') {
      return res.status(400).json({ error: 'Add a tracking ID before marking this order as Dispatched' });
    }
    if (body.tracking_link && body.status !== 'Cancelled') {
      body.status = 'Dispatched';
      if (!body.dispatch_date) body.dispatch_date = todayStr();
    }
    const cols = ['customer_name', 'contact_number', 'description', 'product', 'color', 'size_breakdown', 'qty', 'total_cost',
      'deadline_at', 'deadline_text', 'order_date', 'customer_type', 'so', 'vendor', 'mot', 'mock_folder', 'notes',
      'layout_status', 'payment_status', 'status', ...EXTRA];
    const provided = cols.filter(c => body[c] !== undefined && body[c] !== '');
    if (!body.customer_name) return res.status(400).json({ error: 'Customer name is required' });
    const nextRow = await db.query('SELECT COALESCE(MAX(sl_no), 0) + 1 AS next FROM crewfit_orders');
    const sl_no = nextRow.rows[0].next;
    const allCols = ['sl_no', ...provided];
    const vals = [sl_no, ...provided.map(c => c === 'line_items' ? JSON.stringify(body[c] || []) : body[c])];
    const ph = allCols.map((_, i) => `$${i + 1}`).join(',');
    const r = await db.query(`INSERT INTO crewfit_orders (${allCols.join(',')}) VALUES (${ph}) RETURNING *`, vals);
    res.status(201).json(parseOrder(r.rows[0]));
  } catch (err) {
    console.error('crewfit create error:', err); res.status(500).json({ error: 'Failed to create order' });
  }
});

// DELETE /api/crewfit/orders/:id
router.delete('/orders/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM crewfit_orders WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed to delete' }); }
});

// GET /api/crewfit/orders/:id/invoice/:type — type: 'advance' | 'balance'.
// Issues the invoice (next sequence number, persisted) the first time it's requested,
// then just re-renders the same stored invoice on every later request.
router.get('/orders/:id/invoice/:type', async (req, res) => {
  try {
    const { type } = req.params;
    if (!['advance', 'balance'].includes(type)) return res.status(400).json({ error: 'Invalid invoice type' });

    const r = await db.query('SELECT * FROM crewfit_orders WHERE id = $1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    const order = parseOrder(r.rows[0]);

    if (!Number(order.grand_total)) {
      return res.status(400).json({ error: 'Order pricing is not finalized yet — add products/qty and save the order before generating an invoice.' });
    }
    if (type === 'advance' && order.payment_status === 'Pending') {
      return res.status(400).json({ error: 'Advance payment has not been recorded yet' });
    }
    if (type === 'balance' && order.payment_status !== 'Fully Paid') {
      return res.status(400).json({ error: 'Order is not marked Fully Paid yet' });
    }

    const invoices = safeJson(order.invoices, []);
    let invoice = invoices.find(i => i.type === type);
    if (!invoice) {
      // Older/imported orders may not have advance/balance columns populated — fall back to a 50/50
      // split of the grand total rather than silently invoicing for Rs. 0.
      const grand = Number(order.grand_total) || 0;
      const advance = order.advance != null ? Number(order.advance) : Math.round(grand / 2);
      const balance = order.balance != null ? Number(order.balance) : (grand - advance);
      const amount = type === 'advance' ? advance : balance;
      const gstPct = ((Number(order.product_total) || 0) + (Number(order.shipping) || 0)) > 0
        ? Math.round((Number(order.gst_amount) || 0) / ((Number(order.product_total) || 0) + (Number(order.shipping) || 0)) * 100)
        : 0;
      const taxable = Math.round(amount / (1 + gstPct / 100));
      invoice = {
        number: await nextInvoiceNumber(db),
        type,
        date: new Date().toISOString().slice(0, 10),
        amount, taxable_value: taxable, gst_pct: gstPct, gst_amount: amount - taxable,
      };
      invoices.push(invoice);
      await db.query('UPDATE crewfit_orders SET invoices = $1 WHERE id = $2', [JSON.stringify(invoices), req.params.id]);
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${invoice.number.replace(/\//g, '-')}.pdf"`);
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    doc.pipe(res);
    renderInvoice(doc, order, invoice, invoices);
    doc.end();
  } catch (err) {
    console.error('crewfit invoice error:', err);
    res.status(500).json({ error: 'Failed to generate invoice' });
  }
});

// GET /api/crewfit/orders/:id/shipping-label — printable courier address label.
// Inline (not an attachment) so the browser opens its own print dialog straight from the viewer.
router.get('/orders/:id/shipping-label', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM crewfit_orders WHERE id = $1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    const order = parseOrder(r.rows[0]);
    if (!order.delivery_location && !order.billing_address) {
      return res.status(400).json({ error: 'No delivery address on this order — add one before printing a shipping label.' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Shipping-Label-CF-${order.sl_no}.pdf"`);
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    doc.pipe(res);
    renderShippingLabel(doc, order);
    doc.end();
  } catch (err) {
    console.error('crewfit shipping label error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate shipping label' });
  }
});

// Imported/legacy orders were stored as flat product/color/qty columns with line_items NULL, but
// the drawer still renders one product card for them (synthesized from those columns). Images are
// addressed by line-item index, so materialize that same single item on first use — otherwise the
// upload has nothing to attach to and fails with "Invalid product line".
function ensureLineItems(order) {
  const items = order.line_items || [];
  if (items.length) return items;
  if (!order.product && !order.qty && !order.product_total) return items;
  return [{
    product: order.product || '',
    color: order.color || '',
    printing: order.printing || 'Front & Back',
    qty: order.qty || '',
    unit_price: order.unit_price ?? (order.product_total && order.qty ? Math.round((order.product_total / order.qty) * 100) / 100 : ''),
    product_total: order.product_total ?? '',
    size_breakdown: order.size_breakdown || '',
  }];
}

// POST /api/crewfit/orders/:id/images — attach up to 5 images per product line item.
// kind: 'mock' (designer mockups, pending client confirmation) | 'prod' (post-production photos).
router.post('/orders/:id/images', uploadImages, async (req, res) => {
  try {
    const { kind, itemIndex } = req.body;
    const idx = parseInt(itemIndex, 10);
    if (!['mock', 'prod'].includes(kind) || Number.isNaN(idx)) {
      (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
      return res.status(400).json({ error: 'Invalid image kind or product line' });
    }
    const r = await db.query('SELECT * FROM crewfit_orders WHERE id = $1', [req.params.id]);
    if (!r.rows[0]) { (req.files || []).forEach(f => fs.unlink(f.path, () => {})); return res.status(404).json({ error: 'Not found' }); }
    const order = parseOrder(r.rows[0]);
    const items = ensureLineItems(order);
    if (!items[idx]) {
      (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
      return res.status(400).json({ error: 'Save the order first — this product row does not exist on the order yet.' });
    }

    const field = kind === 'mock' ? 'mockImages' : 'prodImages';
    const existing = items[idx][field] || [];
    const incoming = (req.files || []).map(f => `/uploads/crewfit/${req.params.id}/${f.filename}`);
    if (existing.length + incoming.length > 5) {
      incoming.forEach(u => fs.unlink(path.join(UPLOAD_ROOT, String(req.params.id), path.basename(u)), () => {}));
      return res.status(400).json({ error: `Max 5 ${kind === 'mock' ? 'mock' : 'production'} images per product (${existing.length} already uploaded)` });
    }
    items[idx] = { ...items[idx], [field]: [...existing, ...incoming] };
    await db.query('UPDATE crewfit_orders SET line_items = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [JSON.stringify(items), req.params.id]);
    const fresh = await db.query('SELECT * FROM crewfit_orders WHERE id = $1', [req.params.id]);
    res.json(parseOrder(fresh.rows[0]));
  } catch (err) {
    console.error('crewfit image upload error:', err);
    (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
    res.status(500).json({ error: 'Failed to upload images' });
  }
});

// DELETE /api/crewfit/orders/:id/images — body: { kind, itemIndex, url }
router.delete('/orders/:id/images', async (req, res) => {
  try {
    const { kind, itemIndex, url } = req.body;
    const idx = parseInt(itemIndex, 10);
    if (!['mock', 'prod'].includes(kind) || Number.isNaN(idx) || !url) return res.status(400).json({ error: 'Invalid request' });

    const r = await db.query('SELECT * FROM crewfit_orders WHERE id = $1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    const order = parseOrder(r.rows[0]);
    const items = ensureLineItems(order);
    if (!items[idx]) return res.status(400).json({ error: 'Invalid product line' });

    const field = kind === 'mock' ? 'mockImages' : 'prodImages';
    items[idx] = { ...items[idx], [field]: (items[idx][field] || []).filter(u => u !== url) };
    await db.query('UPDATE crewfit_orders SET line_items = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [JSON.stringify(items), req.params.id]);

    // url is our own /uploads/crewfit/<orderId>/<filename> path — safe to resolve directly under UPLOAD_ROOT.
    const filename = path.basename(url);
    fs.unlink(path.join(UPLOAD_ROOT, String(req.params.id), filename), () => {});

    const fresh = await db.query('SELECT * FROM crewfit_orders WHERE id = $1', [req.params.id]);
    res.json(parseOrder(fresh.rows[0]));
  } catch (err) {
    console.error('crewfit image delete error:', err);
    res.status(500).json({ error: 'Failed to delete image' });
  }
});

/* ---------------- PRODUCTS (catalog, editable) ---------------- */
const parseProduct = (r) => ({
  ...r,
  from_price: r.from_price != null ? Number(r.from_price) : null,
  features: safeJson(r.features, []),
  colors: safeJson(r.colors, []),
  tiers: safeJson(r.tiers, []),
});

// GET /api/crewfit/products
router.get('/products', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM crewfit_products ORDER BY sort_order ASC, id ASC');
    res.json({ products: r.rows.map(parseProduct) });
  } catch (err) {
    console.error('crewfit products error:', err); res.status(500).json({ error: 'Failed to load products' });
  }
});

const PFIELDS = ['name', 'category', 'fit', 'gsm', 'material', 'from_price', 'blurb', 'features', 'colors', 'tiers', 'active', 'sort_order'];
const encodeP = (body) => {
  const out = {};
  for (const f of PFIELDS) {
    if (body[f] === undefined) continue;
    out[f] = ['features', 'colors', 'tiers'].includes(f) ? JSON.stringify(body[f] || []) : body[f];
  }
  return out;
};

// POST /api/crewfit/products
router.post('/products', async (req, res) => {
  try {
    const data = encodeP(req.body);
    if (!data.name) return res.status(400).json({ error: 'Product name required' });
    const keys = Object.keys(data);
    const r = await db.query(
      `INSERT INTO crewfit_products (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
      keys.map(k => data[k])
    );
    res.status(201).json(parseProduct(r.rows[0]));
  } catch (err) { console.error('create product error:', err); res.status(500).json({ error: 'Failed to create product' }); }
});

// PUT /api/crewfit/products/:id
router.put('/products/:id', async (req, res) => {
  try {
    const data = encodeP(req.body);
    const keys = Object.keys(data);
    if (!keys.length) return res.status(400).json({ error: 'Nothing to update' });
    const set = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const vals = keys.map(k => data[k]); vals.push(req.params.id);
    await db.query(`UPDATE crewfit_products SET ${set}, updated_at = CURRENT_TIMESTAMP WHERE id = $${keys.length + 1}`, vals);
    const r = await db.query('SELECT * FROM crewfit_products WHERE id = $1', [req.params.id]);
    res.json(parseProduct(r.rows[0]));
  } catch (err) { console.error('update product error:', err); res.status(500).json({ error: 'Failed to update product' }); }
});

// DELETE /api/crewfit/products/:id
router.delete('/products/:id', async (req, res) => {
  try { await db.query('DELETE FROM crewfit_products WHERE id = $1', [req.params.id]); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: 'Failed to delete product' }); }
});

module.exports = router;
