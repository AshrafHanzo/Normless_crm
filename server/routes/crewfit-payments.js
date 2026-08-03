const express = require('express');
const db = require('../db/connection');
const razorpay = require('../config/razorpay');
const { isValidMobile } = require('../utils/phone');
const { canViewRevenue } = require('../utils/permissions');

const router = express.Router();

// Razorpay works in paise; every amount crossing that boundary goes through these two so a
// rupee/paise mix-up can't happen in one direction only.
const toPaise = (rupees) => Math.round(Number(rupees) * 100);
const toRupees = (paise) => Math.round(Number(paise)) / 100;

// Local calendar parts, not toISOString() — before 05:30 IST the UTC date is still yesterday.
const addDaysStr = (n) => {
  const d = new Date(); d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const KINDS = ['advance', 'balance', 'custom'];
const KIND_LABEL = { advance: 'Advance (50%)', balance: 'Balance (50%)', custom: 'Custom' };

// Razorpay link states → ours. "partially_paid" stays open: these links are created with
// accept_partial false, so it should never occur, but if it somehow does the link is not settled.
const LINK_STATUS = { created: 'Created', paid: 'Paid', cancelled: 'Cancelled', expired: 'Expired', partially_paid: 'Created' };

// Indian mobile → Razorpay wants a bare 10-digit number or +91 form; it rejects spaces/dashes.
function normalizeContact(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `+91${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  return `+${digits}`;
}

// Settling is idempotent on purpose: the webhook and a manual "check status" sync can both
// arrive for the same payment, and a Razorpay webhook may be re-delivered. Returns what
// actually changed so callers can report it.
async function settlePayment(payment, { razorpayPaymentId } = {}) {
  if (payment.status === 'Paid') return { alreadySettled: true, orderUpdated: false };

  await db.query(
    `UPDATE crewfit_payments SET status = 'Paid', razorpay_payment_id = COALESCE($1, razorpay_payment_id),
     paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [razorpayPaymentId || null, payment.id]
  );

  // Only the advance/balance halves of an order drive its pipeline. A custom link — even one
  // attached to an order for reference — is just money in, not a stage change.
  if (!payment.order_id || !['advance', 'balance'].includes(payment.kind)) {
    return { alreadySettled: false, orderUpdated: false };
  }

  const r = await db.query('SELECT id, sl_no, status, payment_status, deadline_at FROM crewfit_orders WHERE id = $1', [payment.order_id]);
  const order = r.rows[0];
  if (!order) return { alreadySettled: false, orderUpdated: false };

  const patch = {};
  if (payment.kind === 'advance') {
    // Never walk a fully-paid order backwards — a late advance webhook must not undo the balance.
    if (order.payment_status !== 'Fully Paid') patch.payment_status = '50% Paid';
    // Advance received → production can start.
    if (order.status === 'Awaiting Payment') patch.status = 'Pending';
    // Production clock starts on payment: 7 days from now, unless a deadline already exists.
    if (!order.deadline_at) patch.deadline_at = addDaysStr(7);
  } else {
    patch.payment_status = 'Fully Paid';
    if (order.status === 'Awaiting Payment') patch.status = 'Pending';
    else if (order.status === 'Ready for Dispatch') patch.status = 'Dispatch Pending';
  }

  const fields = Object.keys(patch);
  if (!fields.length) return { alreadySettled: false, orderUpdated: false };
  const set = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
  await db.query(
    `UPDATE crewfit_orders SET ${set}, updated_at = CURRENT_TIMESTAMP WHERE id = $${fields.length + 1}`,
    [...fields.map(f => patch[f]), order.id]
  );
  console.log(`💰 Payment #${payment.id} (${payment.kind}) settled — order CF-${order.sl_no} → ${JSON.stringify(patch)}`);
  return { alreadySettled: false, orderUpdated: true, order, patch };
}

