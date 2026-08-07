/**
 * GST purchase register — supplier master and hand-entered bills.
 *
 * Mounted under /api/invoices/purchase, so the permission gate on the parent router applies here
 * too. Sales lives in invoices.js; the two only share the gst_reports download history, keyed by
 * its `kind` column.
 */

const express = require('express');
const db = require('../db/connection');
const purchase = require('../services/gst-purchase');

const router = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isAdmin = (req) => req.user?.role === 'owner' || req.user?.role === 'admin';

const ROW_COLUMNS = `id, TO_CHAR(purchase_date, 'YYYY-MM-DD') AS purchase_date, particulars,
    company_name, invoice_no, location, gstin, gst_pct, qty, rate, taxable, gst_amount, gross,
    cgst, sgst, igst, supplier_id, source, created_by, created_at`;

/** Validate an incoming bill. Returns an error string or null. */
function validateBill(body) {
    if (!DATE_RE.test(body.purchase_date || '')) return 'A valid bill date is required';
    if (!String(body.company_name || '').trim()) return 'Supplier name is required';
    if (!String(body.invoice_no || '').trim()) return 'Invoice number is required';
    const pct = Number(body.gst_pct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 1) return 'GST percentage must be between 0 and 1 (e.g. 0.18)';
    const hasAmount = [body.taxable, body.gross, body.qty].some(v => Number(v) > 0);
    if (!hasAmount) return 'Enter a taxable value, a gross total, or a quantity and rate';
    return null;
}

// GET /api/invoices/purchase — bills, newest first, optionally filtered
router.get('/', async (req, res) => {
    try {
        const { from, to, search } = req.query;
        const where = [], vals = [];
        if (DATE_RE.test(from || '')) { vals.push(from); where.push(`purchase_date >= $${vals.length}`); }
        if (DATE_RE.test(to || '')) { vals.push(to); where.push(`purchase_date <= $${vals.length}`); }
        if (search) {
            vals.push(`%${search}%`);
            where.push(`(company_name ILIKE $${vals.length} OR invoice_no ILIKE $${vals.length} OR particulars ILIKE $${vals.length})`);
        }
        const sql = `SELECT ${ROW_COLUMNS} FROM gst_purchases
                     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                     ORDER BY purchase_date DESC, id DESC LIMIT 1000`;
        const rows = (await db.query(sql, vals)).rows;
        res.json({ rows, summary: purchase.summarise(rows) });
    } catch (err) {
        console.error('Error loading purchases:', err);
        res.status(500).json({ error: 'Failed to load purchases' });
    }
});

// POST /api/invoices/purchase — record a bill
router.post('/', async (req, res) => {
    const bad = validateBill(req.body || {});
    if (bad) return res.status(400).json({ error: bad });

    try {
        const r = purchase.computeLine(req.body);
        const result = await db.query(
            `INSERT INTO gst_purchases (purchase_date, particulars, company_name, invoice_no, location, gstin,
                 gst_pct, qty, rate, taxable, gst_amount, gross, cgst, sgst, igst, supplier_id, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
             RETURNING ${ROW_COLUMNS}`,
            [r.purchase_date, r.particulars, r.company_name, r.invoice_no, r.location, r.gstin || null,
             r.gst_pct, r.qty, r.rate, r.taxable, r.gst_amount, r.gross, r.cgst, r.sgst, r.igst,
             req.body.supplier_id || null, req.user?.username || null]
        );
        res.json({ success: true, row: result.rows[0] });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ error: 'That invoice number is already recorded for this supplier.' });
        }
        console.error('Error creating purchase:', err);
        res.status(500).json({ error: 'Failed to save purchase' });
    }
});

