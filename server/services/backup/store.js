/**
 * Reading and writing the backup configuration and history.
 *
 * The Telegram session string is the one value here that must not be stored in the clear. It is a
 * bearer credential for the whole Telegram account — anyone holding it can read the owner's
 * messages, not merely the backups — and it lives in a table that every backup then dumps. Left
 * plain, a stolen archive would hand over the account that holds the archives.
 *
 * So it is sealed with a key derived from JWT_SECRET, which lives in .env and is deliberately NOT
 * part of any backup. A leaked dump therefore yields ciphertext and nothing else; restoring onto a
 * new server means bringing the .env across too, which is already true of the database password.
 */

const crypto = require('crypto');
const db = require('../../db/connection');

const SESSION_AAD = Buffer.from('normless-backup-session-v1');

/** The key that seals the session at rest. Derived, so JWT_SECRET is never used as a key directly. */
function sealKey() {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET is not set — cannot secure the Telegram session');
    return crypto.createHash('sha256').update(`backup-session-seal|${secret}`).digest();
}

function sealSession(plain) {
    if (!plain) return null;
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', sealKey(), iv);
    c.setAAD(SESSION_AAD);
    const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
    return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${body.toString('base64')}`;
}

function openSession(sealed) {
    if (!sealed) return null;
    const [v, ivB, tagB, bodyB] = String(sealed).split('.');
    if (v !== 'v1') throw new Error('Stored Telegram session is in an unknown format');
    const d = crypto.createDecipheriv('aes-256-gcm', sealKey(), Buffer.from(ivB, 'base64'));
    d.setAAD(SESSION_AAD);
    d.setAuthTag(Buffer.from(tagB, 'base64'));
    try {
        return Buffer.concat([d.update(Buffer.from(bodyB, 'base64')), d.final()]).toString('utf8');
    } catch {
        // Almost always means JWT_SECRET changed since the session was stored.
        throw new Error('Could not read the stored Telegram session — JWT_SECRET has changed. Reconnect the account.');
    }
}

/* ────────────────────────────── config ────────────────────────────── */

// One row, id = 1. A second configuration would mean a second Telegram account and a second
// schedule quietly competing for the same archives.
const CONFIG_ID = 1;

async function getConfig() {
    const r = await db.query('SELECT * FROM backup_config WHERE id = $1', [CONFIG_ID]);
    return r.rows[0] || null;
}

/** The config with the session decrypted, for the services that need to talk to Telegram. */
async function getCredentials() {
    const cfg = await getConfig();
    if (!cfg?.tg_session) return null;
    return {
        session: openSession(cfg.tg_session),
        apiId: cfg.tg_api_id,
        apiHash: cfg.tg_api_hash,
        cfg,
    };
}

/** What the browser is allowed to see: never the session, never the api hash, never the passphrase. */
function publicConfig(cfg) {
    if (!cfg) {
        return { configured: false, connected: false, encryption: false, schedule_enabled: false };
    }
    return {
        configured: true,
        connected: !!cfg.tg_session,
        encryption: !!cfg.passphrase_verifier,
        tg_api_id: cfg.tg_api_id ? String(cfg.tg_api_id) : null,
        // Enough to recognise the account, not enough to reuse it.
        tg_user: cfg.tg_user_name || cfg.tg_username || cfg.tg_phone || null,
        tg_username: cfg.tg_username || null,
        tg_phone: cfg.tg_phone ? maskPhone(cfg.tg_phone) : null,
        tg_premium: !!cfg.tg_premium,
        channel_id: cfg.channel_id || null,
        channel_title: cfg.channel_title || null,
        schedule_enabled: !!cfg.schedule_enabled,
        db_cron: cfg.db_cron,
        files_cron: cfg.files_cron,
        files_full_cron: cfg.files_full_cron,
        include_uploads: cfg.include_uploads !== false,
        include_storage: cfg.include_storage !== false,
        keep_daily: cfg.keep_daily,
        keep_weekly: cfg.keep_weekly,
        keep_monthly: cfg.keep_monthly,
        timezone: cfg.timezone,
        last_run_at: cfg.last_run_at,
        last_success_at: cfg.last_success_at,
    };
}

const maskPhone = (p) => {
    const s = String(p).replace(/\s+/g, '');
    return s.length > 5 ? `${s.slice(0, 3)}••••${s.slice(-3)}` : '•••';
};

/** Create the single config row if it is not there yet. */
async function ensureConfigRow() {
    await db.query(
        `INSERT INTO backup_config (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [CONFIG_ID]
    );
    return getConfig();
}

