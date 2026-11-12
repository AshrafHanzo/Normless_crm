/**
 * Myxture: the print-on-demand vendor that makes our oversized jerseys.
 *
 * We don't hold jersey stock. Each order line for a jersey goes to Myxture's portal as a row of
 * their bulk-order sheet; they make it and deliver to our warehouse in two or three days, where
 * the team checks what came against what was sent.
 *
 * The one thing this must get right is that nothing is sent twice. The team downloads a sheet and
 * pastes it into the portal, so every download is recorded as a batch, and a line in a batch that
 * hasn't been voided is sent. What is ready is worked out as ordered minus sent, per order line,
 * so an order edited to add a second jersey after the first went out shows just the new one.
 */

const ExcelJS = require('exceljs');
const db = require('../db/connection');
const inv = require('./inventory');
const { toCsv } = require('../utils/csv');

// The portal's bulk-order sheet, column for column. The customer and payment columns stay empty:
// Myxture ships to our warehouse, not to the customer.
const COLUMNS = [
    'Order number', 'Product type', 'Variant 1', 'Variant 2', 'Qty', 'Shipping', 'Design file',
    'Preview', 'Label', 'Notes', 'Name', 'Phone', 'Email', 'Address', 'Pincode', 'City', 'Payment', 'Value',
];
const SHIPPING = 'Direct Collect';
const SHEET_NAME = 'Bulk order';

// Deliveries normally take two or three days; past this a batch is worth chasing.
const OVERDUE_DAYS = 3;

const SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'];
const SIZE_ALIASES = { XXL: '2XL', XXXL: '3XL', XXXXL: '4XL' };
const normSize = (s) => {
    const u = String(s || '').trim().toUpperCase().replace(/\s+/g, '');
    return SIZE_ALIASES[u] || u;
};
const isSize = (s) => SIZE_ORDER.includes(normSize(s));

