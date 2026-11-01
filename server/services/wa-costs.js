/**
 * What WhatsApp costs: Meta's own figures for each line, over any range of days.
 *
 * Meta charges per message delivered, by the template's category (marketing, utility,
 * authentication). Service replies — anything typed inside the 24 hours after a customer writes —
 * are free, as are utility templates sent inside that window and everything in the 72 hours after
 * a customer arrives from a click-to-WhatsApp ad. The figures come from the business account's
 * pricing analytics, so they are what Meta will bill (approximate until the invoice), in the
 * account's own currency.
 *
 * Meta does not say which of our messages cost what, so the split by who sent them comes from our
 * own records: each status update carries the message's category and whether it is billed, and
 * that is kept on the message. Those are priced at the average rate Meta charged for the category
 * in the same range — an estimate, and only for messages sent since the CRM started keeping it.
 */

const db = require('../db/connection');
const wa = require('./whatsapp');
const lines = require('./wa-line');

const DAY = 86400;

// Meta's figures for a range change only as the day goes on: kept ten minutes, so moving between
// the brands or reopening the page does not ask again.
const cache = new Map();
const TTL = 10 * 60 * 1000;

const ymd = (d) => d.toISOString().slice(0, 10);
const istDay = (unix) => ymd(new Date((Number(unix) + 19800) * 1000));

/** The account's currency and the number's digits, as Meta wants them for the filter. */
async function accountFacts(line) {
    const [account, phone] = await Promise.all([
        wa.graph(`/${line.wabaId}?fields=currency,name`).catch(() => ({})),
        line.phoneNumberId ? wa.graph(`/${line.phoneNumberId}?fields=display_phone_number,verified_name`).catch(() => ({})) : {},
    ]);
    return {
        currency: account?.currency || 'INR',
        account: account?.name || null,
        number: phone?.display_phone_number ? String(phone.display_phone_number).replace(/\D/g, '') : null,
        prettyNumber: phone?.display_phone_number || null,
    };
}

/** Meta's daily data points between two days (inclusive), at most 90 days per request. */
async function pricingPoints(line, number, from, to) {
    const out = [];
    let start = Date.parse(`${from}T00:00:00Z`) / 1000;
    const stop = Date.parse(`${to}T00:00:00Z`) / 1000 + DAY;
    while (start < stop) {
        const end = Math.min(start + 90 * DAY, stop);
        const field = [
            `pricing_analytics.start(${start}).end(${end}).granularity(DAILY)`,
            // Two numbers can share a business account: only this line's.
            number ? `.phone_numbers(["${number}"])` : '',
            '.dimensions(["PRICING_CATEGORY","PRICING_TYPE"])',
        ].join('');
        const data = await wa.graph(`/${line.wabaId}?fields=${encodeURIComponent(field)}`);
        for (const set of data?.pricing_analytics?.data || []) out.push(...(set.data_points || []));
        start = end;
    }
    return out;
}

/** Our own sent messages in the range, by who sent them and how Meta priced them. */
async function bySender(lineId, from, to) {
    const r = await db.query(
        `SELECT CASE WHEN m.sender_type = 'user' THEN 'team'
                     WHEN m.sender_type = 'phone' THEN 'phone'
                     ELSE 'bot' END AS sender,
                m.pricing_category AS category,
                COUNT(*)::int AS sent,
                COUNT(*) FILTER (WHERE m.billable)::int AS billed,
                COUNT(*) FILTER (WHERE m.type = 'template')::int AS templates
           FROM wa_messages m JOIN wa_conversations c ON c.id = m.conversation_id
          WHERE c.line_id = $1 AND m.direction = 'out' AND m.pricing_category IS NOT NULL
            -- Stored in UTC; the day is India's.
            AND (m.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2::date AND $3::date
          GROUP BY 1, 2`, [lineId, from, to]);
    const since = (await db.query(
        `SELECT (MIN(m.created_at) AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')::date::text AS at FROM wa_messages m JOIN wa_conversations c ON c.id = m.conversation_id
          WHERE c.line_id = $1 AND m.pricing_category IS NOT NULL`, [lineId])).rows[0]?.at || null;
    return { rows: r.rows, since };
}

/** One line's costs over the range. */
async function forLine(brand, from, to) {
    await lines.ready();
    const line = lines.get(brand);
    const base = { brand, name: line.name };
    if (!line.token || !line.wabaId) return { ...base, connected: false, error: 'This number is not connected, so Meta has no figures to give.' };

    const key = `${brand}|${from}|${to}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL) return hit.value;

    return lines.run(line, async () => {
        let facts;
        let points;
        try {
            facts = await accountFacts(line);
            points = await pricingPoints(line, facts.number, from, to);
        } catch (err) {
            return { ...base, connected: true, error: `Meta did not give the figures: ${err.message}` };
        }

        const cats = new Map();
        const days = new Map();
        const totals = { cost: 0, charged: 0, free: 0, free_service: 0, free_entry: 0 };
        for (const p of points) {
            const cat = String(p.pricing_category || 'other').toLowerCase();
            const type = String(p.pricing_type || 'regular').toLowerCase();
            const volume = Number(p.volume) || 0;
            const cost = Number(p.cost) || 0;
            const c = cats.get(cat) || { category: cat, charged: 0, free_service: 0, free_entry: 0, cost: 0 };
            if (type === 'free_customer_service') { c.free_service += volume; totals.free_service += volume; totals.free += volume; }
            else if (type === 'free_entry_point') { c.free_entry += volume; totals.free_entry += volume; totals.free += volume; }
            else { c.charged += volume; totals.charged += volume; }
            c.cost += cost;
            totals.cost += cost;
            cats.set(cat, c);

            const d = istDay(p.start);
            const day = days.get(d) || { date: d, cost: 0, charged: 0, free: 0, byCategory: {} };
            day.cost += cost;
            if (type === 'regular') day.charged += volume; else day.free += volume;
            day.byCategory[cat] = (day.byCategory[cat] || 0) + cost;
            days.set(d, day);
        }
        const byCategory = [...cats.values()]
            .map(c => ({ ...c, rate: c.charged ? c.cost / c.charged : null }))
            .sort((a, b) => b.cost - a.cost || (b.charged + b.free_service + b.free_entry) - (a.charged + a.free_service + a.free_entry));

        // Every day in the range, quiet ones included, so the chart reads as a timeline.
        const series = [];
        for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY * 1000) {
            const d = ymd(new Date(t));
            series.push(days.get(d) || { date: d, cost: 0, charged: 0, free: 0, byCategory: {} });
        }

        const rate = Object.fromEntries(byCategory.filter(c => c.rate != null).map(c => [c.category, c.rate]));
        const own = await bySender(line.id, from, to);
        const senders = own.rows.map(r => ({ ...r, estimate: rate[r.category] != null ? r.billed * rate[r.category] : null }));

        const value = {
            ...base, connected: true, currency: facts.currency, account: facts.account, number: facts.prettyNumber,
            totals, byCategory, series, senders, sendersSince: own.since,
        };
        cache.set(key, { at: Date.now(), value });
        return value;
    });
}

module.exports = { forLine };
