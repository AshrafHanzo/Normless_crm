/**
 * Team: people and payroll, leave and permission, claims and advances — shared by Normless and
 * Crewfit.
 *
 * Three levels of access:
 *   - everyone signed in: their own payslips, leave and claims (/me, and asking for leave or
 *     submitting a claim for themselves);
 *   - a manager (named on a person's record): approves that person's leave and claims first;
 *   - can_view_payroll: every person, salary and run. Approving a run is owners and admins only.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const db = require('../db/connection');
const { hasPermission } = require('../utils/permissions');
const payroll = require('../services/payroll');
const teamNotify = require('../services/team-notify');
const mailer = require('../services/mailer');

const router = express.Router();

const COMPANIES = ['normless', 'crewfit', 'both'];
const LEAVE_KINDS = ['leave', 'half', 'permission', 'absent'];
const CLAIM_CATEGORIES = ['Courier & delivery', 'Travel', 'Food', 'Marketing', 'Office', 'Materials', 'Other'];
const RECEIPTS = path.join(__dirname, '..', 'storage', 'team', 'claims');

const me = (req) => req.user?.username || '';
const isAdmin = (req) => req.user?.role === 'owner' || req.user?.role === 'admin';
const canPayroll = (req) => hasPermission(req, 'can_view_payroll');
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const clean = (v) => { const s = String(v ?? '').trim(); return s || null; };

const EMP_COLUMNS = `e.*, TO_CHAR(e.joined_on, 'YYYY-MM-DD') AS joined_on, TO_CHAR(e.left_on, 'YYYY-MM-DD') AS left_on`;

async function myEmployee(req) {
    return (await db.query(`SELECT ${EMP_COLUMNS} FROM team_employees e WHERE LOWER(e.username) = LOWER($1)`, [me(req)])).rows[0] || null;
}
async function employee(id) {
    return (await db.query(`SELECT ${EMP_COLUMNS} FROM team_employees e WHERE e.id = $1`, [id])).rows[0] || null;
}
/** The usernames who hear about a person's request: their manager, else everyone on payroll. */
async function approversOf(emp) {
    if (emp.manager_username) return [emp.manager_username];
    return (await db.query(
        `SELECT username FROM admin_users WHERE COALESCE(is_active, true)
           AND (role IN ('owner','admin') OR COALESCE(can_view_payroll, false))`)).rows.map(r => r.username);
}
const managesEmp = (req, emp) => emp?.manager_username && emp.manager_username.toLowerCase() === me(req).toLowerCase();
const isSelf = (req, emp) => emp?.username && emp.username.toLowerCase() === me(req).toLowerCase();

/** Leave and claims a request can see: payroll all, a manager their team, anyone their own. */
async function scopeWhere(req, alias = 'e') {
    if (await canPayroll(req)) return { sql: 'TRUE', vals: [] };
    return { sql: `(LOWER(${alias}.username) = LOWER($1) OR LOWER(${alias}.manager_username) = LOWER($1))`, vals: [me(req)] };
}

const requirePayroll = async (req, res, next) => {
    try {
        if (!await canPayroll(req)) return res.status(403).json({ error: 'Payroll access is needed for this' });
        next();
    } catch (err) { next(err); }
};

/* ───────────────────────────── badges and me ───────────────────────────── */

// GET /api/team/badges — my tasks due today or late, and requests waiting for me
router.get('/badges', async (req, res) => {
    try {
        const tasks = (await db.query(
            `SELECT COUNT(*)::int AS n FROM tasks t JOIN task_boards b ON b.id = t.board_id
              WHERE LOWER(t.assignee) = LOWER($1) AND t.due_on <= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
                AND t.status NOT IN ('done','rejected','ideas') AND NOT b.archived`, [me(req)])).rows[0].n;
        let approvals = 0;
        if (await canPayroll(req)) {
            approvals = (await db.query(
                `SELECT (SELECT COUNT(*) FROM team_leave WHERE status = 'pending')
                      + (SELECT COUNT(*) FROM team_claims WHERE status IN ('pending','lead_ok')) AS n`)).rows[0].n;
        } else {
            approvals = (await db.query(
                `SELECT (SELECT COUNT(*) FROM team_leave l JOIN team_employees e ON e.id = l.employee_id
                          WHERE l.status = 'pending' AND LOWER(e.manager_username) = LOWER($1))
                      + (SELECT COUNT(*) FROM team_claims c JOIN team_employees e ON e.id = c.employee_id
                          WHERE c.status = 'pending' AND LOWER(e.manager_username) = LOWER($1)) AS n`, [me(req)])).rows[0].n;
        }
        res.json({ tasks, approvals: Number(approvals) || 0 });
    } catch (err) {
        console.error('team badges error:', err);
        res.status(500).json({ error: 'Failed to load counts' });
    }
});

// GET /api/team/me — my record, balance, payslips, leave, claims and notification settings
router.get('/me', async (req, res) => {
    try {
        const emp = await myEmployee(req);
        const prefs = await teamNotify.prefsOf(me(req));
        const events = Object.fromEntries(Object.entries(teamNotify.EVENTS).map(([k, v]) => [k, v.label]));
        const isManager = (await db.query('SELECT 1 FROM team_employees WHERE LOWER(manager_username) = LOWER($1) LIMIT 1', [me(req)])).rows.length > 0;
        if (!emp) return res.json({ employee: null, prefs, events, isManager });
        const balance = await payroll.balanceNow(emp);
        const payslips = (await db.query(
            `SELECT l.id, l.net, l.status, l.paid_at, r.id AS run_id, TO_CHAR(r.month, 'YYYY-MM-DD') AS month, r.status AS run_status
               FROM team_pay_lines l JOIN team_pay_runs r ON r.id = l.run_id
              WHERE l.employee_id = $1 AND r.status <> 'draft' ORDER BY r.month DESC`, [emp.id])).rows;
        const leave = (await db.query(
            `SELECT id, kind, TO_CHAR(from_date, 'YYYY-MM-DD') AS from_date, TO_CHAR(to_date, 'YYYY-MM-DD') AS to_date,
                    half, hours, start_time, end_time, reason, status, decided_by, decision_note, created_at
               FROM team_leave WHERE employee_id = $1 ORDER BY from_date DESC LIMIT 60`, [emp.id])).rows;
        const claims = (await db.query(
            `SELECT id, title, amount, TO_CHAR(spent_on, 'YYYY-MM-DD') AS spent_on, category, status, with_salary,
                    rejected_reason, jsonb_array_length(receipts) AS receipts, created_at
               FROM team_claims WHERE employee_id = $1 ORDER BY created_at DESC LIMIT 60`, [emp.id])).rows;
        const { bank_account, pan, ...safe } = emp;
        res.json({
            employee: { ...safe, bank_last4: bank_account ? String(bank_account).slice(-4) : null },
            balance, payslips, leave, claims, prefs, events, isManager, categories: CLAIM_CATEGORIES,
        });
    } catch (err) {
        console.error('team me error:', err);
        res.status(500).json({ error: 'Failed to load your details' });
    }
});

