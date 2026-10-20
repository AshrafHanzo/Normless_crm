/**
 * Crewfit order messages, sent through the WhatsApp Business API.
 *
 * The order drawer has always had the wording for every step of an order — the summary with the
 * advance link, the balance request, the tracking details, the invoices — but each one went out
 * by opening a wa.me link and pasting it on somebody's phone, and a PDF had to be downloaded and
 * attached by hand. Now that the number is on the API, the CRM sends them itself: the text, the
 * Razorpay link made on the spot, and the proforma or tax invoice as a real attachment.
 *
 * Four of them can go out on their own, each switched on separately in Settings › Order
 * messages, and all off until somebody turns them on:
 *
 *   advance paid        → thanks, production has started, proforma attached
 *   production complete → the production photos, then the balance link
 *   balance paid        → the tax invoice
 *   dispatched          → the tracking details
 *
 * WhatsApp's 24-hour rule still applies. Inside the window the full message goes; outside it,
 * only an approved template can, so each message can name the template to fall back on. With
 * none named, the send is refused and says why rather than failing at Meta.
 *
 * The wording mirrors the order drawer's own builders (CrewfitOrderDrawer.jsx) so a customer
 * reads the same thing whichever way it was sent.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db/connection');
const wa = require('./whatsapp');

const safeJson = (v, fallback) => {
    try { return typeof v === 'string' ? (JSON.parse(v || 'null') ?? fallback) : (v || fallback); }
    catch { return fallback; }
};
const inr = (v) => `₹${Number(v || 0).toLocaleString('en-IN')}`;
const dash = (v) => (v === undefined || v === null || v === '' ? '—' : v);
const placementOf = (it) => it.printing_placement ?? it.printing ?? '';
const printSpec = (it) => [placementOf(it), it.printing_type].filter(Boolean).join(' · ');
const NO_TRACKING_MOTS = ['Porter', 'Self Pickup'];

/** Every message an order can send, and which of them may go out on their own. */
const MESSAGES = {
    summary: { label: 'Order summary with advance link' },
    advance_link: { label: 'Advance payment link' },
    payment_qr: { label: 'Payment QR code' },
    mockups: { label: 'Design mockups' },
    // On unless somebody switches it off: the shop asked for the proforma to follow the advance.
    advance_received: { label: 'Advance received, with proforma', auto: 'When the advance is paid', autoDefault: true },
    proforma: { label: 'Proforma invoice' },
    photos: { label: 'Production photos' },
    balance_link: { label: 'Balance payment link', auto: 'When production is complete' },
    invoice: { label: 'Tax invoice', auto: 'When the balance is paid' },
    dispatch: { label: 'Tracking details', auto: 'When the order is dispatched' },
};

/**
 * The templates these messages fall back on once a chat is past the 24-hour window — written to
 * be sent to Meta for approval in one go from Settings › Order messages. Utility category: each is
 * about an order the customer placed. Meta refuses a template that starts or ends on a gap, so
 * each one ends on words. Files cannot ride on a text template, so the proforma and invoice carry
 * a link to the PDF instead, and photos and mockups invite a reply (which reopens the window).
 */
