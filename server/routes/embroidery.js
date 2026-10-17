/**
 * The design studio: a customer's logo in, a machine-ready stitch file out.
 *
 * The digitising itself is done by a small Python service (embroidery-service/) listening on
 * localhost — OpenCV and the DST writer have no sensible equivalent in this stack. This route is
 * the only way to it: the browser never learns the service exists, never holds its key, and never
 * reaches past the CRM's own login.
 *
 * Every conversion is kept — the logo that went in, the DST that came out and its preview —
 * because a stitch file is regenerated from a logo nobody can find three months later, and
 * because the thread colours only exist here. A DST carries no colour information of its own, so
 * the list is what tells the machine operator which threads to load.
 */

const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db/connection');
const { hasPermission } = require('../utils/permissions');
const { tableParams, pagination } = require('../utils/table');

const router = express.Router();

// The logo and the stitch file are private: a customer's artwork and the file a machine would
// run it from. The preview is not — it has to be drawable by an <img>, which cannot carry a
// bearer token, so it lives with every other image in the application under /uploads.
const STORE = path.join(__dirname, '..', 'storage', 'embroidery');
const PREVIEW_STORE = path.join(__dirname, '..', 'uploads', 'embroidery');
const SERVICE = process.env.EMB_SERVICE_URL || 'http://127.0.0.1:8090';
const MAX_MB = 15;                 // the converter's own limit
const CONVERT_TIMEOUT_MS = 120000; // a big logo on this hardware is seconds, not minutes

// Held in memory: the file goes straight back out to the converter, and only what comes back is
// worth writing down.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
        if (/^image\/(png|jpeg)$/.test(file.mimetype)) cb(null, true);
        else cb(new Error('The logo has to be a PNG or a JPG'));
    },
});

/** One grant covers the page and the work: there is nothing to look at without converting. */
router.use(async (req, res, next) => {
    try {
        if (!await hasPermission(req, 'can_use_design_studio')) return res.status(403).json({ error: 'Access denied' });
        next();
    } catch (err) { next(err); }
});

const trim = (v) => { const t = String(v ?? '').trim(); return t || null; };
const safeJson = (v, fallback) => { try { return typeof v === 'string' ? (JSON.parse(v || 'null') ?? fallback) : (v || fallback); } catch { return fallback; } };
const hydrate = (r) => (r ? {
    ...r,
    thread_colors: safeJson(r.thread_colors, []),
    warnings: safeJson(r.warnings, []),
} : r);

const FIELDS = `id, name, note, width_mm, height_mm, stitch_count, thread_colors, colors_setting,
                underlay, stitch_type, fill_used, underlay_used, warnings, source_name,
                preview_path, dst_bytes, created_by, created_at`;

/** A filename somebody will recognise in their downloads folder. */
const slug = (v) => String(v || 'design').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'design';

/* ── Is the converter there? ─────────────────────────────────────────────────────────────────
   Asked before anything is uploaded, so the page can say "the converter is not running" instead
   of swallowing a logo and failing a minute later. */
router.get('/health', async (req, res) => {
    try {
        const r = await fetch(`${SERVICE}/health`, { signal: AbortSignal.timeout(4000) });
        const body = await r.json().catch(() => null);
        res.json({ up: r.ok && body?.ok === true, configured: !!process.env.EMB_API_KEY });
    } catch (err) {
        res.json({ up: false, configured: !!process.env.EMB_API_KEY, error: err.message });
    }
});

/* ── Converting ──────────────────────────────────────────────────────────────────────────────── */

