const express = require('express');
const db = require('../db/connection');

const router = express.Router();

// GET /api/customers - List with search, filter, pagination
router.get('/', async (req, res) => {
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
        let paramCount = 1;

        if (search) {
            conditions.push(`(first_name ILIKE $${paramCount} OR last_name ILIKE $${paramCount + 1} OR email ILIKE $${paramCount + 2} OR phone ILIKE $${paramCount + 3})`);
            const s = `%${search}%`;
            params.push(s, s, s, s);
            paramCount += 4;
        }

        if (status) {
            conditions.push(`crm_status = $${paramCount}`);
            params.push(status);
            paramCount += 1;
        }

        if (priority) {
            conditions.push(`crm_priority = $${paramCount}`);
            params.push(priority);
            paramCount += 1;
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

        const allowedSorts = ['total_spent', 'orders_count', 'created_at', 'first_name', 'updated_at'];
        const sortCol = allowedSorts.includes(sort) ? sort : 'total_spent';
        const sortDir = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

        const countResult = await db.query(`SELECT COUNT(*) as total FROM customers ${whereClause}`, params);
        const total = parseInt(countResult.rows[0]?.total) || 0;

        const customers = await db.query(`
            SELECT * FROM customers ${whereClause}
            ORDER BY ${sortCol} ${sortDir}
            LIMIT $${paramCount} OFFSET $${paramCount + 1}
        `, [...params, parseInt(limit), offset]);

        res.json({
            customers: customers.rows,
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
router.get('/stats', async (req, res) => {
    try {
        const totalCustomersResult = await db.query('SELECT COUNT(*) as count FROM customers');
        const totalCustomers = parseInt(totalCustomersResult.rows[0]?.count) || 0;

        const avgSpentResult = await db.query('SELECT AVG(total_spent) as avg FROM customers');
        const avgSpent = parseFloat(avgSpentResult.rows[0]?.avg) || 0;

        const totalRevenueResult = await db.query('SELECT SUM(total_spent) as sum FROM customers');
        const totalRevenue = parseFloat(totalRevenueResult.rows[0]?.sum) || 0;

        const statusBreakdownResult = await db.query('SELECT crm_status, COUNT(*) as count FROM customers GROUP BY crm_status');
        const statusBreakdown = statusBreakdownResult.rows;

        const priorityBreakdownResult = await db.query('SELECT crm_priority, COUNT(*) as count FROM customers GROUP BY crm_priority');
        const priorityBreakdown = priorityBreakdownResult.rows;

        res.json({ totalCustomers, avgSpent, totalRevenue, statusBreakdown, priorityBreakdown });
    } catch (err) {
        console.error('Error fetching customer stats:', err);
        res.status(500).json({ error: 'Failed to fetch customer stats' });
    }
});

// GET /api/customers/:id
router.get('/:id', async (req, res) => {
    try {
        const customerResult = await db.query('SELECT * FROM customers WHERE id = $1', [req.params.id]);
        const customer = customerResult.rows?.[0];
        if (!customer) return res.status(404).json({ error: 'Customer not found' });

        const ordersResult = await db.query('SELECT * FROM orders WHERE customer_shopify_id = $1 ORDER BY created_at DESC', [customer.shopify_id]);
        const orders = ordersResult.rows;

        const interactionsResult = await db.query('SELECT * FROM interactions WHERE customer_shopify_id = $1 ORDER BY created_at DESC', [customer.shopify_id]);
        const interactions = interactionsResult.rows;

        res.json({ customer, orders, interactions });
    } catch (err) {
        console.error('Error fetching customer:', err);
        res.status(500).json({ error: 'Failed to fetch customer' });
    }
});

// PUT /api/customers/:id
router.put('/:id', async (req, res) => {
    try {
        const { crm_status, crm_notes, crm_priority } = req.body;

        const customerResult = await db.query('SELECT * FROM customers WHERE id = $1', [req.params.id]);
        const customer = customerResult.rows?.[0];
        if (!customer) return res.status(404).json({ error: 'Customer not found' });

        await db.query(`
            UPDATE customers SET
                crm_status = COALESCE($1, crm_status),
                crm_notes = COALESCE($2, crm_notes),
                crm_priority = COALESCE($3, crm_priority),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $4
        `, [crm_status || null, crm_notes || null, crm_priority || null, req.params.id]);

        const updatedResult = await db.query('SELECT * FROM customers WHERE id = $1', [req.params.id]);
        const updated = updatedResult.rows?.[0];
        res.json(updated);
    } catch (err) {
        console.error('Error updating customer:', err);
        res.status(500).json({ error: 'Failed to update customer' });
    }
});

module.exports = router;