// PUT /api/team/me/prefs — { digest, events: { assigned: { crm, email } … } }
router.put('/me/prefs', async (req, res) => {
    try {
        const events = {};
        for (const k of Object.keys(teamNotify.EVENTS)) {
            const e = req.body?.events?.[k] || {};
            events[k] = { crm: e.crm !== false, email: !!e.email };
        }
        const prefs = { digest: req.body?.digest !== false, events };
        await db.query(
            `INSERT INTO team_notify_prefs (username, prefs) VALUES ($1, $2)
             ON CONFLICT (username) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = NOW()`, [me(req), JSON.stringify(prefs)]);
        res.json({ success: true, prefs });
    } catch (err) {
        console.error('team prefs error:', err);
        res.status(500).json({ error: 'Failed to save your settings' });
    }
});

/* ───────────────────────────── people ───────────────────────────── */

// GET /api/team/meta — pick-lists: CRM logins, departments, companies
router.get('/meta', async (req, res) => {
    try {
        const users = (await db.query(
            `SELECT username, role FROM admin_users WHERE COALESCE(is_active, true) ORDER BY username`)).rows;
        const departments = (await db.query(
            `SELECT DISTINCT department FROM team_employees WHERE department IS NOT NULL ORDER BY department`)).rows.map(r => r.department);
        const canPay = await canPayroll(req);
        res.json({
            users: users.map(u => u.username), departments, companies: COMPANIES, categories: CLAIM_CATEGORIES,
            canPayroll: canPay, canApproveRuns: isAdmin(req),
        });
    } catch (err) {
        console.error('team meta error:', err);
        res.status(500).json({ error: 'Failed to load options' });
    }
});

// GET /api/team/people?q&company&department&status
router.get('/people', requirePayroll, async (req, res) => {
    try {
        const where = [], vals = [];
        const { q, company, department, status } = req.query;
        if (q) { vals.push(`%${q}%`); where.push(`(e.name ILIKE $${vals.length} OR e.phone ILIKE $${vals.length} OR e.emp_code ILIKE $${vals.length} OR e.username ILIKE $${vals.length})`); }
        if (company) { vals.push(company); where.push(`(e.company = $${vals.length} OR e.company = 'both')`); }
        if (department) { vals.push(department); where.push(`e.department = $${vals.length}`); }
        if (status === 'all') { /* everyone */ } else if (status) { vals.push(status); where.push(`e.status = $${vals.length}`); }
        else where.push(`e.status <> 'left'`);
        const rows = (await db.query(
            `SELECT ${EMP_COLUMNS}, u.role AS login_role, (u.username IS NOT NULL) AS has_login
               FROM team_employees e LEFT JOIN admin_users u ON LOWER(u.username) = LOWER(e.username)
              ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.name`, vals)).rows;
        const active = rows.filter(r => r.status !== 'left');
        res.json({
            people: rows,
            summary: {
                active: active.length,
                normless: active.filter(r => r.company === 'normless').length,
                crewfit: active.filter(r => r.company === 'crewfit').length,
                both: active.filter(r => r.company === 'both').length,
                monthly: active.reduce((a, r) => a + Number(r.monthly_salary || 0), 0),
                missingBank: active.filter(r => !r.bank_account && !r.upi_id).length,
            },
        });
    } catch (err) {
        console.error('team people error:', err);
        res.status(500).json({ error: 'Failed to load people' });
    }
});

function personFields(b) {
    const company = COMPANIES.includes(b.company) ? b.company : 'normless';
    const status = ['active', 'notice', 'left'].includes(b.status) ? b.status : 'active';
    return {
        emp_code: clean(b.emp_code), name: clean(b.name), phone: clean(b.phone), email: clean(b.email),
        username: clean(b.username), company, department: clean(b.department), designation: clean(b.designation),
        manager_username: clean(b.manager_username), joined_on: isDate(b.joined_on) ? b.joined_on : null,
        left_on: isDate(b.left_on) ? b.left_on : null, status, paid_leave_per_month: num(b.paid_leave_per_month),
        bank_name: clean(b.bank_name), bank_account: clean(b.bank_account)?.replace(/\s/g, '') || null,
        bank_ifsc: clean(b.bank_ifsc)?.toUpperCase() || null, upi_id: clean(b.upi_id), pan: clean(b.pan)?.toUpperCase() || null,
        notes: clean(b.notes),
    };
}
function personError(f, salary) {
    if (!f.name) return 'Name is required';
    if (salary != null && salary < 0) return 'Salary cannot be negative';
    if (f.bank_ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(f.bank_ifsc)) return 'IFSC should look like HDFC0001234';
    if (f.left_on && f.joined_on && f.left_on < f.joined_on) return 'Last day cannot be before joining';
    return null;
}
const dup = (err) => (err.code === '23505'
    ? (String(err.detail || '').includes('username') ? 'That CRM login is already linked to someone else' : 'That employee ID is already used')
    : null);

// POST /api/team/people
router.post('/people', requirePayroll, async (req, res) => {
    const f = personFields(req.body || {});
    const salary = num(req.body?.monthly_salary) ?? 0;
    const bad = personError(f, salary);
    if (bad) return res.status(400).json({ error: bad });
    try {
        const cols = Object.keys(f);
        const r = await db.query(
            `INSERT INTO team_employees (${cols.join(', ')}, monthly_salary)
             VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, $${cols.length + 1}) RETURNING id`,
            [...Object.values(f), salary]);
        const id = r.rows[0].id;
        if (!f.emp_code) await db.query(`UPDATE team_employees SET emp_code = 'EMP-' || LPAD(id::text, 4, '0') WHERE id = $1`, [id]);
        await db.query(
            `INSERT INTO team_salary_history (employee_id, effective_from, monthly_salary, note, created_by)
             VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, 'Joined', $4)`, [id, f.joined_on, salary, me(req)]);
        res.json({ success: true, person: await employee(id) });
    } catch (err) {
        const d = dup(err);
        if (d) return res.status(400).json({ error: d });
        console.error('team person create error:', err);
        res.status(500).json({ error: 'Failed to add the person' });
    }
});

// PUT /api/team/people/:id — details only; salary changes go through /salary so they keep a history
router.put('/people/:id', requirePayroll, async (req, res) => {
    const f = personFields(req.body || {});
    const bad = personError(f);
    if (bad) return res.status(400).json({ error: bad });
    try {
        const cols = Object.keys(f);
        const r = await db.query(
            `UPDATE team_employees SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = NOW()
              WHERE id = $${cols.length + 1} RETURNING id`, [...Object.values(f), req.params.id]);
        if (!r.rows.length) return res.status(404).json({ error: 'Person not found' });
        res.json({ success: true, person: await employee(req.params.id) });
    } catch (err) {
        const d = dup(err);
        if (d) return res.status(400).json({ error: d });
        console.error('team person update error:', err);
        res.status(500).json({ error: 'Failed to save' });
    }
});