const TEMPLATES = {
    summary: {
        name: 'crewfit_order_confirmation',
        body: 'Hi {{1}}, your Crewfit order {{2}} is confirmed for ₹{{3}}. Please pay the 50% advance of ₹{{4}} using this link to begin production: {{5}} Thank you for choosing Crewfit!',
        map: ['first_name', 'order_ref', 'order_total', 'advance_amount', 'payment_link'],
        examples: ['Rahul', 'CF-142', '2,882', '1,441', 'https://rzp.io/rzp/abc123'],
    },
    advance_link: {
        name: 'crewfit_advance_payment',
        body: 'Hi {{1}}, here is the secure link to pay the advance of ₹{{2}} for your Crewfit order {{3}}: {{4}} Production begins as soon as it is paid.',
        map: ['first_name', 'advance_amount', 'order_ref', 'payment_link'],
        examples: ['Rahul', '1,441', 'CF-142', 'https://rzp.io/rzp/abc123'],
    },
    payment_qr: {
        name: 'crewfit_payment_request',
        body: 'Hi {{1}}, a payment of ₹{{2}} is due for your Crewfit order {{3}}. Reply to this message and we will send you the payment QR code and link.',
        map: ['first_name', 'due_amount', 'order_ref'],
        examples: ['Rahul', '1,441', 'CF-142'],
    },
    mockups: {
        name: 'crewfit_mockup_ready',
        body: 'Hi {{1}}, the design mockup for your Crewfit order {{2}} is ready. Reply to this message to see it and share your feedback.',
        map: ['first_name', 'order_ref'],
        examples: ['Rahul', 'CF-142'],
    },
    advance_received: {
        name: 'crewfit_advance_received',
        body: 'Hi {{1}}, we have received your advance of ₹{{2}} for Crewfit order {{3}} and production has started. Your proforma invoice is here: {{4}} Thank you!',
        map: ['first_name', 'advance_amount', 'order_ref', 'document_link'],
        examples: ['Rahul', '1,441', 'CF-142', 'https://ops.normless.store/uploads/whatsapp/outgoing/proforma.pdf'],
    },
    proforma: {
        name: 'crewfit_proforma_invoice',
        body: 'Hi {{1}}, the proforma invoice for your Crewfit order {{2}} is ready. You can view it here: {{3}} Thank you for choosing Crewfit!',
        map: ['first_name', 'order_ref', 'document_link'],
        examples: ['Rahul', 'CF-142', 'https://ops.normless.store/uploads/whatsapp/outgoing/proforma.pdf'],
    },
    photos: {
        name: 'crewfit_production_complete',
        body: 'Hi {{1}}, good news: your Crewfit order {{2}} is production complete. Reply to this message to see the production photos.',
        map: ['first_name', 'order_ref'],
        examples: ['Rahul', 'CF-142'],
    },
    balance_link: {
        name: 'crewfit_balance_payment',
        body: 'Hi {{1}}, your Crewfit order {{2}} is ready for dispatch. Please pay the balance of ₹{{3}} using this link: {{4}} We will dispatch as soon as it is paid.',
        map: ['first_name', 'order_ref', 'balance_amount', 'payment_link'],
        examples: ['Rahul', 'CF-142', '1,441', 'https://rzp.io/rzp/def456'],
    },
    invoice: {
        name: 'crewfit_tax_invoice',
        body: 'Hi {{1}}, thank you for your payment. The tax invoice for your Crewfit order {{2}} is here: {{3}} We hope to serve you again!',
        map: ['first_name', 'order_ref', 'document_link'],
        examples: ['Rahul', 'CF-142', 'https://ops.normless.store/uploads/whatsapp/outgoing/invoice.pdf'],
    },
    dispatch: {
        name: 'crewfit_order_dispatched',
        body: 'Hi {{1}}, your Crewfit order {{2}} has been dispatched via {{3}}. Tracking: {{4}} Thank you for choosing Crewfit!',
        map: ['first_name', 'order_ref', 'courier', 'tracking_url'],
        examples: ['Rahul', 'CF-142', 'ST Courier', 'ST123456'],
    },
};

const PUBLIC_BASE = () => (process.env.PUBLIC_BASE_URL || 'https://ops.normless.store').replace(/\/+$/, '');

class SendError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
}

/* ── Settings ────────────────────────────────────────────────────────────────────────────── */

async function settings() {
    const r = await db.query(`SELECT key, value FROM wa_settings WHERE key LIKE 'auto_%' OR key LIKE 'order_tpl_%' OR key = 'payment_qr'`);
    const out = Object.fromEntries(r.rows.map(x => [x.key, x.value]));
    for (const [key, m] of Object.entries(MESSAGES)) {
        if (m.autoDefault && out[`auto_${key}`] == null) out[`auto_${key}`] = 'true';
    }
    return out;
}

/* ── The wording ─────────────────────────────────────────────────────────────────────────── */

const itemsOf = (order) => (safeJson(order.line_items, []) || []).filter(it => it.product || it.qty);
const ref = (order) => `CF-${order.sl_no}`;
const firstName = (order) => String(order.customer_name || '').trim().split(/\s+/)[0] || 'there';

function summaryText(order, link) {
    const items = itemsOf(order);
    const L = ['Thank you for sharing the details 🙌', '', 'Please review your order confirmation below:', ''];
    items.forEach((it, i) => {
        if (items.length > 1) L.push(`*— Product ${i + 1} —*`);
        L.push(`📦 *Product:* ${dash(it.product)}${it.color ? ` (${it.color})` : ''}`);
        L.push(`👕 *Quantity:* ${dash(it.qty)}`);
        L.push(`💵 *Price Per Piece:* ₹${it.unit_price || 0}`);
        L.push(`🎨 *Printing:* ${dash(printSpec(it))}`);
        L.push(`📏 *Size Breakdown:* ${dash(it.size_breakdown)}`);
        L.push('');
    });
    L.push(`📍 *Delivery Address:* ${dash(order.delivery_location)}`, '');
    L.push(`💵 *Grand Total:* ${inr(order.grand_total)}`);
    L.push(`💳 *Advance Payable (50%):* ${inr(order.advance)}`);
    L.push(`💵 *Balance Payable Before Dispatch:* ${inr(order.balance)}`, '');
    if (link) L.push('Please complete the advance payment using the link below to begin production:', '', `🔗 ${link}`, '');
    L.push('Kindly verify all the above details before making the payment.', '');
    L.push('Production will begin immediately after payment verification. 🚀');
    return L.join('\n');
}

