/**
 * Purchase orders to vendors, for Normless and Crewfit — CRUD, the pick-lists, analytics, and the
 * outgoing PDF and WhatsApp text.
 *
 * Vendor orders stand alone rather than hanging off a customer order: one order to a vendor
 * routinely covers several styles at once, so a single CF link would fit the minority case.
 *
 * Money: an order's total is the agreed figure if one was entered, else rate × quantity. Once it
 * has a total, its payment status is worked out from the payments recorded against it
 * (services/vendor-money); without one it keeps the hand-set Paid / Not Paid it always had.
 *
 * Mounted at /api/vendor-orders, and at the old /api/crewfit/vendor-orders so nothing that still
 * points there breaks.
 */

const express = require('express');
const PDFDocument = require('pdfkit');
const db = require('../db/connection');
const { hasPermission } = require('../utils/permissions');
const vendorOrder = require('../services/vendor-order');
const money = require('../services/vendor-money');
const plan = require('../services/vendor-plan');
const receipts = require('../services/vendor-receipts');
const vendorWa = require('../services/vendor-wa');
const { tableParams, pagination } = require('../utils/table');

const router = express.Router();

const BRANDS = ['normless', 'crewfit'];

// Client column key → SQL expression. Only these can be sorted on. `products` sorts on the raw
// items JSON, which puts the same product types together — the closest SQL can get to the
// summary the table shows.
const SORTS = {
    ref_no: 'ref_no', order_date: 'order_date', delivery_date: 'delivery_date', vendor: 'LOWER(vendor)',
    brand: 'brand', products: 'items', total_qty: 'total_qty',
    total: 'COALESCE(total_override, total_amount)', paid_amount: 'paid_amount',
    balance: 'COALESCE(total_override, total_amount) - paid_amount',
    status: 'status', payment_status: 'payment_status',
};

// Vendors seen historically on Crewfit customer orders, offered before they are on the list.
const SEED_VENDORS = ['Mubas Clothings', 'PTI', 'Ashna Garments', 'Print Wear', 'Dutees', 'TPR Garments'];
const GSM_OPTIONS = ['160', '180', '200', '240', '250', '300'];
// Mirrors the vocabulary already used on customer orders, so the two lists read the same way.
// Partly Received is set by the deliveries recorded (services/vendor-receipts).
const STATUSES = ['Pending', 'Consignment Ordered', 'Partly Received', 'Consignment Received'];

router.use(async (req, res, next) => {
    try {
        if (!await hasPermission(req, 'can_view_vendors')) return res.status(403).json({ error: 'Access denied' });
        next();
    } catch (err) { next(err); }
});

// Ids are whole numbers; anything else is a path this router doesn't have.
router.param('id', (req, res, next, id) => (/^\d+$/.test(id) ? next() : res.status(404).json({ error: 'Not found' })));

const isAdmin = (req) => req.user?.role === 'owner' || req.user?.role === 'admin';
const canEdit = (req) => hasPermission(req, 'can_edit_vendor_orders');
const parseItems = (raw) => { try { return JSON.parse(raw || '[]'); } catch { return []; } };
const orderTotal = (row) => {
    const t = Number(row.total_override) > 0 ? Number(row.total_override) : Number(row.total_amount);
    return t > 0 ? t : null;
};
const hydrate = (row) => {
    const total = orderTotal(row);
    const paid = Number(row.paid_amount) || 0;
    const instalments = total ? plan.schedule(row.instalments || [], { paid_amount: paid, status: row.status }) : [];
    const planned = money.round2(instalments.reduce((s, i) => s + i.amount, 0));
    return {
        ...row,
        items: parseItems(row.items),
        ref: vendorOrder.refLabel(row),
        total,
        paid_amount: paid,
        balance: total ? money.round2(total - paid) : null,
        // Hand-set only when there is no total to work it out from.
        payment_manual: !total,
        instalments,
        next_instalment: plan.nextDue(instalments),
        received_qty: Number(row.received_qty) || 0,
        rejected_qty: Number(row.rejected_qty) || 0,
        // Rejected pieces are still owed.
        pending_qty: Math.max((Number(row.total_qty) || 0) - ((Number(row.received_qty) || 0) - (Number(row.rejected_qty) || 0)), 0),
        // The total changed after the plan was made, and fixed amounts no longer add up to it.
        plan_mismatch: instalments.length > 0 && Math.abs(planned - total) > 1 ? planned : null,
    };
};

