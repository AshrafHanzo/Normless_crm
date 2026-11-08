/**
 * The mockup, from the designer to an order.
 *
 * The designer uploads the mockup in the chat and sends it for approval: the pictures, then a
 * message with two buttons — ✅ Confirm mockup and ✏️ Need changes. Outside WhatsApp's 24-hour
 * window the approved template crewfit_mockup_confirm carries the first mockup and the same two
 * buttons instead.
 *
 * Confirm: the order is raised from what the lead holds — each product with its colour, quantity
 * and the catalogue price for that quantity, the branding, the billing details — and the customer
 * gets the order summary with the 50% advance link. If something can't be priced or counted (a
 * quantity given as a range, a product priced on request), nothing is guessed: the customer is
 * thanked and the chat waits for a person, with a note saying what is missing.
 *
 * The lead stays at Need mockup while the mockup is with the customer: Confirm moves it to Mock
 * completed; Need changes keeps it at Need mockup and asks the customer what to change.
 */

const db = require('../db/connection');
const wa = require('./whatsapp');
const rules = require('./cf-lead-rules');
const { EMBROIDERY_EXTRA } = require('./crewfit-charges');

const CONFIRM = 'mock_ok';
const CHANGES = 'mock_change';
const TEMPLATE = 'crewfit_mockup_confirm';
// Past the 24-hour window: "your mockup is ready — tap or reply and we'll send it". Its button
// sends this back; any reply does the same.
const READY_TEMPLATE = 'crewfit_mockup_ready_reply';
const SEND_PENDING = 'mock_send';
// How long mockups waiting for the customer's reply still go out when they write.
const PENDING_DAYS = 14;
const MOCK_DIR = require('path').join(__dirname, '..', 'uploads', 'whatsapp', 'mockups');
const GST_PCT = 5;
const DIGITISING = 800;
const PUBLIC_BASE = () => (process.env.PUBLIC_BASE_URL || 'https://ops.normless.store').replace(/\/+$/, '');
const safeJson = (v, f) => { try { return typeof v === 'string' ? (JSON.parse(v || 'null') ?? f) : (v ?? f); } catch { return f; } };
const soName = (u) => { const n = String(u || '').split('@')[0].replace(/[._-]+/g, ' ').trim(); return n ? n.replace(/\b\w/g, c => c.toUpperCase()) : ''; };

