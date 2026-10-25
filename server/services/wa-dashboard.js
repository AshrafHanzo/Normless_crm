/**
 * The numbers behind WhatsApp › Dashboard, for either line, and a salesperson's own page.
 *
 * Everything is counted from what the inbox already records — messages, who sent them, hand-overs,
 * the automations' send log, carts, calls, tickets and (for Crewfit) the orders — over a date range
 * in India time (the database's own zone), with the same-length period before it for comparison.
 *
 * Who closed a Crewfit order is the salesperson written on it (`so`, a first name like "Anu"),
 * matched to a CRM login by that name; an order whose name matches nobody is still counted under
 * the name, and an order with none is counted as unattributed.
 */

const db = require('../db/connection');

const DAY = 86400000;
const median = (xs) => {
    const a = xs.filter(x => Number.isFinite(x)).sort((p, q) => p - q);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
};
const n = (v) => Number(v) || 0;
const iso = (d) => d.toISOString().slice(0, 10);

/** The range asked for (YYYY-MM-DD, both days included) and the one before it, as timestamps. */
function range(q, defaultDays = 7) {
    const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
    let to = ok(q.to) ? new Date(`${q.to}T00:00:00Z`) : new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
    let from = ok(q.from) ? new Date(`${q.from}T00:00:00Z`) : new Date(to.getTime() - (defaultDays - 1) * DAY);
    if (from > to) [from, to] = [to, from];
    if (to - from > 366 * DAY) from = new Date(to.getTime() - 366 * DAY);
    const days = Math.round((to - from) / DAY) + 1;
    const prevTo = new Date(from.getTime() - DAY);
    const prevFrom = new Date(prevTo.getTime() - (days - 1) * DAY);
    // Timestamps are stored in India time without a zone, so plain dates bound them directly.
    const span = (a, b) => ({ from: iso(a), to: iso(b), start: `${iso(a)} 00:00:00`, end: `${iso(new Date(b.getTime() + DAY))} 00:00:00` });
    return { ...span(from, to), days, prev: span(prevFrom, prevTo) };
}

/** The name a person goes by, as the Normless handover introduces them ("priya.s@…" → "Priya"). */
function shortName(user) {
    if (user?.wa_display_name) return String(user.wa_display_name).trim();
    const local = String(user?.username || '').split('@')[0];
    const first = local.split(/[._\-+\s]/)[0].replace(/\d+/g, '') || local;
    return first ? first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() : '';
}

async function users() {
    return (await db.query(
        `SELECT username, wa_display_name, role, can_view_whatsapp, can_view_wa_normless, COALESCE(is_active, true) AS active
           FROM admin_users`)).rows;
}

/** The login a salesperson's name on an order belongs to, or null. */
function userForSo(so, list) {
    const key = String(so || '').trim().toLowerCase();
    if (!key) return null;
    const hit = list.find(u => shortName(u).toLowerCase() === key)
        || list.find(u => String(u.username).split('@')[0].toLowerCase() === key)
        || list.find(u => String(u.username).toLowerCase().startsWith(key));
    return hit?.username || null;
}

/* ── Shared measures ──────────────────────────────────────────────────────────────────────── */

const LAST_DIRECTION = `(SELECT m.direction FROM wa_messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1)`;

/**
 * How long customers waited for a person: for every reply a person sent, from the customer's first
 * unanswered message (or, after the bot handed over, from the bot's last word) to that reply.
 */
