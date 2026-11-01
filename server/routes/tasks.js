/**
 * Tasks: boards, their tasks, sprints, comments, files and analytics — shared by Normless and
 * Crewfit.
 *
 * Who sees a board: its members and lead, and anyone with can_manage_boards (who can also make
 * boards). A board's lead runs that board — members, sprints, settings — without the grant.
 * Every change is written to task_activity, and the assignee, reporter and watchers are told.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db/connection');
const { hasPermission } = require('../utils/permissions');
const teamNotify = require('../services/team-notify');
const { mentionsIn, handleOf } = require('../services/notify');

const router = express.Router();

const STATUSES = ['ideas', 'todo', 'in_progress', 'hold', 'blocked', 'done', 'rejected'];
const STATUS_LABEL = { ideas: 'Ideas', todo: 'To do', in_progress: 'In progress', hold: 'Hold', blocked: 'Blocked', done: 'Done', rejected: 'Rejected' };
// Moving here asks for a reason, shown on the card.
const NEEDS_REASON = ['hold', 'blocked', 'rejected'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const COMPANIES = ['normless', 'crewfit', 'both'];
const REPEATS = ['day', 'weekday', 'week', 'month'];
const FILES = path.join(__dirname, '..', 'storage', 'team', 'tasks');

const me = (req) => req.user?.username || '';
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const clean = (v) => { const s = String(v ?? '').trim(); return s || null; };
const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const lower = (s) => String(s || '').toLowerCase();

router.use(async (req, res, next) => {
    try {
        if (!await hasPermission(req, 'can_view_tasks')) return res.status(403).json({ error: 'Access denied' });
        req.canManage = await hasPermission(req, 'can_manage_boards');
        next();
    } catch (err) { next(err); }
});

// Express 5 has no inline param patterns, so a non-numeric :id ("mine", "analytics") passes on to
// the route that names it.
router.param('id', (req, res, next, id) => (/^\d+$/.test(id) ? next() : next('route')));

const BOARD_COLS = `b.id, b.key, b.name, b.company, b.lead_username, b.members, b.use_sprints, b.sprint_weeks, b.estimate_kind,
    b.wip_limits, b.archived, b.created_by, b.created_at`;

const onBoard = (req, b) => req.canManage || lower(b.lead_username) === lower(me(req)) || (b.members || []).some(m => lower(m) === lower(me(req)));
const runsBoard = (req, b) => req.canManage || lower(b.lead_username) === lower(me(req));

async function boardFor(req, id) {
    const b = (await db.query(`SELECT ${BOARD_COLS} FROM task_boards b WHERE b.id = $1`, [id])).rows[0];
    if (!b || !onBoard(req, b)) return null;
    return b;
}

const TASK_COLS = `t.id, t.board_id, t.number, t.title, t.description, t.status, t.status_reason, t.priority, t.assignee, t.reporter,
    TO_CHAR(t.due_on, 'YYYY-MM-DD') AS due_on, t.estimate, t.labels, t.sprint_id, t.parent_id, t.position, t.checklist, t.links,
    t.watchers, t.repeat, t.started_at, t.done_at, t.created_at, t.updated_at, b.key AS board_key, b.name AS board_name`;

async function taskFor(req, id) {
    const t = (await db.query(`SELECT ${TASK_COLS} FROM tasks t JOIN task_boards b ON b.id = t.board_id WHERE t.id = $1`, [id])).rows[0];
    if (!t) return null;
    const b = await boardFor(req, t.board_id);
    // Someone a task is assigned to can open it even when they are not on the board.
    if (!b && lower(t.assignee) !== lower(me(req))) return null;
    return t;
}

const ref = (t) => `${t.board_key}-${t.number}`;
const linkOf = (t) => `/team/tasks?board=${t.board_id}&task=${t.id}`;
/** Everyone who hears about a task: assignee, reporter, watchers — never the person acting. */
const audience = (t) => [t.assignee, t.reporter, ...(t.watchers || [])].filter(Boolean);

async function log(taskId, actor, what, from, to) {
    await db.query(`INSERT INTO task_activity (task_id, actor, what, from_val, to_val) VALUES ($1,$2,$3,$4,$5)`,
        [taskId, actor, what, from == null ? null : String(from), to == null ? null : String(to)]);
}

/* ───────────────────────────── boards ───────────────────────────── */

// GET /api/tasks/boards — the boards I can see, with open counts
router.get('/boards', async (req, res) => {
    try {
        const rows = (await db.query(
            `SELECT ${BOARD_COLS},
                    (SELECT COUNT(*)::int FROM tasks t WHERE t.board_id = b.id AND t.status NOT IN ('done','rejected')) AS open,
                    (SELECT COUNT(*)::int FROM tasks t WHERE t.board_id = b.id AND t.status NOT IN ('done','rejected','ideas')
                        AND t.due_on < (NOW() AT TIME ZONE 'Asia/Kolkata')::date) AS late,
                    (SELECT row_to_json(s) FROM (SELECT id, name, TO_CHAR(starts_on, 'YYYY-MM-DD') AS starts_on, TO_CHAR(ends_on, 'YYYY-MM-DD') AS ends_on, goal
                        FROM task_sprints WHERE board_id = b.id AND status = 'active' LIMIT 1) s) AS sprint
               FROM task_boards b WHERE NOT b.archived ORDER BY b.name`)).rows;
        const users = (await db.query(
            `SELECT username FROM admin_users WHERE COALESCE(is_active, true) AND (role IN ('owner','admin') OR COALESCE(can_view_tasks, true))
              ORDER BY username`)).rows.map(r => r.username);
        res.json({ boards: rows.filter(b => onBoard(req, b)), users, canCreate: req.canManage, statuses: STATUSES, statusLabels: STATUS_LABEL });
    } catch (err) {
        console.error('tasks boards error:', err);
        res.status(500).json({ error: 'Failed to load boards' });
    }
});

