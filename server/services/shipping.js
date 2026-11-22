/**
 * Shipping with Delhivery from the CRM.
 *
 * Three jobs:
 *  - Ship: create Delhivery shipments for packed orders, fetch their labels, and mark the order
 *    fulfilled in Shopify with the AWB (which is what sends the customer the "shipped" WhatsApp).
 *  - Watch: pull tracking for every live waybill, and find the waybills made in the Delhivery
 *    portal by order number, so the CRM sees everything whichever way it was shipped.
 *  - Warn: an auto-cancelled shipment, or a parcel that has waited too long for pickup, reaches the
 *    CRM bell (and the ops WhatsApp number, when that is switched on) as soon as a sync finds it.
 *
 * Nothing here creates, cancels or books anything on its own except the daily pickup, and that
 * only when it is switched on in settings.
 */

const db = require('../db/connection');
const dlv = require('./delhivery');
const { DEFAULT_SETTINGS } = require('./shipping-schema');
const { notify } = require('./notify');

const trackingUrl = (awb) => `https://www.delhivery.com/track-v2/package/${encodeURIComponent(awb)}`;
const restId = (gid) => (String(gid || '').match(/(\d+)\s*$/) || [])[1] || null;
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const digits = (v) => String(v ?? '').replace(/\D/g, '');
// Delhivery's timestamps are Indian time with no zone on them ("2026-11-21T20:43:31").
const toDate = (v) => {
    if (!v) return null;
    const s = String(v);
    const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(' ', 'T')}+05:30`);
    return Number.isNaN(d.getTime()) ? null : d;
};
const FINAL = ['delivered', 'rto_returned', 'cancelled', 'lost', 'return_done', 'return_closed'];
// Return and exchange pickups from customers have buckets of their own, so they never count as
// shipments, failed deliveries or auto-cancels.
const RETURN_BUCKETS = ['return_pickup', 'return_transit', 'return_done', 'return_closed'];

/* ───────────────────────────── settings ───────────────────────────── */

async function getSettings() {
    const row = (await db.query('SELECT data FROM shipping_settings WHERE id = 1')).rows[0];
    const s = { ...DEFAULT_SETTINGS, ...(row?.data || {}) };
    s.return_address = { ...DEFAULT_SETTINGS.return_address, ...(s.return_address || {}) };
    // Boxes saved before packaging had a kind were the untouched first defaults.
    if (!Array.isArray(s.boxes) || !s.boxes.length || s.boxes.every(b => !b.kind)) s.boxes = DEFAULT_SETTINGS.boxes;
    if (!s.boxes.some(b => b.key === s.default_box)) s.default_box = s.boxes[0].key;
    if (!Array.isArray(s.pack_rules)) s.pack_rules = [];
    // The warehouse name as Delhivery has it: whatever recent shipments were picked up from.
    const seen = (await db.query(
        `SELECT pickup_location FROM shipments WHERE pickup_location IS NOT NULL AND created_at > NOW() - INTERVAL '60 days'
          GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1`)).rows[0];
    if (seen) { s.pickup_location = seen.pickup_location; s.pickup_location_from = 'delhivery'; }
    return s;
}

async function saveSettings(patch, by) {
    const cur = await getSettings();
    const next = { ...cur };
    const str = (v, n = 200) => clean(v).slice(0, n);
    if ('origin_pincode' in patch) next.origin_pincode = digits(patch.origin_pincode).slice(0, 6);
    if ('seller_name' in patch) next.seller_name = str(patch.seller_name, 120);
    if ('default_mode' in patch) next.default_mode = patch.default_mode === 'Express' ? 'Express' : 'Surface';
    if (patch.return_address) {
        const r = patch.return_address;
        next.return_address = { name: str(r.name, 120), address: str(r.address, 300), city: str(r.city, 80), state: str(r.state, 80), pincode: digits(r.pincode).slice(0, 6), phone: digits(r.phone).slice(-10) };
    }
    if (Array.isArray(patch.boxes) && patch.boxes.length) {
        next.boxes = patch.boxes.slice(0, 20).map((b, i) => ({
            key: clean(b.key) || `box${i + 1}`, name: str(b.name, 60) || `Packaging ${i + 1}`,
            kind: b.kind === 'polybag' ? 'polybag' : 'box',
            l: Math.max(1, Number(b.l) || 1), b: Math.max(1, Number(b.b) || 1), h: Math.max(1, Number(b.h) || 1),
            pack_g: Math.max(0, Math.round(Number(b.pack_g) || 0)),
            max_items: Math.max(1, Math.round(Number(b.max_items) || 1)),
        }));
    }
    if ('default_box' in patch) next.default_box = clean(patch.default_box);
    if (!next.boxes.some(b => b.key === next.default_box)) next.default_box = next.boxes[0].key;
    if ('default_item_g' in patch) next.default_item_g = Math.min(20000, Math.max(10, Math.round(Number(patch.default_item_g) || 300)));
    if (Array.isArray(patch.pack_rules)) {
        const keys = new Set(next.boxes.map(b => b.key));
        const seen = new Set();
        next.pack_rules = patch.pack_rules.slice(0, 300)
            .map(r => ({
                match: r.match === 'product' ? 'product' : 'type',
                value: clean(r.value).slice(0, 120), label: str(r.label, 160),
                box: keys.has(clean(r.box)) ? clean(r.box) : '',
                item_g: Number(r.item_g) > 0 ? Math.round(Number(r.item_g)) : null,
            }))
            .filter(r => r.value && (r.box || r.item_g) && !seen.has(`${r.match}:${r.value}`) && seen.add(`${r.match}:${r.value}`));
    }
    for (const k of ['shopify_fulfil', 'sync_enabled', 'auto_pickup', 'alert_whatsapp']) if (k in patch) next[k] = !!patch[k];
    if ('sync_days' in patch) next.sync_days = Math.min(90, Math.max(7, parseInt(patch.sync_days, 10) || 45));
    if ('alert_risk_days' in patch) next.alert_risk_days = Math.min(10, Math.max(1, parseInt(patch.alert_risk_days, 10) || 2));
    if ('pickup_time' in patch) next.pickup_time = /^\d{2}:\d{2}(:\d{2})?$/.test(patch.pickup_time) ? (patch.pickup_time.length === 5 ? `${patch.pickup_time}:00` : patch.pickup_time) : cur.pickup_time;
    if ('ops_phone' in patch) next.ops_phone = digits(patch.ops_phone).slice(-10);
    const { pickup_location_from: _from, ...stored } = next;
    await db.query('UPDATE shipping_settings SET data = $1, updated_by = $2, updated_at = CURRENT_TIMESTAMP WHERE id = 1', [JSON.stringify(stored), by || null]);
    return getSettings();
}

/* ───────────────────────────── jobs ───────────────────────────── */

async function startJob(kind, title, actor, total = 0) {
    return (await db.query(`INSERT INTO shipping_jobs (kind, title, actor, total) VALUES ($1,$2,$3,$4) RETURNING id`, [kind, title, actor || 'Automatic', total])).rows[0].id;
}

async function finishJob(id, { ok = 0, failed = 0, summary = '', errors = [] }) {
    const status = failed && !ok ? 'failed' : failed ? 'done_with_errors' : 'done';
    await db.query(`UPDATE shipping_jobs SET status = $2, ok = $3, failed = $4, summary = $5, errors = $6, finished_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [id, status, ok, failed, summary, JSON.stringify(errors)]);
}