// GET /api/team/people/:id — everything on the person's page
router.get('/people/:id', requirePayroll, async (req, res) => {
    try {
        const emp = await employee(req.params.id);
        if (!emp) return res.status(404).json({ error: 'Person not found' });
        const [history, leave, claims, advances, payslips, login] = await Promise.all([
            db.query(`SELECT id, TO_CHAR(effective_from, 'YYYY-MM-DD') AS effective_from, monthly_salary, note, created_by
                        FROM team_salary_history WHERE employee_id = $1 ORDER BY effective_from DESC, id DESC`, [emp.id]),
            db.query(`SELECT id, kind, TO_CHAR(from_date, 'YYYY-MM-DD') AS from_date, TO_CHAR(to_date, 'YYYY-MM-DD') AS to_date,
                             half, hours, reason, status FROM team_leave WHERE employee_id = $1 ORDER BY from_date DESC LIMIT 40`, [emp.id]),
            db.query(`SELECT id, title, amount, TO_CHAR(spent_on, 'YYYY-MM-DD') AS spent_on, status FROM team_claims
                       WHERE employee_id = $1 ORDER BY created_at DESC LIMIT 40`, [emp.id]),
            db.query(`SELECT id, amount, TO_CHAR(given_on, 'YYYY-MM-DD') AS given_on, recover_per_month, note FROM team_advances
                       WHERE employee_id = $1 ORDER BY given_on DESC`, [emp.id]),
            db.query(`SELECT l.id, l.net, l.status, r.id AS run_id, TO_CHAR(r.month, 'YYYY-MM-DD') AS month, r.status AS run_status
                        FROM team_pay_lines l JOIN team_pay_runs r ON r.id = l.run_id
                       WHERE l.employee_id = $1 ORDER BY r.month DESC`, [emp.id]),
            emp.username ? db.query('SELECT * FROM admin_users WHERE LOWER(username) = LOWER($1)', [emp.username]) : { rows: [] },
        ]);
        const settings = await payroll.getSettings();
        const balance = await payroll.balanceNow(emp);
        const u = login.rows[0];
        // What the login can open, named the way the menu does — changing it stays in Admin.
        const ACCESS = [['can_access_normless', 'Normless'], ['can_access_crewfit', 'Crewfit'], ['can_view_whatsapp', 'Crewfit WhatsApp'],
            ['can_view_wa_normless', 'Normless WhatsApp'], ['can_view_crewfit_orders', 'Bulk orders'], ['can_view_orders', 'Orders'],
            ['can_view_marketing', 'Marketing'], ['can_view_support', 'Support'], ['can_view_tasks', 'Tasks'], ['can_view_payroll', 'Payroll']];
        res.json({
            person: emp, history: history.rows, leave: leave.rows, claims: claims.rows, advances: advances.rows,
            payslips: payslips.rows, balance,
            // On the ÷30 basis a day is the same every month; the other bases depend on the month.
            dayRate: settings.day_basis === 'thirty' ? Math.round(Number(emp.monthly_salary) / 30) : null,
            dayBasis: settings.day_basis,
            login: u ? { role: u.role, active: u.is_active !== false,
                access: ['owner', 'admin'].includes(u.role) ? ['Everything'] : ACCESS.filter(([c]) => u[c]).map(([, l]) => l) } : null,
        });
    } catch (err) {
        console.error('team person error:', err);
        res.status(500).json({ error: 'Failed to load the person' });
    }
});

// POST /api/team/people/:id/salary — { effective_from, monthly_salary, note }
router.post('/people/:id/salary', requirePayroll, async (req, res) => {
    const amount = num(req.body?.monthly_salary);
    if (amount == null || amount < 0) return res.status(400).json({ error: 'Enter the new monthly salary' });
    if (!isDate(req.body?.effective_from)) return res.status(400).json({ error: 'Choose the date it starts from' });
    try {
        const emp = await employee(req.params.id);
        if (!emp) return res.status(404).json({ error: 'Person not found' });
        await db.query(
            `INSERT INTO team_salary_history (employee_id, effective_from, monthly_salary, note, created_by) VALUES ($1,$2,$3,$4,$5)`,
            [emp.id, req.body.effective_from, amount, clean(req.body.note) || 'Revision', me(req)]);
        // The record carries the salary in force today; a future revision takes over from its month.
        const today = (await db.query(
            `SELECT monthly_salary FROM team_salary_history WHERE employee_id = $1 AND effective_from <= CURRENT_DATE
              ORDER BY effective_from DESC, id DESC LIMIT 1`, [emp.id])).rows[0];
        if (today) await db.query('UPDATE team_employees SET monthly_salary = $1, updated_at = NOW() WHERE id = $2', [today.monthly_salary, emp.id]);
        res.json({ success: true });
    } catch (err) {
        console.error('team salary error:', err);
        res.status(500).json({ error: 'Failed to save the salary' });
    }
});

/* ───────────────────────────── leave ───────────────────────────── */

const LEAVE_COLS = `l.id, l.employee_id, l.kind, TO_CHAR(l.from_date, 'YYYY-MM-DD') AS from_date, TO_CHAR(l.to_date, 'YYYY-MM-DD') AS to_date,
    l.half, l.hours, l.start_time, l.end_time, l.reason, l.status, l.decided_by, l.decided_at, l.decision_note, l.created_by, l.created_at,
    e.name, e.company, e.department, e.manager_username, e.username`;

// GET /api/team/leave?status=pending|all&month=YYYY-MM
router.get('/leave', async (req, res) => {
    try {
        const scope = await scopeWhere(req);
        const vals = [...scope.vals], where = [scope.sql];
        if (req.query.status && req.query.status !== 'all') { vals.push(req.query.status); where.push(`l.status = $${vals.length}`); }
        if (/^\d{4}-\d{2}$/.test(req.query.month || '')) {
            const m = `${req.query.month}-01`;
            vals.push(m, payroll.monthEnd(m));
            where.push(`l.to_date >= $${vals.length - 1} AND l.from_date <= $${vals.length}`);
        }
        const rows = (await db.query(
            `SELECT ${LEAVE_COLS} FROM team_leave l JOIN team_employees e ON e.id = l.employee_id
              WHERE ${where.join(' AND ')} ORDER BY l.from_date DESC, l.id DESC LIMIT 300`, vals)).rows;
        // For requests still waiting, what approving would do to pay.
        for (const r of rows.filter(x => x.status === 'pending')) {
            const emp = await employee(r.employee_id);
            const b = await payroll.balanceNow(emp);
            r.effect = { paidLeft: b.paidLeft, permissionUsed: b.permissionUsed, permissionAllowed: b.permissionAllowed };
        }
        const settings = await payroll.getSettings();
        const people = (await db.query(
            `SELECT e.id, e.name FROM team_employees e WHERE e.status <> 'left' AND ${scope.sql} ORDER BY e.name`, scope.vals)).rows;
        res.json({ leave: rows, people, settings: { day_basis: settings.day_basis, permission_hours: settings.permission_hours } });
    } catch (err) {
        console.error('team leave list error:', err);
        res.status(500).json({ error: 'Failed to load leave' });
    }
});

