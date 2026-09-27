/**
 * One backup run, start to finish.
 *
 *   plan → dump/tar → encrypt → split → upload → manifest → record → prune → tidy
 *
 * Two things shape the design.
 *
 * First, a backup must be restorable when the server it came from no longer exists. That rules out
 * keeping the index only in Postgres — the index would be inside the thing you are trying to
 * recover. So every run also uploads a plaintext manifest listing its artifacts, their part
 * message ids and their hashes. Given nothing but the Telegram account and the passphrase, the
 * channel can be read back in order and the CRM rebuilt.
 *
 * Second, a backup that silently half-works is worse than none. Every artifact carries the SHA-256
 * of its plaintext and of its ciphertext, so a restore can say whether the bytes that came back
 * are the bytes that went up, and which half failed if not.
 *
 * Only one run at a time, in-process: two concurrent runs would fight over the staging directory
 * and double the upload bandwidth for no gain.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const archive = require('./archive');
const cryptoBox = require('./crypto');
const tg = require('./telegram');
const store = require('./store');

/* ───────────────── live progress, for the page that is watching ───────────────── */

let current = null;   // { runId, kind, phase, step, steps, detail, pct, startedAt }

const progress = () => current;
const isRunning = () => current !== null;

function setPhase(phase, detail = '', pct = null) {
    if (!current) return;
    current.phase = phase;
    current.detail = detail;
    if (pct !== null) current.pct = Math.max(0, Math.min(100, pct));
    current.updatedAt = Date.now();
}

/* ───────────────── the run ───────────────── */

const stamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);

/**
 * @param {object} opts
 * @param {'full'|'db'|'files'} opts.kind   what to include
 * @param {'manual'|'schedule'} opts.trigger
 * @param {string} [opts.startedBy]
 * @param {string} opts.passphrase          never stored; supplied per run
 */
/**
 * Everything that can be known to be wrong before any work starts.
 *
 * Separated out and awaited by the caller, because a run is fired off in the background: if these
 * checks lived only inside runBackup, a bad passphrase would reject a promise nobody is holding
 * and the browser would be told the backup had started. Throwing here, before the run row exists,
 * is what lets the route answer "no, and this is why".
 */
async function preflight({ kind = 'full', passphrase }) {
    if (current) throw new Error('A backup is already running');
    if (!['full', 'db', 'files'].includes(kind)) throw new Error('Unknown backup kind');
    if (!passphrase) throw new Error('The encryption passphrase is required');

    const creds = await store.getCredentials();
    if (!creds) throw new Error('Telegram is not connected');
    const cfg = creds.cfg;
    if (!cfg.channel_id) throw new Error('No backup channel — finish the Telegram setup first');
    if (!cfg.passphrase_verifier) throw new Error('No encryption passphrase has been set');

    if (!await cryptoBox.checkPassphrase(passphrase, cfg.passphrase_verifier)) {
        throw new Error('That is not the encryption passphrase these backups were set up with');
    }
    if ((kind === 'full' || kind === 'db')) {
        const pg = await archive.checkPgDump();
        if (!pg.ok) throw new Error(pg.error);
    }
    return { creds, cfg };
}

