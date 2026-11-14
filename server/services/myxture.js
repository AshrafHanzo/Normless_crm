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

const SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL', '7XL', '8XL'];
const SIZE_ALIASES = { XXL: '2XL', XXXL: '3XL', XXXXL: '4XL' };
const normSize = (s) => {
    const u = String(s || '').trim().toUpperCase().replace(/\s+/g, '');
    return SIZE_ALIASES[u] || u;
};
// Any NXL counts, so a new extended size (Shopify already sells 6XL) never lands in the sheet blank.
const isSize = (s) => SIZE_ORDER.includes(normSize(s)) || /^[2-9]XL$/.test(normSize(s));

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
 * fulfilled, cancelled, refunded, voided or on hold — and both COD and prepaid count. Influencer
 * seeding and offline sales that hold a Myxture product come in on their own, the same way.
 */
async function readyLines({ client = db, from, to, rto = false } = {}) {
    const maps = await mappings();
    const jobs = [
        () => manualReadyLines({ client, from, to }),
        () => maps.length ? shopCandidates(client, maps, { from, to }) : [],
        () => maps.length ? marketingCandidates(client, maps) : [],
        () => maps.length ? offlineCandidates(client, maps) : [],
    ];
    // A transaction's single connection takes one query at a time; the pool can take them together.
    const [manual, ...rest] = client === db ? await Promise.all(jobs.map(j => j()))
        : await jobs.reduce(async (acc, j) => [...await acc, await j()], Promise.resolve([]));
    const lines = [...manual, ...await finishLines(client, maps, rest.flat())];
    return rto ? withRto(lines) : lines;
}

// Where a line came from. Store orders are keyed by their Shopify id; seeding and offline sales
// by a prefix, so they can never collide with one and are told apart everywhere else.
const MKT = 'mkt:';
const OFF = 'off:';
const sourceOf = (orderId) => String(orderId).startsWith(MKT) ? 'Marketing'
    : String(orderId).startsWith(OFF) ? 'Offline'
        : String(orderId).startsWith('manual:') ? 'Manual' : 'Store';

/** Open store orders that hold a Myxture product, one candidate per order line. */
async function shopCandidates(client, maps, { from, to }) {
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
    vals.push(maps.map(m => `%${m.shopify_product_id}%`));
    where.push(`o.line_items_json LIKE ANY($${vals.length})`);
    const orders = (await client.query(
        `SELECT o.shopify_id, o.order_number, o.financial_status, o.created_at, o.line_items_json,
                TO_CHAR(o.created_at, 'YYYY-MM-DD"T"HH24:MI') AS order_at
           FROM orders o WHERE ${where.join(' AND ')}
          ORDER BY o.created_at DESC`, vals)).rows;
    const out = [];
    for (const o of orders) {
        const payment = /PAID/i.test(o.financial_status || '') && !/PARTIAL/i.test(o.financial_status || '') ? 'Prepaid' : 'COD';
        for (const item of inv.safeItems(o)) {
            out.push({
                order_shopify_id: String(o.shopify_id), order_number: o.order_number, order_date: o.created_at,
                order_at: o.order_at, payment, source: 'Store', item,
            });
        }
    }
    return out;
}

// Seeding that is still to go out. Pending approval is in on purpose: Myxture takes two or three
// days, so a parcel waiting on sign-off is worth ordering now — the status shows on the line.
const SEEDING_OPEN = ['Pending Approval', 'Dispatch Pending'];
// An offline sale that's been agreed but not sent. A draft isn't a sale yet.
const OFFLINE_OPEN = ['Confirmed', 'In Production'];

const safeJson = (v) => { try { return (typeof v === 'string' ? JSON.parse(v || '[]') : v) || [] } catch { return [] } };
const asItem = (it) => ({
    shopify_product_id: it.shopify_product_id, shopify_variant_id: it.shopify_variant_id,
    title: it.product || it.title, variant: it.variant, quantity: it.qty ?? it.quantity,
});

