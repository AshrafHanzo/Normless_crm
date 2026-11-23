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
const { tableParams, pagination } = require('../utils/table');
const { toCsv } = require('../utils/csv');
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

/**
 * GET /track-status?awbs=a,b&orders=#1,#2 — where these parcels are, from the CRM's last tracking.
 * Open to anyone signed in: the scanner, support tickets and marketing orders show it to people who
 * may not have Shipping access, and it says nothing beyond the status.
 */
router.get('/track-status', async (req, res) => {
    try {
        const list = (v) => String(v || '').split(',').map(x => x.trim()).filter(Boolean);
        res.json(await shipping.statusOf({ awbs: list(req.query.awbs), orders: list(req.query.orders) }));
    } catch (err) { fail(res, err, 'look up shipment status'); }
});

router.use(view);

// The orders that still need an AWB: unfulfilled and not cancelled in Shopify, however old, with
// no live shipment. An order on hold in Shopify is usually a return waiting for the team's decision;
// it is listed apart and can't be shipped until Shopify releases it back to unfulfilled.
const PENDING_BASE = `
    o.cancelled_at IS NULL
    AND UPPER(COALESCE(o.fulfillment_status, 'UNFULFILLED')) NOT IN ('FULFILLED', 'RESTOCKED')
    AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.order_number = o.order_number
                      AND COALESCE(s.direction, 'forward') = 'forward'
                      AND (s.bucket <> 'cancelled' OR s.cancel_handled = 'not_shipping' OR s.cancel_handled IS NULL))`;
const PENDING_WHERE = `${PENDING_BASE} AND COALESCE(o.on_hold, false) = false`;
const ON_HOLD_WHERE = `${PENDING_BASE} AND COALESCE(o.on_hold, false) = true`;

const BUCKETS = ['waiting_pickup', 'in_transit', 'out_for_delivery', 'ndr', 'rto_transit', 'rto_returned', 'delivered', 'cancelled', 'lost'];
const RETURNS = shipping.RETURN_BUCKETS;
// As the portal splits them: an AWB with no pickup scheduled yet is "ready to ship"; once a pickup
// is scheduled (or attempted) it is "ready for pickup".
const READY_TO_SHIP = `s.bucket = 'waiting_pickup' AND COALESCE(s.status_code, 'X-UCI') = 'X-UCI'`;
const READY_FOR_PICKUP = `s.bucket = 'waiting_pickup' AND NOT (${READY_TO_SHIP})`;
// Shipments to customers only; return pickups are listed on their own.
const FORWARD = `s.bucket <> ALL('{${RETURNS.join(',')}}')`;

/* ── filters shared by the lists and their CSV downloads ── */

// An order's line items, from the JSON the order sync keeps: [{ title, quantity, variant: "Green / XL" }].
const LINES = `jsonb_array_elements(CASE WHEN o.line_items_json LIKE '[%' THEN o.line_items_json::jsonb ELSE '[]'::jsonb END)`;
// Shopify calls a product without options "Default Title"; that is no variant at all.
const VARIANT = `NULLIF(COALESCE(li->>'variant', li->>'variant_title', ''), 'Default Title')`;
const SIZE_OF = `NULLIF(TRIM(regexp_replace(COALESCE(${VARIANT}, ''), '^.*/', '')), '')`;
const COLOR_OF = `CASE WHEN ${VARIANT} LIKE '%/%' THEN NULLIF(TRIM(split_part(${VARIANT}, '/', 1)), '') END`;
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