/** Work out a request's days and check it; returns { row } or { error }. */
function leaveRow(b) {
    const kind = LEAVE_KINDS.includes(b.kind) ? b.kind : null;
    if (!kind) return { error: 'Choose leave, half day or permission' };
    if (!isDate(b.from_date)) return { error: 'Choose the date' };
    const to = kind === 'leave' || kind === 'absent' ? (isDate(b.to_date) ? b.to_date : b.from_date) : b.from_date;
    if (to < b.from_date) return { error: 'The last day cannot be before the first' };
    let hours = null;
    if (kind === 'permission') {
        hours = num(b.hours);
        if (!hours || hours <= 0 || hours > 8) return { error: 'Permission is between a few minutes and 8 hours' };
    }
    return { row: { kind, from_date: b.from_date, to_date: to, half: kind === 'half' ? (b.half === 'am' ? 'am' : 'pm') : null,
        hours, start_time: clean(b.start_time), end_time: clean(b.end_time), reason: clean(b.reason) } };
}
const KIND_LABEL = { leave: 'Leave', half: 'Half day', permission: 'Permission', absent: 'Absent' };
const describeLeave = (l) => (l.kind === 'permission' ? `${l.hours}h on ${l.from_date}`
    : l.from_date === l.to_date ? l.from_date : `${l.from_date} to ${l.to_date}`);