const ROW_COLUMNS = `id, ref_no, brand, TO_CHAR(order_date, 'YYYY-MM-DD') AS order_date,
    TO_CHAR(delivery_date, 'YYYY-MM-DD') AS delivery_date, vendor, vendor_id, vendor_phone, title, quote_ref,
    status, payment_status, items, notes, total_qty, total_amount, total_override, paid_amount, received_qty, rejected_qty, quotation_id,
    confirmed_at, sent_at, created_by, created_at,
    COALESCE((SELECT json_agg(json_build_object('id', i.id, 'seq', i.seq, 'label', i.label, 'amount', i.amount,
                  'percent', i.percent, 'due_kind', i.due_kind, 'due_date', TO_CHAR(i.due_date, 'YYYY-MM-DD')) ORDER BY i.seq)
              FROM vendor_order_instalments i WHERE i.order_id = vendor_orders.id), '[]') AS instalments`;

const posInt = (v) => { const n = parseInt(v, 10); return n > 0 ? n : 0; };

/** Keep only lines the vendor could act on, and normalise numbers coming from text inputs. */
function cleanItems(items) {
    return (Array.isArray(items) ? items : [])
        .map(item => {
            const rate = Number(item.rate) > 0 ? Number(item.rate) : null;
            const product_type = String(item.product_type || '').trim();
            if (item.kind === 'simple') return { kind: 'simple', product_type, qty: posInt(item.qty), rate };
            return {
                product_type,
                gsm: String(item.gsm || '').trim(),
                rate,
                colors: (item.colors || [])
                    .map(c => {
                        const sizes = {};
                        for (const [size, qty] of Object.entries(c.sizes || {})) {
                            if (posInt(qty)) sizes[String(size).trim()] = posInt(qty);
                        }
                        return { color: String(c.color || '').trim(), sizes };
                    })
                    .filter(c => Object.keys(c.sizes).length),
            };
        })
        .filter(item => item.product_type && (item.kind === 'simple' ? item.qty > 0 : item.colors.length));
}

function validate(body) {
    if (!BRANDS.includes(body.brand)) return 'Pick which brand this order is for';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.order_date || '')) return 'A valid order date is required';
    // Delivery date is optional, but a malformed one should fail loudly rather than be dropped.
    if (body.delivery_date && !/^\d{4}-\d{2}-\d{2}$/.test(body.delivery_date)) return 'Delivery date must be a valid date';
    if (body.delivery_date && body.delivery_date < body.order_date) return 'Delivery date cannot be before the order date';
    if (!String(body.vendor || '').trim()) return 'Vendor is required';
    if (body.total_override !== '' && body.total_override != null && !(Number(body.total_override) >= 0)) return 'Total must be a number';
    if (!cleanItems(body.items).length) return 'Add at least one product with a quantity';
    return null;
}

const agreedTotal = (v) => (Number(v) > 0 ? money.round2(v) : null);
const clean = (v) => { const s = String(v ?? '').trim(); return s || null; };

/**
 * Put a vendor typed on the form onto the shared vendor list (or fill in its missing number), and
 * return its id. A vendor that now supplies the other brand too becomes "both".
 */
async function rememberVendor(name, phone, brand) {
    const vendor = String(name || '').trim();
    if (!vendor) return null;
    const digits = String(phone || '').replace(/\D/g, '');
    const r = await db.query(
        `INSERT INTO vendors (name, phone, brands, created_by) VALUES ($1, $2, $3, 'vendor order')
         ON CONFLICT (LOWER(name)) DO UPDATE SET
             phone = COALESCE(vendors.phone, EXCLUDED.phone),
             brands = CASE WHEN vendors.brands IN ('both', EXCLUDED.brands) THEN vendors.brands ELSE 'both' END,
             updated_at = CURRENT_TIMESTAMP
         RETURNING id`,
        [vendor, digits.length === 10 ? digits : null, brand]
    );
    return r.rows[0]?.id ?? null;
}

