const express = require('express');
const db = require('../db/connection');

const router = express.Router();

// GET /api/interactions/:customerId
router.get('/:customerId', (req, res) => {
    try {
        const customer = db.prepare('SELECT shopify_id FROM customers WHERE id = ?').get(req.params.customerId);
        if (!customer) return res.status(404).json({ error: 'Customer not found' });

        const interactions = db.prepare(
            'SELECT * FROM interactions WHERE customer_shopify_id = ? ORDER BY created_at DESC'
        ).all(customer.shopify_id);

        res.json(interactions);
    } catch (err) {
        console.error('Error fetching interactions:', err);
        res.status(500).json({ error: 'Failed to fetch interactions' });
    }
});

// POST /api/interactions
router.post('/', (req, res) => {
    try {
        const { customer_id, type, content } = req.body;

        if (!customer_id || !type || !content) {
            return res.status(400).json({ error: 'customer_id, type, and content are required' });
        }

        const customer = db.prepare('SELECT shopify_id FROM customers WHERE id = ?').get(customer_id);
        if (!customer) return res.status(404).json({ error: 'Customer not found' });

        const validTypes = ['note', 'call', 'email', 'whatsapp', 'meeting'];
        if (!validTypes.includes(type)) {
            return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });
        }

        const result = db.prepare(
            'INSERT INTO interactions (customer_shopify_id, type, content, created_by) VALUES (?, ?, ?, ?)'
        ).run(customer.shopify_id, type, content, req.user.username);

        const interaction = db.prepare('SELECT * FROM interactions WHERE id = ?').get(result.lastInsertRowid);
        res.status(201).json(interaction);
    } catch (err) {
        console.error('Error creating interaction:', err);
        res.status(500).json({ error: 'Failed to create interaction' });
    }
});

// DELETE /api/interactions/:id
router.delete('/:id', (req, res) => {
    try {
        const interaction = db.prepare('SELECT * FROM interactions WHERE id = ?').get(req.params.id);
        if (!interaction) return res.status(404).json({ error: 'Interaction not found' });

        db.prepare('DELETE FROM interactions WHERE id = ?').run(req.params.id);
        res.json({ message: 'Interaction deleted' });
    } catch (err) {
        console.error('Error deleting interaction:', err);
        res.status(500).json({ error: 'Failed to delete interaction' });
    }
});

module.exports = router;
