/**
 * WhatsApp updates to vendors, from Normless's number, for both brands' orders.
 *
 * Every action that should tell a vendor something — an order raised, a payment, goods in, a QC
 * rejection, an invoice reviewed — puts a row in vendor_wa_queue, held for a few minutes (the
 * Automations page sets how long; 10 by default). Nothing is written into the row but what it is
 * about: the message is worked out from the database when it goes, so a payment corrected inside
 * the hold goes out corrected, one deleted goes out not at all, and several deliveries on one day
 * for one order go as one message.
 *
 * Sending is nl-automations' fire(): the event's approved template, once per (event, ref), logged
 * in the vendor's chat. An event switched off, a vendor with WhatsApp updates off or no number,
 * or a vendor whose link was switched off: nothing is queued or sent.
 */

const crypto = require('crypto');
const db = require('../db/connection');
const lines = require('./wa-line');
const auto = require('./nl-automations');
const money = require('./vendor-money');
const plan = require('./vendor-plan');
const receipts = require('./vendor-receipts');
const { refLabel } = require('./vendor-order');

const COMPANY = 'Normless';
const BRAND_NAMES = { normless: 'Normless', crewfit: 'Crewfit' };
const { shareBase } = require('../utils/public-urls');

const inr = (v) => `₹${(Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (ymd) => { const [y, m, d] = String(ymd).slice(0, 10).split('-'); return `${d} ${MONTHS[Number(m) - 1]} ${y}`; };
const parseItems = (raw) => { try { return JSON.parse(raw || '[]'); } catch { return []; } };
const clip = (s, n = 300) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const lineText = (ls) => clip(ls.map(l => `${[l.product, l.color, l.size].filter(Boolean).join(' ')} × ${l.n}`).join(', '));

const normless = () => lines.get('normless');

/** The vendor, if they can be messaged: active, updates on, a 10-digit number. */
async function messageable(vendorId) {
    const v = (await db.query('SELECT * FROM vendors WHERE id = $1', [vendorId])).rows[0];
    if (!v || !v.active || v.whatsapp_updates === false) return null;
    if (!/^\d{10}$/.test(String(v.phone || ''))) return null;
    return v;
}

/**
 * Queue a message. Returns { queued, send_after } or { queued: false, reason }.
 * `now` skips the hold (a link someone chose to send, a scheduled reminder).
 */
async function enqueue({ event, vendorId, ref, note = null, user = null, notify = true, now = false }) {
    try {
        if (notify === false) return { queued: false, reason: 'not asked to' };
        const line = normless();
        if (!line?.id) return { queued: false, reason: 'Normless WhatsApp isn’t connected' };
        const cfg = await auto.config(line.id);
        const ev = cfg.events[event];
        if (!ev?.enabled || !ev.template) return { queued: false, reason: 'this message is switched off' };
        if (!await messageable(vendorId)) return { queued: false, reason: 'the vendor has no WhatsApp number or updates are off' };

        // Deliveries: one message per order per day. A lot on a day whose message already went
        // gets a message of its own.
        if (event === 'vendor_delivery') {
            const rows = (await db.query(`SELECT ref, status FROM vendor_wa_queue WHERE event = $1 AND (ref = $2 OR ref LIKE $2 || '#%')`, [event, ref])).rows;
            const waiting = rows.find(r => r.status === 'queued');
            if (waiting) return { queued: true, merged: true };
            if (rows.length) ref = `${ref}#${rows.length + 1}`;
        }

        const hold = now ? 0 : cfg.vendor_hold;
        const r = await db.query(
            `INSERT INTO vendor_wa_queue (vendor_id, event, ref, note, send_after, created_by)
             VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP + ($5 || ' minutes')::interval, $6)
             ON CONFLICT (event, ref) DO UPDATE SET note = COALESCE(EXCLUDED.note, vendor_wa_queue.note)
                 WHERE vendor_wa_queue.status = 'queued'
             RETURNING send_after`, [vendorId, event, ref, note, hold, user]);
        return r.rows[0] ? { queued: true, send_after: r.rows[0].send_after, hold } : { queued: false, reason: 'already sent' };
    } catch (err) {
        console.error(`vendor wa enqueue ${event} ${ref}:`, err.message);
        return { queued: false, reason: 'error' };
    }
}