// PUT /api/invoices/purchase/:id
router.put('/:id', async (req, res) => {
    const bad = validateBill(req.body || {});
    if (bad) return res.status(400).json({ error: bad });

    try {
        const r = purchase.computeLine(req.body);
        const result = await db.query(
            `UPDATE gst_purchases SET purchase_date=$1, particulars=$2, company_name=$3, invoice_no=$4,
                 location=$5, gstin=$6, gst_pct=$7, qty=$8, rate=$9, taxable=$10, gst_amount=$11,
                 gross=$12, cgst=$13, sgst=$14, igst=$15, supplier_id=$16, updated_at=CURRENT_TIMESTAMP
             WHERE id=$17 RETURNING ${ROW_COLUMNS}`,
            [r.purchase_date, r.particulars, r.company_name, r.invoice_no, r.location, r.gstin || null,
             r.gst_pct, r.qty, r.rate, r.taxable, r.gst_amount, r.gross, r.cgst, r.sgst, r.igst,
             req.body.supplier_id || null, req.params.id]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'Purchase not found' });
        res.json({ success: true, row: result.rows[0] });
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ error: 'That invoice number is already recorded for this supplier.' });
        }
        console.error('Error updating purchase:', err);
        res.status(500).json({ error: 'Failed to update purchase' });
    }
});

// DELETE /api/invoices/purchase/:id
router.delete('/:id', async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Access denied' });
    try {
        const r = await db.query('DELETE FROM gst_purchases WHERE id = $1 RETURNING id', [req.params.id]);
        if (!r.rows.length) return res.status(404).json({ error: 'Purchase not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting purchase:', err);
        res.status(500).json({ error: 'Failed to delete purchase' });
    }
});

// GET /api/invoices/purchase/suppliers — the autofill list, busiest first
router.get('/suppliers', async (req, res) => {
    try {
        const r = await db.query(
            `SELECT s.id, s.name, s.gstin, s.location, s.default_particulars, s.default_gst_pct,
                    s.default_rate, s.intra_state, COUNT(p.id) AS bill_count
             FROM gst_suppliers s
             LEFT JOIN gst_purchases p ON p.supplier_id = s.id
             GROUP BY s.id ORDER BY COUNT(p.id) DESC, s.name ASC`
        );
        res.json(r.rows);
    } catch (err) {
        console.error('Error loading suppliers:', err);
        res.status(500).json({ error: 'Failed to load suppliers' });
    }
});

// POST /api/invoices/purchase/suppliers — add or update a supplier
router.post('/suppliers', async (req, res) => {
    const { name, gstin, location, default_particulars, default_gst_pct, default_rate } = req.body || {};
    if (!String(name || '').trim()) return res.status(400).json({ error: 'Supplier name is required' });
    if (gstin && !/^\d{2}[A-Z0-9]{13}$/i.test(String(gstin).trim())) {
        return res.status(400).json({ error: 'GSTIN must be 15 characters, starting with a 2-digit state code' });
    }
    try {
        // intra_state follows the GSTIN's state code; for unregistered suppliers the caller's
        // choice stands, since there is no code to read.
        const intra = gstin ? purchase.isIntraState(gstin) : req.body.intra_state !== false;
        const r = await db.query(
            `INSERT INTO gst_suppliers (name, gstin, location, default_particulars, default_gst_pct, default_rate, intra_state)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (LOWER(name), COALESCE(NULLIF(gstin, ''), '')) DO UPDATE SET
                 location = EXCLUDED.location,
                 default_particulars = EXCLUDED.default_particulars,
                 default_gst_pct = EXCLUDED.default_gst_pct,
                 default_rate = EXCLUDED.default_rate,
                 intra_state = EXCLUDED.intra_state,
                 updated_at = CURRENT_TIMESTAMP
             RETURNING *`,
            [String(name).trim(), gstin ? String(gstin).trim().toUpperCase() : null, location || '',
             default_particulars || null, default_gst_pct ?? null, default_rate ?? null, intra]
        );
        res.json({ success: true, supplier: r.rows[0] });
    } catch (err) {
        console.error('Error saving supplier:', err);
        res.status(500).json({ error: 'Failed to save supplier' });
    }
});

module.exports = router;
module.exports.ROW_COLUMNS = ROW_COLUMNS;
