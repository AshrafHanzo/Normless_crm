/**
 * Getting the data back.
 *
 * Two operations, kept firmly apart:
 *
 *   verify   — download, reassemble, decrypt, compare both hashes, throw the plaintext away. This
 *              is the one that should run often. A backup nobody has ever restored is a rumour,
 *              and the usual way people find out is the day they need it.
 *
 *   restore  — the same, but the plaintext is written to disk and left there. It deliberately
 *              stops at that point: it does NOT run pg_restore and does NOT unpack over the live
 *              uploads directory. Overwriting a production database is a decision a person makes
 *              with their hands, not something a web button does while they are reading the page.
 *              The exact command to finish the job is handed back instead.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const archive = require('./archive');
const cryptoBox = require('./crypto');
const tg = require('./telegram');
const store = require('./store');

const RESTORE_DIR = path.join(archive.STORAGE_DIR, 'restore');

let current = null;
const progress = () => current;
const isRunning = () => current !== null;

function setPhase(phase, detail = '', pct = null) {
    if (!current) return;
    current.phase = phase;
    current.detail = detail;
    if (pct !== null) current.pct = Math.max(0, Math.min(100, pct));
    current.updatedAt = Date.now();
}

/**
 * Pull one artifact down and decrypt it.
 *
 * Both hashes are checked, and they say different things: a ciphertext mismatch means the transfer
 * or Telegram's copy is at fault, a plaintext mismatch after a successful decrypt would mean the
 * archive was built wrong. Separating them turns "restore failed" into something diagnosable.
 */
async function fetchArtifact({ artifactId, passphrase, keepPlaintext, label }) {
    const art = await store.getArtifact(artifactId);
    if (!art) throw new Error('No such backup artifact');

    const creds = await store.getCredentials();
    if (!creds) throw new Error('Telegram is not connected');
    const cfg = creds.cfg;

    if (!await cryptoBox.checkPassphrase(passphrase, cfg.passphrase_verifier)) {
        throw new Error('That is not the encryption passphrase these backups were made with');
    }

    await fsp.mkdir(RESTORE_DIR, { recursive: true });
    const work = path.join(RESTORE_DIR, `art${art.id}`);
    await fsp.mkdir(work, { recursive: true });

    const ids = art.message_ids || [];
    if (!ids.length) throw new Error('This artifact has no Telegram messages recorded against it');

    try {
        /* ── download every part ── */
        const partPaths = [];
        for (let i = 0; i < ids.length; i++) {
            const p = path.join(work, `part${String(i + 1).padStart(3, '0')}`);
            setPhase('downloading', `${label}: part ${i + 1} of ${ids.length}`, 5 + 55 * (i / ids.length));
            await tg.downloadMessage(creds, cfg, {
                messageId: ids[i], outPath: p,
                onProgress: (got, total) => setPhase('downloading',
                    `${label}: part ${i + 1}/${ids.length} — ${archive.humanBytes(got)} / ${archive.humanBytes(total)}`,
                    5 + 55 * ((i + (total ? got / total : 0)) / ids.length)),
            });
            partPaths.push(p);
        }

        /* ── reassemble ── */
        setPhase('assembling', `${label}: joining ${partPaths.length} part(s)`, 62);
        const cipherPath = path.join(work, art.filename);
        if (partPaths.length === 1) await fsp.rename(partPaths[0], cipherPath);
        else { await archive.joinParts(partPaths, cipherPath); for (const p of partPaths) await fsp.rm(p, { force: true }); }

        /* ── did the bytes survive the round trip? ── */
        setPhase('verifying', `${label}: checking the ciphertext hash`, 70);
        const gotCipherSha = await cryptoBox.fileSha256(cipherPath);
        if (art.cipher_sha256 && gotCipherSha !== art.cipher_sha256) {
            throw new Error('The downloaded archive does not match what was uploaded — it is corrupt or incomplete in Telegram.');
        }

        /* ── decrypt ── */
        setPhase('decrypting', `${label}: decrypting ${archive.humanBytes(Number(art.cipher_bytes))}`, 76);
        const plainName = art.filename.replace(/\.enc$/, '');
        const plainPath = path.join(work, plainName);
        const dec = await cryptoBox.decryptFile(cipherPath, plainPath, passphrase);

        setPhase('verifying', `${label}: checking the plaintext hash`, 94);
        const plainOk = !art.plain_sha256 || dec.plainSha256 === art.plain_sha256;
        if (!plainOk) throw new Error('Decryption succeeded but the contents do not match the recorded hash.');

        await fsp.rm(cipherPath, { force: true });

        const result = {
            artifact: art, ok: true,
            cipherSha256: gotCipherSha, plainSha256: dec.plainSha256,
            plainBytes: dec.plainBytes,
            path: keepPlaintext ? plainPath : null,
            parts: ids.length,
        };

        if (!keepPlaintext) {
            await fsp.rm(work, { recursive: true, force: true });
        }
        return result;
    } catch (err) {
        await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
        throw err;
    }
}

