/**
 * Customer support — the returns, replacements and refunds arranged by hand.
 *
 * Most of this work arrives on WhatsApp: the size is wrong, the parcel came damaged, the address
 * was mistyped. Somebody then arranges a return, charges for a replacement or refunds, and days
 * later it is finished. None of that is in Shopify, which is why it was a spreadsheet — and the
 * spreadsheet's vocabulary is kept here deliberately, so the desk that filled it recognises every
 * word on the page.
 *
 * Two statuses rather than one, also from the sheet, because they answer different questions:
 * `status` is whether anyone still has to look at this, and `progress` is how far the work got.
 *
 * Marketing's seeding orders are not here. They were in the same workbook, but they are raised and
 * tracked on the Marketing page, and mixing the two would mean one list answering to two desks.
 */

const express = require('express');
const db = require('../db/connection');
const { hasPermission } = require('../utils/permissions');
const { tableParams, pagination } = require('../utils/table');

const router = express.Router();

/* ── Vocabulary ──────────────────────────────────────────────────────────────────────────────
   Served to the client as well, so the dropdowns and whatever the server will accept can never
   drift apart. Free text is still allowed through for anything imported — a ticket from the sheet
   that says something we no longer offer should still read as it did. */
const SOURCES = ['WhatsApp', 'Email', 'Instagram', 'Phone', 'Other'];
const NATURES = [
    'Order Edits (Pre-fulfilment)', 'Return & Replacement', 'Return & Refund', 'Refund', 'Reship',
];
const REASONS = [
    'Size Change', 'Address update', 'Initiate Return', 'Initiate Replacement', 'Initiate Refund',
    'Failed Shipment', 'Damaged product', 'Wrong product', 'Order Cancelled', 'Other',
];
const PAYMENTS = ['Paid', 'Pending', 'Not applicable'];
const STATUSES = ['Open', 'Closed'];
const PROGRESS = ['Pending', 'In Progress', 'Completed'];
const ACTIONS = [
    'Return Initiated', 'Replacement Initiated', 'Reshipped', 'Size Updated', 'Address Changed',
    'Shipped', 'Refunded', 'Manual return required', 'Cancelled',
];

/** Everyone who can open the page; the write gate is separate. */
router.use(async (req, res, next) => {
    try {
        if (!await hasPermission(req, 'can_view_support')) return res.status(403).json({ error: 'Access denied' });
        next();
    } catch (err) { next(err); }
});

const canEdit = async (req, res, next) => {
    try {
        if (!await hasPermission(req, 'can_edit_support')) {
            return res.status(403).json({ error: 'You have read-only access to support tickets' });
        }
        next();
    } catch (err) { next(err); }
};

const trim = (v) => { const t = String(v ?? '').trim(); return t || null; };
const safeJson = (v, fallback) => { try { return typeof v === 'string' ? (JSON.parse(v || 'null') ?? fallback) : (v || fallback); } catch { return fallback; } };
const isoDate = (v) => { const t = trim(v); return t ? t.slice(0, 10) : null; };
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

/** "#11553" and "11553" are the same order; orders are stored with the hash. */
const orderKey = (v) => {
    const raw = String(v ?? '').trim();
    if (!raw) return null;
    const digits = raw.match(/\d{3,}/);
    return digits ? `#${digits[0]}` : raw;
};

const SORTS = {
    ref_no: 'ref_no', order_number: 'order_number', customer_name: 'LOWER(customer_name)',
    nature: 'nature', status: 'status', progress: 'progress', assigned_to: 'LOWER(assigned_to)',
    raised_on: 'raised_on', resolved_on: 'resolved_on', aging: 'aging',
};

// How long this has been somebody's problem: open tickets count to today, finished ones stop at
// the day they were resolved. SQL rather than the browser so it can be sorted on.
const AGING = `(COALESCE(resolved_on, CURRENT_DATE) - raised_on)`;
const FIELDS = `id, ref_no, order_number, shopify_order_id, customer_name, customer_phone,
                customer_email, source, nature, reason, payment_status, request, status, progress,
                action, ops_note, forward_awb, return_awb, assigned_to,
                TO_CHAR(raised_on,'YYYY-MM-DD') AS raised_on,
                TO_CHAR(resolved_on,'YYYY-MM-DD') AS resolved_on,
                created_by, created_at, updated_at, ${AGING} AS aging`;

