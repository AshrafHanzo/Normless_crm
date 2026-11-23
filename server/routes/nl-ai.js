/**
 * The Normless AI agent: its settings, what it was taught, its questions to the team, and what
 * it costs. Mounted at /api/nl-whatsapp/nl/ai (behind the Normless inbox's own access check).
 *
 * Anyone on the Normless inbox can work with it on a chat: answer its question, tell it what to
 * say, pause it, or correct one of its replies (which teaches it). Its page — switching it on,
 * the playbook, every question, the spend — needs the "AI agent" grant (can_manage_nl_ai).
 */

const express = require('express');
const db = require('../db/connection');
const { hasPermission } = require('../utils/permissions');
const agent = require('../services/nl-agent');
const usage = require('../services/ai-usage');
const { readSettings } = require('../services/nl-settings');

const router = express.Router();
const str = (v, max = 2000) => String(v ?? '').trim().slice(0, max);
const who = (req) => req.user?.username || null;
const fail = (res, err, what) => {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    console.error(`nl ai ${what} error:`, err);
    res.status(500).json({ error: `Could not ${what}` });
};

const manage = async (req, res, next) => ((await hasPermission(req, 'can_manage_nl_ai')) ? next()
    : res.status(403).json({ error: 'You don’t have access to the AI agent page' }));

/** A chat on this inbox, or a 404. */
async function chatOf(req, res) {
    const id = parseInt(req.params.id, 10) || 0;
    const c = (await db.query(`SELECT id, ai_paused, assigned_to FROM wa_conversations WHERE id = $1 AND line_id = $2`, [id, req.waLine.id])).rows[0];
    if (!c) res.status(404).json({ error: 'No such chat' });
    return c;
}

const lessonOut = (l) => ({ ...l, expired: !!(l.expires_at && new Date(l.expires_at) < new Date()) });

/* ── The page ──────────────────────────────────────────────────────────────────────────────── */

router.get('/overview', manage, async (req, res) => {
    try {
        const s = await readSettings(req.waLine.id);
        const [st, counts] = await Promise.all([
            agent.status(req.waLine.id),
            db.query(`SELECT
                    (SELECT COUNT(*) FROM nl_ai_questions WHERE line_id = $1 AND status = 'open')::int AS open_questions,
                    (SELECT COUNT(*) FROM nl_ai_lessons WHERE line_id = $1 AND active AND kind = 'lesson')::int AS lessons,
                    (SELECT COUNT(*) FROM nl_ai_lessons WHERE line_id = $1 AND active AND kind = 'announcement' AND (expires_at IS NULL OR expires_at > now()))::int AS announcements,
                    (SELECT COUNT(DISTINCT conversation_id) FROM wa_messages m JOIN wa_conversations c ON c.id = m.conversation_id
                      WHERE c.line_id = $1 AND m.sender_user = 'ai-agent' AND m.created_at > now() - INTERVAL '1 day')::int AS chats_today`, [req.waLine.id]),
        ]);
        res.json({
            settings: s.agent, status: st, models: agent.MODELS, key_set: !!process.env.ANTHROPIC_API_KEY,
            month_spend: await usage.monthSpend(), ...counts.rows[0],
        });
    } catch (err) { fail(res, err, 'load the AI agent'); }
});

