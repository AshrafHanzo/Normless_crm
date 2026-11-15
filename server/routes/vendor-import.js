/**
 * Importing the old vendor tracker sheets: read a workbook (or CSV) and show what it says, then,
 * once someone has checked it and filled in what the sheet never held (quantities ordered),
 * create the vendor (if new), the accepted quotation, the order, its deliveries, its payments and
 * an equal-instalment plan — in one go per sheet.
 *
 * Needs both `can_edit_vendor_orders` and `can_record_vendor_payments`: it writes both halves.
 * Nothing is sent on WhatsApp. A sheet whose quotation is already on an order for that vendor is
 * skipped, so importing the same workbook twice adds nothing.
 */

const express = require('express');
const multer = require('multer');
const db = require('../db/connection');
const { hasPermission } = require('../utils/permissions');
const sheets = require('../services/vendor-sheet-import');
const money = require('../services/vendor-money');
const receipts = require('../services/vendor-receipts');
const { refLabel } = require('../services/vendor-order');

const router = express.Router();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => (/\.(xlsx|csv)$/i.test(file.originalname) ? cb(null, true) : cb(new Error('Upload the tracker as .xlsx (File → Download → Microsoft Excel) or .csv'))),
});

router.use(async (req, res, next) => {
    try {
        if (!await hasPermission(req, 'can_edit_vendor_orders') || !await hasPermission(req, 'can_record_vendor_payments')) {
            return res.status(403).json({ error: 'Importing needs both “add and edit” and “bank details and payments” for vendors' });
        }
        next();
    } catch (err) { next(err); }
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const round2 = money.round2;

// POST /api/vendor-import/preview (multipart `file`) — what each tab says, and what it matches here
router.post('/preview', (req, res, next) => upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'The file is over 10 MB' : err.message });
    next();
}), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Choose the tracker file' });
        const read = await sheets.read(req.file.buffer, req.file.originalname);
        if (!read.length) return res.status(400).json({ error: 'Nothing in that file looks like a vendor tracker' });
        const vendors = (await db.query('SELECT id, name FROM vendors ORDER BY name')).rows;
        for (const s of read) {
            const guess = s.vendor_guess.toLowerCase();
            s.vendor_match = vendors.find(v => v.name.toLowerCase() === guess)
                || vendors.find(v => guess && (v.name.toLowerCase().includes(guess) || guess.includes(v.name.toLowerCase()))) || null;
            s.duplicate = s.vendor_match && s.quote_no
                ? (await db.query(`SELECT id, ref_no FROM vendor_orders WHERE vendor_id = $1 AND LOWER(quote_ref) = LOWER($2) LIMIT 1`,
                    [s.vendor_match.id, s.quote_no])).rows.map(o => refLabel(o))[0] || null
                : null;
        }
        res.json({ sheets: read, vendors });
    } catch (err) {
        console.error('vendor import preview:', err);
        res.status(400).json({ error: `That file couldn’t be read: ${err.message}` });
    }
});

/** Check one sheet as sent back from the form. Returns { error } or { s }. */
function check(s) {
    const name = s.quote_no || s.tab || 'a sheet';
    if (!s.vendor_id && !String(s.new_vendor_name || '').trim()) return { error: `${name}: pick the vendor or give a name for a new one` };
    if (!['normless', 'crewfit'].includes(s.brand)) return { error: `${name}: pick the brand` };
    if (!DATE_RE.test(s.order_date || '')) return { error: `${name}: the order date is missing` };
    const products = (s.products || []).map(p => ({ name: String(p.name || '').trim(), ordered: Math.max(0, parseInt(p.ordered, 10) || 0) })).filter(p => p.name);
    if (!products.length || products.some(p => !p.ordered)) return { error: `${name}: enter the quantity ordered for every product` };
    for (const d of s.deliveries || []) if (!DATE_RE.test(d.date || '')) return { error: `${name}: a delivery date is missing` };
    for (const p of s.payments || []) if (!DATE_RE.test(p.date || '') || !(Number(p.amount) > 0)) return { error: `${name}: a payment date or amount is missing` };
    const total = Number(s.total) > 0 ? round2(s.total) : null;
    return { s: { ...s, products, total } };
}