/** The vendor's page address, making the link the first time a message needs it. Null if switched off. */
async function pageFor(v) {
    if (v.portal_token && !v.portal_enabled) return null;
    let token = v.portal_token;
    if (!token) {
        token = crypto.randomBytes(24).toString('base64url');
        await db.query(`UPDATE vendors SET portal_token = $1, portal_enabled = true, portal_created_at = CURRENT_TIMESTAMP WHERE id = $2 AND portal_token IS NULL`, [token, v.id]);
        token = (await db.query('SELECT portal_token FROM vendors WHERE id = $1', [v.id])).rows[0].portal_token;
    }
    return `${shareBase()}/v/${token}`;
}

const orderRow = async (id) => (await db.query(
    `SELECT o.*, TO_CHAR(o.order_date, 'YYYY-MM-DD') AS ymd, TO_CHAR(o.delivery_date, 'YYYY-MM-DD') AS delivery_ymd,
            ${money.TOTAL_SQL} AS total FROM vendor_orders o WHERE o.id = $1`, [id])).rows[0];

/** What each message says, worked out now. Returns { facts, label } or { skip }. */
const BUILD = {
    async vendor_link() { return { facts: { company: COMPANY }, label: 'their page' }; },

    async vendor_order(row) {
        const o = await orderRow(row.ref.split(':')[1]);
        if (!o) return { skip: 'the order was deleted' };
        const items = parseItems(o.items).map(i => `${i.product_type} × ${require('./vendor-order').itemQty(i)}`);
        return {
            label: refLabel(o),
            facts: {
                vendor_order_ref: refLabel(o), vendor_brand: BRAND_NAMES[o.brand] || COMPANY,
                vendor_items: clip(items.join(', ') || 'see your vendor page'),
                vendor_order_value: Number(o.total) > 0 ? `${inr(o.total)} incl. GST` : 'as per your quotation',
                vendor_delivery_by: o.delivery_ymd ? day(o.delivery_ymd) : 'to be confirmed',
            },
        };
    },

    async vendor_order_changed(row) {
        const o = await orderRow(row.ref.split(':')[1]);
        if (!o) return { skip: 'the order was deleted' };
        return { label: refLabel(o), facts: { vendor_order_ref: refLabel(o), vendor_change: clip(row.note || 'the details have changed', 200) } };
    },

    async vendor_payment(row) {
        const p = (await db.query(
            `SELECT p.*, TO_CHAR(p.paid_on, 'YYYY-MM-DD') AS ymd,
                    COALESCE((SELECT string_agg('VO-' || LPAD(o.ref_no::text, 3, '0'), ', ' ORDER BY o.id)
                              FROM vendor_payment_allocations a JOIN vendor_orders o ON o.id = a.order_id WHERE a.payment_id = p.id), '') AS against
             FROM vendor_payments p WHERE p.id = $1`, [row.ref.split(':')[1]])).rows[0];
        if (!p) return { skip: 'the payment was deleted' };
        const bal = await money.vendorMoney(p.vendor_id);
        return {
            label: inr(p.amount),
            facts: {
                vendor_pay_amount: inr(p.amount), vendor_paid_on: day(p.ymd), vendor_pay_mode: p.mode || 'bank transfer',
                vendor_pay_ref: p.reference || (p.mode === 'Cash' ? 'paid in cash' : 'will be shared on your vendor page'),
                vendor_pay_for: p.against ? `order ${p.against}` : 'your account with us',
                vendor_balance: inr(Math.max(bal.balance, 0)),
            },
        };
    },

    async vendor_delivery(row) {
        const [, orderId, ymdRaw] = row.ref.split(':');
        const ymd = ymdRaw.split('#')[0];
        const o = await orderRow(orderId);
        if (!o) return { skip: 'the order was deleted' };
        const all = (await db.query(`SELECT TO_CHAR(received_on, 'YYYY-MM-DD') AS ymd, lines FROM vendor_receipts WHERE order_id = $1`, [o.id])).rows
            .map(r => ({ ymd: r.ymd, lines: parseItems(r.lines) }));
        const that = all.filter(r => r.ymd === ymd);
        if (!that.length) return { skip: 'the delivery was deleted' };
        const got = new Map();
        for (const r of that) for (const l of r.lines) {
            const k = [l.product, l.color, l.size].join('|');
            got.set(k, { product: l.product, color: l.color, size: l.size, n: (got.get(k)?.n || 0) + (Number(l.received) || 0) });
        }
        const pend = receipts.progress(parseItems(o.items), all).lines.filter(l => l.pending > 0).map(l => ({ ...l, n: l.pending }));
        return {
            label: refLabel(o),
            facts: {
                vendor_received_on: day(ymd), vendor_order_ref: refLabel(o),
                vendor_received: lineText([...got.values()]) || 'see your vendor page',
                vendor_pending: pend.length ? lineText(pend) : 'nothing, the order is complete',
            },
        };
    },

    async vendor_rejected(row) {
        const r = (await db.query(
            `SELECT r.*, TO_CHAR(r.received_on, 'YYYY-MM-DD') AS ymd, o.ref_no, o.id AS oid FROM vendor_receipts r
             JOIN vendor_orders o ON o.id = r.order_id WHERE r.id = $1`, [row.ref.split(':')[1]])).rows[0];
        if (!r || !(r.rejected_qty > 0)) return { skip: 'nothing rejected any more' };
        const ref = refLabel({ ref_no: r.ref_no, id: r.oid });
        return { label: ref, facts: { vendor_received_on: day(r.ymd), vendor_order_ref: ref, vendor_rejected: String(r.rejected_qty), vendor_qc_note: clip(r.note || 'details are on your vendor page', 200) } };
    },

    async vendor_invoice(row) {
        const i = (await db.query('SELECT * FROM vendor_invoices WHERE id = $1', [row.ref.split(':')[1]])).rows[0];
        const wanted = row.ref.split(':')[2];
        if (!i || i.status !== wanted) return { skip: 'the decision changed' };
        return {
            label: i.invoice_no,
            facts: {
                vendor_invoice_no: i.invoice_no, vendor_invoice_amount: i.amount != null ? inr(i.amount) : 'the amount on it',
                vendor_invoice_status: i.status === 'Accepted' ? 'accepted' : 'rejected',
                vendor_invoice_note: i.status === 'Accepted' ? 'Thank you.' : clip(`Reason: ${i.reason || 'please contact us'}. Please upload a corrected invoice.`, 250),
            },
        };
    },

    async vendor_instalment_due(row) {
        const inst = (await db.query('SELECT * FROM vendor_order_instalments WHERE id = $1', [row.ref.split(':')[1]])).rows[0];
        if (!inst) return { skip: 'the plan changed' };
        const o = await orderRow(inst.order_id);
        const all = (await db.query('SELECT * FROM vendor_order_instalments WHERE order_id = $1', [o.id])).rows;
        const mine = plan.schedule(all, { paid_amount: o.paid_amount, status: o.status }).find(i => i.id === inst.id);
        if (!mine || mine.status === 'Paid' || !mine.due_date) return { skip: 'already paid' };
        return {
            label: refLabel(o),
            facts: { vendor_instalment: `${mine.number} of ${mine.of}`, vendor_instalment_amount: inr(mine.remaining), vendor_order_ref: refLabel(o), vendor_instalment_due: day(mine.due_date) },
        };
    },
};

