/**
 * Vendor quotations — the quote PDFs / photos vendors send, kept so several for the same job can
 * be compared, and so the accepted one stays attached to the order it became.
 *
 * Seeing them needs `can_view_vendors`; adding, changing and accepting need
 * `can_edit_vendor_orders`; deleting is admin-only. A quote is Received until it is Accepted
 * (linked to an order) or Rejected; past its valid-until date an open one reads as Expired.
 * Amounts include GST.
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

const router = express.Router();

// Not under server/uploads: that directory is served statically.
const STORE = path.join(__dirname, '..', 'storage', 'vendors', 'quotations');
const MAX_MB = 15;
const TYPES = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => (TYPES[file.mimetype] ? cb(null, true) : cb(new Error('Attach the quotation as a PDF, JPG, PNG or WebP'))),
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BRANDS = ['normless', 'crewfit'];
const STATUSES = ['Received', 'Accepted', 'Rejected'];
const todayIST = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const clean = (v) => { const s = String(v ?? '').trim(); return s || null; };

router.use(async (req, res, next) => {
    try {
        if (!await hasPermission(req, 'can_view_vendors')) return res.status(403).json({ error: 'Access denied' });
        next();
    } catch (err) { next(err); }
});
router.param('id', (req, res, next, id) => (/^\d+$/.test(id) ? next() : res.status(404).json({ error: 'Not found' })));

const isAdmin = (req) => req.user?.role === 'owner' || req.user?.role === 'admin';
const canEdit = (req) => hasPermission(req, 'can_edit_vendor_orders');

const SORTS = { quote_date: 'q.quote_date', vendor: 'LOWER(v.name)', amount: 'q.amount', valid_until: 'q.valid_until', status: 'q.status' };

const COLUMNS = `q.id, q.vendor_id, v.name AS vendor, q.brand, q.quote_no, TO_CHAR(q.quote_date, 'YYYY-MM-DD') AS quote_date,
    TO_CHAR(q.valid_until, 'YYYY-MM-DD') AS valid_until, q.title, q.amount, q.notes, q.status, q.order_id,
    o.ref_no AS order_ref_no, (q.file_path IS NOT NULL) AS has_file, q.file_name, q.file_mime, q.created_by, q.created_at`;
const FROM = 'FROM vendor_quotations q JOIN vendors v ON v.id = q.vendor_id LEFT JOIN vendor_orders o ON o.id = q.order_id';

const hydrate = (q) => ({
    ...q,
    amount: q.amount != null ? Number(q.amount) : null,
    order_ref: q.order_id ? refLabel({ ref_no: q.order_ref_no, id: q.order_id }) : null,
    // An open quote past its date — still listed, flagged so nobody accepts a stale price unawares.
    shown_status: q.status === 'Received' && q.valid_until && q.valid_until < todayIST() ? 'Expired' : q.status,
});

function readBody(body) {
    const vendorId = parseInt(body.vendor_id, 10);
    if (!vendorId) return { error: 'Pick the vendor who sent the quotation' };
    if (!BRANDS.includes(body.brand)) return { error: 'Pick which brand the quotation is for' };
    for (const f of ['quote_date', 'valid_until']) {
        if (body[f] && !DATE_RE.test(body[f])) return { error: 'Dates must be valid' };
    }
    if (body.quote_date && body.valid_until && body.valid_until < body.quote_date) return { error: 'Valid until can’t be before the quotation date' };
    const amount = body.amount === '' || body.amount == null ? null : money.round2(body.amount);
    if (amount != null && !(amount > 0)) return { error: 'The amount must be more than zero' };
    if (!clean(body.quote_no) && !clean(body.title)) return { error: 'Give the quotation number or a title' };
    return {
        row: {
            vendor_id: vendorId, brand: body.brand, quote_no: clean(body.quote_no), title: clean(body.title),
            quote_date: body.quote_date || null, valid_until: body.valid_until || null, amount, notes: clean(body.notes),
        },
    };
}

function saveFile(file, id) {
    fs.mkdirSync(STORE, { recursive: true });
    const name = `${id}-${crypto.randomBytes(8).toString('hex')}${TYPES[file.mimetype]}`;
    fs.writeFileSync(path.join(STORE, name), file.buffer);
    return { file_path: name, file_name: String(file.originalname || 'quotation').slice(0, 120), file_mime: file.mimetype };
}
const removeFile = (name) => { if (name) { try { fs.unlinkSync(path.join(STORE, path.basename(name))); } catch { /* the row is what matters */ } } };

