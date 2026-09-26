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
const sharp = require('sharp');

const router = express.Router();

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads');
const CACHE_ROOT = path.join(__dirname, '..', 'storage', 'thumbs');

// Fixed sizes rather than anything the caller asks for: an open-ended width is an invitation to
// fill the disk with a thousand near-identical renders of the same photo.
const WIDTHS = new Set([72, 96, 160, 320]);
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

/** GET /api/thumb?src=/uploads/crewfit/123/photo.jpeg&w=96 */
router.get('/', async (req, res) => {
    const file = resolveUpload(req.query.src);
    if (!file) return res.status(400).json({ error: 'Not an uploaded image' });

    const width = WIDTHS.has(parseInt(req.query.w, 10)) ? parseInt(req.query.w, 10) : DEFAULT_WIDTH;
    const key = crypto.createHash('sha1').update(`${file}|${width}`).digest('hex');
    const cached = path.join(CACHE_ROOT, String(width), `${key}.webp`);

    const send = () => {
        res.setHeader('Content-Type', 'image/webp');
        // A thumbnail of a given upload never changes — the upload is immutable and a new photo
        // is a new filename — so it can be held for a year.
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        fs.createReadStream(cached).pipe(res);
    };

    try {
        if (fs.existsSync(cached)) return send();
        if (!fs.existsSync(file)) return res.status(404).json({ error: 'That image is not here' });

        await fsp.mkdir(path.dirname(cached), { recursive: true });
        // `withoutEnlargement` so a small image is served as-is rather than blown up and blurred.
        // rotate() first: phone photos carry their orientation in EXIF, and dropping it turns a
        // portrait mock on its side.
        await sharp(file)
            .rotate()
            .resize({ width, withoutEnlargement: true })
            .webp({ quality: 78 })
            .toFile(cached);
        send();
    } catch (err) {
        console.error('thumb failed for', file, '-', err.message);
        // Fall back to the original rather than a broken image: slow beats missing.
        res.redirect(String(req.query.src).split('?')[0]);
    }
});

module.exports = router;
module.exports.WIDTHS = WIDTHS;
