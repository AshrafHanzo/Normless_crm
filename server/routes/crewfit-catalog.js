/**
 * The catalogue customers are sent, and the photographs that go with it.
 *
 * Two things that look like one: the PDF, which is the price list as it leaves the building, and
 * the sample library, which is "here is what we have made" — the pictures a salesperson reaches
 * for when a customer asks what a polo looks like printed.
 *
 * The library is deliberately not a new pile of files. Four hundred-odd photographs already exist
 * on past orders, shot by the people who packed them, and they are the best evidence of the work
 * there is. They are read where they lie, on the orders, and listed beside anything uploaded here
 * on purpose. Nothing is copied, so nothing can drift out of step with the order it came from.
 *
 * Downloading a set of them is a zip, not forty save prompts — and at a size the person picks,
 * because a printer wants the original and WhatsApp will not take 600MB of it.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const yazl = require('yazl');
const db = require('../db/connection');
const { hasPermission } = require('../utils/permissions');

const router = express.Router();

const SERVER_ROOT = path.join(__dirname, '..');
// The PDF is not served statically: it is the price list, and a guessable URL is a price list
// anyone can read. The images are, because a thumbnail grid cannot send a bearer token.
const PDF_DIR = path.join(SERVER_ROOT, 'storage', 'crewfit', 'catalog');
const SAMPLE_DIR = path.join(SERVER_ROOT, 'uploads', 'crewfit-samples');
const MAX_PDF_MB = 40;
const MAX_IMAGE_MB = 15;
// Twelve rather than twenty: nginx takes 55MB in a request and these are phone photographs.
const MAX_IMAGES = 12;
// A zip is streamed, so memory is not the limit — patience is. Past this many files the browser
// is better off being told to narrow the selection.
const MAX_ZIP_FILES = 400;

/* ── Gates ──────────────────────────────────────────────────────────────────────────────────── */

router.use(async (req, res, next) => {
    try {
        if (!await hasPermission(req, 'can_view_crewfit_catalog')) return res.status(403).json({ error: 'Access denied' });
        next();
    } catch (err) { next(err); }
});

const gate = (column, message) => async (req, res, next) => {
    try {
        if (!await hasPermission(req, column)) return res.status(403).json({ error: message });
        next();
    } catch (err) { next(err); }
};
const canUploadPdf = gate('can_upload_crewfit_catalog', 'You can download the catalogue but not replace it');
const canUploadSamples = gate('can_upload_crewfit_samples', 'You can download samples but not add them');

const trim = (v) => { const t = String(v ?? '').trim(); return t || null; };
const safeJson = (v, fallback) => { try { return typeof v === 'string' ? (JSON.parse(v || 'null') ?? fallback) : (v || fallback); } catch { return fallback; } };
const stamped = (original) => {
    const ext = path.extname(original).toLowerCase().replace(/[^a-z0-9.]/g, '');
    return `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
};

/* ── The catalogue PDF ──────────────────────────────────────────────────────────────────────── */

const pdfUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => { fs.mkdirSync(PDF_DIR, { recursive: true }); cb(null, PDF_DIR); },
        filename: (req, file, cb) => cb(null, stamped(file.originalname)),
    }),
    limits: { fileSize: MAX_PDF_MB * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname)) cb(null, true);
        else cb(new Error('The catalogue has to be a PDF'));
    },
});

/** Every version, newest first — the top one is what customers are being sent today. */
router.get('/pdf', async (req, res) => {
    try {
        const r = await db.query(
            `SELECT id, version, title, note, file_name, size_bytes, uploaded_by, uploaded_at
               FROM crewfit_catalog_files ORDER BY version DESC`);
        res.json({ versions: r.rows, current: r.rows[0] || null });
    } catch (err) {
        console.error('catalog pdf list error:', err);
        res.status(500).json({ error: 'Could not read the catalogue' });
    }
});

/** The file itself. `current` is the shorthand the page uses for the download button. */
router.get('/pdf/:id/file', async (req, res) => {
    try {
        const where = req.params.id === 'current' ? 'ORDER BY version DESC LIMIT 1' : 'WHERE id = $1';
        const vals = req.params.id === 'current' ? [] : [parseInt(req.params.id, 10) || 0];
        const row = (await db.query(`SELECT * FROM crewfit_catalog_files ${where}`, vals)).rows[0];
        if (!row) return res.status(404).json({ error: 'No catalogue has been uploaded yet' });

        const full = path.join(PDF_DIR, path.basename(row.file_path));
        if (!fs.existsSync(full)) return res.status(404).json({ error: 'That catalogue file is missing from the server' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${row.file_name.replace(/"/g, '')}"`);
        fs.createReadStream(full).pipe(res);
    } catch (err) {
        console.error('catalog pdf download error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Could not send the catalogue' });
    }
});

