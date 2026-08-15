/**
 * Crewfit GST sales register.
 *
 * Same flow as the Normless register (routes/invoices.js): preview a period, generate the
 * workbook, keep a download history. The figures come from issued tax invoices — see
 * services/crewfit-gst.js for why proformas are excluded and why rows split by HSN.
 *
 * Deliberately a separate register from Normless: the two brands number their invoices on
 * separate series under the one GSTIN, which Rule 46(b) allows ("one or multiple series").
 */

const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/connection');
const register = require('../services/crewfit-gst');
const { hasPermission } = require('../utils/permissions');
const { tableParams, pagination } = require('../utils/table');

const router = express.Router();

const REPORT_SORTS = {
    period_label: 'period_label', from_date: 'from_date', row_count: 'row_count',
    taxable_value: 'taxable_value', gst_total: 'gst_total', gross_total: 'gross_total',
    generated_by: 'generated_by', created_at: 'created_at',
};

// Shares the storage directory with the Normless register — outside server/uploads, which is
// served unauthenticated, because these workbooks carry customer names and order values.
const REPORT_DIR = path.join(__dirname, '..', 'storage', 'gst');
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const KIND = 'crewfit_sales';

router.use(async (req, res, next) => {
    try {
        if (!await hasPermission(req, 'can_view_crewfit_invoices')) {
            return res.status(403).json({ error: 'Access denied' });
        }
        next();
    } catch (err) { next(err); }
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function badRange(from, to) {
    if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) return 'from and to must be YYYY-MM-DD dates';
    if (from > to) return 'from must be on or before to';
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;
    if (!Number.isFinite(days)) return 'invalid dates';
    if (days > 366) return 'range cannot exceed 366 days';
    return null;
}

/** Non-Latin-1 filenames (period labels use an en-dash) need the RFC 5987 form. */
function contentDisposition(filename) {
    const ascii = filename.replace(/[^\x20-\x7E]/g, '-').replace(/["\\]/g, '');
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// GET /api/crewfit/invoices/preview?from=&to= — totals plus anything unbilled in the period
router.get('/preview', async (req, res) => {
    const { from, to } = req.query;
    const bad = badRange(from, to);
    if (bad) return res.status(400).json({ error: bad });
    try {
        res.json(await register.previewPeriod(db, from, to));
    } catch (err) {
        console.error('crewfit register preview error:', err);
        res.status(500).json({ error: 'Failed to preview the register' });
    }
});

// POST /api/crewfit/invoices/generate { from, to } — build and store the workbook
router.post('/generate', async (req, res) => {
    const { from, to } = req.body || {};
    const bad = badRange(from, to);
    if (bad) return res.status(400).json({ error: bad });

    try {
        const rows = await register.buildRows(db, from, to);
        if (!rows.length) return res.status(422).json({ error: 'No tax invoices were issued in this period.' });

        // A fully paid order with no tax invoice is an unbilled supply. Refuse rather than file a
        // return that quietly leaves it out — the same stance the Shopify range guard takes.
        const gaps = await register.findGaps(db, from, to);
        if (gaps.length && !req.body.ignoreGaps) {
            return res.status(422).json({
                error: `${gaps.length} fully paid order${gaps.length > 1 ? 's have' : ' has'} no tax invoice in this period. Issue them first, or generate again confirming you want them left out.`,
                gaps,
            });
        }

        const label = register.periodLabel(from, to);
        const summary = register.summarise(rows);
        const buffer = await register.buildWorkbook(rows, label);
        const filename = `Crewfit GST Sales ${label}.xlsx`;

        const storedName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.xlsx`;
        await fsp.mkdir(REPORT_DIR, { recursive: true });
        await fsp.writeFile(path.join(REPORT_DIR, storedName), buffer);

        const ins = await db.query(
            `INSERT INTO gst_reports (kind, period_label, from_date, to_date, filename, stored_name,
                 row_count, total_qty, taxable_value, gst_total, gross_total,
                 invoice_from, invoice_to, generated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
            [KIND, label, from, to, filename, storedName, summary.row_count, summary.total_qty,
                summary.taxable_value, summary.gst_total, summary.gross_total,
                summary.invoice_from, summary.invoice_to, req.user?.username || null]
        );

        res.json({ success: true, id: ins.rows[0].id, filename, period_label: label, ...summary });
    } catch (err) {
        console.error('crewfit register generate error:', err);
        res.status(500).json({ error: err.message || 'Failed to generate the register' });
    }
});

// GET /api/crewfit/invoices/reports — download history, newest first
router.get('/reports', async (req, res) => {
    try {
        const t = tableParams(req.query, { sortable: REPORT_SORTS, defaultSort: 'created_at' });
        const r = await db.query(
            // from_date/to_date are DATE columns: pg returns a JS Date at local midnight, which
            // serialises to the previous day in IST. Send them as text so the period is the
            // period that was asked for.
            `SELECT id, kind, period_label,
                    TO_CHAR(from_date,'YYYY-MM-DD') AS from_date,
                    TO_CHAR(to_date,'YYYY-MM-DD') AS to_date,
                    filename, row_count, total_qty, taxable_value, gst_total, gross_total,
                    invoice_from, invoice_to, generated_by, created_at
               FROM gst_reports WHERE kind = $1 ${t.orderBy} LIMIT ${t.limit} OFFSET ${t.offset}`, [KIND]);
        const n = await db.query('SELECT COUNT(*)::int AS n FROM gst_reports WHERE kind = $1', [KIND]);
        res.json({ reports: r.rows, pagination: pagination(n.rows[0]?.n || 0, t) });
    } catch (err) {
        console.error('crewfit register history error:', err);
        res.status(500).json({ error: 'Failed to load report history' });
    }
});

// GET /api/crewfit/invoices/reports/:id/download
router.get('/reports/:id/download', async (req, res) => {
    try {
        const r = await db.query('SELECT filename, stored_name FROM gst_reports WHERE id = $1 AND kind = $2', [req.params.id, KIND]);
        const report = r.rows[0];
        if (!report) return res.status(404).json({ error: 'Report not found' });

        // stored_name is ours, but resolve-and-check anyway so a tampered row can't walk out of
        // the report directory.
        const filePath = path.join(REPORT_DIR, path.basename(report.stored_name));
        if (!filePath.startsWith(REPORT_DIR + path.sep) || !fs.existsSync(filePath)) {
            return res.status(410).json({ error: 'The stored file for this report is no longer available.' });
        }
        res.setHeader('Content-Type', XLSX_MIME);
        res.setHeader('Content-Disposition', contentDisposition(report.filename));
        fs.createReadStream(filePath).pipe(res);
    } catch (err) {
        console.error('crewfit register download error:', err);
        res.status(500).json({ error: 'Failed to download report' });
    }
});

// DELETE /api/crewfit/invoices/reports/:id — drops the history entry and its file.
// Invoice numbers stay assigned: they may already be filed, and reissuing them to different
// orders later would be worse than a gap.
router.delete('/reports/:id', async (req, res) => {
    if (req.user?.role !== 'owner' && req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }
    try {
        const r = await db.query('DELETE FROM gst_reports WHERE id = $1 AND kind = $2 RETURNING stored_name', [req.params.id, KIND]);
        if (!r.rows.length) return res.status(404).json({ error: 'Report not found' });
        await fsp.unlink(path.join(REPORT_DIR, path.basename(r.rows[0].stored_name))).catch(() => { });
        res.json({ success: true });
    } catch (err) {
        console.error('crewfit register delete error:', err);
        res.status(500).json({ error: 'Failed to delete report' });
    }
});

module.exports = router;
