/**
 * The packing bench: confirming an order packed, and the dispatch log that comes out of it.
 *
 * What is recorded is a SNAPSHOT of the parcel as it left — the courier's AWB, who it went to,
 * what was in it — rather than a pointer to the order. Three reasons, all of which have bitten
 * this app before: an order can be edited afterwards, a customer's address changes, and Shopify
 * stops serving order data older than sixty days. A dispatch record has to outlive all three.
 *
 * The AWB is not typed. By the time a parcel is packed the order has been fulfilled in Shopify and
 * the courier has assigned a tracking number, so it is read straight off the fulfilment. When it
 * is not there yet — packing ahead of fulfilment — the row is still written and the AWB can be
 * filled in afterwards, because refusing to record a parcel that physically exists would be worse
 * than recording it without a number.
 */

const express = require('express');
const db = require('../db/connection');
const { hasPermission } = require('../utils/permissions');
const { tableParams, pagination } = require('../utils/table');

const router = express.Router();

const PACKED_SORTS = {
    order_number: 'order_number', awb: 'awb', customer_name: 'customer_name',
    total_price: 'total_price', packed_by: 'packed_by', packed_at: 'packed_at',
};

/** Same right as the scanner itself — the bench that scans is the bench that packs. */
const canScan = async (req, res, next) => {
    try {
        if (!await hasPermission(req, 'can_scan_orders')) return res.status(403).json({ error: 'Access denied' });
        next();
    } catch (err) { next(err); }
};
router.use(canScan);

const trim = (v) => { const t = String(v ?? '').trim(); return t || null; };
const safeJson = (v, fallback) => { try { return typeof v === 'string' ? (JSON.parse(v || 'null') ?? fallback) : (v || fallback); } catch { return fallback; } };

/** "#11553" and "11553" are the same label; orders are stored with the hash. */
const orderKey = (v) => {
    const raw = String(v ?? '').trim();
    const digits = raw.match(/\d{3,}/);
    return digits ? `#${digits[0]}` : raw;
};

/** The numeric id inside "gid://shopify/Order/123", for the REST call. */
const restId = (gid) => (String(gid || '').match(/(\d+)\s*$/) || [])[1] || null;

/**
 * What Shopify knows that we don't hold locally: where the parcel is going, and the AWB the
 * courier put on it. Never allowed to fail the confirmation — a packer at the bench cannot do
 * anything about Shopify being slow, and the parcel is packed either way.
 */
async function shopifyDispatchDetails(shopifyOrderId) {
    const id = restId(shopifyOrderId);
    const domain = process.env.SHOPIFY_STORE_DOMAIN;
    const token = process.env.SHOPIFY_ACCESS_TOKEN;
    if (!id || !domain || !token) return {};
    try {
        const url = `https://${domain}/admin/api/2026-04/orders/${id}.json`
            + '?fields=id,name,phone,email,shipping_address,fulfillments,total_price';
        const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
        if (!res.ok) throw new Error(`Shopify order request failed (${res.status})`);
        const { order } = await res.json();
        if (!order) return {};
        const addr = order.shipping_address || {};
        // The latest fulfilment that actually carries a tracking number: a split or re-issued
        // shipment leaves the earlier one behind, and the live label is the last one made.
        const tracked = (order.fulfillments || [])
            .filter(f => f.status !== 'cancelled' && (f.tracking_number || (f.tracking_numbers || [])[0]))
            .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
            .pop();
        return {
            awb: trim(tracked?.tracking_number || (tracked?.tracking_numbers || [])[0]),
            courier: trim(tracked?.tracking_company),
            tracking_url: trim(tracked?.tracking_url || (tracked?.tracking_urls || [])[0]),
            customer_name: trim(addr.name || [addr.first_name, addr.last_name].filter(Boolean).join(' ')),
            customer_phone: trim(addr.phone || order.phone),
            customer_email: trim(order.email),
            ship_address: trim([addr.address1, addr.address2].filter(Boolean).join(', ')),
            ship_city: trim(addr.city),
            ship_state: trim(addr.province),
            ship_pincode: trim(addr.zip),
        };
    } catch (err) {
        console.error('packing: could not read the order from Shopify:', err.message);
        return {};
    }
}