async function record(conversationId, { wamid, body, type = 'text', user = null, senderType = 'user', payload = null }) {
    await db.query(
        `INSERT INTO wa_messages (conversation_id, wamid, direction, sender_type, sender_user, type, body, interactive_payload, status)
         VALUES ($1,$2,'out',$3,$4,$5,$6,$7,'sent')`, [conversationId, wamid, senderType, user, type, body, payload ? JSON.stringify(payload) : null]);
    await db.query(`UPDATE wa_conversations SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [conversationId, String(body).slice(0, 200)]);
}
const note = (conversationId, body, detail = null) => db.query(`INSERT INTO wa_activity (conversation_id, kind, body, detail) VALUES ($1,'status',$2,$3)`, [conversationId, body, detail]);

async function setStatus(leadId, conversationId, key, why) {
    const s = (await db.query('SELECT name FROM wa_lead_statuses WHERE key = $1', [key])).rows[0];
    if (!s || !leadId) return;
    const r = await db.query('UPDATE crewfit_leads SET status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status IS DISTINCT FROM $2', [leadId, key]);
    if (r.rowCount) await note(conversationId, `Marked ${s.name} — ${why}`, key);
}

/**
 * After the mockup pictures went (inside the window): the question with the two buttons. Outside
 * the window: the template, with the first mockup as its picture. `conversation` has id, phone,
 * lead_id, last_inbound_at, lead_name/profile_name.
 */
async function askForApproval(conversation, { mockupUrl = null, user = null } = {}) {
    const text = 'Here is your mockup 👆 Please check the logo, its size and position, and the colour.\n\nIs it good to go?';
    if (wa.windowOpen(conversation.last_inbound_at)) {
        const wamid = await wa.sendButtons(conversation.phone, text, [{ id: CONFIRM, title: '✅ Confirm mockup' }, { id: CHANGES, title: '✏️ Need changes' }]);
        await record(conversation.id, { wamid, body: text, type: 'interactive', user, payload: { kind: 'buttons', options: ['✅ Confirm mockup', '✏️ Need changes'] } });
    } else {
        if (!mockupUrl) throw Object.assign(new Error('Upload the mockup first'), { status: 400 });
        const name = String(conversation.lead_name || conversation.profile_name || 'there').split(/\s+/)[0];
        const wamid = await wa.sendTemplate(conversation.phone, {
            name: TEMPLATE, language: 'en',
            headerImage: /^https?:/.test(mockupUrl) ? mockupUrl : `${PUBLIC_BASE()}${mockupUrl}`,
            variables: [name],
            buttons: [{ index: 0, payload: CONFIRM }, { index: 1, payload: CHANGES }],
        });
        await record(conversation.id, { wamid, body: `Mockup sent for approval (template ${TEMPLATE})`, type: 'template', user });
    }
    // The lead stays at Need mockup until the customer confirms it (confirm moves it on).
}

/* ── Pricing ─────────────────────────────────────────────────────────────────────────────── */

function tierRange(label) {
    const t = String(label).replace(/[–—]/g, '-');
    const plus = t.match(/^(\d+)\s*\+$/);
    if (plus) return [Number(plus[1]), Infinity];
    const pair = t.match(/^(\d+)\s*-\s*(\d+)$/);
    return pair ? [Number(pair[1]), Number(pair[2])] : null;
}

/** The catalogue's price a piece for this many of this product, or null when it is "on request". */
async function unitPrice(productName, qty) {
    const p = (await db.query('SELECT tiers FROM crewfit_products WHERE LOWER(name) = LOWER($1) LIMIT 1', [productName])).rows[0];
    if (!p) return null;
    for (const [label, price] of safeJson(p.tiers, [])) {
        const r = tierRange(label);
        if (r && qty >= r[0] && qty <= r[1]) return typeof price === 'number' ? price : null;
    }
    return null;
}

/* ── The order ───────────────────────────────────────────────────────────────────────────── */

/**
 * The order this lead's chat describes, or why it can't be made yet: { body } or { missing: [...] }.
 */
async function orderFromLead(conversation, lead) {
    const items = rules.itemsOf(lead);
    const missing = [];
    if (!items.length) missing.push('the products');
    // The design mock: the mockups picked for the order, or failing that every one that was sent.
    const sent = (await db.query('SELECT url, for_order FROM wa_mockups WHERE conversation_id = $1 AND (sent_at IS NOT NULL OR for_order) ORDER BY id', [conversation.id])).rows;
    const mockups = (sent.some(r => r.for_order) ? sent.filter(r => r.for_order) : sent).map(r => r.url);
    const embroidery = /embroid/i.test(lead.branding || '');
    const lines = [];
    for (const it of items) {
        const qty = rules.pieces(it.quantity);
        if (!qty || !/^\s*\d+\s*(pcs|pieces)?\s*$/i.test(String(it.quantity))) { missing.push(`the exact quantity of ${it.product}`); continue; }
        let unit = await unitPrice(it.product, qty);
        // The catalogue price is the printed one; embroidery is more a piece.
        if (unit != null && embroidery) unit += EMBROIDERY_EXTRA;
        // One product, priced on request, and somebody already quoted a total: that total it is.
        if (unit == null && items.length === 1 && Number(lead.quoted_amount) > 0) unit = Math.round(Number(lead.quoted_amount) / qty);
        if (unit == null) { missing.push(`a price for ${qty} × ${it.product}`); continue; }
        lines.push({
            product: it.product, color: it.color || '', qty, unit_price: unit, product_total: unit * qty,
            printing_placement: 'Front', printing_type: embroidery ? 'Embroidery' : 'DTF', size_breakdown: '',
            mockImages: mockups,
        });
    }
    if (missing.length) return { missing };

    const productTotal = lines.reduce((n, l) => n + l.product_total, 0);
    const designer = embroidery ? DIGITISING : 0;
    const gst = Math.round((productTotal + designer) * GST_PCT / 100);
    const grand = productTotal + designer + gst;
    const advance = Math.round(grand / 2);
    const phone10 = String(conversation.phone || '').slice(-10);
    return {
        body: {
            customer_name: lead.billing_name || lead.name || conversation.profile_name || phone10,
            contact_number: phone10, whatsapp_number: phone10,
            contact_person: lead.contact_person || lead.name || conversation.profile_name || '',
            billing_name: lead.billing_name || '', billing_address: lead.billing_address || '',
            billing_mobile: lead.billing_mobile || '', billing_email: lead.billing_email || '',
            gst_number: /^na$/i.test(lead.gst_number || '') ? '' : (lead.gst_number || ''),
            delivery_location: lead.delivery_address || lead.billing_address || '',
            line_items: lines,
            product: lines.map(l => l.product).join(', '), color: lines.map(l => l.color).filter(Boolean).join(', '),
            qty: lines.reduce((n, l) => n + l.qty, 0), unit_price: lines.length === 1 ? lines[0].unit_price : '',
            printing_type: embroidery ? 'Embroidery' : 'Printing',
            product_total: productTotal, designer_charge: designer, shipping: 0, gst_amount: gst,
            grand_total: grand, total_cost: grand, advance, balance: grand - advance,
            layout_status: 'Done', status: 'Awaiting Payment', payment_status: 'Pending',
            so: soName(conversation.assigned_to),
            notes: 'Created on WhatsApp when the customer confirmed the mockup.',
            wa_lead_id: lead.id,
        },
    };
}

/** ✅ Confirm: raise the order and send its summary with the advance link. */
async function confirm(conversation) {
    const lead = (await db.query('SELECT * FROM crewfit_leads WHERE id = $1', [conversation.lead_id])).rows[0];
    if (!lead) return;
    await note(conversation.id, 'The customer confirmed the mockup');
    await setStatus(lead.id, conversation.id, 'mock_completed', 'the customer confirmed the mockup');
    // Already raised (a second tap, or a person got there first): send its summary again.
    const existing = (await db.query(
        `SELECT id, sl_no FROM crewfit_orders WHERE wa_lead_id = $1 AND status <> 'Cancelled' AND created_at > NOW() - INTERVAL '30 days' ORDER BY id DESC LIMIT 1`,
        [lead.id])).rows[0];
    let orderId = existing?.id;
    if (!orderId) {
        const built = await orderFromLead(conversation, lead);
        if (built.missing) {
            const text = 'Thank you for confirming the mockup! 🙌 Our team will send you the order details and the payment link shortly.';
            await record(conversation.id, { wamid: await wa.sendText(conversation.phone, text), body: text, senderType: 'bot' });
            await note(conversation.id, `Couldn't raise the order automatically — needs ${built.missing.join(', ')}. Create it from the chat.`);
            return;
        }
        const { createOrder } = require('../routes/crewfit');
        const { order } = await createOrder(built.body, 'whatsapp');
        orderId = order.id;
        await db.query(`INSERT INTO wa_activity (conversation_id, order_id, kind, body) VALUES ($1,$2,'order',$3)`,
            [conversation.id, order.id, `Order CF-${order.sl_no} raised automatically when the customer confirmed the mockup — ₹${Number(order.grand_total).toLocaleString('en-IN')}`]);
    }
    // The summary carries the 50% advance link.
    await require('./wa-orders').send(orderId, 'summary', { user: 'whatsapp', auto: true });
}

