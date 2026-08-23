/**
 * Meta ads daily report — read side, for the CRM's Ads page.
 *
 * Rows land here via routes/meta-ads-ingest.js (public, API-key). Everything below is behind
 * the JWT and `can_view_meta_ads`, since it exposes spend and revenue.
 */

const express = require('express');
const db = require('../db/connection');
const { hasPermission } = require('../utils/permissions');

const router = express.Router();

router.use(async (req, res, next) => {
  try {
    if (!await hasPermission(req, 'can_view_meta_ads')) {
      return res.status(403).json({ error: 'Access denied' });
    }
    next();
  } catch (err) { next(err); }
});

const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''));

// Same trap the Crewfit routes document: pg hands a DATE back as a JS Date at local midnight,
// and toISOString() then reports the previous day for anyone east of UTC (IST is +05:30). Read
// the local calendar fields instead so a report filed on the 23rd doesn't display as the 22nd.
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const toDateStr = (v) => (!v ? null : v instanceof Date ? ymd(v) : String(v).slice(0, 10));
const DATE_FIELDS = ['report_date', 'window_today', 'window_7d_start', 'window_7d_end'];
const fixDates = (row) => {
  if (!row) return row;
  for (const f of DATE_FIELDS) if (f in row) row[f] = toDateStr(row[f]);
  return row;
};

// GET /api/meta-ads/accounts — which accounts have reported, and how recently.
router.get('/accounts', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT account_id,
             COUNT(*)::int AS report_count,
             MAX(report_date) AS latest_date,
             MAX(received_at) AS last_received
      FROM meta_ads_reports
      GROUP BY account_id
      ORDER BY MAX(report_date) DESC`);
    res.json(r.rows.map((row) => ({ ...row, latest_date: toDateStr(row.latest_date) })));
  } catch (err) {
    console.error('Error fetching meta ads accounts:', err.message);
    res.status(500).json({ error: 'Failed to fetch accounts' });
  }
});

// GET /api/meta-ads?account_id=…&date=YYYY-MM-DD
// Latest report by default, or a specific day.
router.get('/', async (req, res) => {
  try {
    const { account_id, date } = req.query;
    const where = [];
    const params = [];
    if (account_id) { params.push(String(account_id)); where.push(`account_id = $${params.length}`); }
    if (date) {
      if (!isDate(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
      params.push(date); where.push(`report_date = $${params.length}`);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const head = await db.query(
      `SELECT * FROM meta_ads_reports ${clause} ORDER BY report_date DESC, id DESC LIMIT 1`, params);
    const report = head.rows[0];
    if (!report) return res.status(404).json({ error: 'No report found' });

    const [campaigns, ads, actionItems] = await Promise.all([
      db.query('SELECT * FROM meta_ads_campaigns WHERE report_id = $1 ORDER BY spend_7d DESC NULLS LAST', [report.id]),
      db.query('SELECT * FROM meta_ads_ads WHERE report_id = $1 ORDER BY spend_7d DESC NULLS LAST', [report.id]),
      db.query('SELECT * FROM meta_ads_action_items WHERE report_id = $1 ORDER BY id', [report.id]),
    ]);

    // raw_payload is kept for forward-compatibility (a sender may add fields before this schema
    // catches up) but it duplicates everything above, so it stays out of the response.
    delete report.raw_payload;
    fixDates(report);

    res.json({
      report,
      campaigns: campaigns.rows,
      ads: ads.rows,
      action_items: actionItems.rows,
    });
  } catch (err) {
    console.error('Error fetching meta ads report:', err.message);
    res.status(500).json({ error: 'Failed to fetch report' });
  }
});

// GET /api/meta-ads/history?account_id=…&days=30 — scorecard trend for charting.
router.get('/history', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const params = [days];
    let clause = '';
    if (req.query.account_id) { params.push(String(req.query.account_id)); clause = `AND account_id = $${params.length}`; }

    const r = await db.query(`
      SELECT report_date, account_id,
             roas_today, roas_avg_7d, spend_today, spend_avg_7d_daily,
             revenue_today, revenue_avg_7d_daily, purchases_today,
             cpa_today, cpa_avg_7d, frequency_today
      FROM meta_ads_reports
      WHERE report_date >= CURRENT_DATE - ($1::int - 1) ${clause}
      ORDER BY report_date ASC`, params);
    res.json(r.rows.map(fixDates));
  } catch (err) {
    console.error('Error fetching meta ads history:', err.message);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// GET /api/meta-ads/campaign/:id/history?days=30 — one campaign's 7-day ROAS over time.
router.get('/campaign/:id/history', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const r = await db.query(`
      SELECT r.report_date, c.name, c.roas_7d, c.cpa_7d, c.ctr_7d, c.cpm_7d,
             c.spend_7d, c.purchases_7d, c.net_profit_7d
      FROM meta_ads_campaigns c
      JOIN meta_ads_reports r ON r.id = c.report_id
      WHERE c.campaign_id = $1 AND r.report_date >= CURRENT_DATE - ($2::int - 1)
      ORDER BY r.report_date ASC`, [String(req.params.id), days]);
    res.json(r.rows.map(fixDates));
  } catch (err) {
    console.error('Error fetching campaign history:', err.message);
    res.status(500).json({ error: 'Failed to fetch campaign history' });
  }
});

module.exports = router;
