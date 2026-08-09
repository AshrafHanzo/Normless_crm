/**
 * Normless GST sales invoicing.
 *
 * Generates the GST sales register for a date range from fulfilled Shopify orders, stores the
 * workbook, and keeps a download history. See services/gst-report.js for how the figures are
 * derived (and why they are derived that way).
 */

const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/connection');
const gst = require('../services/gst-report');
const purchase = require('../services/gst-purchase');
const { hasPermission } = require('../utils/permissions');
const { tableParams, pagination } = require('../utils/table');

const router = express.Router();

// Client column key → SQL expression. Only these can be sorted on.
const REPORT_SORTS = {
    period_label: 'period_label', from_date: 'from_date', row_count: 'row_count',
    taxable_value: 'taxable_value', gst_total: 'gst_total', gross_total: 'gross_total',
    generated_by: 'generated_by', created_at: 'created_at',
};

// Deliberately NOT under server/uploads: that directory is served statically and unauthenticated,
// and these workbooks carry customer names and order values. Downloads go through the authorised
// route below instead.
const REPORT_DIR = path.join(__dirname, '..', 'storage', 'gst');

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

router.use(async (req, res, next) => {
    try {
        if (!await hasPermission(req, 'can_view_invoices')) {
            return res.status(403).json({ error: 'Access denied' });
        }
        next();
    } catch (err) {
        next(err);
    }
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Content-Disposition for a filename that may contain non-Latin-1 characters.
 *
 * Period labels use an en-dash ("01 Jul 2026 – 02 Jul 2026"), and Node throws ERR_INVALID_CHAR on
 * any header value outside Latin-1 — so the plain filename= form must be ASCII, with the real
 * name carried in the RFC 5987 filename* parameter that browsers prefer.
 */
function contentDisposition(filename) {
    const ascii = filename.replace(/[^\x20-\x7E]/g, '-').replace(/["\\]/g, '');
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Validate a from/to pair, returning an error string or null. */
function badRange(from, to) {
    if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) return 'from and to must be YYYY-MM-DD dates';
    if (from > to) return 'from must be on or before to';
    // Guards against a typo'd year turning into a multi-thousand-order Shopify crawl.
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;
    if (!Number.isFinite(days)) return 'invalid dates';
    if (days > 366) return 'range cannot exceed 366 days';
    return null;
}

/** Turn a service error into a response, keeping the 60-day scope message intact. */
function sendError(res, err, fallback) {
    if (err.code === 'INCOMPLETE_RANGE') {
        return res.status(422).json({ error: err.message, expected: err.expected, received: err.received });
    }
    console.error(fallback, err);
    return res.status(500).json({ error: err.message || fallback });
}

// GET /api/invoices/preview?from=&to= — totals for a period, without issuing invoice numbers
router.get('/preview', async (req, res) => {
    const { from, to } = req.query;
    const bad = badRange(from, to);
    if (bad) return res.status(400).json({ error: bad });

    try {
        res.json(await gst.previewPeriod(from, to));
    } catch (err) {
        sendError(res, err, 'Failed to preview GST report');
    }
});

// POST /api/invoices/generate { from, to } — build the workbook, assign numbers, store it
let generating = false;
router.post('/generate', async (req, res) => {
    const { from, to } = req.body || {};
    const bad = badRange(from, to);
    if (bad) return res.status(400).json({ error: bad });

    // Invoice numbers are a shared sequence; serialising generation keeps two concurrent runs from
    // interleaving into it. The unique index on (fy, seq) is the real backstop.
    if (generating) return res.status(429).json({ error: 'A report is already being generated. Please wait.' });
    generating = true;

    try {
        const rows = await db.transaction((client) => gst.buildRows(client, from, to));
        if (!rows.length) {
            return res.status(422).json({ error: 'No fulfilled orders found in this period.' });
        }

        const label = gst.periodLabel(from, to);
        const summary = gst.summarise(rows);
        const buffer = await gst.buildWorkbook(rows, label);

        const filename = `GST Sales ${label}.xlsx`;
        const id = await storeReport({
            kind: 'sales', label, from, to, filename, buffer, summary,
            user: req.user?.username,
        });

        res.json({ success: true, id, filename, period_label: label, ...summary });
    } catch (err) {
        sendError(res, err, 'Failed to generate GST report');
    } finally {
        generating = false;
    }
});

// Supplier master + hand-entered bills. Mounted here so the permission gate above covers it.
router.use('/purchase', require('./invoices-purchase'));

/** Persist a generated workbook and its history row. Shared by the sales and purchase exports. */
async function storeReport({ kind, label, from, to, filename, buffer, summary, user }) {
    const storedName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.xlsx`;
    await fsp.mkdir(REPORT_DIR, { recursive: true });
    await fsp.writeFile(path.join(REPORT_DIR, storedName), buffer);

    const result = await db.query(
        `INSERT INTO gst_reports (kind, period_label, from_date, to_date, filename, stored_name,
             row_count, total_qty, taxable_value, gst_total, gross_total,
             invoice_from, invoice_to, generated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [kind, label, from, to, filename, storedName, summary.row_count, summary.total_qty,
         summary.taxable_value, summary.gst_total, summary.gross_total,
         summary.invoice_from || null, summary.invoice_to || null, user || null]
    );
    return result.rows[0].id;
}

// POST /api/invoices/purchase-export { from, to } — render the purchase register for a period
router.post('/purchase-export', async (req, res) => {
    const { from, to } = req.body || {};
    const bad = badRange(from, to);
    if (bad) return res.status(400).json({ error: bad });

    try {
        const rows = (await db.query(
            `SELECT TO_CHAR(purchase_date, 'YYYY-MM-DD') AS purchase_date, particulars, company_name,
                    invoice_no, location, gstin, gst_pct, qty, rate, taxable, gst_amount, gross,
                    cgst, sgst, igst
             FROM gst_purchases WHERE purchase_date BETWEEN $1 AND $2
             ORDER BY purchase_date ASC, id ASC`, [from, to]
        )).rows;

        if (!rows.length) return res.status(422).json({ error: 'No purchases recorded in this period.' });

        const label = purchase.periodLabel(from, to);
        const summary = purchase.summarise(rows);
        const buffer = await purchase.buildWorkbook(rows, {
            title: purchase.registerTitle(from, to),
            sheetName: label,
        });
        const filename = `GST ${label}.xlsx`;

        const id = await storeReport({
            kind: 'purchase', label, from, to, filename, buffer, summary,
            user: req.user?.username,
        });
        res.json({ success: true, id, filename, period_label: label, ...summary });
    } catch (err) {
        sendError(res, err, 'Failed to export purchase register');
    }
});

// GET /api/invoices/reports — download history, newest first
router.get('/reports', async (req, res) => {
    try {
        // from_date/to_date are DATE columns: pg hands them back as a JS Date at *local* midnight,
        // which JSON-serialises to the previous day in IST. Send them as plain text instead so the
        // period shown is the period that was requested.
        const kind = req.query.kind === 'purchase' || req.query.kind === 'sales' ? req.query.kind : null;
        const t = tableParams(req.query, { sortable: REPORT_SORTS, defaultSort: 'created_at' });
        const r = await db.query(
            `SELECT id, kind, period_label,
                    TO_CHAR(from_date, 'YYYY-MM-DD') AS from_date,
                    TO_CHAR(to_date, 'YYYY-MM-DD') AS to_date,
                    filename, row_count, total_qty,
                    taxable_value, gst_total, gross_total, invoice_from, invoice_to,
                    generated_by, created_at
             FROM gst_reports ${kind ? 'WHERE kind = $1' : ''}
             ${t.orderBy} LIMIT ${t.limit} OFFSET ${t.offset}`,
            kind ? [kind] : []
        );
        const countRes = await db.query(
            `SELECT COUNT(*)::int AS n FROM gst_reports ${kind ? 'WHERE kind = $1' : ''}`, kind ? [kind] : []);
        res.json({ reports: r.rows, pagination: pagination(countRes.rows[0]?.n || 0, t) });
    } catch (err) {
        console.error('Error loading GST reports:', err);
        res.status(500).json({ error: 'Failed to load report history' });
    }
});

// GET /api/invoices/reports/:id/download — re-download a previously generated workbook
router.get('/reports/:id/download', async (req, res) => {
    try {
        const r = await db.query('SELECT filename, stored_name FROM gst_reports WHERE id = $1', [req.params.id]);
        const report = r.rows[0];
        if (!report) return res.status(404).json({ error: 'Report not found' });

        // stored_name is generated by us, but resolve-and-check anyway so a tampered row can't
        // walk out of the report directory.
        const filePath = path.join(REPORT_DIR, path.basename(report.stored_name));
        if (!filePath.startsWith(REPORT_DIR + path.sep) || !fs.existsSync(filePath)) {
            return res.status(410).json({ error: 'The stored file for this report is no longer available.' });
        }

        res.setHeader('Content-Type', XLSX_MIME);
        res.setHeader('Content-Disposition', contentDisposition(report.filename));
        fs.createReadStream(filePath).pipe(res);
    } catch (err) {
        console.error('Error downloading GST report:', err);
        res.status(500).json({ error: 'Failed to download report' });
    }
});

// DELETE /api/invoices/reports/:id — drop a history entry and its file.
// Invoice numbers are intentionally left assigned: they may already be filed, and reissuing them
// to different orders later would be worse than a gap.
router.delete('/reports/:id', async (req, res) => {
    if (req.user?.role !== 'owner' && req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }
    try {
        const r = await db.query('DELETE FROM gst_reports WHERE id = $1 RETURNING stored_name', [req.params.id]);
        if (!r.rows.length) return res.status(404).json({ error: 'Report not found' });
        await fsp.unlink(path.join(REPORT_DIR, path.basename(r.rows[0].stored_name))).catch(() => { });
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting GST report:', err);
        res.status(500).json({ error: 'Failed to delete report' });
    }
});

module.exports = router;