const withUpload = (req, res, next) => upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `The file is over ${MAX_MB} MB` : err.message });
    next();
});

// GET /api/vendor-quotations?vendor_id&brand&status&search
router.get('/', async (req, res) => {
    try {
        const t = tableParams(req.query, { sortable: SORTS, defaultSort: 'quote_date', tiebreak: 'q.id' });
        const where = [], vals = [];
        const q = req.query;
        if (q.vendor_id) { vals.push(parseInt(q.vendor_id, 10) || 0); where.push(`q.vendor_id = $${vals.length}`); }
        if (BRANDS.includes(q.brand)) { vals.push(q.brand); where.push(`q.brand = $${vals.length}`); }
        if (q.status === 'Open') where.push(`q.status = 'Received' AND (q.valid_until IS NULL OR q.valid_until >= CURRENT_DATE)`);
        else if (q.status === 'Expired') where.push(`q.status = 'Received' AND q.valid_until < CURRENT_DATE`);
        else if (STATUSES.includes(q.status)) { vals.push(q.status); where.push(`q.status = $${vals.length}`); }
        if (q.search) {
            vals.push(`%${q.search}%`);
            const n = vals.length;
            where.push(`(v.name ILIKE $${n} OR q.quote_no ILIKE $${n} OR q.title ILIKE $${n} OR q.notes ILIKE $${n})`);
        }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const n = (await db.query(`SELECT COUNT(*)::int AS n ${FROM} ${whereSql}`, vals)).rows[0].n;
        const rows = (await db.query(`SELECT ${COLUMNS} ${FROM} ${whereSql} ${t.orderBy} LIMIT ${t.limit} OFFSET ${t.offset}`, vals)).rows;
        res.json({ quotations: rows.map(hydrate), pagination: pagination(n, t) });
    } catch (err) {
        console.error('vendor quotations list:', err);
        res.status(500).json({ error: 'Failed to load quotations' });
    }
});

// GET /api/vendor-quotations/:id
router.get('/:id', async (req, res) => {
    try {
        const r = (await db.query(`SELECT ${COLUMNS} ${FROM} WHERE q.id = $1`, [req.params.id])).rows[0];
        if (!r) return res.status(404).json({ error: 'Quotation not found' });
        res.json({ quotation: hydrate(r) });
    } catch (err) {
        console.error('vendor quotation:', err);
        res.status(500).json({ error: 'Failed to load the quotation' });
    }
});

// POST /api/vendor-quotations (multipart: the fields, and `file`)
router.post('/', async (req, res, next) => {
    if (!await canEdit(req)) return res.status(403).json({ error: 'Access denied' });
    next();
}, withUpload, async (req, res) => {
    try {
        const { error, row } = readBody(req.body || {});
        if (error) return res.status(400).json({ error });
        if (!(await db.query('SELECT 1 FROM vendors WHERE id = $1', [row.vendor_id])).rows[0]) return res.status(400).json({ error: 'Vendor not found' });
        const cols = Object.keys(row);
        const id = (await db.query(
            `INSERT INTO vendor_quotations (${cols.join(', ')}, created_by)
             VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, $${cols.length + 1}) RETURNING id`,
            [...cols.map(k => row[k]), req.user?.username || null])).rows[0].id;
        if (req.file) {
            const f = saveFile(req.file, id);
            await db.query('UPDATE vendor_quotations SET file_path = $1, file_name = $2, file_mime = $3 WHERE id = $4',
                [f.file_path, f.file_name, f.file_mime, id]);
        }
        res.json({ success: true, id });
    } catch (err) {
        console.error('vendor quotation create:', err);
        res.status(500).json({ error: 'Failed to save the quotation' });
    }
});

