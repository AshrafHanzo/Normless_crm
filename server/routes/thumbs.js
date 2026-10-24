/**
 * Thumbnails for uploaded images.
 *
 * The originals are phone photos — 3.7 MB apiece, 923 MB of them — which is fine for a gallery
 * somebody opens deliberately and ruinous for a list of twenty-five orders that shows one each.
 * Asking for the original at 34 pixels wide would download ninety megabytes to draw a postage
 * stamp, on the phone of someone standing in a warehouse.
 *
 * So: resize on first request, keep the result, serve that afterwards. A thumbnail is derived
 * data — losing the cache costs one resize, not an image.
 *
 * Unauthenticated, exactly like /uploads which it mirrors: an <img> tag cannot send a bearer
 * token, and putting these behind auth would mean no image ever loads. Nothing new is exposed —
 * every path served here is one the static handler already serves in full.
 */

const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const resize = require('../services/resize');

const router = express.Router();

/**
 * The resizer, if it is usable here.
 *
 * Pure JavaScript (jimp) rather than the obvious choice, sharp: this server is a QEMU virtual CPU
 * without SSE4.2 or POPCNT, so it meets neither the x86-64-v2 baseline sharp's prebuilt binaries
 * require nor the SIMD its WebAssembly fallback needs. Sharp does not merely run slowly there —
 * it throws while reporting that it cannot load, which took the whole CRM down on boot the first
 * time it was deployed.
 *
 * jimp is perhaps three times slower at this, which for a 96-pixel thumbnail rendered once and
 * then cached forever is not a number anybody will ever notice: 80ms for a 2560px photo.
 *
 * Loaded on first request and never allowed to throw past this function, because a thumbnail is a
 * convenience and nothing about it should be able to stop someone opening an order.
 */
let resizer;
function loadResizer() {
    if (resizer !== undefined) return resizer;
    try {
        resizer = require('jimp');
    } catch (err) {
        resizer = null;
        console.error('thumbnails are off — the resizer could not be loaded:', err.message);
    }
    return resizer;
}

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads');
const CACHE_ROOT = path.join(__dirname, '..', 'storage', 'thumbs');

// Fixed sizes rather than anything the caller asks for: an open-ended width is an invitation to
// fill the disk with a thousand near-identical renders of the same photo.
// 1280 is the viewer's size. Looking at a photograph should not mean decoding the 2560-pixel
// original — that is 26MB of bitmap per picture, held by the browser long after the viewer is
// closed, and it is what made the whole application sluggish after a visit to the sample library.
const WIDTHS = new Set([72, 96, 160, 320, 1280]);
const DEFAULT_WIDTH = 96;

const IMAGE = /\.(jpe?g|png|webp|gif|avif|heic|heif)$/i;

/**
 * The file a `src` names, or null if it is not an upload.
 *
 * Resolved and then checked to be inside the uploads directory, so "../../.env" cannot walk out
 * of it — the check has to come after resolution, since that is where the walking happens.
 */
function resolveUpload(src) {
    const clean = String(src || '').split('?')[0];
    if (!clean.startsWith('/uploads/')) return null;
    const full = path.resolve(UPLOAD_ROOT, '.' + clean.slice('/uploads'.length));
    if (full !== UPLOAD_ROOT && !full.startsWith(UPLOAD_ROOT + path.sep)) return null;
    return IMAGE.test(full) ? full : null;
}

const cachePath = (file, width) => path.join(CACHE_ROOT, String(width),
    `${crypto.createHash('sha1').update(`${file}|${width}`).digest('hex')}.jpg`);

// The sizes the pages actually ask for: the order list, the galleries, and the viewer. A photo is
// decoded once and all three are written from it, because the decode is nearly all of the six
// seconds a render takes here — rendering them one request at a time tripled the wait.
const SET = [96, 320, 1280];

// One render per photo at a time: a gallery and its viewer asking for the same picture share it.
const rendering = new Map();