// GET /api/vendor-orders/meta — pick-lists for the form, and what this user may do
router.get('/meta', async (req, res) => {
    try {
        // The shared vendor list (archived vendors left out). Names used on Crewfit bulk orders
        // that never made it onto the list are still offered for Crewfit.
        const saved = (await db.query(
            'SELECT id, name, phone, brands FROM vendors WHERE active ORDER BY name')).rows;
        const used = (await db.query(
            `SELECT DISTINCT vendor FROM crewfit_orders WHERE vendor IS NOT NULL AND vendor <> ''`
        )).rows.map(r => r.vendor);
        const archived = new Set((await db.query('SELECT LOWER(name) AS n FROM vendors WHERE NOT active')).rows.map(r => r.n));

        const byName = new Map();
        for (const v of [...SEED_VENDORS, ...used]) {
            if (!archived.has(v.toLowerCase())) byName.set(v.toLowerCase(), { id: null, name: v, phone: null, brands: 'crewfit' });
        }
        // A saved vendor wins: it carries the id and phone number.
        for (const v of saved) byName.set(v.name.toLowerCase(), v);

        const products = (await db.query(
            'SELECT name, gsm FROM crewfit_products WHERE active = true ORDER BY sort_order'
        )).rows;

        res.json({
            vendors: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
            products,
            gsm: GSM_OPTIONS,
            sizes: vendorOrder.SIZES,
            statuses: STATUSES,
            paymentStatuses: money.PAID_STATUSES,
            manualPaymentStatuses: money.MANUAL_STATUSES,
            can: {
                edit: await canEdit(req),
                pay: await hasPermission(req, 'can_record_vendor_payments'),
                delete: isAdmin(req),
            },
        });
    } catch (err) {
        console.error('Error loading vendor-order meta:', err);
        res.status(500).json({ error: 'Failed to load options' });
    }
});