async function marketingCandidates(client, maps) {
    const rows = (await client.query(
        `SELECT id, ref_no, name, status, items, created_at,
                TO_CHAR(created_at, 'YYYY-MM-DD"T"HH24:MI') AS order_at
           FROM marketing_orders WHERE status = ANY($1) AND items LIKE ANY($2)`,
        [SEEDING_OPEN, maps.map(m => `%${m.shopify_product_id}%`)])).rows;
    const out = [];
    for (const r of rows) {
        const ref = r.ref_no ? `M${String(r.ref_no).padStart(3, '0')}` : `M#${r.id}`;
        for (const it of safeJson(r.items)) {
            out.push({
                order_shopify_id: `${MKT}${r.id}`, order_number: ref, order_date: r.created_at, order_at: r.order_at,
                payment: 'Marketing', source: 'Marketing', status: r.status, party: r.name, item: asItem(it),
            });
        }
    }
    return out;
}

async function offlineCandidates(client, maps) {
    const rows = (await client.query(
        `SELECT id, sale_no, customer_name, status, items, created_at,
                TO_CHAR(created_at, 'YYYY-MM-DD"T"HH24:MI') AS order_at
           FROM offline_sales WHERE status = ANY($1) AND items LIKE ANY($2)`,
        [OFFLINE_OPEN, maps.map(m => `%${m.shopify_product_id}%`)])).rows;
    const out = [];
    for (const r of rows) {
        const ref = r.sale_no ? `OS${String(r.sale_no).padStart(4, '0')}` : `OS#${r.id}`;
        for (const it of safeJson(r.items)) {
            out.push({
                order_shopify_id: `${OFF}${r.id}`, order_number: ref, order_date: r.created_at, order_at: r.order_at,
                payment: 'Offline', source: 'Offline', status: r.status, party: r.customer_name, item: asItem(it),
            });
        }
    }
    return out;
}

/**
 * Candidates into ready lines: only Myxture products, minus what was deleted here, with changes
 * made here applied, and less whatever has already gone in a batch.
 */
async function finishLines(client, maps, candidates) {
    const byProduct = new Map(maps.map(m => [String(m.shopify_product_id), m]));
    const mine = candidates.filter(c => byProduct.has(String(c.item.shopify_product_id)));
    if (!mine.length) return [];
    const orderIds = [...new Set(mine.map(c => c.order_shopify_id))];
    const sent = await sentLinesByOrder(client, orderIds);
    const removed = await removedKeys(client, orderIds);
    const edits = await overridesFor(client, orderIds);
    const allMaps = new Map((await mappings({ activeOnly: false })).map(m => [String(m.shopify_product_id), m]));
    const out = [];
    for (const c of mine) {
        const { item } = c;
        const key = lineKeyOf(item);
        if (removed.has(`${c.order_shopify_id}|${key}`)) continue;
        // Changed here before sending — a size swap the customer asked for, say. The change
        // replaces what the order says until the line goes into a batch.
        const ov = edits.get(`${c.order_shopify_id}|${key}`);
        const pid = ov ? String(ov.shopify_product_id) : String(item.shopify_product_id);
        const m = allMaps.get(pid) || byProduct.get(String(item.shopify_product_id));
        const variant = ov ? ov.variant : item.variant;
        const ordered = ov?.qty ?? (parseInt(item.quantity, 10) || 0);
        const already = sentFor(sent.get(c.order_shopify_id), key);
        const qty = ordered - already;
        if (qty <= 0) continue;
        const { color, size } = splitVariant(variant);
        const { item: _item, ...base } = c;
        out.push({
            ...base,
            line_key: key,
            shopify_product_id: ov ? ov.shopify_product_id : (item.shopify_product_id || null),
            shopify_variant_id: ov ? ov.shopify_variant_id : (item.shopify_variant_id || null),
            title: ov?.title || item.title,
            variant,
            edited: ov ? { by: ov.updated_by, at: ov.updated_at, from: item.variant, from_qty: parseInt(item.quantity, 10) || 0, note: ov.note } : null,
            note: ov?.note || null,
            color, size, qty, ordered, already_sent: already,
            product_type: m.product_type,
            fabric: m.fabric || '',
            design_file: designFileFor(m, color),
        });
    }
    return out;
}