async function replyWaits(lineId, r) {
    const rows = (await db.query(
        `SELECT LOWER(rp.sender_user) AS who, EXTRACT(EPOCH FROM rp.created_at - s.start)::int AS secs
           FROM wa_messages rp
           JOIN wa_conversations c ON c.id = rp.conversation_id
           LEFT JOIN LATERAL (SELECT p.created_at, p.sender_type FROM wa_messages p
                               WHERE p.conversation_id = rp.conversation_id AND p.direction = 'out' AND p.created_at < rp.created_at
                               ORDER BY p.created_at DESC, p.id DESC LIMIT 1) prev ON true
           LEFT JOIN LATERAL (SELECT MIN(i.created_at) AS at FROM wa_messages i
                               WHERE i.conversation_id = rp.conversation_id AND i.direction = 'in' AND i.created_at < rp.created_at
                                 AND (prev.created_at IS NULL OR i.created_at > prev.created_at)) fi ON true
           CROSS JOIN LATERAL (SELECT COALESCE(fi.at, CASE WHEN prev.sender_type IN ('bot', 'ai') THEN prev.created_at END) AS start) s
          WHERE c.line_id = $1 AND rp.direction = 'out' AND rp.sender_type = 'user'
            AND rp.created_at >= $2 AND rp.created_at < $3 AND s.start IS NOT NULL`,
        [lineId, r.start, r.end])).rows;
    const byUser = new Map();
    for (const x of rows) {
        if (!byUser.has(x.who)) byUser.set(x.who, []);
        byUser.get(x.who).push(n(x.secs));
    }
    return { all: median(rows.map(x => n(x.secs))), byUser: new Map([...byUser].map(([k, v]) => [k, median(v)])) };
}

async function calls(lineId, r) {
    const row = (await db.query(
        `SELECT COUNT(*) FILTER (WHERE direction = 'in')::int AS came_in,
                COUNT(*) FILTER (WHERE direction = 'in' AND answered_at IS NOT NULL)::int AS answered,
                COUNT(*) FILTER (WHERE direction = 'in' AND status = 'missed')::int AS missed,
                COUNT(*) FILTER (WHERE direction = 'out')::int AS went_out,
                COUNT(*) FILTER (WHERE direction = 'out' AND answered_at IS NOT NULL)::int AS connected,
                COALESCE(SUM(duration_sec), 0)::int AS talk,
                ROUND(AVG(duration_sec) FILTER (WHERE duration_sec > 0))::int AS avg,
                COUNT(*) FILTER (WHERE direction = 'in' AND answered_at IS NOT NULL AND answered_at - created_at <= INTERVAL '30 seconds')::int AS quick
           FROM wa_calls WHERE line_id = $1 AND created_at >= $2::timestamp AND created_at < $3::timestamp`,
        [lineId, r.start, r.end])).rows[0];
    return { ...row, quick_share: row.answered ? Math.round(row.quick / row.answered * 100) : null };
}

async function callsByUser(lineId, r) {
    const rows = (await db.query(
        `SELECT LOWER(COALESCE(answered_by, started_by)) AS who, COUNT(*)::int AS n FROM wa_calls
          WHERE line_id = $1 AND created_at >= $2::timestamp AND created_at < $3::timestamp
            AND COALESCE(answered_by, started_by) IS NOT NULL GROUP BY 1`, [lineId, r.start, r.end])).rows;
    return new Map(rows.map(x => [x.who, x.n]));
}

/** Messages and calls by hour of the day, 8 am to 10 pm. */
async function hours(lineId, r) {
    const rows = (await db.query(
        `SELECT h, SUM(k)::int AS k FROM (
            SELECT EXTRACT(HOUR FROM m.created_at)::int AS h, COUNT(*) AS k FROM wa_messages m
              JOIN wa_conversations c ON c.id = m.conversation_id
             WHERE c.line_id = $1 AND m.direction = 'in' AND m.created_at >= $2 AND m.created_at < $3 GROUP BY 1
            UNION ALL
            SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Kolkata')::int, COUNT(*) FROM wa_calls
             WHERE line_id = $1 AND direction = 'in' AND created_at >= $2::timestamp AND created_at < $3::timestamp GROUP BY 1
         ) t GROUP BY h`, [lineId, r.start, r.end])).rows;
    const by = new Map(rows.map(x => [x.h, x.k]));
    return Array.from({ length: 15 }, (_, i) => ({ hour: 8 + i, count: by.get(8 + i) || 0 }));
}

/* ── Normless ─────────────────────────────────────────────────────────────────────────────── */

