/**
 * Telling people about Team updates: the CRM bell straight away, and an email if they want it.
 *
 * Each person chooses per event (team_notify_prefs). Emails wait a few minutes in
 * team_email_queue so several changes to one task go as one message; the flush loop sends them.
 * A morning summary at 9:30 IST lists each person's tasks due today and late.
 */

const db = require('../db/connection');
const mailer = require('./mailer');
const { notify } = require('./notify');

// Who can switch what off. Payslips and approvals still reach the CRM bell either way.
const EVENTS = {
    assigned: { label: 'A task is assigned to me', crm: true, email: true },
    mention: { label: 'Someone @mentions me', crm: true, email: true },
    status: { label: 'A task I watch changes status', crm: true, email: true },
    comment: { label: 'New comment on a task I watch', crm: true, email: false },
    due: { label: 'Due today or late', crm: true, email: true },
    leave: { label: 'Leave asked for, approved or rejected', crm: true, email: true },
    claim: { label: 'Claim approved, rejected or paid', crm: true, email: true },
    payslip: { label: 'My payslip is ready', crm: true, email: true },
};
const BATCH_MINUTES = 5;

async function prefsOf(username) {
    const row = (await db.query('SELECT prefs FROM team_notify_prefs WHERE username = $1', [username])).rows[0];
    const saved = row?.prefs || {};
    const out = { digest: saved.digest !== false, events: {} };
    for (const [k, d] of Object.entries(EVENTS)) {
        out.events[k] = { crm: saved.events?.[k]?.crm ?? d.crm, email: saved.events?.[k]?.email ?? d.email };
    }
    return out;
}

/** The address an account's email goes to: its username when that is an email, else its employee record's. */
async function emailOf(username) {
    if (mailer.looksLikeEmail(username)) return username;
    const r = (await db.query('SELECT email FROM team_employees WHERE LOWER(username) = LOWER($1)', [username])).rows[0];
    return mailer.looksLikeEmail(r?.email) ? r.email : null;
}

/**
 * One update to several people. `link` is a CRM path; `group` keys the email batch (a task id),
 * so updates to one thing within a few minutes become one email.
 */
async function tell({ usernames = [], event, title, body, link, actor, subject, group }) {
    const targets = [...new Set(usernames.filter(Boolean))].filter(u => u !== actor);
    for (const username of targets) {
        try {
            const p = await prefsOf(username);
            const ev = p.events[event] || { crm: true, email: false };
            if (ev.crm) await notify({ usernames: [username], kind: event, title, body, link, actor });
            if (ev.email) {
                const to = await emailOf(username);
                if (to) {
                    await db.query(
                        `INSERT INTO team_email_queue (to_email, group_key, subject, line, link, send_after)
                         VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '${BATCH_MINUTES} minutes')`,
                        [to, String(group || `${event}:${title}`), subject || title,
                         body ? `${title} — ${body}` : title, link || null]);
                }
            }
        } catch (err) {
            console.error('team notify failed:', err.message);
        }
    }
}

/** Send what has waited long enough: one email per person per group. */
async function flush() {
    const due = (await db.query(
        `SELECT id, to_email, group_key, subject, line, link FROM team_email_queue
          WHERE sent_at IS NULL AND send_after <= NOW() ORDER BY id LIMIT 200`)).rows;
    const groups = new Map();
    for (const r of due) {
        const k = `${r.to_email}|${r.group_key}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
    }
    for (const rows of groups.values()) {
        const first = rows[0], last = rows[rows.length - 1];
        const html = mailer.layout({
            lines: rows.map(r => mailer.esc(r.line)),
            button: last.link ? { href: mailer.appUrl(last.link), label: 'Open in the CRM' } : null,
        });
        await mailer.send({ to: first.to_email, subject: rows.length > 1 ? `${last.subject} (+${rows.length - 1} more)` : last.subject, html });
        await db.query('UPDATE team_email_queue SET sent_at = NOW() WHERE id = ANY($1)', [rows.map(r => r.id)]);
    }
    await db.query(`DELETE FROM team_email_queue WHERE sent_at < NOW() - INTERVAL '14 days'`);
}

const istNow = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
const istDate = () => { const d = istNow(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** Once a day after 9:30 IST: the bell and (if wanted) one summary email per person. */
async function morning() {
    const now = istNow();
    if (now.getHours() < 9 || (now.getHours() === 9 && now.getMinutes() < 30)) return;
    const today = istDate();
    const last = (await db.query(`SELECT value FROM team_settings WHERE key = 'morning_sent'`)).rows[0]?.value?.day;
    if (last === today) return;
    await db.query(
        `INSERT INTO team_settings (key, value) VALUES ('morning_sent', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, [JSON.stringify({ day: today })]);

    const rows = (await db.query(
        `SELECT t.id, t.number, t.title, t.assignee, TO_CHAR(t.due_on, 'YYYY-MM-DD') AS due_on, b.key, b.id AS board_id
           FROM tasks t JOIN task_boards b ON b.id = t.board_id
          WHERE t.assignee IS NOT NULL AND t.due_on <= $1::date
            AND t.status NOT IN ('done','rejected','ideas') AND NOT b.archived
          ORDER BY t.due_on`, [today])).rows;
    const byPerson = new Map();
    for (const r of rows) {
        if (!byPerson.has(r.assignee)) byPerson.set(r.assignee, []);
        byPerson.get(r.assignee).push(r);
    }
    for (const [username, list] of byPerson) {
        const p = await prefsOf(username);
        if (p.events.due.crm) {
            for (const t of list) {
                await notify({ usernames: [username], kind: 'due',
                    title: `${t.key}-${t.number} is ${t.due_on < today ? 'late' : 'due today'}`, body: t.title,
                    link: `/team/tasks?board=${t.board_id}&task=${t.id}`, actor: null });
            }
        }
        if (p.digest && p.events.due.email) {
            const to = await emailOf(username);
            if (!to) continue;
            const late = list.filter(t => t.due_on < today), todayList = list.filter(t => t.due_on === today);
            const line = (t) => `<b>${mailer.esc(`${t.key}-${t.number}`)}</b> ${mailer.esc(t.title)}${t.due_on < today ? ` <span style="color:#b42318">(due ${t.due_on})</span>` : ''}`;
            await mailer.send({
                to,
                subject: `Your tasks today: ${todayList.length} due${late.length ? `, ${late.length} late` : ''}`,
                html: mailer.layout({
                    greeting: 'Good morning,',
                    lines: [...(todayList.length ? ['<b>Due today</b>', ...todayList.map(line)] : []),
                            ...(late.length ? ['<b>Late</b>', ...late.map(line)] : [])],
                    button: { href: mailer.appUrl('/team/tasks?mine=1'), label: 'Open my tasks' },
                }),
            });
        }
    }
}

let started = false;
function start() {
    if (started) return;
    started = true;
    const safe = (fn) => () => fn().catch(err => console.error('team notify loop:', err.message));
    setInterval(safe(flush), 60 * 1000);
    setInterval(safe(morning), 5 * 60 * 1000);
    setTimeout(safe(morning), 20 * 1000);
}

module.exports = { tell, prefsOf, EVENTS, start, flush, morning, emailOf, istDate };