/** Monday of the week a date falls in, as YYYY-MM-DD. */
function weekOf(ymd) {
    const d = new Date(`${ymd}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
}
const PERIOD = { day: (ymd) => ymd, week: weekOf, month: (ymd) => `${ymd.slice(0, 7)}-01` };

/** Shared WHERE for the list and the analytics. */
function filters(q) {
    const where = [], vals = [];
    if (BRANDS.includes(q.brand)) { vals.push(q.brand); where.push(`brand = $${vals.length}`); }
    if (q.vendor_id) { vals.push(parseInt(q.vendor_id, 10) || 0); where.push(`vendor_id = $${vals.length}`); }
    else if (q.vendor) { vals.push(q.vendor); where.push(`vendor = $${vals.length}`); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.from || '')) { vals.push(q.from); where.push(`order_date >= $${vals.length}`); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.to || '')) { vals.push(q.to); where.push(`order_date <= $${vals.length}`); }
    return { where, vals };
}

// GET /api/vendor-orders/analytics?from&to&vendor&brand&group=month|week|day
// What was ordered from vendors over time, and how much of it is paid. Pieces are counted on every
// order; money only where the order has a total, and the orders without one are counted so the
// gap shows rather than reading as nothing owed.
router.get('/analytics', async (req, res) => {
    try {
        const group = PERIOD[req.query.group] ? req.query.group : 'month';
        const { where, vals } = filters(req.query);
        const rows = (await db.query(
            `SELECT TO_CHAR(order_date, 'YYYY-MM-DD') AS order_date, vendor, status, payment_status,
                    items, total_qty, total_amount, total_override, paid_amount
             FROM vendor_orders ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
             ORDER BY order_date`, vals
        )).rows;

        const blank = () => ({ orders: 0, pieces: 0, value: 0, paid_value: 0, pending_value: 0,
            paid_orders: 0, pending_orders: 0, paid_pieces: 0, pending_pieces: 0, unpriced: 0, received: 0 });
        const add = (acc, o) => {
            const pieces = Number(o.total_qty) || 0;
            const value = orderTotal(o) || 0;
            const paidValue = Math.min(Number(o.paid_amount) || 0, value);
            const paid = o.payment_status === 'Paid' || o.payment_status === 'Overpaid';
            acc.orders++; acc.pieces += pieces; acc.value += value;
            acc.paid_value += paidValue; acc.pending_value += value - paidValue;
            if (paid) { acc.paid_orders++; acc.paid_pieces += pieces; }
            else { acc.pending_orders++; acc.pending_pieces += pieces; }
            if (!value) acc.unpriced++;
            if (o.status === 'Consignment Received') acc.received++;
        };

        const totals = blank();
        const periods = new Map(), vendors = new Map(), products = new Map();
        for (const o of rows) {
            add(totals, o);
            const p = PERIOD[group](o.order_date);
            if (!periods.has(p)) periods.set(p, { period: p, ...blank() });
            add(periods.get(p), o);
            if (!vendors.has(o.vendor)) vendors.set(o.vendor, { vendor: o.vendor, last_order: null, ...blank() });
            const v = vendors.get(o.vendor);
            add(v, o); v.last_order = o.order_date;
            for (const item of parseItems(o.items)) {
                const name = item.product_type || 'Other';
                products.set(name, (products.get(name) || 0) + vendorOrder.itemQty(item));
            }
        }

        res.json({
            group,
            totals,
            series: [...periods.values()],
            vendors: [...vendors.values()].sort((a, b) => b.pieces - a.pieces),
            products: [...products.entries()].map(([name, pieces]) => ({ name, pieces })).sort((a, b) => b.pieces - a.pieces),
        });
    } catch (err) {
        console.error('Error loading vendor analytics:', err);
        res.status(500).json({ error: 'Failed to load vendor analytics' });
    }
});

// GET /api/vendor-orders?brand&vendor&vendor_id&status&payment&search
router.get('/', async (req, res) => {
    try {
        const { status, payment, search } = req.query;
        const t = tableParams(req.query, { sortable: SORTS, defaultSort: 'order_date' });
        const { where, vals } = filters(req.query);
        if (status) { vals.push(status); where.push(`status = $${vals.length}`); }
        if (payment === 'due') where.push(`COALESCE(total_override, total_amount) > paid_amount`);
        else if (payment) { vals.push(payment); where.push(`payment_status = $${vals.length}`); }
        if (search) {
            vals.push(`%${search}%`);
            const n = vals.length;
            where.push(`(vendor ILIKE $${n} OR items ILIKE $${n} OR notes ILIKE $${n} OR title ILIKE $${n} OR quote_ref ILIKE $${n})`);
        }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const countRes = await db.query(`SELECT COUNT(*)::int AS n FROM vendor_orders ${whereSql}`, vals);

        const r = await db.query(
            `SELECT ${ROW_COLUMNS} FROM vendor_orders
             ${whereSql} ${t.orderBy} LIMIT ${t.limit} OFFSET ${t.offset}`, vals
        );
        res.json({ orders: r.rows.map(hydrate), pagination: pagination(countRes.rows[0]?.n || 0, t) });
    } catch (err) {
        console.error('Error loading vendor orders:', err);
        res.status(500).json({ error: 'Failed to load vendor orders' });
    }
});

// GET /api/vendor-orders/:id — one order, with the payments against it
router.get('/:id', async (req, res) => {
    try {
        const r = await db.query(`SELECT ${ROW_COLUMNS} FROM vendor_orders WHERE id = $1`, [req.params.id]);
        if (!r.rows.length) return res.status(404).json({ error: 'Vendor order not found' });
        const payments = (await db.query(
            `SELECT p.id, TO_CHAR(p.paid_on, 'YYYY-MM-DD') AS paid_on, p.mode, p.reference, p.source,
                    p.amount AS payment_amount, a.amount, (p.proof_path IS NOT NULL) AS has_proof
             FROM vendor_payment_allocations a JOIN vendor_payments p ON p.id = a.payment_id
             WHERE a.order_id = $1 ORDER BY p.paid_on, p.id`, [req.params.id])).rows;
        const vendor = r.rows[0].vendor_id
            ? (await db.query('SELECT default_plan FROM vendors WHERE id = $1', [r.rows[0].vendor_id])).rows[0] : null;
        const deliveries = (await db.query(
            `SELECT id, TO_CHAR(received_on, 'YYYY-MM-DD') AS received_on, challan_no, note, lines, received_qty, rejected_qty, created_by
             FROM vendor_receipts WHERE order_id = $1 ORDER BY received_on DESC, id DESC`, [req.params.id])).rows
            .map(d => ({ ...d, lines: parseItems(d.lines) }));
        const order = hydrate(r.rows[0]);
        const quotation = order.quotation_id ? (await db.query(
            `SELECT id, quote_no, title, amount, TO_CHAR(quote_date, 'YYYY-MM-DD') AS quote_date, (file_path IS NOT NULL) AS has_file, file_name
             FROM vendor_quotations WHERE id = $1`, [order.quotation_id])).rows[0] || null : null;
        res.json({ order, quotation, payments, vendor_default_plan: parseItems(vendor?.default_plan),
            deliveries, progress: receipts.progress(order.items, deliveries) });
    } catch (err) {
        console.error('Error loading vendor order:', err);
        res.status(500).json({ error: 'Failed to load vendor order' });
    }
});

/** The columns both create and update write. */
function rowFrom(body, items) {
    const { qty, amount, hasPricing } = vendorOrder.totals(items);
    return {
        brand: body.brand,
        order_date: body.order_date,
        delivery_date: body.delivery_date || null,
        vendor: String(body.vendor).trim(),
        vendor_phone: clean(body.vendor_phone),
        title: clean(body.title),
        quote_ref: clean(body.quote_ref),
        items: JSON.stringify(items),
        notes: clean(body.notes),
        total_qty: qty,
        total_amount: hasPricing ? money.round2(amount) : null,
        total_override: agreedTotal(body.total_override),
    };
}

// POST /api/vendor-orders
router.post('/', async (req, res) => {
    if (!await canEdit(req)) return res.status(403).json({ error: 'You can view vendor orders but not raise them' });
    const bad = validate(req.body || {});
    if (bad) return res.status(400).json({ error: bad });

    try {
        const row = rowFrom(req.body, cleanItems(req.body.items));
        row.status = STATUSES.includes(req.body.status) ? req.body.status : 'Pending';
        // Only an order with no total takes a hand-set payment status; the rest start unpaid.
        row.payment_status = money.MANUAL_STATUSES.includes(req.body.payment_status) && !(row.total_override || row.total_amount)
            ? req.body.payment_status : 'Not Paid';
        row.vendor_id = await rememberVendor(row.vendor, row.vendor_phone, row.brand);
        row.created_by = req.user?.username || null;

        // Raised from a quotation: it must be this vendor's, and not already on another order.
        const quoteId = parseInt(req.body.quotation_id, 10) || null;
        if (quoteId) {
            const q = (await db.query('SELECT vendor_id, order_id FROM vendor_quotations WHERE id = $1', [quoteId])).rows[0];
            if (!q) return res.status(400).json({ error: 'That quotation no longer exists' });
            if (q.vendor_id !== row.vendor_id) return res.status(400).json({ error: 'The quotation is from another vendor — pick the vendor who sent it' });
            if (q.order_id) return res.status(409).json({ error: 'That quotation is already on another order' });
            row.quotation_id = quoteId;
        }

        const cols = Object.keys(row);
        const r = await db.transaction(async (c) => {
            const ins = await c.query(
                `INSERT INTO vendor_orders (ref_no, ${cols.join(', ')})
                 VALUES ((SELECT COALESCE(MAX(ref_no), 0) + 1 FROM vendor_orders), ${cols.map((_, i) => `$${i + 1}`).join(', ')})
                 RETURNING ${ROW_COLUMNS}`, cols.map(k => row[k]));
            if (quoteId) {
                await c.query(`UPDATE vendor_quotations SET status = 'Accepted', order_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
                    [ins.rows[0].id, quoteId]);
            }
            return ins;
        });
        const order = hydrate(r.rows[0]);
        const whatsapp = order.vendor_id ? await vendorWa.enqueue({ event: 'vendor_order', vendorId: order.vendor_id, ref: `order:${order.id}`,
            user: req.user?.username, notify: req.body?.notify_vendor !== false && req.body?.notify_vendor !== 'false' }) : null;
        res.json({ success: true, order, whatsapp });
    } catch (err) {
        console.error('Error creating vendor order:', err);
        res.status(500).json({ error: 'Failed to create vendor order' });
    }
});