const TOPICS = [
    ['track', 'Track my order'], ['size', 'Size help'], ['products', 'Browse products'],
    ['exchange', 'Size exchange'], ['refund', 'Return or refund'], ['r:damaged', 'Damaged or wrong item'],
];

/** Chats active in a range, and which of them a person had to step into. */
async function nlChats(lineId, r) {
    const row = (await db.query(
        `WITH active AS (
            SELECT DISTINCT m.conversation_id AS id FROM wa_messages m JOIN wa_conversations c ON c.id = m.conversation_id
             WHERE c.line_id = $1 AND m.direction = 'in' AND m.created_at >= $2 AND m.created_at < $3),
          team AS (
            SELECT a.id FROM active a WHERE
              EXISTS (SELECT 1 FROM wa_activity x WHERE x.conversation_id = a.id AND x.kind IN ('handoff', 'assign') AND x.created_at >= $2 AND x.created_at < $3)
              OR EXISTS (SELECT 1 FROM wa_messages m WHERE m.conversation_id = a.id AND m.sender_type = 'user' AND m.created_at >= $2 AND m.created_at < $3))
         SELECT (SELECT COUNT(*) FROM active)::int AS active, (SELECT COUNT(*) FROM team)::int AS team`,
        [lineId, r.start, r.end])).rows[0];
    return { ...row, solved: row.active - row.team, solved_share: row.active ? Math.round((row.active - row.team) / row.active * 100) : null };
}