/** The vocabulary, for the drawer's dropdowns. */
router.get('/options', (req, res) => {
    res.json({
        sources: SOURCES, natures: NATURES, reasons: REASONS, payments: PAYMENTS,
        statuses: STATUSES, progress: PROGRESS, actions: ACTIONS,
    });
});

/**
 * GET /api/support/tickets — the list, filtered the way the page is read.
 *
 * `view` is the tab: open tickets are what the desk works from, so that is the default.
 */
router.get('/tickets', async (req, res) => {
    try {
        const where = [];
        const vals = [];
        const view = String(req.query.view || 'open').toLowerCase();
        if (view === 'open') where.push(`status <> 'Closed'`);
        else if (view === 'closed') where.push(`status = 'Closed'`);

        for (const [col, q] of [['nature', req.query.nature], ['source', req.query.source], ['action', req.query.action]]) {
            const v = trim(q);
            if (v) { vals.push(v); where.push(`${col} = $${vals.length}`); }
        }
        if (trim(req.query.from)) { vals.push(isoDate(req.query.from)); where.push(`raised_on >= $${vals.length}`); }
        if (trim(req.query.to)) { vals.push(isoDate(req.query.to)); where.push(`raised_on <= $${vals.length}`); }

        const search = trim(req.query.search);
        if (search) {
            vals.push(`%${search.replace(/^#/, '')}%`);
            const i = vals.length;
            where.push(`(order_number ILIKE $${i} OR customer_name ILIKE $${i} OR customer_phone ILIKE $${i}
                      OR customer_email ILIKE $${i} OR request ILIKE $${i} OR ops_note ILIKE $${i}
                      OR forward_awb ILIKE $${i} OR return_awb ILIKE $${i} OR CAST(ref_no AS TEXT) ILIKE $${i})`);
        }
        const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

        const t = tableParams(req.query, { sortable: SORTS, defaultSort: 'raised_on', defaultDir: 'desc' });
        const rows = (await db.query(
            `SELECT ${FIELDS} FROM support_tickets ${clause} ${t.orderBy} LIMIT ${t.limit} OFFSET ${t.offset}`, vals)).rows;
        const total = (await db.query(`SELECT COUNT(*)::int AS n FROM support_tickets ${clause}`, vals)).rows[0].n;

        // The whole desk at a glance, not just the page being looked at.
        const s = (await db.query(
            `SELECT COUNT(*) FILTER (WHERE status <> 'Closed')::int AS open,
                    COUNT(*) FILTER (WHERE status = 'Closed')::int AS closed,
                    COUNT(*) FILTER (WHERE status <> 'Closed' AND ${AGING} > 7)::int AS stale,
                    COUNT(*) FILTER (WHERE raised_on = CURRENT_DATE)::int AS today,
                    COUNT(*)::int AS total
               FROM support_tickets`)).rows[0];

        res.json({ tickets: rows, summary: s, pagination: pagination(total, t) });
    } catch (err) {
        console.error('support list error:', err);
        res.status(500).json({ error: 'Could not read the support tickets' });
    }
});

/** The sidebar badge: tickets nobody has closed. */
router.get('/open-count', async (req, res) => {
    try {
        const r = await db.query(
            `SELECT COUNT(*)::int AS open,
                    COUNT(*) FILTER (WHERE ${AGING} > 7)::int AS stale
               FROM support_tickets WHERE status <> 'Closed'`);
        res.json({ open: r.rows[0].open, stale: r.rows[0].stale });
    } catch (err) {
        console.error('support open-count error:', err);
        res.json({ open: 0, stale: 0 });
    }
});

/**
 * GET /api/support/order/:number — what we know about the order a ticket is being raised against.
 *
 * Only Shopify customer orders: a seeding order is marketing's, and nobody should be able to open
 * a support ticket against one from here by typing its number.
 */
