/**
 * The vendor's own page — public, no login: https://<crm>/v/<token>.
 *
 * Read-only except for uploading invoices. It shows the vendor what we hold about them and what
 * stands between us: their orders and what has come in, payment plans, every payment with its
 * reference, the running statement and their invoices.
 *
 * It never shows: internal notes, comments, who on the team did what, our own bank account, other
 * vendors, payment proof files, or anything about the customers an order was for.
 *
 * Everything hangs off the token. A disabled or regenerated link answers exactly like one that
 * never existed. Requests are limited per link (the server sits behind nginx without trusting its
 * forwarded address, so per-IP would be one shared bucket).
 */

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const db = require('../db/connection');
const money = require('../services/vendor-money');
const plan = require('../services/vendor-plan');
const receipts = require('../services/vendor-receipts');
const invoices = require('../services/vendor-invoices');
const { statement } = require('../services/vendor-statement');
const { refLabel } = require('../services/vendor-order');

const router = express.Router();

const TOKEN_RE = /^[A-Za-z0-9_-]{30,64}$/;
const COMPANY = 'Normless';
const NOT_FOUND = { error: 'This link isn’t active. Ask us for a new one.' };
const parseItems = (raw) => { try { return JSON.parse(raw || '[]'); } catch { return []; } };

const perLink = (windowMs, limit) => rateLimit({
    windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false,
    keyGenerator: (req) => `vendor-link:${req.params.token}`,
    message: { error: 'Too many requests on this link — try again in a few minutes.' },
});

router.use((req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'no-store');
    next();
});

/** The vendor behind a live link, or null. */
async function vendorFor(req) {
    const token = String(req.params.token || '');
    if (!TOKEN_RE.test(token)) return null;
    return (await db.query(
        `SELECT * FROM vendors WHERE portal_token = $1 AND portal_enabled AND active`, [token])).rows[0] || null;
}

const mask = (v, keep = 4) => (v ? `••${String(v).slice(-keep)}` : null);

// GET /api/portal/vendor/:token
router.get('/:token', perLink(15 * 60 * 1000, 300), async (req, res) => {
    try {
        const v = await vendorFor(req);
        if (!v) return res.status(404).json(NOT_FOUND);

        // Last opened, for the team — at most once every ten minutes, so a refresh isn't a write.
        db.query(`UPDATE vendors SET portal_last_seen_at = CURRENT_TIMESTAMP
                  WHERE id = $1 AND (portal_last_seen_at IS NULL OR portal_last_seen_at < CURRENT_TIMESTAMP - INTERVAL '10 minutes')`, [v.id])
            .catch(() => {});

        const orderRows = (await db.query(
            `SELECT o.id, o.ref_no, o.brand, TO_CHAR(o.order_date, 'YYYY-MM-DD') AS order_date,
                    TO_CHAR(o.delivery_date, 'YYYY-MM-DD') AS delivery_date, o.title, o.quote_ref, o.status, o.items,
                    o.total_qty, ${money.TOTAL_SQL} AS total, o.paid_amount
             FROM vendor_orders o WHERE o.vendor_id = $1 ORDER BY o.order_date DESC, o.id DESC`, [v.id])).rows;
        const ids = orderRows.map(o => o.id);
        const [instRows, recRows] = ids.length ? await Promise.all([
            db.query(`SELECT id, order_id, seq, label, amount, percent, due_kind, TO_CHAR(due_date, 'YYYY-MM-DD') AS due_date
                      FROM vendor_order_instalments WHERE order_id = ANY($1::int[]) ORDER BY seq`, [ids]),
            db.query(`SELECT order_id, TO_CHAR(received_on, 'YYYY-MM-DD') AS received_on, lines, received_qty, rejected_qty
                      FROM vendor_receipts WHERE order_id = ANY($1::int[]) ORDER BY received_on DESC, id DESC`, [ids]),
        ]).then(r => r.map(x => x.rows)) : [[], []];

        const orders = orderRows.map(o => {
            const total = Number(o.total) > 0 ? Number(o.total) : null;
            const paid = Number(o.paid_amount) || 0;
            const deliveries = recRows.filter(r => r.order_id === o.id).map(r => ({ ...r, lines: parseItems(r.lines), order_id: undefined }));
            const items = parseItems(o.items);
            return {
                id: o.id, ref: refLabel(o), order_date: o.order_date, delivery_date: o.delivery_date,
                title: o.title, quote_ref: o.quote_ref, status: o.status, total_qty: o.total_qty,
                total, paid: total ? paid : null, balance: total ? money.round2(total - paid) : null,
                progress: receipts.progress(items, deliveries),
                deliveries,
                instalments: total ? plan.schedule(instRows.filter(i => i.order_id === o.id), { paid_amount: paid, status: o.status })
                    .map(i => ({ number: i.number, of: i.of, label: i.label, amount: i.amount, due_kind: i.due_kind, due_date: i.due_date, status: i.status, covered: i.covered, remaining: i.remaining })) : [],
            };
        });

        const payments = (await db.query(
            `SELECT TO_CHAR(p.paid_on, 'YYYY-MM-DD') AS paid_on, p.amount, p.mode, p.reference, p.source,
                    COALESCE((SELECT json_agg(json_build_object('ref_no', o.ref_no, 'id', o.id, 'amount', a.amount) ORDER BY o.id)
                              FROM vendor_payment_allocations a JOIN vendor_orders o ON o.id = a.order_id
                              WHERE a.payment_id = p.id), '[]') AS allocations
             FROM vendor_payments p WHERE p.vendor_id = $1 ORDER BY p.paid_on DESC, p.id DESC`, [v.id])).rows
            .map(p => ({
                paid_on: p.paid_on, amount: Number(p.amount), mode: p.mode,
                reference: p.reference || null,
                // Paid before references were being recorded here — not a reference still to come.
                recorded_earlier: p.source === 'migrated',
                for: p.allocations.map(a => ({ ref: refLabel(a), amount: Number(a.amount) })),
            }));

        const invoiceRows = (await db.query(
            `SELECT i.id, i.invoice_no, TO_CHAR(i.invoice_date, 'YYYY-MM-DD') AS invoice_date, i.amount, i.status, i.reason,
                    i.source, o.ref_no, i.order_id, TO_CHAR(i.created_at, 'YYYY-MM-DD') AS uploaded_on
             FROM vendor_invoices i LEFT JOIN vendor_orders o ON o.id = i.order_id
             WHERE i.vendor_id = $1 ORDER BY i.created_at DESC`, [v.id])).rows
            .map(i => ({ ...i, amount: i.amount != null ? Number(i.amount) : null, order_ref: i.order_id ? refLabel(i) : null, ref_no: undefined }));

        res.json({
            company: COMPANY,
            vendor: {
                name: v.name, contact_person: v.contact_person, phone: v.phone, email: v.email,
                address: [v.address, v.city, v.state].filter(Boolean).join(', ') || null, gstin: v.gstin, pan: v.pan,
                // Enough to spot a wrong account, not enough to be useful to anyone who finds the link.
                bank: (v.bank_account_no || v.upi_id) ? {
                    account_name: v.bank_account_name, bank_name: v.bank_name, account: mask(v.bank_account_no),
                    ifsc: v.bank_ifsc, upi: v.upi_id ? `${String(v.upi_id).slice(0, 2)}•••@${String(v.upi_id).split('@')[1] || ''}` : null,
                } : null,
            },
            money: await money.vendorMoney(v.id),
            orders,
            payments,
            invoices: invoiceRows,
            statement: await statement(v.id),
            as_of: new Date().toISOString(),
        });
    } catch (err) {
        console.error('vendor portal:', err);
        res.status(500).json({ error: 'Something went wrong — try again in a moment.' });
    }
});

