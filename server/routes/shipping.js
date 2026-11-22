/**
 * /api/shipping — Delhivery shipments, run from the CRM.
 *
 * `can_view_shipping` opens the pages; `can_manage_shipping` creates, re-creates, cancels, books
 * pickups and answers failed deliveries (each of these spends from the Delhivery wallet or changes
 * a live shipment). Settings are for owners and admins.
 */

const express = require('express');
const db = require('../db/connection');
const { hasPermission } = require('../utils/permissions');
const shipping = require('../services/shipping');
const dlv = require('../services/delhivery');

const router = express.Router();
const me = (req) => req.user?.username || null;
const isAdmin = (req) => ['owner', 'admin'].includes(req.user?.role);

const view = async (req, res, next) => ((await hasPermission(req, 'can_view_shipping')) ? next() : res.status(403).json({ error: 'Access denied' }));
const manage = async (req, res, next) => ((await hasPermission(req, 'can_manage_shipping')) ? next() : res.status(403).json({ error: 'You can see shipments but not act on them' }));
const admin = (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: 'Only an owner or admin can change shipping settings' }));

const fail = (res, err, what) => {
    console.error(`shipping ${what}:`, err.message);
    res.status(err.status && err.status < 600 ? err.status : 500).json({ error: err.message || `Failed to ${what}` });
};
const ids = (v) => (Array.isArray(v) ? v : [v]).map(Number).filter(Number.isFinite);

router.use(view);

// The orders that still need an AWB: unfulfilled, not cancelled or on hold, from the last 30
// days, and with no live shipment.
const PENDING_WHERE = `
    o.created_at > NOW() - INTERVAL '30 days'
    AND o.cancelled_at IS NULL AND COALESCE(o.on_hold, false) = false
    AND UPPER(COALESCE(o.fulfillment_status, 'UNFULFILLED')) NOT IN ('FULFILLED')
    AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.order_number = o.order_number
                      AND COALESCE(s.direction, 'forward') = 'forward'
                      AND (s.bucket <> 'cancelled' OR s.cancel_handled = 'not_shipping' OR s.cancel_handled IS NULL))`;

const BUCKETS = ['waiting_pickup', 'in_transit', 'out_for_delivery', 'ndr', 'rto_transit', 'rto_returned', 'delivered', 'cancelled', 'lost'];
const RETURNS = shipping.RETURN_BUCKETS;
// Shipments to customers only; return pickups are listed on their own.
const FORWARD = `bucket <> ALL('{${RETURNS.join(',')}}')`;

async function counts() {
    const r = (await db.query(`SELECT bucket, COUNT(*)::int AS n FROM shipments GROUP BY bucket`)).rows;
    const out = Object.fromEntries([...BUCKETS, ...RETURNS].map(b => [b, 0]));
    for (const x of r) out[x.bucket] = x.n;
    out.all = r.filter(x => !RETURNS.includes(x.bucket)).reduce((n, x) => n + x.n, 0);
    out.returns = RETURNS.reduce((n, b) => n + out[b], 0);
    out.returns_open = out.return_pickup + out.return_transit;
    out.pending_awb = (await db.query(`SELECT COUNT(*)::int AS n FROM orders o WHERE ${PENDING_WHERE}`)).rows[0].n;
    out.cancelled_open = (await db.query(`SELECT COUNT(*)::int AS n FROM shipments WHERE bucket = 'cancelled' AND cancel_kind = 'auto' AND cancel_handled IS NULL`)).rows[0].n;
    out.ndr_open = (await db.query(`SELECT COUNT(*)::int AS n FROM shipments WHERE bucket = 'ndr' AND (ndr_action_at IS NULL OR ndr_action_at < status_at)`)).rows[0].n;
    out.not_ready = (await db.query(`SELECT COUNT(*)::int AS n FROM shipments WHERE bucket = 'waiting_pickup' AND status_code IN ('FMEOD-152','X-PNP')`)).rows[0].n;
    return out;
}

