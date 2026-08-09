const express = require('express');
const db = require('../db/connection');
const { canViewRevenue } = require('../utils/permissions');
const { tableParams, pagination } = require('../utils/table');

const router = express.Router();

// Client column key → SQL expression, over the aggregated customer view. Only these can be
// sorted on. `phone_key` breaks ties so a customer can't appear on two pages at once.
const CUSTOMER_SORTS = {
  customer_name: 'LOWER(customer_name)',
  orders_count: 'orders_count',
  total_value: 'total_value',
  last_order_date: 'last_order_date',
  first_order_date: 'first_order_date',
};

// Crewfit has no customers table — a "customer" is every order sharing a phone number. The
// number is the identity key because names get typed inconsistently ("TRM", "TRM Audios").
//
// Real data is messy: two numbers in one field ("9443266643 / 8675535888"), spaces and dashes
// ("98430 - 88300"), a stray colon, and +91/91 prefixes. So the key is: split on the first
// separator, strip everything non-numeric, then keep the LAST 10 digits — which drops a country
// code but leaves a plain 10-digit mobile untouched. Rows with no digits at all (e.g. someone
// typed "self pickup by salman") key to NULL and are excluded rather than lumped together.
const PHONE_KEY = `NULLIF(RIGHT(REGEXP_REPLACE(SPLIT_PART(REGEXP_REPLACE(COALESCE(contact_number,''), '[,;&]', '/', 'g'), '/', 1), '[^0-9]', '', 'g'), 10), '')`;

// Same rule as PHONE_KEY, for values arriving from the client.
const normalizePhone = (raw) => {
  const first = String(raw || '').replace(/[,;&]/g, '/').split('/')[0];
  const digits = first.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
};

// `pg` hands back DATE columns as a JS Date at local midnight; toISOString() would roll it back
// a day in IST. Same helper the orders route uses.
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const toDateStr = (v) => (!v ? null : v instanceof Date ? ymd(v) : String(v).slice(0, 10));

const num = (v) => Number(v || 0);

// One row per customer, newest activity first. Cancelled orders still count as history but
// never contribute to lifetime value.
const AGG_SQL = `
  WITH base AS (SELECT *, ${PHONE_KEY} AS phone_key FROM crewfit_orders),
  keyed AS (SELECT * FROM base WHERE phone_key IS NOT NULL),
  agg AS (
    SELECT phone_key,
      COUNT(*)::int AS orders_count,
      COALESCE(SUM(total_cost) FILTER (WHERE status IS DISTINCT FROM 'Cancelled'), 0) AS total_value,
      COALESCE(SUM(qty) FILTER (WHERE status IS DISTINCT FROM 'Cancelled'), 0)::int AS total_qty,
      MIN(order_date) AS first_order_date,
      MAX(order_date) AS last_order_date,
      COUNT(*) FILTER (WHERE status NOT IN ('Dispatched', 'Cancelled'))::int AS open_orders,
      COUNT(*) FILTER (WHERE status IS DISTINCT FROM 'Cancelled' AND payment_status IS DISTINCT FROM 'Fully Paid')::int AS unpaid_orders
    FROM keyed GROUP BY phone_key
  ),
  latest AS (
    SELECT DISTINCT ON (phone_key)
      phone_key, id AS last_order_id, sl_no AS last_sl_no, customer_name, whatsapp_number,
      contact_number AS raw_contact, so, status AS last_status, delivery_location, billing_address, gst_number
    FROM keyed ORDER BY phone_key, order_date DESC NULLS LAST, id DESC
  )
  SELECT a.*, l.last_order_id, l.last_sl_no, l.customer_name, l.whatsapp_number, l.raw_contact,
         l.so, l.last_status, l.delivery_location, l.billing_address, l.gst_number
  FROM agg a JOIN latest l USING (phone_key)`;

// Per-customer lifetime value and average are themselves totals — 81 of them on screen make the
// hidden grand total trivially derivable, so they go too. Per-ORDER amounts are left alone
// everywhere: an SO needs to know what one order is worth, and that's on the orders screen anyway.
const stripCustomerMoney = (c) => { const { total_value, avg_order_value, ...rest } = c; return rest; };

const shapeCustomer = (r) => ({
  phone: r.phone_key,
  raw_contact: r.raw_contact,
  customer_name: r.customer_name,
  whatsapp_number: r.whatsapp_number,
  so: r.so,
  orders_count: r.orders_count,
  total_value: num(r.total_value),
  total_qty: r.total_qty,
  avg_order_value: r.orders_count ? Math.round(num(r.total_value) / r.orders_count) : 0,
  first_order_date: toDateStr(r.first_order_date),
  last_order_date: toDateStr(r.last_order_date),
  open_orders: r.open_orders,
  unpaid_orders: r.unpaid_orders,
  last_order_id: r.last_order_id,
  last_sl_no: r.last_sl_no,
  last_status: r.last_status,
  // More than one order on the same number is the whole definition of a returning customer.
  customer_type: r.orders_count > 1 ? 'Returning' : 'New',
  delivery_location: r.delivery_location,
  billing_address: r.billing_address,
  gst_number: r.gst_number,
});