/** Product, colour and size: an order line has to match all that are chosen. */
function itemFilter(q, vals, fallbackDesc = null) {
    const conds = [];
    if (q.product) { vals.push(String(q.product)); conds.push(`li->>'title' = $${vals.length}`); }
    if (q.color) { vals.push(String(q.color).toLowerCase()); conds.push(`LOWER(${COLOR_OF}) = $${vals.length}`); }
    if (q.size) { vals.push(String(q.size).toLowerCase()); conds.push(`LOWER(${SIZE_OF}) = $${vals.length}`); }
    if (!conds.length) return null;
    const inOrder = `EXISTS (SELECT 1 FROM ${LINES} li WHERE ${conds.join(' AND ')})`;
    // A manual shipment has no order behind it; its product text is all there is to match.
    if (fallbackDesc && q.product) { vals.push(`%${q.product}%`); return `(${inOrder} OR (o.id IS NULL AND ${fallbackDesc} ILIKE $${vals.length}))`; }
    return inOrder;
}
function dateRange(col, from, to, vals, where) {
    if (isDay(from)) { vals.push(from); where.push(`${col} >= $${vals.length}::date`); }
    if (isDay(to)) { vals.push(to); where.push(`${col} < $${vals.length}::date + 1`); }
}

/** WHERE for the shipments list (s = shipments, o = the order behind it, if any). */
function shipmentFilter(q) {
    const vals = [];
    const where = [];
    const bucket = String(q.bucket || '');
    if (bucket === 'cancelled_open') where.push(`s.bucket = 'cancelled' AND s.cancel_kind = 'auto' AND s.cancel_handled IS NULL`);
    else if (bucket === 'ready_to_ship') where.push(READY_TO_SHIP);
    else if (bucket === 'ready_for_pickup') where.push(READY_FOR_PICKUP);
    else if (bucket === 'not_ready') where.push(`s.bucket = 'waiting_pickup' AND s.status_code IN ('FMEOD-152','X-PNP')`);
    else if (bucket === 'returns') where.push(`s.bucket = ANY('{${RETURNS.join(',')}}')`);
    else if (bucket === 'manual') where.push(`s.source = 'manual'`);
    else if (BUCKETS.includes(bucket) || RETURNS.includes(bucket)) { vals.push(bucket); where.push(`s.bucket = $${vals.length}`); }
    else where.push(FORWARD);
    if (q.payment === 'COD' || q.payment === 'Prepaid') { vals.push(q.payment); where.push(`s.payment_mode = $${vals.length}`); }
    if (q.via === 'crm' || q.via === 'portal') { vals.push(q.via); where.push(`s.created_via = $${vals.length}`); }
    if (q.source === 'manual' || q.source === 'shopify') { vals.push(q.source); where.push(`COALESCE(s.source, 'shopify') = $${vals.length}`); }
    dateRange(`COALESCE(s.manifested_at, s.created_at)`, q.manifested_from, q.manifested_to, vals, where);
    dateRange('o.created_at', q.ordered_from, q.ordered_to, vals, where);
    const items = itemFilter(q, vals, 's.products_desc');
    if (items) where.push(items);
    const term = String(q.q || '').trim();
    if (term) {
        const list = term.split(/[\s,]+/).filter(Boolean);
        if (list.length > 1) {
            vals.push(list); vals.push(list.map(x => (x.startsWith('#') ? x : `#${x}`)));
            where.push(`(s.awb = ANY($${vals.length - 1}) OR s.order_number = ANY($${vals.length}))`);
        } else {
            vals.push(`%${term}%`);
            where.push(`(s.awb ILIKE $${vals.length} OR s.order_number ILIKE $${vals.length} OR s.delhivery_order ILIKE $${vals.length}
                         OR s.consignee_name ILIKE $${vals.length} OR s.consignee_city ILIKE $${vals.length} OR s.consignee_phone ILIKE $${vals.length})`);
        }
    }
    return { vals, where: where.length ? `WHERE ${where.join(' AND ')}` : '' };
}