// PUT /api/vendor-quotations/:id (multipart; a new `file` replaces the old one)
router.put('/:id', async (req, res, next) => {
    if (!await canEdit(req)) return res.status(403).json({ error: 'Access denied' });
    next();
}, withUpload, async (req, res) => {
    try {
        const existing = (await db.query('SELECT id, vendor_id, order_id, file_path FROM vendor_quotations WHERE id = $1', [req.params.id])).rows[0];
        if (!existing) return res.status(404).json({ error: 'Quotation not found' });
        const { error, row } = readBody(req.body || {});
        if (error) return res.status(400).json({ error });
        if (existing.order_id && row.vendor_id !== existing.vendor_id) return res.status(409).json({ error: 'This quotation is on an order — it can’t move to another vendor' });
        const cols = Object.keys(row);
        await db.query(
            `UPDATE vendor_quotations SET ${cols.map((k, i) => `${k} = $${i + 1}`).join(', ')}, updated_at = CURRENT_TIMESTAMP
             WHERE id = $${cols.length + 1}`, [...cols.map(k => row[k]), existing.id]);
        if (req.file) {
            const f = saveFile(req.file, existing.id);
            await db.query('UPDATE vendor_quotations SET file_path = $1, file_name = $2, file_mime = $3 WHERE id = $4',
                [f.file_path, f.file_name, f.file_mime, existing.id]);
            removeFile(existing.file_path);
        }
        res.json({ success: true, id: existing.id });
    } catch (err) {
        console.error('vendor quotation update:', err);
        res.status(500).json({ error: 'Failed to save the quotation' });
    }
});

