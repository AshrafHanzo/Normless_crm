/**
 * The Email page under Support: contact@normless.store's threads, what the AI agent did on each,
 * its questions to the team, and replying by hand.
 *
 * Seeing it is Support's view grant; replying, answering the agent and closing are Support's edit
 * grant. The mailbox itself is read by services/email-inbox, the answers by services/email-agent.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/connection');
const { hasPermission } = require('../utils/permissions');
const inbox = require('../services/email-inbox');
const emailAgent = require('../services/email-agent');

const who = (req) => req.user?.username || 'someone';
const fail = (res, err, what) => {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(`support email: ${what}:`, err);
    res.status(500).json({ error: `Could not ${what}` });
};
const safeJson = (v) => { try { return typeof v === 'string' ? (JSON.parse(v || '[]') || []) : (v || []); } catch { return []; } };

router.use(async (req, res, next) => {
    try {
        if (!await hasPermission(req, 'can_view_support')) return res.status(403).json({ error: 'Access denied' });
        next();
    } catch (err) { next(err); }
});
const canEdit = async (req, res, next) => {
    try {
        if (!await hasPermission(req, 'can_edit_support')) return res.status(403).json({ error: 'You can view support but not reply' });
        next();
    } catch (err) { next(err); }
};

const LAST = (col) => `(SELECT m.${col} FROM email_messages m WHERE m.thread_id = t.id AND m.status <> 'failed' ORDER BY m.created_at DESC, m.id DESC LIMIT 1)`;
// A customer is waiting on a person: the agent asked, or the customer wrote last and the agent
// isn't going to answer (paused, or switched off).
const VIEWS = {
    needs: (agentOn) => `t.status = 'open' AND (t.ai_state = 'asked' OR (${LAST('direction')} = 'in' AND (t.ai_paused OR NOT ${agentOn})))`,
    ai: () => `EXISTS (SELECT 1 FROM email_messages a WHERE a.thread_id = t.id AND a.sender_type = 'ai') OR t.ai_state IN ('asked','closed')`,
    open: () => `t.status = 'open'`,
    closed: () => `t.status = 'closed'`,
    all: () => 'TRUE',
};

/** GET /api/support-email/threads?view=needs|ai|open|closed|all&search= */
router.get('/threads', async (req, res) => {
    try {
        const on = (await emailAgent.status()).on;
        const agentOn = on ? 'TRUE' : 'FALSE';
        const view = VIEWS[req.query.view] ? req.query.view : 'open';
        const params = [];
        let where = `(${VIEWS[view](agentOn)})`;
        const q = String(req.query.search || '').trim();
        if (q) {
            params.push(`%${q.toLowerCase()}%`);
            where += ` AND (LOWER(t.customer_email) LIKE $1 OR LOWER(COALESCE(t.customer_name,'')) LIKE $1 OR LOWER(COALESCE(t.subject,'')) LIKE $1)`;
        }
        const rows = (await db.query(
            `SELECT t.id, t.subject, t.customer_email, t.customer_name, t.status, t.ai_state, t.ai_question, t.ai_paused,
                    t.last_message_at, t.last_inbound_at, ${LAST('direction')} AS last_direction, ${LAST('sender_type')} AS last_sender,
                    LEFT(${LAST('body')}, 160) AS preview
               FROM email_threads t WHERE ${where}
              ORDER BY t.last_message_at DESC NULLS LAST LIMIT 200`, params)).rows;
        const counts = (await db.query(
            `SELECT COUNT(*) FILTER (WHERE ${VIEWS.needs(agentOn)})::int AS needs,
                    COUNT(*) FILTER (WHERE ${VIEWS.open()})::int AS open
               FROM email_threads t`)).rows[0];
        res.json({ threads: rows, counts, agent_on: on, mailbox: await inbox.state() });
    } catch (err) { fail(res, err, 'load the emails'); }
});