/** GET /status — is Delhivery connected, and when did tracking last run. */
router.get('/status', async (req, res) => {
    try {
        const last = (await db.query(`SELECT started_at, status, summary FROM shipping_jobs WHERE kind = 'sync' ORDER BY id DESC LIMIT 1`)).rows[0] || null;
        res.json({ configured: dlv.configured(), last_sync: last, can_manage: await hasPermission(req, 'can_manage_shipping'), is_admin: isAdmin(req) });
    } catch (err) { fail(res, err, 'load status'); }
});

/** GET /alert-count — the sidebar badge: auto-cancels nobody has dealt with. */
router.get('/alert-count', async (req, res) => {
    try {
        const r = (await db.query(`SELECT COUNT(*)::int AS n FROM shipments WHERE bucket = 'cancelled' AND cancel_kind = 'auto' AND cancel_handled IS NULL`)).rows[0];
        res.json({ count: r.n });
    } catch (err) { fail(res, err, 'count alerts'); }
});

router.get('/counts', async (req, res) => {
    try { res.json(await counts()); } catch (err) { fail(res, err, 'count shipments'); }
});

/** GET /overview — the dashboard: counts, the oldest waiting parcel, and delivery performance. */
router.get('/overview', async (req, res) => {
    try {
        const days = [7, 14, 30].includes(parseInt(req.query.days, 10)) ? parseInt(req.query.days, 10) : 7;
        const c = await counts();
        const oldest = (await db.query(`SELECT MIN(COALESCE(manifested_at, created_at)) AS at FROM shipments WHERE bucket = 'waiting_pickup'`)).rows[0].at;
        // Performance over parcels picked up in the window, leaving out the last three days (too
        // early to have been delivered).
        const p = (await db.query(`
            SELECT COUNT(*)::int AS picked,
                   COUNT(*) FILTER (WHERE bucket = 'delivered')::int AS delivered,
                   COUNT(*) FILTER (WHERE bucket IN ('rto_transit','rto_returned'))::int AS rto,
                   COUNT(*) FILTER (WHERE bucket = 'delivered' AND COALESCE(ndr_attempts, 0) <= 1)::int AS first_attempt,
                   COUNT(*) FILTER (WHERE first_attempt_at IS NOT NULL AND expected_delivery IS NOT NULL)::int AS attempted,
                   COUNT(*) FILTER (WHERE first_attempt_at IS NOT NULL AND first_attempt_at <= expected_delivery)::int AS on_time,
                   AVG(EXTRACT(EPOCH FROM (first_attempt_at - picked_up_at)) / 86400) FILTER (WHERE first_attempt_at IS NOT NULL) AS avg_days
              FROM shipments
             WHERE ${FORWARD} AND picked_up_at > NOW() - ($1 || ' days')::interval - INTERVAL '3 days'
               AND picked_up_at < NOW() - INTERVAL '3 days'`, [String(days)])).rows[0];
        const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
        res.json({
            counts: c,
            oldest_waiting: oldest,
            performance: {
                days,
                picked: p.picked,
                on_time_first_attempt: pct(p.on_time, p.attempted),
                avg_days_to_attempt: p.avg_days != null ? Math.round(Number(p.avg_days) * 10) / 10 : null,
                delivered_first_attempt: pct(p.first_attempt, p.delivered),
                rto_rate: pct(p.rto, p.picked),
            },
        });
    } catch (err) { fail(res, err, 'load the overview'); }
});

