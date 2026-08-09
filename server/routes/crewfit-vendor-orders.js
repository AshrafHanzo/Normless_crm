/**
 * Crewfit vendor purchase orders — CRUD, the vendor/product pick-lists, and the outgoing PDF
 * and WhatsApp text.
 *
 * Vendor orders stand alone rather than hanging off a customer order: one order to a vendor
 * routinely covers several styles at once, so a single CF link would fit the minority case.
 */

const express = require('express');
const PDFDocument = require('pdfkit');
const db = require('../db/connection');
const { hasPermission } = require('../utils/permissions');
const vendorOrder = require('../services/vendor-order');
const { tableParams, pagination } = require('../utils/table');

const router = express.Router();

// Client column key → SQL expression. Only these can be sorted on. `products` sorts on the raw
// items JSON, which puts the same product types together — the closest SQL can get to the
// summary the table shows.
const VENDOR_ORDER_SORTS = {
    ref_no: 'ref_no', order_date: 'order_date', delivery_date: 'delivery_date', vendor: 'LOWER(vendor)',
    products: 'items', total_qty: 'total_qty', total_amount: 'total_amount',
    status: 'status', payment_status: 'payment_status',
};

// Vendors seen historically on customer orders, used to seed the dropdown before this module
// has any vendors of its own.
const SEED_VENDORS = ['Mubas Clothings', 'PTI', 'Ashna Garments', 'Print Wear', 'Dutees', 'TPR Garments'];
const GSM_OPTIONS = ['160', '180', '200', '240', '250', '300'];
// Mirrors the vocabulary already used on customer orders, so the two lists read the same way.
const STATUSES = ['Pending', 'Consignment Ordered', 'Consignment Received'];
const PAYMENT_STATUSES = ['Not Paid', 'Paid'];

router.use(async (req, res, next) => {
    try {
        if (!await hasPermission(req, 'can_view_crewfit_vendors')) {
            return res.status(403).json({ error: 'Access denied' });
        }
        next();
    } catch (err) { next(err); }
});

const isAdmin = (req) => req.user?.role === 'owner' || req.user?.role === 'admin';
const parseItems = (raw) => { try { return JSON.parse(raw || '[]'); } catch { return []; } };
const hydrate = (row) => ({ ...row, items: parseItems(row.items), ref: vendorOrder.refLabel(row) });

const ROW_COLUMNS = `id, ref_no, TO_CHAR(order_date, 'YYYY-MM-DD') AS order_date,
    TO_CHAR(delivery_date, 'YYYY-MM-DD') AS delivery_date, vendor, vendor_phone,
    status, payment_status, items, notes, total_qty, total_amount, confirmed_at, sent_at,
    created_by, created_at`;

/** Keep only rows the vendor could act on, and normalise numbers coming from text inputs. */
function cleanItems(items) {
    return (Array.isArray(items) ? items : [])
        .map(item => ({
            product_type: String(item.product_type || '').trim(),
            gsm: String(item.gsm || '').trim(),
            rate: Number(item.rate) > 0 ? Number(item.rate) : null,
            colors: (item.colors || [])
                .map(c => {
                    const sizes = {};
                    for (const [size, qty] of Object.entries(c.sizes || {})) {
                        const n = parseInt(qty, 10);
                        if (n > 0) sizes[String(size).trim()] = n;
                    }
                    return { color: String(c.color || '').trim(), sizes };
                })
                .filter(c => Object.keys(c.sizes).length),
        }))
        .filter(item => item.product_type && item.colors.length);
}

function validate(body) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.order_date || '')) return 'A valid order date is required';
    // Delivery date is optional, but a malformed one should fail loudly rather than be dropped.
    if (body.delivery_date && !/^\d{4}-\d{2}-\d{2}$/.test(body.delivery_date)) return 'Delivery date must be a valid date';
    if (body.delivery_date && body.delivery_date < body.order_date) return 'Delivery date cannot be before the order date';
    if (!String(body.vendor || '').trim()) return 'Vendor is required';
    const items = cleanItems(body.items);
    if (!items.length) return 'Add at least one product with a colour and quantity';
    return null;
}