/**
 * Seeding and offline sales used to be typed in as manual lines. Now they come in on their own, a
 * manual line for one would be the same jersey twice — so each is folded into the order it was
 * for: anything already sent is re-pointed at that order's line (so it counts as sent there), and
 * the manual line goes. Only on an exact match of order, product and size; anything else is left.
 */
async function linkManualLines() {
    const manual = (await db.query(
        `SELECT * FROM myxture_manual_lines WHERE deleted_at IS NULL AND source IN ('Marketing','Offline')`)).rows;
    let linked = 0;
    for (const m of manual) {
        const mk = /^M0*(\d+)/i.exec(m.order_ref || '');
        const os = /^OS0*(\d+)/i.exec(m.order_ref || '');
        const order = mk ? (await db.query('SELECT id, items FROM marketing_orders WHERE ref_no = $1', [mk[1]])).rows[0]
            : os ? (await db.query('SELECT id, items FROM offline_sales WHERE sale_no = $1', [os[1]])).rows[0] : null;
        if (!order) continue;
        const item = safeJson(order.items).map(asItem).find(i =>
            String(i.shopify_product_id) === String(m.shopify_product_id)
            && (m.shopify_variant_id && i.shopify_variant_id
                ? String(i.shopify_variant_id) === String(m.shopify_variant_id)
                : inv.normVariant(i.variant) === inv.normVariant(m.variant)));
        if (!item) continue;
        const orderId = `${mk ? MKT : OFF}${order.id}`;
        await db.transaction(async (c) => {
            await c.query('UPDATE myxture_batch_lines SET order_shopify_id = $1, line_key = $2 WHERE order_shopify_id = $3',
                [orderId, lineKeyOf(item), manualKey(m.id)]);
            await c.query(`UPDATE myxture_manual_lines SET deleted_at = NOW(), deleted_by = $2 WHERE id = $1`,
                [m.id, `linked to ${m.order_ref}`]);
        });
        linked++;
    }
    if (linked) console.log(`Myxture: ${linked} manual lines folded into their seeding / offline orders`);
    return linked;
}

/* ------------------------------------------ RTO shelf ------------------------------------------ */

/**
 * The same jersey came back on an RTO and is sitting on our shelf: sending that piece saves
 * ordering a new one. `rto` on a line is what the shelf holds for that design, colour and size —
 * shared, not reserved, so two orders for it both see it.
 */
async function withRto(lines) {
    let shelf = [];
    try { shelf = await inv.rtoAvailable(); } catch { return lines; }
    if (!shelf.length) return lines;
    const index = inv.availabilityIndex(shelf);
    return lines.map(l => {
        const hit = inv.matchLine({ shopify_variant_id: l.shopify_variant_id, shopify_product_id: l.shopify_product_id, variant: l.variant }, index);
        return hit ? { ...l, rto: { available: hit.available, since: hit.oldest } } : l;
    });
}

/**
 * Fill a ready line from the RTO shelf instead of Myxture: the pieces leave the shelf against this
 * order, and the line comes off Ready (or drops to what's still needed).
 */