/** Send whatever is due. */
async function tick() {
    const line = normless();
    if (!line?.id) return;
    const due = (await db.query(
        `SELECT * FROM vendor_wa_queue WHERE status = 'queued' AND send_after <= CURRENT_TIMESTAMP ORDER BY send_after LIMIT 20`)).rows;
    for (const row of due) await sendRow(line, row);
}

/** Send one queued row. Returns { status, error }. */
async function sendRow(line, row, { force = false, template = null } = {}) {
    const finish = async (status, error = null) => {
        await db.query(`UPDATE vendor_wa_queue SET status = $1, error = $2, done_at = CURRENT_TIMESTAMP WHERE id = $3`,
            [status, error ? String(error).slice(0, 300) : null, row.id]);
        return { status, error };
    };
    try {
        // By hand, updates switched off on the vendor doesn't stop a message someone chose to send.
        const v = force
            ? (await db.query('SELECT * FROM vendors WHERE id = $1 AND active', [row.vendor_id])).rows.find(x => /^\d{10}$/.test(String(x.phone || '')))
            : await messageable(row.vendor_id);
        if (!v) return finish('skipped', 'No WhatsApp number, or updates switched off for this vendor');
        const page = await pageFor(v);
        if (!page) return finish('skipped', 'The vendor’s link is switched off');
        const built = await BUILD[row.event]?.(row);
        if (!built || built.skip) return finish('cancelled', built?.skip || 'Unknown message');
        const facts = {
            ...built.facts, company: COMPANY,
            vendor_name: (v.contact_person || v.name).split(/\s+/)[0] || v.name,
            phone: `91${v.phone}`, name: v.name, first_name: v.name, urls: { vendor_page: page },
        };
        const sent = await auto.fire(line.id, row.event, row.ref, facts, { label: `${v.name}${built.label ? ` · ${built.label}` : ''}`, force, template });
        if (!sent) return finish('skipped', 'Switched off, or this exact message was already sent');
        return finish(sent.status === 'sent' ? 'sent' : 'failed', sent.error || null);
    } catch (err) {
        console.error(`vendor wa ${row.event} ${row.ref}:`, err.message);
        return finish('failed', err.message);
    }
}