/** Remember a vendor (and its number) so the dropdown grows as new names are typed in. */
async function rememberVendor(name, phone) {
    const vendor = String(name || '').trim();
    if (!vendor) return;
    await db.query(
        `INSERT INTO crewfit_vendors (name, phone) VALUES ($1, $2)
         ON CONFLICT (LOWER(name)) DO UPDATE SET
             phone = COALESCE(NULLIF(EXCLUDED.phone, ''), crewfit_vendors.phone),
             updated_at = CURRENT_TIMESTAMP`,
        [vendor, phone || null]
    );
}

// GET /api/crewfit/vendor-orders/meta — pick-lists for the form
router.get('/meta', async (req, res) => {
    try {
        const saved = (await db.query('SELECT name, phone FROM crewfit_vendors ORDER BY name')).rows;
        const used = (await db.query(
            `SELECT DISTINCT vendor FROM crewfit_orders WHERE vendor IS NOT NULL AND vendor <> ''`
        )).rows.map(r => r.vendor);

        const byName = new Map();
        for (const v of [...SEED_VENDORS, ...used].filter(Boolean)) {
            byName.set(v.toLowerCase(), { name: v, phone: null });
        }
        // A saved vendor wins: it carries the phone number.
        for (const v of saved) byName.set(v.name.toLowerCase(), { name: v.name, phone: v.phone });

        const products = (await db.query(
            'SELECT name, gsm FROM crewfit_products WHERE active = true ORDER BY sort_order'
        )).rows;

        res.json({
            vendors: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
            products,
            gsm: GSM_OPTIONS,
            sizes: vendorOrder.SIZES,
            statuses: STATUSES,
            paymentStatuses: PAYMENT_STATUSES,
        });
    } catch (err) {
        console.error('Error loading vendor-order meta:', err);
        res.status(500).json({ error: 'Failed to load options' });
    }
});

// GET /api/crewfit/vendor-orders
router.get('/', async (req, res) => {
    try {
        const { vendor, status, search } = req.query;
        const t = tableParams(req.query, { sortable: VENDOR_ORDER_SORTS, defaultSort: 'order_date' });
        const where = [], vals = [];
        if (vendor) { vals.push(vendor); where.push(`vendor = $${vals.length}`); }
        if (status) { vals.push(status); where.push(`status = $${vals.length}`); }
        if (search) {
            vals.push(`%${search}%`);
            where.push(`(vendor ILIKE $${vals.length} OR items ILIKE $${vals.length} OR notes ILIKE $${vals.length})`);
        }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const countRes = await db.query(`SELECT COUNT(*)::int AS n FROM crewfit_vendor_orders ${whereSql}`, vals);

        const r = await db.query(
            `SELECT ${ROW_COLUMNS} FROM crewfit_vendor_orders
             ${whereSql} ${t.orderBy} LIMIT ${t.limit} OFFSET ${t.offset}`, vals
        );
        res.json({ orders: r.rows.map(hydrate), pagination: pagination(countRes.rows[0]?.n || 0, t) });
    } catch (err) {
        console.error('Error loading vendor orders:', err);
        res.status(500).json({ error: 'Failed to load vendor orders' });
    }
});

// POST /api/crewfit/vendor-orders
router.post('/', async (req, res) => {
    const bad = validate(req.body || {});
    if (bad) return res.status(400).json({ error: bad });

    try {
        const items = cleanItems(req.body.items);
        const { qty, amount, hasPricing } = vendorOrder.totals(items);
        // New orders start Pending and Not Paid; both are moved on by hand as the order progresses.
        const status = STATUSES.includes(req.body.status) ? req.body.status : 'Pending';
        const paymentStatus = PAYMENT_STATUSES.includes(req.body.payment_status) ? req.body.payment_status : 'Not Paid';
        const r = await db.query(
            `INSERT INTO crewfit_vendor_orders
                 (ref_no, order_date, delivery_date, vendor, vendor_phone, status, payment_status,
                  items, notes, total_qty, total_amount, created_by)
             VALUES ((SELECT COALESCE(MAX(ref_no), 0) + 1 FROM crewfit_vendor_orders),
                     $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING ${ROW_COLUMNS}`,
            [req.body.order_date, req.body.delivery_date || null, String(req.body.vendor).trim(),
             req.body.vendor_phone || null, status, paymentStatus,
             JSON.stringify(items), req.body.notes || null, qty, hasPricing ? amount : null,
             req.user?.username || null]
        );
        await rememberVendor(req.body.vendor, req.body.vendor_phone);
        res.json({ success: true, order: hydrate(r.rows[0]) });
    } catch (err) {
        console.error('Error creating vendor order:', err);
        res.status(500).json({ error: 'Failed to create vendor order' });
    }
});