// POST /api/team/leave — for myself (asks), or for someone (payroll or their manager records it, approved)
router.post('/leave', async (req, res) => {
    const { row, error } = leaveRow(req.body || {});
    if (error) return res.status(400).json({ error });
    try {
        let emp, status = 'pending';
        if (req.body.employee_id) {
            emp = await employee(req.body.employee_id);
            if (!emp) return res.status(404).json({ error: 'Person not found' });
            const may = (await canPayroll(req)) || managesEmp(req, emp);
            if (!may && !isSelf(req, emp)) return res.status(403).json({ error: 'You can only record leave for your own team' });
            if (!isSelf(req, emp)) status = 'approved';
        } else {
            emp = await myEmployee(req);
            if (!emp) return res.status(400).json({ error: 'Your login is not linked to a person in Payroll yet — ask the payroll manager' });
        }
        if (row.kind === 'absent' && status !== 'approved') return res.status(403).json({ error: 'Only a manager marks an absence' });
        const r = await db.query(
            `INSERT INTO team_leave (employee_id, kind, from_date, to_date, half, hours, start_time, end_time, reason, status,
                 decided_by, decided_at, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
            [emp.id, row.kind, row.from_date, row.to_date, row.half, row.hours, row.start_time, row.end_time, row.reason, status,
             status === 'approved' ? me(req) : null, status === 'approved' ? new Date() : null, me(req)]);
        if (status === 'pending') {
            await teamNotify.tell({
                usernames: await approversOf(emp), event: 'leave', actor: me(req),
                title: `${emp.name} asked for ${KIND_LABEL[row.kind].toLowerCase()}`, body: `${describeLeave(row)}${row.reason ? ` · ${row.reason}` : ''}`,
                link: '/team/payroll?tab=leave', subject: `Leave request: ${emp.name}`, group: `leave:${r.rows[0].id}`,
            });
        } else if (emp.username) {
            await teamNotify.tell({
                usernames: [emp.username], event: 'leave', actor: me(req),
                title: `${KIND_LABEL[row.kind]} recorded for you`, body: describeLeave(row), link: '/team/me', group: `leave:${r.rows[0].id}`,
            });
        }
        res.json({ success: true, id: r.rows[0].id, status });
    } catch (err) {
        console.error('team leave create error:', err);
        res.status(500).json({ error: 'Failed to save the request' });
    }
});

// POST /api/team/leave/:id/decide — { decision: approve|reject, note }
router.post('/leave/:id/decide', async (req, res) => {
    const decision = req.body?.decision;
    if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'Approve or reject' });
    try {
        const l = (await db.query(`SELECT ${LEAVE_COLS} FROM team_leave l JOIN team_employees e ON e.id = l.employee_id WHERE l.id = $1`, [req.params.id])).rows[0];
        if (!l) return res.status(404).json({ error: 'Request not found' });
        const emp = await employee(l.employee_id);
        if (isSelf(req, emp)) return res.status(403).json({ error: 'Someone else has to approve your own leave' });
        if (!(await canPayroll(req)) && !managesEmp(req, emp)) return res.status(403).json({ error: 'Only their manager or payroll can decide this' });
        if (l.status !== 'pending' && !(await canPayroll(req))) return res.status(400).json({ error: 'This was already decided' });
        const status = decision === 'approve' ? 'approved' : 'rejected';
        await db.query(
            `UPDATE team_leave SET status = $1, decided_by = $2, decided_at = NOW(), decision_note = $3 WHERE id = $4`,
            [status, me(req), clean(req.body.note), l.id]);
        if (emp.username) {
            await teamNotify.tell({
                usernames: [emp.username], event: 'leave', actor: me(req),
                title: `Your ${KIND_LABEL[l.kind].toLowerCase()} was ${status}`, body: `${describeLeave(l)}${req.body.note ? ` · ${req.body.note}` : ''}`,
                link: '/team/me', group: `leave:${l.id}`,
            });
        }
        res.json({ success: true, status });
    } catch (err) {
        console.error('team leave decide error:', err);
        res.status(500).json({ error: 'Failed to save the decision' });
    }
});

// POST /api/team/leave/:id/cancel — my own request before it is decided, or payroll at any time
router.post('/leave/:id/cancel', async (req, res) => {
    try {
        const l = (await db.query('SELECT id, employee_id, status FROM team_leave WHERE id = $1', [req.params.id])).rows[0];
        if (!l) return res.status(404).json({ error: 'Request not found' });
        const emp = await employee(l.employee_id);
        const pay = await canPayroll(req);
        if (!pay && !(isSelf(req, emp) && l.status === 'pending') && !managesEmp(req, emp)) {
            return res.status(403).json({ error: 'You can cancel only your own request while it waits' });
        }
        await db.query(`UPDATE team_leave SET status = 'cancelled', decided_by = $1, decided_at = NOW() WHERE id = $2`, [me(req), l.id]);
        res.json({ success: true });
    } catch (err) {
        console.error('team leave cancel error:', err);
        res.status(500).json({ error: 'Failed to cancel' });
    }
});

// Holidays: paid days off for everyone (Sundays already are).
router.get('/holidays', async (req, res) => {
    try {
        const rows = (await db.query(`SELECT TO_CHAR(day, 'YYYY-MM-DD') AS day, name FROM team_holidays ORDER BY day`)).rows;
        res.json({ holidays: rows });
    } catch (err) {
        console.error('team holidays error:', err);
        res.status(500).json({ error: 'Failed to load holidays' });
    }
});
router.post('/holidays', requirePayroll, async (req, res) => {
    if (!isDate(req.body?.day) || !clean(req.body?.name)) return res.status(400).json({ error: 'A date and a name' });
    try {
        await db.query(`INSERT INTO team_holidays (day, name) VALUES ($1, $2) ON CONFLICT (day) DO UPDATE SET name = EXCLUDED.name`,
            [req.body.day, clean(req.body.name)]);
        res.json({ success: true });
    } catch (err) {
        console.error('team holiday save error:', err);
        res.status(500).json({ error: 'Failed to save the holiday' });
    }
});
router.delete('/holidays/:day', requirePayroll, async (req, res) => {
    try {
        await db.query('DELETE FROM team_holidays WHERE day = $1', [req.params.day]);
        res.json({ success: true });
    } catch (err) {
        console.error('team holiday delete error:', err);
        res.status(500).json({ error: 'Failed to remove the holiday' });
    }
});

/* ───────────────────────────── claims ───────────────────────────── */

const receiptUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => { const dir = path.join(RECEIPTS, 'incoming'); fs.mkdirSync(dir, { recursive: true }); cb(null, dir); },
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '');
            cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
        },
    }),
    limits: { fileSize: 10 * 1024 * 1024, files: 5 },
    fileFilter: (req, file, cb) => {
        if (/^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/.test(file.mimetype)) cb(null, true);
        else cb(new Error('Receipts can be photos (JPG, PNG, WEBP) or PDFs'));
    },
});
const takeReceipts = (req, res, next) => receiptUpload.array('receipts', 5)(req, res, (err) => {
    if (!err) return next();
    res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Each receipt must be under 10MB' : err.message });
});

const CLAIM_COLS = `c.id, c.employee_id, c.title, c.amount, TO_CHAR(c.spent_on, 'YYYY-MM-DD') AS spent_on, c.category, c.company,
    c.link_ref, jsonb_array_length(c.receipts) AS receipts, c.status, c.with_salary, c.lead_by, c.lead_at, c.approved_by,
    c.approved_at, c.rejected_by, c.rejected_reason, c.paid_at, c.created_by, c.created_at,
    e.name, e.department, e.manager_username, e.username`;

// GET /api/team/claims?status=open|approved|paid|rejected|all
router.get('/claims', async (req, res) => {
    try {
        const scope = await scopeWhere(req);
        const vals = [...scope.vals], where = [scope.sql];
        const groups = { open: ['pending', 'lead_ok'], approved: ['approved'], paid: ['paid'], rejected: ['rejected'] };
        const st = req.query.status || 'open';
        if (groups[st]) { vals.push(groups[st]); where.push(`c.status = ANY($${vals.length})`); }
        const rows = (await db.query(
            `SELECT ${CLAIM_COLS} FROM team_claims c JOIN team_employees e ON e.id = c.employee_id
              WHERE ${where.join(' AND ')} ORDER BY c.created_at DESC LIMIT 300`, vals)).rows;
        const counts = (await db.query(
            `SELECT c.status, COUNT(*)::int AS n FROM team_claims c JOIN team_employees e ON e.id = c.employee_id
              WHERE ${scope.sql} GROUP BY c.status`, scope.vals)).rows;
        const advances = (await canPayroll(req)) ? (await db.query(
            `SELECT a.id, a.employee_id, e.name, a.amount, TO_CHAR(a.given_on, 'YYYY-MM-DD') AS given_on, a.recover_per_month, a.note,
                    a.amount - LEAST(a.amount, COALESCE((SELECT SUM(l.advance_back) FROM team_pay_lines l JOIN team_pay_runs r ON r.id = l.run_id
                        WHERE l.employee_id = a.employee_id AND r.status <> 'draft'), 0)) AS owed
               FROM team_advances a JOIN team_employees e ON e.id = a.employee_id ORDER BY a.given_on DESC`)).rows : [];
        res.json({ claims: rows, counts: Object.fromEntries(counts.map(c => [c.status, c.n])), advances, categories: CLAIM_CATEGORIES });
    } catch (err) {
        console.error('team claims error:', err);
        res.status(500).json({ error: 'Failed to load claims' });
    }
});

// POST /api/team/claims — multipart: title, amount, spent_on, category, company, link_ref, with_salary, employee_id?, receipts[]
router.post('/claims', takeReceipts, async (req, res) => {
    const files = req.files || [];
    const drop = () => files.forEach(f => fs.rm(f.path, { force: true }, () => {}));
    const b = req.body || {};
    const amount = num(b.amount);
    if (!clean(b.title)) { drop(); return res.status(400).json({ error: 'Say what it was for' }); }
    if (!amount || amount <= 0) { drop(); return res.status(400).json({ error: 'Enter the amount' }); }
    if (!isDate(b.spent_on)) { drop(); return res.status(400).json({ error: 'Choose the date it was spent' }); }
    try {
        let emp;
        if (b.employee_id) {
            emp = await employee(b.employee_id);
            if (!emp || (!(await canPayroll(req)) && !isSelf(req, emp))) { drop(); return res.status(403).json({ error: 'You can submit claims only for yourself' }); }
        } else {
            emp = await myEmployee(req);
            if (!emp) { drop(); return res.status(400).json({ error: 'Your login is not linked to a person in Payroll yet — ask the payroll manager' }); }
        }
        const r = await db.query(
            `INSERT INTO team_claims (employee_id, title, amount, spent_on, category, company, link_ref, with_salary, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
            [emp.id, clean(b.title), amount, b.spent_on, CLAIM_CATEGORIES.includes(b.category) ? b.category : 'Other',
             COMPANIES.includes(b.company) ? b.company : emp.company, clean(b.link_ref), String(b.with_salary) !== 'false', me(req)]);
        const id = r.rows[0].id;
        if (files.length) {
            const dir = path.join(RECEIPTS, String(id));
            fs.mkdirSync(dir, { recursive: true });
            const saved = files.map(f => {
                const dest = path.join(dir, path.basename(f.path));
                fs.renameSync(f.path, dest);
                return { file: path.basename(f.path), name: f.originalname, type: f.mimetype };
            });
            await db.query('UPDATE team_claims SET receipts = $1 WHERE id = $2', [JSON.stringify(saved), id]);
        }
        await teamNotify.tell({
            usernames: await approversOf(emp), event: 'claim', actor: me(req),
            title: `${emp.name} submitted a claim of ₹${amount}`, body: clean(b.title),
            link: '/team/payroll?tab=claims', subject: `Claim: ${emp.name}, ₹${amount}`, group: `claim:${id}`,
        });
        res.json({ success: true, id });
    } catch (err) {
        drop();
        console.error('team claim create error:', err);
        res.status(500).json({ error: 'Failed to submit the claim' });
    }
});

// POST /api/team/claims/:id/decide — { decision: approve|reject, reason }
router.post('/claims/:id/decide', async (req, res) => {
    const decision = req.body?.decision;
    if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'Approve or reject' });
    try {
        const c = (await db.query(`SELECT ${CLAIM_COLS} FROM team_claims c JOIN team_employees e ON e.id = c.employee_id WHERE c.id = $1`, [req.params.id])).rows[0];
        if (!c) return res.status(404).json({ error: 'Claim not found' });
        const emp = await employee(c.employee_id);
        if (isSelf(req, emp)) return res.status(403).json({ error: 'Someone else has to approve your own claim' });
        const pay = await canPayroll(req), lead = managesEmp(req, emp);
        if (!pay && !lead) return res.status(403).json({ error: 'Only their manager or payroll can decide this' });
        if (!['pending', 'lead_ok'].includes(c.status)) return res.status(400).json({ error: 'This claim was already decided' });
        let status, title;
        if (decision === 'reject') {
            if (!clean(req.body.reason)) return res.status(400).json({ error: 'Say why it is rejected' });
            status = 'rejected';
            await db.query(`UPDATE team_claims SET status = 'rejected', rejected_by = $1, rejected_reason = $2 WHERE id = $3`, [me(req), clean(req.body.reason), c.id]);
            title = `Your claim "${c.title}" was rejected`;
        } else if (pay) {
            status = 'approved';
            await db.query(`UPDATE team_claims SET status = 'approved', approved_by = $1, approved_at = NOW(),
                                lead_by = COALESCE(lead_by, $1), lead_at = COALESCE(lead_at, NOW()) WHERE id = $2`, [me(req), c.id]);
            title = `Your claim "${c.title}" was approved${c.with_salary ? ' — paid with your next salary' : ''}`;
        } else {
            status = 'lead_ok';
            if (c.status === 'lead_ok') return res.status(400).json({ error: 'Already approved by the manager — waiting for payroll' });
            await db.query(`UPDATE team_claims SET status = 'lead_ok', lead_by = $1, lead_at = NOW() WHERE id = $2`, [me(req), c.id]);
            title = `Your claim "${c.title}" was approved by ${me(req).split('@')[0]} — waiting for payroll`;
            const payrollPeople = (await db.query(
                `SELECT username FROM admin_users WHERE COALESCE(is_active, true) AND (role IN ('owner','admin') OR COALESCE(can_view_payroll, false))`)).rows.map(r => r.username);
            await teamNotify.tell({ usernames: payrollPeople, event: 'claim', actor: me(req),
                title: `Claim ready for payroll: ${emp.name}, ₹${Number(c.amount)}`, body: c.title, link: '/team/payroll?tab=claims', group: `claim:${c.id}` });
        }
        if (emp.username) {
            await teamNotify.tell({ usernames: [emp.username], event: 'claim', actor: me(req), title,
                body: decision === 'reject' ? req.body.reason : `₹${Number(c.amount)}`, link: '/team/me', group: `claim:${c.id}` });
        }
        res.json({ success: true, status });
    } catch (err) {
        console.error('team claim decide error:', err);
        res.status(500).json({ error: 'Failed to save the decision' });
    }
});