async function normless(lineId, q) {
    const r = range(q, 7);
    const [now, before, waits, prevWaits] = await Promise.all([nlChats(lineId, r), nlChats(lineId, r.prev), replyWaits(lineId, r), replyWaits(lineId, r.prev)]);

    const waiting = (await db.query(
        `SELECT COUNT(*)::int AS n, MIN(c.last_inbound_at) AS oldest,
                COUNT(*) FILTER (WHERE c.assigned_to IS NULL)::int AS nobody
           FROM wa_conversations c WHERE c.line_id = $1 AND c.status = 'open' AND c.mode = 'human' AND ${LAST_DIRECTION} = 'in'`,
        [lineId])).rows[0];
    const tickets = async (rr) => n((await db.query(
        `SELECT COUNT(*)::int AS n FROM support_tickets t JOIN wa_conversations c ON c.id = t.wa_conversation_id
          WHERE c.line_id = $1 AND t.created_at >= $2 AND t.created_at < $3`, [lineId, rr.start, rr.end])).rows[0].n);

    // Per day: chats with a customer message that day, and how many of them went to a person.
    const daily = (await db.query(
        `WITH d AS (
            SELECT DISTINCT m.conversation_id AS id, m.created_at::date AS day FROM wa_messages m JOIN wa_conversations c ON c.id = m.conversation_id
             WHERE c.line_id = $1 AND m.direction = 'in' AND m.created_at >= $2 AND m.created_at < $3)
         SELECT d.day::text AS day, COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM wa_activity x WHERE x.conversation_id = d.id AND x.kind IN ('handoff', 'assign') AND x.created_at::date = d.day)
                                    OR EXISTS (SELECT 1 FROM wa_messages m WHERE m.conversation_id = d.id AND m.sender_type = 'user' AND m.created_at::date = d.day))::int AS team
           FROM d GROUP BY d.day ORDER BY d.day`, [lineId, r.start, r.end])).rows;

    // What they asked about: the menu options they tapped.
    const topicRows = (await db.query(
        `WITH taps AS (
            SELECT DISTINCT m.conversation_id AS id, (m.interactive_payload::json ->> 'id') AS topic
              FROM wa_messages m JOIN wa_conversations c ON c.id = m.conversation_id
             WHERE c.line_id = $1 AND m.direction = 'in' AND m.interactive_payload IS NOT NULL
               AND m.created_at >= $2 AND m.created_at < $3)
         SELECT t.topic, COUNT(*)::int AS n,
                COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM wa_activity x WHERE x.conversation_id = t.id AND x.kind IN ('handoff', 'assign') AND x.created_at >= $2 AND x.created_at < $3))::int AS bot
           FROM taps t WHERE t.topic = ANY($4) GROUP BY t.topic`,
        [lineId, r.start, r.end, TOPICS.map(t => t[0])])).rows;
    const topics = TOPICS.map(([key, label]) => {
        const x = topicRows.find(t => t.topic === key);
        return { key, label, count: x?.n || 0, bot_share: x?.n ? Math.round(x.bot / x.n * 100) : null };
    });

    // Abandoned carts.
    const carts = (await db.query(
        `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE recovered_at IS NOT NULL)::int AS recovered,
                COALESCE(SUM(total) FILTER (WHERE recovered_at IS NOT NULL), 0)::numeric AS recovered_value,
                COUNT(*) FILTER (WHERE recovered_at IS NOT NULL AND EXISTS (SELECT 1 FROM nl_auto_sends s WHERE s.line_id = k.line_id AND s.ref = k.token AND s.event LIKE 'cart_%' AND s.status = 'sent' AND s.created_at < k.recovered_at))::int AS after_reminder
           FROM nl_carts k WHERE line_id = $1 AND created_at >= $2::timestamptz AND created_at < $3::timestamptz`,
        [lineId, r.start, r.end])).rows[0];
    const sends = (await db.query(
        `SELECT s.event, COUNT(*) FILTER (WHERE s.status = 'sent')::int AS sent, COUNT(*) FILTER (WHERE s.status = 'failed')::int AS failed,
                COUNT(*) FILTER (WHERE s.status = 'skipped')::int AS skipped,
                COUNT(*) FILTER (WHERE s.reply = 'confirmed')::int AS confirmed, COUNT(*) FILTER (WHERE s.reply = 'cancel_requested')::int AS cancel,
                COUNT(*) FILTER (WHERE s.event LIKE 'cart_%' AND s.status = 'sent' AND EXISTS (SELECT 1 FROM nl_carts k WHERE k.line_id = s.line_id AND k.token = s.ref AND k.recovered_at > s.created_at))::int AS ordered
           FROM nl_auto_sends s WHERE s.line_id = $1 AND s.created_at >= $2::timestamptz AND s.created_at < $3::timestamptz GROUP BY s.event`,
        [lineId, r.start, r.end])).rows;
    const taps = (await db.query(
        `SELECT kind, COALESCE(SUM(clicks), 0)::int AS clicks FROM nl_links WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz GROUP BY kind`,
        [r.start, r.end])).rows;
    const tapsOf = (k) => taps.filter(t => (k.endsWith('%') ? String(t.kind || '').startsWith(k.slice(0, -1)) : t.kind === k)).reduce((s, t) => s + t.clicks, 0);
    const stops = n((await db.query(
        `SELECT COUNT(*)::int AS n FROM wa_contacts WHERE line_id = $1 AND opted_out_at >= $2::timestamptz AND opted_out_at < $3::timestamptz`,
        [lineId, r.start, r.end])).rows[0].n);
    const ev = (k) => sends.find(s => s.event === k) || { sent: 0, failed: 0, skipped: 0, confirmed: 0, cancel: 0, ordered: 0 };

    // Team.
    const people = (await users()).filter(u => u.active);
    const byUser = (await db.query(
        `SELECT LOWER(m.sender_user) AS who, COUNT(DISTINCT m.conversation_id)::int AS chats
           FROM wa_messages m JOIN wa_conversations c ON c.id = m.conversation_id
          WHERE c.line_id = $1 AND m.sender_type = 'user' AND m.created_at >= $2 AND m.created_at < $3 AND m.sender_user IS NOT NULL
          GROUP BY 1`, [lineId, r.start, r.end])).rows;
    const closed = (await db.query(
        `SELECT LOWER(x.actor) AS who, COUNT(*)::int AS n FROM wa_activity x JOIN wa_conversations c ON c.id = x.conversation_id
          WHERE c.line_id = $1 AND x.kind = 'status' AND x.body LIKE '%closed the chat%' AND x.created_at >= $2 AND x.created_at < $3 GROUP BY 1`,
        [lineId, r.start, r.end])).rows;
    const raised = (await db.query(
        `SELECT LOWER(t.created_by) AS who, COUNT(*)::int AS n FROM support_tickets t JOIN wa_conversations c ON c.id = t.wa_conversation_id
          WHERE c.line_id = $1 AND t.created_at >= $2 AND t.created_at < $3 GROUP BY 1`, [lineId, r.start, r.end])).rows;
    const waitingBy = (await db.query(
        `SELECT LOWER(c.assigned_to) AS who, COUNT(*)::int AS n FROM wa_conversations c
          WHERE c.line_id = $1 AND c.status = 'open' AND c.assigned_to IS NOT NULL AND ${LAST_DIRECTION} = 'in' GROUP BY 1`, [lineId])).rows;
    const callBy = await callsByUser(lineId, r);
    const get = (rows, who) => rows.find(x => x.who === who)?.n ?? rows.find(x => x.who === who)?.chats ?? 0;
    const names = new Set([...people.filter(u => u.can_view_wa_normless).map(u => u.username.toLowerCase()), ...byUser.map(x => x.who), ...waitingBy.map(x => x.who)]);
    const team = [...names].filter(Boolean).map(who => {
        const u = people.find(p => p.username.toLowerCase() === who) || { username: who };
        return {
            username: u.username, name: shortName(u), chats: byUser.find(x => x.who === who)?.chats || 0,
            first_reply_secs: waits.byUser.get(who) ?? null, closed: get(closed, who), tickets: get(raised, who),
            calls: callBy.get(who) || 0, waiting: get(waitingBy, who),
        };
    }).sort((a, b) => b.chats - a.chats || a.name.localeCompare(b.name));

    return {
        brand: 'normless', range: { from: r.from, to: r.to, days: r.days, prev_from: r.prev.from, prev_to: r.prev.to },
        kpis: {
            conversations: { now: now.active, before: before.active },
            solved_share: { now: now.solved_share, before: before.solved_share },
            team: { now: now.team, before: before.team },
            first_reply_secs: { now: waits.all, before: prevWaits.all },
            waiting: { now: waiting.n, oldest: waiting.oldest, nobody: waiting.nobody },
            tickets: { now: await tickets(r), before: await tickets(r.prev) },
        },
        daily: fillDays(r, daily),
        topics,
        carts: {
            ...carts, recovered_value: n(carts.recovered_value), taps: tapsOf('cart_%'),
            reminders: ['cart_1', 'cart_2', 'cart_3'].map(k => ({ event: k, sent: ev(k).sent, ordered: ev(k).ordered })),
        },
        orders: {
            messages: ['order_prepaid', 'order_partial_cod', 'order_cod', 'cod_confirm', 'order_cancelled', 'fulfilled', 'refund']
                .map(k => ({ event: k, sent: ev(k).sent, taps: tapsOf(k) })),
            cod: { sent: ev('cod_confirm').sent, confirmed: ev('cod_confirm').confirmed, cancel: ev('cod_confirm').cancel },
            failed: sends.reduce((s, x) => s + x.failed, 0), stops,
        },
        calls: await calls(lineId, r),
        hours: await hours(lineId, r),
        team,
    };
}

