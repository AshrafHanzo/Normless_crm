const express = require('express');
const db = require('../db/connection');

const router = express.Router();

// GET /api/dashboard
router.get('/', (req, res) => {
    try {
        // Total counts
        const totalCustomers = db.prepare('SELECT COUNT(*) as count FROM customers').get().count;
        const totalOrders = db.prepare('SELECT COUNT(*) as count FROM orders').get().count;
        const totalRevenue = db.prepare('SELECT SUM(total_price) as sum FROM orders').get().sum || 0;
        const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;

        // New customers this month
        const newCustomersThisMonth = db.prepare(`
            SELECT COUNT(*) as count FROM customers
            WHERE created_at >= date('now', 'start of month')
        `).get().count;

        // Orders this month
        const ordersThisMonth = db.prepare(`
            SELECT COUNT(*) as count FROM orders
            WHERE created_at >= date('now', 'start of month')
        `).get().count;

        // Revenue this month
        const revenueThisMonth = db.prepare(`
            SELECT SUM(total_price) as sum FROM orders
            WHERE created_at >= date('now', 'start of month')
        `).get().sum || 0;

        // Top 10 customers by spend
        const topCustomers = db.prepare(`
            SELECT id, shopify_id, first_name, last_name, email, total_spent, orders_count, crm_status
            FROM customers
            ORDER BY total_spent DESC
            LIMIT 10
        `).all();

        // Recent 10 orders
        const recentOrders = db.prepare(`
            SELECT o.id, o.order_number, o.total_price, o.currency, o.financial_status, o.fulfillment_status, o.created_at,
                   c.first_name, c.last_name
            FROM orders o
            LEFT JOIN customers c ON o.customer_shopify_id = c.shopify_id
            ORDER BY o.created_at DESC
            LIMIT 10
        `).all();

        // Order status breakdown
        const statusBreakdown = db.prepare(`
            SELECT fulfillment_status, COUNT(*) as count
            FROM orders
            GROUP BY fulfillment_status
        `).all();

        // Daily revenue for the last 30 days
        const dailyRevenue = db.prepare(`
            SELECT
                date(created_at) as date,
                SUM(total_price) as revenue,
                COUNT(*) as order_count
            FROM orders
            WHERE created_at >= date('now', '-30 days')
            GROUP BY date(created_at)
            ORDER BY date ASC
        `).all();

        res.json({
            metrics: {
                totalCustomers,
                totalOrders,
                totalRevenue,
                avgOrderValue,
                newCustomersThisMonth,
                ordersThisMonth,
                revenueThisMonth,
            },
            topCustomers,
            recentOrders,
            statusBreakdown,
            dailyRevenue,
        });
    } catch (err) {
        console.error('Error fetching dashboard data:', err);
        res.status(500).json({ error: 'Failed to fetch dashboard data' });
    }
});

module.exports = router;