/** WHERE for the orders waiting for an AWB (o = orders, c = customer, p = packing record). */
function pendingFilter(q) {
    const vals = [];
    let where = q.hold === 'only' ? ON_HOLD_WHERE : PENDING_WHERE;
    const term = String(q.q || '').trim();
    if (term) {
        const list = term.split(/[\s,]+/).filter(Boolean).map(x => (x.startsWith('#') ? x : `#${x}`));
        if (list.length > 1) { vals.push(list); where += ` AND o.order_number = ANY($${vals.length})`; }
        else { vals.push(`%${term}%`); where += ` AND (o.order_number ILIKE $${vals.length} OR c.first_name ILIKE $${vals.length} OR c.last_name ILIKE $${vals.length} OR c.phone ILIKE $${vals.length} OR p.customer_name ILIKE $${vals.length})`; }
    }
    if (q.packed === 'yes') where += ' AND p.id IS NOT NULL';
    if (q.packed === 'no') where += ' AND p.id IS NULL';
    const extra = [];
    dateRange('o.created_at', q.ordered_from, q.ordered_to, vals, extra);
    const items = itemFilter(q, vals);
    if (items) extra.push(items);
    if (extra.length) where += ` AND ${extra.join(' AND ')}`;
    return { vals, where };
}
const PENDING_FROM = (where) => `FROM orders o
    LEFT JOIN customers c ON c.shopify_id = o.customer_shopify_id
    LEFT JOIN packed_orders p ON p.order_number = o.order_number
    WHERE ${where}`;
const SHIPMENTS_FROM = (where) => `FROM shipments s LEFT JOIN orders o ON o.order_number = s.order_number ${where}`;

