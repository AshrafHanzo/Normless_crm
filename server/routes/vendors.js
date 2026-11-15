/**
 * Purchasing — the vendor list shared by Normless and Crewfit.
 *
 * Three grants: `can_view_vendors` opens the pages, `can_edit_vendor_orders` adds and changes
 * vendors, and `can_record_vendor_payments` is needed to see or change bank details (the same
 * people who will pay them). Deleting is admin-only, and only for a vendor nothing points at yet —
 * otherwise archive.
 */

const express = require('express');
const db = require('../db/connection');
const { hasPermission } = require('../utils/permissions');
const { tableParams, pagination } = require('../utils/table');
const { refLabel } = require('../services/vendor-order');
const money = require('../services/vendor-money');

const router = express.Router();

router.param('id', (req, res, next, id) => (/^\d+$/.test(id) ? next() : res.status(404).json({ error: 'Not found' })));

router.use(async (req, res, next) => {
    try {
        if (!await hasPermission(req, 'can_view_vendors')) return res.status(403).json({ error: 'Access denied' });
        next();
    } catch (err) { next(err); }
});

const isAdmin = (req) => req.user?.role === 'owner' || req.user?.role === 'admin';
const canEdit = (req) => hasPermission(req, 'can_edit_vendor_orders');
const canSeeBank = (req) => hasPermission(req, 'can_record_vendor_payments');

const BRANDS = ['normless', 'crewfit', 'both'];
// Offered in the category picker until vendors have categories of their own; any typed value is
// kept too.
const DEFAULT_CATEGORIES = ['Blanks', 'Printing', 'Embroidery', '3D printing', 'Packaging', 'Labels & tags', 'Fabric'];

const BANK_FIELDS = ['bank_account_name', 'bank_account_no', 'bank_ifsc', 'bank_name', 'upi_id'];
const TEXT_FIELDS = ['contact_person', 'email', 'address', 'city', 'state', 'gstin', 'pan',
    'categories', 'payment_terms', 'notes'];

const SORTS = {
    name: 'LOWER(v.name)', categories: 'LOWER(v.categories)', brands: 'v.brands',
    orders: 'o.orders', ordered_value: 'o.ordered_value', last_order: 'o.last_order',
    paid: 'COALESCE(p.paid, 0)', balance: `${'COALESCE(o.due, 0) - (COALESCE(p.paid, 0) - COALESCE(p.allocated, 0))'}`,
};

/** Per-vendor roll-up of orders (both brands) and payments. */
const ORDER_ROLLUP = `
    LEFT JOIN (
        SELECT vendor_id, COUNT(*)::int AS orders,
               COUNT(*) FILTER (WHERE status <> 'Consignment Received')::int AS open_orders,
               SUM(COALESCE(total_override, total_amount)) AS ordered_value, SUM(total_qty)::int AS pieces,
               SUM(GREATEST(COALESCE(total_override, total_amount) - paid_amount, 0))
                   FILTER (WHERE COALESCE(total_override, total_amount) > 0) AS due,
               TO_CHAR(MAX(order_date), 'YYYY-MM-DD') AS last_order
        FROM vendor_orders WHERE vendor_id IS NOT NULL GROUP BY vendor_id
    ) o ON o.vendor_id = v.id
    LEFT JOIN (
        SELECT vp.vendor_id, SUM(vp.amount) AS paid,
               SUM((SELECT COALESCE(SUM(a.amount), 0) FROM vendor_payment_allocations a WHERE a.payment_id = vp.id)) AS allocated,
               TO_CHAR(MAX(vp.paid_on), 'YYYY-MM-DD') AS last_paid
        FROM vendor_payments vp GROUP BY vp.vendor_id
    ) p ON p.vendor_id = v.id`;