/** At 10 am (India), a reminder for each unpaid instalment due tomorrow — once per instalment and date. */
async function instalmentTick() {
    const ist = new Date(Date.now() + 5.5 * 3600e3);
    if (ist.getUTCHours() !== 10) return;
    const tomorrow = new Date(ist.getTime() + 86400e3).toISOString().slice(0, 10);
    const rows = (await db.query(
        `SELECT i.id, i.order_id, o.vendor_id, TO_CHAR(i.due_date, 'YYYY-MM-DD') AS due
         FROM vendor_order_instalments i JOIN vendor_orders o ON o.id = i.order_id
         WHERE i.due_kind = 'date' AND i.due_date = $1 AND o.vendor_id IS NOT NULL`, [tomorrow])).rows;
    for (const r of rows) {
        await enqueue({ event: 'vendor_instalment_due', vendorId: r.vendor_id, ref: `instalment:${r.id}:${r.due}`, now: true, user: 'reminder' });
    }
}

/** What is waiting to go to this vendor, and what went recently — for the vendor's page in the CRM. */
async function forVendor(vendorId) {
    return (await db.query(
        `SELECT q.id, q.event, q.ref, q.status, q.error, q.send_after, q.done_at, q.created_by, q.created_at
         FROM vendor_wa_queue q WHERE q.vendor_id = $1
         ORDER BY (q.status = 'queued') DESC, COALESCE(q.done_at, q.created_at) DESC LIMIT 15`, [vendorId])).rows
        .map(r => ({ ...r, label: auto.EVENTS.find(e => e.key === r.event)?.label || r.event }));
}

/** Send a queued message now, or not at all. */
async function act(id, vendorId, action) {
    const sql = action === 'send'
        ? `UPDATE vendor_wa_queue SET send_after = CURRENT_TIMESTAMP WHERE id = $1 AND vendor_id = $2 AND status = 'queued' RETURNING id`
        : `UPDATE vendor_wa_queue SET status = 'cancelled', error = 'Stopped by hand', done_at = CURRENT_TIMESTAMP WHERE id = $1 AND vendor_id = $2 AND status = 'queued' RETURNING id`;
    const r = await db.query(sql, [id, vendorId]);
    if (r.rows.length && action === 'send') await tick();
    return r.rows.length > 0;
}

