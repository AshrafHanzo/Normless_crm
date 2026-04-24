const express = require('express');
const db = require('../db/connection');

const router = express.Router();

/**
 * Fetch real order count directly from Shopify REST API
 * This returns the REAL total (e.g. 5,274) unlike paginated data which is scope-limited
 */
async function getShopifyOrderCount() {
    try {
        const domain = process.env.SHOPIFY_STORE_DOMAIN;
        const token = process.env.SHOPIFY_ACCESS_TOKEN;
        if (!domain || !token) {
            console.warn('⚠️ Shopify env vars missing, using customer aggregate for order count');
            return db.prepare('SELECT COALESCE(SUM(orders_count), 0) as total FROM customers').get().total;
        }
        const url = `https://${domain}/admin/api/2026-04/orders/count.json?status=any`;
        const response = await fetch(url, {
            headers: { 'X-Shopify-Access-Token': token }
        });
        if (response.ok) {
            const data = await response.json();
            console.log(`📊 Shopify real order count: ${data.count}`);
            return data.count;
        }
        console.warn(`⚠️ Shopify count API returned ${response.status}`);
    } catch (err) {
        console.error('❌ Failed to fetch Shopify order count:', err.message);
    }
    // Fallback to customer-based count if API fails
    return db.prepare('SELECT COALESCE(SUM(orders_count), 0) as total FROM customers').get().total;
}

