/**
 * /api/myxture — jersey orders sent to Myxture's print-on-demand portal, and checked back in.
 * See services/myxture.js for how "already sent" is decided.
 */
const express = require('express');
const db = require('../db/connection');
const { hasPermission } = require('../utils/permissions');
const mx = require('../services/myxture');

const router = express.Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.use(async (req, res, next) => {
    if (!await hasPermission(req, 'can_view_myxture')) return res.status(403).json({ error: 'Access denied' });
    next();
});

const who = (req) => req.user?.username || null;
const fail = (res, err, what) => {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(`myxture ${what}:`, err);
    res.status(500).json({ error: `Failed to ${what}` });
};

function contentDisposition(name) {
    const ascii = name.replace(/[^\x20-\x7E]/g, '-').replace(/["\\]/g, '');
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

router.get('/stats', async (req, res) => {
    try { res.json(await mx.stats()); } catch (err) { fail(res, err, 'load the Myxture summary'); }
});

// GET /api/myxture/ready?from=&to= — every line waiting to go, filtered on the client.
router.get('/ready', async (req, res) => {
    try {
        const from = DATE_RE.test(req.query.from || '') ? req.query.from : null;
        const to = DATE_RE.test(req.query.to || '') ? req.query.to : null;
        const lines = await mx.withImages(await mx.readyLines({ from, to }));
        res.json({ lines, mapped: (await mx.mappings()).length, sources: mx.MANUAL_SOURCES });
    } catch (err) { fail(res, err, 'load the orders ready for Myxture'); }
});

// POST /api/myxture/manual — a line for an order that didn't come through the store.
router.post('/manual', async (req, res) => {
    try { res.json(await mx.addManualLine(req.body || {}, who(req))); }
    catch (err) { fail(res, err, 'add the line'); }
});

router.delete('/manual/:id', async (req, res) => {
    try { await mx.deleteManualLine(parseInt(req.params.id, 10), who(req)); res.json({ ok: true }); }
    catch (err) { fail(res, err, 'remove the line'); }
});

router.put('/manual/:id', async (req, res) => {
    try { await mx.editManualLine(parseInt(req.params.id, 10), req.body || {}, who(req)); res.json({ ok: true }); }
    catch (err) { fail(res, err, 'save the line'); }
});

// PUT /api/myxture/ready/edit { order_shopify_id, line_key, shopify_product_id, shopify_variant_id, variant, qty, note }
router.put('/ready/edit', async (req, res) => {
    try { await mx.editReadyLine(req.body || {}, who(req)); res.json({ ok: true }); }
    catch (err) { fail(res, err, 'save the change'); }
});

// Undo a change made here; the line follows Shopify again.
router.post('/ready/edit/clear', async (req, res) => {
    try { await mx.clearReadyEdit(String(req.body?.order_shopify_id || ''), String(req.body?.line_key || '')); res.json({ ok: true }); }
    catch (err) { fail(res, err, 'undo the change'); }
});

// POST /api/myxture/ready/remove { order_shopify_id, line_key, order_number, title, variant, qty, reason }
router.post('/ready/remove', async (req, res) => {
    try { await mx.removeReadyLine(req.body || {}, who(req)); res.json({ ok: true }); }
    catch (err) { fail(res, err, 'remove the line'); }
});

router.put('/batches/:id/lines/:lineId', async (req, res) => {
    try {
        await mx.editBatchLine(parseInt(req.params.id, 10), parseInt(req.params.lineId, 10), req.body || {}, who(req));
        res.json(await mx.getBatch(parseInt(req.params.id, 10)));
    } catch (err) { fail(res, err, 'save the line'); }
});

router.post('/batches/:id/lines/:lineId/remove', async (req, res) => {
    try {
        await mx.removeBatchLine(parseInt(req.params.id, 10), parseInt(req.params.lineId, 10), req.body || {}, who(req));
        res.json(await mx.getBatch(parseInt(req.params.id, 10)));
    } catch (err) { fail(res, err, 'remove the line'); }
});

// The store's products with their variants and photos — for the product and variant pickers.
router.get('/catalogue', async (req, res) => {
    try { res.json({ products: await mx.catalogue() }); }
    catch (err) { fail(res, err, 'load the product catalogue'); }
});

// POST /api/myxture/batches { lines: [{ order_shopify_id, line_key }], note }
router.post('/batches', async (req, res) => {
    try {
        res.json(await mx.createBatch({ lines: req.body?.lines, note: req.body?.note, user: who(req) }));
    } catch (err) { fail(res, err, 'create the batch'); }
});

router.get('/batches', async (req, res) => {
    try {
        const limit = Math.min(200, parseInt(req.query.limit, 10) || 50);
        const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
        res.json(await mx.listBatches({ limit, offset }));
    } catch (err) { fail(res, err, 'load the batches'); }
});

router.get('/batches/:id', async (req, res) => {
    try {
        const b = await mx.getBatch(parseInt(req.params.id, 10));
        if (!b) return res.status(404).json({ error: 'Batch not found' });
        res.json(b);
    } catch (err) { fail(res, err, 'load the batch'); }
});

// The same file every time: built from what the batch recorded, not from today's orders.
const sendFile = (ext) => async (req, res) => {
    try {
        const b = await mx.getBatch(parseInt(req.params.id, 10));
        if (!b) return res.status(404).json({ error: 'Batch not found' });
        if (ext === 'csv') {
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', contentDisposition(mx.fileName(b, 'csv')));
            return res.send(mx.batchCsv(b));
        }
        const buf = await mx.batchXlsx(b);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', contentDisposition(mx.fileName(b, 'xlsx')));
        res.send(Buffer.from(buf));
    } catch (err) { fail(res, err, 'build the file'); }
};
router.get('/batches/:id/file.xlsx', sendFile('xlsx'));
router.get('/batches/:id/file.csv', sendFile('csv'));

router.post('/batches/:id/void', async (req, res) => {
    try { await mx.voidBatch(parseInt(req.params.id, 10), who(req)); res.json({ ok: true }); }
    catch (err) { fail(res, err, 'void the batch'); }
});

// POST /api/myxture/batches/:id/receive { lines: [{ id, received_qty, qc_note }] }
router.post('/batches/:id/receive', async (req, res) => {
    try {
        await mx.receiveLines(parseInt(req.params.id, 10), req.body?.lines, who(req));
        res.json(await mx.getBatch(parseInt(req.params.id, 10)));
    } catch (err) { fail(res, err, 'save what was received'); }
});

router.get('/attention', async (req, res) => {
    try { res.json({ lines: await mx.withImages(await mx.attentionLines()) }); } catch (err) { fail(res, err, 'load the changed orders'); }
});

router.post('/attention/:lineId/clear', async (req, res) => {
    try { await mx.clearAttention(parseInt(req.params.lineId, 10), who(req)); res.json({ ok: true }); }
    catch (err) { fail(res, err, 'clear it'); }
});

/* ---------------------------------- product mapping ---------------------------------- */

router.get('/products', async (req, res) => {
    try { res.json({ products: await mx.withImages(await mx.mappings({ activeOnly: false })) }); }
    catch (err) { fail(res, err, 'load the Myxture products'); }
});

router.put('/products/:productId', async (req, res) => {
    try {
        const id = String(req.params.productId).replace(/\D/g, '');
        const { title, product_type, fabric, design_file, active } = req.body || {};
        if (!id) return res.status(400).json({ error: 'Pick a Shopify product' });
        if (!String(product_type || '').trim()) return res.status(400).json({ error: 'Product type is required' });
        if (!String(design_file || '').trim()) return res.status(400).json({ error: 'Design file is required' });
        await db.query(
            `INSERT INTO myxture_products (shopify_product_id, title, product_type, fabric, design_file, active, updated_by, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
             ON CONFLICT (shopify_product_id) DO UPDATE SET title = excluded.title, product_type = excluded.product_type,
                fabric = excluded.fabric, design_file = excluded.design_file, active = excluded.active,
                updated_by = excluded.updated_by, updated_at = NOW()`,
            [id, title || null, String(product_type).trim(), String(fabric || '').trim() || null,
                String(design_file).trim(), active !== false, who(req)]);
        res.json({ ok: true });
    } catch (err) { fail(res, err, 'save the product'); }
});

// Stops new orders for it reaching the tab. Batches already sent keep their own copy of the
// product's details, so their files don't change.
router.delete('/products/:productId', async (req, res) => {
    try {
        const id = String(req.params.productId).replace(/\D/g, '');
        const open = (await db.query(
            'SELECT COUNT(*)::int AS n FROM myxture_manual_lines WHERE shopify_product_id = $1 AND deleted_at IS NULL', [id])).rows[0].n;
        await db.query('DELETE FROM myxture_products WHERE shopify_product_id = $1', [id]);
        res.json({ ok: true, manual_lines: open });
    } catch (err) { fail(res, err, 'delete the product'); }
});

module.exports = router;