router.post('/convert', (req, res, next) => upload.single('file')(req, res, (err) => {
    if (!err) return next();
    const known = { LIMIT_FILE_SIZE: `The logo must be under ${MAX_MB}MB` };
    res.status(400).json({ error: known[err.code] || err.message || 'Could not read that file' });
}), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Choose the logo to convert' });
        const widthMm = Number(req.body?.width_mm);
        if (!Number.isFinite(widthMm) || widthMm < 10 || widthMm > 400) {
            return res.status(400).json({ error: 'The finished width must be between 10mm and 400mm' });
        }
        const STITCHES = ['auto', 'satin', 'tatami', 'satin_border', 'run'];
        const stitchType = STITCHES.includes(trim(req.body?.stitch_type)) ? trim(req.body.stitch_type) : 'auto';
        const colors = trim(req.body?.colors) || 'auto';
        const underlay = String(req.body?.underlay ?? 'true') !== 'false';
        const name = trim(req.body?.name) || path.parse(req.file.originalname).name;

        const form = new FormData();
        form.append('file', new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname);
        form.append('width_mm', String(widthMm));
        form.append('colors', colors);
        form.append('underlay', String(underlay));
        form.append('stitch_type', stitchType);

        let answer;
        try {
            answer = await fetch(`${SERVICE}/convert`, {
                method: 'POST',
                headers: process.env.EMB_API_KEY ? { 'X-API-Key': process.env.EMB_API_KEY } : {},
                body: form,
                signal: AbortSignal.timeout(CONVERT_TIMEOUT_MS),
            });
        } catch (err) {
            // The converter is a separate service; when it is down this is the honest answer,
            // rather than a 500 that reads like the CRM broke.
            console.error('embroidery service unreachable:', err.message);
            return res.status(503).json({ error: 'The converter is not running on the server — ask for it to be started' });
        }

        if (!answer.ok) {
            const detail = await answer.json().catch(() => null);
            const message = detail?.detail || `The converter refused that file (${answer.status})`;
            return res.status(answer.status === 401 ? 500 : 400)
                .json({ error: answer.status === 401 ? 'The converter rejected our key — EMB_API_KEY does not match' : message });
        }

        const out = await answer.json();
        const info = out.info || {};
        const dst = Buffer.from(out.dst_base64 || '', 'base64');
        const preview = Buffer.from(out.preview_png_base64 || '', 'base64');
        if (!dst.length) return res.status(500).json({ error: 'The converter returned an empty stitch file' });

        // Kept under storage rather than uploads: a customer's logo and the file a machine would
        // stitch it from are not things to leave on a guessable public path.
        const stamp = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
        const dir = path.join(STORE, stamp);
        await fsp.mkdir(dir, { recursive: true });
        const ext = path.extname(req.file.originalname).toLowerCase() === '.jpg' ? '.jpg' : path.extname(req.file.originalname).toLowerCase() || '.png';
        await fsp.writeFile(path.join(dir, `source${ext}`), req.file.buffer);
        await fsp.writeFile(path.join(dir, 'design.dst'), dst);
        await fsp.mkdir(path.join(PREVIEW_STORE, stamp), { recursive: true });
        await fsp.writeFile(path.join(PREVIEW_STORE, stamp, 'preview.png'), preview);

        const row = (await db.query(
            `INSERT INTO embroidery_designs
               (name, note, width_mm, height_mm, stitch_count, thread_colors, colors_setting,
                underlay, stitch_type, fill_used, underlay_used, warnings, source_name,
                source_path, dst_path, preview_path, dst_bytes, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
             RETURNING ${FIELDS}`,
            [name, trim(req.body?.note), info.width_mm ?? widthMm, info.height_mm ?? null,
                info.stitch_count ?? null, JSON.stringify(info.thread_colors || []), colors, underlay,
                // Asked for, and done: a shape too wide for satin is filled instead, and the two
                // columns are how anyone sees that happened.
                info.stitch_type || stitchType, info.fill || null, info.underlay || null,
                JSON.stringify(info.warnings || []), req.file.originalname,
                `${stamp}/source${ext}`, `${stamp}/design.dst`, `/uploads/embroidery/${stamp}/preview.png`, dst.length,
                req.user?.username || null])).rows[0];

        res.status(201).json({ design: hydrate(row) });
    } catch (err) {
        console.error('embroidery convert error:', err);
        res.status(500).json({ error: 'Could not convert that logo' });
    }
});

/* ── The library ─────────────────────────────────────────────────────────────────────────────── */

const SORTS = {
    name: 'LOWER(name)', created_at: 'created_at', stitch_count: 'stitch_count', width_mm: 'width_mm',
};