/* ───────────────────────────── tracking → our buckets ───────────────────────────── */

/**
 * Where a parcel is, in the CRM's words. Delhivery's status type (UD/DL/RT/CN/PP/PU) and status
 * come first; the NSL code tells a failed delivery (EOD-…) from a parcel merely sitting at a hub.
 *
 * Delhivery does not document how an auto-cancel shows in tracking, so anything that says
 * "cancel" before pickup counts, except EOD-6O, which is the customer cancelling at the door — a
 * failed delivery, not a cancelled shipment.
 */
function bucketOf(st = {}, direction = 'forward') {
    const type = String(st.StatusType || '').toUpperCase();
    const s = String(st.Status || '').toLowerCase();
    const code = String(st.StatusCode || '').toUpperCase();
    const ins = String(st.Instructions || '');
    if (direction === 'return') {
        // A pickup from the customer: waiting to be collected (PP), on its way back (PU), back
        // with us (DL, "DTO"), or closed without a pickup (CN).
        if (type === 'DL') return 'return_done';
        if (type === 'CN' || /cancel|closed/.test(s)) return 'return_closed';
        if (type === 'PU') return 'return_transit';
        return 'return_pickup';
    }
    if (type === 'DL') return /rto|dto/.test(s) ? 'rto_returned' : 'delivered';
    if (type === 'CN' || /cancel/.test(s)) return 'cancelled';
    if (type === 'RT') return 'rto_transit';
    if (s === 'lost') return 'lost';
    if (s === 'manifested' || s === 'not picked' || s === 'open' || s === 'scheduled') {
        if (/cancel/i.test(ins) && code !== 'EOD-6O') return 'cancelled';
        return 'waiting_pickup';
    }
    if (s === 'dispatched') return 'out_for_delivery';
    if (s === 'pending' && /^EOD-/.test(code)) return 'ndr';
    return 'in_transit';
}

/** What a tracking answer says about one shipment, as columns. */
function fromTracking(S) {
    const st = S.Status || {};
    const scans = (S.Scans || []).map(x => x.ScanDetail || x).filter(Boolean);
    const c = S.Consignee || {};
    const attempts = scans.filter(x => String(x.Scan).toLowerCase() === 'dispatched' && String(x.ScanType).toUpperCase() === 'UD').length;
    // Delhivery's OrderType is "Pickup" for a return or exchange pickup; COD / Pre-paid otherwise.
    const direction = /pickup/i.test(S.OrderType || '') ? 'return' : 'forward';
    const bucket = bucketOf(st, direction);
    // PickUpDate is filled in at manifest time, picked up or not; the pickup scan is the truth.
    const pickScan = scans.find(x => String(x.StatusCode).toUpperCase() === 'X-PPOM' || /picked up/i.test(x.Instructions || ''))
        || scans.find(x => String(x.ScanType).toUpperCase() === 'UD' && String(x.Scan).toLowerCase() === 'in transit');
    return {
        awb: String(S.AWB || ''),
        delhivery_order: clean(S.ReferenceNo) || null,
        direction,
        bucket,
        status_type: st.StatusType || null,
        status: st.Status || null,
        status_code: st.StatusCode || null,
        instructions: st.Instructions || null,
        status_location: st.StatusLocation || null,
        status_at: toDate(st.StatusDateTime),
        scans: JSON.stringify(scans.slice(-60).map(x => ({ at: x.ScanDateTime, scan: x.Scan, type: x.ScanType, code: x.StatusCode, text: x.Instructions, place: x.ScannedLocation }))),
        payment_mode: direction === 'return' ? 'Return' : S.OrderType ? (/cod/i.test(S.OrderType) ? 'COD' : 'Prepaid') : null,
        cod_amount: Number(S.CODAmount) || 0,
        total_amount: Number(S.InvoiceAmount) || null,
        consignee_name: clean(c.Name) || null,
        consignee_city: clean(c.City) || null,
        consignee_state: clean(c.State) || null,
        consignee_pincode: c.PinCode ? String(c.PinCode) : null,
        destination: clean(S.Destination) || null,
        pickup_location: clean(S.PickupLocation) || null,
        manifested_at: toDate(scans[0]?.ScanDateTime),
        picked_up_at: toDate(pickScan?.ScanDateTime),
        expected_delivery: toDate(S.ExpectedDeliveryDate || S.PromisedDeliveryDate),
        delivered_at: bucket === 'delivered' ? toDate(S.DeliveryDate || st.StatusDateTime) : null,
        rto_started_at: toDate(S.RTOStartedDate),
        first_attempt_at: toDate(S.FirstAttemptDate),
        ndr_attempts: direction === 'return' ? 0 : attempts,
        ndr_reason: bucket === 'ndr' ? (st.Instructions || null) : null,
    };
}

/** Order number as the CRM stores it, from Delhivery's reference ("#13584-R1" → "#13584"). */
const orderOf = (ref) => {
    const r = clean(ref);
    if (!r) return null;
    const base = r.replace(/-R\d+$/i, '');
    return base.startsWith('#') ? base : `#${base}`;
};

/**
 * Write what tracking says onto the row. Returns { row, was } so callers can see what changed.
 * A shipment cancelled from the CRM stays cancelled however Delhivery describes it afterwards
 * (a cancel before pickup still tracks as "Manifested"), unless it moves on to a return or a
 * delivery.
 */