const LIST_COLUMNS = `v.id, v.name, v.contact_person, v.phone, v.city, v.gstin, v.categories, v.brands,
    v.active, v.whatsapp_updates, COALESCE(o.orders, 0) AS orders, COALESCE(o.open_orders, 0) AS open_orders,
    o.ordered_value, COALESCE(o.pieces, 0) AS pieces, o.last_order, COALESCE(p.paid, 0) AS paid, p.last_paid,
    COALESCE(o.due, 0) - (COALESCE(p.paid, 0) - COALESCE(p.allocated, 0)) AS balance`;

const clean = (v) => {
    const s = String(v ?? '').trim();
    return s ? s : null;
};
const upper = (v) => clean(v)?.toUpperCase().replace(/\s+/g, '') || null;

/** Shown in place of bank details to someone without the payments grant. */
const maskBank = (v) => ({
    ...Object.fromEntries(BANK_FIELDS.map(f => [f, null])),
    bank_on_file: !!(v.bank_account_no || v.upi_id),
    bank_last4: v.bank_account_no ? String(v.bank_account_no).slice(-4) : null,
});

/** Tidy and check an incoming vendor. Returns { error } or { row }. */
function readBody(body, { withBank }) {
    const name = clean(body.name);
    if (!name) return { error: 'Vendor name is required' };
    if (name.length > 120) return { error: 'Vendor name is too long' };

    const phone = String(body.phone ?? '').replace(/\D/g, '');
    if (phone && phone.length !== 10) return { error: 'Phone must be a 10-digit mobile number' };

    const row = { name, phone: phone || null };
    for (const f of TEXT_FIELDS) row[f] = clean(body[f]);
    row.gstin = upper(body.gstin);
    row.pan = upper(body.pan);
    row.brands = BRANDS.includes(body.brands) ? body.brands : 'both';
    row.whatsapp_updates = body.whatsapp_updates !== false;
    row.categories = (Array.isArray(body.categories) ? body.categories : String(body.categories || '').split(','))
        .map(c => String(c).trim()).filter(Boolean).filter((c, i, a) => a.findIndex(x => x.toLowerCase() === c.toLowerCase()) === i)
        .join(', ') || null;

    if (row.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) return { error: 'Email doesn’t look right' };
    if (row.gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/.test(row.gstin)) return { error: 'GSTIN should be 15 characters, like 33ABCDE1234F1Z5' };
    if (row.pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(row.pan)) return { error: 'PAN should be 10 characters, like ABCDE1234F' };

    if (withBank) {
        row.bank_account_name = clean(body.bank_account_name);
        row.bank_name = clean(body.bank_name);
        row.bank_account_no = String(body.bank_account_no ?? '').replace(/\s+/g, '') || null;
        row.bank_ifsc = upper(body.bank_ifsc);
        row.upi_id = clean(body.upi_id);
        if (row.bank_account_no && !/^\d{6,20}$/.test(row.bank_account_no)) return { error: 'Account number should be 6–20 digits' };
        if (row.bank_ifsc && !/^[A-Z]{4}0[A-Z\d]{6}$/.test(row.bank_ifsc)) return { error: 'IFSC should be 11 characters, like HDFC0001234' };
        if (row.upi_id && !/^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(row.upi_id)) return { error: 'UPI ID should look like name@bank' };
    }
    return { row };
}

const nameTaken = async (name, exceptId = null) => !!(await db.query(
    'SELECT 1 FROM vendors WHERE LOWER(name) = LOWER($1) AND ($2::int IS NULL OR id <> $2)', [name, exceptId])).rows[0];

// GET /api/vendors/meta — pick-lists and what this user may do
router.get('/meta', async (req, res) => {
    try {
        const used = (await db.query(`SELECT categories FROM vendors WHERE categories IS NOT NULL`)).rows
            .flatMap(r => r.categories.split(',').map(c => c.trim())).filter(Boolean);
        const seen = new Map();
        for (const c of [...DEFAULT_CATEGORIES, ...used]) if (!seen.has(c.toLowerCase())) seen.set(c.toLowerCase(), c);
        res.json({
            categories: [...seen.values()].sort((a, b) => a.localeCompare(b)),
            brands: BRANDS,
            can: { edit: await canEdit(req), bank: await canSeeBank(req), delete: isAdmin(req) },
        });
    } catch (err) {
        console.error('vendors meta:', err);
        res.status(500).json({ error: 'Failed to load options' });
    }
});