async function runBackup({ kind = 'full', trigger = 'manual', startedBy = null, passphrase }) {
    const { creds, cfg } = await preflight({ kind, passphrase });

    const run = await store.startRun({ kind, trigger, started_by: startedBy });
    current = { runId: run.id, kind, trigger, phase: 'starting', detail: '', pct: 0, startedAt: Date.now() };

    const artifacts = [];
    const t0 = Date.now();

    try {
        await archive.ensureStaging();
        await archive.cleanStaging();

        const wantDb = kind === 'full' || kind === 'db';
        const wantFiles = kind === 'full' || kind === 'files';
        const tag = stamp();

        /* ── database ── */
        if (wantDb) {
            const check = await archive.checkPgDump();
            setPhase('database', 'Dumping PostgreSQL…', 5);
            const encPath = path.join(archive.STAGING_DIR, `db_${tag}.dump.enc`);
            const res = await cryptoBox.encryptStream(archive.dumpDatabaseStream(), encPath, passphrase);

            setPhase('database', `Uploading ${archive.humanBytes(res.cipherBytes)}…`, 12);
            artifacts.push(await uploadArtifact({
                creds, cfg, runId: run.id, kind: 'database',
                filename: `db_${tag}.dump.enc`, res,
                meta: { format: 'pg_dump -Fc', pg: check.version },
                baseP: 12, spanP: wantFiles ? 18 : 80,
            }));
        }

        /* ── files ── */
        if (wantFiles) {
            // A full files backup on the schedule the config asks for, incremental otherwise. The
            // watermark is the last run that actually succeeded — never the last attempted — so a
            // failed night is re-covered by the next one rather than skipped forever.
            const since = await decideSince(cfg, trigger);
            setPhase('files', since ? 'Finding files changed since the last backup…' : 'Listing all files…', 32);

            const groups = await archive.planFiles({
                uploads: cfg.include_uploads !== false,
                storage: cfg.include_storage !== false,
                since,
            });

            const base = 34;
            const span = 60 / Math.max(groups.length, 1);
            for (let i = 0; i < groups.length; i++) {
                const g = groups[i];
                if (!g.count) {
                    setPhase('files', `${g.key}: nothing new`, base + span * i);
                    continue;
                }
                setPhase('files', `Packing ${g.count} ${g.key} file${g.count > 1 ? 's' : ''} (${archive.humanBytes(g.bytes)})…`, base + span * i);

                const encPath = path.join(archive.STAGING_DIR, `${g.key}_${tag}.tar.gz.enc`);
                const res = await cryptoBox.encryptStream(
                    archive.tarStream(g.dir, g.files.map(f => f.rel)),
                    encPath, passphrase
                );

                setPhase('files', `Uploading ${g.key} (${archive.humanBytes(res.cipherBytes)})…`, base + span * i + span * 0.3);
                artifacts.push(await uploadArtifact({
                    creds, cfg, runId: run.id, kind: g.key,
                    filename: `${g.key}_${tag}.tar.gz.enc`, res,
                    fileCount: g.count,
                    meta: {
                        format: 'tar.gz', incremental: !!since,
                        since: since ? new Date(since).toISOString() : null,
                        files_in_archive: g.count, files_on_disk: g.totalCount,
                        bytes_on_disk: g.totalBytes,
                    },
                    baseP: base + span * i + span * 0.3, spanP: span * 0.7,
                }));
            }

            if (!since) await store.updateConfig({ last_files_full_at: new Date().toISOString() });
        }

        /* ── manifest: the index that survives losing this server ── */
        setPhase('manifest', 'Writing the recovery manifest…', 95);
        const manifestId = await uploadManifest({ creds, cfg, run, artifacts, tag });

        const totals = artifacts.reduce((a, x) => ({
            plain: a.plain + Number(x.plain_bytes || 0),
            cipher: a.cipher + Number(x.cipher_bytes || 0),
        }), { plain: 0, cipher: 0 });

        const finished = await store.finishRun(run.id, {
            status: artifacts.length ? 'success' : 'empty',
            plain_bytes: totals.plain,
            cipher_bytes: totals.cipher,
            artifact_count: artifacts.length,
            manifest_message_id: manifestId,
            duration_ms: Date.now() - t0,
        });

        await store.updateConfig({
            last_run_at: new Date().toISOString(),
            last_success_at: new Date().toISOString(),
        });

        setPhase('pruning', 'Applying retention…', 98);
        const pruned = await prune(creds, cfg).catch(e => {
            // Retention failing must not turn a good backup into a failed one.
            console.error('backup retention failed:', e.message);
            return { runs: 0, messages: 0 };
        });

        setPhase('done', 'Finished', 100);
        return { ...finished, artifacts, pruned };
    } catch (err) {
        console.error('Backup run failed:', err);
        await store.finishRun(run.id, {
            status: 'failed',
            error: String(err.message || err).slice(0, 2000),
            artifact_count: artifacts.length,
            duration_ms: Date.now() - t0,
        }).catch(() => {});
        await store.updateConfig({ last_run_at: new Date().toISOString() }).catch(() => {});
        throw err;
    } finally {
        // Staging holds a full unencrypted-sized copy of everything; never leave it lying about.
        await archive.cleanStaging().catch(() => {});
        current = null;
    }
}

/** Whether this files run should be a full one. */
async function decideSince(cfg, trigger) {
    // A manual run is someone asking for a complete, self-contained copy.
    if (trigger === 'manual') return null;
    const lastFull = cfg.last_files_full_at ? new Date(cfg.last_files_full_at).getTime() : null;
    if (!lastFull) return null;
    const days = Number(cfg.files_full_every_days || 7);
    if (Date.now() - lastFull > days * 86400 * 1000) return null;
    return await store.lastSuccessAt();
}

/** Split, upload every part, and record the artifact. */
async function uploadArtifact({ creds, cfg, runId, kind, filename, res, fileCount = null, meta = {}, baseP = 0, spanP = 10 }) {
    const maxPart = cfg.tg_premium ? tg.MAX_FILE_PREMIUM : tg.MAX_FILE_FREE;
    // Stay clearly under the ceiling rather than at it.
    const partSize = Math.min(archive.DEFAULT_PART_SIZE, Math.floor(maxPart * 0.95));
    const parts = await archive.splitFile(res.path, partSize);

    const messageIds = [];
    for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const label = parts.length > 1 ? `${filename} (part ${i + 1}/${parts.length})` : filename;
        const caption = [
            `📦 ${label}`,
            `run #${runId} · ${kind}`,
            `sha256 ${res.cipherSha256.slice(0, 16)}…`,
        ].join('\n');

        const up = await tg.uploadFile(creds, cfg, {
            filePath: p.path,
            caption,
            onProgress: (sent, total) => {
                const within = total ? sent / total : 0;
                setPhase(current?.phase || 'uploading',
                    `${label} — ${archive.humanBytes(sent)} / ${archive.humanBytes(total)}`,
                    baseP + spanP * ((i + within) / parts.length));
            },
        });
        messageIds.push(up.messageId);

        // Free the part as soon as it is safely up: a 2 GB archive would otherwise sit on disk
        // twice over, once whole and once in pieces.
        if (!p.isWhole) await fsp.rm(p.path, { force: true });
    }

    await fsp.rm(res.path, { force: true });

    return store.addArtifact({
        run_id: runId, kind, filename,
        plain_bytes: res.plainBytes, cipher_bytes: res.cipherBytes,
        plain_sha256: res.plainSha256, cipher_sha256: res.cipherSha256,
        part_count: parts.length, message_ids: messageIds,
        file_count: fileCount, meta,
    });
}