async function applyTracking(S, { createdVia = 'portal' } = {}) {
    const t = fromTracking(S);
    if (!t.awb) return null;
    const prev = (await db.query('SELECT * FROM shipments WHERE awb = $1', [t.awb])).rows[0];
    if (t.direction === 'forward' && prev?.cancel_kind === 'manual' && !['rto_transit', 'rto_returned', 'delivered'].includes(t.bucket)) t.bucket = 'cancelled';

    // Only a shipment to the customer can be auto-cancelled. A closed return pickup is not news,
    // and one marked before returns were told apart loses the mark.
    let cancelKind = t.direction === 'return' ? null : (prev?.cancel_kind || null);
    let cancelledAt = t.direction === 'return' ? null : (prev?.cancelled_at || null);
    if (t.bucket === 'cancelled' && !cancelKind) { cancelKind = 'auto'; cancelledAt = t.status_at || new Date(); }

    const cols = ['direction', 'bucket', 'status_type', 'status', 'status_code', 'instructions', 'status_location', 'status_at', 'scans',
        'consignee_name', 'consignee_city', 'consignee_state', 'consignee_pincode', 'destination', 'pickup_location',
        'manifested_at', 'picked_up_at', 'expected_delivery', 'delivered_at', 'rto_started_at', 'first_attempt_at', 'ndr_attempts', 'ndr_reason'];
    if (prev) {
        const sets = cols.map((c, i) => `${c} = COALESCE($${i + 2}, ${c})`);
        // The bucket, status and NDR reason are always today's answer, never yesterday's.
        sets[cols.indexOf('bucket')] = `bucket = $${cols.indexOf('bucket') + 2}`;
        sets[cols.indexOf('ndr_reason')] = `ndr_reason = $${cols.indexOf('ndr_reason') + 2}`;
        const vals = cols.map(c => t[c]);
        const r = await db.query(
            `UPDATE shipments SET ${sets.join(', ')},
                    cancel_kind = $${cols.length + 2}, cancelled_at = $${cols.length + 3},
                    payment_mode = CASE WHEN $${cols.length + 4} = 'Return' THEN 'Return' ELSE COALESCE(payment_mode, $${cols.length + 4}) END,
                    last_tracked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
              WHERE awb = $1 RETURNING *`,
            [t.awb, ...vals, cancelKind, cancelledAt, t.payment_mode]);
        return { row: r.rows[0], was: prev };
    }
    const orderNumber = orderOf(t.delhivery_order);
    const shop = orderNumber ? (await db.query('SELECT shopify_id FROM orders WHERE order_number = $1', [orderNumber])).rows[0] : null;
    const ins = ['awb', 'order_number', 'delhivery_order', 'shopify_order_id', 'created_via', ...cols, 'payment_mode', 'cod_amount', 'total_amount', 'cancel_kind', 'cancelled_at', 'last_tracked_at'];
    const vals = [t.awb, orderNumber, t.delhivery_order, shop?.shopify_id || null, createdVia, ...cols.map(c => t[c]), t.payment_mode, t.cod_amount, t.total_amount, cancelKind, cancelledAt, new Date()];
    const r = await db.query(
        `INSERT INTO shipments (${ins.join(', ')}) VALUES (${ins.map((_, i) => `$${i + 1}`).join(', ')})
         ON CONFLICT (awb) DO NOTHING RETURNING *`, vals);
    return { row: r.rows[0], was: null };
}

/* ───────────────────────────── alerts ───────────────────────────── */

async function shippingUsers() {
    const r = await db.query(`SELECT username FROM admin_users
                               WHERE COALESCE(is_active, true) = true
                                 AND (role IN ('owner','admin') OR COALESCE(can_view_shipping, false) = true)`);
    return r.rows.map(x => x.username);
}

/** The bell for everyone on Shipping, and the ops WhatsApp number when that is switched on. */
async function alert({ title, body, link = '/shipping', whatsapp }, settings) {
    await notify({ usernames: await shippingUsers(), kind: 'shipping', title, body, link, actor: 'Delhivery' });
    const s = settings || await getSettings();
    if (!s.alert_whatsapp || !s.ops_phone || !whatsapp) return null;
    try {
        const wa = require('./whatsapp');
        const waLine = require('./wa-line');
        await waLine.ready();
        await waLine.run('normless', () => wa.sendText(`91${s.ops_phone}`, whatsapp));
        return null;
    } catch (err) {
        // A text outside WhatsApp's 24-hour window is refused; the bell already has it.
        return `WhatsApp alert not sent: ${err.message}`;
    }
}

const listOrders = (rows, n = 3) => rows.slice(0, n).map(r => r.order_number || r.awb).join(', ') + (rows.length > n ? ` and ${rows.length - n} more` : '');

/* ───────────────────────────── sync ───────────────────────────── */

const lookedUp = new Map();     // order number → when we last asked Delhivery about it
let syncing = null;

/**
 * One pass: track every live waybill, look up recent orders not yet seen (shipped from the
 * portal), then raise alerts for new auto-cancels and parcels stuck waiting for pickup.
 */
async function sync({ actor } = {}) {
    if (syncing) return syncing;
    syncing = (async () => {
        const s = await getSettings();
        const jobId = await startJob('sync', 'Tracking sync', actor);
        const errors = [];
        let checked = 0, moved = 0, found = 0;
        const newlyCancelled = [];
        try {
            // 1. Every waybill still on its way, plus cancelled ones nobody has dealt with (an
            //    auto-cancel can be undone on Delhivery's side).
            const live = (await db.query(
                `SELECT awb FROM shipments WHERE bucket <> ALL($1) OR last_tracked_at IS NULL OR direction IS NULL
                    OR (bucket = 'cancelled' AND cancel_kind = 'auto' AND cancel_handled IS NULL)`, [FINAL])).rows.map(r => r.awb);
            for (const S of await dlv.track(live)) {
                const r = await applyTracking(S);
                if (!r) continue;
                checked++;
                if (r.was && r.was.bucket !== r.row.bucket) moved++;
                if (r.row.bucket === 'cancelled' && r.row.cancel_kind === 'auto' && r.was?.bucket !== 'cancelled') newlyCancelled.push(r.row);
            }

            // 2. Orders from the last few weeks that we hold no shipment for: shipped from the
            //    portal or its Shopify channel. Each asked about at most every six hours.
            const recent = (await db.query(
                `SELECT o.order_number FROM orders o
                  WHERE o.created_at > NOW() - ($1 || ' days')::interval
                    AND o.cancelled_at IS NULL
                    AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.order_number = o.order_number)
                  ORDER BY o.created_at DESC LIMIT 1500`, [String(s.sync_days)])).rows.map(r => r.order_number);
            const due = recent.filter(n => !lookedUp.has(n) || Date.now() - lookedUp.get(n) > 6 * 3600 * 1000);
            for (const S of await dlv.trackByOrder(due)) {
                const r = await applyTracking(S, { createdVia: 'portal' });
                if (r?.row && !r.was) {
                    found++;
                    // Found already cancelled: only news if it happened in the last two days.
                    if (r.row.bucket === 'cancelled' && r.row.cancel_kind === 'auto'
                        && r.row.status_at && Date.now() - new Date(r.row.status_at) < 2 * 86400000) newlyCancelled.push(r.row);
                }
            }
            for (const n of due) lookedUp.set(n, Date.now());

            // 3. Alerts.
            if (newlyCancelled.length) {
                const n = newlyCancelled.length;
                const e = await alert({
                    title: `${n} shipment${n > 1 ? 's' : ''} auto-cancelled by Delhivery`,
                    body: `${listOrders(newlyCancelled)}. Re-create ${n > 1 ? 'them' : 'it'} to get a new AWB.`,
                    link: '/shipping?tab=cancelled',
                    whatsapp: `Delhivery auto-cancelled ${n} shipment${n > 1 ? 's' : ''}: ${listOrders(newlyCancelled, 8)}. Re-create in the CRM under Shipping > Auto-cancelled.`,
                }, s);
                if (e) errors.push({ error: e });
            }
            const atRisk = (await db.query(
                `UPDATE shipments SET at_risk_alerted_at = CURRENT_TIMESTAMP
                  WHERE bucket = 'waiting_pickup' AND at_risk_alerted_at IS NULL
                    AND COALESCE(manifested_at, created_at) < NOW() - ($1 || ' days')::interval
                    AND COALESCE(pickup_location, $2) = $2
                RETURNING order_number, awb`, [String(s.alert_risk_days), s.pickup_location])).rows;
            if (atRisk.length) {
                const n = atRisk.length;
                const e = await alert({
                    title: `${n} parcel${n > 1 ? 's' : ''} waiting for pickup over ${s.alert_risk_days} days`,
                    body: `${listOrders(atRisk)}. Delhivery may auto-cancel these. Check they are packed and labelled for the next pickup.`,
                    link: '/shipping?tab=pickups',
                    whatsapp: `${n} parcel${n > 1 ? 's have' : ' has'} waited over ${s.alert_risk_days} days for Delhivery pickup (${listOrders(atRisk, 8)}). They may be auto-cancelled.`,
                }, s);
                if (e) errors.push({ error: e });
            }

            const parts = [`${checked} checked`, `${moved} moved`];
            if (found) parts.push(`${found} found from the portal`);
            if (newlyCancelled.length) parts.push(`${newlyCancelled.length} auto-cancelled`);
            if (atRisk.length) parts.push(`${atRisk.length} waiting too long`);
            await finishJob(jobId, { ok: checked + found, failed: errors.length, summary: parts.join(' · '), errors });
            return { checked, moved, found, cancelled: newlyCancelled.length, at_risk: atRisk.length };
        } catch (err) {
            await finishJob(jobId, { failed: 1, summary: err.message, errors: [{ error: err.message }] });
            throw err;
        }
    })().finally(() => { syncing = null; });
    return syncing;
}

