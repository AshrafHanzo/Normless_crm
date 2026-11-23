/**
 * What the Anthropic API costs us.
 *
 * Every Claude call in the CRM writes one row here: which feature made it, the model, and the
 * tokens it used, priced at Anthropic's published per-million-token rates. The AI agent page
 * reads these back as today / this month / by feature / by day, and the agent checks the month's
 * total against its budget before it answers anyone.
 *
 * These are our own figures, worked out from the token counts the API returns with every reply.
 * They match Anthropic's bill closely but not to the paisa (taxes, any credits or discounts);
 * the account balance itself is on platform.claude.com, under Billing.
 */

const db = require('../db/connection');

// US dollars per million tokens. A cache write (5-minute) costs 1.25× input; a cache read 0.1×.
const PRICES = {
    'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
    'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};
const priceOf = (model) => PRICES[String(model || '').replace(/-\d{8}$/, '')] || PRICES['claude-opus-5-5'];

/** What the CRM calls each feature, for the spend page. */
const FEATURES = {
    nl_agent: 'Normless AI agent',
    nl_bot: 'Normless bot',
    nl_try: 'Try it (testing)',
    email_agent: 'Email agent (contact@)',
    cf_assistant: 'Crewfit assistant',
    cf_billing: 'Crewfit billing reader',
};

function costOf(model, usage = {}) {
    const p = priceOf(model);
    const usd = ((usage.input_tokens || 0) * p.input + (usage.output_tokens || 0) * p.output
        + (usage.cache_read_input_tokens || 0) * p.cacheRead + (usage.cache_creation_input_tokens || 0) * p.cacheWrite) / 1e6;
    return Math.round(usd * 1e6) / 1e6;
}

/** Write down one API reply's usage. Never throws: a lost row must not cost a customer a reply. */
async function record(feature, response, { conversationId = null, ref = null } = {}) {
    try {
        const u = response?.usage;
        if (!u) return;
        const model = response.model || null;
        await db.query(
            `INSERT INTO ai_usage (feature, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, conversation_id, ref)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [feature, model, u.input_tokens || 0, u.output_tokens || 0, u.cache_read_input_tokens || 0,
                u.cache_creation_input_tokens || 0, costOf(model, u), conversationId, ref]);
    } catch (err) {
        console.error('ai usage record failed:', err.message);
    }
}

/** Spent so far this calendar month (India time), in US dollars. */
async function monthSpend(feature = null) {
    const r = await db.query(
        `SELECT COALESCE(SUM(cost_usd), 0)::float AS usd FROM ai_usage
          WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'
            AND ($1::text IS NULL OR feature = $1)`, [feature]);
    return r.rows[0].usd;
}

/** Everything the spend page shows, for the last `days` days. */
async function summary(days = 30) {
    days = Math.max(1, Math.min(366, Math.round(Number(days) || 30)));
    const IST = `(created_at AT TIME ZONE 'Asia/Kolkata')`;
    const [totals, byFeature, byDay, byModel, perChat] = await Promise.all([
        db.query(`SELECT
              COALESCE(SUM(cost_usd) FILTER (WHERE ${IST}::date = (now() AT TIME ZONE 'Asia/Kolkata')::date), 0)::float AS today,
              COALESCE(SUM(cost_usd) FILTER (WHERE ${IST} >= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')), 0)::float AS month,
              COALESCE(SUM(cost_usd) FILTER (WHERE ${IST} >= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') - INTERVAL '1 month'
                                               AND ${IST} < date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')), 0)::float AS last_month,
              COALESCE(SUM(cost_usd) FILTER (WHERE created_at > now() - make_interval(days => $1)), 0)::float AS range,
              COUNT(*) FILTER (WHERE created_at > now() - make_interval(days => $1))::int AS calls,
              COALESCE(SUM(input_tokens + cache_read_tokens + cache_write_tokens) FILTER (WHERE created_at > now() - make_interval(days => $1)), 0)::bigint AS tokens_in,
              COALESCE(SUM(output_tokens) FILTER (WHERE created_at > now() - make_interval(days => $1)), 0)::bigint AS tokens_out
            FROM ai_usage`, [days]),
        db.query(`SELECT feature, COUNT(*)::int AS calls, SUM(cost_usd)::float AS usd, COUNT(DISTINCT conversation_id)::int AS chats
                    FROM ai_usage WHERE created_at > now() - make_interval(days => $1) GROUP BY feature ORDER BY usd DESC`, [days]),
        db.query(`SELECT TO_CHAR(${IST}::date, 'YYYY-MM-DD') AS day, SUM(cost_usd)::float AS usd, COUNT(*)::int AS calls
                    FROM ai_usage WHERE created_at > now() - make_interval(days => $1) GROUP BY 1 ORDER BY 1`, [days]),
        db.query(`SELECT COALESCE(model, 'unknown') AS model, SUM(cost_usd)::float AS usd, COUNT(*)::int AS calls
                    FROM ai_usage WHERE created_at > now() - make_interval(days => $1) GROUP BY 1 ORDER BY usd DESC`, [days]),
        // What one answered chat costs: the agent's spend over the chats it worked on.
        db.query(`SELECT COUNT(DISTINCT conversation_id)::int AS chats, COALESCE(SUM(cost_usd), 0)::float AS usd
                    FROM ai_usage WHERE feature = 'nl_agent' AND conversation_id IS NOT NULL
                     AND created_at > now() - make_interval(days => $1)`, [days]),
    ]);
    const t = totals.rows[0];
    const pc = perChat.rows[0];
    return {
        days,
        today: t.today, month: t.month, last_month: t.last_month, range: t.range,
        calls: t.calls, tokens_in: Number(t.tokens_in), tokens_out: Number(t.tokens_out),
        per_chat: pc.chats ? pc.usd / pc.chats : null, agent_chats: pc.chats,
        by_feature: byFeature.rows.map(r => ({ ...r, label: FEATURES[r.feature] || r.feature })),
        by_day: byDay.rows,
        by_model: byModel.rows,
        key_set: !!process.env.ANTHROPIC_API_KEY,
    };
}

module.exports = { record, monthSpend, summary, costOf, PRICES, FEATURES };
