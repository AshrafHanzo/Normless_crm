/**
 * Vendor invoices, the team's side: the list per vendor, uploading one on a vendor's behalf, and
 * reviewing what vendors uploaded on their link (accept, or reject with a reason they will see).
 *
 * Seeing them needs `can_view_vendors`; uploading and reviewing need `can_edit_vendor_orders`;
 * deleting is admin-only. Accepting moves no money — it is the paper trail; the GST purchase
 * register is still kept by hand.
 */

const express = require('express');
const db = require('../db/connection');
const { hasPermission } = require('../utils/permissions');
const invoices = require('../services/vendor-invoices');
const { refLabel } = require('../services/vendor-order');
const vendorWa = require('../services/vendor-wa');

const router = express.Router();

router.use(async (req, res, next) => {
    try {
        if (!await hasPermission(req, 'can_view_vendors')) return res.status(403).json({ error: 'Access denied' });
        next();
    } catch (err) { next(err); }
});
router.param('id', (req, res, next, id) => (/^\d+$/.test(id) ? next() : res.status(404).json({ error: 'Not found' })));

const canEdit = (req) => hasPermission(req, 'can_edit_vendor_orders');
const isAdmin = (req) => req.user?.role === 'owner' || req.user?.role === 'admin';

// GET /api/vendor-invoices?vendor_id&status
router.get('/', async (req, res) => {
    try {
        const where = [], vals = [];
        if (req.query.vendor_id) { vals.push(parseInt(req.query.vendor_id, 10) || 0); where.push(`i.vendor_id = $${vals.length}`); }
        if (['Under review', 'Accepted', 'Rejected'].includes(req.query.status)) { vals.push(req.query.status); where.push(`i.status = $${vals.length}`); }
        const rows = (await db.query(
            `SELECT i.id, i.vendor_id, v.name AS vendor, i.order_id, o.ref_no, i.invoice_no, TO_CHAR(i.invoice_date, 'YYYY-MM-DD') AS invoice_date,
                    i.amount, i.note, i.source, i.uploaded_by, i.status, i.reason, i.reviewed_by, i.file_name,
                    TO_CHAR(i.created_at, 'YYYY-MM-DD') AS uploaded_on
             FROM vendor_invoices i JOIN vendors v ON v.id = i.vendor_id LEFT JOIN vendor_orders o ON o.id = i.order_id
             ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
             ORDER BY (i.status = 'Under review') DESC, i.created_at DESC LIMIT 500`, vals)).rows
            .map(i => ({ ...i, amount: i.amount != null ? Number(i.amount) : null, order_ref: i.order_id ? refLabel(i) : null }));
        res.json({ invoices: rows });
    } catch (err) {
        console.error('vendor invoices list:', err);
        res.status(500).json({ error: 'Failed to load invoices' });
    }
});

// POST /api/vendor-invoices (multipart: vendor_id, invoice_no, invoice_date, amount, order_id, note, file)
router.post('/', async (req, res, next) => {
    if (!await canEdit(req)) return res.status(403).json({ error: 'Access denied' });
    next();
}, invoices.withFile, async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Attach the invoice file' });
        const vendorId = parseInt(req.body?.vendor_id, 10) || 0;
        if (!(await db.query('SELECT 1 FROM vendors WHERE id = $1', [vendorId])).rows[0]) return res.status(400).json({ error: 'Vendor not found' });
        const { error, row } = await invoices.readInvoice(req.body || {}, vendorId);
        if (error) return res.status(400).json({ error });
        const f = invoices.saveFile(req.file, vendorId);
        // Added by us from the vendor's own paper: nothing to review.
        const r = await db.query(
            `INSERT INTO vendor_invoices (vendor_id, order_id, invoice_no, invoice_date, amount, note, file_path, file_name, file_mime,
                                          source, uploaded_by, status, reviewed_by, reviewed_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'team',$10,'Accepted',$10,CURRENT_TIMESTAMP) RETURNING id`,
            [vendorId, row.order_id, row.invoice_no, row.invoice_date, row.amount, row.note, f.file_path, f.file_name, f.file_mime, req.user?.username || null]);
        res.json({ success: true, id: r.rows[0].id });
    } catch (err) {
        console.error('vendor invoice create:', err);
        res.status(500).json({ error: 'Failed to save the invoice' });
    }
});

// POST /api/vendor-invoices/:id/review { status: 'Accepted' | 'Rejected' | 'Under review', reason }
router.post('/:id/review', async (req, res) => {
    if (!await canEdit(req)) return res.status(403).json({ error: 'Access denied' });
    const { status } = req.body || {};
    if (!['Accepted', 'Rejected', 'Under review'].includes(status)) return res.status(400).json({ error: 'Unknown status' });
    const reason = String(req.body?.reason || '').trim().slice(0, 300) || null;
    if (status === 'Rejected' && !reason) return res.status(400).json({ error: 'Say why — the vendor sees the reason' });
    try {
        const r = await db.query(
            `UPDATE vendor_invoices SET status = $1, reason = $2, reviewed_by = $3, reviewed_at = CURRENT_TIMESTAMP
             WHERE id = $4 RETURNING id, vendor_id, source`, [status, status === 'Rejected' ? reason : null, req.user?.username || null, req.params.id]);
        if (!r.rows.length) return res.status(404).json({ error: 'Invoice not found' });
        // Only what the vendor sent us is worth a message back.
        const inv = r.rows[0];
        const whatsapp = inv.source === 'vendor' && status !== 'Under review'
            ? await vendorWa.enqueue({ event: 'vendor_invoice', vendorId: inv.vendor_id, ref: `invoice:${inv.id}:${status}`, user: req.user?.username, notify: req.body?.notify_vendor !== false && req.body?.notify_vendor !== 'false' })
            : null;
        res.json({ success: true, whatsapp });
    } catch (err) {
        console.error('vendor invoice review:', err);
        res.status(500).json({ error: 'Failed to update the invoice' });
    }
});

// GET /api/vendor-invoices/:id/file
router.get('/:id/file', async (req, res) => {
    try {
        const row = (await db.query('SELECT file_path, file_name, file_mime FROM vendor_invoices WHERE id = $1', [req.params.id])).rows[0];
        if (!row) return res.status(404).json({ error: 'Invoice not found' });
        invoices.sendFile(res, row);
    } catch (err) {
        console.error('vendor invoice file:', err);
        res.status(500).json({ error: 'Failed to read the file' });
    }
});

// DELETE /api/vendor-invoices/:id — admin only
router.delete('/:id', async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only an admin can delete an invoice' });
    try {
        const row = (await db.query('DELETE FROM vendor_invoices WHERE id = $1 RETURNING file_path', [req.params.id])).rows[0];
        if (!row) return res.status(404).json({ error: 'Invoice not found' });
        invoices.removeFile(row.file_path);
        res.json({ success: true });
    } catch (err) {
        console.error('vendor invoice delete:', err);
        res.status(500).json({ error: 'Failed to delete the invoice' });
    }
});

module.exports = router;