// PUT /api/crewfit/vendor-orders/:id
router.put('/:id', async (req, res) => {
    const bad = validate(req.body || {});
    if (bad) return res.status(400).json({ error: bad });

    try {
        const existing = (await db.query('SELECT status, payment_status FROM crewfit_vendor_orders WHERE id = $1', [req.params.id])).rows[0];
        if (!existing) return res.status(404).json({ error: 'Vendor order not found' });

        const items = cleanItems(req.body.items);
        const { qty, amount, hasPricing } = vendorOrder.totals(items);
        const status = STATUSES.includes(req.body.status) ? req.body.status : existing.status;
        const paymentStatus = PAYMENT_STATUSES.includes(req.body.payment_status) ? req.body.payment_status : existing.payment_status;
        const r = await db.query(
            `UPDATE crewfit_vendor_orders SET order_date=$1, delivery_date=$2, vendor=$3, vendor_phone=$4,
                 status=$5, payment_status=$6, items=$7, notes=$8, total_qty=$9, total_amount=$10,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id=$11 RETURNING ${ROW_COLUMNS}`,
            [req.body.order_date, req.body.delivery_date || null, String(req.body.vendor).trim(),
             req.body.vendor_phone || null, status, paymentStatus,
             JSON.stringify(items), req.body.notes || null, qty, hasPricing ? amount : null, req.params.id]
        );
        await rememberVendor(req.body.vendor, req.body.vendor_phone);
        res.json({ success: true, order: hydrate(r.rows[0]) });
    } catch (err) {
        console.error('Error updating vendor order:', err);
        res.status(500).json({ error: 'Failed to update vendor order' });
    }
});

// POST /api/crewfit/vendor-orders/:id/status — move either status on from the list
router.post('/:id/status', async (req, res) => {
    const { status, payment_status: paymentStatus } = req.body || {};
    if (status !== undefined && !STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status' });
    if (paymentStatus !== undefined && !PAYMENT_STATUSES.includes(paymentStatus)) {
        return res.status(400).json({ error: 'Unknown payment status' });
    }
    if (status === undefined && paymentStatus === undefined) return res.status(400).json({ error: 'Nothing to update' });

    try {
        const sets = [], vals = [];
        if (status !== undefined) { vals.push(status); sets.push(`status = $${vals.length}`); }
        if (paymentStatus !== undefined) { vals.push(paymentStatus); sets.push(`payment_status = $${vals.length}`); }
        vals.push(req.params.id);
        const r = await db.query(
            `UPDATE crewfit_vendor_orders SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP
             WHERE id = $${vals.length} RETURNING ${ROW_COLUMNS}`, vals
        );
        if (!r.rows.length) return res.status(404).json({ error: 'Vendor order not found' });
        res.json({ success: true, order: hydrate(r.rows[0]) });
    } catch (err) {
        console.error('Error updating vendor order status:', err);
        res.status(500).json({ error: 'Failed to update status' });
    }
});

// GET /api/crewfit/vendor-orders/:id/message — the WhatsApp text
router.get('/:id/message', async (req, res) => {
    try {
        const r = await db.query(`SELECT ${ROW_COLUMNS} FROM crewfit_vendor_orders WHERE id = $1`, [req.params.id]);
        if (!r.rows.length) return res.status(404).json({ error: 'Vendor order not found' });
        const order = hydrate(r.rows[0]);
        res.json({ message: vendorOrder.buildVendorMessage(order), phone: order.vendor_phone });
    } catch (err) {
        console.error('Error building vendor message:', err);
        res.status(500).json({ error: 'Failed to build message' });
    }
});

// GET /api/crewfit/vendor-orders/:id/pdf
router.get('/:id/pdf', async (req, res) => {
    try {
        const r = await db.query(`SELECT ${ROW_COLUMNS} FROM crewfit_vendor_orders WHERE id = $1`, [req.params.id]);
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

// DELETE /api/crewfit/vendor-orders/:id
router.delete('/:id', async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Access denied' });
    try {
        const r = await db.query('DELETE FROM crewfit_vendor_orders WHERE id = $1 RETURNING id', [req.params.id]);
        if (!r.rows.length) return res.status(404).json({ error: 'Vendor order not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting vendor order:', err);
        res.status(500).json({ error: 'Failed to delete vendor order' });
    }
});

module.exports = router;
