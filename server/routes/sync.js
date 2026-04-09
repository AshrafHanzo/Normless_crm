const express = require('express');
const syncService = require('../services/sync');
const shopify = require('../services/shopify');

const router = express.Router();

// POST /api/sync/full
router.post('/full', async (req, res) => {
    try {
        res.json({ message: 'Sync started...', status: 'in_progress' });
        // Run sync in background after responding
        syncService.syncAll().then(result => {
            console.log('Background sync completed:', result);
        }).catch(err => {
            console.error('Background sync failed:', err);
        });
    } catch (err) {
        console.error('Error starting sync:', err);
        res.status(500).json({ error: 'Failed to start sync' });
    }
});

// POST /api/sync/run - Sync and wait for result
router.post('/run', async (req, res) => {
    try {
        const result = await syncService.syncAll();
        res.json(result);
    } catch (err) {
        console.error('Error running sync:', err);
        res.status(500).json({ error: 'Failed to run sync' });
    }
});

// GET /api/sync/status
router.get('/status', (req, res) => {
    try {
        const lastSync = syncService.getLastSync();
        res.json({ lastSync });
    } catch (err) {
        console.error('Error fetching sync status:', err);
        res.status(500).json({ error: 'Failed to fetch sync status' });
    }
});

// GET /api/sync/test - Test Shopify connection
router.get('/test', async (req, res) => {
    try {
        const data = await shopify.testConnection();
        res.json({ connected: true, shop: data.shop });
    } catch (err) {
        console.error('Shopify connection test failed:', err);
        res.status(500).json({ connected: false, error: err.message });
    }
});

module.exports = router;
