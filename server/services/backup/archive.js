/**
 * Turning the CRM into files that can be carried off the machine.
 *
 * Three sources, because they fail and change at completely different rates:
 *
 *   database  — `pg_dump -Fc` of the whole cluster database. One dump covers BOTH brands: Normless
 *               and Crewfit are 42 tables in a single Postgres database, not two systems. Custom
 *               format rather than plain SQL so `pg_restore` can rebuild selectively, in parallel,
 *               and in the right dependency order on a bare new server.
 *   uploads   — server/uploads, the Crewfit design mocks and production photos. ~924 MB of phone
 *               camera JPEGs that are never rewritten: a new photo is a new filename. That makes
 *               "changed since the last run" an honest incremental rather than a guess.
 *   storage   — server/storage, the generated GST workbooks. Small, and regenerable in principle,
 *               but a filed return's workbook is the thing an auditor asks for.
 *
 * Nothing here encrypts or uploads. It produces a stream; `runner.js` pipes that through
 * `crypto.js` and hands the result to `telegram.js`.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const tar = require('tar');
const { PassThrough } = require('stream');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const UPLOADS_DIR = path.join(SERVER_ROOT, 'uploads');
const STORAGE_DIR = path.join(SERVER_ROOT, 'storage');
// Staging lives under server/storage, which .gitignore already excludes and which sits on the
// same filesystem as the uploads — so a rename is a rename, not a copy.
const STAGING_DIR = path.join(STORAGE_DIR, 'backup-staging');

// Telegram refuses a single document over 2 GB (4 GB with Premium). 1.9 GB leaves room for the
// part header and keeps a whole part comfortably inside the limit even as it is re-encoded.
const DEFAULT_PART_SIZE = 1_900_000_000;

async function ensureStaging() {
    await fsp.mkdir(STAGING_DIR, { recursive: true });
    return STAGING_DIR;
}

/** Remove anything left behind by a run that died before it could tidy up. */
async function cleanStaging() {
    try {
        for (const f of await fsp.readdir(STAGING_DIR)) {
            await fsp.rm(path.join(STAGING_DIR, f), { force: true, recursive: true });
        }
    } catch { /* nothing staged yet */ }
}

/* ────────────────────────────── database ────────────────────────────── */

/** Where pg_dump lives. Overridable because a Postgres installed from a vendor repo moves it. */
const pgDumpBin = () => process.env.PG_DUMP_PATH || 'pg_dump';

/**
 * Check pg_dump exists and is new enough for the server it will dump.
 *
 * pg_dump refuses outright to dump a server newer than itself, and the failure message is opaque
 * if you have not seen it before — so it is checked up front, where it can be explained.
 */
async function checkPgDump() {
    return new Promise((resolve) => {
        const p = spawn(pgDumpBin(), ['--version']);
        let out = '';
        p.stdout.on('data', d => { out += d; });
        p.on('error', () => resolve({ ok: false, error: `${pgDumpBin()} not found. Install postgresql-client on this server.` }));
        p.on('close', (code) => {
            if (code !== 0) return resolve({ ok: false, error: 'pg_dump could not be run' });
            const m = out.match(/(\d+)\.(\d+)/);
            resolve({ ok: true, version: out.trim(), major: m ? parseInt(m[1], 10) : null });
        });
    });
}

/**
 * DATABASE_URL split into the PG* environment variables pg_dump reads.
 *
 * Deliberately not `--dbname=postgresql://user:password@…`: command-line arguments are visible in
 * `ps` to every user on the box, so that spelling would publish the database password to anyone
 * with a shell. The environment of another user's process is not readable on Linux.
 */
function pgEnvFromUrl(url) {
    const u = new URL(url);
    const env = {
        PGHOST: decodeURIComponent(u.hostname),
        PGPORT: u.port || '5432',
        PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, '')),
        PGCONNECT_TIMEOUT: '30',
    };
    if (u.username) env.PGUSER = decodeURIComponent(u.username);
    if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
    // sslmode and friends ride along in the query string on managed databases.
    for (const [k, v] of u.searchParams) {
        if (k.toLowerCase() === 'sslmode') env.PGSSLMODE = v;
    }
    return env;
}