const parseLines = (j) => { try { const a = JSON.parse(j || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
const variantOf = (li) => { const v = li.variant || li.variant_title || ''; return v === 'Default Title' ? '' : v; };
const lineText = (li) => `${li.title || li.name || ''}${variantOf(li) ? ` / ${variantOf(li)}` : ''}${(li.quantity || 1) > 1 ? ` ×${li.quantity}` : ''}`;
const itemsOf = (json, fallback) => { const l = parseLines(json); return l.length ? l.map(lineText).filter(Boolean) : (fallback ? [fallback] : []); };

const csvOut = (res, name, rows, columns) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(toCsv(rows, columns));
};
const stamp = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 16).replace('T', '-').replace(':', '');
const ist = (v) => (v ? new Date(new Date(v).getTime() + 5.5 * 3600000).toISOString().slice(0, 16).replace('T', ' ') : '');

async function counts() {
    const r = (await db.query(`SELECT bucket, COUNT(*)::int AS n FROM shipments GROUP BY bucket`)).rows;
    const out = Object.fromEntries([...BUCKETS, ...RETURNS].map(b => [b, 0]));
    for (const x of r) out[x.bucket] = x.n;
    out.all = r.filter(x => !RETURNS.includes(x.bucket)).reduce((n, x) => n + x.n, 0);
    out.returns = RETURNS.reduce((n, b) => n + out[b], 0);
    out.returns_open = out.return_pickup + out.return_transit;
    out.pending_awb = (await db.query(`SELECT COUNT(*)::int AS n FROM orders o WHERE ${PENDING_WHERE}`)).rows[0].n;
    out.on_hold = (await db.query(`SELECT COUNT(*)::int AS n FROM orders o WHERE ${ON_HOLD_WHERE}`)).rows[0].n;
    out.cancelled_open = (await db.query(`SELECT COUNT(*)::int AS n FROM shipments WHERE bucket = 'cancelled' AND cancel_kind = 'auto' AND cancel_handled IS NULL`)).rows[0].n;
    out.ndr_open = (await db.query(`SELECT COUNT(*)::int AS n FROM shipments WHERE bucket = 'ndr' AND (ndr_action_at IS NULL OR ndr_action_at < status_at)`)).rows[0].n;
    out.not_ready = (await db.query(`SELECT COUNT(*)::int AS n FROM shipments WHERE bucket = 'waiting_pickup' AND status_code IN ('FMEOD-152','X-PNP')`)).rows[0].n;
    out.ready_to_ship = (await db.query(`SELECT COUNT(*)::int AS n FROM shipments s WHERE ${READY_TO_SHIP}`)).rows[0].n;
    out.ready_for_pickup = (await db.query(`SELECT COUNT(*)::int AS n FROM shipments s WHERE ${READY_FOR_PICKUP}`)).rows[0].n;
    out.manual = (await db.query(`SELECT COUNT(*)::int AS n FROM shipments WHERE source = 'manual'`)).rows[0].n;
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
              FROM shipments s
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

/** GET /filters — what the product, colour and size filters can offer (orders of the last 6 months). */
router.get('/filters', async (req, res) => {
    try {
        const r = (await db.query(
            `SELECT DISTINCT li->>'title' AS product, ${COLOR_OF} AS color, ${SIZE_OF} AS size
               FROM orders o, ${LINES} li WHERE o.created_at > NOW() - INTERVAL '180 days'`)).rows;
        const uniq = (k) => [...new Set(r.map(x => x[k]).filter(Boolean))];
        const SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', '2XL', 'XXL', '3XL', 'XXXL', '4XL', '5XL'];
        const sizes = uniq('size').sort((a, b) => {
            const ia = SIZE_ORDER.indexOf(a.toUpperCase()), ib = SIZE_ORDER.indexOf(b.toUpperCase());
            return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
        });
        res.json({ products: uniq('product').sort((a, b) => a.localeCompare(b)), colors: uniq('color').sort((a, b) => a.localeCompare(b)), sizes });
    } catch (err) { fail(res, err, 'load the filters'); }
});

const PENDING_SORT = { sortable: { ordered: 'o.created_at', order: 'o.order_number' }, defaultSort: 'ordered', tiebreak: 'o.id' };

/** GET /pending — orders that still need an AWB (or, with hold=only, the ones on hold). */
router.get('/pending', async (req, res) => {
    try {
        const t = tableParams(req.query, PENDING_SORT);
        const { vals, where } = pendingFilter(req.query);
        const total = (await db.query(`SELECT COUNT(*)::int AS n ${PENDING_FROM(where)}`, vals)).rows[0].n;
        vals.push(t.limit, t.offset);
        const rows = (await db.query(
            `SELECT o.order_number, o.shopify_id, o.total_price, o.financial_status, o.created_at, o.line_items_json, COALESCE(o.on_hold, false) AS on_hold,
                    COALESCE(NULLIF(p.customer_name, ''), TRIM(CONCAT(c.first_name, ' ', c.last_name))) AS customer_name,
                    p.ship_city, p.ship_pincode, p.packed_at, p.packed_by,
                    (SELECT s.awb FROM shipments s WHERE s.order_number = o.order_number AND s.bucket = 'cancelled' AND s.cancel_kind = 'auto' ORDER BY s.id DESC LIMIT 1) AS cancelled_awb
             ${PENDING_FROM(where)} ${t.orderBy} LIMIT $${vals.length - 1} OFFSET $${vals.length}`, vals)).rows;
        res.json({
            total, pagination: pagination(total, t),
            orders: rows.map(r => {
                const items = parseLines(r.line_items_json);
                return {
                    order_number: r.order_number, created_at: r.created_at, total_price: r.total_price,
                    financial_status: r.financial_status, on_hold: r.on_hold,
                    cod: String(r.financial_status || '').toLowerCase() === 'pending',
                    customer_name: r.customer_name || '', city: r.ship_city || '', pincode: r.ship_pincode || '',
                    packed_at: r.packed_at, packed_by: r.packed_by, cancelled_awb: r.cancelled_awb,
                    items: items.map(lineText).filter(Boolean),
                    qty: items.reduce((n, li) => n + (Number(li.quantity) || 1), 0),
                };
            }),
        });
    } catch (err) { fail(res, err, 'list orders waiting for an AWB'); }
});

/** GET /pending.csv — the same list, every row, as a spreadsheet. */
router.get('/pending.csv', async (req, res) => {
    try {
        const { vals, where } = pendingFilter(req.query);
        const rows = (await db.query(
            `SELECT o.order_number, o.created_at, o.total_price, o.financial_status, o.line_items_json, COALESCE(o.on_hold, false) AS on_hold,
                    COALESCE(NULLIF(p.customer_name, ''), TRIM(CONCAT(c.first_name, ' ', c.last_name))) AS customer_name, c.phone,
                    p.ship_city, p.ship_pincode, p.packed_at
             ${PENDING_FROM(where)} ORDER BY o.created_at DESC LIMIT 20000`, vals)).rows;
        csvOut(res, `${req.query.hold === 'only' ? 'on-hold' : 'pending-awb'}-${stamp()}.csv`, rows.map(r => ({
            order: r.order_number, date: ist(r.created_at), customer: r.customer_name, phone: r.phone || '',
            city: r.ship_city || '', pincode: r.ship_pincode || '', total: r.total_price,
            payment: String(r.financial_status || '').toLowerCase() === 'pending' ? 'COD' : 'Prepaid',
            items: itemsOf(r.line_items_json).join('; '), packed: r.packed_at ? ist(r.packed_at) : '', hold: r.on_hold ? 'On hold' : '',
        })), [{ key: 'order', label: 'Order' }, { key: 'date', label: 'Ordered' }, { key: 'customer', label: 'Customer' },
            { key: 'phone', label: 'Phone' }, { key: 'city', label: 'City' }, { key: 'pincode', label: 'Pincode' },
            { key: 'total', label: 'Total' }, { key: 'payment', label: 'Payment' }, { key: 'items', label: 'Items' },
            { key: 'packed', label: 'Packed' }, { key: 'hold', label: 'On hold' }]);
    } catch (err) { fail(res, err, 'export orders'); }
});

const SHIP_SORT = {
    sortable: {
        updated: 'COALESCE(s.status_at, s.created_at)', manifested: 'COALESCE(s.manifested_at, s.created_at)',
        ordered: 'o.created_at', order: 's.order_number', status: 's.status',
    },
    defaultSort: 'updated', tiebreak: 's.id',
};
// Oldest first where somebody has to act (waiting, failed, cancelled); newest first elsewhere.
const ACT_ON = ['waiting_pickup', 'ready_to_ship', 'ready_for_pickup', 'ndr', 'cancelled', 'cancelled_open', 'not_ready', 'return_pickup'];

/** GET /shipments?bucket=&q=&payment=&manifested_from=&ordered_from=&product=&color=&size=&sort=&page=&limit= */
router.get('/shipments', async (req, res) => {
    try {
        const q = { ...req.query };
        if (!q.dir && !q.sort) q.dir = ACT_ON.includes(String(q.bucket || '')) ? 'asc' : 'desc';
        // The old page-size parameter, still used by the Auto-cancelled tab.
        if (!q.limit && q.size) q.limit = q.size;
        const t = tableParams(q, { ...SHIP_SORT, maxLimit: 300 });
        const { vals, where } = shipmentFilter(q);
        const total = (await db.query(`SELECT COUNT(*)::int AS n ${SHIPMENTS_FROM(where)}`, vals)).rows[0].n;
        vals.push(t.limit, t.offset);
        const rows = (await db.query(
            `SELECT s.id, s.awb, s.order_number, s.delhivery_order, s.created_via, s.source, s.source_ref, s.direction, s.bucket, s.status_type, s.status,
                    s.status_code, s.instructions, s.status_location, s.status_at, s.payment_mode, s.cod_amount, s.total_amount, s.box, s.weight_g,
                    s.shipping_mode, s.consignee_name, s.consignee_city, s.consignee_pincode, s.destination, s.manifested_at, s.picked_up_at,
                    s.expected_delivery, s.delivered_at, s.ndr_attempts, s.ndr_reason, s.ndr_action, s.ndr_action_at,
                    s.cancelled_at, s.cancel_kind, s.cancel_handled, s.recreated_from, s.recreated_as, s.shopify_fulfilled, s.shopify_error,
                    s.label_url, s.created_by, s.created_at, s.products_desc, o.created_at AS ordered_at, o.line_items_json
             ${SHIPMENTS_FROM(where)} ${t.orderBy} LIMIT $${vals.length - 1} OFFSET $${vals.length}`, vals)).rows;
        res.json({
            total, pagination: pagination(total, t),
            shipments: rows.map(({ line_items_json: j, ...r }) => ({ ...r, items: itemsOf(j, r.products_desc) })),
        });
    } catch (err) { fail(res, err, 'list shipments'); }
});

/** GET /shipments.csv — the list as it is filtered, every row. */
router.get('/shipments.csv', async (req, res) => {
    try {
        const { vals, where } = shipmentFilter(req.query);
        const rows = (await db.query(
            `SELECT s.*, o.created_at AS ordered_at, o.line_items_json ${SHIPMENTS_FROM(where)}
              ORDER BY COALESCE(s.manifested_at, s.created_at) DESC LIMIT 20000`, vals)).rows;
        csvOut(res, `shipments-${req.query.bucket || 'all'}-${stamp()}.csv`, rows.map(r => ({
            order: r.order_number || '', ref: r.delhivery_order || '', awb: r.awb, status: r.status || '', bucket: r.bucket,
            detail: r.instructions || '', payment: r.payment_mode || '', cod: r.payment_mode === 'COD' ? r.cod_amount : '',
            customer: r.consignee_name || '', phone: r.consignee_phone || '', city: r.consignee_city || r.destination || '',
            pincode: r.consignee_pincode || '', items: itemsOf(r.line_items_json, r.products_desc).join('; '),
            box: r.box || '', weight: r.weight_g || '', ordered: ist(r.ordered_at), manifested: ist(r.manifested_at || r.created_at),
            picked: ist(r.picked_up_at), delivered: ist(r.delivered_at), source: r.source === 'manual' ? `Manual${r.source_ref ? ` (${r.source_ref})` : ''}` : (r.created_via === 'crm' ? 'CRM' : 'Delhivery portal'),
            replaces: r.recreated_from || '', replaced_by: r.recreated_as || '',
        })), [{ key: 'order', label: 'Order' }, { key: 'ref', label: 'Delhivery order id' }, { key: 'awb', label: 'AWB' },
            { key: 'status', label: 'Status' }, { key: 'bucket', label: 'CRM status' }, { key: 'detail', label: 'Delhivery says' },
            { key: 'payment', label: 'Payment' }, { key: 'cod', label: 'COD amount' }, { key: 'customer', label: 'Customer' },
            { key: 'phone', label: 'Phone' }, { key: 'city', label: 'City' }, { key: 'pincode', label: 'Pincode' },
            { key: 'items', label: 'Items' }, { key: 'box', label: 'Packaging' }, { key: 'weight', label: 'Weight g' },
            { key: 'ordered', label: 'Ordered' }, { key: 'manifested', label: 'Manifested' }, { key: 'picked', label: 'Picked up' },
            { key: 'delivered', label: 'Delivered' }, { key: 'source', label: 'Made in' },
            { key: 'replaces', label: 'Replaces AWB' }, { key: 'replaced_by', label: 'Replaced by AWB' }]);
    } catch (err) { fail(res, err, 'export shipments'); }
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

/** POST /manual — a shipment typed in: a replacement, a marketing parcel, a support re-send. */
router.post('/manual', manage, async (req, res) => {
    try { res.json(await shipping.createManual(req.body || {}, { actor: me(req) })); }
    catch (err) { fail(res, err, 'create the shipment'); }
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