// GET /api/vendors?search&category&brand&status=active|archived|all
router.get('/', async (req, res) => {
    try {
        const { search, category, brand } = req.query;
        const status = ['archived', 'all'].includes(req.query.status) ? req.query.status : 'active';
        const t = tableParams(req.query, { sortable: SORTS, defaultSort: 'name', defaultDir: 'asc' });
        const where = [], vals = [];
        if (status !== 'all') where.push(`v.active = ${status === 'active'}`);
        if (search) {
            vals.push(`%${search}%`);
            const n = vals.length;
            where.push(`(v.name ILIKE $${n} OR v.contact_person ILIKE $${n} OR v.phone ILIKE $${n}
                         OR v.gstin ILIKE $${n} OR v.city ILIKE $${n})`);
        }
        if (category) { vals.push(`%${category}%`); where.push(`v.categories ILIKE $${vals.length}`); }
        // A vendor marked "both" serves either brand.
        if (BRANDS.includes(brand) && brand !== 'both') { vals.push(brand); where.push(`v.brands IN ($${vals.length}, 'both')`); }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

        const total = (await db.query(`SELECT COUNT(*)::int AS n FROM vendors v ${whereSql}`, vals)).rows[0].n;
        const rows = (await db.query(
            `SELECT ${LIST_COLUMNS} FROM vendors v ${ORDER_ROLLUP} ${whereSql}
             ${t.orderBy} LIMIT ${t.limit} OFFSET ${t.offset}`, vals)).rows;

        const summary = (await db.query(
            `SELECT COUNT(*) FILTER (WHERE v.active)::int AS active,
                    COUNT(*) FILTER (WHERE NOT v.active)::int AS archived,
                    COUNT(*) FILTER (WHERE v.active AND COALESCE(o.open_orders, 0) > 0)::int AS with_open_orders,
                    COUNT(*) FILTER (WHERE v.active AND v.phone IS NULL)::int AS missing_phone
             FROM vendors v ${ORDER_ROLLUP}`)).rows[0];

        res.json({ vendors: rows, summary, pagination: pagination(total, t) });
    } catch (err) {
        console.error('vendors list:', err);
        res.status(500).json({ error: 'Failed to load vendors' });
    }
});

const parseItems = (raw) => { try { return JSON.parse(raw || '[]'); } catch { return []; } };

// GET /api/vendors/:id — the profile: details, money, orders and payments
router.get('/:id', async (req, res) => {
    try {
        const v = (await db.query('SELECT * FROM vendors WHERE id = $1', [req.params.id])).rows[0];
        if (!v) return res.status(404).json({ error: 'Vendor not found' });
        const vendor = await canSeeBank(req) ? { ...v, bank_on_file: !!(v.bank_account_no || v.upi_id) } : { ...v, ...maskBank(v) };

        const orders = (await db.query(
            `SELECT o.id, o.ref_no, o.brand, TO_CHAR(o.order_date, 'YYYY-MM-DD') AS order_date,
                    TO_CHAR(o.delivery_date, 'YYYY-MM-DD') AS delivery_date, o.title, o.quote_ref, o.status, o.payment_status,
                    o.items, o.total_qty, ${money.TOTAL_SQL} AS total, o.paid_amount
             FROM vendor_orders o WHERE o.vendor_id = $1 ORDER BY o.order_date DESC, o.id DESC`, [v.id])).rows
            .map(o => {
                const total = Number(o.total) > 0 ? Number(o.total) : null;
                const paid = Number(o.paid_amount) || 0;
                return { ...o, items: parseItems(o.items), ref: refLabel(o), total, paid_amount: paid,
                    balance: total ? money.round2(total - paid) : null };
            });

        const payments = (await db.query(
            `SELECT p.id, TO_CHAR(p.paid_on, 'YYYY-MM-DD') AS paid_on, p.amount, p.mode, p.reference, p.note, p.source,
                    (p.proof_path IS NOT NULL) AS has_proof,
                    COALESCE((SELECT json_agg(json_build_object('order_id', o.id, 'ref_no', o.ref_no, 'amount', a.amount) ORDER BY o.id)
                              FROM vendor_payment_allocations a JOIN vendor_orders o ON o.id = a.order_id
                              WHERE a.payment_id = p.id), '[]') AS allocations
             FROM vendor_payments p WHERE p.vendor_id = $1 ORDER BY p.paid_on DESC, p.id DESC`, [v.id])).rows
            .map(p => ({
                ...p, amount: Number(p.amount),
                allocations: p.allocations.map(a => ({ ...a, amount: Number(a.amount), ref: refLabel(a) })),
                missing_reference: p.source === 'manual' && p.mode !== 'Cash' && !String(p.reference || '').trim(),
            }));

        const stats = {
            orders: orders.length,
            open_orders: orders.filter(o => o.status !== 'Consignment Received').length,
            unpriced_orders: orders.filter(o => !o.total).length,
            pieces: orders.reduce((s, o) => s + (Number(o.total_qty) || 0), 0),
            ...await money.vendorMoney(v.id),
        };
        res.json({ vendor, orders, payments, stats });
    } catch (err) {
        console.error('vendor profile:', err);
        res.status(500).json({ error: 'Failed to load vendor' });
    }
});