/**
 * The plaintext index, uploaded alongside the archives.
 *
 * Deliberately not encrypted: it is what you read when the CRM is gone and all you have is the
 * Telegram account. It names files and sizes — no customer data, no credentials, and not the
 * passphrase — so the archives stay sealed even though the index is readable.
 */
async function uploadManifest({ creds, cfg, run, artifacts, tag }) {
    const manifest = {
        format: 'normless-crm-backup-manifest',
        version: 1,
        run_id: run.id,
        kind: run.kind,
        created_at: new Date().toISOString(),
        encryption: {
            cipher: 'AES-256-GCM',
            kdf: 'scrypt',
            note: 'Every .enc artifact carries its own salt and IV in a 49-byte header. Decrypt with the backup passphrase.',
        },
        restore: 'Download each artifact part in message_ids order, concatenate, decrypt, then pg_restore (database) or tar -xzf (files).',
        artifacts: artifacts.map(a => ({
            kind: a.kind,
            filename: a.filename,
            part_count: a.part_count,
            message_ids: store.parseArtifact(a).message_ids,
            plain_bytes: Number(a.plain_bytes),
            cipher_bytes: Number(a.cipher_bytes),
            plain_sha256: a.plain_sha256,
            cipher_sha256: a.cipher_sha256,
            file_count: a.file_count,
            meta: store.parseArtifact(a).meta,
        })),
    };

    const p = path.join(archive.STAGING_DIR, `manifest_${tag}.json`);
    await fsp.writeFile(p, JSON.stringify(manifest, null, 2), 'utf8');
    try {
        const up = await tg.uploadFile(creds, cfg, {
            filePath: p,
            caption: `🗂 Manifest — run #${run.id} · ${run.kind}\n${artifacts.length} artifact(s)\nKeep this: it is the index for restoring.`,
        });
        return up.messageId;
    } finally {
        await fsp.rm(p, { force: true });
    }
}

/* ───────────────── retention ───────────────── */

/**
 * Drop old runs, keeping a thinning window: recent dailies, then weeklies, then monthlies.
 *
 * Deleting the Telegram messages is what actually reclaims anything; the rows are only removed
 * once that has succeeded, so a run still listed is a run still restorable.
 */
async function prune(creds, cfg) {
    const keepDaily = Number(cfg.keep_daily ?? 14);
    const keepWeekly = Number(cfg.keep_weekly ?? 8);
    const keepMonthly = Number(cfg.keep_monthly ?? 6);

    const { runs } = await store.listRuns({ limit: 1000 });
    const good = runs.filter(r => r.status === 'success').sort((a, b) => new Date(b.started_at) - new Date(a.started_at));

    const keep = new Set();
    const seenWeek = new Set(), seenMonth = new Set();
    good.forEach((r, i) => {
        const d = new Date(r.started_at);
        if (i < keepDaily) { keep.add(r.id); return; }
        const wk = `${d.getUTCFullYear()}-W${Math.floor(d.getUTCDate() / 7)}-${d.getUTCMonth()}`;
        if (seenWeek.size < keepWeekly && !seenWeek.has(wk)) { seenWeek.add(wk); keep.add(r.id); return; }
        const mo = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
        if (seenMonth.size < keepMonthly && !seenMonth.has(mo)) { seenMonth.add(mo); keep.add(r.id); }
    });

    // The newest successful run is never pruned, whatever the numbers say.
    if (good[0]) keep.add(good[0].id);

    const doomed = good.filter(r => !keep.has(r.id));
    let messages = 0;
    for (const r of doomed) {
        const full = await store.getRun(r.id);
        const ids = full.artifacts.flatMap(a => a.message_ids || []);
        if (full.manifest_message_id) ids.push(full.manifest_message_id);
        if (ids.length) messages += await tg.deleteMessages(creds, cfg, ids);
        await require('../../db/connection').query('DELETE FROM backup_artifacts WHERE run_id = $1', [r.id]);
        await require('../../db/connection').query(`UPDATE backup_runs SET status = 'pruned', error = NULL WHERE id = $1`, [r.id]);
    }
    return { runs: doomed.length, messages };
}

module.exports = { runBackup, preflight, progress, isRunning, prune };