const batchRef = (no) => `MYX-${String(no).padStart(4, '0')}`;
const plainOrderNo = (n) => String(n || '').replace(/^#/, '');

/**
 * Colour and size out of a variant title. Shopify writes "Beige / L" for a two-option product and
 * just "L" when size is the only option, so size is whichever part looks like a size.
 */
function splitVariant(variant) {
    const parts = String(variant || '').split('/').map(s => s.trim()).filter(Boolean);
    const sizeIdx = parts.findIndex(isSize);
    const size = sizeIdx === -1 ? '' : normSize(parts[sizeIdx]);
    const color = parts.filter((_, i) => i !== sizeIdx).join(' / ');
    return { color, size };
}

const designFileFor = (mapping, color) =>
    String(mapping.design_file || '').replace(/\{colou?r\}/gi, color || '').trim();

const lineKeyOf = (item) => item.shopify_variant_id
    ? String(item.shopify_variant_id)
    : `${item.shopify_product_id || ''}:${item.title || ''}:${item.variant || ''}`;

/* ------------------------------------------------------------------------------------------ */

async function mappings({ activeOnly = true } = {}) {
    const r = await db.query(
        `SELECT m.*, p.title AS shop_title FROM myxture_products m
           LEFT JOIN shopify_products p ON p.shopify_id = m.shopify_product_id
          ${activeOnly ? 'WHERE m.active = true' : ''}
          ORDER BY COALESCE(m.title, p.title)`);
    return r.rows;
}

/** Product ids Myxture makes — the pick list leaves these out, since we don't print them. */
async function productIds() {
    try {
        const r = await db.query('SELECT shopify_product_id FROM myxture_products WHERE active = true');
        return new Set(r.rows.map(x => String(x.shopify_product_id)));
    } catch {
        return new Set();
    }
}

/** Sent quantity per order line, over batches that weren't voided. Key: `${order}|${line}`. */
async function sentIndex(client = db, orderIds = null) {
    const vals = [];
    let where = 'b.voided_at IS NULL';
    if (orderIds) { vals.push(orderIds); where += ' AND l.order_shopify_id = ANY($1)'; }
    const r = await client.query(
        `SELECT l.order_shopify_id, l.line_key, SUM(l.qty)::int AS qty
           FROM myxture_batch_lines l JOIN myxture_batches b ON b.id = l.batch_id
          WHERE ${where}
          GROUP BY l.order_shopify_id, l.line_key`, vals);
    return new Map(r.rows.map(x => [`${x.order_shopify_id}|${x.line_key}`, x.qty]));
}

/**
 * Every Myxture line still waiting to be sent. Same idea of "open" as the pick list — not
 * fulfilled, cancelled, refunded, voided or on hold — and both COD and prepaid count.
 */
async function readyLines({ client = db, from, to } = {}) {
    const maps = await mappings();
    if (!maps.length) return [];
    const byProduct = new Map(maps.map(m => [String(m.shopify_product_id), m]));

    const where = [
        `UPPER(COALESCE(o.fulfillment_status,'')) NOT IN ('FULFILLED','RESTOCKED')`,
        `UPPER(COALESCE(o.financial_status,'')) NOT IN ('VOIDED','REFUNDED')`,
        'o.cancelled_at IS NULL',
        'COALESCE(o.on_hold, false) = false',
    ];
    const vals = [];
    if (from) { vals.push(from); where.push(`o.created_at::date >= $${vals.length}`); }
    if (to) { vals.push(to); where.push(`o.created_at::date <= $${vals.length}`); }
    // Cheap text prefilter so only orders holding a Myxture product are parsed.
    const ids = [...byProduct.keys()];
    vals.push(ids.map(id => `%${id}%`));
    where.push(`o.line_items_json LIKE ANY($${vals.length})`);

    const orders = (await client.query(
        `SELECT o.shopify_id, o.order_number, o.financial_status, o.created_at, o.line_items_json
           FROM orders o WHERE ${where.join(' AND ')}
          ORDER BY o.created_at DESC`, vals)).rows;
    if (!orders.length) return [];

    const sent = await sentIndex(client, orders.map(o => String(o.shopify_id)));
    const out = [];
    for (const o of orders) {
        for (const item of inv.safeItems(o)) {
            const m = byProduct.get(String(item.shopify_product_id));
            if (!m) continue;
            const ordered = parseInt(item.quantity, 10) || 0;
            const key = lineKeyOf(item);
            const already = sent.get(`${o.shopify_id}|${key}`) || 0;
            const qty = ordered - already;
            if (qty <= 0) continue;
            const { color, size } = splitVariant(item.variant);
            out.push({
                order_shopify_id: String(o.shopify_id),
                order_number: o.order_number,
                order_date: o.created_at,
                payment: /PAID/i.test(o.financial_status || '') && !/PARTIAL/i.test(o.financial_status || '') ? 'Prepaid' : 'COD',
                line_key: key,
                shopify_product_id: item.shopify_product_id || null,
                shopify_variant_id: item.shopify_variant_id || null,
                title: item.title,
                variant: item.variant,
                color, size, qty, ordered, already_sent: already,
                product_type: m.product_type,
                fabric: m.fabric || '',
                design_file: designFileFor(m, color),
            });
        }
    }
    return out;
}

/**
 * Turn the chosen lines into a batch. Locked so two people exporting at the same moment can't both
 * take the same line: the second sees it already sent and gets only what is left.
 */
async function createBatch({ lines, user, note }) {
    const wanted = new Set((lines || []).map(l => `${l.order_shopify_id}|${l.line_key}`));
    if (!wanted.size) throw Object.assign(new Error('Pick at least one line to send'), { status: 400 });

    return db.transaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('myxture_batch'))");
        const ready = (await readyLines({ client })).filter(l => wanted.has(`${l.order_shopify_id}|${l.line_key}`));
        if (!ready.length) {
            throw Object.assign(new Error('These lines have already been sent to Myxture'), { status: 409 });
        }
        const no = (await client.query('SELECT COALESCE(MAX(batch_no), 0) + 1 AS n FROM myxture_batches')).rows[0].n;
        const b = (await client.query(
            `INSERT INTO myxture_batches (batch_no, source, note, created_by) VALUES ($1, 'export', $2, $3) RETURNING *`,
            [no, note || null, user])).rows[0];
        for (const l of ready) await insertLine(client, b.id, l);
        return { batch: b, ref: batchRef(no), lines: ready.length, units: ready.reduce((s, l) => s + l.qty, 0),
            skipped: wanted.size - ready.length };
    });
}