// POST /api/team/claims/:id/paid — an approved claim paid outside the salary
router.post('/claims/:id/paid', requirePayroll, async (req, res) => {
    try {
        const c = (await db.query(`SELECT ${CLAIM_COLS} FROM team_claims c JOIN team_employees e ON e.id = c.employee_id WHERE c.id = $1`, [req.params.id])).rows[0];
        if (!c) return res.status(404).json({ error: 'Claim not found' });
        if (c.status !== 'approved') return res.status(400).json({ error: 'Approve the claim first' });
        await db.query(`UPDATE team_claims SET status = 'paid', paid_at = NOW() WHERE id = $1`, [c.id]);
        if (c.username) await teamNotify.tell({ usernames: [c.username], event: 'claim', actor: me(req), title: `Your claim "${c.title}" was paid`, body: `₹${Number(c.amount)}`, link: '/team/me', group: `claim:${c.id}` });
        res.json({ success: true });
    } catch (err) {
        console.error('team claim paid error:', err);
        res.status(500).json({ error: 'Failed to mark it paid' });
    }
});

// GET /api/team/claims/:id/receipt/:n — the file, for the claimant, their manager or payroll
router.get('/claims/:id/receipt/:n', async (req, res) => {
    try {
        const c = (await db.query('SELECT employee_id, receipts FROM team_claims WHERE id = $1', [req.params.id])).rows[0];
        if (!c) return res.status(404).json({ error: 'Not found' });
        const emp = await employee(c.employee_id);
        if (!(await canPayroll(req)) && !isSelf(req, emp) && !managesEmp(req, emp)) return res.status(403).json({ error: 'Access denied' });
        const r = (c.receipts || [])[Number(req.params.n)];
        if (!r) return res.status(404).json({ error: 'Not found' });
        const file = path.join(RECEIPTS, String(req.params.id), path.basename(r.file));
        if (!fs.existsSync(file)) return res.status(404).json({ error: 'The file is missing' });
        res.setHeader('Content-Type', r.type || 'application/octet-stream');
        res.setHeader('Content-Disposition', `inline; filename="${String(r.name || 'receipt').replace(/[^\w. -]/g, '')}"`);
        fs.createReadStream(file).pipe(res);
    } catch (err) {
        console.error('team receipt error:', err);
        res.status(500).json({ error: 'Failed to open the receipt' });
    }
});