function boardFields(b) {
    const members = [...new Set((Array.isArray(b.members) ? b.members : []).map(clean).filter(Boolean))];
    const wip = {};
    for (const s of STATUSES) { const n = num(b.wip_limits?.[s]); if (n && n > 0) wip[s] = Math.floor(n); }
    return {
        name: clean(b.name), company: COMPANIES.includes(b.company) ? b.company : 'both', lead_username: clean(b.lead_username),
        members, use_sprints: b.use_sprints !== false, sprint_weeks: Math.min(6, Math.max(1, num(b.sprint_weeks) || 2)),
        estimate_kind: ['points', 'hours', 'none'].includes(b.estimate_kind) ? b.estimate_kind : 'points', wip_limits: JSON.stringify(wip),
    };
}

// POST /api/tasks/boards — { key, name, company, lead_username, members[], use_sprints, sprint_weeks, estimate_kind, wip_limits }
router.post('/boards', async (req, res) => {
    if (!req.canManage) return res.status(403).json({ error: 'Creating boards needs the "create and run boards" permission' });
    const f = boardFields(req.body || {});
    const key = String(req.body?.key || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (!f.name) return res.status(400).json({ error: 'Name the board' });
    if (key.length < 2) return res.status(400).json({ error: 'A short key of 2–6 letters, like MKT' });
    try {
        if (f.lead_username && !f.members.includes(f.lead_username)) f.members.push(f.lead_username);
        const r = await db.query(
            `INSERT INTO task_boards (key, name, company, lead_username, members, use_sprints, sprint_weeks, estimate_kind, wip_limits, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
            [key, f.name, f.company, f.lead_username, f.members, f.use_sprints, f.sprint_weeks, f.estimate_kind, f.wip_limits, me(req)]);
        res.json({ success: true, id: r.rows[0].id });
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ error: `The key ${key} is already used by another board` });
        console.error('tasks board create error:', err);
        res.status(500).json({ error: 'Failed to create the board' });
    }
});

// PUT /api/tasks/boards/:id — settings, members; archive with { archived: true }
router.put('/boards/:id', async (req, res) => {
    try {
        const b = await boardFor(req, req.params.id);
        if (!b) return res.status(404).json({ error: 'Board not found' });
        if (!runsBoard(req, b)) return res.status(403).json({ error: 'Only the board lead can change the board' });
        const f = boardFields({ ...b, ...req.body });
        if (!f.name) return res.status(400).json({ error: 'Name the board' });
        if (f.lead_username && !f.members.includes(f.lead_username)) f.members.push(f.lead_username);
        await db.query(
            `UPDATE task_boards SET name=$1, company=$2, lead_username=$3, members=$4, use_sprints=$5, sprint_weeks=$6,
                 estimate_kind=$7, wip_limits=$8, archived=$9 WHERE id=$10`,
            [f.name, f.company, f.lead_username, f.members, f.use_sprints, f.sprint_weeks, f.estimate_kind, f.wip_limits,
             req.body.archived === undefined ? b.archived : !!req.body.archived, b.id]);
        res.json({ success: true });
    } catch (err) {
        console.error('tasks board update error:', err);
        res.status(500).json({ error: 'Failed to save the board' });
    }
});

// GET /api/tasks/boards/:id — the board, its sprints and its tasks
// ?view=board (active sprint, or everything open without sprints) | backlog (no sprint) | all
router.get('/boards/:id', async (req, res) => {
    try {
        const b = await boardFor(req, req.params.id);
        if (!b) return res.status(404).json({ error: 'Board not found' });
        const sprints = (await db.query(
            `SELECT id, name, goal, TO_CHAR(starts_on, 'YYYY-MM-DD') AS starts_on, TO_CHAR(ends_on, 'YYYY-MM-DD') AS ends_on,
                    status, planned_points FROM task_sprints WHERE board_id = $1 AND status <> 'closed' ORDER BY starts_on`, [b.id])).rows;
        const active = sprints.find(s => s.status === 'active');
        const rows = (await db.query(
            `SELECT ${TASK_COLS},
                    (SELECT COUNT(*)::int FROM task_comments c WHERE c.task_id = t.id) AS comments,
                    (SELECT COUNT(*)::int FROM task_files f WHERE f.task_id = t.id) AS files
               FROM tasks t JOIN task_boards b ON b.id = t.board_id
              WHERE t.board_id = $1 AND (t.status NOT IN ('done','rejected') OR t.done_at > NOW() - INTERVAL '30 days' OR t.sprint_id = $2)
              ORDER BY t.position, t.id`, [b.id, active?.id || null])).rows;
        const labels = [...new Set(rows.flatMap(t => t.labels || []))].sort();
        res.json({ board: b, sprints, activeSprint: active || null, tasks: rows, labels, canRun: runsBoard(req, b),
            statuses: STATUSES, statusLabels: STATUS_LABEL });
    } catch (err) {
        console.error('tasks board error:', err);
        res.status(500).json({ error: 'Failed to load the board' });
    }
});

/* ───────────────────────────── tasks ───────────────────────────── */

// GET /api/tasks/mine — my open tasks across boards
router.get('/mine', async (req, res) => {
    try {
        const rows = (await db.query(
            `SELECT ${TASK_COLS} FROM tasks t JOIN task_boards b ON b.id = t.board_id
              WHERE LOWER(t.assignee) = LOWER($1) AND NOT b.archived
                AND (t.status NOT IN ('done','rejected') OR t.done_at > NOW() - INTERVAL '7 days')
              ORDER BY (t.status IN ('done','rejected')), t.due_on NULLS LAST, t.id`, [me(req)])).rows;
        res.json({ tasks: rows, statusLabels: STATUS_LABEL });
    } catch (err) {
        console.error('tasks mine error:', err);
        res.status(500).json({ error: 'Failed to load your tasks' });
    }
});

function taskFields(b, board) {
    const out = {};
    if (b.title !== undefined) out.title = clean(b.title);
    if (b.description !== undefined) out.description = clean(b.description);
    if (b.priority !== undefined) out.priority = PRIORITIES.includes(b.priority) ? b.priority : 'medium';
    if (b.assignee !== undefined) out.assignee = clean(b.assignee);
    if (b.due_on !== undefined) out.due_on = isDate(b.due_on) ? b.due_on : null;
    if (b.estimate !== undefined) out.estimate = board.estimate_kind === 'none' ? null : num(b.estimate);
    if (b.labels !== undefined) out.labels = [...new Set((Array.isArray(b.labels) ? b.labels : String(b.labels || '').split(','))
        .map(s => String(s).trim()).filter(Boolean))].slice(0, 8);
    if (b.sprint_id !== undefined) out.sprint_id = num(b.sprint_id);
    if (b.parent_id !== undefined) out.parent_id = num(b.parent_id);
    if (b.checklist !== undefined) out.checklist = JSON.stringify((Array.isArray(b.checklist) ? b.checklist : [])
        .map(i => ({ text: String(i.text || '').trim().slice(0, 300), done: !!i.done })).filter(i => i.text).slice(0, 50));
    if (b.links !== undefined) out.links = JSON.stringify((Array.isArray(b.links) ? b.links : [])
        .map(l => ({ label: String(l.label || '').trim().slice(0, 120), url: String(l.url || '').trim().slice(0, 500) }))
        .filter(l => l.label && (/^\/[^/]/.test(l.url) || /^https?:\/\//.test(l.url) || !l.url)).slice(0, 20));
    if (b.watchers !== undefined) out.watchers = [...new Set((Array.isArray(b.watchers) ? b.watchers : []).map(clean).filter(Boolean))];
    if (b.repeat !== undefined) {
        out.repeat = b.repeat && REPEATS.includes(b.repeat.every)
            ? JSON.stringify({ every: b.repeat.every, next_on: isDate(b.repeat.next_on) ? b.repeat.next_on : null }) : null;
    }
    return out;
}

// POST /api/tasks — { board_id, title, status, … }
router.post('/', async (req, res) => {
    try {
        const b = await boardFor(req, req.body?.board_id);
        if (!b) return res.status(404).json({ error: 'Board not found' });
        const f = taskFields(req.body, b);
        if (!f.title) return res.status(400).json({ error: 'Give the task a title' });
        const status = STATUSES.includes(req.body.status) ? req.body.status : 'todo';
        const id = await db.transaction(async (c) => {
            const n = (await c.query('UPDATE task_boards SET next_no = next_no + 1 WHERE id = $1 RETURNING next_no - 1 AS n', [b.id])).rows[0].n;
            const pos = (await c.query('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM tasks WHERE board_id = $1 AND status = $2', [b.id, status])).rows[0].p;
            const cols = Object.keys(f);
            const r = await c.query(
                `INSERT INTO tasks (board_id, number, status, reporter, position, watchers${cols.length ? `, ${cols.filter(k => k !== 'watchers').join(', ')}` : ''})
                 VALUES ($1, $2, $3, $4, $5, $6${cols.filter(k => k !== 'watchers').map((_, i) => `, $${i + 7}`).join('')}) RETURNING id`,
                [b.id, n, status, me(req), pos, f.watchers || [], ...cols.filter(k => k !== 'watchers').map(k => f[k])]);
            return r.rows[0].id;
        });
        await log(id, me(req), 'created');
        const t = await taskFor(req, id);
        if (t.assignee) {
            await teamNotify.tell({ usernames: [t.assignee], event: 'assigned', actor: me(req),
                title: `${handleOf(me(req))} assigned you ${ref(t)}`, body: t.title, link: linkOf(t),
                subject: `[${ref(t)}] ${handleOf(me(req))} assigned you: ${t.title}`, group: `task:${t.id}` });
        }
        res.json({ success: true, task: t });
    } catch (err) {
        console.error('tasks create error:', err);
        res.status(500).json({ error: 'Failed to create the task' });
    }
});

// GET /api/tasks/:id — the task with comments, files, activity and sub-tasks
router.get('/:id', async (req, res) => {
    try {
        const t = await taskFor(req, req.params.id);
        if (!t) return res.status(404).json({ error: 'Task not found' });
        const [comments, files, activity, subtasks, board] = await Promise.all([
            db.query('SELECT id, author, body, created_at FROM task_comments WHERE task_id = $1 ORDER BY created_at', [t.id]),
            db.query('SELECT id, name, size, uploaded_by, created_at FROM task_files WHERE task_id = $1 ORDER BY created_at', [t.id]),
            db.query('SELECT actor, what, from_val, to_val, created_at FROM task_activity WHERE task_id = $1 ORDER BY created_at DESC LIMIT 100', [t.id]),
            db.query(`SELECT t.id, t.number, t.title, t.status, t.assignee FROM tasks t WHERE t.parent_id = $1 ORDER BY t.id`, [t.id]),
            db.query(`SELECT ${BOARD_COLS} FROM task_boards b WHERE b.id = $1`, [t.board_id]),
        ]);
        const sprints = (await db.query(
            `SELECT id, name, status FROM task_sprints WHERE board_id = $1 AND status <> 'closed' ORDER BY starts_on`, [t.board_id])).rows;
        res.json({ task: t, comments: comments.rows, files: files.rows, activity: activity.rows, subtasks: subtasks.rows,
            board: board.rows[0], sprints, statuses: STATUSES, statusLabels: STATUS_LABEL });
    } catch (err) {
        console.error('tasks get error:', err);
        res.status(500).json({ error: 'Failed to load the task' });
    }
});

// PUT /api/tasks/:id — any fields, plus { status, status_reason } and { position }
router.put('/:id', async (req, res) => {
    try {
        const t = await taskFor(req, req.params.id);
        if (!t) return res.status(404).json({ error: 'Task not found' });
        const board = (await db.query(`SELECT ${BOARD_COLS} FROM task_boards b WHERE b.id = $1`, [t.board_id])).rows[0];
        const f = taskFields(req.body || {}, board);
        if (f.title === null) return res.status(400).json({ error: 'The title cannot be empty' });
        const sets = { ...f };
        const status = req.body?.status;
        if (status !== undefined && status !== t.status) {
            if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status' });
            if (NEEDS_REASON.includes(status) && !clean(req.body.status_reason)) {
                return res.status(400).json({ error: `Say why it is ${STATUS_LABEL[status].toLowerCase()}`, needsReason: true });
            }
            // A WIP limit is a nudge for the team, so it is checked but not forced on a lead.
            const limit = Number(board.wip_limits?.[status]) || 0;
            if (limit) {
                const n = (await db.query('SELECT COUNT(*)::int AS n FROM tasks WHERE board_id = $1 AND status = $2', [t.board_id, status])).rows[0].n;
                if (n >= limit && !req.body.overLimit) return res.status(409).json({ error: `${STATUS_LABEL[status]} already has ${n} of its ${limit}`, overLimit: true });
            }
            sets.status = status;
            sets.status_reason = NEEDS_REASON.includes(status) ? clean(req.body.status_reason) : null;
            if (status === 'in_progress' && !t.started_at) sets.started_at = new Date();
            sets.done_at = status === 'done' || status === 'rejected' ? new Date() : null;
        }
        // The reason on a held or blocked task can be changed without moving it.
        else if (req.body?.status_reason !== undefined && NEEDS_REASON.includes(t.status)) sets.status_reason = clean(req.body.status_reason);
        if (req.body?.position !== undefined && num(req.body.position) != null) sets.position = num(req.body.position);
        const cols = Object.keys(sets);
        if (!cols.length) return res.json({ success: true, task: t });
        await db.query(`UPDATE tasks SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = NOW() WHERE id = $${cols.length + 1}`,
            [...cols.map(c => sets[c]), t.id]);

        // History and the people to tell.
        const who = handleOf(me(req));
        if (sets.status) {
            await log(t.id, me(req), 'status', STATUS_LABEL[t.status], STATUS_LABEL[sets.status]);
            await teamNotify.tell({ usernames: audience(t), event: 'status', actor: me(req),
                title: `${ref(t)} moved to ${STATUS_LABEL[sets.status]}`, body: `${t.title}${sets.status_reason ? ` · ${sets.status_reason}` : ''} (by ${who})`,
                link: linkOf(t), subject: `[${ref(t)}] ${t.title}`, group: `task:${t.id}` });
        }
        if (f.assignee !== undefined && lower(f.assignee) !== lower(t.assignee)) {
            await log(t.id, me(req), 'assignee', t.assignee, f.assignee);
            if (f.assignee) {
                await teamNotify.tell({ usernames: [f.assignee], event: 'assigned', actor: me(req),
                    title: `${who} assigned you ${ref(t)}`, body: t.title, link: linkOf(t),
                    subject: `[${ref(t)}] ${who} assigned you: ${t.title}`, group: `task:${t.id}` });
            }
        }
        for (const k of ['title', 'due_on', 'priority', 'estimate', 'sprint_id']) {
            if (f[k] !== undefined && String(f[k] ?? '') !== String(t[k] ?? '')) await log(t.id, me(req), k, t[k], f[k]);
        }
        if (f.due_on !== undefined && String(f.due_on ?? '') !== String(t.due_on ?? '')) {
            await teamNotify.tell({ usernames: audience(t), event: 'status', actor: me(req),
                title: `${ref(t)} is now due ${f.due_on || 'with no date'}`, body: `${t.title} (by ${who})`, link: linkOf(t),
                subject: `[${ref(t)}] ${t.title}`, group: `task:${t.id}` });
        }
        res.json({ success: true, task: await taskFor(req, t.id) });
    } catch (err) {
        console.error('tasks update error:', err);
        res.status(500).json({ error: 'Failed to save the task' });
    }
});

// DELETE /api/tasks/:id — the reporter, the board lead, or a board manager
router.delete('/:id', async (req, res) => {
    try {
        const t = await taskFor(req, req.params.id);
        if (!t) return res.status(404).json({ error: 'Task not found' });
        const board = (await db.query(`SELECT ${BOARD_COLS} FROM task_boards b WHERE b.id = $1`, [t.board_id])).rows[0];
        if (!runsBoard(req, board) && lower(t.reporter) !== lower(me(req))) return res.status(403).json({ error: 'Only whoever created it or the board lead can delete it' });
        await db.query('DELETE FROM tasks WHERE id = $1', [t.id]);
        fs.rm(path.join(FILES, String(t.id)), { recursive: true, force: true }, () => {});
        res.json({ success: true });
    } catch (err) {
        console.error('tasks delete error:', err);
        res.status(500).json({ error: 'Failed to delete the task' });
    }
});

// POST /api/tasks/:id/watch — { watching: bool }
router.post('/:id/watch', async (req, res) => {
    try {
        const t = await taskFor(req, req.params.id);
        if (!t) return res.status(404).json({ error: 'Task not found' });
        const set = new Set(t.watchers || []);
        if (req.body?.watching === false) set.delete(me(req)); else set.add(me(req));
        await db.query('UPDATE tasks SET watchers = $1 WHERE id = $2', [[...set], t.id]);
        res.json({ success: true, watchers: [...set] });
    } catch (err) {
        console.error('tasks watch error:', err);
        res.status(500).json({ error: 'Failed to save' });
    }
});

// POST /api/tasks/:id/comments — { body }; @handles notify board members named
router.post('/:id/comments', async (req, res) => {
    const body = clean(req.body?.body);
    if (!body) return res.status(400).json({ error: 'Write something first' });
    try {
        const t = await taskFor(req, req.params.id);
        if (!t) return res.status(404).json({ error: 'Task not found' });
        const board = (await db.query(`SELECT ${BOARD_COLS} FROM task_boards b WHERE b.id = $1`, [t.board_id])).rows[0];
        const people = [...new Set([...(board.members || []), board.lead_username, t.assignee, t.reporter].filter(Boolean))]
            .map(u => ({ username: u, handle: handleOf(u) }));
        const mentioned = mentionsIn(body, people);
        const r = await db.query('INSERT INTO task_comments (task_id, author, body) VALUES ($1,$2,$3) RETURNING id, author, body, created_at', [t.id, me(req), body]);
        // Commenting means you care how it goes.
        const watchers = new Set([...(t.watchers || []), me(req), ...mentioned]);
        await db.query('UPDATE tasks SET watchers = $1, updated_at = NOW() WHERE id = $2', [[...watchers], t.id]);
        const who = handleOf(me(req));
        const snippet = body.length > 140 ? `${body.slice(0, 140)}…` : body;
        if (mentioned.length) {
            await teamNotify.tell({ usernames: mentioned, event: 'mention', actor: me(req),
                title: `${who} mentioned you on ${ref(t)}`, body: snippet, link: linkOf(t), subject: `[${ref(t)}] ${who} mentioned you`, group: `task:${t.id}` });
        }
        const rest = audience(t).filter(u => !mentioned.includes(u));
        await teamNotify.tell({ usernames: rest, event: 'comment', actor: me(req),
            title: `${who} commented on ${ref(t)}`, body: snippet, link: linkOf(t), subject: `[${ref(t)}] ${t.title}`, group: `task:${t.id}` });
        res.json({ success: true, comment: r.rows[0] });
    } catch (err) {
        console.error('tasks comment error:', err);
        res.status(500).json({ error: 'Failed to post the comment' });
    }
});

/* ───────────────────────────── files ───────────────────────────── */

const fileUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => { const dir = path.join(FILES, String(req.params.id)); fs.mkdirSync(dir, { recursive: true }); cb(null, dir); },
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '');
            cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
        },
    }),
    limits: { fileSize: 25 * 1024 * 1024, files: 10 },
});

router.post('/:id/files', async (req, res, next) => {
    const t = await taskFor(req, req.params.id).catch(() => null);
    if (!t) return res.status(404).json({ error: 'Task not found' });
    fileUpload.array('files', 10)(req, res, async (err) => {
        if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Each file must be under 25MB' : err.message });
        try {
            for (const f of req.files || []) {
                await db.query('INSERT INTO task_files (task_id, path, name, size, uploaded_by) VALUES ($1,$2,$3,$4,$5)',
                    [t.id, path.basename(f.path), f.originalname.slice(0, 200), f.size, me(req)]);
            }
            await log(t.id, me(req), 'files', null, String((req.files || []).length));
            res.json({ success: true });
        } catch (e) { next(e); }
    });
});

router.get('/files/:fileId', async (req, res) => {
    try {
        const f = (await db.query('SELECT * FROM task_files WHERE id = $1', [req.params.fileId])).rows[0];
        if (!f || !(await taskFor(req, f.task_id))) return res.status(404).json({ error: 'File not found' });
        const file = path.join(FILES, String(f.task_id), path.basename(f.path));
        if (!fs.existsSync(file)) return res.status(404).json({ error: 'The file is missing' });
        res.setHeader('Content-Disposition', `inline; filename="${String(f.name).replace(/[^\w. -]/g, '')}"`);
        res.sendFile(file);
    } catch (err) {
        console.error('tasks file error:', err);
        res.status(500).json({ error: 'Failed to open the file' });
    }
});

router.delete('/files/:fileId', async (req, res) => {
    try {
        const f = (await db.query('SELECT * FROM task_files WHERE id = $1', [req.params.fileId])).rows[0];
        if (!f || !(await taskFor(req, f.task_id))) return res.status(404).json({ error: 'File not found' });
        await db.query('DELETE FROM task_files WHERE id = $1', [f.id]);
        fs.rm(path.join(FILES, String(f.task_id), path.basename(f.path)), { force: true }, () => {});
        res.json({ success: true });
    } catch (err) {
        console.error('tasks file delete error:', err);
        res.status(500).json({ error: 'Failed to remove the file' });
    }
});

/* ───────────────────────────── sprints ───────────────────────────── */

// POST /api/tasks/boards/:id/sprints — { name, goal, starts_on, ends_on }
router.post('/boards/:id/sprints', async (req, res) => {
    try {
        const b = await boardFor(req, req.params.id);
        if (!b) return res.status(404).json({ error: 'Board not found' });
        if (!runsBoard(req, b)) return res.status(403).json({ error: 'Only the board lead plans sprints' });
        let { starts_on, ends_on } = req.body || {};
        const count = (await db.query('SELECT COUNT(*)::int AS n FROM task_sprints WHERE board_id = $1', [b.id])).rows[0].n;
        if (!isDate(starts_on)) {
            const last = (await db.query(`SELECT TO_CHAR(MAX(ends_on), 'YYYY-MM-DD') AS d FROM task_sprints WHERE board_id = $1`, [b.id])).rows[0].d;
            const d = last ? new Date(`${last}T00:00:00Z`) : new Date();
            if (last) d.setUTCDate(d.getUTCDate() + 1);
            starts_on = d.toISOString().slice(0, 10);
        }
        if (!isDate(ends_on)) {
            const d = new Date(`${starts_on}T00:00:00Z`);
            d.setUTCDate(d.getUTCDate() + b.sprint_weeks * 7 - 1);
            ends_on = d.toISOString().slice(0, 10);
        }
        if (ends_on < starts_on) return res.status(400).json({ error: 'The sprint cannot end before it starts' });
        const r = await db.query(
            `INSERT INTO task_sprints (board_id, name, goal, starts_on, ends_on) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
            [b.id, clean(req.body?.name) || `Sprint ${count + 1}`, clean(req.body?.goal), starts_on, ends_on]);
        res.json({ success: true, id: r.rows[0].id });
    } catch (err) {
        console.error('tasks sprint create error:', err);
        res.status(500).json({ error: 'Failed to plan the sprint' });
    }
});

// PUT /api/tasks/sprints/:id — { name, goal, starts_on, ends_on, action: start|close }
router.put('/sprints/:id', async (req, res) => {
    try {
        const s = (await db.query(`SELECT * FROM task_sprints WHERE id = $1`, [req.params.id])).rows[0];
        if (!s) return res.status(404).json({ error: 'Sprint not found' });
        const b = await boardFor(req, s.board_id);
        if (!b || !runsBoard(req, b)) return res.status(403).json({ error: 'Only the board lead runs sprints' });
        const action = req.body?.action;
        if (action === 'start') {
            const other = (await db.query(`SELECT name FROM task_sprints WHERE board_id = $1 AND status = 'active' AND id <> $2`, [b.id, s.id])).rows[0];
            if (other) return res.status(400).json({ error: `${other.name} is still running — close it first` });
            const planned = (await db.query(`SELECT COALESCE(SUM(estimate), 0) AS n FROM tasks WHERE sprint_id = $1`, [s.id])).rows[0].n;
            await db.query(`UPDATE task_sprints SET status = 'active', planned_points = $1 WHERE id = $2`, [planned, s.id]);
        } else if (action === 'close') {
            // Unfinished work moves to the next planned sprint, or back to the backlog.
            const next = (await db.query(`SELECT id FROM task_sprints WHERE board_id = $1 AND status = 'planned' AND id <> $2 ORDER BY starts_on LIMIT 1`, [b.id, s.id])).rows[0];
            const moved = await db.query(
                `UPDATE tasks SET sprint_id = $1 WHERE sprint_id = $2 AND status NOT IN ('done','rejected') RETURNING id`, [next?.id || null, s.id]);
            await db.query(`UPDATE task_sprints SET status = 'closed', closed_at = NOW() WHERE id = $1`, [s.id]);
            return res.json({ success: true, moved: moved.rowCount, to: next ? 'next sprint' : 'backlog' });
        } else {
            await db.query(`UPDATE task_sprints SET name = COALESCE($1, name), goal = $2,
                                starts_on = COALESCE($3::date, starts_on), ends_on = COALESCE($4::date, ends_on) WHERE id = $5`,
                [clean(req.body?.name), clean(req.body?.goal), isDate(req.body?.starts_on) ? req.body.starts_on : null,
                 isDate(req.body?.ends_on) ? req.body.ends_on : null, s.id]);
        }
        res.json({ success: true });
    } catch (err) {
        console.error('tasks sprint update error:', err);
        res.status(500).json({ error: 'Failed to update the sprint' });
    }
});

/* ───────────────────────────── analytics ───────────────────────────── */

// GET /api/tasks/analytics?board&company&days=30
router.get('/analytics', async (req, res) => {
    try {
        const days = Math.min(365, Math.max(7, parseInt(req.query.days, 10) || 30));
        let boards = (await db.query(`SELECT ${BOARD_COLS} FROM task_boards b WHERE NOT b.archived`)).rows;
        // A member sees their own numbers; a lead their boards; a board manager everything.
        const scopeAll = req.canManage;
        boards = boards.filter(b => scopeAll || runsBoard(req, b) || onBoard(req, b));
        if (req.query.board) boards = boards.filter(b => String(b.id) === String(req.query.board));
        if (req.query.company) boards = boards.filter(b => b.company === req.query.company || b.company === 'both');
        const ids = boards.map(b => b.id);
        const ledIds = boards.filter(b => runsBoard(req, b)).map(b => b.id);
        const onlyMe = !scopeAll && !ledIds.length;
        const base = `t.board_id = ANY($1) ${onlyMe ? 'AND LOWER(t.assignee) = LOWER($2)' : ''}`;
        const vals = onlyMe ? [ids, me(req)] : [ids];
        const since = `NOW() - INTERVAL '${days} days'`;

        const totals = (await db.query(
            `SELECT COUNT(*) FILTER (WHERE t.status = 'done' AND t.done_at > ${since})::int AS finished,
                    COUNT(*) FILTER (WHERE t.status = 'done' AND t.done_at > ${since} AND t.due_on IS NOT NULL)::int AS with_due,
                    COUNT(*) FILTER (WHERE t.status = 'done' AND t.done_at > ${since} AND t.due_on IS NOT NULL AND t.done_at::date <= t.due_on)::int AS on_time,
                    AVG(EXTRACT(EPOCH FROM (t.done_at - COALESCE(t.started_at, t.created_at))) / 86400)
                        FILTER (WHERE t.status = 'done' AND t.done_at > ${since}) AS avg_days,
                    COUNT(*) FILTER (WHERE t.status NOT IN ('done','rejected','ideas') AND t.due_on < (NOW() AT TIME ZONE 'Asia/Kolkata')::date)::int AS overdue,
                    COUNT(*) FILTER (WHERE t.status NOT IN ('done','rejected'))::int AS open
               FROM tasks t WHERE ${base}`, vals)).rows[0];
        const before = (await db.query(
            `SELECT COUNT(*)::int AS n FROM tasks t WHERE ${base} AND t.status = 'done'
                AND t.done_at BETWEEN NOW() - INTERVAL '${days * 2} days' AND ${since}`, vals)).rows[0].n;

        const people = (await db.query(
            `SELECT t.assignee AS username,
                    COUNT(*) FILTER (WHERE t.status NOT IN ('done','rejected'))::int AS open,
                    COUNT(*) FILTER (WHERE t.status = 'done' AND t.done_at > ${since})::int AS finished,
                    COUNT(*) FILTER (WHERE t.status = 'done' AND t.done_at > ${since} AND t.due_on IS NOT NULL)::int AS with_due,
                    COUNT(*) FILTER (WHERE t.status = 'done' AND t.done_at > ${since} AND t.due_on IS NOT NULL AND t.done_at::date <= t.due_on)::int AS on_time,
                    COUNT(*) FILTER (WHERE t.status NOT IN ('done','rejected','ideas') AND t.due_on < (NOW() AT TIME ZONE 'Asia/Kolkata')::date)::int AS overdue,
                    AVG(EXTRACT(EPOCH FROM (t.done_at - COALESCE(t.started_at, t.created_at))) / 86400)
                        FILTER (WHERE t.status = 'done' AND t.done_at > ${since}) AS avg_days,
                    ARRAY_AGG(DISTINCT b.name) AS boards
               FROM tasks t JOIN task_boards b ON b.id = t.board_id
              WHERE ${base} AND t.assignee IS NOT NULL GROUP BY t.assignee ORDER BY finished DESC`, vals)).rows;

        const byStatus = (await db.query(
            `SELECT t.status, COUNT(*)::int AS n FROM tasks t WHERE ${base} AND (t.status NOT IN ('done','rejected') OR t.done_at > ${since})
              GROUP BY t.status`, vals)).rows;

        // Sprints: the one running (points left each day) and the last five (planned vs done).
        let burndown = null, sprints = [];
        if (boards.length === 1 && boards[0].use_sprints) {
            const s = (await db.query(
                `SELECT id, name, TO_CHAR(starts_on, 'YYYY-MM-DD') AS starts_on, TO_CHAR(ends_on, 'YYYY-MM-DD') AS ends_on
                   FROM task_sprints WHERE board_id = $1 AND status = 'active' LIMIT 1`, [boards[0].id])).rows[0];
            if (s) {
                const tasks = (await db.query(`SELECT COALESCE(estimate, 1) AS pts, done_at FROM tasks WHERE sprint_id = $1`, [s.id])).rows;
                const total = tasks.reduce((a, t) => a + Number(t.pts), 0);
                const daysList = [];
                const today = new Date().toISOString().slice(0, 10);
                for (let d = new Date(`${s.starts_on}T00:00:00Z`); d.toISOString().slice(0, 10) <= s.ends_on; d.setUTCDate(d.getUTCDate() + 1)) {
                    const day = d.toISOString().slice(0, 10);
                    const doneBy = tasks.filter(t => t.done_at && new Date(t.done_at).toISOString().slice(0, 10) <= day).reduce((a, t) => a + Number(t.pts), 0);
                    daysList.push({ day, left: day <= today ? total - doneBy : null });
                }
                burndown = { sprint: s, total, days: daysList };
            }
            sprints = (await db.query(
                `SELECT s.id, s.name, s.status, COALESCE(s.planned_points, (SELECT COALESCE(SUM(COALESCE(estimate,1)),0) FROM tasks WHERE sprint_id = s.id)) AS planned,
                        (SELECT COALESCE(SUM(COALESCE(estimate,1)),0) FROM tasks t WHERE t.sprint_id = s.id AND t.status = 'done') AS done
                   FROM task_sprints s WHERE s.board_id = $1 AND s.status <> 'planned' ORDER BY s.starts_on DESC LIMIT 5`, [boards[0].id])).rows.reverse();
        }
        res.json({
            totals: { ...totals, avg_days: totals.avg_days == null ? null : Number(totals.avg_days), before },
            people: people.map(p => ({ ...p, avg_days: p.avg_days == null ? null : Number(p.avg_days) })),
            byStatus, burndown, sprints, scope: scopeAll ? 'all' : onlyMe ? 'me' : 'lead',
            boards: boards.map(b => ({ id: b.id, name: b.name })), statusLabels: STATUS_LABEL,
        });
    } catch (err) {
        console.error('tasks analytics error:', err);
        res.status(500).json({ error: 'Failed to load analytics' });
    }
});

/* ───────────────────────────── repeating tasks ───────────────────────────── */

function nextDate(from, every) {
    const d = new Date(`${from}T00:00:00Z`);
    if (every === 'day') d.setUTCDate(d.getUTCDate() + 1);
    else if (every === 'weekday') { do { d.setUTCDate(d.getUTCDate() + 1); } while ([0, 6].includes(d.getUTCDay())); }
    else if (every === 'week') d.setUTCDate(d.getUTCDate() + 7);
    else d.setUTCMonth(d.getUTCMonth() + 1);
    return d.toISOString().slice(0, 10);
}

/** A repeating task makes its next copy when the copy's day comes. */
async function runRepeats() {
    const today = teamNotify.istDate();
    const due = (await db.query(
        `SELECT t.*, TO_CHAR(t.due_on, 'YYYY-MM-DD') AS due_on FROM tasks t JOIN task_boards b ON b.id = t.board_id
          WHERE t.repeat IS NOT NULL AND (t.repeat->>'next_on') IS NOT NULL AND (t.repeat->>'next_on') <= $1 AND NOT b.archived`, [today])).rows;
    for (const t of due) {
        const on = t.repeat.next_on;
        await db.transaction(async (c) => {
            const n = (await c.query('UPDATE task_boards SET next_no = next_no + 1 WHERE id = $1 RETURNING next_no - 1 AS n', [t.board_id])).rows[0].n;
            await c.query(
                `INSERT INTO tasks (board_id, number, title, description, status, priority, assignee, reporter, due_on, estimate,
                     labels, checklist, watchers, sprint_id, position)
                 VALUES ($1,$2,$3,$4,'todo',$5,$6,$7,$8,$9,$10,$11,$12,
                     (SELECT id FROM task_sprints WHERE board_id = $1 AND status = 'active' LIMIT 1), 0)`,
                [t.board_id, n, t.title, t.description, t.priority, t.assignee, t.reporter, on, t.estimate, t.labels,
                 JSON.stringify((t.checklist || []).map(i => ({ ...i, done: false }))), t.watchers]);
            let next = nextDate(on, t.repeat.every);
            while (next <= today) next = nextDate(next, t.repeat.every);
            await c.query(`UPDATE tasks SET repeat = $1 WHERE id = $2`, [JSON.stringify({ ...t.repeat, next_on: next }), t.id]);
        });
        if (t.assignee) {
            const b = (await db.query('SELECT key FROM task_boards WHERE id = $1', [t.board_id])).rows[0];
            await teamNotify.tell({ usernames: [t.assignee], event: 'assigned', actor: null,
                title: `New repeating task on ${b.key}: ${t.title}`, body: `Due ${on}`, link: `/team/tasks?board=${t.board_id}&mine=1`, group: `repeat:${t.id}:${on}` });
        }
    }
}

let repeating = false;
function startRepeats() {
    if (repeating) return;
    repeating = true;
    const go = () => runRepeats().catch(err => console.error('repeating tasks:', err.message));
    setTimeout(go, 30 * 1000);
    setInterval(go, 30 * 60 * 1000);
}

module.exports = router;
module.exports.startRepeats = startRepeats;
module.exports.runRepeats = runRepeats;
