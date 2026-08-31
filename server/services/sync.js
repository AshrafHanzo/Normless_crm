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

/**
 * Full sync - fetches ALL customers and orders from Shopify
 */
async function syncAll() {
    const startedAt = new Date().toISOString();
    let totalSynced = 0;

    try {
        console.log('🔄 Starting full sync from Shopify...');

        // Sync Customers
        console.log('📥 Fetching customers...');
        const customers = await shopify.fetchAllCustomers();

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

        console.log(`✅ Synced ${customers.length} customers`);
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
    mergeLineItems, syncAll, getLastSync };