/** GET /api/support-email/count — for the sidebar: threads needing a person. */
router.get('/count', async (req, res) => {
    try {
        const on = (await emailAgent.status()).on ? 'TRUE' : 'FALSE';
        const r = (await db.query(`SELECT COUNT(*)::int AS n FROM email_threads t WHERE ${VIEWS.needs(on)}`)).rows[0];
        res.json({ needs: r.n });
    } catch (err) { fail(res, err, 'count the emails'); }
});

/** GET /api/support-email/threads/:id */
router.get('/threads/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10) || 0;
        const thread = (await db.query('SELECT * FROM email_threads WHERE id = $1', [id])).rows[0];
        if (!thread) return res.status(404).json({ error: 'That email is gone' });
        const messages = (await db.query(
            `SELECT id, direction, sender_type, sender_user, from_email, from_name, subject, body, attachments, status, error, created_at
               FROM email_messages WHERE thread_id = $1 ORDER BY created_at, id`, [id])).rows.map(m => ({ ...m, attachments: safeJson(m.attachments) }));
        const tickets = (await db.query(
            `SELECT id, ref_no, order_number, reason, status, progress FROM support_tickets
              WHERE email_thread_id = $1 OR LOWER(customer_email) = $2 ORDER BY id DESC LIMIT 10`, [id, thread.customer_email])).rows;
        res.json({ thread, messages, tickets, agent: await emailAgent.status() });
    } catch (err) { fail(res, err, 'open the email'); }
});

/** POST /api/support-email/threads/:id/reply { body } — a person replies. */
router.post('/threads/:id/reply', canEdit, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10) || 0;
        const body = String(req.body?.body || '').trim();
        if (!body) return res.status(400).json({ error: 'Write the reply first' });
        const msg = await inbox.reply(id, body.slice(0, 20000), { type: 'user', user: who(req) });
        // A person answered: whatever the agent asked is settled.
        await db.query(`UPDATE email_threads SET ai_state = NULL, ai_question = NULL, assigned_to = COALESCE(assigned_to, $2) WHERE id = $1`, [id, who(req)]);
        res.json({ message: msg });
    } catch (err) { fail(res, err, 'send the reply'); }
});

/** POST /api/support-email/threads/:id/answer { answer, remember } — answer the agent's question. */
router.post('/threads/:id/answer', canEdit, async (req, res) => {
    try {
        const out = await emailAgent.answer(parseInt(req.params.id, 10) || 0, {
            answer: req.body?.answer, remember: !!req.body?.remember, by: who(req),
        });
        res.json(out);
    } catch (err) { fail(res, err, 'pass on the answer'); }
});

/** POST /api/support-email/threads/:id/state { status?, ai_paused? } */
router.post('/threads/:id/state', canEdit, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10) || 0;
        const v = req.body || {};
        if (v.status && !['open', 'closed'].includes(v.status)) return res.status(400).json({ error: 'Open or closed' });
        const row = (await db.query(
            `UPDATE email_threads SET status = COALESCE($2, status), ai_paused = COALESCE($3, ai_paused),
                    ai_state = CASE WHEN $2 = 'closed' THEN NULL ELSE ai_state END,
                    ai_question = CASE WHEN $2 = 'closed' THEN NULL ELSE ai_question END
              WHERE id = $1 RETURNING *`,
            [id, v.status || null, typeof v.ai_paused === 'boolean' ? v.ai_paused : null])).rows[0];
        if (!row) return res.status(404).json({ error: 'That email is gone' });
        res.json({ thread: row });
    } catch (err) { fail(res, err, 'update the email'); }
});

/** POST /api/support-email/threads/:id/run — let the agent answer it now. */
router.post('/threads/:id/run', canEdit, async (req, res) => {
    try {
        res.json(await emailAgent.run(parseInt(req.params.id, 10) || 0));
    } catch (err) { fail(res, err, 'run the agent'); }
});

/** POST /api/support-email/sync — read the mailbox now. */
router.post('/sync', canEdit, async (req, res) => {
    try {
        const fresh = await inbox.sync();
        fresh.forEach(id => emailAgent.schedule(id, 5_000));
        res.json({ new_threads: fresh.length, mailbox: await inbox.state() });
    } catch (err) { fail(res, err, 'read the mailbox'); }
});

module.exports = router;
