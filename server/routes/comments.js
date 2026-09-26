/**
 * Comments, for anything worth talking about.
 *
 * One table and one set of endpoints, keyed by what the comment is about. Each kind of thing
 * declares three facts below — who may read and write its comments, who may be named in one, and
 * how to describe it in a notification — and everything else is shared. The alternative, a
 * comments endpoint per module, was three copies of mention parsing and notification wiring that
 * would drift apart the first time one of them was fixed.
 */

const express = require('express');
const db = require('../db/connection');
const notify = require('../services/notify');
const { hasPermission } = require('../utils/permissions');

const router = express.Router();

const trimmed = (v) => { const t = String(v ?? '').trim(); return t || null; };
const safeJson = (v, fallback) => { try { return typeof v === 'string' ? (JSON.parse(v || 'null') ?? fallback) : (v || fallback); } catch { return fallback; } };

/**
 * What can be commented on.
 *
 *   perm      — the permission that lets someone read and write these comments
 *   mention   — the permission someone needs to be worth naming (they must be able to open it)
 *   describe  — row → { ref, link }, for the notification's title and where it points
 */
const ENTITIES = {
    crewfit_order: {
        perm: 'can_edit_crewfit_orders',
        mention: 'can_view_crewfit_orders',
        table: 'crewfit_orders',
        describe: (r) => ({
            ref: `CF-${r.sl_no}${r.customer_name ? ` · ${r.customer_name}` : ''}`,
            link: `/crewfit/orders?focus=${r.id}`,
        }),
        columns: 'id, sl_no, customer_name',
    },
    marketing_order: {
        perm: 'can_view_marketing',
        mention: 'can_view_marketing',
        table: 'marketing_orders',
        describe: (r) => ({
            ref: `seeding order #${r.ref_no}${r.name ? ` · ${r.name}` : ''}`,
            link: `/marketing?focus=${r.id}`,
        }),
        columns: 'id, ref_no, name',
    },
};

/** Resolve :entity/:id to the row it names, or answer for it. */
async function load(req, res) {
    const spec = ENTITIES[req.params.entity];
    if (!spec) { res.status(404).json({ error: 'Nothing of that kind can be commented on' }); return null; }
    if (!await hasPermission(req, spec.perm)) { res.status(403).json({ error: 'Access denied' }); return null; }

    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) { res.status(400).json({ error: 'Which one?' }); return null; }
    const row = (await db.query(`SELECT ${spec.columns} FROM ${spec.table} WHERE id = $1`, [id])).rows[0];
    if (!row) { res.status(404).json({ error: 'That is gone' }); return null; }
    return { spec, row, id };
}

const hydrate = (r) => ({ ...r, created_by: r.created_by || null, mentions: safeJson(r.mentions, []) });

/** GET /api/comments/:entity/:id — oldest first, the way a conversation reads. */
router.get('/:entity/:id', async (req, res) => {
    try {
        const found = await load(req, res);
        if (!found) return;
        const r = await db.query(
            `SELECT id, parent_id, body, created_by, mentions, created_at FROM comments
              WHERE entity = $1 AND entity_id = $2 ORDER BY created_at, id`,
            [req.params.entity, found.id]);
        res.json({ comments: r.rows.map(hydrate) });
    } catch (err) {
        console.error('comments list error:', err);
        res.status(500).json({ error: 'Failed to load the comments' });
    }
});

/** GET /api/comments/:entity/:id/team — who can be named here. */
router.get('/:entity/:id/team', async (req, res) => {
    try {
        const found = await load(req, res);
        if (!found) return;
        res.json({ team: await notify.mentionableUsers(found.spec.mention) });
    } catch (err) {
        console.error('comments team error:', err);
        res.status(500).json({ error: 'Failed to load the team list' });
    }
});

/**
 * POST /api/comments/:entity/:id { body, parent_id? }
 *
 * A `parent_id` makes it a reply; replies are one level deep, so answering a reply answers the
 * comment it hangs off rather than nesting further. Whoever is named with an @ is told, and so is
 * the author of the comment being answered.
 */
