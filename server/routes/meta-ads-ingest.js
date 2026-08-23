/**
 * Meta ads daily report — ingest.
 *
 * The one endpoint in this app that is NOT behind the JWT: a scheduled Claude task posts the
 * previous day's Meta Ads numbers here once a day, and it has no way to hold a user session.
 * It authenticates with a shared key in `X-API-Key` instead, checked against META_ADS_INGEST_KEY.
 *
 * Upserts on (account_id, report_date) so a retry, a manual re-run, or a late correction all
 * land on the same row rather than stacking duplicates for the day. The campaign/ad/action-item
 * children are replaced wholesale on each post — a report is a snapshot of the account at that
 * moment, so a campaign missing from the new payload should disappear, not linger from yesterday.
 *
 * Reading these rows back is a different file (routes/meta-ads.js) and is behind the JWT.
 */

const express = require('express');
const crypto = require('crypto');
const db = require('../db/connection');

const router = express.Router();

const STATUSES = new Set(['green', 'amber', 'red']);

// Payloads arrive machine-generated, but be forgiving about shape: Meta's own API hands back
// money and rates as formatted strings ("₹4,088.60 INR", "1.08%"), so a sender that forwards
// those verbatim shouldn't silently write NULLs.
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const cleaned = String(v).replace(/[^0-9.-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};
const int = (v) => { const n = num(v); return n === null ? null : Math.round(n); };
const str = (v) => { const s = String(v ?? '').trim(); return s || null; };
const status = (v) => { const s = String(v ?? '').trim().toLowerCase(); return STATUSES.has(s) ? s : null; };
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) && !Number.isNaN(Date.parse(v));