function insertLine(client, batchId, l) {
    return client.query(
        `INSERT INTO myxture_batch_lines (batch_id, order_shopify_id, order_number, line_key, shopify_product_id,
            shopify_variant_id, title, variant, color, size, qty, product_type, fabric, design_file)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [batchId, l.order_shopify_id, l.order_number, l.line_key, l.shopify_product_id, l.shopify_variant_id,
            l.title, l.variant, l.color, l.size, l.qty, l.product_type, l.fabric, l.design_file]);
}

/* ------------------------------------------------------------------------------------------ */

const STATUS_SQL = `
    CASE WHEN b.voided_at IS NOT NULL THEN 'Voided'
         WHEN COUNT(l.id) FILTER (WHERE l.received_at IS NULL) = 0 THEN 'Received'
         WHEN COUNT(l.id) FILTER (WHERE l.received_at IS NOT NULL) > 0 THEN 'Partly received'
         ELSE 'Sent' END`;

async function listBatches({ limit = 50, offset = 0 } = {}) {
    const r = await db.query(
        `SELECT b.*, COUNT(l.id)::int AS lines, COALESCE(SUM(l.qty),0)::int AS units,
                COUNT(DISTINCT l.order_shopify_id)::int AS orders,
                COALESCE(SUM(l.received_qty),0)::int AS received_units,
                COUNT(l.id) FILTER (WHERE l.received_at IS NOT NULL AND l.received_qty < l.qty)::int AS short_lines,
                ${STATUS_SQL} AS status
           FROM myxture_batches b LEFT JOIN myxture_batch_lines l ON l.batch_id = b.id
          GROUP BY b.id ORDER BY b.batch_no DESC LIMIT $1 OFFSET $2`, [limit, offset]);
    const total = (await db.query('SELECT COUNT(*)::int AS n FROM myxture_batches')).rows[0].n;
    return { batches: r.rows.map(b => ({ ...b, ref: batchRef(b.batch_no) })), total };
}

async function getBatch(id) {
    const b = (await db.query(
        `SELECT b.*, ${STATUS_SQL} AS status FROM myxture_batches b
           LEFT JOIN myxture_batch_lines l ON l.batch_id = b.id WHERE b.id = $1 GROUP BY b.id`, [id])).rows[0];
    if (!b) return null;
    const lines = (await db.query(
        `SELECT l.*, o.cancelled_at, o.financial_status, o.fulfillment_status
           FROM myxture_batch_lines l LEFT JOIN orders o ON o.shopify_id = l.order_shopify_id
          WHERE l.batch_id = $1`, [id])).rows;
    lines.sort(fileOrder);
    return { ...b, ref: batchRef(b.batch_no), lines };
}

// Newest order first, as the portal sheet was filled in; within an order, the order's own line order.
function fileOrder(a, b) {
    const na = parseInt(plainOrderNo(a.order_number), 10) || 0;
    const nb = parseInt(plainOrderNo(b.order_number), 10) || 0;
    return nb - na || a.id - b.id;
}

const fileRows = (lines) => lines.map(l => [
    plainOrderNo(l.order_number), l.product_type || '', l.fabric || '', l.size || '', l.qty, SHIPPING,
    l.design_file || '', '', '', '', '', '', '', '', '', '', '', '',
]);

async function batchXlsx(batch) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(SHEET_NAME);
    ws.addRow(COLUMNS);
    ws.getRow(1).font = { bold: true };
    for (const row of fileRows(batch.lines)) {
        const r = ws.addRow(row);
        // The portal reads order numbers as numbers; keep them so rather than as text.
        const n = Number(row[0]);
        if (Number.isFinite(n) && row[0] !== '') r.getCell(1).value = n;
    }
    ws.columns.forEach((c, i) => { c.width = Math.max(10, COLUMNS[i].length + 4); });
    ws.getColumn(2).width = 26;
    ws.getColumn(3).width = 16;
    ws.getColumn(7).width = 18;
    return wb.xlsx.writeBuffer();
}

function batchCsv(batch) {
    const cols = COLUMNS.map((label, i) => ({ key: i, label }));
    return toCsv(fileRows(batch.lines).map(r => ({ ...r })), cols);
}

const fileName = (batch, ext) => `${batch.ref} Myxture bulk order.${ext}`;

/* ------------------------------------------------------------------------------------------ */

async function voidBatch(id, user) {
    const b = (await db.query('SELECT * FROM myxture_batches WHERE id = $1', [id])).rows[0];
    if (!b) throw Object.assign(new Error('Batch not found'), { status: 404 });
    if (b.voided_at) throw Object.assign(new Error('Already voided'), { status: 400 });
    const rec = (await db.query(
        'SELECT COUNT(*)::int AS n FROM myxture_batch_lines WHERE batch_id = $1 AND received_at IS NOT NULL', [id])).rows[0].n;
    if (rec) throw Object.assign(new Error('Part of this batch has been received, so it was sent — it can no longer be voided'), { status: 400 });
    await db.query('UPDATE myxture_batches SET voided_at = NOW(), voided_by = $2 WHERE id = $1', [id, user]);
}

/**
 * Record what arrived. Each entry: { id, received_qty, qc_note }; a null received_qty undoes the
 * receipt (a line ticked by mistake).
 */
async function receiveLines(batchId, entries, user) {
    const b = (await db.query('SELECT voided_at FROM myxture_batches WHERE id = $1', [batchId])).rows[0];
    if (!b) throw Object.assign(new Error('Batch not found'), { status: 404 });
    if (b.voided_at) throw Object.assign(new Error('This batch was voided'), { status: 400 });
    for (const e of entries || []) {
        const id = parseInt(e.id, 10);
        if (!id) continue;
        if (e.received_qty === null || e.received_qty === '' || e.received_qty === undefined) {
            await db.query(
                `UPDATE myxture_batch_lines SET received_qty = NULL, received_at = NULL, received_by = NULL, qc_note = $3
                  WHERE id = $1 AND batch_id = $2`, [id, batchId, e.qc_note || null]);
            continue;
        }
        const qty = Math.max(0, parseInt(e.received_qty, 10) || 0);
        await db.query(
            `UPDATE myxture_batch_lines
                SET received_qty = $3, qc_note = $4, received_by = $5,
                    received_at = COALESCE(received_at, NOW())
              WHERE id = $1 AND batch_id = $2`, [id, batchId, qty, e.qc_note || null, user]);
    }
}

/**
 * Sent lines whose order changed under them: cancelled, refunded or voided, or cut to fewer
 * pieces than were sent. Myxture is already making these, so somebody has to act on the portal.
 */
async function attentionLines() {
    const r = await db.query(
        `SELECT l.*, b.batch_no, o.cancelled_at, o.financial_status, o.line_items_json
           FROM myxture_batch_lines l
           JOIN myxture_batches b ON b.id = l.batch_id AND b.voided_at IS NULL
           LEFT JOIN orders o ON o.shopify_id = l.order_shopify_id
          WHERE l.attention_cleared_at IS NULL
          ORDER BY b.batch_no DESC`);
    const sentTotals = new Map();
    for (const l of r.rows) {
        const k = `${l.order_shopify_id}|${l.line_key}`;
        sentTotals.set(k, (sentTotals.get(k) || 0) + l.qty);
    }
    const out = [];
    for (const l of r.rows) {
        let reason = null;
        if (!l.line_items_json) reason = null;          // order not in the sync window — can't tell
        else if (l.cancelled_at) reason = 'Order cancelled';
        else if (/^(REFUNDED|VOIDED)$/i.test(l.financial_status || '')) reason = `Order ${String(l.financial_status).toLowerCase()}`;
        else {
            const item = inv.safeItems(l).find(i => lineKeyOf(i) === l.line_key);
            const now = item ? (parseInt(item.quantity, 10) || 0) : 0;
            const sent = sentTotals.get(`${l.order_shopify_id}|${l.line_key}`) || 0;
            if (now < sent) reason = now === 0 ? 'Item removed from the order' : `Order now has ${now}, ${sent} sent`;
        }
        if (!reason) continue;
        const { line_items_json, ...rest } = l;
        out.push({ ...rest, ref: batchRef(l.batch_no), reason });
    }
    return out;
}

async function clearAttention(lineId, user) {
    await db.query(
        'UPDATE myxture_batch_lines SET attention_cleared_at = NOW(), attention_cleared_by = $2 WHERE id = $1',
        [lineId, user]);
}

async function stats() {
    const ready = await readyLines();
    const s = (await db.query(
        `SELECT
            COALESCE(SUM(l.qty) FILTER (WHERE b.created_at >= date_trunc('week', NOW())),0)::int AS week_units,
            COUNT(DISTINCT l.order_shopify_id) FILTER (WHERE b.created_at >= date_trunc('week', NOW()))::int AS week_orders,
            COALESCE(SUM(l.qty) FILTER (WHERE b.created_at >= date_trunc('month', NOW())),0)::int AS month_units,
            COUNT(DISTINCT l.order_shopify_id) FILTER (WHERE b.created_at >= date_trunc('month', NOW()))::int AS month_orders,
            COALESCE(SUM(l.qty),0)::int AS total_units,
            COUNT(DISTINCT l.order_shopify_id)::int AS total_orders,
            COALESCE(SUM(l.qty) FILTER (WHERE l.received_at IS NULL),0)::int AS awaiting_units,
            COALESCE(SUM(l.qty) FILTER (WHERE l.received_at IS NULL AND b.created_at < NOW() - INTERVAL '${OVERDUE_DAYS} days'),0)::int AS overdue_units,
            COALESCE(SUM(l.received_qty),0)::int AS received_units,
            COUNT(l.id) FILTER (WHERE l.received_at IS NOT NULL AND l.received_qty < l.qty)::int AS short_lines
           FROM myxture_batch_lines l JOIN myxture_batches b ON b.id = l.batch_id
          WHERE b.voided_at IS NULL`)).rows[0];
    const attention = await attentionLines();
    return {
        ready_lines: ready.length,
        ready_units: ready.reduce((n, l) => n + l.qty, 0),
        ready_orders: new Set(ready.map(l => l.order_shopify_id)).size,
        ...s,
        attention: attention.length,
        overdue_days: OVERDUE_DAYS,
    };
}

module.exports = {
    COLUMNS, SHIPPING, SHEET_NAME, batchRef, plainOrderNo, splitVariant, designFileFor, lineKeyOf, normSize,
    mappings, productIds, readyLines, createBatch, insertLine, listBatches, getBatch, batchXlsx, batchCsv, fileName,
    voidBatch, receiveLines, attentionLines, clearAttention, stats, fileOrder,
};
