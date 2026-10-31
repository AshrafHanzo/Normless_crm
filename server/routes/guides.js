/**
 * Team guides — a page of how-we-work that sits beside the screen it explains: the sales playbook
 * in the Crewfit inbox, the scaling system in Marketing.
 *
 * Each guide ships as an HTML file in server/guides. An admin can replace it with their own HTML
 * file, which is kept in team_guides and wins over the shipped one until it is restored. Whoever
 * can see the screen can read its guide; only owners and admins can replace one.
 *
 * Mounted ahead of the app-wide express.json: a replaced guide is a whole HTML page, well past
 * that parser's 100kb limit.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db/connection');
const { hasPermission } = require('../utils/permissions');

const router = express.Router();

const GUIDES = {
    'crewfit-sales': { title: 'Crewfit sales playbook', permission: 'can_view_whatsapp' },
    'marketing-scaling': { title: 'Marketing scaling system', permission: 'can_view_marketing' },
};
const MAX_BYTES = 3 * 1024 * 1024;

const isAdmin = (req) => req.user?.role === 'owner' || req.user?.role === 'admin';
const shipped = (key) => fs.readFileSync(path.join(__dirname, '..', 'guides', `${key}.html`), 'utf8');

router.use(express.json({ limit: '4mb' }));

router.use('/:key', async (req, res, next) => {
    try {
        req.guide = GUIDES[req.params.key];
        if (!req.guide) return res.status(404).json({ error: 'No such guide' });
        if (!await hasPermission(req, req.guide.permission)) return res.status(403).json({ error: 'Access denied' });
        next();
    } catch (err) { next(err); }
});

// GET /api/guides/:key
router.get('/:key', async (req, res) => {
    try {
        const row = (await db.query(
            `SELECT html, file_name, updated_by, updated_at FROM team_guides WHERE key = $1`, [req.params.key]
        )).rows[0];
        res.json({
            key: req.params.key,
            title: req.guide.title,
            html: row?.html || shipped(req.params.key),
            replaced: row ? { file_name: row.file_name, by: row.updated_by, at: row.updated_at } : null,
            canReplace: isAdmin(req),
        });
    } catch (err) {
        console.error('Error loading guide:', err);
        res.status(500).json({ error: 'Failed to load the guide' });
    }
});

// PUT /api/guides/:key — { html, file_name }
router.put('/:key', async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only an admin can replace a guide' });
    const html = String(req.body?.html || '');
    if (!html.trim() || !/<[a-z!]/i.test(html)) return res.status(400).json({ error: 'Choose an HTML file' });
    if (Buffer.byteLength(html) > MAX_BYTES) return res.status(400).json({ error: 'The file is over 3 MB' });
    try {
        await db.query(
            `INSERT INTO team_guides (key, html, file_name, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
             ON CONFLICT (key) DO UPDATE SET html = EXCLUDED.html, file_name = EXCLUDED.file_name,
                 updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`,
            [req.params.key, html, String(req.body?.file_name || '').slice(0, 200) || null, req.user?.username || null]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Error replacing guide:', err);
        res.status(500).json({ error: 'Failed to save the guide' });
    }
});

// DELETE /api/guides/:key — back to the shipped guide
router.delete('/:key', async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only an admin can restore a guide' });
    try {
        await db.query('DELETE FROM team_guides WHERE key = $1', [req.params.key]);
        res.json({ success: true });
    } catch (err) {
        console.error('Error restoring guide:', err);
        res.status(500).json({ error: 'Failed to restore the guide' });
    }
});

module.exports = router;