async function fillFromRto(body, user) {
    const orderId = String(body.order_shopify_id || '');
    const key = String(body.line_key || '');
    const line = (await readyLines()).find(l => l.order_shopify_id === orderId && l.line_key === key);
    if (!line) throw bad('That line is no longer waiting', 409);
    const rows = (await db.query(
        `SELECT id, variant_id, shopify_product_id, variant, qty - qty_used - qty_written_off AS left
           FROM inventory_rto WHERE qty - qty_used - qty_written_off > 0 ORDER BY created_at ASC`)).rows
        .filter(r => line.shopify_variant_id && r.variant_id
            ? String(r.variant_id) === String(line.shopify_variant_id)
            : String(r.shopify_product_id) === String(line.shopify_product_id)
                && inv.normVariant(r.variant) === inv.normVariant(line.variant));
    let want = Math.min(parseInt(body.qty, 10) || line.qty, line.qty);
    let taken = 0;
    let piece = null;
    for (const r of rows) {
        if (want <= 0) break;
        const n = Math.min(want, r.left);
        const res = await inv.takeRtoPiece(r.id, n, line.order_number, 'Sent instead of a Myxture print', user);
        if (res.error) continue;
        piece = piece || { id: r.id, variant_id: r.variant_id, product_title: line.title, variant: line.variant };
        taken += n; want -= n;
    }
    if (!taken) throw bad('Nothing left on the RTO shelf for this one', 409);

    if (line.manual) {
        const left = line.ordered - taken;
        if (left <= line.already_sent) await deleteManualLine(line.manual_id, user);
        else await db.query('UPDATE myxture_manual_lines SET qty = $2, updated_by = $3, updated_at = NOW() WHERE id = $1', [line.manual_id, left, user]);
    } else if (taken >= line.qty) {
        await removeReadyLine({ ...line, reason: `Sent from the RTO shelf (${taken})` }, user);
    } else {
        // Part of it from the shelf: the rest still goes to Myxture.
        await db.query(
            `INSERT INTO myxture_overrides (order_shopify_id, line_key, shopify_product_id, shopify_variant_id, title, variant, qty, note, updated_by, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
             ON CONFLICT (order_shopify_id, line_key) DO UPDATE SET qty = excluded.qty, note = excluded.note,
                updated_by = excluded.updated_by, updated_at = NOW()`,
            [orderId, key, line.shopify_product_id, line.shopify_variant_id, line.title, line.variant,
                line.ordered - taken, `${taken} sent from the RTO shelf`, user]);
    }
    // The Inventory page's "you already have this one" notice for the order is answered too.
    if (line.source === 'Store') { try { await inv.resolveAlertsForOrder(line.order_number, piece, user); } catch { /* best effort */ } }
    return { taken, rest: line.qty - taken };
}

/** Non-voided batch lines for these orders, grouped by order. */
async function sentLinesByOrder(client, orderIds) {
    const r = await client.query(
        `SELECT l.order_shopify_id, l.line_key, l.shopify_variant_id, l.qty
           FROM myxture_batch_lines l JOIN myxture_batches b ON b.id = l.batch_id
          WHERE b.voided_at IS NULL AND l.order_shopify_id = ANY($1)`, [orderIds]);
    const by = new Map();
    for (const x of r.rows) {
        if (!by.has(x.order_shopify_id)) by.set(x.order_shopify_id, []);
        by.get(x.order_shopify_id).push(x);
    }
    return by;
}

/**
 * How much of an order line has gone. A sent line counts against it by the key it was sent under
 * or by the variant it was changed to, so a size changed here and then also in Shopify is still
 * one piece sent, not one sent and one waiting.
 */
const sentFor = (lines, key) => (lines || [])
    .filter(l => l.line_key === key || String(l.shopify_variant_id || '') === key)
    .reduce((n, l) => n + l.qty, 0);

async function removedKeys(client, orderIds) {
    const r = await client.query(
        'SELECT order_shopify_id, line_key FROM myxture_removed WHERE order_shopify_id = ANY($1)', [orderIds]);
    return new Set(r.rows.map(x => `${x.order_shopify_id}|${x.line_key}`));
}