// GET /api/vendors/:id/statement — the running ledger: each priced order raises what is owed,
// each payment brings it down. Orders with no total are listed but move nothing.
router.get('/:id/statement', async (req, res) => {
    try {
        const v = (await db.query('SELECT id, name FROM vendors WHERE id = $1', [req.params.id])).rows[0];
        if (!v) return res.status(404).json({ error: 'Vendor not found' });
        const orders = (await db.query(
            `SELECT o.id, o.ref_no, o.brand, TO_CHAR(o.order_date, 'YYYY-MM-DD') AS date, o.title, o.quote_ref, o.items,
                    ${money.TOTAL_SQL} AS total, o.created_at
             FROM vendor_orders o WHERE o.vendor_id = $1`, [v.id])).rows;
        const payments = (await db.query(
            `SELECT p.id, TO_CHAR(p.paid_on, 'YYYY-MM-DD') AS date, p.amount, p.mode, p.reference, p.source, p.created_at,
                    COALESCE((SELECT string_agg('VO-' || LPAD(o.ref_no::text, 3, '0'), ', ' ORDER BY o.id)
                              FROM vendor_payment_allocations a JOIN vendor_orders o ON o.id = a.order_id
                              WHERE a.payment_id = p.id), '') AS against
             FROM vendor_payments p WHERE p.vendor_id = $1`, [v.id])).rows;

        const entries = [
            ...orders.map(o => {
                const items = parseItems(o.items).map(i => i.product_type).filter(Boolean).join(', ');
                return {
                    kind: 'order', id: o.id, date: o.date, at: o.created_at, ref: refLabel(o), brand: o.brand,
                    text: [o.title || items || 'Order', o.quote_ref ? `quote ${o.quote_ref}` : null].filter(Boolean).join(' · '),
                    billed: Number(o.total) > 0 ? Number(o.total) : null, paid: null,
                };
            }),
            ...payments.map(p => ({
                kind: 'payment', id: p.id, date: p.date, at: p.created_at, ref: p.reference || null, mode: p.mode,
                text: `Payment${p.mode ? ` · ${p.mode}` : ''}${p.against ? ` · for ${p.against}` : ' · on account'}`,
                billed: null, paid: Number(p.amount),
                missing_reference: p.source === 'manual' && p.mode !== 'Cash' && !String(p.reference || '').trim(),
            })),
        ].sort((a, b) => (a.date === b.date
            ? (a.kind === b.kind ? new Date(a.at) - new Date(b.at) : (a.kind === 'order' ? -1 : 1))
            : a.date.localeCompare(b.date)));

        let balance = 0;
        for (const e of entries) {
            balance = money.round2(balance + (e.billed || 0) - (e.paid || 0));
            e.balance = balance;
        }
        res.json({ vendor: v, entries, balance });
    } catch (err) {
        console.error('vendor statement:', err);
        res.status(500).json({ error: 'Failed to load the statement' });
    }
});

