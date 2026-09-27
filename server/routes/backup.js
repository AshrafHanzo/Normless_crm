/**
 * The backup API.
 *
 * Two tiers of access, deliberately unequal:
 *
 *   can_view_backups — see the page, the history and the schedule, and start a backup.
 *   owner            — everything that can destroy or divert data: connecting a Telegram account,
 *                      changing the passphrase, restoring, and deleting runs. Those are not
 *                      "admin" actions, they are "the person who owns the business" actions.
 *
 * The passphrase is never stored by any of these endpoints (the scheduler is the one exception,
 * and it is opt-in and explained where it happens). It arrives in the body of the request that
 * needs it and is forgotten when that request ends.
 */

const express = require('express');
const db = require('../db/connection');
const { hasPermission } = require('../utils/permissions');

const store = require('../services/backup/store');
const tg = require('../services/backup/telegram');
const runner = require('../services/backup/runner');
const restore = require('../services/backup/restore');
const scheduler = require('../services/backup/scheduler');
const archive = require('../services/backup/archive');
const cryptoBox = require('../services/backup/crypto');

const router = express.Router();

/* ── gates ── */

router.use(async (req, res, next) => {
    try {
        if (!await hasPermission(req, 'can_view_backups')) {
            return res.status(403).json({ error: 'You do not have access to backups' });
        }
        next();
    } catch (err) { next(err); }
});

const ownerOnly = (req, res, next) =>
    req.user?.role === 'owner' ? next() : res.status(403).json({ error: 'Only an owner can do this' });

const fail = (res, err, fallback = 'Request failed') => {
    console.error('backup route error:', err);
    res.status(400).json({ error: String(err?.message || fallback) });
};

/* ── status ── */

// Everything the page needs for its first paint, in one request.
router.get('/status', async (req, res) => {
    try {
        const cfg = await store.getConfig();
        const pgd = await archive.checkPgDump();
        const [plan, restored] = await Promise.all([
            archive.planFiles({ uploads: true, storage: true }).catch(() => []),
            restore.listRestored().catch(() => []),
        ]);
        const dbSize = await db.query(`SELECT pg_database_size(current_database()) AS b`).then(r => Number(r.rows[0].b)).catch(() => null);

        res.json({
            config: store.publicConfig(cfg),
            schedule: scheduler.status(),
            running: runner.progress(),
            restoring: restore.progress(),
            environment: {
                pgDump: pgd,
                dbBytes: dbSize,
                sources: plan.map(g => ({ key: g.key, files: g.totalCount, bytes: g.totalBytes })),
            },
            restoredOnDisk: restored,
            isOwner: req.user?.role === 'owner',
        });
    } catch (err) { fail(res, err, 'Could not read backup status'); }
});

// Polled while a run is in flight; deliberately tiny.
router.get('/progress', (req, res) => {
    res.json({ backup: runner.progress(), restore: restore.progress() });
});

/* ── Telegram sign-in ── */

router.post('/telegram/start', ownerOnly, async (req, res) => {
    try {
        const { apiId, apiHash, phone } = req.body || {};
        if (!apiId || !apiHash || !phone) return res.status(400).json({ error: 'API ID, API hash and phone number are all required' });
        if (!/^\d+$/.test(String(apiId).trim())) return res.status(400).json({ error: 'API ID should be a number — check my.telegram.org' });

        const out = await tg.startLogin({ apiId: String(apiId).trim(), apiHash: String(apiHash).trim(), phone: String(phone).trim() });
        res.json({ token: out.token, viaApp: out.viaApp });
    } catch (err) { fail(res, err, 'Could not start the Telegram sign-in'); }
});

router.post('/telegram/code', ownerOnly, async (req, res) => {
    try {
        const { token, code } = req.body || {};
        if (!token || !code) return res.status(400).json({ error: 'Enter the code Telegram sent you' });

        const out = await tg.submitCode({ token, code });
        if (out.needsPassword) return res.json({ needsPassword: true });
        await persistSession(out, req.body);
        res.json({ connected: true, user: out.user });
    } catch (err) { fail(res, err, 'Could not verify the code'); }
});

router.post('/telegram/password', ownerOnly, async (req, res) => {
    try {
        const { token, password } = req.body || {};
        if (!token || !password) return res.status(400).json({ error: 'Enter your two-factor password' });

        const out = await tg.submitPassword({ token, password });
        await persistSession(out, req.body);
        res.json({ connected: true, user: out.user });
    } catch (err) { fail(res, err, 'Could not verify the password'); }
});

/** Store the session and make sure there is a channel to upload into. */
async function persistSession(out, body) {
    await store.ensureConfigRow();
    await store.updateConfig({
        tg_api_id: String(body.apiId || '').trim() || undefined,
        tg_api_hash: String(body.apiHash || '').trim() || undefined,
        tg_session: store.sealSession(out.session),
        tg_user_id: out.user.id,
        tg_username: out.user.username,
        tg_phone: out.user.phone,
        tg_user_name: out.user.name,
        tg_premium: !!out.user.premium,
    });

    // Create the channel now rather than lazily on the first run: better to fail here, while
    // somebody is watching the screen, than at 3am.
    const cfg = await store.getConfig();
    if (!cfg.channel_id) {
        const creds = await store.getCredentials();
        const chan = await tg.createChannel(creds);
        await store.updateConfig({
            channel_id: chan.id, channel_access_hash: chan.accessHash, channel_title: chan.title,
        });
    }
}

