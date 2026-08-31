const db = require('../db/connection');
const shopify = require('./shopify');

/**
 * Shopify's line items, with the product images we had already resolved carried across.
 *
 * Matched on variant id, since that is what an image belongs to. Returns the incoming payload
 * untouched when there is nothing stored to carry over.
 */
function mergeLineItems(incomingJson, storedJson) {
    if (!storedJson) return incomingJson;
    try {
        const incoming = JSON.parse(incomingJson || '[]');
        const stored = JSON.parse(storedJson || '[]');
        if (!Array.isArray(incoming) || !Array.isArray(stored)) return incomingJson;

        const images = new Map();
        for (const s of stored) {
            if (s?.shopify_variant_id && (s.image || (s.all_images || []).length)) {
                images.set(String(s.shopify_variant_id), { image: s.image, all_images: s.all_images || [] });
            }
        }
        if (!images.size) return incomingJson;

        return JSON.stringify(incoming.map(li => {
            const hit = images.get(String(li.shopify_variant_id));
            return hit ? { ...li, image: li.image || hit.image, all_images: (li.all_images || []).length ? li.all_images : hit.all_images } : li;
        }));
    } catch {
        // Unparseable either side — Shopify's copy is the one that matters.
        return incomingJson;
    }
}

/* ---------------------------------------------------------------------------------------------
 * How much of the customer list to ask for
 *
 * Customers are the expensive half of a sync by a wide margin — ~27,000 of them against ~2,600
 * orders — and almost none of them change between one cycle and the next. So the list is fetched
 * incrementally, from a watermark, and swept in full only occasionally.
 *
 * Two safeguards, because an incremental fetch is only as good as its watermark:
 *  - the window overlaps, so a customer updated in the seconds around a cycle boundary is asked
 *    for twice rather than missed once. The upsert makes a repeat free.
 *  - a full sweep runs daily regardless, which heals anything a filter ever failed to return.
 * ------------------------------------------------------------------------------------------- */
const CUSTOMER_MARK = 'customers_synced_through';
const CUSTOMER_SWEEP = 'customers_full_sweep_at';
const OVERLAP_MS = 10 * 60 * 1000;          // 10 minutes either side of the mark
const SWEEP_EVERY_MS = 24 * 60 * 60 * 1000; // a full pass once a day

async function readState(key) {
    try {
        const r = await db.query('SELECT value FROM sync_state WHERE key = $1', [key]);
        return r.rows[0]?.value || null;
    } catch { return null; }   // table not created yet — behave like a first run
}