// POST /api/vendors
router.post('/', async (req, res) => {
    try {
        if (!await canEdit(req)) return res.status(403).json({ error: 'You can view vendors but not add them' });
        const { error, row } = readBody(req.body || {}, { withBank: await canSeeBank(req) });
        if (error) return res.status(400).json({ error });
        if (await nameTaken(row.name)) return res.status(409).json({ error: `${row.name} is already on the vendor list` });

        const cols = Object.keys(row);
        const r = await db.query(
            `INSERT INTO vendors (${cols.join(', ')}, created_by) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}, $${cols.length + 1})
             RETURNING id`, [...cols.map(c => row[c]), req.user?.username || null]);
        res.json({ success: true, id: r.rows[0].id });
    } catch (err) {
        console.error('vendor create:', err);
        res.status(500).json({ error: 'Failed to add vendor' });
    }
});

// PUT /api/vendors/:id
router.put('/:id', async (req, res) => {
    try {
        if (!await canEdit(req)) return res.status(403).json({ error: 'You can view vendors but not change them' });
        const existing = (await db.query('SELECT id, name FROM vendors WHERE id = $1', [req.params.id])).rows[0];
        if (!existing) return res.status(404).json({ error: 'Vendor not found' });
        // Without the payments grant the bank fields are never read from the request, so a form that
        // was shown them masked can't blank them out.
        const { error, row } = readBody(req.body || {}, { withBank: await canSeeBank(req) });
        if (error) return res.status(400).json({ error });
        if (await nameTaken(row.name, existing.id)) return res.status(409).json({ error: `${row.name} is already on the vendor list` });

        const cols = Object.keys(row);
        await db.transaction(async (c) => {
            await c.query(
                `UPDATE vendors SET ${cols.map((col, i) => `${col} = $${i + 1}`).join(', ')}, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $${cols.length + 1}`, [...cols.map(col => row[col]), existing.id]);
            // Orders show the vendor's name as typed; a rename is the same vendor, so they follow.
            if (row.name !== existing.name) {
                await c.query('UPDATE vendor_orders SET vendor = $1 WHERE vendor_id = $2', [row.name, existing.id]);
            }
        });
        res.json({ success: true });
    } catch (err) {
        console.error('vendor update:', err);
        res.status(500).json({ error: 'Failed to save vendor' });
    }
});

// POST /api/vendors/:id/active { active } — archive or bring back
router.post('/:id/active', async (req, res) => {
    try {
        if (!await canEdit(req)) return res.status(403).json({ error: 'Access denied' });
        const r = await db.query(
            'UPDATE vendors SET active = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id',
            [req.body?.active !== false, req.params.id]);
        if (!r.rows.length) return res.status(404).json({ error: 'Vendor not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('vendor archive:', err);
        res.status(500).json({ error: 'Failed to update vendor' });
    }
});

// DELETE /api/vendors/:id — only a vendor with no orders; anything with history is archived instead
router.delete('/:id', async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Access denied' });
    try {
        const used = (await db.query(
            `SELECT (SELECT COUNT(*) FROM vendor_orders WHERE vendor_id = $1) + (SELECT COUNT(*) FROM vendor_payments WHERE vendor_id = $1) AS n`,
            [req.params.id])).rows[0].n;
        if (Number(used)) return res.status(409).json({ error: 'This vendor has orders or payments — archive it instead' });
        const r = await db.query('DELETE FROM vendors WHERE id = $1 RETURNING id', [req.params.id]);
        if (!r.rows.length) return res.status(404).json({ error: 'Vendor not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('vendor delete:', err);
        res.status(500).json({ error: 'Failed to delete vendor' });
    }
});

module.exports = router;