/** A readable stream of `pg_dump -Fc`. */
function dumpDatabaseStream() {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');

    const proc = spawn(
        pgDumpBin(),
        ['--format=custom', '--compress=9', '--no-owner', '--no-privileges'],
        { env: { ...process.env, ...pgEnvFromUrl(url) }, stdio: ['ignore', 'pipe', 'pipe'] }
    );

    // stderr is drained and kept: pg_dump reports real failures there while still writing a
    // partial, useless dump to stdout, so the exit code is the only trustworthy signal.
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 8000) stderr = stderr.slice(-8000); });

    // The child's stdout is republished so an exit code can be turned into a stream error — a
    // consumer piping stdout directly would see a clean EOF on a failed dump.
    const out = new PassThrough();
    proc.stdout.pipe(out, { end: false });

    proc.on('error', (err) => out.destroy(new Error(`Could not run pg_dump: ${err.message}`)));
    proc.on('close', (code) => {
        if (code === 0) return out.end();
        out.destroy(new Error(`pg_dump exited with code ${code}${stderr ? `: ${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`));
    });

    return out;
}

/* ────────────────────────────── files ────────────────────────────── */

/**
 * Every file under `dir`, with its size and mtime.
 *
 * Paths come back relative to `dir` and with forward slashes, so a manifest written on one machine
 * still matches on another.
 */
async function walk(dir, base = dir, acc = []) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return acc; }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        // Never recurse into our own staging directory: a backup that contains the backup it is
        // in the middle of writing grows until the disk is full.
        if (full === STAGING_DIR) continue;
        if (e.isDirectory()) await walk(full, base, acc);
        else if (e.isFile()) {
            const st = await fsp.stat(full).catch(() => null);
            if (st) acc.push({ rel: path.relative(base, full).split(path.sep).join('/'), size: st.size, mtimeMs: st.mtimeMs });
        }
    }
    return acc;
}

/**
 * What a file backup would contain, without building it.
 *
 * `since` makes it incremental: only files modified after that moment. Safe here precisely because
 * uploads are immutable — an edited photo is written under a new name — so "new mtime" means "new
 * file" rather than "file I already have an old copy of".
 */
async function planFiles({ uploads = true, storage = true, since = null } = {}) {
    const groups = [];
    if (uploads) groups.push({ key: 'uploads', dir: UPLOADS_DIR });
    if (storage) groups.push({ key: 'storage', dir: STORAGE_DIR });

    const out = [];
    for (const g of groups) {
        const all = await walk(g.dir);
        const picked = since ? all.filter(f => f.mtimeMs > since) : all;
        out.push({
            key: g.key, dir: g.dir,
            files: picked,
            count: picked.length,
            bytes: picked.reduce((n, f) => n + f.size, 0),
            totalCount: all.length,
            totalBytes: all.reduce((n, f) => n + f.size, 0),
        });
    }
    return out;
}

/** A gzipped tar stream of the given relative paths, rooted at `dir`. */
function tarStream(dir, relPaths) {
    return tar.create(
        {
            gzip: { level: 6 },   // JPEGs barely compress; level 9 costs CPU for nothing
            cwd: dir,
            // Drop uid/gid/mtime-sensitive fields so an archive restores cleanly as any user.
            portable: true,
            // A file deleted between planning and packing must not fail the whole run.
            onwarn: (code, msg) => console.warn(`  tar: ${code} ${msg}`),
        },
        relPaths
    );
}

/* ────────────────────────────── splitting ────────────────────────────── */

/**
 * Split a file into parts of at most `partSize`.
 *
 * Telegram caps a single document at 2 GB, so anything larger is uploaded as several documents and
 * stitched back together on restore — the same shape as the split/manifest scheme in the
 * Telegram-drive app. Returns a single-element list when the file already fits, so the caller has
 * one code path either way.
 */
async function splitFile(filePath, partSize = DEFAULT_PART_SIZE) {
    const { size } = await fsp.stat(filePath);
    if (size <= partSize) return [{ path: filePath, index: 0, size, isWhole: true }];

    const parts = [];
    const total = Math.ceil(size / partSize);
    for (let i = 0; i < total; i++) {
        const start = i * partSize;
        const end = Math.min(start + partSize, size) - 1;
        const partPath = `${filePath}.part${String(i + 1).padStart(3, '0')}`;
        await new Promise((resolve, reject) => {
            fs.createReadStream(filePath, { start, end })
                .pipe(fs.createWriteStream(partPath))
                .on('finish', resolve).on('error', reject);
        });
        parts.push({ path: partPath, index: i, size: end - start + 1, isWhole: false });
    }
    return parts;
}

/**
 * Reassemble parts, in order, into `outPath`.
 *
 * Each part waits on the *source* stream's 'end', not the destination's 'finish': the destination
 * is piped with `{ end: false }` so it stays open for the next part, which means it does not emit
 * 'finish' until the explicit `.end()` right at the bottom. Waiting on the destination per part
 * therefore hangs forever on the very first one.
 */
async function joinParts(partPaths, outPath) {
    const out = fs.createWriteStream(outPath);
    // One listener for the whole join, not one per part: a large archive can be a dozen parts,
    // and re-subscribing each time round the loop trips Node's max-listeners warning.
    let writeError = null;
    const onWriteError = (e) => { writeError = e; };
    out.on('error', onWriteError);

    try {
        for (const p of partPaths) {
            await new Promise((resolve, reject) => {
                const rs = fs.createReadStream(p);
                rs.on('error', reject);
                rs.on('end', () => (writeError ? reject(writeError) : resolve()));
                rs.pipe(out, { end: false });
            });
            if (writeError) throw writeError;
        }
    } catch (err) {
        out.destroy();
        throw err;
    }
    await new Promise((res, rej) => out.end(e => (e ? rej(e) : res())));
    out.removeListener('error', onWriteError);
    return outPath;
}

const humanBytes = (n) => {
    if (!Number.isFinite(n)) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
};

module.exports = {
    UPLOADS_DIR, STORAGE_DIR, STAGING_DIR, DEFAULT_PART_SIZE,
    ensureStaging, cleanStaging,
    checkPgDump, dumpDatabaseStream, pgEnvFromUrl,
    walk, planFiles, tarStream,
    splitFile, joinParts, humanBytes,
};