function paymentText(order, payment) {
    const half = payment.kind === 'advance' ? 'advance (50%)' : 'balance';
    return [
        `Hi ${firstName(order)}! 👋`, '',
        `Here's the secure payment link for the ${half} of your Crewfit order (Ref: ${ref(order)}):`, '',
        `💵 *Amount:* ${inr(payment.amount)}`,
        `🔗 ${payment.razorpay_short_url}`, '',
        payment.kind === 'balance'
            ? 'Once this is paid we will dispatch your order right away. 🚚'
            : 'Production begins as soon as this payment is confirmed. 🚀',
        '', 'Thank you for choosing Crewfit! 🙌',
    ].join('\n');
}

function balanceText(order, payment) {
    const grand = Number(order.grand_total) || 0;
    const balance = Number(payment.amount) || 0;
    const L = [`Hi ${firstName(order)}! 🎉`, ''];
    L.push(`Great news — your Crewfit order (Ref: ${ref(order)}) is *production complete* and ready for dispatch! ✅`, '');
    L.push('*— Order Summary —*');
    for (const it of itemsOf(order)) {
        L.push(`📦 ${dash(it.product)}${it.color ? ` (${it.color})` : ''} × ${dash(it.qty)}`);
    }
    L.push('');
    L.push(`💵 *Grand Total:* ${inr(grand)}`);
    L.push(`✅ *Advance Already Paid:* ${inr(Math.max(0, grand - balance))}`);
    L.push(`💰 *Balance Payable Now:* ${inr(balance)}`, '');
    L.push('Kindly complete the balance payment using the secure link below so we can dispatch your order right away:', '');
    L.push(`🔗 ${payment.razorpay_short_url}`, '');
    L.push('Once the payment is confirmed, we will dispatch your order and share the tracking details with you. 🚚');
    return L.join('\n');
}

function advanceReceivedText(order) {
    return [
        `Hi ${firstName(order)}! 🙌`, '',
        `We have received your advance of ${inr(order.advance)} for Crewfit order ${ref(order)}. Production has started. 🚀`,
        ...(order.deadline_at ? ['', `📅 *Expected ready by:* ${String(order.deadline_at).slice(0, 10)}`] : []),
        '', 'The proforma invoice is attached. We will share production photos as soon as your order is ready.',
    ].join('\n');
}

const trackingUrl = (order) => (order.mot === 'ST Courier' && order.tracking_link
    ? `https://trackcourier.io/track-and-trace/st-courier/${String(order.tracking_link).trim()}` : null);

function dispatchText(order) {
    if (NO_TRACKING_MOTS.includes(order.mot)) {
        return [
            `Hi ${firstName(order)}! 🎉`, '',
            order.mot === 'Self Pickup'
                ? `Your Crewfit order (Ref: ${ref(order)}) is packed and ready for pickup.`
                : `Your Crewfit order (Ref: ${ref(order)}) has been dispatched through *Porter*.`,
            '', 'Thank you for choosing Crewfit!',
        ].join('\n');
    }
    const L = [`Hi ${firstName(order)}! 🎉`, '', `Your Crewfit order (Ref: ${ref(order)}) has been dispatched${order.mot ? ` via ${order.mot}` : ''}.`, ''];
    L.push(`📦 *Tracking ID:* ${order.tracking_link || '—'}`);
    if (trackingUrl(order)) L.push(`🔗 *Track your parcel here:* ${trackingUrl(order)}`);
    L.push('', 'Thank you for choosing Crewfit! We hope to serve you again. 🙌');
    return L.join('\n');
}

const mockupsText = (order) => [
    `Hi ${firstName(order)}! 🎨`, '',
    `Above is the design mockup for your Crewfit order (Ref: ${ref(order)}). Please check the placement, colours and spelling, and reply *OK* to approve or tell us what to change.`,
].join('\n');

/** What is due now: the advance until it is paid, then the balance. */
const dueNow = (order) => (order.payment_status === 'Pending' || !order.payment_status
    ? { kind: 'advance', amount: Number(order.advance) || Math.round((Number(order.grand_total) || 0) / 2) }
    : { kind: 'balance', amount: Number(order.balance) || 0 });

