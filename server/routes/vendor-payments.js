/**
 * Payments made to vendors — each with its UTR / bank reference, an optional proof screenshot, and
 * how it is split across that vendor's orders.
 *
 * Seeing payments needs `can_view_vendors`; recording, editing and attaching proof need
 * `can_record_vendor_payments`; deleting is admin-only. Money not allocated to an order stays with
 * the vendor as credit "on account". Every change re-works out the paid amount and payment status
 * of each order it touches (services/vendor-money).
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db/connection');
const { hasPermission } = require('../utils/permissions');
const { tableParams, pagination } = require('../utils/table');
const { refLabel } = require('../services/vendor-order');
const money = require('../services/vendor-money');
const plan = require('../services/vendor-plan');

const router = express.Router();

// Not under server/uploads: that directory is served statically, and a bank screenshot must never
// be fetchable by anyone who guesses a filename.
const STORE = path.join(__dirname, '..', 'storage', 'vendors', 'payments');
const MAX_MB = 8;
const PROOF_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' };
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => (PROOF_TYPES[file.mimetype] ? cb(null, true) : cb(new Error('Attach a JPG, PNG, WebP or PDF'))),
});

const MODES = ['NEFT', 'IMPS', 'UPI', 'RTGS', 'Cheque', 'Cash'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.use(async (req, res, next) => {
    try {
        if (!await hasPermission(req, 'can_view_vendors')) return res.status(403).json({ error: 'Access denied' });
        next();
    } catch (err) { next(err); }
});
router.param('id', (req, res, next, id) => (/^\d+$/.test(id) ? next() : res.status(404).json({ error: 'Not found' })));

const isAdmin = (req) => req.user?.role === 'owner' || req.user?.role === 'admin';
const canPay = (req) => hasPermission(req, 'can_record_vendor_payments');
const clean = (v) => { const s = String(v ?? '').trim(); return s || null; };
const today = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);   // India

const SORTS = {
    paid_on: 'p.paid_on', vendor: 'LOWER(v.name)', amount: 'p.amount', mode: 'p.mode', reference: 'p.reference',
};

const INST_SQL = `COALESCE((SELECT json_agg(json_build_object('id', i.id, 'seq', i.seq, 'label', i.label, 'amount', i.amount,
                  'percent', i.percent, 'due_kind', i.due_kind, 'due_date', TO_CHAR(i.due_date, 'YYYY-MM-DD')) ORDER BY i.seq)
              FROM vendor_order_instalments i WHERE i.order_id = o.id), '[]') AS instalments`;

const LIST_COLUMNS = `p.id, p.vendor_id, v.name AS vendor, TO_CHAR(p.paid_on, 'YYYY-MM-DD') AS paid_on, p.amount,
    p.mode, p.reference, p.paid_from, p.note, p.source, (p.proof_path IS NOT NULL) AS has_proof, p.proof_name,
    p.created_by, p.created_at,
    COALESCE((SELECT json_agg(json_build_object('order_id', o.id, 'ref_no', o.ref_no, 'brand', o.brand, 'amount', a.amount)
                              ORDER BY o.order_date, o.id)
              FROM vendor_payment_allocations a JOIN vendor_orders o ON o.id = a.order_id
              WHERE a.payment_id = p.id), '[]') AS allocations`;

/** A UTR is missing on a payment we recorded ourselves, by any route but cash. */
const MISSING_REF_SQL = `(p.source = 'manual' AND COALESCE(p.mode, '') <> 'Cash' AND COALESCE(TRIM(p.reference), '') = '')`;

const hydrate = (p) => ({
    ...p,
    amount: Number(p.amount),
    allocations: (p.allocations || []).map(a => ({ ...a, amount: Number(a.amount), ref: refLabel(a) })),
    allocated: money.round2((p.allocations || []).reduce((s, a) => s + Number(a.amount), 0)),
    missing_reference: p.source === 'manual' && p.mode !== 'Cash' && !String(p.reference || '').trim(),
});