router.post('/telegram/cancel', ownerOnly, (req, res) => {
    tg.cancelLogin(req.body?.token);
    res.json({ ok: true });
});

router.post('/telegram/disconnect', ownerOnly, async (req, res) => {
    try {
        // The channel and its archives are left alone on purpose — disconnecting is not deleting,
        // and the backups stay restorable by signing the account back in.
        await store.updateConfig({ tg_session: null, schedule_enabled: false, sched_passphrase: null });
        await scheduler.reload();
        res.json({ ok: true });
    } catch (err) { fail(res, err, 'Could not disconnect'); }
});

router.get('/telegram/check', async (req, res) => {
    try {
        const creds = await store.getCredentials();
        if (!creds) return res.json({ connected: false });
        res.json({ connected: true, user: await tg.whoAmI(creds) });
    } catch (err) {
        res.json({ connected: false, error: String(err.message) });
    }
});

/* ── encryption passphrase ── */

router.post('/passphrase', ownerOnly, async (req, res) => {
    try {
        const { passphrase, confirm, current } = req.body || {};
        if (!passphrase || passphrase.length < 12) {
            return res.status(400).json({ error: 'Use a passphrase of at least 12 characters' });
        }
        if (passphrase !== confirm) return res.status(400).json({ error: 'The two passphrases do not match' });

        const cfg = await store.ensureConfigRow();
        if (cfg.passphrase_verifier) {
            // Changing it does not re-encrypt what is already uploaded, so the old one has to be
            // proven — otherwise someone could quietly orphan every existing archive.
            if (!await cryptoBox.checkPassphrase(current || '', cfg.passphrase_verifier)) {
                return res.status(400).json({ error: 'The current passphrase is wrong' });
            }
        }

        await store.updateConfig({ passphrase_verifier: await cryptoBox.passphraseVerifier(passphrase) });
        // A stored schedule passphrase would now be the old one; drop it and make them re-enable.
        if (cfg.sched_passphrase) {
            await db.query('UPDATE backup_config SET sched_passphrase = NULL, schedule_enabled = false WHERE id = $1', [store.CONFIG_ID]);
            await scheduler.reload();
        }
        res.json({ ok: true, rearmScheduleNeeded: !!cfg.sched_passphrase });
    } catch (err) { fail(res, err, 'Could not set the passphrase'); }
});

router.post('/passphrase/verify', async (req, res) => {
    try {
        const cfg = await store.getConfig();
        if (!cfg?.passphrase_verifier) return res.json({ ok: false, reason: 'No passphrase is set yet' });
        res.json({ ok: await cryptoBox.checkPassphrase(req.body?.passphrase || '', cfg.passphrase_verifier) });
    } catch (err) { fail(res, err, 'Could not check the passphrase'); }
});

/* ── settings ── */

const CRON_FIELDS = ['db_cron', 'files_cron'];

router.put('/settings', ownerOnly, async (req, res) => {
    try {
        const b = req.body || {};
        const patch = {};

        for (const f of CRON_FIELDS) {
            if (b[f] !== undefined) {
                if (!scheduler.validate(String(b[f]))) return res.status(400).json({ error: `"${b[f]}" is not a valid cron expression` });
                patch[f] = String(b[f]);
            }
        }
        if (b.timezone !== undefined) {
            try { new Intl.DateTimeFormat('en', { timeZone: String(b.timezone) }); }
            catch { return res.status(400).json({ error: 'Unknown timezone' }); }
            patch.timezone = String(b.timezone);
        }
        for (const f of ['include_uploads', 'include_storage']) if (b[f] !== undefined) patch[f] = !!b[f];
        for (const f of ['keep_daily', 'keep_weekly', 'keep_monthly']) {
            if (b[f] !== undefined) {
                const n = parseInt(b[f], 10);
                if (!Number.isFinite(n) || n < 1 || n > 365) return res.status(400).json({ error: `${f} must be between 1 and 365` });
                patch[f] = n;
            }
        }

        // Turning the schedule on needs the passphrase, because nobody will be here to type it.
        if (b.schedule_enabled !== undefined) {
            const on = !!b.schedule_enabled;
            if (on) {
                const cfg = await store.getConfig();
                if (!cfg?.passphrase_verifier) return res.status(400).json({ error: 'Set an encryption passphrase first' });
                if (!cfg.tg_session) return res.status(400).json({ error: 'Connect Telegram first' });
                if (!b.passphrase) return res.status(400).json({ error: 'Enter the passphrase to enable automatic backups' });
                if (!await cryptoBox.checkPassphrase(b.passphrase, cfg.passphrase_verifier)) {
                    return res.status(400).json({ error: 'That is not the backup passphrase' });
                }
                await db.query('UPDATE backup_config SET sched_passphrase = $1 WHERE id = $2',
                    [scheduler.sealPassphrase(b.passphrase), store.CONFIG_ID]);
            } else {
                await db.query('UPDATE backup_config SET sched_passphrase = NULL WHERE id = $1', [store.CONFIG_ID]);
            }
            patch.schedule_enabled = on;
        }

        await store.updateConfig(patch);
        const s = await scheduler.reload();
        res.json({ ok: true, config: store.publicConfig(await store.getConfig()), schedule: s });
    } catch (err) { fail(res, err, 'Could not save settings'); }
});