async function overridesFor(client, orderIds) {
    const r = await client.query('SELECT * FROM myxture_overrides WHERE order_shopify_id = ANY($1)', [orderIds]);
    return new Map(r.rows.map(x => [`${x.order_shopify_id}|${x.line_key}`, x]));
}

/* --------------------------------------- manual lines --------------------------------------- */

// Orders that never came through the Shopify store — influencer seeding, offline sales — added by
// hand. They go through the same batches, keyed `manual:<id>`, so they can't be sent twice either.
// Seeding and offline sales come in on their own now (see marketingCandidates), so they're no
// longer offered here — adding one by hand as well would put it on the list twice.
const MANUAL_SOURCES = ['Replacement', 'Other'];
const manualKey = (id) => `manual:${id}`;

async function manualReadyLines({ client = db, from, to } = {}) {
    const where = ['m.deleted_at IS NULL'];
    const vals = [];
    if (from) { vals.push(from); where.push(`m.created_at::date >= $${vals.length}`); }
    if (to) { vals.push(to); where.push(`m.created_at::date <= $${vals.length}`); }
    const rows = (await client.query(
        `SELECT m.*, p.product_type, p.fabric, p.design_file,
                TO_CHAR(m.created_at, 'YYYY-MM-DD"T"HH24:MI') AS order_at
           FROM myxture_manual_lines m
           JOIN myxture_products p ON p.shopify_product_id = m.shopify_product_id AND p.active = true
          WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC`, vals)).rows;
    if (!rows.length) return [];
    const sent = await sentIndex(client, rows.map(r => manualKey(r.id)));
    const out = [];
    for (const r of rows) {
        const already = sent.get(`${manualKey(r.id)}|manual`) || 0;
        const qty = r.qty - already;
        if (qty <= 0) continue;
        const { color, size } = splitVariant(r.variant);
        out.push({
            order_shopify_id: manualKey(r.id),
            order_number: r.order_ref,
            order_date: r.created_at,
            order_at: r.order_at,
            payment: r.source || 'Manual',
            source: 'Manual',
            manual: true, manual_id: r.id, note: r.note, created_by: r.created_by,
            line_key: 'manual',
            shopify_product_id: r.shopify_product_id, shopify_variant_id: r.shopify_variant_id,
            title: r.title, variant: r.variant,
            color, size, qty, ordered: r.qty, already_sent: already,
            product_type: r.product_type || '',
            fabric: r.fabric || '',
            design_file: r.design_file ? designFileFor(r, color) : '',
        });
    }
    return out;
}