// GET /api/vendor-payments?vendor_id&brand&from&to&mode&missing_ref=1&search
router.get('/', async (req, res) => {
    try {
        const t = tableParams(req.query, { sortable: SORTS, defaultSort: 'paid_on', tiebreak: 'p.id' });
        const where = [], vals = [];
        const q = req.query;
        if (q.vendor_id) { vals.push(parseInt(q.vendor_id, 10) || 0); where.push(`p.vendor_id = $${vals.length}`); }
        if (['normless', 'crewfit'].includes(q.brand)) {
            vals.push(q.brand);
            where.push(`EXISTS (SELECT 1 FROM vendor_payment_allocations a JOIN vendor_orders o ON o.id = a.order_id
                               WHERE a.payment_id = p.id AND o.brand = $${vals.length})`);
        }
        if (DATE_RE.test(q.from || '')) { vals.push(q.from); where.push(`p.paid_on >= $${vals.length}`); }
        if (DATE_RE.test(q.to || '')) { vals.push(q.to); where.push(`p.paid_on <= $${vals.length}`); }
        if (MODES.includes(q.mode)) { vals.push(q.mode); where.push(`p.mode = $${vals.length}`); }
        if (q.missing_ref === '1') where.push(MISSING_REF_SQL);
        if (q.search) {
            vals.push(`%${q.search}%`);
            const n = vals.length;
            where.push(`(v.name ILIKE $${n} OR p.reference ILIKE $${n} OR p.note ILIKE $${n})`);
        }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const from = 'FROM vendor_payments p JOIN vendors v ON v.id = p.vendor_id';

        const sum = (await db.query(
            `SELECT COUNT(*)::int AS n, COALESCE(SUM(p.amount), 0) AS total,
                    COUNT(*) FILTER (WHERE ${MISSING_REF_SQL})::int AS missing_ref
             ${from} ${whereSql}`, vals)).rows[0];
        const rows = (await db.query(
            `SELECT ${LIST_COLUMNS} ${from} ${whereSql} ${t.orderBy}
             LIMIT ${t.limit} OFFSET ${t.offset}`, vals)).rows;

        res.json({
            payments: rows.map(hydrate),
            summary: { count: sum.n, total: Number(sum.total), missing_ref: sum.missing_ref },
            pagination: pagination(sum.n, t),
        });
    } catch (err) {
        console.error('vendor payments list:', err);
        res.status(500).json({ error: 'Failed to load payments' });
    }
});

const DUE_ORDER = { Overdue: 0, Due: 1, 'Due soon': 2, Upcoming: 3, 'No date': 4, 'On delivery': 5 };

