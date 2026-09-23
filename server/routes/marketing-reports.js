/**
 * Daily marketing reports — the HTML a scheduled Claude run builds each morning from Meta Ads and
 * Shopify, kept here so the marketing team can read it in the CRM instead of hunting for a file.
 *
 * Two doors in. The scheduled run is not a logged-in user, so it posts through `ingest` with a
 * shared key (MARKETING_REPORT_API_KEY), the same way Razorpay posts its webhook. Everything else —
 * listing, opening, downloading, deleting — is behind the normal login and the marketing permission.
 *
 * The HTML lives in the database rather than on disk: a report is a few hundred KB at most, and
 * keeping it in Postgres means it is covered by the same backups as everything else.
 */

const express = require('express');
const crypto = require('crypto');
const db = require('../db/connection');
const { hasPermission } = require('../utils/permissions');

// A report with inline charts and images can get large; keep in step with nginx's
// client_max_body_size (55M) so nginx is never the one to refuse it with an HTML 413.
const MAX_BODY = '20mb';

const trim = (v) => { const t = String(v ?? '').trim(); return t || null; };
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
const pad = (n) => String(n).padStart(2, '0');
// The run fires at 9am IST, and the server clock is UTC, so "today" is taken in India's timezone.
const todayIST = () => {
  const d = new Date(Date.now() + 330 * 60 * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const fileName = (row) => `${(row.title || 'report').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')}-${row.report_date}.html`;

/* ─────────────────────────── ingest (scheduled run) ─────────────────────────── */

const ingest = express.Router();

// Its own body parsers, mounted ahead of the app-wide express.json — that one caps at 100kb, which
// a report with an embedded chart library would blow straight through.
ingest.use(express.json({ limit: MAX_BODY }));
ingest.use(express.text({ type: ['text/html', 'text/plain'], limit: MAX_BODY }));

ingest.post('/', async (req, res) => {
  const expected = process.env.MARKETING_REPORT_API_KEY;
  if (!expected) return res.status(503).json({ error: 'Report upload is not configured on the server' });

  const given = String(req.headers['x-report-key'] || '');
  const a = Buffer.from(given), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Invalid report key' });

  // Either a JSON body { html, title?, report_date?, source? } or the raw HTML with the rest in
  // the query string — whichever is easier for the run to produce.
  const body = typeof req.body === 'string' ? { html: req.body } : (req.body || {});
  const html = typeof body.html === 'string' ? body.html : '';
  if (!html.trim()) return res.status(400).json({ error: 'No HTML in the request' });

  const title = trim(body.title ?? req.query.title) || 'Daily marketing report';
  const reportDate = trim(body.report_date ?? req.query.report_date) || todayIST();
  if (!isDate(reportDate)) return res.status(400).json({ error: 'report_date must be YYYY-MM-DD' });
  const source = trim(body.source ?? req.query.source) || 'Meta Ads + Shopify';

  try {
    // A run that retries after a timeout sends the same bytes twice; keep the one copy.
    const hash = crypto.createHash('sha256').update(html).digest('hex');
    const dupe = await db.query('SELECT id FROM marketing_reports WHERE content_hash = $1', [hash]);
    if (dupe.rows[0]) return res.json({ id: dupe.rows[0].id, duplicate: true });

    const r = await db.query(
      `INSERT INTO marketing_reports (title, report_date, source, html, size_bytes, content_hash)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [title, reportDate, source, html, Buffer.byteLength(html), hash]
    );
    console.log(`📊 Marketing report #${r.rows[0].id} received for ${reportDate}`);
    res.status(201).json({ id: r.rows[0].id });
  } catch (err) {
    console.error('Marketing report ingest error:', err);
    res.status(500).json({ error: 'Failed to save the report' });
  }
});

/* ─────────────────────────── CRM (logged-in users) ─────────────────────────── */

const router = express.Router();

router.use(async (req, res, next) => {
  try {
    if (!await hasPermission(req, 'can_view_marketing')) return res.status(403).json({ error: 'Access denied' });
    next();
  } catch (err) { next(err); }
});

router.param('id', (req, res, next, id) => (/^\d+$/.test(id) ? next() : res.status(404).json({ error: 'Report not found' })));

// The list leaves the HTML itself out — thirty reports of it would be a slow page for a table.
router.get('/', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, title, to_char(report_date, 'YYYY-MM-DD') AS report_date, source, size_bytes, created_at
         FROM marketing_reports ORDER BY report_date DESC, created_at DESC`
    );
    res.json({ reports: r.rows });
  } catch (err) {
    console.error('Marketing reports list error:', err);
    res.status(500).json({ error: 'Failed to load reports' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, title, to_char(report_date, 'YYYY-MM-DD') AS report_date, html FROM marketing_reports WHERE id = $1`,
      [req.params.id]
    );
    const row = r.rows[0];
    if (!row) return res.status(404).json({ error: 'Report not found' });
    res.json({ ...row, filename: fileName(row) });
  } catch (err) {
    console.error('Marketing report fetch error:', err);
    res.status(500).json({ error: 'Failed to load the report' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const r = await db.query('DELETE FROM marketing_reports WHERE id = $1 RETURNING id', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Report not found' });
    console.log(`🗑️  Marketing report #${req.params.id} deleted by ${req.user?.username}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Marketing report delete error:', err);
    res.status(500).json({ error: 'Failed to delete the report' });
  }
});

module.exports = router;
module.exports.ingest = ingest;
