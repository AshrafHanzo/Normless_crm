/**
 * The clock behind automatic backups.
 *
 * Two schedules, because the two halves change at completely different rates: the database is
 * small and changes constantly, the uploads folder is ~924 MB and gains a handful of photos a day.
 * Dumping 924 MB every night to capture 3 MB of new files would burn bandwidth for nothing.
 *
 *   db_cron     — the Postgres dump. Nightly by default.
 *   files_cron  — uploads + storage, incremental, with a full copy every `files_full_every_days`.
 *
 * ── The passphrase problem ──
 *
 * Archives are encrypted with a passphrase the server deliberately does not keep, which is what
 * makes a stolen backup useless. But a scheduled run at 3am has nobody to type it.
 *
 * So the owner opts in: enabling the schedule stores the passphrase sealed with JWT_SECRET, the
 * same way the Telegram session is. It is an honest, stated trade — someone who takes both the
 * database *and* the .env can open the archives. Someone who takes only the backups still cannot,
 * which is the threat that actually matters here, since the backups are the thing leaving the
 * building. Scheduling off means nothing is stored and every run is typed by hand.
 */

const cron = require('node-cron');
const crypto = require('crypto');
const store = require('./store');
const runner = require('./runner');

let tasks = [];
let lastError = null;

const AAD = Buffer.from('normless-backup-passphrase-v1');

function sealKey() {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET is not set');
    return crypto.createHash('sha256').update(`backup-passphrase-seal|${secret}`).digest();
}

function sealPassphrase(plain) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', sealKey(), iv);
    c.setAAD(AAD);
    const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
    return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${body.toString('base64')}`;
}

function openPassphrase(sealed) {
    if (!sealed) return null;
    const [v, ivB, tagB, bodyB] = String(sealed).split('.');
    if (v !== 'v1') return null;
    try {
        const d = crypto.createDecipheriv('aes-256-gcm', sealKey(), Buffer.from(ivB, 'base64'));
        d.setAAD(AAD);
        d.setAuthTag(Buffer.from(tagB, 'base64'));
        return Buffer.concat([d.update(Buffer.from(bodyB, 'base64')), d.final()]).toString('utf8');
    } catch {
        return null;   // JWT_SECRET rotated — the schedule stops rather than failing every night
    }
}

/** Tear down every registered cron task. */
function stop() {
    for (const t of tasks) { try { t.task.destroy(); } catch { /* already gone */ } }
    tasks = [];
}

/**
 * Read the config and (re)arm the schedules. Safe to call repeatedly — settings changes do.
 */
async function reload() {
    stop();
    lastError = null;

    let cfg;
    try { cfg = await store.getConfig(); } catch (e) { lastError = e.message; return { active: false, reason: e.message }; }

    if (!cfg) return { active: false, reason: 'Backups are not set up yet' };
    if (!cfg.schedule_enabled) return { active: false, reason: 'Scheduled backups are switched off' };
    if (!cfg.tg_session || !cfg.channel_id) return { active: false, reason: 'Telegram is not connected' };

    const passphrase = openPassphrase(cfg.sched_passphrase);
    if (!passphrase) {
        lastError = 'The stored passphrase could not be read (JWT_SECRET may have changed). Re-enter it in Backup settings.';
        return { active: false, reason: lastError };
    }

    const tz = cfg.timezone || 'Asia/Kolkata';
    const plan = [
        { key: 'db', expr: cfg.db_cron, kind: 'db' },
        { key: 'files', expr: cfg.files_cron, kind: 'files' },
    ];

    for (const p of plan) {
        if (!p.expr || !cron.validate(p.expr)) continue;
        const task = cron.schedule(p.expr, () => fire(p.kind, passphrase), { timezone: tz });
        tasks.push({ ...p, task, tz });
    }

    return { active: tasks.length > 0, count: tasks.length, ...status() };
}

/** Run one scheduled backup, swallowing failures — a thrown error inside cron kills the process. */
async function fire(kind, passphrase) {
    if (runner.isRunning()) {
        console.log(`⏭  Backup (${kind}) skipped — one is already running`);
        return;
    }
    try {
        console.log(`🗄  Scheduled backup starting (${kind})…`);
        const r = await runner.runBackup({ kind, trigger: 'schedule', startedBy: 'scheduler', passphrase });
        console.log(`✅ Scheduled backup #${r.id} finished — ${r.artifact_count} artifact(s)`);
    } catch (err) {
        lastError = err.message;
        console.error(`❌ Scheduled backup (${kind}) failed:`, err.message);
    }
}

/** What is armed and when it next fires — for the settings page. */
function status() {
    return {
        active: tasks.length > 0,
        lastError,
        jobs: tasks.map(t => {
            let next = null;
            try { next = t.task.getNextRun?.() || null; } catch { /* not started yet */ }
            return { key: t.key, cron: t.expr, timezone: t.tz, nextRun: next };
        }),
    };
}

/** The next fire time for an expression, without arming anything. Used to preview a setting. */
function previewNext(expr, tz = 'Asia/Kolkata') {
    if (!cron.validate(expr)) return null;
    let t;
    try {
        t = cron.schedule(expr, () => {}, { timezone: tz });
        return t.getNextRun?.() || null;
    } catch {
        return null;
    } finally {
        try { t?.destroy(); } catch { /* nothing to clean */ }
    }
}

module.exports = { reload, stop, status, previewNext, sealPassphrase, openPassphrase, validate: cron.validate };