/** Every instalment still owing, across orders, with its order and vendor. */
async function dueInstalments({ brand, vendorId } = {}) {
    const where = [`${money.TOTAL_SQL} > o.paid_amount`, 'EXISTS (SELECT 1 FROM vendor_order_instalments i WHERE i.order_id = o.id)'];
    const vals = [];
    if (['normless', 'crewfit'].includes(brand)) { vals.push(brand); where.push(`o.brand = $${vals.length}`); }
    if (vendorId) { vals.push(vendorId); where.push(`o.vendor_id = $${vals.length}`); }
    const orders = (await db.query(
        `SELECT o.id, o.ref_no, o.brand, o.vendor_id, v.name AS vendor, TO_CHAR(o.order_date, 'YYYY-MM-DD') AS order_date,
                o.title, o.quote_ref, o.status, ${money.TOTAL_SQL} AS total, o.paid_amount, ${INST_SQL}
         FROM vendor_orders o LEFT JOIN vendors v ON v.id = o.vendor_id
         WHERE ${where.join(' AND ')}`, vals)).rows;
    const out = [];
    for (const o of orders) {
        for (const i of plan.schedule(o.instalments, o)) {
            if (i.status === 'Paid') continue;
            out.push({ ...i, order_id: o.id, ref: refLabel(o), brand: o.brand, vendor_id: o.vendor_id, vendor: o.vendor,
                title: o.title, quote_ref: o.quote_ref, order_total: Number(o.total), order_paid: Number(o.paid_amount) });
        }
    }
    return out.sort((a, b) => (DUE_ORDER[a.status] - DUE_ORDER[b.status])
        || String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')) || a.order_id - b.order_id || a.seq - b.seq);
}

// GET /api/vendor-payments/due?brand&vendor_id — what is owed on payment plans, most urgent first
router.get('/due', async (req, res) => {
    try {
        const rows = await dueInstalments({ brand: req.query.brand, vendorId: parseInt(req.query.vendor_id, 10) || null });
        const bucket = (keep) => {
            const list = rows.filter(r => keep.includes(r.status));
            return { count: list.length, amount: money.round2(list.reduce((s, r) => s + r.remaining, 0)) };
        };
        res.json({
            instalments: rows,
            summary: {
                overdue: bucket(['Overdue']),
                due: bucket(['Due']),
                soon: bucket(['Due soon']),
                later: bucket(['Upcoming', 'No date', 'On delivery']),
            },
        });
    } catch (err) {
        console.error('vendor instalments due:', err);
        res.status(500).json({ error: 'Failed to load what is due' });
    }
});

// GET /api/vendor-payments/due-count — for the menu badge: instalments overdue or due today
router.get('/due-count', async (req, res) => {
    try {
        const rows = await dueInstalments();
        res.json({ due: rows.filter(r => r.status === 'Overdue' || r.status === 'Due').length });
    } catch (err) {
        console.error('vendor due count:', err);
        res.status(500).json({ error: 'Failed' });
    }
});

// GET /api/vendor-payments/form?vendor_id&payment_id — what the payment form needs: the vendor's
// bank details and balance, and the orders it can be put against (with what is still due on each,
// counting this payment's own share as not yet paid when it is being edited).
router.get('/form', async (req, res) => {
    try {
        if (!await canPay(req)) return res.status(403).json({ error: 'Access denied' });
        const vendorId = parseInt(req.query.vendor_id, 10) || 0;
        const paymentId = parseInt(req.query.payment_id, 10) || 0;
        const vendor = (await db.query(
            `SELECT id, name, phone, bank_account_name, bank_account_no, bank_ifsc, bank_name, upi_id
             FROM vendors WHERE id = $1`, [vendorId])).rows[0];
        if (!vendor) return res.status(404).json({ error: 'Vendor not found' });

        const orders = (await db.query(
            `SELECT o.id, o.ref_no, o.brand, TO_CHAR(o.order_date, 'YYYY-MM-DD') AS order_date, o.title, o.quote_ref,
                    o.status, o.payment_status, o.items, ${money.TOTAL_SQL} AS total, o.paid_amount, ${INST_SQL},
                    o.paid_amount - COALESCE((SELECT a.amount FROM vendor_payment_allocations a
                                              WHERE a.order_id = o.id AND a.payment_id = $2), 0) AS paid_elsewhere,
                    COALESCE((SELECT a.amount FROM vendor_payment_allocations a
                              WHERE a.order_id = o.id AND a.payment_id = $2), 0) AS this_payment
             FROM vendor_orders o
             WHERE o.vendor_id = $1
             ORDER BY o.order_date, o.id`, [vendorId, paymentId])).rows
            .map(o => {
                const total = Number(o.total) > 0 ? Number(o.total) : null;
                const due = total ? money.round2(total - Number(o.paid_elsewhere)) : null;
                // The next instalment as it stands without this payment, to suggest an amount.
                const next = total ? plan.nextDue(plan.schedule(o.instalments, { ...o, paid_amount: o.paid_elsewhere })) : null;
                return {
                    next_instalment: next && { number: next.number, of: next.of, label: next.label, remaining: next.remaining, due_date: next.due_date, status: next.status },
                    id: o.id, ref: refLabel(o), brand: o.brand, order_date: o.order_date, title: o.title, quote_ref: o.quote_ref,
                    status: o.status, payment_status: o.payment_status, total, due, this_payment: Number(o.this_payment),
                    summary: (() => { try { return JSON.parse(o.items || '[]').map(i => i.product_type).filter(Boolean).join(', '); } catch { return ''; } })(),
                };
            })
            // Offer what can still take money, plus anything this payment already sits on.
            .filter(o => o.this_payment > 0 || (o.total ? o.due > 0 : o.payment_status !== 'Paid'));

        res.json({ vendor, orders, money: await money.vendorMoney(vendorId), modes: MODES });
    } catch (err) {
        console.error('vendor payment form:', err);
        res.status(500).json({ error: 'Failed to load the payment form' });
    }
});

// GET /api/vendor-payments/:id
router.get('/:id', async (req, res) => {
    try {
        const r = (await db.query(`SELECT ${LIST_COLUMNS} FROM vendor_payments p JOIN vendors v ON v.id = p.vendor_id WHERE p.id = $1`,
            [req.params.id])).rows[0];
        if (!r) return res.status(404).json({ error: 'Payment not found' });
        res.json({ payment: hydrate(r) });
    } catch (err) {
        console.error('vendor payment:', err);
        res.status(500).json({ error: 'Failed to load payment' });
    }
});

/**
 * Check a payment and its split. Returns { error } or { row, allocations }. `paymentId` is set when
 * editing, so the payment's current split isn't counted against itself.
 */
async function readPayment(body, paymentId = null) {
    const vendorId = parseInt(body.vendor_id, 10);
    const vendor = vendorId && (await db.query('SELECT id FROM vendors WHERE id = $1', [vendorId])).rows[0];
    if (!vendor) return { error: 'Pick the vendor this payment went to' };
    if (!DATE_RE.test(body.paid_on || '')) return { error: 'A valid payment date is required' };
    if (body.paid_on > today()) return { error: 'The payment date can’t be in the future' };
    const amount = money.round2(body.amount);
    if (!(amount > 0) || amount > 1e9) return { error: 'Enter the amount paid' };
    if (!MODES.includes(body.mode)) return { error: 'Pick how it was paid' };
    const reference = clean(body.reference);
    if (body.mode !== 'Cash' && !reference) return { error: 'Enter the UTR / bank reference — it’s how the vendor matches the payment' };
    if (reference && reference.length > 60) return { error: 'The reference is too long' };

    const wanted = (Array.isArray(body.allocations) ? body.allocations : [])
        .map(a => ({ order_id: parseInt(a.order_id, 10), amount: money.round2(a.amount) }))
        .filter(a => a.order_id && a.amount > 0);
    if (new Set(wanted.map(a => a.order_id)).size !== wanted.length) return { error: 'An order is listed twice' };
    const allocated = money.round2(wanted.reduce((s, a) => s + a.amount, 0));
    if (allocated > amount) return { error: `₹${allocated.toLocaleString('en-IN')} is split across orders, more than the ₹${amount.toLocaleString('en-IN')} paid` };

    if (wanted.length) {
        const orders = (await db.query(
            `SELECT o.id, o.ref_no, o.vendor_id, ${money.TOTAL_SQL} AS total,
                    o.paid_amount - COALESCE((SELECT a.amount FROM vendor_payment_allocations a
                                              WHERE a.order_id = o.id AND a.payment_id = $2), 0) AS paid_elsewhere
             FROM vendor_orders o WHERE o.id = ANY($1::int[])`, [wanted.map(a => a.order_id), paymentId || 0])).rows;
        for (const a of wanted) {
            const o = orders.find(x => x.id === a.order_id);
            if (!o || o.vendor_id !== vendorId) return { error: 'One of the orders isn’t this vendor’s' };
            if (Number(o.total) > 0) {
                const due = money.round2(Number(o.total) - Number(o.paid_elsewhere));
                if (a.amount > due) return { error: `${refLabel(o)} has ₹${Math.max(due, 0).toLocaleString('en-IN')} still due — put the rest on another order or leave it on account` };
            }
        }
    }

    return {
        row: { vendor_id: vendorId, paid_on: body.paid_on, amount, mode: body.mode, reference,
            paid_from: clean(body.paid_from), note: clean(body.note) },
        allocations: wanted,
    };
}

async function writeAllocations(c, paymentId, allocations) {
    const before = (await c.query('SELECT order_id FROM vendor_payment_allocations WHERE payment_id = $1', [paymentId])).rows.map(r => r.order_id);
    await c.query('DELETE FROM vendor_payment_allocations WHERE payment_id = $1', [paymentId]);
    for (const a of allocations) {
        await c.query('INSERT INTO vendor_payment_allocations (payment_id, order_id, amount) VALUES ($1, $2, $3)',
            [paymentId, a.order_id, a.amount]);
    }
    await money.recompute([...before, ...allocations.map(a => a.order_id)], c);
}

// POST /api/vendor-payments
router.post('/', async (req, res) => {
    try {
        if (!await canPay(req)) return res.status(403).json({ error: 'You can see payments but not record them' });
        const { error, row, allocations } = await readPayment(req.body || {});
        if (error) return res.status(400).json({ error });
        const id = await db.transaction(async (c) => {
            const cols = Object.keys(row);
            const p = (await c.query(
                `INSERT INTO vendor_payments (${cols.join(', ')}, created_by)
                 VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, $${cols.length + 1}) RETURNING id`,
                [...cols.map(k => row[k]), req.user?.username || null])).rows[0];
            await writeAllocations(c, p.id, allocations);
            return p.id;
        });
        res.json({ success: true, id });
    } catch (err) {
        console.error('vendor payment create:', err);
        res.status(500).json({ error: 'Failed to record the payment' });
    }
});

// PUT /api/vendor-payments/:id
router.put('/:id', async (req, res) => {
    try {
        if (!await canPay(req)) return res.status(403).json({ error: 'Access denied' });
        const existing = (await db.query('SELECT id, vendor_id FROM vendor_payments WHERE id = $1', [req.params.id])).rows[0];
        if (!existing) return res.status(404).json({ error: 'Payment not found' });
        const { error, row, allocations } = await readPayment(req.body || {}, existing.id);
        if (error) return res.status(400).json({ error });
        await db.transaction(async (c) => {
            const cols = Object.keys(row);
            await c.query(
                `UPDATE vendor_payments SET ${cols.map((k, i) => `${k} = $${i + 1}`).join(', ')},
                     updated_by = $${cols.length + 1}, updated_at = CURRENT_TIMESTAMP, source = 'manual'
                 WHERE id = $${cols.length + 2}`, [...cols.map(k => row[k]), req.user?.username || null, existing.id]);
            await writeAllocations(c, existing.id, allocations);
        });
        res.json({ success: true, id: existing.id });
    } catch (err) {
        console.error('vendor payment update:', err);
        res.status(500).json({ error: 'Failed to save the payment' });
    }
});

// DELETE /api/vendor-payments/:id — admin only; the orders it paid go back to owing it
router.delete('/:id', async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only an admin can delete a payment' });
    try {
        const p = (await db.query('SELECT id, amount, reference, proof_path FROM vendor_payments WHERE id = $1', [req.params.id])).rows[0];
        if (!p) return res.status(404).json({ error: 'Payment not found' });
        await db.transaction(async (c) => {
            const orders = (await c.query('SELECT order_id FROM vendor_payment_allocations WHERE payment_id = $1', [p.id])).rows.map(r => r.order_id);
            await c.query('DELETE FROM vendor_payments WHERE id = $1', [p.id]);
            await money.recompute(orders, c);
        });
        if (p.proof_path) { try { fs.unlinkSync(path.join(STORE, p.proof_path)); } catch { /* the row is what matters */ } }
        console.log(`vendor payment ${p.id} deleted by ${req.user?.username}: ₹${p.amount}, ref ${p.reference || '—'}`);
        res.json({ success: true });
    } catch (err) {
        console.error('vendor payment delete:', err);
        res.status(500).json({ error: 'Failed to delete the payment' });
    }
});

