/**
 * The encryption envelope every backup artifact is wrapped in.
 *
 * A backup of this CRM is 28,000-odd customer records with names, phone numbers, email and
 * delivery addresses, every invoice ever issued, and the Shopify token sitting in the dump of the
 * settings. Telegram Saved Messages and private channels are ordinary cloud storage — not
 * end-to-end encrypted — so the archive is encrypted here, before it ever leaves the server, and
 * Telegram only ever holds ciphertext.
 *
 * AES-256-GCM rather than CBC or CTR because it is authenticated: a truncated upload, a flipped
 * bit, or a tampered part makes decryption *fail* instead of quietly handing back a corrupt
 * database that only reveals itself weeks later, halfway through a restore.
 *
 * The key is derived with scrypt from the passphrase the owner sets. Only a verifier hash of that
 * passphrase is stored — never the passphrase, never the key. That is the deliberate trade: lose
 * the passphrase and the backups are unrecoverable by anyone, us included.
 *
 * ── File layout ───────────────────────────────────────────────────────────────────────────────
 *   offset  size  field
 *        0     8  magic 'NLSBAK01'
 *        8     1  format version
 *        9     4  scrypt N          (big-endian uint32)
 *       13     4  scrypt r
 *       17     4  scrypt p
 *       21    16  salt
 *       37    12  iv (96-bit, the size GCM is specified for)
 *       49     n  ciphertext
 *   len-16    16  GCM auth tag
 *
 * The parameters travel in the header rather than living in code, so an archive written today
 * still opens after the cost parameters are raised for new backups.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

const MAGIC = Buffer.from('NLSBAK01', 'ascii');
const VERSION = 1;
const SALT_LEN = 16;
const IV_LEN = 12;          // 96 bits — what GCM is specified for; other sizes are slower and weaker
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + 1 + 4 + 4 + 4 + SALT_LEN + IV_LEN;   // 49

// ~32 MB of memory per derivation. Deliberately slow: it is paid once per archive, and it is the
// only thing standing between a leaked backup and the passphrase behind it.
const SCRYPT = { N: 32768, r: 8, p: 1 };
// Node's default maxmem is 32 MB, which is *exactly* what the parameters above need — and the
// check is `>`, so it lands right on the boundary and throws. Give it room.
const SCRYPT_MAXMEM = 96 * 1024 * 1024;

/** Derive the 32-byte AES key. Async so a derivation never blocks the event loop. */
function deriveKey(passphrase, salt, params = SCRYPT) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(
            Buffer.from(String(passphrase), 'utf8'), salt, 32,
            { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM },
            (err, key) => (err ? reject(err) : resolve(key))
        );
    });
}

/**
 * A stable fingerprint of a passphrase, for checking the one typed today matches the one the
 * existing backups were written with.
 *
 * Its own random salt, and never the archive key — this value is stored in the database, and a
 * verifier that shared a salt with the archives would narrow an attack on them.
 */
async function passphraseVerifier(passphrase) {
    const salt = crypto.randomBytes(SALT_LEN);
    const key = await deriveKey(passphrase, salt);
    return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Whether `passphrase` is the one `verifier` was made from. Constant-time on the digest. */
async function checkPassphrase(passphrase, verifier) {
    try {
        const [scheme, N, r, p, saltB64, keyB64] = String(verifier || '').split('$');
        if (scheme !== 'scrypt') return false;
        const salt = Buffer.from(saltB64, 'base64');
        const expected = Buffer.from(keyB64, 'base64');
        const actual = await deriveKey(passphrase, salt, { N: +N, r: +r, p: +p });
        return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    } catch {
        return false;
    }
}

/** Passes bytes through untouched while hashing them. */
function sha256Tap(onDigest) {
    const h = crypto.createHash('sha256');
    return new Transform({
        transform(chunk, _enc, cb) { h.update(chunk); cb(null, chunk); },
        flush(cb) { onDigest(h.digest('hex')); cb(); },
    });
}

/**
 * Encrypt a readable stream to `outPath`.
 *
 * Returns the sizes and both digests: the plaintext hash proves a restore reproduced the original
 * bytes, the ciphertext hash proves the upload and re-download did not corrupt them. Keeping both
 * means a failed verification says *which* half broke.
 */
async function encryptStream(source, outPath, passphrase) {
    const salt = crypto.randomBytes(SALT_LEN);
    const iv = crypto.randomBytes(IV_LEN);
    const key = await deriveKey(passphrase, salt);

    const header = Buffer.alloc(HEADER_LEN);
    let o = 0;
    MAGIC.copy(header, o); o += MAGIC.length;
    header.writeUInt8(VERSION, o); o += 1;
    header.writeUInt32BE(SCRYPT.N, o); o += 4;
    header.writeUInt32BE(SCRYPT.r, o); o += 4;
    header.writeUInt32BE(SCRYPT.p, o); o += 4;
    salt.copy(header, o); o += SALT_LEN;
    iv.copy(header, o);

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const out = fs.createWriteStream(outPath);

    let plainSha = null, plainBytes = 0;
    const counter = new Transform({
        transform(chunk, _enc, cb) { plainBytes += chunk.length; cb(null, chunk); },
    });

    // The header is written before the pipeline so it lands ahead of the first cipher block.
    await new Promise((res, rej) => out.write(header, (e) => (e ? rej(e) : res())));

    // `{ end: false }` keeps the stream open for the auth tag, which GCM only produces once the
    // last plaintext byte has gone through the cipher.
    await pipeline(source, counter, sha256Tap(h => { plainSha = h; }), cipher, out, { end: false });

    const tag = cipher.getAuthTag();
    await new Promise((res, rej) => out.write(tag, (e) => (e ? rej(e) : res())));
    await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));

    const { size } = await fsp.stat(outPath);
    return { path: outPath, plainBytes, plainSha256: plainSha, cipherBytes: size, cipherSha256: await fileSha256(outPath) };
}