/* ───────────────────────────── Shopify ───────────────────────────── */

async function shopifyOrder(shopifyId) {
    const id = restId(shopifyId);
    if (!id) throw new Error('This order has no Shopify id');
    const url = `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2026-04/orders/${id}.json`
        + '?fields=id,name,phone,email,created_at,shipping_address,billing_address,line_items,total_price,current_total_price,total_outstanding,financial_status,payment_gateway_names,fulfillments,tags,cancelled_at';
    let res;
    try {
        res = await fetch(url, { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN } });
    } catch (err) {
        throw new Error(`Couldn't reach Shopify to read the address (${err.message})`);
    }
    if (res.status === 404) throw new Error('Shopify no longer returns this order (older than 60 days?)');
    if (!res.ok) throw new Error(`Shopify order request failed (${res.status})`);
    return (await res.json()).order;
}

async function shopifyGql(query, variables) {
    let res;
    try {
        res = await fetch(`https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2026-04/graphql.json`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN },
            body: JSON.stringify({ query, variables }),
        });
    } catch (err) {
        throw new Error(`Couldn't reach Shopify (${err.message})`);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.errors) {
        const msg = JSON.stringify(json.errors || json).slice(0, 300);
        if (/access|scope|denied|permission/i.test(msg)) throw new Error('The CRM\'s Shopify app cannot fulfil orders yet: it needs the write_merchant_managed_fulfillment_orders and write_fulfillments scopes');
        throw new Error(`Shopify: ${msg}`);
    }
    return json.data;
}

/**
 * Mark the order fulfilled with this AWB, or — when it already has a fulfilment carrying
 * `replacingAwb` — swap the tracking number on that fulfilment.
 */
async function shopifyFulfil(shopifyId, awb, { replacingAwb } = {}) {
    const gid = `gid://shopify/Order/${restId(shopifyId)}`;
    const tracking = { company: 'Delhivery', number: String(awb), url: trackingUrl(awb) };
    const d = await shopifyGql(`query($id: ID!) { order(id: $id) {
        fulfillments(first: 20) { id status trackingInfo { number } }
        fulfillmentOrders(first: 20) { nodes { id status } } } }`, { id: gid });
    const order = d?.order;
    if (!order) throw new Error('Order not found in Shopify');
    const existing = (order.fulfillments || []).find(f => f.status !== 'CANCELLED'
        && (f.trackingInfo || []).some(t => replacingAwb && t.number === String(replacingAwb)));
    if (existing) {
        const r = await shopifyGql(`mutation($id: ID!, $t: FulfillmentTrackingInput!) {
            fulfillmentTrackingInfoUpdate(fulfillmentId: $id, trackingInfoInput: $t, notifyCustomer: false) { userErrors { message } } }`,
        { id: existing.id, t: tracking });
        const ue = r?.fulfillmentTrackingInfoUpdate?.userErrors || [];
        if (ue.length) throw new Error(ue.map(e => e.message).join('; '));
        return 'updated';
    }
    const open = (order.fulfillmentOrders?.nodes || []).filter(f => ['OPEN', 'IN_PROGRESS', 'SCHEDULED'].includes(f.status));
    if (!open.length) {
        if ((order.fulfillments || []).some(f => f.status !== 'CANCELLED')) return 'already_fulfilled';
        throw new Error('Nothing left to fulfil on this order in Shopify');
    }
    const r = await shopifyGql(`mutation($f: FulfillmentInput!) {
        fulfillmentCreate(fulfillment: $f) { fulfillment { id } userErrors { message } } }`,
    { f: { lineItemsByFulfillmentOrder: open.map(f => ({ fulfillmentOrderId: f.id })), notifyCustomer: false, trackingInfo: tracking } });
    const ue = r?.fulfillmentCreate?.userErrors || [];
    if (ue.length) throw new Error(ue.map(e => e.message).join('; '));
    return 'created';
}

/* ───────────────────────────── building a shipment ───────────────────────────── */

