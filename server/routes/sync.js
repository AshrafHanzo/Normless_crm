const express = require('express');
const syncService = require('../services/sync');
const shopify = require('../services/shopify');

const router = express.Router();

let autoSyncInterval = null;
let isSyncing = false;

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
        if (isSyncing) {
            return res.status(429).json({ error: 'Sync already in progress' });
        }

        isSyncing = true;
        const result = await syncService.syncAll();
        isSyncing = false;

        res.json(result);
    } catch (err) {
        isSyncing = false;
        console.error('Error running sync:', err);
        res.status(500).json({ error: 'Failed to run sync' });
    }
});

// GET /api/sync/status
router.get('/status', (req, res) => {
    try {
        const lastSync = syncService.getLastSync();
        res.json({
            lastSync,
            isSyncing,
            autoSyncEnabled: autoSyncInterval !== null
        });
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

// POST /api/sync/enable-auto - Enable auto-sync
router.post('/enable-auto', (req, res) => {
    try {
        const intervalSeconds = req.body.interval || 30; // Default 30 seconds

        if (autoSyncInterval) {
            clearInterval(autoSyncInterval);
        }

        autoSyncInterval = setInterval(() => {
            if (!isSyncing) {
                isSyncing = true;
                syncService.syncAll()
                    .then(() => {
                        isSyncing = false;
                        console.log(`✨ Auto-sync completed at ${new Date().toLocaleTimeString()}`);
                    })
                    .catch(err => {
                        isSyncing = false;
                        console.error('Auto-sync failed:', err);
                    });
            }
        }, intervalSeconds * 1000);

        console.log(`🔄 Auto-sync enabled (every ${intervalSeconds} seconds)`);
        res.json({
            enabled: true,
            interval: intervalSeconds,
            message: `Auto-sync will run every ${intervalSeconds} seconds`
        });
    } catch (err) {
        console.error('Error enabling auto-sync:', err);
        res.status(500).json({ error: 'Failed to enable auto-sync' });
    }
});

// POST /api/sync/disable-auto - Disable auto-sync
router.post('/disable-auto', (req, res) => {
    try {
        if (autoSyncInterval) {
            clearInterval(autoSyncInterval);
            autoSyncInterval = null;
        }

        console.log('🛑 Auto-sync disabled');
        res.json({ enabled: false, message: 'Auto-sync disabled' });
    } catch (err) {
        console.error('Error disabling auto-sync:', err);
        res.status(500).json({ error: 'Failed to disable auto-sync' });
    }
});

module.exports = router;
module.exports.getAutoSyncStatus = () => autoSyncInterval !== null;