/** Render every missing size of one upload. Resolves once they are all on disk. */
function render(file, width, { background = false } = {}) {
    const widths = [...new Set([...SET, width])];
    const outs = widths.map(w => ({ width: w, out: cachePath(file, w) })).filter(o => !fs.existsSync(o.out));
    if (!outs.length) return Promise.resolve();
    if (rendering.has(file)) return rendering.get(file);
    const job = resize.toFiles(file, outs, { background }).finally(() => rendering.delete(file));
    rendering.set(file, job);
    return job;
}

// How long a page waits for a render before it is sent the original photo instead. The viewer is
// the one someone is staring at, so it waits least; small thumbnails wait longer, because the
// original is a 4MB photograph and a list of them is a lot to download. The render carries on
// either way, so the next look is instant.
const PATIENCE_MS = (width) => (width >= 1280 ? 1500 : 8000);

/** GET /api/thumb?src=/uploads/crewfit/123/photo.jpeg&w=96 */
router.get('/', async (req, res) => {
    const file = resolveUpload(req.query.src);
    if (!file) return res.status(400).json({ error: 'Not an uploaded image' });

    const width = WIDTHS.has(parseInt(req.query.w, 10)) ? parseInt(req.query.w, 10) : DEFAULT_WIDTH;
    const cached = cachePath(file, width);
    const original = String(req.query.src).split('?')[0];

    const send = () => {
        res.setHeader('Content-Type', 'image/jpeg');
        // A thumbnail of a given upload never changes — the upload is immutable and a new photo
        // is a new filename — so it can be held for a year.
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        fs.createReadStream(cached).pipe(res);
    };
    // The original instead, for now. Not cached, so the next request gets the thumbnail.
    const fallBack = () => { res.setHeader('Cache-Control', 'no-store'); res.redirect(original); };

    // Straight to the original when there is no resizer at all: slow beats broken.
    if (!loadResizer()) return fallBack();

    try {
        if (fs.existsSync(cached)) return send();
        if (!fs.existsSync(file)) return res.status(404).json({ error: 'That image is not here' });

        // Rendered on the resizer thread rather than here: jimp is seconds of solid arithmetic
        // per photograph, and on this thread it stops the server answering anything at all.
        const job = render(file, width);
        let timer;
        const waited = await Promise.race([
            job.then(() => 'done'),
            new Promise(r => { timer = setTimeout(() => r('late'), PATIENCE_MS(width)); }),
        ]);
        clearTimeout(timer);
        if (waited === 'done' && fs.existsSync(cached)) return send();
        job.catch(err => console.error('thumb failed for', file, '-', err.message));
        fallBack();
    } catch (err) {
        console.error('thumb failed for', file, '-', err.message);
        // Fall back to the original rather than a broken image: slow beats missing.
        fallBack();
    }
});

/**
 * Render, in the background, every size that is not on disk yet — so a photo is ready before
 * anybody opens it. Run at start-up and then every so often for new uploads; one photo at a time,
 * and always behind anything somebody is actually waiting for.
 */
let warming = false;
async function warm() {
    if (warming || !loadResizer()) return;
    warming = true;
    let done = 0;
    try {
        const files = [];
        const walk = async (dir) => {
            for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) await walk(full);
                else if (IMAGE.test(entry.name)) files.push(full);
            }
        };
        await walk(UPLOAD_ROOT);
        for (const file of files) {
            if (SET.every(w => fs.existsSync(cachePath(file, w)))) continue;
            // Somebody is waiting on a picture: let theirs go first.
            while (resize.waiting > 0) await new Promise(r => setTimeout(r, 2000));
            try { await render(file, SET[0], { background: true }); done++; }
            catch (err) { if (!/too many/.test(err.message)) console.error('thumb warm failed for', file, '-', err.message); }
        }
    } finally {
        warming = false;
        if (done) console.log(`thumbnails: rendered ${done} photo${done === 1 ? '' : 's'} ahead of time`);
    }
}

module.exports = router;
module.exports.WIDTHS = WIDTHS;
module.exports.warm = warm;