/** A new version. The old ones stay: a quote sent last month was priced off one of them. */
router.post('/pdf', canUploadPdf, (req, res, next) => pdfUpload.single('file')(req, res, (err) => {
    if (!err) return next();
    const known = { LIMIT_FILE_SIZE: `The catalogue must be under ${MAX_PDF_MB}MB` };
    res.status(400).json({ error: known[err.code] || err.message || 'Could not read that file' });
}), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Attach the catalogue PDF' });
        const next = (await db.query('SELECT COALESCE(MAX(version), 0) + 1 AS n FROM crewfit_catalog_files')).rows[0].n;
        const row = (await db.query(
            `INSERT INTO crewfit_catalog_files (version, title, note, file_name, file_path, size_bytes, uploaded_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, version, title, note, file_name, size_bytes, uploaded_by, uploaded_at`,
            [next, trim(req.body?.title), trim(req.body?.note), req.file.originalname, req.file.filename,
                req.file.size, req.user?.username || null])).rows[0];
        res.status(201).json({ version: row });
    } catch (err) {
        console.error('catalog pdf upload error:', err);
        if (req.file) fs.unlink(req.file.path, () => {});
        res.status(500).json({ error: 'Could not save that catalogue' });
    }
});

/** Only the owner removes a version, and the file goes with the record. */
router.delete('/pdf/:id', canUploadPdf, async (req, res) => {
    try {
        if (req.user?.role !== 'owner') return res.status(403).json({ error: 'Only the owner can remove a catalogue version' });
        const row = (await db.query('DELETE FROM crewfit_catalog_files WHERE id = $1 RETURNING file_path, version',
            [parseInt(req.params.id, 10) || 0])).rows[0];
        if (!row) return res.status(404).json({ error: 'That version is already gone' });
        fs.unlink(path.join(PDF_DIR, path.basename(row.file_path)), () => {});
        res.json({ deleted: true, version: row.version });
    } catch (err) {
        console.error('catalog pdf delete error:', err);
        res.status(500).json({ error: 'Could not remove that version' });
    }
});

/* ── The sample library ─────────────────────────────────────────────────────────────────────── */

const sampleUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => { fs.mkdirSync(SAMPLE_DIR, { recursive: true }); cb(null, SAMPLE_DIR); },
        filename: (req, file, cb) => cb(null, stamped(file.originalname)),
    }),
    limits: { fileSize: MAX_IMAGE_MB * 1024 * 1024, files: MAX_IMAGES },
    fileFilter: (req, file, cb) => {
        if (/^image\/(jpeg|png|webp|heic|heif)$/.test(file.mimetype)) cb(null, true);
        else cb(new Error('Only JPG, PNG or WEBP images can be uploaded'));
    },
});

/**
 * Every photograph we hold of a product, wherever it lives.
 *
 * Order photos are read out of the line items that carry them, so the library needs no copy of
 * anything and cannot fall out of step with the orders. Each one says which order and which
 * customer it came from, because that is what tells you whether it can be sent to somebody else.
 */