// Constant-time compare so a wrong key can't be recovered by timing the response. Both sides are
// hashed first because timingSafeEqual throws on length mismatch — which would itself leak length.
function keyMatches(supplied, expected) {
  const a = crypto.createHash('sha256').update(String(supplied)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

router.use((req, res, next) => {
  const expected = process.env.META_ADS_INGEST_KEY;
  // Fail closed. An unset key must not mean "let everyone in".
  if (!expected) {
    console.error('META_ADS_INGEST_KEY is not configured — rejecting ingest.');
    return res.status(503).json({ error: 'Ingest is not configured on this server' });
  }
  const supplied = req.get('X-API-Key');
  if (!supplied || !keyMatches(supplied, expected)) {
    return res.status(401).json({ error: 'Invalid or missing X-API-Key' });
  }
  next();
});

// POST /api/meta-ads-reports
router.post('/', async (req, res) => {
  const body = req.body || {};

  if (!isDate(body.report_date)) {
    return res.status(400).json({ error: 'report_date is required, formatted YYYY-MM-DD' });
  }
  if (!str(body.account_id)) {
    return res.status(400).json({ error: 'account_id is required' });
  }
  if (body.campaigns && !Array.isArray(body.campaigns)) {
    return res.status(400).json({ error: 'campaigns must be an array' });
  }
  if (body.ads && !Array.isArray(body.ads)) {
    return res.status(400).json({ error: 'ads must be an array' });
  }
  if (body.action_items && !Array.isArray(body.action_items)) {
    return res.status(400).json({ error: 'action_items must be an array' });
  }

  const w = body.window || {};
  const s = body.scorecard || {};
  const pick = (metric, key) => (s[metric] ? s[metric][key] : null);

  try {
    const result = await db.transaction(async (tx) => {
      const r = await tx.query(`
        INSERT INTO meta_ads_reports (
          account_id, report_date, window_today, window_7d_start, window_7d_end,
          roas_today, roas_avg_7d, roas_status,
          spend_today, spend_avg_7d_daily,
          revenue_today, revenue_avg_7d_daily,
          purchases_today, purchases_avg_7d_daily,
          cpa_today, cpa_avg_7d, cpa_status,
          frequency_today, frequency_avg_7d, frequency_status,
          raw_payload, received_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,CURRENT_TIMESTAMP)
        ON CONFLICT (account_id, report_date) DO UPDATE SET
          window_today = EXCLUDED.window_today,
          window_7d_start = EXCLUDED.window_7d_start,
          window_7d_end = EXCLUDED.window_7d_end,
          roas_today = EXCLUDED.roas_today,
          roas_avg_7d = EXCLUDED.roas_avg_7d,
          roas_status = EXCLUDED.roas_status,
          spend_today = EXCLUDED.spend_today,
          spend_avg_7d_daily = EXCLUDED.spend_avg_7d_daily,
          revenue_today = EXCLUDED.revenue_today,
          revenue_avg_7d_daily = EXCLUDED.revenue_avg_7d_daily,
          purchases_today = EXCLUDED.purchases_today,
          purchases_avg_7d_daily = EXCLUDED.purchases_avg_7d_daily,
          cpa_today = EXCLUDED.cpa_today,
          cpa_avg_7d = EXCLUDED.cpa_avg_7d,
          cpa_status = EXCLUDED.cpa_status,
          frequency_today = EXCLUDED.frequency_today,
          frequency_avg_7d = EXCLUDED.frequency_avg_7d,
          frequency_status = EXCLUDED.frequency_status,
          raw_payload = EXCLUDED.raw_payload,
          received_at = CURRENT_TIMESTAMP
        RETURNING id`,
        [
          str(body.account_id), body.report_date,
          isDate(w.today) ? w.today : null,
          isDate(w.seven_day_start) ? w.seven_day_start : null,
          isDate(w.seven_day_end) ? w.seven_day_end : null,
          num(pick('roas', 'today')), num(pick('roas', 'avg_7d')), status(pick('roas', 'status')),
          num(pick('spend', 'today')), num(pick('spend', 'avg_7d_daily')),
          num(pick('revenue', 'today')), num(pick('revenue', 'avg_7d_daily')),
          num(pick('purchases', 'today')), num(pick('purchases', 'avg_7d_daily')),
          num(pick('cpa', 'today')), num(pick('cpa', 'avg_7d')), status(pick('cpa', 'status')),
          num(pick('frequency', 'today')), num(pick('frequency', 'avg_7d')), status(pick('frequency', 'status')),
          JSON.stringify(body),
        ]
      );
      const reportId = r.rows[0].id;

      // Snapshot semantics: clear the day's children, then rewrite them from this payload.
      await tx.query('DELETE FROM meta_ads_campaigns WHERE report_id = $1', [reportId]);
      await tx.query('DELETE FROM meta_ads_ads WHERE report_id = $1', [reportId]);
      await tx.query('DELETE FROM meta_ads_action_items WHERE report_id = $1', [reportId]);

      for (const c of (body.campaigns || [])) {
        await tx.query(`
          INSERT INTO meta_ads_campaigns (
            report_id, campaign_id, name, daily_budget,
            roas_7d, roas_status, cpa_7d, cpa_status, ctr_7d, ctr_status,
            cpm_7d, cpm_status, frequency_7d, frequency_status,
            purchases_7d, spend_7d, net_profit_7d, roas_prev_7d, roas_delta
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
          [
            reportId, str(c.id), str(c.name), num(c.daily_budget),
            num(c.roas_7d), status(c.roas_status), num(c.cpa_7d), status(c.cpa_status),
            num(c.ctr_7d), status(c.ctr_status), num(c.cpm_7d), status(c.cpm_status),
            num(c.frequency_7d), status(c.frequency_status),
            int(c.purchases_7d), num(c.spend_7d), num(c.net_profit_7d),
            num(c.roas_prev_7d), num(c.roas_delta),
          ]
        );
      }

      for (const a of (body.ads || [])) {
        await tx.query(`
          INSERT INTO meta_ads_ads (
            report_id, ad_id, name, campaign_id, campaign_name,
            roas_7d, cpa_7d, ctr_7d, ctr_status, cpm_7d, cpm_status,
            frequency_7d, purchases_7d, spend_7d
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            reportId, str(a.id), str(a.name), str(a.campaign_id), str(a.campaign_name),
            num(a.roas_7d), num(a.cpa_7d), num(a.ctr_7d), status(a.ctr_status),
            num(a.cpm_7d), status(a.cpm_status), num(a.frequency_7d),
            int(a.purchases_7d), num(a.spend_7d),
          ]
        );
      }

      for (const it of (body.action_items || [])) {
        await tx.query(`
          INSERT INTO meta_ads_action_items (
            report_id, entity_type, entity_name, metric, value, threshold, message
          ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [reportId, str(it.entity_type), str(it.entity_name), str(it.metric),
           num(it.value), num(it.threshold), str(it.message)]
        );
      }

      return reportId;
    });

    console.log(`📈 Meta ads report stored: ${body.account_id} / ${body.report_date} ` +
      `(${(body.campaigns || []).length} campaigns, ${(body.ads || []).length} ads, ` +
      `${(body.action_items || []).length} action items)`);

    res.json({ status: 'ok', report_id: result, report_date: body.report_date });
  } catch (err) {
    console.error('Meta ads ingest failed:', err.message);
    res.status(500).json({ error: 'Failed to store report' });
  }
});

module.exports = router;