// How many prior orders this number already has. Shared by the lookup endpoint and by order
// creation, so the UI hint and the stored value can never disagree.
async function historyForPhone(phone, excludeOrderId) {
  const key = normalizePhone(phone);
  if (!key) return { phone: '', orders_count: 0, customer_type: 'New', customer_name: null, last_order: null };
  const params = [key];
  let where = `WHERE ${PHONE_KEY} = $1 AND status IS DISTINCT FROM 'Cancelled'`;
  if (excludeOrderId) { params.push(excludeOrderId); where += ` AND id <> $${params.length}`; }
  const r = await db.query(
    `SELECT id, sl_no, customer_name, whatsapp_number, order_date, total_cost, status, delivery_location, billing_address, gst_number
     FROM crewfit_orders ${where} ORDER BY order_date DESC NULLS LAST, id DESC`, params);
  const rows = r.rows;
  const last = rows[0] || null;
  return {
    phone: key,
    orders_count: rows.length,
    customer_type: rows.length > 0 ? 'Returning' : 'New',
    customer_name: last?.customer_name || null,
    lifetime_value: rows.reduce((s, o) => s + num(o.total_cost), 0),
    last_order: last ? {
      id: last.id, sl_no: last.sl_no, order_date: toDateStr(last.order_date),
      total_cost: num(last.total_cost), status: last.status,
      delivery_location: last.delivery_location, billing_address: last.billing_address, gst_number: last.gst_number,
    } : null,
  };
}

// GET /api/crewfit/customers — searchable, sortable customer list
router.get('/', async (req, res) => {
  try {
    const { search = '', type = '' } = req.query;
    const t = tableParams(req.query, { sortable: CUSTOMER_SORTS, defaultSort: 'last_order_date', tiebreak: 'phone_key' });

    const filters = [];
    const params = [];
    if (search.trim()) {
      params.push(`%${search.trim().toLowerCase()}%`);
      // Search the raw contact too, so typing the second number of a shared field still finds them.
      filters.push(`(LOWER(customer_name) LIKE $${params.length} OR phone_key LIKE $${params.length} OR LOWER(COALESCE(raw_contact,'')) LIKE $${params.length})`);
    }
    if (type === 'Returning') filters.push('orders_count > 1');
    else if (type === 'New') filters.push('orders_count = 1');

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const countRes = await db.query(`SELECT COUNT(*)::int AS n FROM (${AGG_SQL}) c ${where}`, params);
    const total = countRes.rows[0]?.n || 0;

    params.push(t.limit, t.offset);
    const rows = await db.query(
      `SELECT * FROM (${AGG_SQL}) c ${where} ${t.orderBy} LIMIT $${params.length - 1} OFFSET $${params.length}`, params);

    // Headline numbers describe the whole customer base, not just the page in view.
    const statsRes = await db.query(`SELECT COUNT(*)::int AS total_customers,
        COUNT(*) FILTER (WHERE orders_count > 1)::int AS returning_customers,
        COALESCE(SUM(total_value), 0) AS lifetime_value
      FROM (${AGG_SQL}) c`);
    const s = statsRes.rows[0] || {};

    // Customer counts are operational; the combined lifetime value is the revenue figure, so it
    // only ships to users allowed to see money totals.
    const showRevenue = await canViewRevenue(req);
    res.json({
      customers: rows.rows.map(c => (showRevenue ? shapeCustomer(c) : stripCustomerMoney(shapeCustomer(c)))),
      pagination: pagination(total, t),
      canViewRevenue: showRevenue,
      stats: {
        totalCustomers: s.total_customers || 0,
        returningCustomers: s.returning_customers || 0,
        ...(showRevenue ? { lifetimeValue: num(s.lifetime_value) } : {}),
      },
    });
  } catch (err) {
    console.error('crewfit customers list error:', err);
    res.status(500).json({ error: 'Failed to load customers' });
  }
});

// GET /api/crewfit/customers/lookup?phone=... — drives the live New/Returning hint in the order
// drawer. Registered before /:phone so "lookup" isn't swallowed as a phone number.
router.get('/lookup', async (req, res) => {
  try {
    res.json(await historyForPhone(req.query.phone, req.query.excludeId ? parseInt(req.query.excludeId) : null));
  } catch (err) {
    console.error('crewfit customer lookup error:', err);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// GET /api/crewfit/customers/:phone — profile plus full order history
router.get('/:phone', async (req, res) => {
  try {
    const key = normalizePhone(req.params.phone);
    if (!key) return res.status(400).json({ error: 'Invalid phone number' });

    const c = await db.query(`SELECT * FROM (${AGG_SQL}) c WHERE phone_key = $1`, [key]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Customer not found' });

    const orders = await db.query(
      `SELECT id, sl_no, order_date, deadline_at, product, qty, total_cost, status, payment_status,
              layout_status, so, vendor, mot, tracking_link, dispatch_date, customer_name, notes
       FROM crewfit_orders WHERE ${PHONE_KEY} = $1
       ORDER BY order_date DESC NULLS LAST, id DESC`, [key]);

    const showRevenue = await canViewRevenue(req);
    res.json({
      canViewRevenue: showRevenue,
      customer: showRevenue ? shapeCustomer(c.rows[0]) : stripCustomerMoney(shapeCustomer(c.rows[0])),
      orders: orders.rows.map(o => ({
        ...o,
        order_date: toDateStr(o.order_date),
        deadline_at: toDateStr(o.deadline_at),
        dispatch_date: toDateStr(o.dispatch_date),
        total_cost: num(o.total_cost),
      })),
    });
  } catch (err) {
    console.error('crewfit customer detail error:', err);
    res.status(500).json({ error: 'Failed to load customer' });
  }
});

module.exports = router;
module.exports.historyForPhone = historyForPhone;
module.exports.normalizePhone = normalizePhone;