function fillDays(r, rows) {
    const out = [];
    for (let d = new Date(`${r.from}T00:00:00Z`); iso(d) <= r.to; d = new Date(d.getTime() + DAY)) {
        const hit = rows.find(x => x.day === iso(d));
        out.push({ day: iso(d), total: hit?.total || 0, team: hit?.team || 0 });
    }
    return out;
}

/* ── Crewfit ──────────────────────────────────────────────────────────────────────────────── */

const ORDER_OK = `COALESCE(o.status, '') <> 'Cancelled'`;
const COLLECTED = `CASE WHEN o.payment_status = 'Fully Paid' THEN COALESCE(o.grand_total, 0)
                        ELSE GREATEST(COALESCE(o.grand_total - o.balance, o.advance, 0), 0) END`;

async function orderTotals(r, soFilter = null) {
    const params = [r.from, r.to];
    let extra = '';
    if (soFilter) { params.push(soFilter); extra = `AND LOWER(TRIM(o.so)) = ANY($3)`; }
    return (await db.query(
        `SELECT COUNT(*)::int AS orders, COALESCE(SUM(o.qty), 0)::int AS units, COALESCE(SUM(o.grand_total), 0)::numeric AS value,
                COALESCE(SUM(${COLLECTED}), 0)::numeric AS collected
           FROM crewfit_orders o WHERE o.order_date >= $1::date AND o.order_date <= $2::date AND ${ORDER_OK} ${extra}`, params)).rows[0];
}

