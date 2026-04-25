const express = require('express');
const db = require('../db/connection');

const router = express.Router();

// GET /api/orders - List with filters and pagination
router.get('/', (req, res) => {
    try {
        const {
            search = '',
            financial_status = '',
            fulfillment_status = '',
            sort = 'created_at',
            order = 'DESC',
            page = 1,
            limit = 20
        } = req.query;

        const offset = (parseInt(page) - 1) * parseInt(limit);
        let conditions = [];
        let params = [];

        if (search) {
            conditions.push(`(order_number LIKE ? OR customer_shopify_id LIKE ?)`);
            const s = `%${search}%`;
            params.push(s, s);
        }

        if (financial_status) {
            conditions.push(`financial_status = ?`);
            params.push(financial_status);
        }

        if (fulfillment_status) {
            conditions.push(`fulfillment_status = ?`);
            params.push(fulfillment_status);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const allowedSorts = ['created_at', 'total_price', 'order_number'];
        const sortCol = allowedSorts.includes(sort) ? sort : 'created_at';
        const sortDir = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

        const countRow = db.prepare(`SELECT COUNT(*) as total FROM orders ${whereClause}`).get(...params);
        const total = countRow.total;

        const orders = db.prepare(`
            SELECT o.*, c.first_name, c.last_name, c.email as customer_email
            FROM orders o
            LEFT JOIN customers c ON o.customer_shopify_id = c.shopify_id
            ${whereClause}
            ORDER BY o.${sortCol} ${sortDir}
            LIMIT ? OFFSET ?
        `).all(...params, parseInt(limit), offset);

        res.json({
            orders,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(total / parseInt(limit))
            }
        });
    } catch (err) {
        console.error('Error fetching orders:', err);
        res.status(500).json({ error: 'Failed to fetch orders' });
    }
});

// GET /api/orders/stats
router.get('/stats', (req, res) => {
    try {
        const totalOrders = db.prepare('SELECT COUNT(*) as count FROM orders').get().count;
        const totalRevenue = db.prepare('SELECT SUM(total_price) as sum FROM orders').get().sum || 0;
        const avgOrderValue = db.prepare('SELECT AVG(total_price) as avg FROM orders').get().avg || 0;

        const financialBreakdown = db.prepare(
            'SELECT financial_status, COUNT(*) as count FROM orders GROUP BY financial_status'
        ).all();

        const fulfillmentBreakdown = db.prepare(
            'SELECT fulfillment_status, COUNT(*) as count FROM orders GROUP BY fulfillment_status'
        ).all();

        // Revenue by month (last 6 months)
        const revenueByMonth = db.prepare(`
            SELECT
                strftime('%Y-%m', created_at) as month,
                SUM(total_price) as revenue,
                COUNT(*) as order_count
            FROM orders
            WHERE created_at >= date('now', '-6 months')
            GROUP BY strftime('%Y-%m', created_at)
            ORDER BY month ASC
        `).all();

        res.json({ totalOrders, totalRevenue, avgOrderValue, financialBreakdown, fulfillmentBreakdown, revenueByMonth });
    } catch (err) {
        console.error('Error fetching order stats:', err);
        res.status(500).json({ error: 'Failed to fetch order stats' });
    }
});

// GET /api/orders/lookup/:orderName - Find order by barcode value
router.get('/lookup/:orderName', async (req, res) => {
    try {
        let name = req.params.orderName;
        console.log(`[Order Lookup Hit] Searching for: "${name}"`);
        
        // Search for exact match first
        let order = db.prepare(`
            SELECT o.*, c.first_name, c.last_name, c.email as customer_email
            FROM orders o
            LEFT JOIN customers c ON o.customer_shopify_id = c.shopify_id
            WHERE o.order_number = ?
        `).get(name);

        // If not found, try adding a '#' if it's missing, or vice versa
        if (!order) {
            const altName = name.startsWith('#') ? name.substring(1) : `#${name}`;
             order = db.prepare(`
                SELECT o.*, c.first_name, c.last_name, c.email as customer_email
                FROM orders o
                LEFT JOIN customers c ON o.customer_shopify_id = c.shopify_id
                WHERE o.order_number = ?
            `).get(altName);
        }

        if (!order) return res.status(404).json({ error: 'Order not found' });

        // Dynamically fetch product images for the line items
        try {
            let lineItems = JSON.parse(order.line_items_json || '[]');
            const token = process.env.SHOPIFY_ACCESS_TOKEN;
            const domain = process.env.SHOPIFY_STORE_DOMAIN;
            
            if (token && domain) {
                let updated = false;
                for (let li of lineItems) {
                    if (!li.image && li.title) {
                        const url = `https://${domain}/admin/api/2026-04/products.json?title=${encodeURIComponent(li.title)}`;
                        const pRes = await fetch(url, { headers: { 'X-Shopify-Access-Token': token } });
                        if (pRes.ok) {
                            const pData = await pRes.json();
                            if (pData.products && pData.products.length > 0 && pData.products[0].image) {
                                li.image = pData.products[0].image.src;
                                updated = true;
                            }
                        }
                    }
                }
                
                if (updated) {
                    order.line_items_json = JSON.stringify(lineItems);
                    // Optionally update the DB so we don't have to fetch it again next time
                    db.prepare('UPDATE orders SET line_items_json = ? WHERE id = ?').run(order.line_items_json, order.id);
                }
            }
        } catch (imgErr) {
            console.error('Failed to fetch images dynamically:', imgErr.message);
        }

        res.json(order);
    } catch (err) {
        console.error('Error looking up order:', err);
        res.status(500).json({ error: 'Failed to look up order' });
    }
});

// GET /api/orders/:id
router.get('/:id', (req, res) => {
    try {
        const order = db.prepare(`
            SELECT o.*, c.first_name, c.last_name, c.email as customer_email
            FROM orders o
            LEFT JOIN customers c ON o.customer_shopify_id = c.shopify_id
            WHERE o.id = ?
        `).get(req.params.id);

        if (!order) return res.status(404).json({ error: 'Order not found' });

        res.json(order);
    } catch (err) {
        console.error('Error fetching order:', err);
        res.status(500).json({ error: 'Failed to fetch order' });
    }
});

module.exports = router;