/** GET /pending — orders that still need an AWB, newest first, with what packing knows. */
router.get('/pending', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const size = Math.min(100, Math.max(10, parseInt(req.query.size, 10) || 50));
        const vals = [];
        let where = PENDING_WHERE;
        const q = String(req.query.q || '').trim();
        if (q) {
            const list = q.split(/[\s,]+/).filter(Boolean).map(x => (x.startsWith('#') ? x : `#${x}`));
            if (list.length > 1) { vals.push(list); where += ` AND o.order_number = ANY($${vals.length})`; }
            else { vals.push(`%${q}%`); where += ` AND (o.order_number ILIKE $${vals.length} OR c.first_name ILIKE $${vals.length} OR c.last_name ILIKE $${vals.length} OR c.phone ILIKE $${vals.length} OR p.customer_name ILIKE $${vals.length})`; }
        }
        if (req.query.packed === 'yes') where += ' AND p.id IS NOT NULL';
        if (req.query.packed === 'no') where += ' AND p.id IS NULL';
        const from = `FROM orders o
                      LEFT JOIN customers c ON c.shopify_id = o.customer_shopify_id
                      LEFT JOIN packed_orders p ON p.order_number = o.order_number
                     WHERE ${where}`;
        const total = (await db.query(`SELECT COUNT(*)::int AS n ${from}`, vals)).rows[0].n;
        vals.push(size, (page - 1) * size);
        const rows = (await db.query(
            `SELECT o.order_number, o.shopify_id, o.total_price, o.financial_status, o.created_at, o.line_items_json,
                    COALESCE(NULLIF(p.customer_name, ''), TRIM(CONCAT(c.first_name, ' ', c.last_name))) AS customer_name,
                    p.ship_city, p.ship_pincode, p.packed_at, p.packed_by,
                    (SELECT s.awb FROM shipments s WHERE s.order_number = o.order_number AND s.bucket = 'cancelled' AND s.cancel_kind = 'auto' ORDER BY s.id DESC LIMIT 1) AS cancelled_awb
             ${from} ORDER BY o.created_at DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}`, vals)).rows;
        const parse = (j) => { try { return JSON.parse(j || '[]'); } catch { return []; } };
        res.json({
            total, page, size,
            orders: rows.map(r => {
                const items = parse(r.line_items_json);
                return {
                    order_number: r.order_number, created_at: r.created_at, total_price: r.total_price,
                    financial_status: r.financial_status,
                    cod: String(r.financial_status || '').toLowerCase() === 'pending',
                    customer_name: r.customer_name || '', city: r.ship_city || '', pincode: r.ship_pincode || '',
                    packed_at: r.packed_at, packed_by: r.packed_by,
                    items: items.map(li => `${li.title || li.name || ''}${li.variant_title ? ` / ${li.variant_title}` : ''}${(li.quantity || 1) > 1 ? ` ×${li.quantity}` : ''}`).filter(Boolean),
                    qty: items.reduce((n, li) => n + (Number(li.quantity) || 1), 0),
                };
            }),
        });
    } catch (err) { fail(res, err, 'list orders waiting for an AWB'); }
});

/** GET /shipments?bucket=&q=&payment=&page= */
router.get('/shipments', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const size = Math.min(100, Math.max(10, parseInt(req.query.size, 10) || 50));
        const vals = [];
        const where = [];
        const bucket = String(req.query.bucket || '');
        if (bucket === 'cancelled_open') where.push(`bucket = 'cancelled' AND cancel_kind = 'auto' AND cancel_handled IS NULL`);
        else if (bucket === 'not_ready') where.push(`bucket = 'waiting_pickup' AND status_code IN ('FMEOD-152','X-PNP')`);
        else if (bucket === 'returns') where.push(`bucket = ANY('{${RETURNS.join(',')}}')`);
        else if (BUCKETS.includes(bucket) || RETURNS.includes(bucket)) { vals.push(bucket); where.push(`bucket = $${vals.length}`); }
        else where.push(FORWARD);
        if (req.query.payment === 'COD' || req.query.payment === 'Prepaid') { vals.push(req.query.payment); where.push(`payment_mode = $${vals.length}`); }
        if (req.query.via === 'crm' || req.query.via === 'portal') { vals.push(req.query.via); where.push(`created_via = $${vals.length}`); }
        const q = String(req.query.q || '').trim();
        if (q) {
            const list = q.split(/[\s,]+/).filter(Boolean);
            if (list.length > 1) {
                vals.push(list); vals.push(list.map(x => (x.startsWith('#') ? x : `#${x}`)));
                where.push(`(awb = ANY($${vals.length - 1}) OR order_number = ANY($${vals.length}))`);
            } else {
                vals.push(`%${q}%`);
                where.push(`(awb ILIKE $${vals.length} OR order_number ILIKE $${vals.length} OR consignee_name ILIKE $${vals.length} OR consignee_city ILIKE $${vals.length})`);
            }
        }
        const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const total = (await db.query(`SELECT COUNT(*)::int AS n FROM shipments ${w}`, vals)).rows[0].n;
        // Oldest first where somebody has to act (waiting, failed, cancelled); newest first elsewhere.
        const order = ['waiting_pickup', 'ndr', 'cancelled', 'cancelled_open', 'not_ready', 'return_pickup'].includes(bucket)
            ? 'COALESCE(status_at, created_at) ASC' : 'COALESCE(status_at, created_at) DESC';
        vals.push(size, (page - 1) * size);
        const rows = (await db.query(
            `SELECT id, awb, order_number, delhivery_order, created_via, direction, bucket, status_type, status, status_code, instructions,
                    status_location, status_at, payment_mode, cod_amount, total_amount, box, weight_g, shipping_mode,
                    consignee_name, consignee_city, consignee_pincode, destination, manifested_at, picked_up_at,
                    expected_delivery, delivered_at, ndr_attempts, ndr_reason, ndr_action, ndr_action_at,
                    cancelled_at, cancel_kind, cancel_handled, recreated_from, recreated_as, shopify_fulfilled, shopify_error,
                    label_url, created_by, created_at
               FROM shipments ${w} ORDER BY ${order} LIMIT $${vals.length - 1} OFFSET $${vals.length}`, vals)).rows;
        res.json({ total, page, size, shipments: rows });
    } catch (err) { fail(res, err, 'list shipments'); }
});

