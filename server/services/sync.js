const db = require('../db/connection');
const shopify = require('./shopify');

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

        for (const item of orders) {
            await db.query(`
                INSERT INTO orders (shopify_id, order_number, customer_shopify_id, total_price, currency, financial_status, fulfillment_status, line_items_json, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT(shopify_id) DO UPDATE SET
                    order_number = excluded.order_number,
                    customer_shopify_id = excluded.customer_shopify_id,
                    total_price = excluded.total_price,
                    currency = excluded.currency,
                    financial_status = excluded.financial_status,
                    fulfillment_status = excluded.fulfillment_status
            `, [
                item.shopify_id, item.order_number, item.customer_shopify_id, item.total_price, item.currency,
                item.financial_status, item.fulfillment_status, item.line_items_json, item.created_at
            ]);
        }

        console.log(`✅ Synced ${orders.length} orders`);
        totalSynced += orders.length;

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

module.exports = { syncAll, getLastSync };