/** What the CRM would send for an order, before anyone has chosen a box. */
function orderFacts(o) {
    const a = o.shipping_address || o.billing_address || {};
    const items = (o.line_items || []).filter(li => (li.current_quantity ?? li.quantity) > 0);
    const qty = items.reduce((n, li) => n + (li.current_quantity ?? li.quantity), 0);
    const gateways = (o.payment_gateway_names || []).join(' ').toLowerCase();
    const outstanding = Number(o.total_outstanding) || 0;
    const isCod = outstanding > 0 || /cod|cash on delivery/.test(gateways) || o.financial_status === 'pending';
    const phone = digits(a.phone || o.phone).slice(-10);
    return {
        name: clean(a.name || [a.first_name, a.last_name].filter(Boolean).join(' ')),
        add: clean([a.address1, a.address2].filter(Boolean).join(', ')),
        city: clean(a.city), state: clean(a.province), pin: digits(a.zip).slice(0, 6),
        phone,
        payment_mode: isCod ? 'COD' : 'Prepaid',
        cod_amount: isCod ? (outstanding || Number(o.current_total_price ?? o.total_price) || 0) : 0,
        total_amount: Number(o.current_total_price ?? o.total_price) || 0,
        products_desc: items.map(li => `${li.title}${li.variant_title ? ` - ${li.variant_title}` : ''} x${li.current_quantity ?? li.quantity}`).join(', ').slice(0, 480),
        quantity: qty || 1,
        lines: items.map(li => ({ product_id: li.product_id ? String(li.product_id) : null, title: li.title, qty: li.current_quantity ?? li.quantity, grams: Number(li.grams) || 0 })),
        tags: o.tags || '',
    };
}

function problemsOf(f) {
    const p = [];
    if (!f.name) p.push('name missing');
    if (!f.add || f.add.length < 8) p.push('address missing or too short');
    if (!/^[1-9]\d{5}$/.test(f.pin)) p.push(`pincode "${f.pin || '—'}" isn't valid`);
    if (!/^[6-9]\d{9}$/.test(f.phone)) p.push(`phone "${f.phone || '—'}" isn't a valid mobile`);
    return p;
}

/* ───────────────────────────── packing ───────────────────────────── */

const DAY = 86400000;
const typeCache = new Map();        // product id → { type, at }
let catalogCache = null;            // { at, products }

/** Shopify product types for these product ids, from a day-long cache. */
async function productTypes(ids) {
    const want = [...new Set(ids.filter(Boolean).map(String))];
    const missing = want.filter(id => !typeCache.has(id) || Date.now() - typeCache.get(id).at > DAY);
    for (let i = 0; i < missing.length; i += 100) {
        const group = missing.slice(i, i + 100);
        try {
            const d = await shopifyGql(`query($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id productType } } }`,
                { ids: group.map(id => `gid://shopify/Product/${id}`) });
            for (const n of d?.nodes || []) if (n?.id) typeCache.set(restId(n.id), { type: n.productType || '', at: Date.now() });
        } catch { /* type rules just won't match; product rules and the default still apply */ }
    }
    return new Map(want.map(id => [id, typeCache.get(id)?.type || '']));
}