router.get('/shipments/:id', async (req, res) => {
    try {
        const row = (await db.query('SELECT * FROM shipments WHERE id = $1', [req.params.id])).rows[0];
        if (!row) return res.status(404).json({ error: 'Shipment not found' });
        const ticket = (await db.query(
            `SELECT id, ref_no, status FROM support_tickets WHERE order_number = $1 ORDER BY id DESC LIMIT 1`, [row.order_number])).rows[0] || null;
        res.json({ shipment: row, ticket, tracking_url: shipping.trackingUrl(row.awb) });
    } catch (err) { fail(res, err, 'load the shipment'); }
});

/** POST /quote { order_number, box?, weight_g?, payment_mode?, shipping_mode? } — the drawer's preview. */
router.post('/quote', async (req, res) => {
    try { res.json(await shipping.quote(String(req.body?.order_number || '').trim(), req.body || {})); }
    catch (err) { fail(res, err, 'check the order'); }
});

/* ── actions ── */

router.post('/create', manage, async (req, res) => {
    try {
        const items = (Array.isArray(req.body?.items) ? req.body.items : []).filter(x => x?.order_number).slice(0, 200);
        if (!items.length) return res.status(400).json({ error: 'Choose at least one order' });
        res.json(await shipping.createMany(items, { actor: me(req) }));
    } catch (err) { fail(res, err, 'create shipments'); }
});

router.post('/recreate', manage, async (req, res) => {
    try { res.json(await shipping.recreate(ids(req.body?.ids || []), { box: req.body?.box }, { actor: me(req) })); }
    catch (err) { fail(res, err, 're-create shipments'); }
});

router.post('/not-shipping', manage, async (req, res) => {
    try { res.json({ updated: await shipping.markNotShipping(ids(req.body?.ids || []), me(req)) }); }
    catch (err) { fail(res, err, 'update shipments'); }
});

router.post('/shipments/:id/cancel', manage, async (req, res) => {
    try { res.json(await shipping.cancelOne(Number(req.params.id), me(req))); }
    catch (err) { fail(res, err, 'cancel the shipment'); }
});

router.post('/shipments/:id/edit', manage, async (req, res) => {
    try { res.json(await shipping.editOne(Number(req.params.id), req.body || {}, me(req))); }
    catch (err) { fail(res, err, 'update the shipment'); }
});

router.post('/reattempt', manage, async (req, res) => {
    try { res.json(await shipping.reattempt(ids(req.body?.ids || []), me(req))); }
    catch (err) { fail(res, err, 'ask for a re-attempt'); }
});