router.get('/designs', async (req, res) => {
    try {
        const where = [];
        const vals = [];
        const search = trim(req.query.search);
        if (search) {
            vals.push(`%${search}%`);
            where.push(`(name ILIKE $${vals.length} OR note ILIKE $${vals.length} OR source_name ILIKE $${vals.length})`);
        }
        const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const t = tableParams(req.query, { sortable: SORTS, defaultSort: 'created_at', defaultDir: 'desc', defaultLimit: 24 });
        const rows = (await db.query(
            `SELECT ${FIELDS} FROM embroidery_designs ${clause} ${t.orderBy} LIMIT ${t.limit} OFFSET ${t.offset}`, vals)).rows;
        const total = (await db.query(`SELECT COUNT(*)::int AS n FROM embroidery_designs ${clause}`, vals)).rows[0].n;
        const sums = (await db.query(
            `SELECT COUNT(*)::int AS designs, COALESCE(SUM(stitch_count),0)::bigint AS stitches FROM embroidery_designs`)).rows[0];
        res.json({ designs: rows.map(hydrate), summary: sums, pagination: pagination(total, t) });
    } catch (err) {
        console.error('embroidery list error:', err);
        res.status(500).json({ error: 'Could not read the design library' });
    }
});

/** The three files a conversion leaves behind: what went in, what came out, and what it looks like. */
router.get('/designs/:id/:kind', async (req, res) => {
    try {
        const kinds = {
            dst: { col: 'dst_path', type: 'application/octet-stream', ext: 'dst', inline: false, root: STORE },
            preview: { col: 'preview_path', type: 'image/png', ext: 'png', inline: true, root: null },
            source: { col: 'source_path', type: 'image/png', ext: 'png', inline: true, root: STORE },
        };
        const kind = kinds[req.params.kind];
        if (!kind) return res.status(404).json({ error: 'No such file' });

        const row = (await db.query(`SELECT * FROM embroidery_designs WHERE id = $1`, [parseInt(req.params.id, 10) || 0])).rows[0];
        if (!row) return res.status(404).json({ error: 'That design is gone' });
        // The preview is stored by its served path; the private two by a name inside the store.
        const root = kind.root || path.join(__dirname, '..');
        const full = path.join(root, row[kind.col].replace(/^\//, ''));
        if (!full.startsWith(root + path.sep) || !fs.existsSync(full)) {
            return res.status(404).json({ error: 'That file is missing from the server' });
        }
        const name = `${slug(row.name)}_${Math.round(Number(row.width_mm) || 0)}mm.${kind.ext}`;
        res.setHeader('Content-Type', kind.type);
        res.setHeader('Content-Disposition', `${kind.inline ? 'inline' : 'attachment'}; filename="${name}"`);
        res.setHeader('Cache-Control', 'private, max-age=86400');
        fs.createReadStream(full).pipe(res);
    } catch (err) {
        console.error('embroidery file error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Could not send that file' });
    }
});

/** Rename, or note what it is for. The files themselves are what they are. */
router.patch('/designs/:id', async (req, res) => {
    try {
        const patch = {};
        if (req.body.name !== undefined) patch.name = trim(req.body.name);
        if (req.body.note !== undefined) patch.note = trim(req.body.note);
        if (!patch.name && req.body.name !== undefined) return res.status(400).json({ error: 'A design needs a name' });
        if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change' });

        const cols = Object.keys(patch);
        const r = await db.query(
            `UPDATE embroidery_designs SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}
              WHERE id = $1 RETURNING ${FIELDS}`,
            [parseInt(req.params.id, 10) || 0, ...cols.map(c => patch[c])]);
        if (!r.rows[0]) return res.status(404).json({ error: 'That design is gone' });
        res.json({ design: hydrate(r.rows[0]) });
    } catch (err) {
        console.error('embroidery update error:', err);
        res.status(500).json({ error: 'Could not save that' });
    }
});

router.delete('/designs/:id', async (req, res) => {
    try {
        const row = (await db.query('DELETE FROM embroidery_designs WHERE id = $1 RETURNING dst_path, preview_path, name',
            [parseInt(req.params.id, 10) || 0])).rows[0];
        if (!row) return res.status(404).json({ error: 'That design is already gone' });
        // Both folders named for the conversion go with the record: the private pair and the
        // preview that had to live where an <img> could reach it.
        fs.rm(path.join(STORE, path.dirname(row.dst_path)), { recursive: true, force: true }, () => {});
        fs.rm(path.join(PREVIEW_STORE, path.dirname(row.dst_path)), { recursive: true, force: true }, () => {});
        res.json({ deleted: true, name: row.name });
    } catch (err) {
        console.error('embroidery delete error:', err);
        res.status(500).json({ error: 'Could not remove that design' });
    }
});

module.exports = router;