/** The order as this database holds it, with its customer. */
async function localOrder(orderNumber) {
    const r = await db.query(
        `SELECT o.id, o.shopify_id, o.order_number, o.total_price, o.line_items_json,
                o.fulfillment_status, o.financial_status, o.cancelled_at,
                c.first_name, c.last_name, c.email AS customer_email, c.phone AS customer_phone
           FROM orders o
           LEFT JOIN customers c ON c.shopify_id = o.customer_shopify_id
          WHERE o.order_number = $1`, [orderNumber]);
    return r.rows[0] || null;
}

const hydrate = (row) => (row ? { ...row, items: safeJson(row.items_json, []) } : null);

/** One row of the dispatch log, by order number. Used by the scanner to say "already packed". */
async function packedRow(orderNumber) {
    const r = await db.query('SELECT * FROM packed_orders WHERE order_number = $1', [orderNumber]);
    return hydrate(r.rows[0]);
}

/**
 * POST /api/scanner/packed { order_number, awb?, note? }
 *
 * Confirm a parcel packed. Idempotent on the order number: scanning the same label twice is the
 * same parcel, so the second one reports what the first recorded rather than logging a dispatch
 * that never happened.
 */
router.post('/packed', async (req, res) => {
    try {
        const orderNumber = orderKey(req.body?.order_number);
        if (!orderNumber) return res.status(400).json({ error: 'Which order was packed?' });

        const existing = await packedRow(orderNumber);
        if (existing) return res.json({ packed: existing, already: true });

        const order = await localOrder(orderNumber);
        if (!order) return res.status(404).json({ error: `Order ${orderNumber} is not in the CRM yet — run a sync and scan it again.` });
        if (order.cancelled_at) return res.status(409).json({ error: `Order ${orderNumber} is cancelled — it should not be going out.` });

        const items = safeJson(order.line_items_json, []).map(it => ({
            title: it.title, variant: it.variant || null, quantity: Number(it.quantity) || 0,
            shopify_variant_id: it.shopify_variant_id || null,
        }));
        const fromShopify = await shopifyDispatchDetails(order.shopify_id);
        const localName = [order.first_name, order.last_name].filter(Boolean).join(' ');

        const r = await db.query(
            `INSERT INTO packed_orders
               (order_number, shopify_order_id, awb, courier, tracking_url, customer_name,
                customer_phone, customer_email, ship_address, ship_city, ship_state, ship_pincode,
                total_price, total_qty, items_json, note, packed_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
             ON CONFLICT (order_number) DO NOTHING
             RETURNING *`,
            [orderNumber, order.shopify_id,
                trim(req.body?.awb) || fromShopify.awb || null, fromShopify.courier || null, fromShopify.tracking_url || null,
                fromShopify.customer_name || trim(localName), fromShopify.customer_phone || trim(order.customer_phone),
                fromShopify.customer_email || trim(order.customer_email), fromShopify.ship_address || null,
                fromShopify.ship_city || null, fromShopify.ship_state || null, fromShopify.ship_pincode || null,
                order.total_price, items.reduce((n, it) => n + it.quantity, 0), JSON.stringify(items),
                trim(req.body?.note), req.user?.username || null]);

        // Lost the race with another bench scanning the same label — report theirs.
        if (!r.rows[0]) return res.json({ packed: await packedRow(orderNumber), already: true });

        console.log(`📦 ${orderNumber} packed by ${req.user?.username || 'unknown'}${r.rows[0].awb ? ` · AWB ${r.rows[0].awb}` : ' · no AWB yet'}`);
        res.status(201).json({ packed: hydrate(r.rows[0]), already: false });
    } catch (err) {
        console.error('packing confirm error:', err);
        res.status(500).json({ error: 'Failed to record this parcel' });
    }
});

/**
 * POST /api/scanner/packed/:id/awb { awb? }
 *
 * Fill in a missing tracking number — read from Shopify again, or typed in when the courier gave
 * one outside Shopify. Only ever fills a blank: an AWB already recorded is what was on the parcel.
 */
