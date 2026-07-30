const express = require('express');
const db = require('../db/connection');

const router = express.Router();

// Clean dropdown picklists (source of truth for the UI).
const META = {
  statuses: ['Enquiry', 'Consignment Ordered', 'Ongoing Production', 'Ready for Dispatch', 'Dispatched', 'Cancelled'],
  payments: ['Pending', '50% Paid', 'Fully Paid'],
  layouts: ['Pending', 'Done'],
  customerTypes: ['New', 'Returning'],
  sos: ['Anu', 'Sadam'],
  vendors: ['Mubas Clothings', 'PTI', 'Ashna Garments', 'Print Wear', 'Dutees', 'TPR Garments'],
  mots: ['ST Courier', 'Porter', 'Self Pickup', 'DTDC', 'Professional Couriers', 'Delhivery', 'KRS Travels', 'AVK Cargo'],
};
const CLOSED = ['Dispatched', 'Cancelled'];

const toDateStr = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};
const todayStr = () => new Date().toISOString().slice(0, 10);
const addDaysStr = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

async function fetchAll() {
  const r = await db.query('SELECT * FROM crewfit_orders ORDER BY sl_no DESC');
  return r.rows.map(o => ({ ...o, deadline_at: toDateStr(o.deadline_at), order_date: toDateStr(o.order_date), dispatch_date: toDateStr(o.dispatch_date) }));
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

// GET /api/crewfit/reminders — the follow-up engine (2-day lead)
router.get('/reminders', async (req, res) => {
  try {
    const orders = await fetchAll();
    const today = todayStr(), soon = addDaysStr(2);
    const active = orders.filter(o => !CLOSED.includes(o.status));
    const overdue = active.filter(o => o.deadline_at && o.deadline_at < today);
    const dueSoon = active.filter(o => o.deadline_at && o.deadline_at >= today && o.deadline_at <= soon);
    const balanceDue = active.filter(o => o.payment_status !== 'Fully Paid');
    const layoutPending = active.filter(o => o.layout_status === 'Pending');
    const noDeadline = active.filter(o => !o.deadline_at);

    const groups = [
      { key: 'overdue', label: 'Overdue', icon: '🚨', tone: 'danger', orders: overdue },
      { key: 'dueSoon', label: 'Due within 2 days', icon: '⏰', tone: 'warning', orders: dueSoon },
      { key: 'balanceDue', label: 'Balance payment due', icon: '💰', tone: 'info', orders: balanceDue },
      { key: 'layoutPending', label: 'Layout pending', icon: '🎨', tone: 'primary', orders: layoutPending },
      { key: 'noDeadline', label: 'No deadline set', icon: '📅', tone: 'muted', orders: noDeadline },
    ].map(g => ({ ...g, count: g.orders.length }));

    const badge = new Set([...overdue, ...dueSoon, ...balanceDue, ...layoutPending].map(o => o.id)).size;
    res.json({ groups, badge, activeCount: active.length });
  } catch (err) {
    console.error('crewfit reminders error:', err); res.status(500).json({ error: 'Failed to load reminders' });
  }
});

// GET /api/crewfit/orders — list with filters
router.get('/orders', async (req, res) => {
  try {
    const { status, payment_status, layout_status, so, vendor, search } = req.query;
    let orders = await fetchAll();
    const eq = (k, v) => { if (v) orders = orders.filter(o => (o[k] || '') === v); };
    eq('status', status); eq('payment_status', payment_status); eq('layout_status', layout_status); eq('so', so); eq('vendor', vendor);
    if (search) {
      const s = search.toLowerCase();
      orders = orders.filter(o => [o.customer_name, o.contact_number, o.description, String(o.sl_no)].some(x => (x || '').toLowerCase().includes(s)));
    }
    res.json({ orders, total: orders.length });
  } catch (err) {
    console.error('crewfit orders error:', err); res.status(500).json({ error: 'Failed to load orders' });
  }
});

// GET /api/crewfit/orders/:id
router.get('/orders/:id', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM crewfit_orders WHERE id = $1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

const EDITABLE = ['status', 'payment_status', 'layout_status', 'customer_type', 'so', 'vendor', 'mot', 'tracking_link',
  'deadline_at', 'deadline_text', 'dispatch_date', 'notes', 'total_cost', 'qty', 'color', 'size_breakdown',
  'customer_name', 'contact_number', 'mock_folder', 'description'];

// PUT /api/crewfit/orders/:id — inline field / dropdown updates
router.put('/orders/:id', async (req, res) => {
  try {
    const fields = Object.keys(req.body).filter(k => EDITABLE.includes(k));
    if (!fields.length) return res.status(400).json({ error: 'No editable fields provided' });
    const set = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
    const vals = fields.map(f => (req.body[f] === '' ? null : req.body[f]));
    vals.push(req.params.id);
    await db.query(`UPDATE crewfit_orders SET ${set}, updated_at = CURRENT_TIMESTAMP WHERE id = $${fields.length + 1}`, vals);
    const r = await db.query('SELECT * FROM crewfit_orders WHERE id = $1', [req.params.id]);
    res.json(r.rows[0]);
  } catch (err) {
    console.error('crewfit update error:', err); res.status(500).json({ error: 'Failed to update order' });
  }
});

// POST /api/crewfit/orders — create
router.post('/orders', async (req, res) => {
  try {
    const cols = ['customer_name', 'contact_number', 'description', 'color', 'size_breakdown', 'qty', 'total_cost',
      'deadline_at', 'deadline_text', 'order_date', 'customer_type', 'so', 'vendor', 'mot', 'mock_folder', 'notes',
      'layout_status', 'payment_status', 'status'];
    const provided = cols.filter(c => req.body[c] !== undefined && req.body[c] !== '');
    if (!req.body.customer_name) return res.status(400).json({ error: 'Customer name is required' });
    const nextRow = await db.query('SELECT COALESCE(MAX(sl_no), 0) + 1 AS next FROM crewfit_orders');
    const sl_no = nextRow.rows[0].next;
    const allCols = ['sl_no', ...provided];
    const vals = [sl_no, ...provided.map(c => req.body[c])];
    const ph = allCols.map((_, i) => `$${i + 1}`).join(',');
    const r = await db.query(`INSERT INTO crewfit_orders (${allCols.join(',')}) VALUES (${ph}) RETURNING *`, vals);
    res.status(201).json(r.rows[0]);
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

module.exports = router;