const qrText = (order) => {
    const due = dueNow(order);
    return [
        `Hi ${firstName(order)}! 👋`, '',
        `Scan the QR code above to pay the ${due.kind === 'advance' ? 'advance (50%)' : 'balance'} of *${inr(due.amount)}* for your Crewfit order (Ref: ${ref(order)}).`, '',
        '📸 Once paid, please share the *payment screenshot* here so we can confirm it.',
        due.kind === 'advance' ? 'Production begins as soon as the payment is confirmed. 🚀' : 'We will dispatch your order once the payment is confirmed. 🚚',
    ].join('\n');
};

const photosText = (order) => [
    `Hi ${firstName(order)}! 👕`, '',
    // Production is finished by now, so nothing here invites changes — it reports, it does not ask.
    `Your Crewfit order (Ref: ${ref(order)}) is production complete ✅ Above are the photos of your finished order.`,
].join('\n');

/* ── The pieces a message needs ──────────────────────────────────────────────────────────── */

/** The open payment link for one half of an order, made at Razorpay if there is none. */
async function ensureLink(order, kind, user) {
    const existing = (await db.query(
        `SELECT * FROM crewfit_payments WHERE order_id = $1 AND kind = $2 AND status IN ('Created','Paid')
          ORDER BY id DESC LIMIT 1`, [order.id, kind])).rows[0];
    if (existing?.status === 'Paid') throw new SendError(`The ${kind} for ${ref(order)} is already paid`);
    if (existing) return existing;

    const razorpay = require('../config/razorpay');
    if (!razorpay.isConfigured) throw new SendError(`Razorpay is not configured, so no ${kind} link can be made`, 503);
    const grand = Number(order.grand_total) || 0;
    if (!grand) throw new SendError(`${ref(order)} has no total yet — add products and save it first`);
    const advance = order.advance != null ? Number(order.advance) : Math.round(grand / 2);
    const balance = order.balance != null ? Number(order.balance) : grand - advance;
    const { createLink, KIND_LABEL } = require('../routes/crewfit-payments');
    return createLink({
        order_id: order.id, kind,
        customer_name: order.billing_name || order.customer_name,
        contact_number: order.whatsapp_number || order.billing_mobile || order.contact_number,
        email: order.billing_email,
        amount: kind === 'advance' ? advance : balance,
        description: `Crewfit order ${ref(order)} — ${KIND_LABEL[kind]}`,
        created_by: user || 'whatsapp',
    });
}

const OUT_DIR = path.join(__dirname, '..', 'uploads', 'whatsapp', 'outgoing');