router.post('/settings/preview-cron', (req, res) => {
    const { expr, timezone } = req.body || {};
    if (!expr || !scheduler.validate(String(expr))) return res.status(400).json({ error: 'Not a valid cron expression' });
    res.json({ next: scheduler.previewNext(String(expr), timezone || 'Asia/Kolkata') });
});

/* ── running ── */

router.post('/run', async (req, res) => {
    try {
        const { kind = 'full', passphrase } = req.body || {};

        // Checked here, awaited, BEFORE anything is launched. A backup takes minutes, so the run
        // itself has to happen in the background and the browser cannot wait for it — which means
        // any error it throws later has nobody to report to. Everything knowable up front is
        // therefore settled up front, and only then is the run let go of.
        await runner.preflight({ kind, passphrase });

        runner.runBackup({ kind, trigger: 'manual', startedBy: req.user?.username, passphrase })
            .catch(err => console.error('manual backup failed:', err.message));

        res.json({ started: true, kind, by: req.user?.username });
    } catch (err) { fail(res, err, 'Could not start the backup'); }
});

/* ── history ── */

router.get('/runs', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const { runs, total } = await store.listRuns({ limit, offset: (page - 1) * limit });
        res.json({ runs, pagination: { total, page, limit, totalPages: Math.max(Math.ceil(total / limit), 1) } });
    } catch (err) { fail(res, err, 'Could not load backup history'); }
});

router.get('/runs/:id', async (req, res) => {
    try {
        const run = await store.getRun(parseInt(req.params.id, 10));
        if (!run) return res.status(404).json({ error: 'No such backup run' });
        res.json(run);
    } catch (err) { fail(res, err, 'Could not load that run'); }
});

/* ── verify & restore ── */

router.post('/artifacts/:id/verify', async (req, res) => {
    try {
        if (restore.isRunning()) return res.status(409).json({ error: 'A restore or verification is already running' });
        if (!req.body?.passphrase) return res.status(400).json({ error: 'Enter the encryption passphrase' });

        restore.verifyArtifact({ artifactId: parseInt(req.params.id, 10), passphrase: req.body.passphrase })
            .then(r => { lastVerify = { at: Date.now(), ok: true, artifactId: r.artifact.id }; })
            .catch(err => { lastVerify = { at: Date.now(), ok: false, error: err.message }; console.error('verify failed:', err.message); });

        await new Promise(r => setTimeout(r, 400));
        res.json({ started: true, progress: restore.progress() });
    } catch (err) { fail(res, err, 'Could not start verification'); }
});

let lastVerify = null;
let lastRestore = null;
router.get('/last-result', (req, res) => res.json({ verify: lastVerify, restore: lastRestore }));

router.post('/artifacts/:id/restore', ownerOnly, async (req, res) => {
    try {
        if (restore.isRunning()) return res.status(409).json({ error: 'A restore or verification is already running' });
        if (!req.body?.passphrase) return res.status(400).json({ error: 'Enter the encryption passphrase' });

        restore.restoreArtifact({ artifactId: parseInt(req.params.id, 10), passphrase: req.body.passphrase })
            .then(r => { lastRestore = { at: Date.now(), ok: true, path: r.path, instructions: r.instructions, artifactId: r.artifact.id }; })
            .catch(err => { lastRestore = { at: Date.now(), ok: false, error: err.message }; console.error('restore failed:', err.message); });

        await new Promise(r => setTimeout(r, 400));
        res.json({ started: true, progress: restore.progress() });
    } catch (err) { fail(res, err, 'Could not start the restore'); }
});

router.delete('/restored', ownerOnly, async (req, res) => {
    try {
        await restore.clearRestored(req.query.artifactId ? parseInt(req.query.artifactId, 10) : null);
        lastRestore = null;
        res.json({ ok: true });
    } catch (err) { fail(res, err, 'Could not clear the restored files'); }
});

/* ── retention, run by hand ── */

router.post('/prune', ownerOnly, async (req, res) => {
    try {
        const creds = await store.getCredentials();
        if (!creds) return res.status(400).json({ error: 'Telegram is not connected' });
        res.json(await runner.prune(creds, creds.cfg));
    } catch (err) { fail(res, err, 'Could not apply retention'); }
});

module.exports = router;