router.get('/order/:number', async (req, res) => {
    try {
        const orderNumber = orderKey(req.params.number);
        if (!orderNumber) return res.status(400).json({ error: 'Which order?' });
        const r = await db.query(
            `SELECT o.shopify_id, o.order_number, o.total_price, o.line_items_json, o.created_at,
                    o.financial_status, o.fulfillment_status, o.cancelled_at, o.on_hold,
                    c.first_name, c.last_name, c.email AS customer_email, c.phone AS customer_phone
               FROM orders o
               LEFT JOIN customers c ON c.shopify_id = o.customer_shopify_id
              WHERE o.order_number = $1`, [orderNumber]);
        const o = r.rows[0];
        // The dispatch log knows where the parcel went and under which waybill — which is exactly
        // what a return is arranged against, and it outlives the order in Shopify.
        const packed = (await db.query(
            `SELECT awb, courier, customer_name, customer_phone, customer_email, ship_city, ship_state, packed_at
               FROM packed_orders WHERE order_number = $1`, [orderNumber])).rows[0] || null;

        if (!o && !packed) {
            return res.status(404).json({ error: `${orderNumber} is not in the CRM — raise the ticket anyway, or check the number` });
        }
        res.json({
            order: o ? {
                order_number: o.order_number,
                shopify_order_id: o.shopify_id,
                customer_name: trim([o.first_name, o.last_name].filter(Boolean).join(' ')) || packed?.customer_name || null,
                customer_phone: trim(o.customer_phone) || packed?.customer_phone || null,
                customer_email: trim(o.customer_email) || packed?.customer_email || null,
                total_price: o.total_price,
                financial_status: o.financial_status,
                fulfillment_status: o.cancelled_at ? 'CANCELLED' : o.on_hold ? 'ON HOLD' : o.fulfillment_status,
                created_at: o.created_at,
                items: safeJson(o.line_items_json, []).map(i => ({ title: i.title, variant: i.variant, quantity: i.quantity })),
            } : {
                order_number: orderNumber,
                customer_name: packed.customer_name, customer_phone: packed.customer_phone,
                customer_email: packed.customer_email, items: [],
            },
            dispatch: packed,
            // Everything this customer has asked for before — the context that makes a third
            // replacement request read differently from a first.
            history: (await db.query(
                `SELECT ${FIELDS} FROM support_tickets WHERE order_number = $1 ORDER BY raised_on DESC, id DESC`,
                [orderNumber])).rows,
        });
    } catch (err) {
        console.error('support order lookup error:', err);
        res.status(500).json({ error: 'Could not read that order' });
    }
});

router.get('/tickets/:id', async (req, res) => {
    try {
        const r = await db.query(`SELECT ${FIELDS} FROM support_tickets WHERE id = $1`, [parseInt(req.params.id, 10) || 0]);
        if (!r.rows[0]) return res.status(404).json({ error: 'That ticket is gone' });
        res.json({ ticket: r.rows[0] });
    } catch (err) {
        console.error('support get error:', err);
        res.status(500).json({ error: 'Could not read that ticket' });
    }
});

/** The columns a ticket's body is made of, and how each is cleaned. */
const WRITABLE = {
    order_number: orderKey,
    shopify_order_id: trim, customer_name: trim, customer_phone: trim, customer_email: trim,
    source: trim, nature: trim, reason: trim, payment_status: trim, request: trim,
    status: trim, progress: trim, action: trim, ops_note: trim,
    forward_awb: trim, return_awb: trim, assigned_to: trim,
    raised_on: isoDate, resolved_on: isoDate,
};

/**
 * POST /api/support/tickets — raise one.
 *
 * The reference number is handed out under a lock rather than read-then-written: two people
 * raising a ticket at the same moment would otherwise both be told they are CS-0043.
 */