// PUT /api/vendor-orders/:id
router.put('/:id', async (req, res) => {
    if (!await canEdit(req)) return res.status(403).json({ error: 'You can view vendor orders but not change them' });
    const bad = validate(req.body || {});
    if (bad) return res.status(400).json({ error: bad });

    try {
        const existing = (await db.query(
            `SELECT status, payment_status, vendor_id, total_qty, COALESCE(total_override, total_amount) AS total,
                    TO_CHAR(delivery_date, 'YYYY-MM-DD') AS delivery_date FROM vendor_orders WHERE id = $1`, [req.params.id])).rows[0];
        if (!existing) return res.status(404).json({ error: 'Vendor order not found' });

        const row = rowFrom(req.body, cleanItems(req.body.items));
        row.status = STATUSES.includes(req.body.status) ? req.body.status : existing.status;
        row.payment_status = money.MANUAL_STATUSES.includes(req.body.payment_status) ? req.body.payment_status : existing.payment_status;
        row.vendor_id = await rememberVendor(row.vendor, row.vendor_phone, row.brand);
        if (existing.vendor_id && row.vendor_id !== existing.vendor_id) {
            const paid = (await db.query('SELECT 1 FROM vendor_payment_allocations WHERE order_id = $1 LIMIT 1', [req.params.id])).rows[0];
            if (paid) return res.status(409).json({ error: 'Payments to this vendor are recorded against the order — move or delete them before changing the vendor' });
        }

        const cols = Object.keys(row);
        const r = await db.transaction(async (c) => {
            await c.query(
                `UPDATE vendor_orders SET ${cols.map((col, i) => `${col} = $${i + 1}`).join(', ')}, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $${cols.length + 1}`, [...cols.map(col => row[col]), req.params.id]);
            // A new total changes how much of it is paid, and what each percentage instalment is.
            const total = row.total_override || row.total_amount;
            if (total) {
                await c.query(`UPDATE vendor_order_instalments SET amount = ROUND($1 * percent / 100, 2)
                               WHERE order_id = $2 AND percent IS NOT NULL`, [total, req.params.id]);
            }
            await money.recompute([req.params.id], c);
            // Changed lines change what is still to come.
            if ((await c.query('SELECT 1 FROM vendor_receipts WHERE order_id = $1 LIMIT 1', [req.params.id])).rows[0]) {
                await receipts.refresh(req.params.id, c);
            }
            return c.query(`SELECT ${ROW_COLUMNS} FROM vendor_orders WHERE id = $1`, [req.params.id]);
        });
        const order = hydrate(r.rows[0]);
        // Once the vendor has been told about the order, a change to what they make, by when, or for
        // how much is told too.
        let whatsapp = null;
        const told = order.vendor_id && (await db.query(
            `SELECT 1 FROM vendor_wa_queue WHERE event = 'vendor_order' AND ref = $1 AND status = 'sent'`, [`order:${order.id}`])).rows[0];
        if (told) {
            const fmt = (v) => `₹${Number(v).toLocaleString('en-IN')}`;
            const changes = [];
            if (Number(existing.total_qty) !== Number(order.total_qty)) changes.push(`quantity is now ${order.total_qty} pieces (was ${existing.total_qty})`);
            if ((Number(existing.total) || 0) !== (Number(order.total) || 0) && order.total) changes.push(`order value is now ${fmt(order.total)} incl. GST`);
            if ((existing.delivery_date || '') !== (order.delivery_date || '') && order.delivery_date) changes.push(`expected delivery is now ${order.delivery_date.split('-').reverse().join('/')}`);
            if (changes.length) {
                whatsapp = await vendorWa.enqueue({ event: 'vendor_order_changed', vendorId: order.vendor_id, ref: `order-changed:${order.id}:${Date.now()}`,
                    note: changes.join('; '), user: req.user?.username, notify: req.body?.notify_vendor !== false && req.body?.notify_vendor !== 'false' });
            }
        }
        res.json({ success: true, order, whatsapp });
    } catch (err) {
        console.error('Error updating vendor order:', err);
        res.status(500).json({ error: 'Failed to update vendor order' });
    }
});