/** POST /labels { ids } — fresh label links (Delhivery's links expire). */
router.post('/labels', async (req, res) => {
    try {
        const rows = (await db.query('SELECT awb FROM shipments WHERE id = ANY($1)', [ids(req.body?.ids || [])])).rows;
        if (!rows.length) return res.status(400).json({ error: 'Choose at least one shipment' });
        res.json({ labels: await shipping.labelsFor(rows.map(r => r.awb)) });
    } catch (err) { fail(res, err, 'fetch labels'); }
});

/* ── pickups ── */

router.get('/pickups', async (req, res) => {
    try {
        const s = await shipping.getSettings();
        const rows = (await db.query(`SELECT * FROM shipping_pickups ORDER BY pickup_date DESC, id DESC LIMIT 30`)).rows;
        const out = [];
        for (const p of rows) {
            const st = p.awbs?.length ? (await db.query(
                `SELECT COUNT(*) FILTER (WHERE picked_up_at IS NOT NULL)::int AS picked,
                        COUNT(*) FILTER (WHERE bucket = 'waiting_pickup')::int AS waiting,
                        COUNT(*) FILTER (WHERE bucket = 'cancelled')::int AS cancelled
                   FROM shipments WHERE awb = ANY($1)`, [p.awbs])).rows[0] : { picked: 0, waiting: 0, cancelled: 0 };
            out.push({ ...p, awbs: undefined, awb_count: p.awbs?.length || 0, ...st });
        }
        // Everything still waiting at our location, oldest first, with Delhivery's last word on it.
        const waiting = (await db.query(
            `SELECT id, awb, order_number, consignee_name, consignee_city, payment_mode, cod_amount, status, status_code, instructions,
                    status_at, COALESCE(manifested_at, created_at) AS since, created_via
               FROM shipments WHERE bucket = 'waiting_pickup' AND COALESCE(pickup_location, $1) = $1
              ORDER BY COALESCE(manifested_at, created_at) ASC LIMIT 500`, [s.pickup_location])).rows;
        res.json({ pickups: out, waiting, pickup_location: s.pickup_location, pickup_time: s.pickup_time, risk_days: s.alert_risk_days });
    } catch (err) { fail(res, err, 'list pickups'); }
});

router.post('/pickups', manage, async (req, res) => {
    try { res.json(await shipping.bookPickup(req.body || {}, me(req))); }
    catch (err) { fail(res, err, 'book the pickup'); }
});

/* ── activity, sync, settings ── */

router.get('/jobs', async (req, res) => {
    try {
        const vals = [];
        const where = [];
        if (req.query.kind) { vals.push(String(req.query.kind)); where.push(`kind = $${vals.length}`); }
        if (req.query.failed === '1') where.push(`failed > 0`);
        if (req.query.hide_sync === '1') where.push(`NOT (kind = 'sync' AND failed = 0)`);
        const rows = (await db.query(
            `SELECT * FROM shipping_jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 100`, vals)).rows;
        res.json({ jobs: rows });
    } catch (err) { fail(res, err, 'list activity'); }
});

router.post('/sync', manage, async (req, res) => {
    try { res.json(await shipping.sync({ actor: me(req) })); }
    catch (err) { fail(res, err, 'sync tracking'); }
});

router.get('/settings', async (req, res) => {
    try { res.json({ settings: await shipping.getSettings(), configured: dlv.configured() }); }
    catch (err) { fail(res, err, 'load settings'); }
});

router.put('/settings', admin, async (req, res) => {
    try { res.json({ settings: await shipping.saveSettings(req.body || {}, me(req)) }); }
    catch (err) { fail(res, err, 'save settings'); }
});

/** GET /catalog — Shopify products and product types, for the packing rules. */
router.get('/catalog', admin, async (req, res) => {
    try {
        const c = await shipping.catalog({ fresh: req.query.fresh === '1' });
        res.json({ products: c.products, types: c.types });
    } catch (err) { fail(res, err, 'load products from Shopify'); }
});

/** POST /settings/test — a harmless call (pincode lookup) to prove the token works. */
router.post('/settings/test', admin, async (req, res) => {
    try {
        const s = await shipping.getSettings();
        const r = await dlv.pincode(s.origin_pincode || '110001');
        res.json({ ok: true, serviceable: r.serviceable });
    } catch (err) { fail(res, err, 'reach Delhivery'); }
});

module.exports = router;