router.post('/:entity/:id', async (req, res) => {
    try {
        const found = await load(req, res);
        if (!found) return;
        const body = trimmed(req.body?.body);
        if (!body) return res.status(400).json({ error: 'Write something first' });
        if (body.length > 4000) return res.status(400).json({ error: 'That is too long for one comment — keep it under 4000 characters' });

        let parent = null;
        if (req.body?.parent_id) {
            parent = (await db.query(
                'SELECT id, parent_id, created_by FROM comments WHERE id = $1 AND entity = $2 AND entity_id = $3',
                [req.body.parent_id, req.params.entity, found.id])).rows[0];
            if (!parent) return res.status(404).json({ error: 'The comment you are replying to is gone' });
        }
        const parentId = parent ? (parent.parent_id || parent.id) : null;

        const author = req.user?.username || null;
        const mentioned = notify.mentionsIn(body, await notify.mentionableUsers(found.spec.mention));

        const r = await db.query(
            `INSERT INTO comments (entity, entity_id, parent_id, body, created_by, mentions)
             VALUES ($1,$2,$3,$4,$5,$6)
             RETURNING id, parent_id, body, created_by, mentions, created_at`,
            [req.params.entity, found.id, parentId, body, author, JSON.stringify(mentioned)]);

        const { ref, link } = found.spec.describe(found.row);
        const from = notify.handleOf(author) || 'Someone';
        await notify.notify({
            usernames: mentioned, kind: 'mention', actor: author, link,
            title: `${from} mentioned you on ${ref}`, body,
        });
        // The person being answered hears about it too — unless they were named, which already told them.
        if (parent?.created_by && !mentioned.includes(parent.created_by)) {
            await notify.notify({
                usernames: [parent.created_by], kind: 'reply', actor: author, link,
                title: `${from} replied to you on ${ref}`, body,
            });
        }
        res.status(201).json({ comment: hydrate(r.rows[0]) });
    } catch (err) {
        console.error('comment create error:', err);
        res.status(500).json({ error: 'Failed to post that comment' });
    }
});

/**
 * DELETE /api/comments/:entity/:id/:commentId — the owner's alone.
 *
 * A comment is a record of what the team knew and when, so removing one is not tidying up after
 * yourself: the person who wrote it is often exactly the person who would want it gone. Nobody
 * can edit one either — a comment someone has already read and acted on is answered, not
 * rewritten.
 *
 * Addressed through the thing it belongs to, so a comment can only be deleted by someone who can
 * reach that thing in the first place.
 */
router.delete('/:entity/:id/:commentId', async (req, res) => {
    try {
        const found = await load(req, res);
        if (!found) return;
        if (req.user?.role !== 'owner') return res.status(403).json({ error: 'Only the account owner can do this' });

        const row = (await db.query(
            'SELECT id FROM comments WHERE id = $1 AND entity = $2 AND entity_id = $3',
            [req.params.commentId, req.params.entity, found.id])).rows[0];
        if (!row) return res.status(404).json({ error: 'That comment is already gone' });
        // A reply without the comment it answers reads as a non-sequitur, so it goes with it.
        await db.query('DELETE FROM comments WHERE id = $1 OR parent_id = $1', [row.id]);
        res.json({ success: true });
    } catch (err) {
        console.error('comment delete error:', err);
        res.status(500).json({ error: 'Failed to delete that comment' });
    }
});

/** How many comments each of these has, for a list that wants to flag them. */
async function countsFor(entity, ids) {
    if (!ids.length) return new Map();
    const r = await db.query(
        `SELECT entity_id, COUNT(*)::int AS n FROM comments
          WHERE entity = $1 AND entity_id = ANY($2) GROUP BY entity_id`, [entity, ids]);
    return new Map(r.rows.map(x => [x.entity_id, x.n]));
}

module.exports = router;
module.exports.countsFor = countsFor;
module.exports.ENTITIES = ENTITIES;