async function libraryImages() {
    const out = [];

    const orders = (await db.query(
        `SELECT id, sl_no, customer_name, order_date, line_items
           FROM crewfit_orders WHERE line_items IS NOT NULL ORDER BY order_date DESC NULLS LAST, id DESC`)).rows;
    for (const o of orders) {
        for (const it of safeJson(o.line_items, [])) {
            for (const [kind, urls] of [['Production', it.prodImages], ['Mock', it.mockImages]]) {
                for (const url of urls || []) {
                    out.push({
                        id: `order:${url}`,
                        url,
                        source: kind,
                        product: it.product || null,
                        color: it.color || null,
                        order_no: o.sl_no,
                        order_id: o.id,
                        customer_name: o.customer_name || null,
                        taken_on: o.order_date,
                    });
                }
            }
        }
    }

    const uploaded = (await db.query(
        `SELECT id, product, title, file_path, uploaded_by, uploaded_at FROM crewfit_samples ORDER BY uploaded_at DESC`)).rows;
    for (const s of uploaded) {
        out.push({
            id: `sample:${s.id}`,
            sample_id: s.id,
            url: s.file_path,
            source: 'Uploaded',
            product: s.product || null,
            title: s.title || null,
            uploaded_by: s.uploaded_by,
            taken_on: s.uploaded_at,
        });
    }
    return out;
}