// POST /api/team/advances — { employee_id, amount, given_on, recover_per_month, note }
router.post('/advances', requirePayroll, async (req, res) => {
    const amount = num(req.body?.amount), per = num(req.body?.recover_per_month);
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Enter the amount given' });
    if (!per || per <= 0) return res.status(400).json({ error: 'Enter how much to take back each month' });
    if (!isDate(req.body?.given_on)) return res.status(400).json({ error: 'Choose the date it was given' });
    try {
        const emp = await employee(req.body.employee_id);
        if (!emp) return res.status(404).json({ error: 'Person not found' });
        await db.query(
            `INSERT INTO team_advances (employee_id, amount, given_on, recover_per_month, note, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
            [emp.id, amount, req.body.given_on, Math.min(per, amount), clean(req.body.note), me(req)]);
        res.json({ success: true });
    } catch (err) {
        console.error('team advance error:', err);
        res.status(500).json({ error: 'Failed to save the advance' });
    }
});

/* ───────────────────────────── settings ───────────────────────────── */

router.get('/settings', requirePayroll, async (req, res) => {
    try { res.json({ settings: await payroll.getSettings() }); } catch (err) {
        console.error('team settings error:', err);
        res.status(500).json({ error: 'Failed to load settings' });
    }
});

router.put('/settings', requirePayroll, async (req, res) => {
    try {
        const cur = await payroll.getSettings();
        const b = req.body || {};
        const pos = (v, d) => { const n = num(v); return n == null || n < 0 ? d : n; };
        const next = {
            ...cur,
            day_basis: ['thirty', 'month', 'working'].includes(b.day_basis) ? b.day_basis : cur.day_basis,
            paid_leave_per_month: pos(b.paid_leave_per_month, cur.paid_leave_per_month),
            carry_max: pos(b.carry_max, cur.carry_max),
            permission_hours: pos(b.permission_hours, cur.permission_hours),
            permission_block_hours: Math.max(0.5, pos(b.permission_block_hours, cur.permission_block_hours)),
            pay_day: Math.min(28, Math.max(1, pos(b.pay_day, cur.pay_day))),
            lop: Object.fromEntries(Object.keys(payroll.DEFAULTS.lop).map(k => [k, b.lop?.[k] === undefined ? cur.lop[k] : !!b.lop[k]])),
            companies: {
                normless: { name: clean(b.companies?.normless?.name) || cur.companies.normless.name, address: clean(b.companies?.normless?.address) ?? '' },
                crewfit: { name: clean(b.companies?.crewfit?.name) || cur.companies.crewfit.name, address: clean(b.companies?.crewfit?.address) ?? '' },
            },
        };
        await payroll.saveSettings(next, me(req));
        res.json({ success: true, settings: next });
    } catch (err) {
        console.error('team settings save error:', err);
        res.status(500).json({ error: 'Failed to save settings' });
    }
});

/* ───────────────────────────── payroll runs ───────────────────────────── */

const LINE_COLS = `l.*, e.name, e.emp_code, e.company, e.department, e.designation, e.username, e.email,
    e.bank_name, e.bank_account, e.bank_ifsc, e.upi_id, TO_CHAR(e.joined_on, 'YYYY-MM-DD') AS joined_on`;
const runOf = async (id) => (await db.query(
    `SELECT id, TO_CHAR(month, 'YYYY-MM-DD') AS month, status, TO_CHAR(pay_date, 'YYYY-MM-DD') AS pay_date,
            prepared_by, approved_by, approved_at, created_at FROM team_pay_runs WHERE id = $1`, [id])).rows[0];

router.get('/runs', requirePayroll, async (req, res) => {
    try {
        const rows = (await db.query(
            `SELECT r.id, TO_CHAR(r.month, 'YYYY-MM-DD') AS month, r.status, r.approved_by,
                    COUNT(l.id)::int AS people, COALESCE(SUM(l.net), 0) AS net,
                    COUNT(l.id) FILTER (WHERE l.status = 'paid')::int AS paid
               FROM team_pay_runs r LEFT JOIN team_pay_lines l ON l.run_id = r.id
              GROUP BY r.id ORDER BY r.month DESC`)).rows;
        res.json({ runs: rows });
    } catch (err) {
        console.error('team runs error:', err);
        res.status(500).json({ error: 'Failed to load payroll runs' });
    }
});

// POST /api/team/runs — { month: 'YYYY-MM' } starts that month's run (or opens the existing one)
router.post('/runs', requirePayroll, async (req, res) => {
    if (!/^\d{4}-\d{2}$/.test(req.body?.month || '')) return res.status(400).json({ error: 'Choose the month' });
    try {
        const month = `${req.body.month}-01`;
        const settings = await payroll.getSettings();
        const pay = new Date(`${payroll.monthEnd(month)}T00:00:00Z`);
        pay.setUTCDate(pay.getUTCDate() + Number(settings.pay_day || 1));
        const r = await db.query(
            `INSERT INTO team_pay_runs (month, pay_date, prepared_by) VALUES ($1, $2, $3)
             ON CONFLICT (month) DO UPDATE SET month = EXCLUDED.month RETURNING id`, [month, pay.toISOString().slice(0, 10), me(req)]);
        await payroll.refreshRun(r.rows[0].id);
        res.json({ success: true, id: r.rows[0].id });
    } catch (err) {
        console.error('team run create error:', err);
        res.status(500).json({ error: 'Failed to start the run' });
    }
});

// GET /api/team/runs/:id — a draft is worked out afresh each time it is opened
router.get('/runs/:id', requirePayroll, async (req, res) => {
    try {
        let run = await runOf(req.params.id);
        if (!run) return res.status(404).json({ error: 'Run not found' });
        if (run.status === 'draft') { await payroll.refreshRun(run.id); run = await runOf(run.id); }
        const lines = (await db.query(
            `SELECT ${LINE_COLS} FROM team_pay_lines l JOIN team_employees e ON e.id = l.employee_id WHERE l.run_id = $1 ORDER BY e.name`, [run.id])).rows;
        const sum = (k) => lines.reduce((a, l) => a + Number(l[k] || 0), 0);
        const prev = (await db.query(
            `SELECT COALESCE(SUM(l.net), 0) AS net FROM team_pay_lines l JOIN team_pay_runs r ON r.id = l.run_id
              WHERE r.month = ($1::date - INTERVAL '1 month')::date`, [run.month])).rows[0];
        const checks = [];
        for (const l of lines) {
            if (!l.bank_account && !l.upi_id) checks.push({ employee_id: l.employee_id, text: `${l.name} has no bank account — pay by cash or add it first` });
            if (Number(l.lop_days) >= 2) checks.push({ employee_id: l.employee_id, text: `${l.name} has ${Number(l.lop_days)} days loss of pay` });
            if (Number(l.net) <= 0) checks.push({ employee_id: l.employee_id, text: `${l.name}'s pay comes to ₹${Number(l.net)}` });
        }
        res.json({
            run: { ...run, name: payroll.monthName(run.month) },
            lines: lines.map(({ bank_account, ...l }) => ({ ...l, has_bank: !!bank_account, bank_last4: bank_account ? String(bank_account).slice(-4) : null })),
            totals: { salary: sum('salary'), lop: sum('lop_amount'), lop_days: sum('lop_days'), incentive: sum('incentive'), claims: sum('claims'),
                advance: sum('advance_back'), net: sum('net'), paid_leave: sum('paid_leave_days'), previous: Number(prev.net) || 0,
                lop_people: lines.filter(l => Number(l.lop_days) > 0).length },
            checks, canApprove: isAdmin(req),
        });
    } catch (err) {
        console.error('team run error:', err);
        res.status(500).json({ error: 'Failed to load the run' });
    }
});

// PUT /api/team/runs/:id/lines/:lineId — { incentive, incentive_note } while the run is a draft
router.put('/runs/:id/lines/:lineId', requirePayroll, async (req, res) => {
    try {
        const run = await runOf(req.params.id);
        if (!run) return res.status(404).json({ error: 'Run not found' });
        if (run.status !== 'draft') return res.status(400).json({ error: 'This run is approved — reopen it to change amounts' });
        const incentive = num(req.body?.incentive) ?? 0;
        if (incentive < 0) return res.status(400).json({ error: 'Incentive cannot be negative' });
        const l = (await db.query('SELECT * FROM team_pay_lines WHERE id = $1 AND run_id = $2', [req.params.lineId, run.id])).rows[0];
        if (!l) return res.status(404).json({ error: 'Line not found' });
        const net = payroll.netOf({ ...l, incentive });
        await db.query('UPDATE team_pay_lines SET incentive = $1, incentive_note = $2, net = $3 WHERE id = $4',
            [incentive, clean(req.body?.incentive_note), net, l.id]);
        res.json({ success: true, net });
    } catch (err) {
        console.error('team line error:', err);
        res.status(500).json({ error: 'Failed to save' });
    }
});

// POST /api/team/runs/:id/approve — owners and admins lock the numbers
router.post('/runs/:id/approve', async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only an owner or admin approves payroll' });
    try {
        const run = await runOf(req.params.id);
        if (!run) return res.status(404).json({ error: 'Run not found' });
        if (run.status !== 'draft') return res.status(400).json({ error: 'Already approved' });
        await payroll.refreshRun(run.id);
        await db.transaction(async (c) => {
            await c.query(`UPDATE team_pay_runs SET status = 'approved', approved_by = $1, approved_at = NOW() WHERE id = $2`, [me(req), run.id]);
            const lines = (await c.query('SELECT detail FROM team_pay_lines WHERE run_id = $1', [run.id])).rows;
            const ids = lines.flatMap(l => l.detail?.claim_ids || []);
            if (ids.length) await c.query('UPDATE team_claims SET paid_run_id = $1 WHERE id = ANY($2)', [run.id, ids]);
        });
        res.json({ success: true });
    } catch (err) {
        console.error('team run approve error:', err);
        res.status(500).json({ error: 'Failed to approve' });
    }
});