async function leadTotals(r) {
    return (await db.query(
        `SELECT COUNT(*)::int AS leads, COUNT(*) FILTER (WHERE l.ad_referral IS NOT NULL)::int AS from_ads,
                COUNT(*) FILTER (WHERE s.stage = 'won' OR EXISTS (SELECT 1 FROM crewfit_orders o WHERE o.wa_lead_id = l.id))::int AS won
           FROM crewfit_leads l LEFT JOIN wa_lead_statuses s ON s.key = l.status
          WHERE l.created_at >= $1 AND l.created_at < $2`, [r.start, r.end])).rows[0];
}

/** Units per salesperson per week, for the eight weeks up to the end of the range. */
async function weekly(r, soFilter = null) {
    const end = new Date(`${r.to}T00:00:00Z`);
    const start = new Date(end.getTime() - 7 * 8 * DAY);
    const params = [iso(start), r.to];
    let extra = '';
    if (soFilter) { params.push(soFilter); extra = `AND LOWER(TRIM(o.so)) = ANY($3)`; }
    const rows = (await db.query(
        `SELECT DATE_TRUNC('week', o.order_date)::date::text AS week, COALESCE(NULLIF(TRIM(o.so), ''), '—') AS so,
                COUNT(*)::int AS orders, COALESCE(SUM(o.qty), 0)::int AS units
           FROM crewfit_orders o WHERE o.order_date > $1::date AND o.order_date <= $2::date AND ${ORDER_OK} ${extra}
          GROUP BY 1, 2 ORDER BY 1`, params)).rows;
    const weeks = [];
    const monday = (d) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x; };
    for (let w = monday(new Date(start.getTime() + DAY)); w <= end; w = new Date(w.getTime() + 7 * DAY)) {
        const k = iso(w);
        const here = rows.filter(x => x.week === k);
        weeks.push({ week: k, by: Object.fromEntries(here.map(x => [x.so, x.units])), orders: here.reduce((s, x) => s + x.orders, 0), units: here.reduce((s, x) => s + x.units, 0) });
    }
    return weeks;
}