/** The proforma or tax invoice, issued if need be and saved where the media sender can read it. */
async function documentFile(order, alias) {
    const { orderDocumentBuffer } = require('../routes/crewfit');
    let doc;
    try { doc = await orderDocumentBuffer(order.id, alias); }
    catch (err) { throw new SendError(err.message, err.status || 500); }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const stored = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}.pdf`;
    fs.writeFileSync(path.join(OUT_DIR, stored), doc.buffer);
    return { path: path.join(OUT_DIR, stored), url: `/uploads/whatsapp/outgoing/${stored}`, mime: 'application/pdf', filename: doc.filename, number: doc.row.number };
}

/** Order photos on disk — production photos, or the design mockups — at most ten. */
function photoFiles(order, field = 'prodImages') {
    const root = path.join(__dirname, '..');
    const files = [];
    for (const it of itemsOf(order)) {
        for (const url of it[field] || []) {
            const p = path.join(root, String(url).replace(/^\/+/, ''));
            // Only ever a file under uploads: a stored URL is data, not a path to trust.
            if (!p.startsWith(path.join(root, 'uploads') + path.sep) || !fs.existsSync(p)) continue;
            const ext = path.extname(p).toLowerCase();
            files.push({ path: p, url, mime: ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg', filename: path.basename(p) });
        }
    }
    return files.slice(0, 10);
}

/* ── The conversation an order talks through ─────────────────────────────────────────────── */

/**
 * The thread with the order's customer, made if they have never messaged us.
 *
 * Also ties the order to the enquiry when it was raised outside the inbox, so the lead panel
 * lists it and the timeline picks up its payments.
 */
async function threadForOrder(order) {
    const phone = wa.normalisePhone(order.whatsapp_number || order.contact_number || order.billing_mobile);
    if (!phone) throw new SendError(`${ref(order)} has no WhatsApp number`);
    return db.transaction(async (c) => {
        const contact = (await c.query(
            `INSERT INTO wa_contacts (line_id, phone, profile_name) VALUES ((SELECT id FROM wa_lines WHERE brand = 'crewfit'), $1, $2)
             ON CONFLICT (line_id, phone) DO UPDATE SET profile_name = COALESCE(wa_contacts.profile_name, EXCLUDED.profile_name)
             RETURNING id, phone, lead_id`, [phone, order.customer_name || null])).rows[0];
        let leadId = order.wa_lead_id || contact.lead_id;
        if (!leadId) {
            leadId = (await c.query(
                `INSERT INTO crewfit_leads (name, company, phone, source, status)
                 VALUES ($1, $2, $3, 'order',
                         COALESCE((SELECT key FROM wa_lead_statuses WHERE stage = 'won' ORDER BY sort_order LIMIT 1), 'new'))
                 RETURNING id`, [order.customer_name, order.billing_name, phone])).rows[0].id;
        }
        if (!contact.lead_id) await c.query('UPDATE wa_contacts SET lead_id = $2 WHERE id = $1', [contact.id, leadId]);
        if (!order.wa_lead_id) await c.query('UPDATE crewfit_orders SET wa_lead_id = $2 WHERE id = $1', [order.id, leadId]);
        const conv = (await c.query(
            `INSERT INTO wa_conversations (contact_id, last_message_at, line_id)
             VALUES ($1, CURRENT_TIMESTAMP, (SELECT id FROM wa_lines WHERE brand = 'crewfit'))
             ON CONFLICT (contact_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
             RETURNING *`, [contact.id])).rows[0];
        return { ...conv, phone };
    });
}

/* ── Activity ─────────────────────────────────────────────────────────────────────────────── */

async function logActivity({ conversationId = null, orderId = null, kind, body, actor = null, detail = null }) {
    try {
        if (!conversationId && orderId) {
            const o = (await db.query('SELECT whatsapp_number, contact_number, billing_mobile FROM crewfit_orders WHERE id = $1', [orderId])).rows[0];
            const phone = o && wa.normalisePhone(o.whatsapp_number || o.contact_number || o.billing_mobile);
            if (phone) {
                conversationId = (await db.query(
                    `SELECT c.id FROM wa_conversations c JOIN wa_contacts k ON k.id = c.contact_id
                      WHERE k.phone = $1 AND k.line_id = (SELECT id FROM wa_lines WHERE brand = 'crewfit')`,
                    [phone])).rows[0]?.id || null;
            }
        }
        if (!conversationId) return;
        await db.query(
            `INSERT INTO wa_activity (conversation_id, order_id, kind, body, actor, detail) VALUES ($1,$2,$3,$4,$5,$6)`,
            [conversationId, orderId, kind, body, actor, detail]);
    } catch (err) {
        console.error('whatsapp activity log failed:', err.message);
    }
}

/* ── Sending ──────────────────────────────────────────────────────────────────────────────── */

/** What fills a template's gaps for an order message sent outside the window. */
function templateValue(source, ctx) {
    const { order, payment } = ctx;
    switch (source) {
        case 'first_name': return firstName(order);
        case 'name': return order.customer_name || '';
        case 'company': return order.billing_name || '';
        case 'order_ref': return ref(order);
        case 'order_total': return Number(order.grand_total || 0).toLocaleString('en-IN');
        case 'advance_amount': return Number(order.advance || 0).toLocaleString('en-IN');
        case 'balance_amount': case 'balance_due': return Number(order.balance || 0).toLocaleString('en-IN');
        case 'payment_link': return payment?.razorpay_short_url || '';
        case 'tracking_id': return order.tracking_link || 'shared separately';
        case 'tracking_url': return trackingUrl(order) || order.tracking_link || 'shared separately';
        case 'courier': return order.mot || 'courier';
        case 'due_amount': return Number(dueNow(order).amount || 0).toLocaleString('en-IN');
        case 'document_link': return ctx.fileUrl ? `${PUBLIC_BASE()}${ctx.fileUrl}` : '';
        case 'product': return itemsOf(order).map(it => it.product).filter(Boolean).join(', ');
        case 'quantity': return String(itemsOf(order).reduce((n, it) => n + (parseInt(it.qty, 10) || 0), 0) || '');
        case 'agent_name': return String(ctx.user || '').split('@')[0];
        default: return '';
    }
}

async function record(conv, { wamid, type, body, user, auto, media }) {
    const row = (await db.query(
        `INSERT INTO wa_messages (conversation_id, wamid, direction, sender_type, sender_user, type, body,
                                  media_url, media_mime, media_name, status)
         VALUES ($1,$2,'out',$3,$4,$5,$6,$7,$8,$9,'sent')
         RETURNING id, wamid, direction, sender_type, sender_user, type, body, media_url,
                   media_mime, media_name, status, error, sent_at`,
        [conv.id, wamid, auto ? 'auto' : 'user', auto ? null : user || null, type, body,
            media?.url || null, media?.mime || null, media?.filename || null])).rows[0];
    await db.query(
        `UPDATE wa_conversations SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = $2,
                status = 'open', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [conv.id, String(body || media?.filename || 'Sent a file').slice(0, 200)]);
    return row;
}

