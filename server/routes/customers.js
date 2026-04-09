const express = require('express');
const db = require('../db/connection');

const router = express.Router();

// GET /api/customers - List with search, filter, pagination
router.get('/', (req, res) => {
    try {
        const {
            search = '',
            status = '',
            priority = '',
            sort = 'total_spent',
            order = 'DESC',
            page = 1,
            limit = 20
        } = req.query;

        const offset = (parseInt(page) - 1) * parseInt(limit);
        let conditions = [];
        let params = [];

        if (search) {
            conditions.push(`(first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR phone LIKE ?)`);
            const s = `%${search}%`;
            params.push(s, s, s, s);
        }

        if (status) {
            conditions.push(`crm_status = ?`);
            params.push(status);
        }

        if (priority) {
            conditions.push(`crm_priority = ?`);
            params.push(priority);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const allowedSorts = ['total_spent', 'orders_count', 'created_at', 'first_name', 'updated_at'];
        const sortCol = allowedSorts.includes(sort) ? sort : 'total_spent';
        const sortDir = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

        const countRow = db.prepare(`SELECT COUNT(*) as total FROM customers ${whereClause}`).get(...params);
        const total = countRow.total;

        const customers = db.prepare(`
            SELECT * FROM customers ${whereClause}
            ORDER BY ${sortCol} ${sortDir}
            LIMIT ? OFFSET ?
        `).all(...params, parseInt(limit), offset);

        res.json({
            customers,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(total / parseInt(limit))
            }
        });
    } catch (err) {
        console.error('Error fetching customers:', err);
        res.status(500).json({ error: 'Failed to fetch customers' });
    }
});

// GET /api/customers/stats
router.get('/stats', (req, res) => {
    try {
        const totalCustomers = db.prepare('SELECT COUNT(*) as count FROM customers').get().count;
        const avgSpent = db.prepare('SELECT AVG(total_spent) as avg FROM customers').get().avg || 0;
        const totalRevenue = db.prepare('SELECT SUM(total_spent) as sum FROM customers').get().sum || 0;
        const statusBreakdown = db.prepare('SELECT crm_status, COUNT(*) as count FROM customers GROUP BY crm_status').all();
        const priorityBreakdown = db.prepare('SELECT crm_priority, COUNT(*) as count FROM customers GROUP BY crm_priority').all();

        res.json({ totalCustomers, avgSpent, totalRevenue, statusBreakdown, priorityBreakdown });
    } catch (err) {
        console.error('Error fetching customer stats:', err);
        res.status(500).json({ error: 'Failed to fetch customer stats' });
    }
});

// GET /api/customers/:id
router.get('/:id', (req, res) => {
    try {
        const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
        if (!customer) return res.status(404).json({ error: 'Customer not found' });

        const orders = db.prepare('SELECT * FROM orders WHERE customer_shopify_id = ? ORDER BY created_at DESC').all(customer.shopify_id);
        const interactions = db.prepare('SELECT * FROM interactions WHERE customer_shopify_id = ? ORDER BY created_at DESC').all(customer.shopify_id);

        res.json({ customer, orders, interactions });
    } catch (err) {
        console.error('Error fetching customer:', err);
        res.status(500).json({ error: 'Failed to fetch customer' });
    }
});

// PUT /api/customers/:id
router.put('/:id', (req, res) => {
    try {
        const { crm_status, crm_notes, crm_priority } = req.body;
        const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
        if (!customer) return res.status(404).json({ error: 'Customer not found' });

        db.prepare(`
            UPDATE customers SET
                crm_status = COALESCE(?, crm_status),
                crm_notes = COALESCE(?, crm_notes),
                crm_priority = COALESCE(?, crm_priority),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `).run(crm_status || null, crm_notes || null, crm_priority || null, req.params.id);

        const updated = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
        res.json(updated);
    } catch (err) {
        console.error('Error updating customer:', err);
        res.status(500).json({ error: 'Failed to update customer' });
    }
});

module.exports = router;