async function writeState(key, value) {
    await db.query(
        `INSERT INTO sync_state (key, value, updated_at) VALUES ($1,$2,CURRENT_TIMESTAMP)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
        [key, value]);
}

/** The timestamp to fetch customers from, or null to fetch the lot. */
async function customerSince() {
    const mark = await readState(CUSTOMER_MARK);
    if (!mark) return null;                                   // never synced: take everything
    const sweptAt = await readState(CUSTOMER_SWEEP);
    if (!sweptAt || Date.now() - Date.parse(sweptAt) > SWEEP_EVERY_MS) return null;
    return new Date(Date.parse(mark) - OVERLAP_MS).toISOString();
}

/**
 * Full sync - orders every cycle, customers incrementally from a watermark
 */
async function syncAll() {
    const startedAt = new Date().toISOString();
    let totalSynced = 0;

    try {
        console.log('🔄 Starting full sync from Shopify...');

        // Sync Customers
        const since = await customerSince();
        // Stamped before the fetch, never after: anything changed while it runs must fall inside
        // the next window rather than in the gap between them.
        const customerCutoff = new Date().toISOString();
        console.log(since ? `📥 Fetching customers changed since ${since}...` : '📥 Fetching all customers (full sweep)...');
        const customers = await shopify.fetchAllCustomers(since);

        for (const item of customers) {
            await db.query(`
                INSERT INTO customers (shopify_id, email, first_name, last_name, phone, orders_count, total_spent, tags, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT(shopify_id) DO UPDATE SET
                    email = excluded.email,
                    first_name = excluded.first_name,
                    last_name = excluded.last_name,
                    phone = excluded.phone,
                    orders_count = excluded.orders_count,
                    total_spent = excluded.total_spent,
                    tags = excluded.tags,
                    updated_at = excluded.updated_at
            `, [
                item.shopify_id, item.email, item.first_name, item.last_name, item.phone,
                item.orders_count, item.total_spent, item.tags, item.updated_at
            ]);
        }

        // Only now, because a fetch that threw must not move the mark past what it never wrote.
        await writeState(CUSTOMER_MARK, customerCutoff);
        if (!since) await writeState(CUSTOMER_SWEEP, customerCutoff);

        console.log(`✅ Synced ${customers.length} customers${since ? ' (changed since the last cycle)' : ' — full sweep'}`);
        totalSynced += customers.length;

        // Sync Orders
        console.log('📥 Fetching orders...');
        const orders = await shopify.fetchAllOrders();

        // Line items are refreshed, not left frozen: a customer who changes size after ordering
        // must move the right blank in inventory. They can't simply be overwritten either —
        // Shopify's payload carries image: null, and the scanner caches product images into these
        // rows, so a blind refresh would wipe them and make the scanner re-fetch every time.
        // Merge instead: Shopify owns what was bought, we keep the images we resolved.
        const storedItems = new Map((await db.query(
            'SELECT shopify_id, line_items_json FROM orders WHERE shopify_id = ANY($1)',
            [orders.map(o => o.shopify_id)])).rows.map(r => [r.shopify_id, r.line_items_json]));

        for (const item of orders) {
            item.line_items_json = mergeLineItems(item.line_items_json, storedItems.get(item.shopify_id));
            await db.query(`
                INSERT INTO orders (shopify_id, order_number, customer_shopify_id, total_price, currency, financial_status, fulfillment_status, cancelled_at, line_items_json, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                ON CONFLICT(shopify_id) DO UPDATE SET
                    order_number = excluded.order_number,
                    customer_shopify_id = excluded.customer_shopify_id,
                    total_price = excluded.total_price,
                    currency = excluded.currency,
                    financial_status = excluded.financial_status,
                    fulfillment_status = excluded.fulfillment_status,
                    cancelled_at = excluded.cancelled_at,
                    line_items_json = excluded.line_items_json
            `, [
                item.shopify_id, item.order_number, item.customer_shopify_id, item.total_price, item.currency,
                item.financial_status, item.fulfillment_status, item.cancelled_at, item.line_items_json, item.created_at
            ]);
        }

        console.log(`✅ Synced ${orders.length} orders`);
        totalSynced += orders.length;

        // On hold is not in the REST payload, so it is asked for separately and stamped on the
        // rows. Never allowed to fail the sync: not knowing which orders are held is worse than a
        // stale flag, but neither is worth losing the orders themselves over.
        try {
            const held = await shopify.fetchOnHoldOrderNames();
            await db.query('UPDATE orders SET on_hold = (order_number = ANY($1))', [held]);
            if (held.length) console.log(`⏸  ${held.length} order(s) on hold`);
        } catch (e) {
            console.error('on-hold status skipped:', e.message);
        }

        // Draw the blanks these orders consume. Safe to run on every sync: each (order, variant)
        // owns one movement row, so re-importing the same order corrects it rather than deducting
        // again. Never allowed to fail the sync — stock is bookkeeping, orders are the record.
        try {
            const inventory = require('./inventory');
            const rows = orders.map(o => ({
                shopify_id: o.shopify_id, order_number: o.order_number,
                financial_status: o.financial_status, fulfillment_status: o.fulfillment_status,
                line_items_json: o.line_items_json,
            }));
            const applied = await inventory.applyOrders(rows);
            if (applied.changed) console.log(`📦 Inventory: ${applied.changed} stock movement(s) from ${applied.orders} order(s)`);
        } catch (e) {
            console.error('inventory update skipped:', e.message);
        }

        // Log sync
        await db.query(`
            INSERT INTO sync_logs (type, status, records_synced, started_at, completed_at)
            VALUES ('full', 'success', $1, $2, $3)
        `, [totalSynced, startedAt, new Date().toISOString()]);

        console.log(`🎉 Full sync complete! Total records: ${totalSynced}`);

        return { success: true, records_synced: totalSynced, customers: customers.length, orders: orders.length };
    } catch (error) {
        console.error('❌ Sync failed:', error.message);

        await db.query(`
            INSERT INTO sync_logs (type, status, records_synced, error_message, started_at, completed_at)
            VALUES ('full', 'error', $1, $2, $3, $4)
        `, [totalSynced, error.message, startedAt, new Date().toISOString()]);

        return { success: false, error: error.message };
    }
}

/**
 * Get last sync info
 */
function getLastSync() {
    return db.query('SELECT * FROM sync_logs ORDER BY id DESC LIMIT 1').then(res => res.rows[0] || null).catch(() => null);
}

module.exports = {
    mergeLineItems, syncAll, getLastSync,
    // Exported so the sync's own state can be inspected without running one.
    customerSince, readState, CUSTOMER_MARK, CUSTOMER_SWEEP };