// POST /api/vendor-orders/:id/status — move the status on from the list (and the hand-set
// payment flag, for an order with no total)
router.post('/:id/status', async (req, res) => {
    if (!await canEdit(req)) return res.status(403).json({ error: 'Access denied' });
    const { status, payment_status: paymentStatus } = req.body || {};
    if (status !== undefined && !STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status' });
    if (paymentStatus !== undefined && !money.MANUAL_STATUSES.includes(paymentStatus)) {
        return res.status(400).json({ error: 'Unknown payment status' });
    }
    if (status === undefined && paymentStatus === undefined) return res.status(400).json({ error: 'Nothing to update' });

    try {
        const o = (await db.query('SELECT total_amount, total_override FROM vendor_orders WHERE id = $1', [req.params.id])).rows[0];
        if (!o) return res.status(404).json({ error: 'Vendor order not found' });
        if (paymentStatus !== undefined && orderTotal(o)) {
            return res.status(400).json({ error: 'This order has a total, so its payment status comes from the payments recorded — record a payment instead' });
        }
        const sets = [], vals = [];
        if (status !== undefined) { vals.push(status); sets.push(`status = $${vals.length}`); }
        if (paymentStatus !== undefined) { vals.push(paymentStatus); sets.push(`payment_status = $${vals.length}`); }
        vals.push(req.params.id);
        const r = await db.query(
            `UPDATE vendor_orders SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP
             WHERE id = $${vals.length} RETURNING ${ROW_COLUMNS}`, vals
        );
        res.json({ success: true, order: hydrate(r.rows[0]) });
    } catch (err) {
        console.error('Error updating vendor order status:', err);
        res.status(500).json({ error: 'Failed to update status' });
    }
});

// GET /api/vendor-orders/:id/message — the WhatsApp text
router.get('/:id/message', async (req, res) => {
    try {
        const r = await db.query(`SELECT ${ROW_COLUMNS} FROM vendor_orders WHERE id = $1`, [req.params.id]);
        if (!r.rows.length) return res.status(404).json({ error: 'Vendor order not found' });
        const order = hydrate(r.rows[0]);
        res.json({ message: vendorOrder.buildVendorMessage(order), phone: order.vendor_phone });
    } catch (err) {
        console.error('Error building vendor message:', err);
        res.status(500).json({ error: 'Failed to build message' });
    }
});

// GET /api/vendor-orders/:id/pdf
router.get('/:id/pdf', async (req, res) => {
    try {
        const r = await db.query(`SELECT ${ROW_COLUMNS} FROM vendor_orders WHERE id = $1`, [req.params.id]);
        if (!r.rows.length) return res.status(404).json({ error: 'Vendor order not found' });
        const order = hydrate(r.rows[0]);

        const doc = new PDFDocument({ size: 'A4', margin: 0 });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${order.ref}-${String(order.vendor).replace(/[^\w -]/g, '')}.pdf"`);
        doc.pipe(res);
        vendorOrder.renderVendorOrder(doc, order);
        doc.end();
    } catch (err) {
        console.error('Error rendering vendor order PDF:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to render PDF' });
    }
});