// GET /api/dashboard?startDate=2025-06-01&endDate=2026-04-18
router.get('/', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;

        let dateFilter = '';
        let params = [];

        // Build date filter if provided
        if (startDate && endDate) {
            dateFilter = `WHERE DATE(created_at) >= ? AND DATE(created_at) <= ?`;
            params = [startDate, endDate];
        }

        let totalOrders, totalRevenue, totalCustomers, avgOrderValue;

        if (dateFilter) {
            // DATE-FILTERED: Use synced orders table (accurate for the data we have)
            const countResult = db.prepare(`SELECT COUNT(*) as count FROM orders ${dateFilter}`).get(...params);
            const revenueResult = db.prepare(`SELECT COALESCE(SUM(total_price), 0) as sum FROM orders ${dateFilter}`).get(...params);
            totalOrders = countResult.count;
            totalRevenue = revenueResult.sum;
            // Count unique customers with orders in the date range
            const customerCountResult = db.prepare(`
                SELECT COUNT(DISTINCT customer_shopify_id) as count
                FROM orders
                ${dateFilter}
            `).get(...params);
            totalCustomers = customerCountResult.count;
            avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;
        } else {
            // ALL-TIME: Use REAL data from Shopify API
            const [shopifyCount] = await Promise.all([getShopifyOrderCount()]);
            totalOrders = shopifyCount;

            // For ALL-TIME revenue without a date filter, use the customer total_spent
            // which represents all-time spending (more accurate than order count * price)
            const dbRevenue = db.prepare('SELECT COALESCE(SUM(total_spent), 0) as total FROM customers').get().total;
            totalRevenue = dbRevenue;

            totalCustomers = db.prepare('SELECT COUNT(*) as count FROM customers').get().count;
            avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;
        }

        // Current month metrics (from synced orders - accurate for recent data)
        const currentMonth = new Date().toISOString().substring(0, 7);
        const monthStart = `${currentMonth}-01`;
        const monthEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString().substring(0, 10);

        const monthStats = db.prepare(`
            SELECT
                COUNT(*) as orders,
                COALESCE(SUM(total_price), 0) as revenue
            FROM orders
            WHERE DATE(created_at) >= ? AND DATE(created_at) <= ?
        `).get(monthStart, monthEnd);

        const newCustomersThisMonth = db.prepare(`
            SELECT COUNT(*) as count FROM customers
            WHERE DATE(created_at) >= ? AND DATE(created_at) <= ?
        `).get(monthStart, monthEnd).count;

        // Top 10 customers
        const topCustomers = db.prepare(`
            SELECT id, first_name, last_name, email, total_spent, orders_count
            FROM customers
            WHERE total_spent > 0
            ORDER BY total_spent DESC
            LIMIT 10
        `).all();

        // Recent 10 orders
        const recentOrders = db.prepare(`
            SELECT o.id, o.order_number, o.total_price, o.fulfillment_status, o.created_at,
                   c.first_name, c.last_name
            FROM orders o
            LEFT JOIN customers c ON o.customer_shopify_id = c.shopify_id
            ORDER BY o.created_at DESC
            LIMIT 10
        `).all();

        // Order status breakdown
        let statusBreakdown;
        if (dateFilter) {
            statusBreakdown = db.prepare(`
                SELECT fulfillment_status, COUNT(*) as count
                FROM orders
                ${dateFilter}
                GROUP BY fulfillment_status
                ORDER BY count DESC
            `).all(...params);
        } else {
            statusBreakdown = db.prepare(`
                SELECT fulfillment_status, COUNT(*) as count
                FROM orders
                GROUP BY fulfillment_status
                ORDER BY count DESC
            `).all();
        }

        // Daily revenue chart (last 30 days or filtered range)
        let dailyRevenue = [];
        if (startDate && endDate) {
            dailyRevenue = db.prepare(`
                SELECT
                    DATE(created_at) as date,
                    COALESCE(SUM(total_price), 0) as revenue,
                    COUNT(*) as order_count
                FROM orders
                WHERE DATE(created_at) >= ? AND DATE(created_at) <= ?
                GROUP BY DATE(created_at)
                ORDER BY date ASC
            `).all(startDate, endDate);
        } else {
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);
            const startDateStr = thirtyDaysAgo.toISOString().substring(0, 10);

            dailyRevenue = db.prepare(`
                SELECT
                    DATE(created_at) as date,
                    COALESCE(SUM(total_price), 0) as revenue,
                    COUNT(*) as order_count
                FROM orders
                WHERE DATE(created_at) >= ?
                GROUP BY DATE(created_at)
                ORDER BY date ASC
            `).all(startDateStr);
        }

        // Fill in missing dates
        const allDates = {};
        if (startDate && endDate) {
            const start = new Date(startDate);
            const end = new Date(endDate);
            for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
                const dateStr = d.toISOString().substring(0, 10);
                allDates[dateStr] = { date: dateStr, revenue: 0, order_count: 0 };
            }
        } else {
            const today = new Date();
            for (let i = 29; i >= 0; i--) {
                const d = new Date(today);
                d.setDate(d.getDate() - i);
                const dateStr = d.toISOString().substring(0, 10);
                allDates[dateStr] = { date: dateStr, revenue: 0, order_count: 0 };
            }
        }

        dailyRevenue.forEach(d => {
            allDates[d.date] = d;
        });

        const chartData = Object.values(allDates);

        // Monthly revenue (last 12 months)
        const monthlyRevenue = db.prepare(`
            SELECT
                strftime('%Y-%m', created_at) as month,
                COALESCE(SUM(total_price), 0) as revenue,
                COUNT(*) as order_count
            FROM orders
            GROUP BY strftime('%Y-%m', created_at)
            ORDER BY month DESC
            LIMIT 12
        `).all().reverse();

        res.json({
            metrics: {
                totalCustomers,
                totalOrders,
                totalRevenue,
                avgOrderValue,
                ordersThisMonth: monthStats.orders,
                revenueThisMonth: monthStats.revenue,
                newCustomersThisMonth,
            },
            topCustomers,
            recentOrders,
            statusBreakdown,
            dailyRevenue: chartData,
            monthlyRevenue,
            dateRange: {
                startDate: startDate || null,
                endDate: endDate || null,
                daysCount: chartData.length
            }
        });
    } catch (err) {
        console.error('Dashboard error:', err);
        res.status(500).json({ error: 'Failed to load dashboard', details: err.message });
    }
});

module.exports = router;