router.put('/settings', manage, async (req, res) => {
    try {
        const v = req.body || {};
        const num = (x, min, max, d) => { const n = Number(x); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
        const agentSettings = {
            enabled: !!v.enabled,
            model: agent.MODELS.includes(v.model) ? v.model : agent.MODELS[0],
            budget_usd: Math.round(num(v.budget_usd, 0, 100000, 50) * 100) / 100,
            usd_inr: Math.round(num(v.usd_inr, 1, 1000, 88) * 100) / 100,
            quiet_minutes: Math.round(num(v.quiet_minutes, 0, 1440, 30)),
            close_when_done: v.close_when_done !== false,
        };
        if (agentSettings.enabled && !process.env.ANTHROPIC_API_KEY) {
            return res.status(400).json({ error: 'Add the Anthropic API key to the server first (ANTHROPIC_API_KEY), then switch the agent on.' });
        }
        await db.transaction(async (c) => {
            const row = (await c.query('SELECT settings FROM wa_lines WHERE id = $1 FOR UPDATE', [req.waLine.id])).rows[0];
            let all = {};
            try { all = JSON.parse(row?.settings || '{}') || {}; } catch { all = {}; }
            all.agent = agentSettings;
            all.updated_by = who(req);
            all.updated_at = new Date().toISOString();
            await c.query('UPDATE wa_lines SET settings = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [req.waLine.id, JSON.stringify(all)]);
        });
        res.json({ settings: agentSettings, status: await agent.status(req.waLine.id) });
    } catch (err) { fail(res, err, 'save the settings'); }
});

router.get('/spend', manage, async (req, res) => {
    try {
        const s = await readSettings(req.waLine.id);
        res.json({ ...(await usage.summary(req.query.days)), budget_usd: s.agent.budget_usd, usd_inr: s.agent.usd_inr });
    } catch (err) { fail(res, err, 'load the spend'); }
});

router.post('/try', manage, async (req, res) => {
    try {
        const turns = (Array.isArray(req.body?.turns) ? req.body.turns : [])
            .map(t => ({ role: t?.role === 'agent' ? 'agent' : 'customer', text: str(t?.text) })).filter(t => t.text).slice(-20);
        if (!turns.length || turns[turns.length - 1].role !== 'customer') return res.status(400).json({ error: 'Write something as the customer first' });
        const out = await agent.tryIt(turns);
        if (out.error) return res.status(400).json(out);
        res.json(out);
    } catch (err) { fail(res, err, 'try the agent'); }
});

/* ── The playbook ──────────────────────────────────────────────────────────────────────────── */

router.get('/lessons', manage, async (req, res) => {
    try {
        const r = await db.query(
            `SELECT id, kind, title, body, active, expires_at, source, conversation_id, created_by, created_at, updated_at
               FROM nl_ai_lessons WHERE line_id = $1 ORDER BY active DESC, kind DESC, id DESC`, [req.waLine.id]);
        res.json({ lessons: r.rows.map(lessonOut) });
    } catch (err) { fail(res, err, 'load the playbook'); }
});

function cleanLesson(b) {
    const body = str(b?.body, 3000);
    if (!body) throw Object.assign(new Error('Write what the agent should do'), { status: 400 });
    const kind = b?.kind === 'announcement' ? 'announcement' : 'lesson';
    const until = b?.expires_at ? new Date(b.expires_at) : null;
    if (until && Number.isNaN(until.getTime())) throw Object.assign(new Error('That end date is not a date'), { status: 400 });
    return { kind, title: str(b?.title, 200) || null, body, active: b?.active !== false, expires_at: until ? until.toISOString() : null };
}

router.post('/lessons', manage, async (req, res) => {
    try {
        const l = cleanLesson(req.body);
        const r = await db.query(
            `INSERT INTO nl_ai_lessons (line_id, kind, title, body, active, expires_at, source, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,'manual',$7) RETURNING *`,
            [req.waLine.id, l.kind, l.title, l.body, l.active, l.expires_at, who(req)]);
        res.status(201).json({ lesson: lessonOut(r.rows[0]) });
    } catch (err) { fail(res, err, 'save the lesson'); }
});

router.put('/lessons/:id', manage, async (req, res) => {
    try {
        const l = cleanLesson(req.body);
        const r = await db.query(
            `UPDATE nl_ai_lessons SET kind = $3, title = $4, body = $5, active = $6, expires_at = $7, updated_at = now()
              WHERE id = $1 AND line_id = $2 RETURNING *`,
            [parseInt(req.params.id, 10) || 0, req.waLine.id, l.kind, l.title, l.body, l.active, l.expires_at]);
        if (!r.rows[0]) return res.status(404).json({ error: 'That lesson is gone' });
        res.json({ lesson: lessonOut(r.rows[0]) });
    } catch (err) { fail(res, err, 'save the lesson'); }
});

router.delete('/lessons/:id', manage, async (req, res) => {
    try {
        await db.query(`DELETE FROM nl_ai_lessons WHERE id = $1 AND line_id = $2`, [parseInt(req.params.id, 10) || 0, req.waLine.id]);
        res.json({ ok: true });
    } catch (err) { fail(res, err, 'delete the lesson'); }
});

/* ── Its questions to the team ─────────────────────────────────────────────────────────────── */

router.get('/questions', manage, async (req, res) => {
    try {
        const status = ['open', 'answered', 'dismissed'].includes(req.query.status) ? req.query.status : null;
        const r = await db.query(
            `SELECT q.*, k.profile_name, NULLIF(TRIM(CONCAT(cu.first_name, ' ', cu.last_name)), '') AS customer_name, c.assigned_to,
                    (SELECT body FROM wa_messages m WHERE m.conversation_id = q.conversation_id AND m.direction = 'in'
                      ORDER BY COALESCE(m.sent_at, m.created_at) DESC, m.id DESC LIMIT 1) AS last_customer_message
               FROM nl_ai_questions q JOIN wa_conversations c ON c.id = q.conversation_id
               JOIN wa_contacts k ON k.id = c.contact_id LEFT JOIN customers cu ON cu.id = k.customer_id
              WHERE q.line_id = $1 AND ($2::text IS NULL OR q.status = $2)
              ORDER BY (q.status = 'open') DESC, q.created_at DESC LIMIT 200`, [req.waLine.id, status]);
        res.json({ questions: r.rows });
    } catch (err) { fail(res, err, 'load the questions'); }
});

router.post('/questions/:id/answer', async (req, res) => {
    try {
        const out = await agent.answer(parseInt(req.params.id, 10) || 0, {
            answer: req.body?.answer, remember: !!req.body?.remember, lesson: str(req.body?.lesson, 3000) || null, by: who(req),
        });
        res.json(out);
    } catch (err) { fail(res, err, 'send the answer'); }
});

router.post('/questions/:id/dismiss', async (req, res) => {
    try {
        const r = await db.query(
            `UPDATE nl_ai_questions SET status = 'dismissed', answered_by = $3, answered_at = now()
              WHERE id = $1 AND line_id = $2 AND status = 'open' RETURNING id`, [parseInt(req.params.id, 10) || 0, req.waLine.id, who(req)]);
        if (!r.rows[0]) return res.status(409).json({ error: 'Somebody already dealt with this' });
        res.json({ ok: true });
    } catch (err) { fail(res, err, 'dismiss the question'); }
});

/* ── On one chat, from the inbox ───────────────────────────────────────────────────────────── */

router.get('/conversations/:id', async (req, res) => {
    try {
        const c = await chatOf(req, res); if (!c) return;
        const q = (await db.query(
            `SELECT id, question, context, created_at FROM nl_ai_questions WHERE conversation_id = $1 AND status = 'open' ORDER BY id DESC LIMIT 1`, [c.id])).rows[0] || null;
        const st = await agent.status(req.waLine.id);
        res.json({ on: st.on, why: st.why || null, paused: c.ai_paused, question: q, canManage: await hasPermission(req, 'can_manage_nl_ai') });
    } catch (err) { fail(res, err, 'load the agent on this chat'); }
});

router.post('/conversations/:id/pause', async (req, res) => {
    try {
        const c = await chatOf(req, res); if (!c) return;
        const paused = !!req.body?.paused;
        await db.query(`UPDATE wa_conversations SET ai_paused = $2, updated_at = now() WHERE id = $1`, [c.id, paused]);
        await db.query(`INSERT INTO wa_activity (conversation_id, kind, body, actor) VALUES ($1,'ai',$2,$3)`,
            [c.id, `${String(who(req) || '').split('@')[0]} ${paused ? 'paused' : 'resumed'} the AI agent on this chat`, who(req)]);
        res.json({ paused });
    } catch (err) { fail(res, err, 'change the agent on this chat'); }
});

/** "Tell the AI": it writes and sends a reply that does what the person said. */
router.post('/conversations/:id/instruct', async (req, res) => {
    try {
        const c = await chatOf(req, res); if (!c) return;
        const instruction = str(req.body?.instruction, 2000);
        if (!instruction) return res.status(400).json({ error: 'Say what the agent should tell the customer' });
        await db.query(`INSERT INTO wa_activity (conversation_id, kind, body, actor) VALUES ($1,'ai',$2,$3)`,
            [c.id, `${String(who(req) || '').split('@')[0]} told the AI agent: ${instruction.slice(0, 300)}`, who(req)]);
        const out = await agent.run(c.id, { force: true, task: `${String(who(req) || '').split('@')[0]} on the team says: ${instruction}\nDo what they say: write the reply to the customer now.` });
        res.json(out);
    } catch (err) { fail(res, err, 'pass that to the agent'); }
});

/** "Answer now": run it on this chat straight away, if there is anything to answer. */
router.post('/conversations/:id/run', async (req, res) => {
    try {
        const c = await chatOf(req, res); if (!c) return;
        res.json(await agent.run(c.id, { force: true }));
    } catch (err) { fail(res, err, 'run the agent'); }
});

/** "Teach": what the agent should have said instead. Saved as a lesson it uses from now on. */
router.post('/messages/:id/teach', async (req, res) => {
    try {
        const correction = str(req.body?.correction, 3000);
        if (!correction) return res.status(400).json({ error: 'Write what it should have said or done' });
        const m = (await db.query(
            `SELECT m.id, m.conversation_id, m.body, m.created_at FROM wa_messages m JOIN wa_conversations c ON c.id = m.conversation_id
              WHERE m.id = $1 AND c.line_id = $2 AND m.sender_type = 'ai'`, [parseInt(req.params.id, 10) || 0, req.waLine.id])).rows[0];
        if (!m) return res.status(404).json({ error: 'That isn’t one of the agent’s messages' });
        const asked = (await db.query(
            `SELECT body FROM wa_messages WHERE conversation_id = $1 AND direction = 'in' AND created_at <= $2
              ORDER BY created_at DESC, id DESC LIMIT 1`, [m.conversation_id, m.created_at])).rows[0]?.body || '';
        const body = `${asked ? `When a customer says something like "${String(asked).slice(0, 300)}", ` : ''}don't reply "${String(m.body).slice(0, 300)}". Instead: ${correction}`;
        const r = await db.query(
            `INSERT INTO nl_ai_lessons (line_id, kind, title, body, source, conversation_id, created_by)
             VALUES ($1,'lesson',$2,$3,'correction',$4,$5) RETURNING *`,
            [req.waLine.id, str(req.body?.title, 200) || 'Correction from a chat', body, m.conversation_id, who(req)]);
        await db.query(`INSERT INTO wa_activity (conversation_id, kind, body, actor) VALUES ($1,'ai',$2,$3)`,
            [m.conversation_id, `${String(who(req) || '').split('@')[0]} corrected the AI agent: ${correction.slice(0, 200)}`, who(req)]);
        res.status(201).json({ lesson: lessonOut(r.rows[0]) });
    } catch (err) { fail(res, err, 'save the correction'); }
});

module.exports = router;