router.post('/tickets', canEdit, async (req, res) => {
    try {
        const body = {};
        for (const [col, clean] of Object.entries(WRITABLE)) {
            if (req.body[col] !== undefined) body[col] = clean(req.body[col]);
        }
        if (!body.order_number && !body.customer_name && !body.customer_phone) {
            return res.status(400).json({ error: 'Say which order, or at least who the customer is' });
        }
        body.raised_on = body.raised_on || today();
        body.status = STATUSES.includes(body.status) ? body.status : 'Open';
        body.progress = PROGRESS.includes(body.progress) ? body.progress : 'Pending';
        if (body.status === 'Closed' && !body.resolved_on) body.resolved_on = today();

        const cols = Object.keys(body);
        const ticket = await db.transaction(async (tx) => {
            await tx.query(`SELECT pg_advisory_xact_lock(hashtext('support_ticket_ref'))`);
            const next = (await tx.query('SELECT COALESCE(MAX(ref_no), 0) + 1 AS n FROM support_tickets')).rows[0].n;
            const values = cols.map(c => body[c]);
            const r = await tx.query(
                `INSERT INTO support_tickets (ref_no, created_by, ${cols.join(', ')})
                 VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')})
                 RETURNING id`,
                [next, req.user?.username || null, ...values]);
            return r.rows[0].id;
        });
        const row = (await db.query(`SELECT ${FIELDS} FROM support_tickets WHERE id = $1`, [ticket])).rows[0];
        res.status(201).json({ ticket: row });
    } catch (err) {
        console.error('support create error:', err);
        res.status(500).json({ error: 'Could not raise the ticket' });
    }
});

/**
 * PATCH /api/support/tickets/:id — change one.
 *
 * Closing stamps the day it was resolved and reopening clears it, so the aging on a reopened
 * ticket starts counting again instead of staying frozen at the day somebody closed it early.
 */
router.patch('/tickets/:id', canEdit, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10) || 0;
        const before = (await db.query('SELECT id, status, resolved_on FROM support_tickets WHERE id = $1', [id])).rows[0];
        if (!before) return res.status(404).json({ error: 'That ticket is gone' });

        const patch = {};
        for (const [col, clean] of Object.entries(WRITABLE)) {
            if (req.body[col] !== undefined) patch[col] = clean(req.body[col]);
        }
        if (patch.status === 'Closed' && before.status !== 'Closed' && patch.resolved_on === undefined && !before.resolved_on) {
            patch.resolved_on = today();
        }
        if (patch.status && patch.status !== 'Closed' && before.status === 'Closed' && patch.resolved_on === undefined) {
            patch.resolved_on = null;
        }
        if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change' });

        const cols = Object.keys(patch);
        await db.query(
            `UPDATE support_tickets SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = CURRENT_TIMESTAMP
              WHERE id = $1`,
            [id, ...cols.map(c => patch[c])]);
        const row = (await db.query(`SELECT ${FIELDS} FROM support_tickets WHERE id = $1`, [id])).rows[0];
        res.json({ ticket: row });
    } catch (err) {
        console.error('support update error:', err);
        res.status(500).json({ error: 'Could not save that change' });
    }
});

/** Only the owner deletes a ticket — everyone else closes it, which keeps the record. */
router.delete('/tickets/:id', canEdit, async (req, res) => {
    try {
        if (req.user?.role !== 'owner') {
            return res.status(403).json({ error: 'Only the owner can delete a ticket — close it instead' });
        }
        const id = parseInt(req.params.id, 10) || 0;
        const r = await db.query('DELETE FROM support_tickets WHERE id = $1 RETURNING ref_no', [id]);
        if (!r.rows[0]) return res.status(404).json({ error: 'That ticket is already gone' });
        await db.query(`DELETE FROM comments WHERE entity = 'support_ticket' AND entity_id = $1`, [id]);
        res.json({ deleted: true, ref_no: r.rows[0].ref_no });
    } catch (err) {
        console.error('support delete error:', err);
        res.status(500).json({ error: 'Could not delete that ticket' });
    }
});

module.exports = router;
module.exports.VOCAB = { SOURCES, NATURES, REASONS, PAYMENTS, STATUSES, PROGRESS, ACTIONS };