// POST /api/team/runs/:id/reopen — back to a draft, while nobody has been paid from it
router.post('/runs/:id/reopen', async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only an owner or admin can reopen payroll' });
    try {
        const run = await runOf(req.params.id);
        if (!run) return res.status(404).json({ error: 'Run not found' });
        const paid = (await db.query(`SELECT COUNT(*)::int AS n FROM team_pay_lines WHERE run_id = $1 AND status = 'paid'`, [run.id])).rows[0].n;
        if (paid) return res.status(400).json({ error: 'People have already been paid from this run' });
        await db.query(`UPDATE team_pay_runs SET status = 'draft', approved_by = NULL, approved_at = NULL WHERE id = $1`, [run.id]);
        await db.query(`UPDATE team_claims SET paid_run_id = NULL WHERE paid_run_id = $1`, [run.id]);
        res.json({ success: true });
    } catch (err) {
        console.error('team run reopen error:', err);
        res.status(500).json({ error: 'Failed to reopen' });
    }
});

/** A payslip as a PDF buffer. */
function payslipBuffer(args) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', margin: 0 });
        const parts = [];
        doc.on('data', (b) => parts.push(b));
        doc.on('end', () => resolve(Buffer.concat(parts)));
        doc.on('error', reject);
        payroll.renderPayslip(doc, args);
        doc.end();
    });
}

// POST /api/team/runs/:id/paid — { line_ids: [...] | 'all', utr } marks people paid and sends payslips
router.post('/runs/:id/paid', requirePayroll, async (req, res) => {
    try {
        const run = await runOf(req.params.id);
        if (!run) return res.status(404).json({ error: 'Run not found' });
        if (run.status === 'draft') return res.status(400).json({ error: 'The run has to be approved first' });
        const all = req.body?.line_ids === 'all';
        const ids = all ? null : (Array.isArray(req.body?.line_ids) ? req.body.line_ids.map(Number).filter(Number.isFinite) : []);
        if (!all && !ids.length) return res.status(400).json({ error: 'Choose who was paid' });
        const lines = (await db.query(
            `SELECT ${LINE_COLS} FROM team_pay_lines l JOIN team_employees e ON e.id = l.employee_id
              WHERE l.run_id = $1 AND l.status <> 'paid' ${all ? '' : 'AND l.id = ANY($2)'}`, all ? [run.id] : [run.id, ids])).rows;
        const settings = await payroll.getSettings();
        let emailed = 0;
        for (const l of lines) {
            await db.query(`UPDATE team_pay_lines SET status = 'paid', paid_at = NOW(), utr = $1 WHERE id = $2`, [clean(req.body?.utr), l.id]);
            const ids2 = l.detail?.claim_ids || [];
            if (ids2.length) await db.query(`UPDATE team_claims SET status = 'paid', paid_at = NOW() WHERE id = ANY($1)`, [ids2]);
            const line = { ...l, paid_at: new Date() };
            if (l.username) {
                await teamNotify.tell({ usernames: [l.username], event: 'payslip', actor: me(req),
                    title: `Your ${payroll.monthName(run.month)} payslip is ready`, body: `₹${Number(l.net).toLocaleString('en-IN')} paid`, link: '/team/me', group: `payslip:${l.id}` });
            }
            // The payslip goes by email straight away (not batched): it carries the PDF.
            const prefs = l.username ? await teamNotify.prefsOf(l.username) : null;
            const to = l.username ? await teamNotify.emailOf(l.username) : (mailer.looksLikeEmail(l.email) ? l.email : null);
            if (to && (!prefs || prefs.events.payslip.email)) {
                const pdf = await payslipBuffer({ line, emp: l, run, settings });
                const ok = await mailer.send({
                    to, subject: `Your payslip for ${payroll.monthName(run.month)}`,
                    html: mailer.layout({ greeting: `Hi ${String(l.name).split(' ')[0]},`,
                        lines: [`Your salary for ${payroll.monthName(run.month)} has been paid: <b>₹${Number(l.net).toLocaleString('en-IN')}</b>.`, 'Your payslip is attached.'],
                        button: l.username ? { href: mailer.appUrl('/team/me'), label: 'See all your payslips' } : null,
                        footer: l.username ? undefined : ' ' }),
                    attachments: [{ filename: `Payslip-${run.month.slice(0, 7)}-${String(l.name).replace(/[^\w]+/g, '-')}.pdf`, content: pdf }],
                });
                if (ok) emailed++;
            }
        }
        const left = (await db.query(`SELECT COUNT(*)::int AS n FROM team_pay_lines WHERE run_id = $1 AND status <> 'paid'`, [run.id])).rows[0].n;
        if (!left) await db.query(`UPDATE team_pay_runs SET status = 'paid' WHERE id = $1`, [run.id]);
        res.json({ success: true, paid: lines.length, emailed });
    } catch (err) {
        console.error('team run paid error:', err);
        res.status(500).json({ error: 'Failed to mark paid' });
    }
});

// GET /api/team/runs/:id/bank.csv
router.get('/runs/:id/bank.csv', requirePayroll, async (req, res) => {
    try {
        const run = await runOf(req.params.id);
        if (!run) return res.status(404).json({ error: 'Run not found' });
        if (run.status === 'draft') return res.status(400).json({ error: 'Approve the run first' });
        const lines = (await db.query(
            `SELECT ${LINE_COLS} FROM team_pay_lines l JOIN team_employees e ON e.id = l.employee_id
              WHERE l.run_id = $1 ${req.query.company ? `AND (e.company = $2 OR e.company = 'both')` : ''} ORDER BY e.name`,
            req.query.company ? [run.id, req.query.company] : [run.id])).rows;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="salaries-${run.month.slice(0, 7)}.csv"`);
        res.send(payroll.bankCsv(lines, run.month));
    } catch (err) {
        console.error('team bank file error:', err);
        res.status(500).json({ error: 'Failed to build the bank file' });
    }
});

// GET /api/team/runs/:id/payslip/:employeeId — payroll, or the person themself once approved
router.get('/runs/:id/payslip/:employeeId', async (req, res) => {
    try {
        const run = await runOf(req.params.id);
        if (!run) return res.status(404).json({ error: 'Run not found' });
        const emp = await employee(req.params.employeeId);
        const pay = await canPayroll(req);
        if (!pay && !(isSelf(req, emp) && run.status !== 'draft')) return res.status(403).json({ error: 'Access denied' });
        if (run.status === 'draft') await payroll.refreshRun(run.id);
        const line = (await db.query(
            `SELECT ${LINE_COLS} FROM team_pay_lines l JOIN team_employees e ON e.id = l.employee_id
              WHERE l.run_id = $1 AND l.employee_id = $2`, [run.id, req.params.employeeId])).rows[0];
        if (!line) return res.status(404).json({ error: 'No payslip for this person in this run' });
        const pdf = await payslipBuffer({ line, emp: line, run, settings: await payroll.getSettings() });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="Payslip-${run.month.slice(0, 7)}-${String(line.name).replace(/[^\w]+/g, '-')}.pdf"`);
        res.send(pdf);
    } catch (err) {
        console.error('team payslip error:', err);
        res.status(500).json({ error: 'Failed to build the payslip' });
    }
});

module.exports = router;