router.post('/packed/:id/awb', async (req, res) => {
    try {
        const row = (await db.query('SELECT * FROM packed_orders WHERE id = $1', [req.params.id])).rows[0];
        if (!row) return res.status(404).json({ error: 'That parcel is not in the log' });
        if (row.awb) return res.json({ packed: hydrate(row), unchanged: true });

        const typed = trim(req.body?.awb);
        const found = typed ? { awb: typed } : await shopifyDispatchDetails(row.shopify_order_id);
        if (!found.awb) return res.status(404).json({ error: 'Shopify still has no tracking number for this order' });

        const r = await db.query(
            `UPDATE packed_orders SET awb = $1, courier = COALESCE($2, courier),
                    tracking_url = COALESCE($3, tracking_url), updated_at = CURRENT_TIMESTAMP
              WHERE id = $4 RETURNING *`,
            [found.awb, found.courier || null, found.tracking_url || null, row.id]);
        res.json({ packed: hydrate(r.rows[0]) });
    } catch (err) {
        console.error('packing awb error:', err);
        res.status(500).json({ error: 'Failed to update the tracking number' });
    }
});

/** GET /api/scanner/packed — the dispatch log, newest first. */
router.get('/packed', async (req, res) => {
    try {
        const { search, from, to } = req.query;
        const t = tableParams(req.query, { sortable: PACKED_SORTS, defaultSort: 'packed_at' });
        const where = [];
        const vals = [];
        if (search) {
            vals.push(`%${String(search).trim().replace(/^#/, '')}%`);
            where.push(`(order_number ILIKE $${vals.length} OR awb ILIKE $${vals.length}
                         OR customer_name ILIKE $${vals.length} OR customer_phone ILIKE $${vals.length})`);
        }
        // Dates are the packer's day in IST, which is what the bench means by "today".
        if (from) { vals.push(from); where.push(`(packed_at AT TIME ZONE 'Asia/Kolkata')::date >= $${vals.length}`); }
        if (to) { vals.push(to); where.push(`(packed_at AT TIME ZONE 'Asia/Kolkata')::date <= $${vals.length}`); }
        const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';

        const rows = (await db.query(
            `SELECT * FROM packed_orders ${sql} ${t.orderBy} LIMIT ${t.limit} OFFSET ${t.offset}`, vals)).rows;
        const total = (await db.query(`SELECT COUNT(*)::int AS n FROM packed_orders ${sql}`, vals)).rows[0].n;
        const today = (await db.query(
            `SELECT COUNT(*)::int AS n FROM packed_orders
              WHERE (packed_at AT TIME ZONE 'Asia/Kolkata')::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date`)).rows[0].n;
        const missing = (await db.query('SELECT COUNT(*)::int AS n FROM packed_orders WHERE awb IS NULL')).rows[0].n;

        res.json({ packed: rows.map(hydrate), summary: { total, today, missing_awb: missing }, pagination: pagination(total, t) });
    } catch (err) {
        console.error('packing log error:', err);
        res.status(500).json({ error: 'Failed to load the dispatch log' });
    }
});

/**
 * DELETE /api/scanner/packed/:id — owner/admin only.
 * A parcel wrongly marked packed has to be removable, but not by the bench that marked it.
 */
router.delete('/packed/:id', async (req, res) => {
    if (req.user?.role !== 'owner' && req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Only an owner or admin can remove a dispatch record' });
    }
    try {
        const r = await db.query('DELETE FROM packed_orders WHERE id = $1 RETURNING order_number', [req.params.id]);
        if (!r.rows[0]) return res.status(404).json({ error: 'That parcel is not in the log' });
        console.log(`🗑️  packed record for ${r.rows[0].order_number} removed by ${req.user?.username}`);
        res.json({ success: true });
    } catch (err) {
        console.error('packing delete error:', err);
        res.status(500).json({ error: 'Failed to remove the record' });
    }
});

module.exports = router;
module.exports.packedRow = packedRow;