// Deliveries (goods in) — recorded by whoever can edit vendor orders.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const todayIST = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

async function readDelivery(req) {
    const o = (await db.query('SELECT id, items FROM vendor_orders WHERE id = $1', [req.params.id])).rows[0];
    if (!o) return { status: 404, error: 'Vendor order not found' };
    const b = req.body || {};
    if (!DATE_RE.test(b.received_on || '')) return { error: 'A valid delivery date is required' };
    if (b.received_on > todayIST()) return { error: 'The delivery date can’t be in the future' };
    const checked = receipts.cleanLines(b.lines, parseItems(o.items));
    if (checked.error) return { error: checked.error };
    return { row: { received_on: b.received_on, challan_no: clean(b.challan_no), note: clean(b.note),
        lines: JSON.stringify(checked.lines), received_qty: checked.received, rejected_qty: checked.rejected } };
}

// POST /api/vendor-orders/:id/deliveries
router.post('/:id/deliveries', async (req, res) => {
    if (!await canEdit(req)) return res.status(403).json({ error: 'Access denied' });
    try {
        const d = await readDelivery(req);
        if (d.error) return res.status(d.status || 400).json({ error: d.error });
        const cols = Object.keys(d.row);
        const id = await db.transaction(async (c) => {
            const r = (await c.query(
                `INSERT INTO vendor_receipts (order_id, ${cols.join(', ')}, created_by)
                 VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}, $${cols.length + 2}) RETURNING id`,
                [req.params.id, ...cols.map(k => d.row[k]), req.user?.username || null])).rows[0];
            await receipts.refresh(req.params.id, c);
            return r.id;
        });
        const vendorId = (await db.query('SELECT vendor_id FROM vendor_orders WHERE id = $1', [req.params.id])).rows[0]?.vendor_id;
        let whatsapp = null;
        if (vendorId) {
            const user = req.user?.username, notify = req.body?.notify_vendor !== false && req.body?.notify_vendor !== 'false';
            whatsapp = await vendorWa.enqueue({ event: 'vendor_delivery', vendorId, ref: `delivery:${req.params.id}:${d.row.received_on}`, user, notify });
            if (d.row.rejected_qty > 0) await vendorWa.enqueue({ event: 'vendor_rejected', vendorId, ref: `rejected:${id}`, user, notify });
        }
        res.json({ success: true, id, whatsapp });
    } catch (err) {
        console.error('Error recording delivery:', err);
        res.status(500).json({ error: 'Failed to record the delivery' });
    }
});