// Only these may be written from a request; anything else is ignored rather than trusted.
const WRITABLE = new Set([
    'tg_api_id', 'tg_api_hash', 'tg_session', 'tg_user_id', 'tg_username', 'tg_phone', 'tg_user_name',
    'tg_premium', 'channel_id', 'channel_access_hash', 'channel_title',
    'passphrase_verifier', 'schedule_enabled', 'db_cron', 'files_cron', 'files_full_cron',
    'include_uploads', 'include_storage', 'keep_daily', 'keep_weekly', 'keep_monthly',
    'timezone', 'last_run_at', 'last_success_at', 'last_files_full_at',
]);

async function updateConfig(patch) {
    await ensureConfigRow();
    const keys = Object.keys(patch).filter(k => WRITABLE.has(k));
    if (!keys.length) return getConfig();
    const sets = keys.map((k, i) => `${k} = $${i + 1}`);
    const vals = keys.map(k => patch[k]);
    vals.push(CONFIG_ID);
    await db.query(
        `UPDATE backup_config SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${vals.length}`,
        vals
    );
    return getConfig();
}

/* ────────────────────────────── runs & artifacts ────────────────────────────── */

async function startRun({ kind, trigger, started_by }) {
    const r = await db.query(
        `INSERT INTO backup_runs (kind, trigger, started_by, status)
         VALUES ($1, $2, $3, 'running') RETURNING *`,
        [kind, trigger, started_by || null]
    );
    return r.rows[0];
}

async function finishRun(id, patch) {
    const keys = Object.keys(patch);
    const sets = keys.map((k, i) => `${k} = $${i + 1}`);
    const vals = keys.map(k => patch[k]);
    vals.push(id);
    const r = await db.query(
        `UPDATE backup_runs SET ${sets.join(', ')}, finished_at = CURRENT_TIMESTAMP WHERE id = $${vals.length} RETURNING *`,
        vals
    );
    return r.rows[0];
}

async function addArtifact(a) {
    const r = await db.query(
        `INSERT INTO backup_artifacts
           (run_id, kind, filename, plain_bytes, cipher_bytes, plain_sha256, cipher_sha256,
            part_count, message_ids, file_count, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [a.run_id, a.kind, a.filename, a.plain_bytes, a.cipher_bytes, a.plain_sha256, a.cipher_sha256,
         a.part_count, JSON.stringify(a.message_ids || []), a.file_count ?? null,
         a.meta ? JSON.stringify(a.meta) : null]
    );
    return r.rows[0];
}

const parseArtifact = (a) => a && ({
    ...a,
    message_ids: safeJson(a.message_ids, []),
    meta: safeJson(a.meta, null),
});

function safeJson(v, fallback) {
    if (v == null) return fallback;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return fallback; }
}

async function listRuns({ limit = 50, offset = 0 } = {}) {
    const r = await db.query(
        `SELECT * FROM backup_runs ORDER BY started_at DESC LIMIT $1 OFFSET $2`, [limit, offset]
    );
    const total = (await db.query('SELECT COUNT(*)::int AS n FROM backup_runs')).rows[0].n;
    return { runs: r.rows, total };
}

async function getRun(id) {
    const r = await db.query('SELECT * FROM backup_runs WHERE id = $1', [id]);
    if (!r.rows[0]) return null;
    const a = await db.query('SELECT * FROM backup_artifacts WHERE run_id = $1 ORDER BY id', [id]);
    return { ...r.rows[0], artifacts: a.rows.map(parseArtifact) };
}

async function getArtifact(id) {
    const r = await db.query('SELECT * FROM backup_artifacts WHERE id = $1', [id]);
    return parseArtifact(r.rows[0]) || null;
}

/** The moment of the last successful run of a given kind — the watermark an incremental reads. */
async function lastSuccessAt(kind = null) {
    const r = await db.query(
        `SELECT MAX(started_at) AS t FROM backup_runs
          WHERE status = 'success' ${kind ? 'AND kind = $1' : ''}`,
        kind ? [kind] : []
    );
    return r.rows[0]?.t ? new Date(r.rows[0].t).getTime() : null;
}

module.exports = {
    sealSession, openSession,
    getConfig, getCredentials, publicConfig, ensureConfigRow, updateConfig,
    startRun, finishRun, addArtifact, listRuns, getRun, getArtifact, lastSuccessAt,
    parseArtifact, CONFIG_ID,
};