async function addManualLine(body, user) {
    const ref = String(body.order_ref || '').trim();
    const qty = parseInt(body.qty, 10) || 0;
    const pid = String(body.shopify_product_id || '').replace(/\D/g, '');
    if (!ref) throw Object.assign(new Error('Give it a reference, e.g. the influencer or the offline sale number'), { status: 400 });
    if (!pid) throw Object.assign(new Error('Pick the product'), { status: 400 });
    if (qty <= 0) throw Object.assign(new Error('Quantity must be at least 1'), { status: 400 });
    const m = (await db.query('SELECT 1 FROM myxture_products WHERE shopify_product_id = $1', [pid])).rows[0];
    if (!m) throw Object.assign(new Error('That product is not set up as a Myxture product'), { status: 400 });
    const { size } = splitVariant(body.variant);
    if (!size) throw Object.assign(new Error('Pick the size'), { status: 400 });
    const source = MANUAL_SOURCES.includes(body.source) ? body.source : 'Other';
    const r = await db.query(
        `INSERT INTO myxture_manual_lines (order_ref, source, shopify_product_id, shopify_variant_id, title, variant, qty, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [ref, source, pid, String(body.shopify_variant_id || '').replace(/\D/g, '') || null,
            body.title || null, String(body.variant || '').trim(), qty, String(body.note || '').trim() || null, user]);
    return r.rows[0];
}

/** Only while nothing of it has gone — after that it lives in a batch and is voided there. */
async function deleteManualLine(id, user) {
    const sent = await sentIndex(db, [manualKey(id)]);
    if (sent.get(`${manualKey(id)}|manual`)) {
        throw Object.assign(new Error('Already sent to Myxture — void its batch instead'), { status: 400 });
    }
    await db.query('UPDATE myxture_manual_lines SET deleted_at = NOW(), deleted_by = $2 WHERE id = $1', [id, user]);
}

/* -------------------------------------- edit and remove -------------------------------------- */

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

/** The product and variant a line is changed to, checked against what Myxture makes. */
async function resolveTarget(body) {
    const pid = String(body.shopify_product_id || '').replace(/\D/g, '');
    if (!pid) throw bad('Pick the product');
    const m = (await db.query('SELECT * FROM myxture_products WHERE shopify_product_id = $1', [pid])).rows[0];
    if (!m) throw bad('That product is not set up as a Myxture product');
    const variant = String(body.variant || '').trim();
    const { color, size } = splitVariant(variant);
    if (!size) throw bad('Pick the size');
    const qty = parseInt(body.qty, 10);
    if (!(qty > 0)) throw bad('Quantity must be at least 1');
    return {
        pid, mapping: m, variant, color, size, qty,
        vid: String(body.shopify_variant_id || '').replace(/\D/g, '') || null,
        title: String(body.title || m.title || '').trim() || null,
        note: String(body.note || '').trim() || null,
    };
}

/** Change a Shopify line that hasn't been sent: size, colour or quantity, before it goes. */
async function editReadyLine(body, user) {
    const order = String(body.order_shopify_id || '');
    const key = String(body.line_key || '');
    if (!order || !key || order.startsWith('manual:')) throw bad('Pick an order line');
    const t = await resolveTarget(body);
    await db.query(
        `INSERT INTO myxture_overrides (order_shopify_id, line_key, shopify_product_id, shopify_variant_id, title, variant, qty, note, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
         ON CONFLICT (order_shopify_id, line_key) DO UPDATE SET shopify_product_id = excluded.shopify_product_id,
            shopify_variant_id = excluded.shopify_variant_id, title = excluded.title, variant = excluded.variant,
            qty = excluded.qty, note = excluded.note, updated_by = excluded.updated_by, updated_at = NOW()`,
        [order, key, t.pid, t.vid, t.title, t.variant, t.qty, t.note, user]);
}

/** Undo a change made here, so the line follows Shopify again. */
async function clearReadyEdit(order, key) {
    await db.query('DELETE FROM myxture_overrides WHERE order_shopify_id = $1 AND line_key = $2', [order, key]);
}

async function editManualLine(id, body, user) {
    const sent = await sentLinesByOrder(db, [manualKey(id)]);
    if (sentFor(sent.get(manualKey(id)), 'manual')) throw bad('Already sent to Myxture — change it in its batch instead');
    const t = await resolveTarget(body);
    const ref = String(body.order_ref || '').trim();
    if (!ref) throw bad('Give it a reference');
    const source = MANUAL_SOURCES.includes(body.source) ? body.source : 'Other';
    await db.query(
        `UPDATE myxture_manual_lines SET order_ref = $2, source = $3, shopify_product_id = $4, shopify_variant_id = $5,
            title = $6, variant = $7, qty = $8, note = $9, updated_by = $10, updated_at = NOW()
          WHERE id = $1 AND deleted_at IS NULL`,
        [id, ref, source, t.pid, t.vid, t.title, t.variant, t.qty, t.note, user]);
}

/**
 * Take a store order line off Myxture's list for good — made some other way, or not wanted. Kept
 * as a record rather than deleted, so it can't quietly come back on the next sync.
 */
async function removeReadyLine(body, user) {
    const order = String(body.order_shopify_id || '');
    const key = String(body.line_key || '');
    if (order.startsWith('manual:')) return deleteManualLine(parseInt(order.slice(7), 10), user);
    if (!order || !key) throw bad('Pick a line');
    await db.query(
        `INSERT INTO myxture_removed (order_shopify_id, line_key, order_number, title, variant, qty, reason, removed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [order, key, body.order_number || null, body.title || null, body.variant || null,
            parseInt(body.qty, 10) || null, String(body.reason || '').trim() || null, user]);
    await clearReadyEdit(order, key);
}

/**
 * Change a line that has already gone — the customer changed their size after we sent it. The
 * portal has to be changed by hand too; this keeps our record (and the check-in) right, and keeps
 * what it said before.
 */
async function editBatchLine(batchId, lineId, body, user) {
    const l = (await db.query(
        `SELECT l.*, b.voided_at FROM myxture_batch_lines l JOIN myxture_batches b ON b.id = l.batch_id
          WHERE l.id = $1 AND l.batch_id = $2`, [lineId, batchId])).rows[0];
    if (!l) throw bad('Line not found', 404);
    if (l.voided_at) throw bad('This batch was voided');
    if (l.received_at) throw bad('Already received — undo the receipt first');
    const t = await resolveTarget(body);
    const was = { title: l.title, variant: l.variant, size: l.size, qty: l.qty, design_file: l.design_file };
    await db.query(
        `UPDATE myxture_batch_lines SET shopify_product_id = $3, shopify_variant_id = $4, title = $5, variant = $6,
            color = $7, size = $8, qty = $9, product_type = $10, fabric = $11, design_file = $12,
            original = COALESCE(original, $13), edited_by = $14, edited_at = NOW(),
            qc_note = COALESCE($15, qc_note)
          WHERE id = $1 AND batch_id = $2`,
        [lineId, batchId, t.pid, t.vid, t.title, t.variant, t.color, t.size, t.qty,
            t.mapping.product_type, t.mapping.fabric, designFileFor(t.mapping, t.color),
            JSON.stringify(was), user, t.note]);
}

/**
 * Take a line out of a batch — the order was cancelled after it went, say. It doesn't come back
 * as ready: a store line is recorded as removed, a manual one is deleted.
 */
async function removeBatchLine(batchId, lineId, body, user) {
    const l = (await db.query(
        `SELECT l.*, b.voided_at FROM myxture_batch_lines l JOIN myxture_batches b ON b.id = l.batch_id
          WHERE l.id = $1 AND l.batch_id = $2`, [lineId, batchId])).rows[0];
    if (!l) throw bad('Line not found', 404);
    if (l.voided_at) throw bad('This batch was voided');
    if (l.received_at) throw bad('Already received — undo the receipt first');
    await db.transaction(async (c) => {
        await c.query('DELETE FROM myxture_batch_lines WHERE id = $1', [lineId]);
        if (l.order_shopify_id.startsWith('manual:')) {
            await c.query('UPDATE myxture_manual_lines SET deleted_at = NOW(), deleted_by = $2 WHERE id = $1',
                [parseInt(l.order_shopify_id.slice(7), 10), user]);
        } else {
            await c.query(
                `INSERT INTO myxture_removed (order_shopify_id, line_key, order_number, title, variant, qty, reason, removed_by, batch_no)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,(SELECT batch_no FROM myxture_batches WHERE id = $9))`,
                [l.order_shopify_id, l.line_key, l.order_number, l.title, l.variant, l.qty,
                    String(body?.reason || '').trim() || null, user, batchId]);
        }
    });
}

/* ------------------------------------------ images ------------------------------------------ */

/**
 * Product photos, from the Shopify catalogue the rest of the CRM already caches for five minutes.
 * The variant's own photo where it has one (the colour being made), else the product's. Never
 * fatal: without Shopify the products still list, just without pictures.
 */
async function catalogue() {
    try {
        const products = await require('./shopify').fetchProducts();
        return products.map(p => ({
            id: String(p.id), title: p.title, image: p.image,
            variants: p.variants.map(v => ({ id: String(v.id), title: v.title, image: v.image, ...splitVariant(v.title) })),
        }));
    } catch {
        const rows = await inv.catalogue();
        return rows.map(p => ({
            id: String(p.shopify_id), title: p.title, image: null,
            variants: p.variants.map(v => ({ id: String(v.variant_id), title: v.variant, image: null, ...splitVariant(v.variant) })),
        }));
    }
}

async function imageIndex() {
    const byVariant = new Map();
    const byProduct = new Map();
    try {
        for (const p of await catalogue()) {
            if (p.image) byProduct.set(p.id, p.image);
            for (const v of p.variants) if (v.image) byVariant.set(v.id, v.image);
        }
    } catch { /* no pictures */ }
    return (pid, vid) => byVariant.get(String(vid || '')) || byProduct.get(String(pid || '')) || null;
}

async function withImages(rows) {
    const img = await imageIndex();
    return rows.map(r => ({ ...r, image: img(r.shopify_product_id, r.shopify_variant_id) }));
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
    return { ...b, ref: batchRef(b.batch_no), lines: await withImages(lines), sheet_rows: fileRows(lines) };
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
    // Seeding and offline sales aren't in the orders table: read their own status and items.
    const ids = (prefix) => [...new Set(r.rows.map(l => l.order_shopify_id)
        .filter(id => id.startsWith(prefix)).map(id => parseInt(id.slice(prefix.length), 10)))];
    const [mkt, off] = await Promise.all([
        db.query('SELECT id, status, items FROM marketing_orders WHERE id = ANY($1)', [ids(MKT)]),
        db.query('SELECT id, status, items FROM offline_sales WHERE id = ANY($1)', [ids(OFF)]),
    ]);
    const other = new Map([
        ...mkt.rows.map(x => [`${MKT}${x.id}`, x]), ...off.rows.map(x => [`${OFF}${x.id}`, x])]);
    for (const l of r.rows) {
        const o = other.get(l.order_shopify_id);
        if (!o) continue;
        l.line_items_json = JSON.stringify(safeJson(o.items).map(asItem));
        if (o.status === 'Cancelled') l.cancelled_at = true;
    }
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
            // By the key it went under, or the variant it was changed to since.
            const item = inv.safeItems(l).find(i => lineKeyOf(i) === l.line_key
                || (l.shopify_variant_id && lineKeyOf(i) === String(l.shopify_variant_id)));
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

/**
 * Drop inventory "unmapped" warnings for Myxture products — they're print-on-demand, there's no
 * blank on our shelf to map them to. The warning rows carry the product title, not its id.
 */
async function clearInventoryNoise() {
    try {
        const r = await db.query(
            `DELETE FROM inventory_unmapped u USING myxture_products m
              WHERE m.title IS NOT NULL AND u.product_title = m.title`);
        if (r.rowCount) console.log(`Myxture: cleared ${r.rowCount} inventory warnings for print-on-demand products`);
        return r.rowCount;
    } catch (err) {
        console.error('myxture clearInventoryNoise:', err.message);
        return 0;
    }
}

module.exports = {
    clearInventoryNoise,
    COLUMNS, SHIPPING, SHEET_NAME, batchRef, plainOrderNo, splitVariant, designFileFor, lineKeyOf, normSize,
    mappings, productIds, readyLines, createBatch, insertLine, listBatches, getBatch, batchXlsx, batchCsv, fileName,
    voidBatch, receiveLines, attentionLines, clearAttention, stats, fileOrder,
    MANUAL_SOURCES, addManualLine, deleteManualLine, catalogue, withImages,
    editReadyLine, clearReadyEdit, editManualLine, removeReadyLine, editBatchLine, removeBatchLine,
    fillFromRto, sourceOf, linkManualLines, SEEDING_OPEN, OFFLINE_OPEN,
};