// POST /api/vendor-quotations/:id/status { status: 'Rejected' | 'Received' } — reject, or reopen
router.post('/:id/status', async (req, res) => {
    if (!await canEdit(req)) return res.status(403).json({ error: 'Access denied' });
    const status = req.body?.status;
    if (!['Rejected', 'Received'].includes(status)) return res.status(400).json({ error: 'A quotation is accepted by putting it on an order' });
    try {
        const q = (await db.query('SELECT order_id FROM vendor_quotations WHERE id = $1', [req.params.id])).rows[0];
        if (!q) return res.status(404).json({ error: 'Quotation not found' });
        if (q.order_id) return res.status(409).json({ error: 'This quotation is on an order — take it off the order first' });
        await db.query('UPDATE vendor_quotations SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [status, req.params.id]);
        res.json({ success: true });
    } catch (err) {
        console.error('vendor quotation status:', err);
        res.status(500).json({ error: 'Failed to update the quotation' });
    }
});

// POST /api/vendor-quotations/:id/link { order_id } — accept it as the quote an existing order was
// placed on (orders raised before quotations were kept). Fills in the order's quotation number,
// and its total if it has none.
router.post('/:id/link', async (req, res) => {
    if (!await canEdit(req)) return res.status(403).json({ error: 'Access denied' });
    try {
        const q = (await db.query('SELECT id, vendor_id, quote_no, amount, order_id FROM vendor_quotations WHERE id = $1', [req.params.id])).rows[0];
        if (!q) return res.status(404).json({ error: 'Quotation not found' });
        const orderId = parseInt(req.body?.order_id, 10) || 0;
        const o = (await db.query('SELECT id, vendor_id, quotation_id, total_amount, total_override FROM vendor_orders WHERE id = $1', [orderId])).rows[0];
        if (!o) return res.status(404).json({ error: 'Order not found' });
        if (o.vendor_id !== q.vendor_id) return res.status(400).json({ error: 'That order is with another vendor' });
        if (o.quotation_id && o.quotation_id !== q.id) return res.status(409).json({ error: 'That order already has a quotation attached' });
        await db.transaction(async (c) => {
            if (q.order_id && q.order_id !== o.id) await c.query('UPDATE vendor_orders SET quotation_id = NULL WHERE id = $1', [q.order_id]);
            const noTotal = !(Number(o.total_override) > 0) && !(Number(o.total_amount) > 0);
            await c.query(
                `UPDATE vendor_orders SET quotation_id = $1, quote_ref = COALESCE(NULLIF(quote_ref, ''), $2),
                     total_override = CASE WHEN $3::boolean THEN $4 ELSE total_override END, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $5`, [q.id, q.quote_no, noTotal && q.amount != null, q.amount, o.id]);
            await c.query(`UPDATE vendor_quotations SET status = 'Accepted', order_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [o.id, q.id]);
            if (noTotal && q.amount != null) await money.recompute([o.id], c);
        });
        res.json({ success: true });
    } catch (err) {
        console.error('vendor quotation link:', err);
        res.status(500).json({ error: 'Failed to put the quotation on the order' });
    }
});

// POST /api/vendor-quotations/:id/unlink — take it off its order; it goes back to Received
router.post('/:id/unlink', async (req, res) => {
    if (!await canEdit(req)) return res.status(403).json({ error: 'Access denied' });
    try {
        const q = (await db.query('SELECT id, order_id FROM vendor_quotations WHERE id = $1', [req.params.id])).rows[0];
        if (!q) return res.status(404).json({ error: 'Quotation not found' });
        await db.transaction(async (c) => {
            if (q.order_id) await c.query('UPDATE vendor_orders SET quotation_id = NULL WHERE id = $1 AND quotation_id = $2', [q.order_id, q.id]);
            await c.query(`UPDATE vendor_quotations SET status = 'Received', order_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [q.id]);
        });
        res.json({ success: true });
    } catch (err) {
        console.error('vendor quotation unlink:', err);
        res.status(500).json({ error: 'Failed to take the quotation off the order' });
    }
});

// DELETE /api/vendor-quotations/:id — admin only, and not while it is on an order
router.delete('/:id', async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only an admin can delete a quotation' });
    try {
        const q = (await db.query('SELECT id, order_id, file_path FROM vendor_quotations WHERE id = $1', [req.params.id])).rows[0];
        if (!q) return res.status(404).json({ error: 'Quotation not found' });
        if (q.order_id) return res.status(409).json({ error: 'This quotation is on an order — take it off the order first' });
        await db.query('DELETE FROM vendor_quotations WHERE id = $1', [q.id]);
        removeFile(q.file_path);
        res.json({ success: true });
    } catch (err) {
        console.error('vendor quotation delete:', err);
        res.status(500).json({ error: 'Failed to delete the quotation' });
    }
});

// GET /api/vendor-quotations/:id/file
router.get('/:id/file', async (req, res) => {
    try {
        const q = (await db.query('SELECT file_path, file_name, file_mime FROM vendor_quotations WHERE id = $1', [req.params.id])).rows[0];
        if (!q?.file_path) return res.status(404).json({ error: 'No file attached' });
        const file = path.join(STORE, path.basename(q.file_path));
        if (!fs.existsSync(file)) return res.status(404).json({ error: 'The file is missing' });
        res.setHeader('Content-Type', q.file_mime || 'application/octet-stream');
        res.setHeader('Content-Disposition', `inline; filename="${String(q.file_name || 'quotation').replace(/[^\w. -]/g, '')}"`);
        fs.createReadStream(file).pipe(res);
    } catch (err) {
        console.error('vendor quotation file:', err);
        res.status(500).json({ error: 'Failed to read the file' });
    }
});

module.exports = router;