// POST /api/portal/vendor/:token/invoices — the vendor uploads an invoice (multipart, `file`)
router.post('/:token/invoices', perLink(60 * 60 * 1000, 20), async (req, res, next) => {
    try {
        const v = await vendorFor(req);
        if (!v) return res.status(404).json(NOT_FOUND);
        req.vendor = v;
        next();
    } catch (err) { next(err); }
}, invoices.withFile, async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Attach the invoice file' });
        const v = req.vendor;
        const { error, row } = await invoices.readInvoice(req.body || {}, v.id);
        if (error) return res.status(400).json({ error });
        const f = invoices.saveFile(req.file, v.id);
        await db.query(
            `INSERT INTO vendor_invoices (vendor_id, order_id, invoice_no, invoice_date, amount, note, file_path, file_name, file_mime, source, uploaded_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'vendor',$10)`,
            [v.id, row.order_id, row.invoice_no, row.invoice_date, row.amount, row.note, f.file_path, f.file_name, f.file_mime, `vendor: ${v.name}`]);
        await invoices.notifyUpload(v, row.invoice_no);
        res.json({ success: true });
    } catch (err) {
        console.error('vendor portal invoice upload:', err);
        res.status(500).json({ error: 'The invoice couldn’t be saved — try again.' });
    }
});

// GET /api/portal/vendor/:token/invoices/:id/file — one of their own invoices
router.get('/:token/invoices/:id/file', perLink(15 * 60 * 1000, 120), async (req, res) => {
    try {
        const v = await vendorFor(req);
        if (!v) return res.status(404).json(NOT_FOUND);
        const row = (await db.query('SELECT file_path, file_name, file_mime FROM vendor_invoices WHERE id = $1 AND vendor_id = $2',
            [parseInt(req.params.id, 10) || 0, v.id])).rows[0];
        if (!row) return res.status(404).json({ error: 'Not found' });
        invoices.sendFile(res, row);
    } catch (err) {
        console.error('vendor portal invoice file:', err);
        res.status(500).json({ error: 'Failed to read the file' });
    }
});

module.exports = router;