/** ✏️ Need changes: back to the designer. */
async function changes(conversation) {
    const text = 'Sure — please tell us what you would like changed (logo size, position, colour…), and our designer will update the mockup.';
    await record(conversation.id, { wamid: await wa.sendText(conversation.phone, text), body: text, senderType: 'bot' });
    await setStatus(conversation.lead_id, conversation.id, 'need_mockup', 'the customer asked for changes to the mockup');
    try { await require('./wa-routing').reroute(conversation.id, 'lead_status', 'need_mockup'); } catch { /* the rules may say nothing */ }
}

/** A tapped button. Returns true when it was one of these. */
async function onReply(conversationId, payloadId) {
    if (![CONFIRM, CHANGES].includes(payloadId)) return false;
    const conversation = (await db.query(
        `SELECT c.*, k.phone, k.lead_id, k.profile_name FROM wa_conversations c JOIN wa_contacts k ON k.id = c.contact_id WHERE c.id = $1`,
        [conversationId])).rows[0];
    if (!conversation?.lead_id) return false;
    if (payloadId === CONFIRM) await confirm(conversation);
    else await changes(conversation);
    return true;
}

/**
 * The lead went to Need mockup: the customer is told we have what we need and the design team
 * will send the mockup here — once per lead, from the CRM's number, as an automatic message.
 * Only inside the 24-hour window (there is no template for it); outside it the timeline says so.
 * `told` marks it done without a message, for when the menu's own summary just said it.
 */