/**
 * Send one order message. Returns the messages written to the thread.
 *
 * `auto` marks a send the CRM made on its own, which shows as such in the thread and the log.
 */
// A send in flight, or one finished moments ago, by order and message. A second click while the
// first is still uploading a PDF would otherwise send the customer the same link twice.
const recent = new Map();
const AGAIN_AFTER_MS = 3 * 1000;

async function send(orderId, kind, opts = {}) {
    const key = `${orderId}:${kind}`;
    const last = recent.get(key);
    if (last === 'sending') throw new SendError('That is already being sent — it will show in the chat in a moment', 409);
    // A repeat within a couple of seconds is a double click, not a decision to send it again.
    if (last && Date.now() - last < AGAIN_AFTER_MS) throw new SendError(`${MESSAGES[kind]?.label || 'That'} was sent a moment ago`, 409);
    recent.set(key, 'sending');
    try {
        const out = await sendOnce(orderId, kind, opts);
        recent.set(key, Date.now());
        return out;
    } catch (err) {
        recent.delete(key);
        throw err;
    }
}

async function sendOnce(orderId, kind, { user = null, auto = false } = {}) {
    if (!MESSAGES[kind]) throw new SendError('Unknown order message');
    if (!wa.configured()) throw new SendError('WhatsApp is not configured on this server', 503);
    const order = (await db.query('SELECT * FROM crewfit_orders WHERE id = $1', [orderId])).rows[0];
    if (!order) throw new SendError('Order not found', 404);
    const conv = await threadForOrder(order);
    const open = wa.windowOpen(conv.last_inbound_at);

    // What the message is made of. Links and documents are made before anything is sent, so a
    // refusal (no total yet, not paid yet) stops the send whole rather than half-way.
    let text = null;
    let files = [];
    let payment = null;
    let caption = '';
    if (kind === 'summary') {
        payment = await ensureLink(order, 'advance', user).catch((err) => {
            if (err.status === 503) return null;     // no Razorpay: the summary still goes, without a link
            throw err;
        });
        text = summaryText(order, payment?.razorpay_short_url);
    } else if (kind === 'advance_link' || kind === 'balance_link') {
        payment = await ensureLink(order, kind === 'advance_link' ? 'advance' : 'balance', user);
        text = kind === 'balance_link' ? balanceText(order, payment) : paymentText(order, payment);
    } else if (kind === 'advance_received') {
        text = advanceReceivedText(order);
        files = [await documentFile(order, 'proforma')];
    } else if (kind === 'proforma' || kind === 'invoice') {
        const file = await documentFile(order, kind === 'proforma' ? 'proforma' : 'final');
        files = [file];
        caption = kind === 'proforma'
            ? `Proforma invoice ${file.number} for your Crewfit order ${ref(order)}.`
            : `Tax invoice ${file.number} for your Crewfit order ${ref(order)} — ${inr(order.grand_total)}, paid in full. Thank you!`;
    } else if (kind === 'photos') {
        files = photoFiles(order);
        if (!files.length) throw new SendError(`${ref(order)} has no production photos uploaded yet`);
        text = photosText(order);
    } else if (kind === 'mockups') {
        files = photoFiles(order, 'mockImages');
        if (!files.length) throw new SendError(`${ref(order)} has no design mockups uploaded yet`);
        text = mockupsText(order);
    } else if (kind === 'payment_qr') {
        const qr = await qrFile();
        if (!qr) throw new SendError('No payment QR has been uploaded yet — add it in WhatsApp settings › Order messages');
        if (order.payment_status === 'Fully Paid') throw new SendError(`${ref(order)} is already fully paid`);
        files = [qr];
        caption = qrText(order);
    } else if (kind === 'dispatch') {
        if (!order.tracking_link && !NO_TRACKING_MOTS.includes(order.mot)) throw new SendError(`${ref(order)} has no tracking ID yet`);
        text = dispatchText(order);
    }

    const sent = [];
    try {
        if (!open) {
            // Outside the window only a template can go, and only if one was chosen for this.
            const s = await settings();
            const tplId = s[`order_tpl_${kind}`];
            const t = tplId && (await db.query(`SELECT * FROM wa_templates WHERE id = $1 AND line_id = (SELECT id FROM wa_lines WHERE brand = 'crewfit')`, [tplId])).rows[0];
            if (t && t.status !== 'APPROVED') {
                throw new SendError(`${ref(order)}: the chat is past WhatsApp’s 24-hour window, and the template “${t.name}” is still ${String(t.status || 'pending').toLowerCase()} at Meta. Sync templates once Meta approves it, or wait for the customer to write.`, 409);
            }
            if (!t) {
                throw new SendError(`${ref(order)}: the chat is past WhatsApp’s 24-hour window. Pick an approved template for “${MESSAGES[kind].label}” in WhatsApp settings › Order messages, or wait for the customer to write.`, 409);
            }
            const map = safeJson(t.var_map, []);
            const variables = Array.from({ length: t.variables }, (_, i) => templateValue(map[i], { order, payment, user, fileUrl: files[0]?.url }));
            if (variables.some(v => !String(v).trim())) {
                throw new SendError(`The template “${t.name}” has a gap this order cannot fill — check what each gap is filled from in Settings › Templates`);
            }
            const wamid = await wa.sendTemplate(conv.phone, { name: t.name, language: t.language, variables });
            sent.push(await record(conv, { wamid, type: 'template', body: wa.renderTemplate(t.body_text, variables), user, auto }));
        } else {
            for (const [i, f] of files.entries()) {
                const out = await wa.sendMedia(conv.phone, { filePath: f.path, mime: f.mime, filename: f.filename, caption: i === 0 ? caption : '' });
                sent.push(await record(conv, { wamid: out.wamid, type: out.kind, body: i === 0 ? caption : null, user, auto, media: f }));
            }
            if (text) {
                const wamid = await wa.sendText(conv.phone, text);
                sent.push(await record(conv, { wamid, type: 'text', body: text, user, auto }));
            }
        }
    } catch (err) {
        if (err instanceof wa.WhatsAppError) throw new SendError(err.message, 502);
        throw err;
    }

    // The order remembers what went, as the drawer's own buttons did.
    if (payment) await db.query('UPDATE crewfit_payments SET sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [payment.id]);
    if (kind === 'dispatch') await db.query('UPDATE crewfit_orders SET tracking_sent_at = CURRENT_TIMESTAMP WHERE id = $1', [order.id]);
    if (kind === 'photos') await db.query('UPDATE crewfit_orders SET photos_sent_at = CURRENT_TIMESTAMP WHERE id = $1', [order.id]);
    await logActivity({
        conversationId: conv.id, orderId: order.id, kind: 'message', actor: auto ? null : user, detail: kind,
        body: `${auto ? 'Sent automatically' : 'Sent'}: ${MESSAGES[kind].label} for ${ref(order)}${open ? '' : ' (as a template)'}`,
    });
    return { conversationId: conv.id, messages: sent };
}

/** The shop's payment QR, uploaded once in Settings › Order messages. */
async function qrFile() {
    const s = await settings();
    if (!s.payment_qr) return null;
    const p = path.join(__dirname, '..', String(s.payment_qr).replace(/^\/+/, ''));
    if (!p.startsWith(path.join(__dirname, '..', 'uploads') + path.sep) || !fs.existsSync(p)) return null;
    return { path: p, url: s.payment_qr, mime: 'image/jpeg', filename: 'Crewfit-payment-QR.jpg' };
}

/**
 * Send every Crewfit template to Meta for approval, and point each order message at its own.
 * Ones already on the account are left alone and just linked. Returns what happened to each.
 */
async function submitTemplates(user) {
    const out = [];
    for (const [kind, t] of Object.entries(TEMPLATES)) {
        const existing = (await db.query(`SELECT id, status FROM wa_templates WHERE name = $1 AND language = 'en' AND line_id = (SELECT id FROM wa_lines WHERE brand = 'crewfit')`, [t.name])).rows[0];
        let id = existing?.id;
        if (!existing) {
            try {
                const made = await wa.createTemplate({ name: t.name, language: 'en', category: 'UTILITY', body: t.body, examples: t.examples });
                const vars = new Set((t.body.match(/\{\{\s*(\d+)\s*\}\}/g) || [])).size;
                id = (await db.query(
                    `INSERT INTO wa_templates (name, language, category, status, body_text, variables, var_map, synced_at, line_id)
                     VALUES ($1,'en','UTILITY',$2,$3,$4,$5,CURRENT_TIMESTAMP,(SELECT id FROM wa_lines WHERE brand = 'crewfit'))
                     ON CONFLICT (line_id, name, language) DO UPDATE SET status = EXCLUDED.status, body_text = EXCLUDED.body_text,
                         variables = EXCLUDED.variables, var_map = EXCLUDED.var_map
                     RETURNING id`, [t.name, made.status || 'PENDING', t.body, vars, JSON.stringify(t.map)])).rows[0].id;
                out.push({ kind, name: t.name, result: 'submitted' });
            } catch (err) {
                out.push({ kind, name: t.name, result: 'failed', error: err.message });
                continue;
            }
        } else {
            await db.query(`UPDATE wa_templates SET var_map = COALESCE(var_map, $2) WHERE id = $1`, [id, JSON.stringify(t.map)]);
            out.push({ kind, name: t.name, result: `already on the account (${String(existing.status || '').toLowerCase()})` });
        }
        await db.query(
            `INSERT INTO wa_settings (key, value, updated_by, updated_at) VALUES ($1,$2,$3,CURRENT_TIMESTAMP)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`,
            [`order_tpl_${kind}`, String(id), user || null]);
    }
    return out;
}

/* ── Sending on its own ──────────────────────────────────────────────────────────────────── */

async function autoSend(orderId, kind) {
    const s = await settings();
    if (s[`auto_${kind}`] !== 'true') return;
    try {
        await send(orderId, kind, { auto: true });
    } catch (err) {
        // Nobody is waiting on this send, so the thread's timeline is where a refusal shows.
        console.error(`whatsapp auto ${kind} for order ${orderId}:`, err.message);
        await logActivity({ orderId, kind: 'error', body: `Could not send “${MESSAGES[kind].label}” automatically: ${err.message}` });
    }
}

/** An order was created or saved. Called without awaiting by the order routes. */
function orderChanged(before, after, user) {
    (async () => {
        if (!after) return;
        if (!before) {
            await logActivity({ orderId: after.id, kind: 'order', actor: user, body: `Order CF-${after.sl_no} created — ${inr(after.grand_total)}` });
            return;
        }
        if (before.status !== after.status) {
            await logActivity({ orderId: after.id, kind: 'order', actor: user, body: `CF-${after.sl_no} moved to ${after.status}` });
        }
        if (before.status !== 'Dispatched' && after.status === 'Dispatched') await autoSend(after.id, 'dispatch');
        // A payment recorded by hand (UPI, the QR, a bank transfer) is the same event as one that
        // came through Razorpay, and the customer should hear the same thing.
        if (before.payment_status === 'Pending' && after.payment_status === '50% Paid') {
            await logActivity({ orderId: after.id, kind: 'payment', actor: user, body: `Advance recorded for CF-${after.sl_no}` });
            await autoSend(after.id, 'advance_received');
        }
        if (before.payment_status !== 'Fully Paid' && after.payment_status === 'Fully Paid') {
            await logActivity({ orderId: after.id, kind: 'payment', actor: user, body: `Balance recorded for CF-${after.sl_no}` });
            await autoSend(after.id, 'invoice');
        }
        if (before.status !== 'Ready for Dispatch' && after.status === 'Ready for Dispatch' && after.payment_status !== 'Fully Paid') {
            const s = await settings();
            if (s.auto_balance_link === 'true' && photoFiles(after).length) {
                await send(after.id, 'photos', { auto: true }).catch(err => console.error('whatsapp auto photos:', err.message));
            }
            await autoSend(after.id, 'balance_link');
        }
    })().catch(err => console.error('whatsapp order hook:', err.message));
}

/** A Razorpay payment settled. Called without awaiting by settlePayment. */
function paymentSettled(payment) {
    (async () => {
        if (!payment?.order_id) return;
        const o = (await db.query('SELECT sl_no FROM crewfit_orders WHERE id = $1', [payment.order_id])).rows[0];
        await logActivity({
            orderId: payment.order_id, kind: 'payment',
            body: `${inr(payment.amount)} ${payment.kind === 'advance' ? 'advance' : payment.kind === 'balance' ? 'balance' : 'payment'} received for CF-${o?.sl_no}`,
        });
        if (payment.kind === 'advance') await autoSend(payment.order_id, 'advance_received');
        if (payment.kind === 'balance') await autoSend(payment.order_id, 'invoice');
    })().catch(err => console.error('whatsapp payment hook:', err.message));
}

module.exports = { MESSAGES, TEMPLATES, SendError, send, submitTemplates, orderChanged, paymentSettled, logActivity, threadForOrder };