/** GET /api/crewfit/catalog/samples?search=&product=&source= */
router.get('/samples', async (req, res) => {
    try {
        const all = await libraryImages();
        const search = (trim(req.query.search) || '').toLowerCase();
        const product = trim(req.query.product);
        const source = trim(req.query.source);

        const images = all.filter(i =>
            (!product || i.product === product)
            && (!source || i.source === source)
            && (!search || [i.product, i.title, i.customer_name, i.color, i.order_no && `cf-${i.order_no}`]
                .filter(Boolean).some(v => String(v).toLowerCase().includes(search))));

        // What is actually held, so the filter chips can only offer something that exists.
        const byProduct = new Map();
        for (const i of all) {
            const key = i.product || 'Not named';
            byProduct.set(key, (byProduct.get(key) || 0) + 1);
        }
        res.json({
            images,
            total: all.length,
            products: [...byProduct.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
        });
    } catch (err) {
        console.error('samples list error:', err);
        res.status(500).json({ error: 'Could not read the sample library' });
    }
});

/** Add samples of our own, named so they can be found again. */
router.post('/samples', canUploadSamples, (req, res, next) => sampleUpload.array('images', MAX_IMAGES)(req, res, (err) => {
    if (!err) return next();
    const known = {
        LIMIT_FILE_SIZE: `Each image must be under ${MAX_IMAGE_MB}MB`,
        LIMIT_FILE_COUNT: `Up to ${MAX_IMAGES} images at a time`,
    };
    res.status(400).json({ error: known[err.code] || err.message || 'Could not read those images' });
}), async (req, res) => {
    try {
        if (!req.files?.length) return res.status(400).json({ error: 'Choose the images to add' });
        const product = trim(req.body?.product);
        if (!product) {
            req.files.forEach(f => fs.unlink(f.path, () => {}));
            return res.status(400).json({ error: 'Name the product these are of — it is how anyone finds them again' });
        }
        const title = trim(req.body?.title);
        const saved = [];
        for (const f of req.files) {
            const r = await db.query(
                `INSERT INTO crewfit_samples (product, title, file_path, size_bytes, uploaded_by)
                 VALUES ($1,$2,$3,$4,$5) RETURNING id, product, title, file_path, uploaded_at`,
                [product, title, `/uploads/crewfit-samples/${f.filename}`, f.size, req.user?.username || null]);
            saved.push(r.rows[0]);
        }
        res.status(201).json({ added: saved.length, samples: saved });
    } catch (err) {
        console.error('samples upload error:', err);
        (req.files || []).forEach(f => fs.unlink(f.path, () => {}));
        res.status(500).json({ error: 'Could not add those samples' });
    }
});

/** Remove an uploaded sample. Order photos are not touched from here — they belong to the order. */
router.delete('/samples/:id', canUploadSamples, async (req, res) => {
    try {
        if (req.user?.role !== 'owner') return res.status(403).json({ error: 'Only the owner can remove a sample' });
        const row = (await db.query('DELETE FROM crewfit_samples WHERE id = $1 RETURNING file_path',
            [parseInt(req.params.id, 10) || 0])).rows[0];
        if (!row) return res.status(404).json({ error: 'That sample is already gone' });
        fs.unlink(path.join(SERVER_ROOT, row.file_path.replace(/^\//, '')), () => {});
        res.json({ deleted: true });
    } catch (err) {
        console.error('sample delete error:', err);
        res.status(500).json({ error: 'Could not remove that sample' });
    }
});

/**
 * POST /api/crewfit/catalog/samples/zip { urls: [...], size: 'original' | 'web', name? }
 *
 * One file instead of forty save prompts. `web` runs each image through the same resizer the
 * thumbnails use — a set that is 600MB of phone photographs comes back small enough to send,
 * which is the difference between the feature being used and not.
 *
 * Streamed as it is built: nothing is held in memory and nothing is written to disk.
 */
router.post('/samples/zip', async (req, res) => {
    try {
        const urls = (Array.isArray(req.body?.urls) ? req.body.urls : [])
            .map(u => String(u || ''))
            // Only the two places images live. A path from anywhere else is somebody probing.
            .filter(u => /^\/uploads\/(crewfit|crewfit-samples)\//.test(u) && !u.includes('..'));
        if (!urls.length) return res.status(400).json({ error: 'Nothing was selected' });
        if (urls.length > MAX_ZIP_FILES) {
            return res.status(400).json({ error: `That is ${urls.length} images — narrow it to ${MAX_ZIP_FILES} or fewer` });
        }
        const web = String(req.body?.size || 'original') === 'web';
        const label = (trim(req.body?.name) || 'crewfit-samples').replace(/[^a-z0-9._-]+/gi, '-').toLowerCase();

        // Resolved before a single header goes out. A zip is streamed, so once it has started
        // there is no way to say "none of those files are here" — the person just receives an
        // empty archive and no reason for it.
        const found = urls
            .map(url => ({ url, full: path.join(SERVER_ROOT, url.replace(/^\//, '')) }))
            .filter(f => fs.existsSync(f.full));
        if (!found.length) {
            return res.status(404).json({ error: 'None of those images are on this server any more' });
        }
        const missing = urls.length - found.length;
        if (missing) console.warn(`samples zip: ${missing} of ${urls.length} files are missing from disk`);

        // jimp is loaded only when a resize is actually asked for: it is the heaviest thing in the
        // process and a download of originals should not pay for it.
        const jimp = web ? require('jimp') : null;

        const zip = new yazl.ZipFile();
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${label}-${web ? 'web' : 'originals'}.zip"`);
        zip.outputStream.pipe(res);

        const used = new Set();
        for (const { url, full } of found) {
            // Two orders can hold a file of the same name; a zip cannot.
            let name = path.basename(url);
            while (used.has(name)) name = `${path.parse(name).name}-${crypto.randomBytes(2).toString('hex')}${path.extname(name)}`;
            used.add(name);

            if (!web) { zip.addFile(full, name); continue; }
            try {
                const img = await jimp.read(full);
                if (Math.max(img.bitmap.width, img.bitmap.height) > 1600) img.scaleToFit(1600, 1600);
                const buf = await img.quality(82).getBufferAsync(jimp.MIME_JPEG);
                // A "smaller" copy that came out bigger is not a smaller copy: flat artwork
                // compresses better as PNG than as JPEG, and the point of this option is the size.
                if (buf.length >= fs.statSync(full).size) zip.addFile(full, name);
                else zip.addBuffer(buf, name.replace(/\.(png|webp|heic|heif)$/i, '.jpg'));
            } catch (e) {
                // A picture that will not resize is still a picture: send it as it is rather than
                // dropping it out of a download somebody is relying on being complete.
                console.error('zip resize failed, sending the original:', url, e.message);
                zip.addFile(full, name);
            }
        }
        zip.end();
    } catch (err) {
        console.error('samples zip error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Could not build that download' });
    }
});

module.exports = router;