async function detailsReceived(leadId, conversationId, { told = false } = {}) {
    if (!leadId || !conversationId) return;
    const lead = (await db.query('SELECT * FROM crewfit_leads WHERE id = $1', [leadId])).rows[0];
    if (!lead || lead.mockup_notice_at) return;
    if (told) {
        await db.query('UPDATE crewfit_leads SET mockup_notice_at = CURRENT_TIMESTAMP WHERE id = $1', [leadId]);
        return;
    }
    const conv = (await db.query(
        `SELECT c.id, c.last_inbound_at, k.phone FROM wa_conversations c JOIN wa_contacts k ON k.id = c.contact_id WHERE c.id = $1`,
        [conversationId])).rows[0];
    if (!conv || !wa.configured()) return;
    if (!wa.windowOpen(conv.last_inbound_at)) {
        await note(conversationId, 'Need mockup — the customer was not told: the chat is past WhatsApp’s 24-hour window');
        return;
    }
    const lines = ['Thank you! 🙌 We have received all the details for your order:', ''];
    for (const it of rules.itemsOf(lead)) {
        const what = [it.product, it.color].filter(Boolean).join(' — ');
        if (what) lines.push(`• ${what}${it.quantity ? ` × ${it.quantity}` : ''}${it.sizes ? ` (${it.sizes})` : ''}`);
    }
    if (lead.printing_placement) lines.push(`• Logo placement: ${lead.printing_placement}`);
    if (lead.logo_url) lines.push('• Your logo: received ✅');
    lines.push('', 'Our design team is now preparing your mockup and will send you the mock images right here shortly. 🎨');
    const text = lines.join('\n');
    const wamid = await wa.sendText(conv.phone, text);
    await record(conv.id, { wamid, body: text, senderType: 'auto' });
    await db.query('UPDATE crewfit_leads SET mockup_notice_at = CURRENT_TIMESTAMP WHERE id = $1', [leadId]);
    await note(conv.id, 'Told the customer their details are with the design team');
}

/* ── Sending the mockups ─────────────────────────────────────────────────────────────────── */

/**
 * The mockup pictures, then the question with ✅ Confirm / ✏️ Need changes. Inside the window only.
 * `rows` are wa_mockups rows; `user` is who sends them (the designer). Returns the messages.
 */
async function sendMockups(conversation, rows, { user = null } = {}) {
    const first = String(conversation.lead_name || conversation.profile_name || '').trim().split(/\s+/)[0] || 'there';
    const ask = `Hi ${first}! 🎨 Here is the design mockup for your order.`;
    const sent = [];
    for (const [i, m] of rows.entries()) {
        const file = require('path').join(MOCK_DIR, require('path').basename(m.url));
        const caption = i === rows.length - 1 ? ask : '';
        const out = await wa.sendMedia(conversation.phone, { filePath: file, mime: m.mime || 'image/jpeg', filename: m.file_name || require('path').basename(file), caption });
        sent.push((await db.query(
            `INSERT INTO wa_messages (conversation_id, wamid, direction, sender_type, sender_user, type, body, media_url, media_mime, media_name, status)
             VALUES ($1,$2,'out','user',$3,$4,$5,$6,$7,$8,'sent')
             RETURNING id, conversation_id, wamid, direction, sender_type, sender_user, type, body, media_url, media_mime, media_name, status, error, sent_at`,
            [conversation.id, out.wamid, user, out.kind, caption || null, m.url, m.mime, m.file_name])).rows[0]);
        await db.query('UPDATE wa_mockups SET sent_at = CURRENT_TIMESTAMP, sent_by = $2, pending_at = NULL WHERE id = $1', [m.id, user]);
    }
    await askForApproval(conversation, { user });
    return sent;
}