/** Every product and product type in Shopify, for the packing rules in settings. */
async function catalog({ fresh = false } = {}) {
    if (!fresh && catalogCache && Date.now() - catalogCache.at < 10 * 60000) return catalogCache;
    const products = [];
    let after = null;
    for (let page = 0; page < 20; page++) {
        const d = await shopifyGql(`query($after: String) { products(first: 250, after: $after, sortKey: TITLE) {
            nodes { id title productType status } pageInfo { hasNextPage endCursor } } }`, { after });
        for (const n of d.products.nodes) {
            const id = restId(n.id);
            products.push({ id, title: n.title, type: n.productType || '', status: n.status });
            typeCache.set(id, { type: n.productType || '', at: Date.now() });
        }
        if (!d.products.pageInfo.hasNextPage) break;
        after = d.products.pageInfo.endCursor;
    }
    const types = [...new Set(products.map(p => p.type).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    catalogCache = { at: Date.now(), products, types };
    return catalogCache;
}

const volume = (b) => (Number(b.l) || 0) * (Number(b.b) || 0) * (Number(b.h) || 0);
// A box always outranks a polybag; within a kind, the bigger one wins.
const rank = (b) => (b.kind === 'box' ? 1e9 : 0) + volume(b);

/**
 * The packaging and weight an order needs, from the packing rules. Each piece gets the packaging
 * its product (or else its product type) asks for, or the default. The order goes in the biggest
 * of those; if there are more pieces than that holds, the next size up that holds them all.
 * Weight is the empty packaging plus every piece (rule weight, else Shopify's, else the default).
 */
async function packFor(facts, s) {
    const lines = facts.lines || [];
    const types = await productTypes(lines.map(l => l.product_id));
    const byKey = new Map(s.boxes.map(b => [b.key, b]));
    const fallback = byKey.get(s.default_box) || s.boxes[0];
    let need = null, needFor = null, itemsG = 0, pieces = 0;
    for (const l of lines) {
        const type = (types.get(l.product_id) || '').toLowerCase();
        const rule = s.pack_rules.find(r => r.match === 'product' && r.value === l.product_id)
            || s.pack_rules.find(r => r.match === 'type' && type && r.value.toLowerCase() === type);
        const box = (rule?.box && byKey.get(rule.box)) || fallback;
        const qty = Number(l.qty) || 1;
        pieces += qty;
        itemsG += (rule?.item_g || l.grams || s.default_item_g) * qty;
        if (!need || rank(box) > rank(need)) { need = box; needFor = rule?.box ? l.title : null; }
    }
    if (!need) need = fallback;
    const why = [];
    if (needFor) why.push(`${needFor} goes in a ${need.name.toLowerCase()}`);
    let box = need;
    if (pieces > (Number(need.max_items) || 1)) {
        const bigger = s.boxes.filter(b => rank(b) >= rank(need) && (Number(b.max_items) || 1) >= pieces).sort((a, b) => rank(a) - rank(b))[0]
            || [...s.boxes].sort((a, b) => (Number(b.max_items) || 1) - (Number(a.max_items) || 1))[0];
        if (bigger && bigger.key !== need.key) why.push(`${pieces} pieces don't fit a ${need.name.toLowerCase()}`);
        box = bigger || need;
    }
    if (!why.length) why.push(lines.length ? 'default packaging' : 'no items found');
    const weight = Math.max(50, Math.round((Number(box.pack_g) || 0) + itemsG));
    return { box: box.key, weight_g: weight, items_g: Math.round(itemsG), pieces, why: why.join('; ') };
}

/** The Delhivery payload for one order, with whatever the packer chose on top. */
function payloadFor(facts, choice, s, delhiveryOrder, pack) {
    const box = s.boxes.find(b => b.key === choice.box) || s.boxes.find(b => b.key === pack?.box) || s.boxes[0];
    const grams = Math.round(Number(choice.weight_g) || ((Number(box.pack_g) || 0) + (pack?.items_g ?? s.default_item_g)));
    const mode = choice.payment_mode === 'Prepaid' || choice.payment_mode === 'COD' ? choice.payment_mode : facts.payment_mode;
    const cod = mode === 'COD' ? Number(choice.cod_amount ?? facts.cod_amount) || 0 : 0;
    const r = s.return_address || {};
    return {
        box, grams, mode, cod,
        payload: {
            name: facts.name, add: facts.add, pin: facts.pin, city: facts.city, state: facts.state, country: 'India',
            phone: facts.phone, order: delhiveryOrder, payment_mode: mode,
            cod_amount: mode === 'COD' ? String(cod) : '', total_amount: String(facts.total_amount),
            products_desc: facts.products_desc, quantity: String(facts.quantity), hsn_code: '',
            weight: String(grams),
            shipment_length: String(Number(choice.length_cm) || box.l),
            shipment_width: String(Number(choice.width_cm) || box.b),
            shipment_height: String(Number(choice.height_cm) || box.h),
            shipping_mode: choice.shipping_mode === 'Express' ? 'Express' : (s.default_mode || 'Surface'),
            seller_name: s.seller_name || 'Normless', seller_add: r.address || '', seller_inv: '',
            return_name: r.name || '', return_add: r.address || '', return_city: r.city || '', return_state: r.state || '',
            return_pin: r.pincode || '', return_phone: r.phone || '', return_country: r.address ? 'India' : '',
            waybill: '', order_date: null, address_type: '',
        },
    };
}

/** Preview for the drawer: the order's facts, problems, serviceability and charge. */
async function quote(orderNumber, choice = {}) {
    const s = await getSettings();
    const o = (await db.query('SELECT shopify_id FROM orders WHERE order_number = $1', [orderNumber])).rows[0];
    if (!o) throw Object.assign(new Error(`Order ${orderNumber} isn't in the CRM`), { status: 404 });
    const facts = orderFacts(await shopifyOrder(o.shopify_id));
    const pack = await packFor(facts, s);
    const { grams, mode, cod, box } = payloadFor(facts, choice, s, orderNumber, pack);
    const out = { order_number: orderNumber, facts, problems: problemsOf(facts), suggested: pack, box: box.key, weight_g: grams, payment_mode: mode, cod_amount: cod };
    // Delhivery may already have an AWB for it from the portal that the sync hasn't seen yet.
    try { await refreshFromDelhivery([orderNumber]); } catch (e) { out.check_error = `Couldn't check Delhivery for an existing AWB (${e.message})`; }
    try { out.pincode = /^\d{6}$/.test(facts.pin) ? await dlv.pincode(facts.pin) : null; } catch (e) { out.pincode_error = e.message; }
    if (out.pincode?.serviceable && mode === 'COD' && !out.pincode.cod) out.problems.push('Delhivery has no COD at this pincode');
    if (out.pincode && !out.pincode.serviceable) out.problems.push('Delhivery doesn\'t deliver to this pincode');
    if (s.origin_pincode && /^\d{6}$/.test(facts.pin)) {
        try {
            out.charge = await dlv.charges({ originPin: s.origin_pincode, destPin: facts.pin, grams, mode: choice.shipping_mode === 'Express' ? 'E' : 'S', paymentType: mode === 'COD' ? 'COD' : 'Pre-paid', cod });
        } catch (e) { out.charge_error = e.message; }
    }
    const active = await activeAwb(orderNumber);
    if (active) out.problems.push(alreadyHas(active));
    return out;
}

/** A live AWB to the customer for this order, if there is one (other than `exceptId`). */
async function activeAwb(orderNumber, exceptId = null) {
    return (await db.query(
        `SELECT awb, created_via FROM shipments
          WHERE order_number = $1 AND bucket <> 'cancelled' AND COALESCE(direction, 'forward') = 'forward'
            AND ($2::int IS NULL OR id <> $2) ORDER BY id DESC LIMIT 1`, [orderNumber, exceptId])).rows[0] || null;
}
const alreadyHas = (a) => `already has AWB ${a.awb}${a.created_via === 'portal' ? ' (made in the Delhivery portal)' : ''}`;

/**
 * Ask Delhivery what it holds for these orders right now and record it. While the portal is
 * still in use, an order can be manifested there minutes before someone ships it here; the
 * 30-minute sync would be too late to stop a second AWB.
 */
async function refreshFromDelhivery(orderNumbers) {
    const list = [...new Set(orderNumbers.map(clean).filter(Boolean))];
    if (!list.length) return;
    for (const S of await dlv.trackByOrder(list)) await applyTracking(S, { createdVia: 'portal' });
    for (const n of list) lookedUp.set(n, Date.now());
}

/**
 * Create shipments. `items` = [{ order_number, box, weight_g, payment_mode, cod_amount,
 * shipping_mode, length_cm…, recreate_of }]. Every order is checked first; the ones that pass go
 * to Delhivery in one call. Labels are fetched straight after, and Shopify is told last.
 */
async function createMany(items, { actor, kind = 'create' } = {}) {
    const s = await getSettings();
    if (!s.pickup_location) throw Object.assign(new Error('Set the pickup location in Shipping settings first'), { status: 400 });
    const jobId = await startJob(kind, kind === 'recreate' ? `Re-create auto-cancelled · ${items.length}` : `Get AWB · ${items.length} order${items.length > 1 ? 's' : ''}`, actor, items.length);
    const errors = [];
    const ready = [];
    try {
        await refreshFromDelhivery(items.map(it => it.order_number));
    } catch (err) {
        const msg = `Couldn't check Delhivery for existing AWBs (${err.message}). Nothing was created, to avoid duplicates.`;
        await finishJob(jobId, { failed: items.length, summary: msg, errors: [{ error: msg }] });
        throw Object.assign(new Error(msg), { status: 502 });
    }

    for (const it of items) {
        const orderNumber = clean(it.order_number);
        try {
            const o = (await db.query('SELECT shopify_id, cancelled_at FROM orders WHERE order_number = $1', [orderNumber])).rows[0];
            if (!o) throw new Error('order isn\'t in the CRM');
            if (o.cancelled_at) throw new Error('order is cancelled in Shopify');
            const old = it.recreate_of ? (await db.query('SELECT * FROM shipments WHERE id = $1', [it.recreate_of])).rows[0] : null;
            const active = await activeAwb(orderNumber, old?.id || null);
            if (active) throw new Error(alreadyHas(active));
            const so = await shopifyOrder(o.shopify_id);
            if (so.cancelled_at) throw new Error('order is cancelled in Shopify');
            const facts = orderFacts(so);
            const probs = problemsOf(facts);
            if (probs.length) throw new Error(probs.join('; '));
            // Delhivery refuses an order id it has seen, so a re-create gets "-R1", "-R2"…
            const earlier = (await db.query('SELECT COUNT(*)::int AS n FROM shipments WHERE order_number = $1', [orderNumber])).rows[0].n;
            const delhiveryOrder = earlier ? `${orderNumber}-R${earlier}` : orderNumber;
            const choice = old ? {
                box: it.box || old.box, weight_g: it.weight_g || old.weight_g, payment_mode: it.payment_mode || old.payment_mode,
                cod_amount: it.cod_amount ?? (old.payment_mode === 'COD' ? old.cod_amount : undefined), shipping_mode: it.shipping_mode || old.shipping_mode,
                length_cm: old.length_cm, width_cm: old.width_cm, height_cm: old.height_cm,
            } : it;
            const p = payloadFor(facts, choice, s, delhiveryOrder, await packFor(facts, s));
            ready.push({ orderNumber, delhiveryOrder, shopifyId: o.shopify_id, facts, old, ...p });
        } catch (err) {
            errors.push({ order_number: orderNumber, error: err.message });
        }
    }

    const created = [];
    for (let i = 0; i < ready.length; i += 25) {
        const group = ready.slice(i, i + 25);
        let res;
        try {
            res = await dlv.createShipments(group.map(g => g.payload), s.pickup_location);
        } catch (err) {
            for (const g of group) errors.push({ order_number: g.orderNumber, error: err.message });
            continue;
        }
        const packages = res?.packages || [];
        for (const g of group) {
            const pkg = packages.find(p => clean(p.refnum) === g.delhiveryOrder) || (group.length === 1 ? packages[0] : null);
            if (!pkg || !pkg.waybill || /fail/i.test(pkg.status || '')) {
                const why = pkg ? [].concat(pkg.remarks || []).join('; ') : (res?.rmk || 'Delhivery returned no waybill');
                errors.push({ order_number: g.orderNumber, error: why || 'Delhivery returned no waybill' });
                continue;
            }
            const awb = String(pkg.waybill);
            const row = (await db.query(
                `INSERT INTO shipments (awb, order_number, delhivery_order, shopify_order_id, created_via, bucket, status_type, status,
                        payment_mode, cod_amount, total_amount, box, weight_g, length_cm, width_cm, height_cm, shipping_mode, products_desc,
                        consignee_name, consignee_city, consignee_state, consignee_pincode, pickup_location, manifested_at, recreated_from, created_by)
                 VALUES ($1,$2,$3,$4,'crm','waiting_pickup','UD','Manifested',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,CURRENT_TIMESTAMP,$20,$21)
                 ON CONFLICT (awb) DO NOTHING RETURNING *`,
                [awb, g.orderNumber, g.delhiveryOrder, g.shopifyId, g.mode, g.cod, g.facts.total_amount, g.box.key, g.grams,
                    g.payload.shipment_length, g.payload.shipment_width, g.payload.shipment_height, g.payload.shipping_mode, g.facts.products_desc,
                    g.facts.name, g.facts.city, g.facts.state, g.facts.pin, s.pickup_location, g.old?.awb || null, actor || null])).rows[0];
            if (g.old) {
                await db.query(`UPDATE shipments SET cancel_handled = 'recreated', cancel_handled_by = $2, cancel_handled_at = CURRENT_TIMESTAMP,
                                       recreated_as = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [g.old.id, actor || null, awb]);
            }
            created.push({ ...g, awb, row });
        }
    }

    // Labels, then Shopify. Neither can undo a shipment that now exists, so their failures are
    // recorded against it rather than counted as the shipment failing.
    let labelLinks = [];
    if (created.length) {
        try {
            labelLinks = await dlv.labels(created.map(c => c.awb), '4R');
            for (const l of labelLinks) {
                if (!l.url) continue;
                await db.query(`UPDATE shipments SET label_url = $2 WHERE awb = ANY($1)`, [String(l.waybill).split(','), l.url]);
            }
        } catch (err) {
            errors.push({ error: `Labels not fetched: ${err.message}. Use Reprint label.`, soft: true });
        }
    }
    let shopifyNote = null;
    if (created.length && s.shopify_fulfil) {
        for (const c of created) {
            try {
                await shopifyFulfil(c.shopifyId, c.awb, { replacingAwb: c.old?.awb });
                await db.query('UPDATE shipments SET shopify_fulfilled = true, shopify_error = NULL WHERE awb = $1', [c.awb]);
            } catch (err) {
                await db.query('UPDATE shipments SET shopify_error = $2 WHERE awb = $1', [c.awb, err.message.slice(0, 300)]);
                shopifyNote = err.message;
            }
        }
    }

    const hard = errors.filter(e => !e.soft);
    const parts = [`${created.length} AWB${created.length === 1 ? '' : 's'} created`];
    if (labelLinks.length) parts.push('labels ready');
    if (shopifyNote) parts.push(`Shopify not updated: ${shopifyNote}`);
    else if (created.length && s.shopify_fulfil) parts.push('Shopify updated');
    if (hard.length) parts.push(`${hard.length} failed`);
    await finishJob(jobId, { ok: created.length, failed: hard.length, summary: parts.join(' · '), errors });
    return {
        job_id: jobId,
        created: created.map(c => ({ order_number: c.orderNumber, awb: c.awb, id: c.row?.id })),
        failed: hard,
        labels: labelLinks.filter(l => l.url),
        warnings: [...errors.filter(e => e.soft).map(e => e.error), ...(shopifyNote ? [`Shopify not updated: ${shopifyNote}`] : [])],
    };
}

/** Re-create auto-cancelled shipments: same order, same box and payment, a new AWB. */
async function recreate(ids, opts = {}, { actor } = {}) {
    const rows = (await db.query(`SELECT * FROM shipments WHERE id = ANY($1) AND bucket = 'cancelled' AND cancel_handled IS NULL`, [ids])).rows;
    if (!rows.length) throw Object.assign(new Error('None of those are waiting to be re-created'), { status: 400 });
    return createMany(rows.map(r => ({ order_number: r.order_number, recreate_of: r.id, box: opts.box })), { actor, kind: 'recreate' });
}

async function markNotShipping(ids, actor) {
    const r = await db.query(`UPDATE shipments SET cancel_handled = 'not_shipping', cancel_handled_by = $2, cancel_handled_at = CURRENT_TIMESTAMP
                               WHERE id = ANY($1) AND bucket = 'cancelled' AND cancel_handled IS NULL RETURNING id`, [ids, actor || null]);
    return r.rowCount;
}

async function cancelOne(id, actor) {
    const row = (await db.query('SELECT * FROM shipments WHERE id = $1', [id])).rows[0];
    if (!row) throw Object.assign(new Error('Shipment not found'), { status: 404 });
    if (!['waiting_pickup', 'in_transit', 'ndr'].includes(row.bucket)) throw Object.assign(new Error(`Can't cancel a shipment that is ${row.status || row.bucket}`), { status: 400 });
    const jobId = await startJob('cancel', `Cancel ${row.order_number || row.awb}`, actor, 1);
    try {
        await dlv.cancel(row.awb);
    } catch (err) {
        await finishJob(jobId, { failed: 1, summary: err.message, errors: [{ order_number: row.order_number, awb: row.awb, error: err.message }] });
        throw Object.assign(err, { status: 502 });
    }
    // Before pickup it becomes a cancelled shipment; after pickup Delhivery turns it into a return.
    const bucket = row.bucket === 'waiting_pickup' ? 'cancelled' : 'rto_transit';
    await db.query(`UPDATE shipments SET cancel_kind = 'manual', cancelled_at = CURRENT_TIMESTAMP, bucket = $2,
                           cancel_handled = CASE WHEN $2 = 'cancelled' THEN 'not_shipping' ELSE cancel_handled END,
                           cancel_handled_by = $3, cancel_handled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [id, bucket, actor || null]);
    await finishJob(jobId, { ok: 1, summary: bucket === 'cancelled' ? `AWB ${row.awb} cancelled` : `AWB ${row.awb} sent back to us` });
    return { bucket };
}

async function reattempt(ids, actor) {
    const rows = (await db.query(`SELECT * FROM shipments WHERE id = ANY($1) AND bucket = 'ndr'`, [ids])).rows;
    if (!rows.length) throw Object.assign(new Error('None of those are failed deliveries'), { status: 400 });
    const jobId = await startJob('ndr', `Re-attempt · ${rows.length}`, actor, rows.length);
    try {
        const r = await dlv.reattempt(rows.map(x => x.awb));
        const upl = r?.request_id || r?.upl || r?.UPL || null;
        await db.query(`UPDATE shipments SET ndr_action = 'RE-ATTEMPT', ndr_action_at = CURRENT_TIMESTAMP, ndr_action_by = $2, updated_at = CURRENT_TIMESTAMP WHERE id = ANY($1)`,
            [rows.map(x => x.id), actor || null]);
        await finishJob(jobId, { ok: rows.length, summary: `Re-attempt asked for ${rows.length}${upl ? ` · request ${upl}` : ''}` });
        return { requested: rows.length, request_id: upl };
    } catch (err) {
        await finishJob(jobId, { failed: rows.length, summary: err.message, errors: rows.map(x => ({ order_number: x.order_number, awb: x.awb, error: err.message })) });
        throw Object.assign(err, { status: 502 });
    }
}

async function editOne(id, fields, actor) {
    const row = (await db.query('SELECT * FROM shipments WHERE id = $1', [id])).rows[0];
    if (!row) throw Object.assign(new Error('Shipment not found'), { status: 404 });
    const body = {};
    if (fields.name) body.name = clean(fields.name).slice(0, 120);
    if (fields.phone) { const p = digits(fields.phone).slice(-10); if (!/^[6-9]\d{9}$/.test(p)) throw Object.assign(new Error('That phone number isn\'t a valid mobile'), { status: 400 }); body.phone = p; }
    if (fields.add) body.add = clean(fields.add).slice(0, 400);
    if (!Object.keys(body).length) throw Object.assign(new Error('Nothing to change'), { status: 400 });
    const jobId = await startJob('edit', `Edit ${row.order_number || row.awb}`, actor, 1);
    try {
        await dlv.edit(row.awb, body);
    } catch (err) {
        await finishJob(jobId, { failed: 1, summary: err.message, errors: [{ order_number: row.order_number, awb: row.awb, error: err.message }] });
        throw Object.assign(err, { status: 502 });
    }
    if (body.name) await db.query('UPDATE shipments SET consignee_name = $2 WHERE id = $1', [id, body.name]);
    await db.query(`UPDATE shipments SET ndr_action = 'EDITED', ndr_action_at = CURRENT_TIMESTAMP, ndr_action_by = $2 WHERE id = $1`, [id, actor || null]);
    await finishJob(jobId, { ok: 1, summary: `Updated ${Object.keys(body).join(', ')} on AWB ${row.awb}` });
    return { ok: true };
}

/** Book a pickup for everything at our location still waiting. */
async function bookPickup({ date, time, count } = {}, actor) {
    const s = await getSettings();
    const waiting = (await db.query(
        `SELECT awb FROM shipments WHERE bucket = 'waiting_pickup' AND COALESCE(pickup_location, $1) = $1`, [s.pickup_location])).rows.map(r => r.awb);
    const n = Math.max(1, parseInt(count, 10) || waiting.length || 1);
    const day = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
    const at = /^\d{2}:\d{2}(:\d{2})?$/.test(time || '') ? (time.length === 5 ? `${time}:00` : time) : s.pickup_time;
    const jobId = await startJob('pickup', `Pickup ${day} ${at.slice(0, 5)} · ${n} parcels`, actor, 1);
    let r;
    try {
        r = await dlv.requestPickup({ date: day, time: at, location: s.pickup_location, count: n });
    } catch (err) {
        await finishJob(jobId, { failed: 1, summary: err.message, errors: [{ error: err.message }] });
        throw Object.assign(err, { status: 502 });
    }
    const pickupId = String(r?.pickup_id || r?.pickupId || r?.id || '') || null;
    const row = (await db.query(
        `INSERT INTO shipping_pickups (pickup_id, pickup_date, pickup_time, location, expected_count, awbs, response, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [pickupId, day, at, s.pickup_location, n, waiting, JSON.stringify(r || {}), actor || null])).rows[0];
    await finishJob(jobId, { ok: 1, summary: `Pickup ${pickupId || '(no id returned)'} booked for ${day} ${at.slice(0, 5)}` });
    return row;
}

/* ───────────────────────────── worker ───────────────────────────── */

let timer = null;
function start() {
    if (timer) return;
    const tick = async () => {
        try {
            if (!dlv.configured()) return;
            const s = await getSettings();
            if (s.sync_enabled) await sync();
            if (s.auto_pickup) {
                const ist = new Date(Date.now() + 5.5 * 3600000);
                const today = ist.toISOString().slice(0, 10);
                const hour = ist.getUTCHours();
                const booked = (await db.query(`SELECT 1 FROM shipping_pickups WHERE pickup_date = $1`, [today])).rows[0];
                const waiting = (await db.query(`SELECT COUNT(*)::int AS n FROM shipments WHERE bucket = 'waiting_pickup' AND COALESCE(pickup_location, $1) = $1`, [s.pickup_location])).rows[0].n;
                if (!booked && waiting && hour >= 10 && hour < 16) await bookPickup({ date: today, count: waiting }, 'Automatic');
            }
        } catch (err) {
            console.error('shipping worker:', err.message);
        }
    };
    setTimeout(tick, 2 * 60 * 1000).unref();
    timer = setInterval(tick, 30 * 60 * 1000);
    timer.unref();
}

module.exports = {
    getSettings, saveSettings, sync, quote, createMany, catalog, packFor, RETURN_BUCKETS, recreate, markNotShipping, cancelOne, reattempt, editOne, bookPickup,
    labelsFor: (awbs) => dlv.labels(awbs, '4R'), bucketOf, fromTracking, trackingUrl, start,
};