async function crewfit(lineId, q) {
    const r = range(q, new Date().getDate());       // default: this month so far
    const list = await users();
    const [o, ob, l, lb, waits, prevWaits] = await Promise.all([orderTotals(r), orderTotals(r.prev), leadTotals(r), leadTotals(r.prev), replyWaits(lineId, r), replyWaits(lineId, r.prev)]);

    const perSo = (await db.query(
        `SELECT COALESCE(NULLIF(TRIM(o.so), ''), '') AS so, COUNT(*)::int AS orders, COALESCE(SUM(o.qty), 0)::int AS units,
                COALESCE(SUM(o.grand_total), 0)::numeric AS value, COALESCE(SUM(${COLLECTED}), 0)::numeric AS collected
           FROM crewfit_orders o WHERE o.order_date >= $1::date AND o.order_date <= $2::date AND ${ORDER_OK}
          GROUP BY 1 ORDER BY 3 DESC`, [r.from, r.to])).rows;
    const chats = (await db.query(
        `SELECT LOWER(m.sender_user) AS who, COUNT(DISTINCT m.conversation_id)::int AS chats, COUNT(*)::int AS sent
           FROM wa_messages m JOIN wa_conversations c ON c.id = m.conversation_id
          WHERE c.line_id = $1 AND m.sender_type = 'user' AND m.created_at >= $2 AND m.created_at < $3 AND m.sender_user IS NOT NULL GROUP BY 1`,
        [lineId, r.start, r.end])).rows;
    const callBy = await callsByUser(lineId, r);
    const team = perSo.filter(x => x.so).map(x => {
        const username = userForSo(x.so, list);
        const who = username?.toLowerCase();
        const c = chats.find(y => y.who === who);
        return {
            so: x.so, username, orders: x.orders, units: x.units, value: n(x.value), collected: n(x.collected),
            avg: x.orders ? Math.round(n(x.value) / x.orders) : null,
            chats: c?.chats || 0, first_reply_secs: who ? waits.byUser.get(who) ?? null : null, calls: who ? callBy.get(who) || 0 : 0,
        };
    });
    const unattributed = perSo.find(x => !x.so);

    const statuses = (await db.query(`SELECT key, name, stage, sort_order FROM wa_lead_statuses ORDER BY sort_order`)).rows;
    const byStatus = (await db.query(
        `SELECT status, COUNT(*)::int AS n FROM crewfit_leads WHERE created_at >= $1 AND created_at < $2 GROUP BY 1`, [r.start, r.end])).rows;
    const funnel = statuses.map(s => ({ key: s.key, label: s.name, stage: s.stage, count: byStatus.find(b => b.status === s.key)?.n || 0 }));
    const sources = (await db.query(
        `SELECT CASE WHEN l.ad_referral IS NOT NULL THEN 'ads' ELSE COALESCE(l.source, 'other') END AS source,
                COUNT(*)::int AS leads, COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM crewfit_orders o WHERE o.wa_lead_id = l.id))::int AS orders
           FROM crewfit_leads l WHERE l.created_at >= $1 AND l.created_at < $2 GROUP BY 1 ORDER BY 2 DESC`, [r.start, r.end])).rows;

    const convo = (await db.query(
        `SELECT COUNT(*) FILTER (WHERE m.direction = 'in')::int AS msgs_in, COUNT(*) FILTER (WHERE m.direction = 'out')::int AS msgs_out,
                COUNT(DISTINCT m.conversation_id) FILTER (WHERE m.direction = 'in')::int AS active,
                COUNT(DISTINCT m.conversation_id) FILTER (WHERE m.sender_type IN ('bot', 'ai'))::int AS by_menu
           FROM wa_messages m JOIN wa_conversations c ON c.id = m.conversation_id
          WHERE c.line_id = $1 AND m.created_at >= $2 AND m.created_at < $3`, [lineId, r.start, r.end])).rows[0];
    const stale = n((await db.query(
        `SELECT COUNT(*)::int AS n FROM wa_conversations c WHERE c.line_id = $1 AND c.status = 'open'
            AND ${LAST_DIRECTION} = 'in' AND c.last_inbound_at < NOW() - INTERVAL '1 hour'`, [lineId])).rows[0].n);
    const docs = (await db.query(
        `SELECT x.detail AS kind, COUNT(*)::int AS n FROM wa_activity x JOIN wa_conversations c ON c.id = x.conversation_id
          WHERE c.line_id = $1 AND x.kind = 'message' AND x.detail IS NOT NULL AND x.created_at >= $2 AND x.created_at < $3
          GROUP BY 1 ORDER BY 2 DESC`, [lineId, r.start, r.end])).rows;

    const conv = (x) => (x.leads ? Math.round(x.won / x.leads * 100) : null);
    return {
        brand: 'crewfit', range: { from: r.from, to: r.to, days: r.days, prev_from: r.prev.from, prev_to: r.prev.to },
        kpis: {
            orders: { now: o.orders, before: ob.orders }, units: { now: o.units, before: ob.units },
            value: { now: n(o.value), before: n(ob.value) }, collected: { now: n(o.collected), before: n(ob.collected) },
            leads: { now: l.leads, before: lb.leads, from_ads: l.from_ads },
            conversion: { now: conv(l), before: conv(lb) },
            first_reply_secs: { now: waits.all, before: prevWaits.all },
        },
        team, unattributed: unattributed ? { orders: unattributed.orders, units: unattributed.units } : null,
        weekly: await weekly(r), funnel, sources,
        conversations: { ...convo, menu_share: convo.active ? Math.round(convo.by_menu / convo.active * 100) : null, stale, docs },
        calls: await calls(lineId, r),
    };
}

