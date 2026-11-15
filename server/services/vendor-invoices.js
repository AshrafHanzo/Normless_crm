/**
 * Vendor invoice files, shared by the vendor's own page (their uploads) and the team's routes.
 * Stored outside /uploads, which is served publicly; read back only through a route that checks
 * whose invoice it is.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db/connection');
const { notify } = require('./notify');

const STORE = path.join(__dirname, '..', 'storage', 'vendors', 'invoices');
const MAX_MB = 10;
const TYPES = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_MB * 1024 * 1024, files: 1, fields: 20 },
    fileFilter: (req, file, cb) => (TYPES[file.mimetype] ? cb(null, true) : cb(new Error('Upload the invoice as a PDF, JPG, PNG or WebP'))),
});

/** Express middleware: one `file`, with a readable error for too big / wrong type. */
const withFile = (req, res, next) => upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `The file is over ${MAX_MB} MB` : err.message });
    next();
});

function saveFile(file, vendorId) {
    fs.mkdirSync(STORE, { recursive: true });
    const name = `${vendorId}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${TYPES[file.mimetype]}`;
    fs.writeFileSync(path.join(STORE, name), file.buffer);
    return { file_path: name, file_name: String(file.originalname || 'invoice').slice(0, 120), file_mime: file.mimetype };
}
const removeFile = (name) => { if (name) { try { fs.unlinkSync(path.join(STORE, path.basename(name))); } catch { /* the row is what matters */ } } };

function sendFile(res, row) {
    const file = path.join(STORE, path.basename(row.file_path || ''));
    if (!row.file_path || !fs.existsSync(file)) return res.status(404).json({ error: 'The file is missing' });
    res.setHeader('Content-Type', row.file_mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${String(row.file_name || 'invoice').replace(/[^\w. -]/g, '')}"`);
    fs.createReadStream(file).pipe(res);
}

/**
 * Check an invoice's details. `order_id`, if given, must be one of this vendor's orders.
 * Returns { error } or { row }.
 */
async function readInvoice(body, vendorId) {
    const invoiceNo = String(body.invoice_no || '').trim().slice(0, 60);
    if (!invoiceNo) return { error: 'Enter the invoice number' };
    if (body.invoice_date && !DATE_RE.test(body.invoice_date)) return { error: 'The invoice date isn’t valid' };
    const amount = body.amount === '' || body.amount == null ? null : Math.round(Number(body.amount) * 100) / 100;
    if (amount != null && !(amount > 0 && amount < 1e9)) return { error: 'Enter the invoice amount' };
    let orderId = parseInt(body.order_id, 10) || null;
    if (orderId) {
        const o = (await db.query('SELECT id FROM vendor_orders WHERE id = $1 AND vendor_id = $2', [orderId, vendorId])).rows[0];
        if (!o) orderId = null;
    }
    return { row: { invoice_no: invoiceNo, invoice_date: body.invoice_date || null, amount, order_id: orderId,
        note: String(body.note || '').trim().slice(0, 300) || null } };
}

/** Tell whoever handles vendor orders that a vendor sent an invoice. */
async function notifyUpload(vendor, invoiceNo) {
    const users = (await db.query(
        `SELECT username FROM admin_users WHERE COALESCE(is_active, true)
           AND (role IN ('owner','admin') OR COALESCE(can_edit_vendor_orders, false))`)).rows.map(r => r.username);
    await notify({
        usernames: users, kind: 'vendor_invoice',
        title: `${vendor.name} uploaded invoice ${invoiceNo}`,
        body: 'Review it on their vendor page.',
        link: `/vendors/${vendor.id}?tab=invoices`, actor: null,
    });
}

module.exports = { withFile, saveFile, removeFile, sendFile, readInvoice, notifyUpload, MAX_MB };