// Ask Razorpay for the current state of a link. Used by the manual "check status" action and
// as the safety net for webhooks that never arrived (a tunnel/DNS blip on their side or ours).
async function syncPayment(payment) {
  if (!payment.razorpay_payment_link_id) return { synced: false, reason: 'no link' };
  const link = await razorpay.client().paymentLink.fetch(payment.razorpay_payment_link_id);
  const mapped = LINK_STATUS[link.status] || 'Created';
  await db.query('UPDATE crewfit_payments SET last_synced_at = CURRENT_TIMESTAMP WHERE id = $1', [payment.id]);

  if (mapped === 'Paid') {
    const paidPayment = (link.payments || []).find(p => p.status === 'captured');
    const result = await settlePayment(payment, { razorpayPaymentId: paidPayment?.payment_id });
    return { synced: true, status: 'Paid', ...result };
  }
  if (mapped !== payment.status) {
    await db.query(
      `UPDATE crewfit_payments SET status = $1, cancelled_at = CASE WHEN $1 IN ('Cancelled','Expired') THEN CURRENT_TIMESTAMP ELSE cancelled_at END,
       updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [mapped, payment.id]
    );
  }
  return { synced: true, status: mapped, orderUpdated: false };
}

// Create the link at Razorpay and store our row. `row` supplies everything except the link fields.
async function createLink({ order_id = null, kind, customer_name, contact_number, email, amount, description, notes, created_by }) {
  const rupees = Number(amount);
  if (!rupees || rupees <= 0) throw Object.assign(new Error('Amount must be greater than zero'), { status: 400 });
  // Razorpay rejects anything under ₹1, and a stray paise value here would silently become ₹0.
  if (rupees < 1) throw Object.assign(new Error('Amount must be at least ₹1'), { status: 400 });

  const rzp = razorpay.client();
  const link = await rzp.paymentLink.create({
    amount: toPaise(rupees),
    currency: 'INR',
    accept_partial: false,
    description: (description || 'Crewfit payment').slice(0, 2048),
    customer: {
      name: customer_name || 'Customer',
      ...(normalizeContact(contact_number) ? { contact: normalizeContact(contact_number) } : {}),
      ...(email ? { email } : {}),
    },
    notify: { sms: false, email: false }, // the SO sends it on WhatsApp themselves
    reminder_enable: true,
    notes: { source: 'crewfit-crm', kind, ...(order_id ? { order_id: String(order_id) } : {}) },
  });

  const r = await db.query(
    `INSERT INTO crewfit_payments (order_id, kind, customer_name, contact_number, email, amount, description, notes,
       status, razorpay_payment_link_id, razorpay_short_url, razorpay_mode, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Created',$9,$10,$11,$12) RETURNING *`,
    [order_id, kind, customer_name || null, contact_number || null, email || null, rupees,
      description || null, notes || null, link.id, link.short_url, razorpay.MODE, created_by || null]
  );
  return r.rows[0];
}

// GET /api/crewfit/payments — transaction list
router.get('/', async (req, res) => {
  try {
    const { status, kind, search, orderId, startDate, endDate, page = 1, limit = 25 } = req.query;
    const where = [];
    const vals = [];
    const add = (sql, v) => { vals.push(v); where.push(sql.replace('?', `$${vals.length}`)); };

    if (status) add('p.status = ?', status);
    if (kind) add('p.kind = ?', kind);
    if (orderId) add('p.order_id = ?', parseInt(orderId, 10));
    if (startDate) add('p.created_at >= ?', startDate);
    if (endDate) add('p.created_at < (?::date + 1)', endDate);
    if (search) {
      const s = `%${search.trim().toLowerCase()}%`;
      vals.push(s);
      where.push(`(LOWER(p.customer_name) LIKE $${vals.length} OR p.contact_number LIKE $${vals.length}
        OR LOWER(COALESCE(p.description,'')) LIKE $${vals.length} OR CAST(o.sl_no AS TEXT) LIKE $${vals.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const totals = await db.query(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(CASE WHEN p.status = 'Paid' THEN p.amount ELSE 0 END), 0) AS collected,
              COALESCE(SUM(CASE WHEN p.status = 'Created' THEN p.amount ELSE 0 END), 0) AS awaiting
       FROM crewfit_payments p LEFT JOIN crewfit_orders o ON o.id = p.order_id ${whereSql}`, vals);

    const lim = Math.max(1, parseInt(limit, 10) || 25);
    const pg = Math.max(1, parseInt(page, 10) || 1);
    const rows = await db.query(
      `SELECT p.*, o.sl_no AS order_sl_no, o.customer_name AS order_customer
       FROM crewfit_payments p LEFT JOIN crewfit_orders o ON o.id = p.order_id
       ${whereSql} ORDER BY p.created_at DESC, p.id DESC LIMIT ${lim} OFFSET ${(pg - 1) * lim}`, vals);

    const total = parseInt(totals.rows[0].n, 10);
    // Individual link amounts stay — staff still need them to chase a specific payment. Only the
    // roll-ups leave, and they're omitted from the payload rather than blanked in the UI, so the
    // figure isn't sitting in a network response for anyone who opens devtools.
    const showRevenue = await canViewRevenue(req);
    res.json({
      payments: rows.rows,
      summary: {
        ...(showRevenue ? { collected: Number(totals.rows[0].collected), awaiting: Number(totals.rows[0].awaiting) } : {}),
        count: total,
      },
      canViewRevenue: showRevenue,
      pagination: { total, page: pg, limit: lim, totalPages: Math.max(1, Math.ceil(total / lim)) },
      mode: razorpay.MODE,
      configured: razorpay.isConfigured,
    });
  } catch (err) {
    console.error('payments list error:', err); res.status(500).json({ error: 'Failed to load payments' });
  }
});

// GET /api/crewfit/payments/for-order/:orderId — the links belonging to one order
router.get('/for-order/:orderId', async (req, res) => {
  try {
    const r = await db.query(
      'SELECT * FROM crewfit_payments WHERE order_id = $1 ORDER BY created_at DESC, id DESC',
      [req.params.orderId]
    );
    res.json({ payments: r.rows, mode: razorpay.MODE, configured: razorpay.isConfigured });
  } catch (err) {
    console.error('payments for-order error:', err); res.status(500).json({ error: 'Failed to load payments' });
  }
});

// POST /api/crewfit/payments — a standalone (custom) payment link
router.post('/', async (req, res) => {
  try {
    if (!razorpay.isConfigured) {
      return res.status(400).json({ error: `Razorpay (${razorpay.MODE} mode) is not configured — set ${razorpay.missingVars().join(' and ')}` });
    }
    const { customer_name, contact_number, email, amount, description, notes, order_id } = req.body;
    if (!customer_name) return res.status(400).json({ error: 'Customer name is required' });
    if (!contact_number) return res.status(400).json({ error: 'Contact number is required' });
    if (!isValidMobile(contact_number)) return res.status(400).json({ error: 'Contact number must be exactly 10 digits' });

    const payment = await createLink({
      order_id: order_id ? parseInt(order_id, 10) : null,
      kind: 'custom', customer_name, contact_number, email, amount,
      description: description || `Payment — ${customer_name}`,
      notes, created_by: req.user?.username,
    });
    res.json(payment);
  } catch (err) {
    console.error('create payment link error:', err);
    res.status(err.status || 500).json({ error: err.error?.description || err.message || 'Failed to create payment link' });
  }
});

// POST /api/crewfit/payments/order/:orderId — the advance or balance half of an order.
// Amount comes from the order itself, never the client, so a tampered request can't
// under-charge; an explicit amount is only honoured when the order has no split recorded.
router.post('/order/:orderId', async (req, res) => {
  try {
    if (!razorpay.isConfigured) {
      return res.status(400).json({ error: `Razorpay (${razorpay.MODE} mode) is not configured — set ${razorpay.missingVars().join(' and ')}` });
    }
    const kind = req.body.kind;
    if (!['advance', 'balance'].includes(kind)) return res.status(400).json({ error: 'kind must be "advance" or "balance"' });

    const r = await db.query('SELECT * FROM crewfit_orders WHERE id = $1', [req.params.orderId]);
    const order = r.rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const grand = Number(order.grand_total) || 0;
    if (!grand) return res.status(400).json({ error: 'This order has no total yet — add products and save it before collecting payment.' });

    // Legacy/imported orders may have no advance/balance split stored — fall back to a 50/50
    // of the grand total, matching how the invoices already handle the same gap.
    const advance = order.advance != null ? Number(order.advance) : Math.round(grand / 2);
    const balance = order.balance != null ? Number(order.balance) : (grand - advance);
    const amount = kind === 'advance' ? advance : balance;
    if (!amount || amount <= 0) return res.status(400).json({ error: `This order has no ${kind} amount to collect` });

    // One open link per half — otherwise the customer can be sent two live links for the same
    // money and pay twice. An existing paid link is returned as an error, not silently reissued.
    const existing = await db.query(
      `SELECT * FROM crewfit_payments WHERE order_id = $1 AND kind = $2 AND status IN ('Created','Paid') ORDER BY id DESC LIMIT 1`,
      [order.id, kind]
    );
    if (existing.rows[0]) {
      if (existing.rows[0].status === 'Paid') {
        return res.status(400).json({ error: `The ${kind} for this order is already paid` });
      }
      return res.json({ ...existing.rows[0], reused: true });
    }

    const payment = await createLink({
      order_id: order.id, kind,
      customer_name: order.billing_name || order.customer_name,
      contact_number: order.whatsapp_number || order.billing_mobile || order.contact_number,
      email: order.billing_email,
      amount,
      description: `Crewfit order CF-${order.sl_no} — ${KIND_LABEL[kind]}`,
      created_by: req.user?.username,
    });
    res.json(payment);
  } catch (err) {
    console.error('order payment link error:', err);
    res.status(err.status || 500).json({ error: err.error?.description || err.message || 'Failed to create payment link' });
  }
});

// POST /api/crewfit/payments/:id/sync — re-check one link against Razorpay
router.post('/:id/sync', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM crewfit_payments WHERE id = $1', [req.params.id]);
    const payment = r.rows[0];
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    const result = await syncPayment(payment);
    const fresh = await db.query('SELECT * FROM crewfit_payments WHERE id = $1', [payment.id]);
    res.json({ ...fresh.rows[0], syncResult: result });
  } catch (err) {
    console.error('payment sync error:', err);
    res.status(500).json({ error: err.error?.description || err.message || 'Failed to check payment status' });
  }
});

// POST /api/crewfit/payments/sync-pending — re-checks open links against Razorpay. Driven by
// the UI's 10s auto-refresh, so it must stay cheap: a per-link cooldown means several open
// browser tabs (or a tab polling faster than expected) still cost at most one Razorpay call
// per link per COOLDOWN, rather than one per poll per tab.
// Body: { orderId } scopes it to a single order's links — that's what the order drawer uses.
const SYNC_COOLDOWN_SECONDS = 8;
router.post('/sync-pending', async (req, res) => {
  try {
    if (!razorpay.isConfigured) return res.status(400).json({ error: `Razorpay (${razorpay.MODE} mode) is not configured` });
    const { orderId } = req.body || {};
    const vals = [SYNC_COOLDOWN_SECONDS];
    let scope = '';
    if (orderId) { vals.push(parseInt(orderId, 10)); scope = ` AND order_id = $${vals.length}`; }
    const r = await db.query(
      `SELECT * FROM crewfit_payments
       WHERE status = 'Created' AND razorpay_payment_link_id IS NOT NULL
         AND (last_synced_at IS NULL OR last_synced_at < CURRENT_TIMESTAMP - ($1 || ' seconds')::interval)
         ${scope}
       ORDER BY id DESC LIMIT 100`, vals);

    let checked = 0, nowPaid = 0;
    const settled = [];
    for (const payment of r.rows) {
      try {
        const out = await syncPayment(payment);
        checked++;
        if (out.status === 'Paid' && !out.alreadySettled) { nowPaid++; settled.push({ id: payment.id, kind: payment.kind, amount: Number(payment.amount), order_id: payment.order_id }); }
      } catch (e) { console.error(`sync payment #${payment.id}:`, e.message); }
    }
    res.json({ checked, nowPaid, settled });
  } catch (err) {
    console.error('sync-pending error:', err); res.status(500).json({ error: 'Failed to sync payments' });
  }
});

// POST /api/crewfit/payments/:id/cancel
router.post('/:id/cancel', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM crewfit_payments WHERE id = $1', [req.params.id]);
    const payment = r.rows[0];
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    if (payment.status === 'Paid') return res.status(400).json({ error: 'This payment is already paid and cannot be cancelled' });

    if (payment.razorpay_payment_link_id) {
      try { await razorpay.client().paymentLink.cancel(payment.razorpay_payment_link_id); }
      catch (e) {
        // Already cancelled/expired at Razorpay is not a failure — fall through and record it.
        console.warn(`cancel link ${payment.razorpay_payment_link_id}:`, e.error?.description || e.message);
      }
    }
    const upd = await db.query(
      `UPDATE crewfit_payments SET status = 'Cancelled', cancelled_at = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`, [payment.id]);
    res.json(upd.rows[0]);
  } catch (err) {
    console.error('payment cancel error:', err); res.status(500).json({ error: 'Failed to cancel payment link' });
  }
});

// POST /api/crewfit/payments/:id/sent — records that the SO shared the link
router.post('/:id/sent', async (req, res) => {
  try {
    const r = await db.query(
      `UPDATE crewfit_payments SET sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING *`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Payment not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('payment sent error:', err); res.status(500).json({ error: 'Failed to update payment' });
  }
});

module.exports = router;
module.exports.settlePayment = settlePayment;
module.exports.syncPayment = syncPayment;