/** One salesperson's own page. `username` is whose; the names on orders that are theirs are found by it. */
async function myPerformance(lineId, username, q) {
    const r = range(q, new Date().getDate());
    const list = await users();
    const u = list.find(x => x.username.toLowerCase() === String(username).toLowerCase()) || { username };
    const names = (await db.query(`SELECT DISTINCT TRIM(so) AS so FROM crewfit_orders WHERE NULLIF(TRIM(so), '') IS NOT NULL`)).rows
        .map(x => x.so).filter(so => userForSo(so, list)?.toLowerCase() === u.username.toLowerCase()).map(so => so.toLowerCase());
    const [o, ob, waits, prevWaits] = await Promise.all([
        names.length ? orderTotals(r, names) : { orders: 0, units: 0, value: 0, collected: 0 },
        names.length ? orderTotals(r.prev, names) : { orders: 0, units: 0, value: 0, collected: 0 },
        replyWaits(lineId, r), replyWaits(lineId, r.prev),
    ]);
    const who = u.username.toLowerCase();
    const orders = names.length ? (await db.query(
        `SELECT o.id, o.sl_no, o.order_date::text AS date, o.customer_name, o.billing_name, o.product, o.qty, o.grand_total,
                o.payment_status, o.status
           FROM crewfit_orders o WHERE o.order_date >= $1::date AND o.order_date <= $2::date AND ${ORDER_OK}
            AND LOWER(TRIM(o.so)) = ANY($3) ORDER BY o.order_date DESC, o.sl_no DESC LIMIT 100`, [r.from, r.to, names])).rows : [];
    // Chats waiting on them: theirs, open, the customer spoke last.
    const followups = (await db.query(
        `SELECT c.id, COALESCE(l.name, k.profile_name, k.phone) AS name, l.company, c.last_message_preview AS preview, c.last_inbound_at
           FROM wa_conversations c JOIN wa_contacts k ON k.id = c.contact_id LEFT JOIN crewfit_leads l ON l.id = k.lead_id
          WHERE c.line_id = $1 AND c.status = 'open' AND LOWER(c.assigned_to) = $2 AND ${LAST_DIRECTION} = 'in'
          ORDER BY c.last_inbound_at ASC LIMIT 8`, [lineId, who])).rows;
    const chats = (await db.query(
        `SELECT COUNT(DISTINCT m.conversation_id)::int AS n FROM wa_messages m JOIN wa_conversations c ON c.id = m.conversation_id
          WHERE c.line_id = $1 AND m.sender_type = 'user' AND LOWER(m.sender_user) = $2 AND m.created_at >= $3 AND m.created_at < $4`,
        [lineId, who, r.start, r.end])).rows[0].n;
    return {
        user: { username: u.username, name: shortName(u), so_names: names },
        range: { from: r.from, to: r.to, days: r.days, prev_from: r.prev.from, prev_to: r.prev.to },
        kpis: {
            orders: { now: o.orders, before: ob.orders }, units: { now: o.units, before: ob.units },
            value: { now: n(o.value), before: n(ob.value) }, collected: { now: n(o.collected), before: n(ob.collected) },
            chats: { now: chats }, first_reply_secs: { now: waits.byUser.get(who) ?? null, before: prevWaits.byUser.get(who) ?? null },
        },
        weekly: names.length ? await weekly(r, names) : [],
        orders: orders.map(x => ({ ...x, grand_total: n(x.grand_total) })),
        followups,
    };
}

module.exports = { normless, crewfit, myPerformance, range, userForSo, shortName, median };