/** Download + decrypt + hash-check, keeping nothing. The routine health check. */
async function verifyArtifact({ artifactId, passphrase }) {
    if (current) throw new Error('A restore or verification is already running');
    const art = await store.getArtifact(artifactId);
    current = { kind: 'verify', artifactId, phase: 'starting', pct: 0, startedAt: Date.now() };
    try {
        const r = await fetchArtifact({ artifactId, passphrase, keepPlaintext: false, label: art?.filename || 'artifact' });
        setPhase('done', 'Verified', 100);
        return r;
    } finally {
        current = null;
    }
}

/** Download + decrypt and leave the plaintext on disk, with the command to finish the job. */
async function restoreArtifact({ artifactId, passphrase }) {
    if (current) throw new Error('A restore or verification is already running');
    const art = await store.getArtifact(artifactId);
    current = { kind: 'restore', artifactId, phase: 'starting', pct: 0, startedAt: Date.now() };
    try {
        const r = await fetchArtifact({ artifactId, passphrase, keepPlaintext: true, label: art?.filename || 'artifact' });
        setPhase('done', 'Ready', 100);
        return { ...r, instructions: instructionsFor(art, r.path) };
    } finally {
        current = null;
    }
}

/**
 * What to type next, spelled out for the case that matters: a brand-new server at 3am.
 *
 * `--clean --if-exists` because a restore usually lands on a database that already has the schema
 * from the app's own boot-time `ensure*` functions, and without them pg_restore stops on the first
 * object that already exists.
 */
function instructionsFor(art, plainPath) {
    if (art.kind === 'database') {
        return {
            title: 'Restore the database',
            warning: 'This REPLACES the contents of the target database. Point it at a fresh one first if you are not certain.',
            steps: [
                `pg_restore --clean --if-exists --no-owner --no-privileges \\`,
                `  --dbname "$DATABASE_URL" "${plainPath}"`,
                ``,
                `# Then restart the app so it re-runs its schema checks:`,
                `pm2 restart normless-crm`,
            ].join('\n'),
        };
    }
    const target = art.kind === 'uploads' ? archive.UPLOADS_DIR : archive.STORAGE_DIR;
    return {
        title: `Restore the ${art.kind} files`,
        warning: 'Existing files with the same names are overwritten. Uploads are normally immutable, so this is usually safe — but check first.',
        steps: [
            `mkdir -p "${target}"`,
            `tar -xzf "${plainPath}" -C "${target}"`,
            ``,
            `# Check what is in the archive before unpacking:`,
            `tar -tzf "${plainPath}" | head -50`,
        ].join('\n'),
    };
}

/** Remove a finished restore's plaintext — it is a full copy of production sitting on disk. */
async function clearRestored(artifactId = null) {
    if (artifactId) {
        await fsp.rm(path.join(RESTORE_DIR, `art${Number(artifactId)}`), { recursive: true, force: true });
        return 1;
    }
    await fsp.rm(RESTORE_DIR, { recursive: true, force: true });
    return 1;
}

/** What is currently sitting decrypted on disk, so the page can nag about clearing it. */
async function listRestored() {
    try {
        const out = [];
        for (const d of await fsp.readdir(RESTORE_DIR, { withFileTypes: true })) {
            if (!d.isDirectory()) continue;
            const dir = path.join(RESTORE_DIR, d.name);
            for (const f of await fsp.readdir(dir)) {
                const st = await fsp.stat(path.join(dir, f)).catch(() => null);
                if (st?.isFile()) out.push({ artifactId: Number(d.name.replace('art', '')) || null, file: f, bytes: st.size, at: st.mtime });
            }
        }
        return out;
    } catch {
        return [];
    }
}

module.exports = { verifyArtifact, restoreArtifact, clearRestored, listRestored, progress, isRunning, RESTORE_DIR };
