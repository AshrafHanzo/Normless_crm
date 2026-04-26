const express = require('express');
const db = require('../db/connection');

const router = express.Router();

/**
 * Fetch real order count directly from Shopify REST API
 */
async function getShopifyOrderCount() {
    try {
        const domain = process.env.SHOPIFY_STORE_DOMAIN;
        const token = process.env.SHOPIFY_ACCESS_TOKEN;
        if (!domain || !token) {
            console.warn('⚠️ Shopify env vars missing, using customer aggregate for order count');
            const result = await db.prepare('SELECT COALESCE(SUM(orders_count), 0) as total FROM customers').get();
            return result?.total || 0;
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
    // Fallback
    const result = await db.prepare('SELECT COALESCE(SUM(orders_count), 0) as total FROM customers').get();
    return result?.total || 0;
}

/**
 * Fetch real order count for a date range from Shopify REST API
 */
async function getShopifyFilteredOrderCount(startDate, endDate) {
    try {
        const domain = process.env.SHOPIFY_STORE_DOMAIN;
        const token = process.env.SHOPIFY_ACCESS_TOKEN;
        if (!domain || !token) return null;
        
        const url = `https://${domain}/admin/api/2026-04/orders/count.json?status=any&created_at_min=${startDate}T00:00:00Z&created_at_max=${endDate}T23:59:59Z`;
        const response = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
        if (response.ok) {
            const data = await response.json();
            return data.count;
        }
    } catch (err) {
        console.error('❌ Failed to fetch Shopify filtered count:', err.message);
    }
    return null;
}

// GET /api/dashboard?startDate=2025-06-01&endDate=2026-04-18
router.get('/', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;

        let dateFilter = '';
        let params = [];

        if (startDate && endDate) {
            dateFilter = `WHERE DATE(created_at) >= $1 AND DATE(created_at) <= $2`;
            params = [startDate, endDate];
        }

        let totalOrders, totalRevenue, totalCustomers, avgOrderValue;

        if (dateFilter) {
            // With date filter
            const shopifyCount = await getShopifyFilteredOrderCount(startDate, endDate);
            
            const countResult = await db.prepare(`SELECT COUNT(*) as count FROM orders ${dateFilter}`).get(...params);
            const revenueResult = await db.prepare(`SELECT COALESCE(SUM(total_price), 0) as sum FROM orders ${dateFilter}`).get(...params);
            
            // Use Shopify API count if available, otherwise fallback to DB
            totalOrders = shopifyCount !== null ? shopifyCount : (countResult?.count || 0);
            totalRevenue = revenueResult?.sum || 0;

            const customerCountResult = await db.prepare(`
                SELECT COUNT(DISTINCT customer_shopify_id) as count
                FROM orders
                ${dateFilter}
            `).get(...params);
            totalCustomers = customerCountResult?.count || 0;
            avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;
        } else {
            // All-time
            const shopifyCount = await getShopifyOrderCount();
            totalOrders = shopifyCount;

            const dbRevenue = await db.prepare('SELECT COALESCE(SUM(total_spent), 0) as total FROM customers').get();
            totalRevenue = dbRevenue?.total || 0;

            const customerCount = await db.prepare('SELECT COUNT(*) as count FROM customers').get();
            totalCustomers = customerCount?.count || 0;
            avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;
        }

        // Current month
        const currentMonth = new Date().toISOString().substring(0, 7);
        const monthStart = `${currentMonth}-01`;
        const monthEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString().substring(0, 10);

        const monthStats = await db.prepare(`
            SELECT
                COUNT(*) as orders,
                COALESCE(SUM(total_price), 0) as revenue
            FROM orders
            WHERE DATE(created_at) >= $1 AND DATE(created_at) <= $2
        `).get(monthStart, monthEnd);

        const newCustomersThisMonth = await db.prepare(`
            SELECT COUNT(*) as count FROM customers
            WHERE DATE(created_at) >= $1 AND DATE(created_at) <= $2
        `).get(monthStart, monthEnd);

        // Top 10 customers
        const topCustomers = await db.prepare(`
            SELECT id, first_name, last_name, email, total_spent, orders_count
            FROM customers
            WHERE total_spent > 0
            ORDER BY total_spent DESC
            LIMIT 10
        `).all();

        // Recent 10 orders
        const recentOrders = await db.prepare(`
            SELECT o.id, o.order_number, o.total_price, o.fulfillment_status, o.created_at,
                   c.first_name, c.last_name
            FROM orders o
            LEFT JOIN customers c ON o.customer_shopify_id = c.shopify_id
            ORDER BY o.created_at DESC
            LIMIT 10
        `).all();

        // Status breakdown
        let statusBreakdown;
        if (dateFilter) {
            statusBreakdown = await db.prepare(`
                SELECT fulfillment_status, COUNT(*) as count
                FROM orders
                ${dateFilter}
                GROUP BY fulfillment_status
                ORDER BY count DESC
            `).all(...params);
        } else {
            statusBreakdown = await db.prepare(`
                SELECT fulfillment_status, COUNT(*) as count
                FROM orders
                GROUP BY fulfillment_status
                ORDER BY count DESC
            `).all();
        }

        // Daily revenue
        let dailyRevenue = [];
        if (startDate && endDate) {
            dailyRevenue = await db.prepare(`
                SELECT
                    DATE(created_at) as date,
                    COALESCE(SUM(total_price), 0) as revenue,
                    COUNT(*) as order_count
                FROM orders
                WHERE DATE(created_at) >= $1 AND DATE(created_at) <= $2
                GROUP BY DATE(created_at)
                ORDER BY date ASC
            `).all(startDate, endDate);
        } else {
            const thirtyDaysAgo = new Date();
            thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);
            const startDateStr = thirtyDaysAgo.toISOString().substring(0, 10);

            dailyRevenue = await db.prepare(`
                SELECT
                    DATE(created_at) as date,
                    COALESCE(SUM(total_price), 0) as revenue,
                    COUNT(*) as order_count
                FROM orders
                WHERE DATE(created_at) >= $1
                GROUP BY DATE(created_at)
                ORDER BY date ASC
            `).all(startDateStr);
        }

        // Fill missing dates
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

        // Monthly revenue - PostgreSQL version
        const monthlyRevenue = await db.prepare(`
            SELECT
                to_char(created_at, 'YYYY-MM') as month,
                COALESCE(SUM(total_price), 0) as revenue,
                COUNT(*) as order_count
            FROM orders
            GROUP BY to_char(created_at, 'YYYY-MM')
            ORDER BY month DESC
            LIMIT 12
        `).all();

        res.json({
            metrics: {
                totalCustomers,
                totalOrders,
                totalRevenue,
                avgOrderValue,
                ordersThisMonth: monthStats?.orders || 0,
                revenueThisMonth: monthStats?.revenue || 0,
                newCustomersThisMonth: newCustomersThisMonth?.count || 0,
            },
            topCustomers: topCustomers || [],
            recentOrders: recentOrders || [],
            statusBreakdown: statusBreakdown || [],
            dailyRevenue: chartData,
            monthlyRevenue: (monthlyRevenue || []).reverse(),
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
