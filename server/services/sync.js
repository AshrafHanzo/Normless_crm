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

        const upsertCustomer = db.prepare(`
            INSERT INTO customers (shopify_id, email, first_name, last_name, phone, orders_count, total_spent, tags, updated_at)
            VALUES (@shopify_id, @email, @first_name, @last_name, @phone, @orders_count, @total_spent, @tags, @updated_at)
            ON CONFLICT(shopify_id) DO UPDATE SET
                email = excluded.email,
                first_name = excluded.first_name,
                last_name = excluded.last_name,
                phone = excluded.phone,
                orders_count = excluded.orders_count,
                total_spent = excluded.total_spent,
                tags = excluded.tags,
                updated_at = excluded.updated_at
        `);

        const insertManyCustomers = db.transaction((items) => {
            for (const item of items) {
                upsertCustomer.run(item);
            }
        });

        insertManyCustomers(customers);
        console.log(`✅ Synced ${customers.length} customers`);
        totalSynced += customers.length;

        // Sync Orders
        console.log('📥 Fetching orders...');
        const orders = await shopify.fetchAllOrders();

        const upsertOrder = db.prepare(`
            INSERT INTO orders (shopify_id, order_number, customer_shopify_id, total_price, currency, financial_status, fulfillment_status, line_items_json, created_at)
            VALUES (@shopify_id, @order_number, @customer_shopify_id, @total_price, @currency, @financial_status, @fulfillment_status, @line_items_json, @created_at)
            ON CONFLICT(shopify_id) DO UPDATE SET
                order_number = excluded.order_number,
                customer_shopify_id = excluded.customer_shopify_id,
                total_price = excluded.total_price,
                currency = excluded.currency,
                financial_status = excluded.financial_status,
                fulfillment_status = excluded.fulfillment_status
                -- We DO NOT overwrite line_items_json here because it might contain 
                -- dynamically fetched images that the REST API sync doesn't have.
        `);

        const insertManyOrders = db.transaction((items) => {
            for (const item of items) {
                upsertOrder.run(item);
            }
        });

        insertManyOrders(orders);
        console.log(`✅ Synced ${orders.length} orders`);
        totalSynced += orders.length;

        // Log sync
        db.prepare(`
            INSERT INTO sync_logs (type, status, records_synced, started_at, completed_at)
            VALUES ('full', 'success', ?, ?, ?)
        `).run(totalSynced, startedAt, new Date().toISOString());

        console.log(`🎉 Full sync complete! Total records: ${totalSynced}`);

        return { success: true, records_synced: totalSynced, customers: customers.length, orders: orders.length };
    } catch (error) {
        console.error('❌ Sync failed:', error.message);

        db.prepare(`
            INSERT INTO sync_logs (type, status, records_synced, error_message, started_at, completed_at)
            VALUES ('full', 'error', ?, ?, ?, ?)
        `).run(totalSynced, error.message, startedAt, new Date().toISOString());

        return { success: false, error: error.message };
    }
}

/**
 * Get last sync info
 */
function getLastSync() {
    return db.prepare('SELECT * FROM sync_logs ORDER BY id DESC LIMIT 1').get() || null;
}

module.exports = { syncAll, getLastSync };