/** The "mockup is ready" template, submitted to Meta the first time it is needed. */
function readyTemplate({ create = false } = {}) {
    const body = 'Hi {{1}}, the design mockup for your Crewfit order is ready 🎨 Tap the button below or reply Hi, and we will send you the mockup images right away.';
    return require('./wa-own-template').ensure({
        name: READY_TEMPLATE, body, create,
        components: [
            { type: 'BODY', text: body, example: { body_text: [['Rahul']] } },
            { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Send my mockup' }] },
        ],
    });
}

/**
 * Past the window: the template that asks the customer to reply, and the mockups kept waiting —
 * they go the moment the customer writes (sendPending). Throws { status: 409 } with what to do
 * while Meta has not approved the template yet.
 */
async function askToReply(conversation, rows, { user = null } = {}) {
    const t = await readyTemplate({ create: true });
    if (t.status !== 'APPROVED') {
        throw Object.assign(new Error(t.created
            ? 'The chat is past the 24-hour window, so the mockup needs the “mockup is ready” template. It has just been sent to Meta for approval (usually a few minutes) — send again once it is approved.'
            : `The chat is past the 24-hour window, and the “mockup is ready” template (${t.name}) is ${String(t.status).toLowerCase()} at Meta. Send again once Meta approves it.`), { status: 409 });
    }
    const first = String(conversation.lead_name || conversation.profile_name || 'there').trim().split(/\s+/)[0];
    const wamid = await wa.sendTemplate(conversation.phone, {
        name: t.name, language: t.language, variables: [first], buttons: [{ index: 0, payload: SEND_PENDING }],
    });
    await record(conversation.id, { wamid, type: 'template', user,
        body: `Hi ${first}, the design mockup for your Crewfit order is ready 🎨 Tap the button below or reply Hi, and we will send you the mockup images right away.` });
    await db.query(`UPDATE wa_mockups SET pending_at = CURRENT_TIMESTAMP, pending_by = $2 WHERE id = ANY($1::int[])`, [rows.map(r => r.id), user]);
    await note(conversation.id, `Mockup ready — asked the customer to reply (template); ${rows.length} mockup${rows.length > 1 ? 's' : ''} go out when they do`);
}

/**
 * The customer wrote (or tapped "Send my mockup"): mockups waiting for that go out now, from the
 * designer who sent them. True when it dealt with the message — then nothing else answers it.
 */
async function sendPending(conversationId, tapped = null) {
    const rows = (await db.query(
        `SELECT id, url, file_name, mime, pending_by FROM wa_mockups
          WHERE conversation_id = $1 AND pending_at > NOW() - make_interval(days => $2) ORDER BY id`, [conversationId, PENDING_DAYS])).rows;
    if (!rows.length) return tapped === SEND_PENDING;     // a second tap after they went: nothing to add
    const conversation = (await db.query(
        `SELECT c.id, c.last_inbound_at, k.phone, k.profile_name, l.name AS lead_name, k.lead_id
           FROM wa_conversations c JOIN wa_contacts k ON k.id = c.contact_id LEFT JOIN crewfit_leads l ON l.id = k.lead_id
          WHERE c.id = $1`, [conversationId])).rows[0];
    if (!conversation || !wa.windowOpen(conversation.last_inbound_at)) return false;
    // Taken off the waiting list first, so two quick messages do not send them twice.
    const claimed = await db.query(`UPDATE wa_mockups SET pending_at = NULL WHERE id = ANY($1::int[]) AND pending_at IS NOT NULL RETURNING id`, [rows.map(r => r.id)]);
    const mine = rows.filter(r => claimed.rows.some(c => c.id === r.id));
    if (!mine.length) return true;
    await sendMockups(conversation, mine, { user: mine[0].pending_by });
    await note(conversation.id, `The customer replied — sent ${mine.length} mockup${mine.length > 1 ? 's' : ''} for approval`);
    return true;
}

module.exports = { askForApproval, onReply, orderFromLead, unitPrice, detailsReceived, sendMockups, askToReply, sendPending,
    readyTemplate, CONFIRM, CHANGES, TEMPLATE, READY_TEMPLATE, SEND_PENDING };