/** Encrypt a file on disk. */
async function encryptFile(inPath, outPath, passphrase) {
    return encryptStream(fs.createReadStream(inPath), outPath, passphrase);
}

/** Read and validate the header of an encrypted archive. */
async function readHeader(inPath) {
    const fh = await fsp.open(inPath, 'r');
    try {
        const buf = Buffer.alloc(HEADER_LEN);
        const { bytesRead } = await fh.read(buf, 0, HEADER_LEN, 0);
        if (bytesRead < HEADER_LEN) throw new Error('File is too short to be a backup archive');
        if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a Normless backup archive');
        const version = buf.readUInt8(8);
        if (version !== VERSION) throw new Error(`Unsupported archive version ${version}`);
        return {
            version,
            params: { N: buf.readUInt32BE(9), r: buf.readUInt32BE(13), p: buf.readUInt32BE(17) },
            salt: buf.subarray(21, 21 + SALT_LEN),
            iv: buf.subarray(37, 37 + IV_LEN),
        };
    } finally {
        await fh.close();
    }
}

/**
 * Decrypt an archive to `outPath`.
 *
 * Throws if the passphrase is wrong OR the bytes were altered — GCM cannot tell those apart, and
 * for a restore the distinction does not matter: either way these are not the original bytes.
 */
async function decryptFile(inPath, outPath, passphrase) {
    const { params, salt, iv } = await readHeader(inPath);
    const { size } = await fsp.stat(inPath);
    const cipherEnd = size - TAG_LEN;
    if (cipherEnd < HEADER_LEN) throw new Error('Archive is truncated — no auth tag');

    // The tag sits at the end, so it has to be read before the body can be verified.
    const fh = await fsp.open(inPath, 'r');
    let tag;
    try {
        tag = Buffer.alloc(TAG_LEN);
        await fh.read(tag, 0, TAG_LEN, cipherEnd);
    } finally {
        await fh.close();
    }

    const key = await deriveKey(passphrase, salt, params);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);

    let plainSha = null;
    try {
        await pipeline(
            fs.createReadStream(inPath, { start: HEADER_LEN, end: cipherEnd - 1 }),
            decipher,
            sha256Tap(h => { plainSha = h; }),
            fs.createWriteStream(outPath)
        );
    } catch (err) {
        // A half-written plaintext is worse than none: it looks like a restorable file.
        await fsp.rm(outPath, { force: true });
        if (/auth|tag/i.test(err.message)) {
            throw new Error('Could not decrypt: wrong passphrase, or the archive has been altered or corrupted.');
        }
        throw err;
    }
    return { path: outPath, plainSha256: plainSha, plainBytes: (await fsp.stat(outPath)).size };
}

function fileSha256(p) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        fs.createReadStream(p).on('data', c => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
    });
}

module.exports = {
    encryptStream, encryptFile, decryptFile, readHeader, fileSha256,
    passphraseVerifier, checkPassphrase, deriveKey,
    HEADER_LEN, TAG_LEN, MAGIC, VERSION,
};