// POST /api/vendor-payments/:id/proof — attach (or replace) the bank screenshot / advice
router.post('/:id/proof', async (req, res, next) => {
    if (!await canPay(req)) return res.status(403).json({ error: 'Access denied' });
    upload.single('file')(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `The file is over ${MAX_MB} MB` : err.message });
        next();
    });
}, async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file attached' });
        const p = (await db.query('SELECT id, proof_path FROM vendor_payments WHERE id = $1', [req.params.id])).rows[0];
        if (!p) return res.status(404).json({ error: 'Payment not found' });
        fs.mkdirSync(STORE, { recursive: true });
        const name = `${p.id}-${crypto.randomBytes(8).toString('hex')}${PROOF_TYPES[req.file.mimetype]}`;
        fs.writeFileSync(path.join(STORE, name), req.file.buffer);
        await db.query('UPDATE vendor_payments SET proof_path = $1, proof_name = $2, proof_mime = $3 WHERE id = $4',
            [name, String(req.file.originalname || 'proof').slice(0, 120), req.file.mimetype, p.id]);
        if (p.proof_path) { try { fs.unlinkSync(path.join(STORE, p.proof_path)); } catch { /* replaced anyway */ } }
        res.json({ success: true });
    } catch (err) {
        console.error('vendor payment proof:', err);
        res.status(500).json({ error: 'Failed to save the file' });
    }
});

// GET /api/vendor-payments/:id/proof
router.get('/:id/proof', async (req, res) => {
    try {
        const p = (await db.query('SELECT proof_path, proof_name, proof_mime FROM vendor_payments WHERE id = $1', [req.params.id])).rows[0];
        if (!p?.proof_path) return res.status(404).json({ error: 'No proof attached' });
        const file = path.join(STORE, path.basename(p.proof_path));
        if (!fs.existsSync(file)) return res.status(404).json({ error: 'The file is missing' });
        res.setHeader('Content-Type', p.proof_mime || 'application/octet-stream');
        res.setHeader('Content-Disposition', `inline; filename="${String(p.proof_name || 'proof').replace(/[^\w. -]/g, '')}"`);
        fs.createReadStream(file).pipe(res);
    } catch (err) {
        console.error('vendor payment proof read:', err);
        res.status(500).json({ error: 'Failed to read the file' });
    }
});

module.exports = router;