/**
 * The template a message would go with: the one chosen on the Automations page, else the CRM's own
 * for the event if Meta has it. Returns { key, status } or null.
 */
async function templateOf(lineId, event) {
    const cfg = (await auto.config(lineId)).events[event];
    const set = require('./nl-template-set').byEvent(event);
    const key = cfg?.template || (set ? `${set.name}|en` : null);
    if (!key) return null;
    const [name, language] = key.split('|');
    const t = (await db.query('SELECT status FROM wa_templates WHERE line_id = $1 AND name = $2 AND language = $3', [lineId, name, language])).rows[0];
    return t ? { key, name, status: t.status } : { key, name, status: null };
}

/** Can this message be sent by hand to this vendor right now? { ready, reason }. */
async function canSend(event, vendorId) {
    const line = normless();
    if (!line?.id) return { ready: false, reason: 'Normless WhatsApp isn’t connected' };
    const v = (await db.query('SELECT phone, active, portal_token, portal_enabled FROM vendors WHERE id = $1', [vendorId])).rows[0];
    if (!v) return { ready: false, reason: 'Vendor not found' };
    if (!/^\d{10}$/.test(String(v.phone || ''))) return { ready: false, reason: 'Add the vendor’s WhatsApp number first' };
    if (v.portal_token && !v.portal_enabled) return { ready: false, reason: 'Their link is switched off — the message’s button opens it' };
    const t = await templateOf(line.id, event);
    if (!t?.status) return { ready: false, reason: 'The vendor template isn’t at Meta yet — submit it in WhatsApp → Settings → Templates → Vendors', setup: true };
    if (t.status !== 'APPROVED') return { ready: false, reason: `The template ${t.name} is ${String(t.status).toLowerCase()} at Meta — it can be sent once approved`, setup: true };
    return { ready: true };
}

/**
 * Send a vendor message now, by hand, from the Normless number — no hold, and whether or not the
 * automatic message is switched on. Returns { sent: true } or { sent: false, reason }.
 */
async function sendNow({ event, vendorId, ref, note = null, user = null }) {
    const check = await canSend(event, vendorId);
    if (!check.ready) return { sent: false, reason: check.reason, setup: !!check.setup };
    const line = normless();
    const t = await templateOf(line.id, event);
    // A ref of its own each time, so a message can be sent again by hand.
    const own = `${ref}:manual:${Date.now()}`;
    const row = (await db.query(
        `INSERT INTO vendor_wa_queue (vendor_id, event, ref, note, send_after, status, created_by)
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, 'queued', $5) RETURNING *`, [vendorId, event, own, note, user])).rows[0];
    const result = await sendRow(line, row, { force: true, template: t.key });
    return result.status === 'sent' ? { sent: true } : { sent: false, reason: result.error || 'It didn’t go' };
}

/** For the forms: would a message go out for this event to this vendor? */
async function willNotify(event, vendorId) {
    const line = normless();
    if (!line?.id) return false;
    const ev = (await auto.config(line.id)).events[event];
    return !!(ev?.enabled && ev.template && await messageable(vendorId));
}

let timers = [];
function start() {
    let busy = false;
    const guard = (fn) => async () => {
        if (busy) return;
        busy = true;
        try { await fn(); } catch (err) { console.error('vendor wa:', err.message); } finally { busy = false; }
    };
    timers.push(setInterval(guard(tick), 60 * 1000));
    timers.push(setInterval(guard(instalmentTick), 30 * 60 * 1000));
    timers.forEach(t => t.unref());
}

module.exports = { enqueue, tick, instalmentTick, forVendor, act, willNotify, start, pageFor, sendNow, canSend };