// PUT /api/vendor-orders/:id/deliveries/:rid
router.put('/:id/deliveries/:rid', async (req, res) => {
    if (!await canEdit(req)) return res.status(403).json({ error: 'Access denied' });
    try {
        const d = await readDelivery(req);
        if (d.error) return res.status(d.status || 400).json({ error: d.error });
        const cols = Object.keys(d.row);
        const found = await db.transaction(async (c) => {
            const r = await c.query(
                `UPDATE vendor_receipts SET ${cols.map((k, i) => `${k} = $${i + 1}`).join(', ')},
                     updated_by = $${cols.length + 1}, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $${cols.length + 2} AND order_id = $${cols.length + 3} RETURNING id`,
                [...cols.map(k => d.row[k]), req.user?.username || null, parseInt(req.params.rid, 10) || 0, req.params.id]);
            if (r.rows.length) await receipts.refresh(req.params.id, c);
            return r.rows.length > 0;
        });
        if (!found) return res.status(404).json({ error: 'Delivery not found' });
        // Rejects added on an edit are still news to the vendor.
        if (d.row.rejected_qty > 0) {
            const vendorId = (await db.query('SELECT vendor_id FROM vendor_orders WHERE id = $1', [req.params.id])).rows[0]?.vendor_id;
            if (vendorId) await vendorWa.enqueue({ event: 'vendor_rejected', vendorId, ref: `rejected:${parseInt(req.params.rid, 10)}`, user: req.user?.username, notify: req.body?.notify_vendor !== false && req.body?.notify_vendor !== 'false' });
        }
        res.json({ success: true });
    } catch (err) {
        console.error('Error saving delivery:', err);
        res.status(500).json({ error: 'Failed to save the delivery' });
    }
});

// DELETE /api/vendor-orders/:id/deliveries/:rid
router.delete('/:id/deliveries/:rid', async (req, res) => {
    if (!await canEdit(req)) return res.status(403).json({ error: 'Access denied' });
    try {
        const found = await db.transaction(async (c) => {
            const r = await c.query('DELETE FROM vendor_receipts WHERE id = $1 AND order_id = $2 RETURNING id',
                [parseInt(req.params.rid, 10) || 0, req.params.id]);
            if (r.rows.length) await receipts.refresh(req.params.id, c);
            return r.rows.length > 0;
        });
        if (!found) return res.status(404).json({ error: 'Delivery not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting delivery:', err);
        res.status(500).json({ error: 'Failed to delete the delivery' });
    }
});

// PUT /api/vendor-orders/:id/plan { instalments: [...], save_as_default } — the payment plan.
// Set by whoever records payments: it is the money side of the order.
router.put('/:id/plan', async (req, res) => {
    if (!await hasPermission(req, 'can_record_vendor_payments')) return res.status(403).json({ error: 'Only people who record vendor payments can set a payment plan' });
    try {
        const o = (await db.query(
            `SELECT id, vendor_id, TO_CHAR(order_date, 'YYYY-MM-DD') AS order_date, total_amount, total_override
             FROM vendor_orders WHERE id = $1`, [req.params.id])).rows[0];
        if (!o) return res.status(404).json({ error: 'Vendor order not found' });
        const total = orderTotal(o);
        const { error, rows } = plan.cleanPlan(req.body?.instalments, total);
        if (error) return res.status(400).json({ error });

        await db.transaction(async (c) => {
            await c.query('DELETE FROM vendor_order_instalments WHERE order_id = $1', [o.id]);
            for (const r of rows) {
                await c.query(
                    `INSERT INTO vendor_order_instalments (order_id, seq, label, amount, percent, due_kind, due_date)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [o.id, r.seq, r.label, r.amount, r.percent, r.due_kind, r.due_date]);
            }
            if (req.body?.save_as_default && o.vendor_id && rows.length) {
                await c.query('UPDATE vendors SET default_plan = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                    [JSON.stringify(plan.toTemplate(rows, total, o.order_date)), o.vendor_id]);
            }
        });
        const r = await db.query(`SELECT ${ROW_COLUMNS} FROM vendor_orders WHERE id = $1`, [o.id]);
        res.json({ success: true, order: hydrate(r.rows[0]) });
    } catch (err) {
        console.error('Error saving payment plan:', err);
        res.status(500).json({ error: 'Failed to save the payment plan' });
    }
});

// DELETE /api/vendor-orders/:id — not while payments are recorded against it
router.delete('/:id', async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Access denied' });
    try {
        const paid = (await db.query('SELECT 1 FROM vendor_payment_allocations WHERE order_id = $1 LIMIT 1', [req.params.id])).rows[0];
        if (paid) return res.status(409).json({ error: 'Payments are recorded against this order — delete or move them first' });
        const r = await db.transaction(async (c) => {
            // Its quotation goes back to open rather than staying "accepted" for an order that's gone.
            await c.query(`UPDATE vendor_quotations SET status = 'Received', order_id = NULL WHERE order_id = $1`, [req.params.id]);
            return c.query('DELETE FROM vendor_orders WHERE id = $1 RETURNING id', [req.params.id]);
        });
        if (!r.rows.length) return res.status(404).json({ error: 'Vendor order not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting vendor order:', err);
        res.status(500).json({ error: 'Failed to delete vendor order' });
    }
});

module.exports = router;
