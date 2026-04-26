const express = require('express');
const db = require('../db/connection');

const router = express.Router();

// GET /api/interactions/:customerId
router.get('/:customerId', async (req, res) => {
    try {
        const customerResult = await db.query('SELECT shopify_id FROM customers WHERE id = $1', [req.params.customerId]);
        const customer = customerResult.rows?.[0];
        if (!customer) return res.status(404).json({ error: 'Customer not found' });

        const interactionsResult = await db.query(
            'SELECT * FROM interactions WHERE customer_shopify_id = $1 ORDER BY created_at DESC',
            [customer.shopify_id]
        );

        res.json(interactionsResult.rows);
    } catch (err) {
        console.error('Error fetching interactions:', err);
        res.status(500).json({ error: 'Failed to fetch interactions' });
    }
});

// POST /api/interactions
router.post('/', async (req, res) => {
    try {
        const { customer_id, type, content } = req.body;

        if (!customer_id || !type || !content) {
            return res.status(400).json({ error: 'customer_id, type, and content are required' });
        }

        const customerResult = await db.query('SELECT shopify_id FROM customers WHERE id = $1', [customer_id]);
        const customer = customerResult.rows?.[0];
        if (!customer) return res.status(404).json({ error: 'Customer not found' });

        const validTypes = ['note', 'call', 'email', 'whatsapp', 'meeting'];
        if (!validTypes.includes(type)) {
            return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });
        }

        const result = await db.query(
            'INSERT INTO interactions (customer_shopify_id, type, content, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
            [customer.shopify_id, type, content, req.user.username]
        );
        const interactionId = result.rows[0]?.id;

        const interactionResult = await db.query('SELECT * FROM interactions WHERE id = $1', [interactionId]);
        const interaction = interactionResult.rows?.[0];
        res.status(201).json(interaction);
    } catch (err) {
        console.error('Error creating interaction:', err);
        res.status(500).json({ error: 'Failed to create interaction' });
    }
});

// DELETE /api/interactions/:id
router.delete('/:id', async (req, res) => {
    try {
        const interactionResult = await db.query('SELECT * FROM interactions WHERE id = $1', [req.params.id]);
        const interaction = interactionResult.rows?.[0];
        if (!interaction) return res.status(404).json({ error: 'Interaction not found' });

        await db.query('DELETE FROM interactions WHERE id = $1', [req.params.id]);
        res.json({ message: 'Interaction deleted' });
    } catch (err) {
        console.error('Error deleting interaction:', err);
        res.status(500).json({ error: 'Failed to delete interaction' });
    }
});

module.exports = router;
