/**
 * Your own notifications — what you were named in, and who answered you.
 *
 * Scoped to the caller throughout: there is no route here that can read or clear somebody else's,
 * not even for an owner. A notification is about what one person has seen.
 */

const express = require('express');
const db = require('../db/connection');

const router = express.Router();
const me = (req) => req.user?.username || '';

// GET /api/notifications?unread=1 — newest first, with the unread count for the bell.
router.get('/', async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
        const onlyUnread = req.query.unread === '1';
        const rows = (await db.query(
            `SELECT id, kind, title, body, link, actor, read_at, created_at
               FROM notifications
              WHERE username = $1 ${onlyUnread ? 'AND read_at IS NULL' : ''}
              ORDER BY created_at DESC, id DESC LIMIT ${limit}`, [me(req)])).rows;
        const unread = (await db.query(
            'SELECT COUNT(*)::int AS n FROM notifications WHERE username = $1 AND read_at IS NULL', [me(req)]
        )).rows[0].n;
        res.json({ notifications: rows, unread });
    } catch (err) {
        console.error('notifications list error:', err);
        res.status(500).json({ error: 'Failed to load your notifications' });
    }
});

/** POST /api/notifications/read { ids? } — mark some read, or all of them when no ids are given. */
router.post('/read', async (req, res) => {
    try {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : null;
        const r = await db.query(
            `UPDATE notifications SET read_at = CURRENT_TIMESTAMP
              WHERE username = $1 AND read_at IS NULL ${ids ? 'AND id = ANY($2)' : ''}`,
            ids ? [me(req), ids] : [me(req)]);
        res.json({ success: true, marked: r.rowCount });
    } catch (err) {
        console.error('notifications read error:', err);
        res.status(500).json({ error: 'Failed to update your notifications' });
    }
});

module.exports = router;