async function importOne(c, s, user) {
    // 1. The vendor.
    let vendorId = parseInt(s.vendor_id, 10) || null;
    if (!vendorId) {
        const name = String(s.new_vendor_name).trim().slice(0, 120);
        vendorId = (await c.query(
            `INSERT INTO vendors (name, brands, created_by) VALUES ($1, $2, $3)
             ON CONFLICT (LOWER(name)) DO UPDATE SET updated_at = CURRENT_TIMESTAMP RETURNING id`, [name, s.brand, user])).rows[0].id;
    }
    const vendor = (await c.query('SELECT id, name, phone FROM vendors WHERE id = $1', [vendorId])).rows[0];
    if (!vendor) throw new Error('vendor not found');

    // 2. Already imported?
    if (s.quote_no) {
        const dup = (await c.query(`SELECT id, ref_no FROM vendor_orders WHERE vendor_id = $1 AND LOWER(quote_ref) = LOWER($2) LIMIT 1`, [vendorId, s.quote_no])).rows[0];
        if (dup) return { skipped: `already imported as ${refLabel(dup)}`, vendor: vendor.name };
    }

    // 3. The quotation, accepted.
    const quoteId = (await c.query(
        `INSERT INTO vendor_quotations (vendor_id, brand, quote_no, quote_date, title, amount, notes, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'Imported from the tracker sheet', 'Accepted', $7) RETURNING id`,
        [vendorId, s.brand, s.quote_no || null, DATE_RE.test(s.quote_date || '') ? s.quote_date : null,
         s.title || null, s.total, user])).rows[0].id;

    // 4. The order: a plain-quantity line per product.
    const items = s.products.map(p => ({ kind: 'simple', product_type: p.name, qty: p.ordered, rate: null }));
    const order = (await c.query(
        `INSERT INTO vendor_orders (ref_no, brand, order_date, vendor, vendor_id, vendor_phone, title, quote_ref, quotation_id,
                                    items, notes, total_qty, total_override, status, payment_status, created_by)
         VALUES ((SELECT COALESCE(MAX(ref_no), 0) + 1 FROM vendor_orders), $1, $2, $3, $4, $5, $6, $7, $8, $9,
                 'Imported from the tracker sheet', $10, $11, 'Consignment Ordered', 'Not Paid', $12)
         RETURNING id, ref_no`,
        [s.brand, s.order_date, vendor.name, vendorId, vendor.phone, s.title || null, s.quote_no || null, quoteId,
         JSON.stringify(items), items.reduce((n, i) => n + i.qty, 0), s.total, user])).rows[0];
    await c.query('UPDATE vendor_quotations SET order_id = $1 WHERE id = $2', [order.id, quoteId]);

    // 5. Deliveries: one per date.
    for (const d of s.deliveries || []) {
        const lines = Object.entries(d.qty || {}).map(([product, n]) => ({ product, color: null, size: null, received: Math.max(0, parseInt(n, 10) || 0), rejected: 0 }))
            .filter(l => l.received > 0 && s.products.some(p => p.name === l.product));
        if (!lines.length) continue;
        await c.query(
            `INSERT INTO vendor_receipts (order_id, received_on, note, lines, received_qty, rejected_qty, created_by)
             VALUES ($1, $2, 'From the tracker sheet', $3, $4, 0, $5)`,
            [order.id, d.date, JSON.stringify(lines), lines.reduce((n, l) => n + l.received, 0), user]);
    }
    await receipts.refresh(order.id, c);

    // 6. Payments: no mode or UTR was kept, so they show "Add UTR" until someone does.
    let left = s.total || Infinity;
    for (const p of s.payments || []) {
        const amount = round2(p.amount);
        const pay = (await c.query(
            `INSERT INTO vendor_payments (vendor_id, paid_on, amount, note, source, created_by)
             VALUES ($1, $2, $3, 'From the tracker sheet — add the mode and UTR', 'manual', $4) RETURNING id`,
            [vendorId, p.date, amount, user])).rows[0];
        const onOrder = round2(Math.min(amount, Math.max(left, 0)));
        if (onOrder > 0) {
            await c.query('INSERT INTO vendor_payment_allocations (payment_id, order_id, amount) VALUES ($1, $2, $3)', [pay.id, order.id, onOrder]);
            left = round2(left - onOrder);
        }
    }
    await money.recompute([order.id], c);

    // 7. A plan of equal instalments, when the sheet's instalment divides the total. The ones
    //    already paid are dated by their payments; the rest wait for a date.
    let planned = 0;
    const inst = Number(s.instalment) > 0 ? Number(s.instalment) : null;
    if (s.make_plan !== false && inst && s.total) {
        const n = Math.round(s.total / inst);
        if (n >= 1 && n <= 24 && Math.abs(n * inst - s.total) <= 1) {
            const pays = (s.payments || []).map(p => p.date).sort();
            for (let i = 0; i < n; i++) {
                const amount = i === n - 1 ? round2(s.total - inst * (n - 1)) : inst;
                await c.query(
                    `INSERT INTO vendor_order_instalments (order_id, seq, label, amount, percent, due_kind, due_date)
                     VALUES ($1, $2, NULL, $3, $4, 'date', $5)`,
                    [order.id, i + 1, amount, round2(100 / n), pays[i] || null]);
            }
            planned = n;
        }
    }
    return { ref: refLabel(order), order_id: order.id, vendor_id: vendorId, vendor: vendor.name, planned };
}

// POST /api/vendor-import/commit { sheets: [...] }
router.post('/commit', async (req, res) => {
    const input = Array.isArray(req.body?.sheets) ? req.body.sheets.filter(s => s && s.include !== false) : [];
    if (!input.length) return res.status(400).json({ error: 'Nothing to import' });
    const checked = [];
    for (const raw of input) {
        const { error, s } = check(raw);
        if (error) return res.status(400).json({ error });
        checked.push(s);
    }
    const results = [];
    for (const s of checked) {
        try {
            results.push({ quote_no: s.quote_no, ...await db.transaction(c => importOne(c, s, req.user?.username || null)) });
        } catch (err) {
            console.error('vendor import commit:', err);
            results.push({ quote_no: s.quote_no, error: err.message });
        }
    }
    res.json({ results });
});

module.exports = router;
