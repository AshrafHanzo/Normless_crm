/**
 * The ₹198 manual-exchange fee.
 *
 * Exchanges normally go through the returns centre. Now and then a customer asks us to do it by
 * hand instead: the AI agent then sends a Razorpay payment link for the fee (same Razorpay account
 * as Crewfit's links). Once Razorpay says it is paid (its webhook, or the check every two minutes),
 * the exchange ticket is raised with the payment ID on it, so the team can start the return
 * knowing the money is in, and the customer is told the ticket number.
 */

const db = require('../db/connection');
const razorpay = require('../config/razorpay');

const FEE = 198;
const CHECK_MS = 2 * 60_000;
const LINK_DAYS = 7;

const ref = (n) => `CS-${String(n).padStart(4, '0')}`;
const orderKey = (v) => { const d = String(v || '').match(/\d{3,}/)?.[0]; return d ? `#${d}` : null; };

function contact(phone) {
    const d = String(phone || '').replace(/\D/g, '');
    if (d.length === 10) return `+91${d}`;
    if (d.length === 12 && d.startsWith('91')) return `+${d}`;
    return null;
}

/** What the agent sees about one fee link. */
const shape = (f) => ({
    order: f.order_number, amount: Number(f.amount), link: f.razorpay_short_url, status: f.status,
    created: f.created_at, paid_at: f.paid_at, razorpay_payment_id: f.razorpay_payment_id,
    ticket: f.ticket_ref ? ref(f.ticket_ref) : null, request: f.request,
});

/**
 * A link for the fee on this order, for the chat or email thread the agent is answering. An open
 * link already sent for the same order is sent again rather than making a second one.
 */
async function linkFor({ order_number, request, wa_conversation_id = null, email_thread_id = null, customer_name, customer_phone, customer_email, actor = 'ai-agent' }) {
    const num = orderKey(order_number);
    if (!num) return { error: 'Give the order number' };
    const what = String(request || '').trim();
    if (!what) return { error: 'Say what is being exchanged, e.g. "Doom Legacy Tee from M to S"' };
    if (!razorpay.isConfigured) return { error: 'Payment links are not set up; ask the team' };
    const order = (await db.query(`SELECT order_number, cancelled_at, email FROM orders WHERE order_number = $1`, [num])).rows[0];
    if (!order) return { error: `${num} isn't in our orders; check the number` };
    if (order.cancelled_at) return { error: `${num} is cancelled, so there is nothing to exchange` };

    const paid = (await db.query(
        `SELECT f.*, t.ref_no AS ticket_ref FROM nl_exchange_fees f LEFT JOIN support_tickets t ON t.id = f.ticket_id
          WHERE f.order_number = $1 AND f.status = 'Paid' ORDER BY f.id DESC LIMIT 1`, [num])).rows[0];
    if (paid) return { already_paid: shape(paid), note: 'The fee for this order is already paid; do not send another link.' };
    const open = (await db.query(
        `SELECT * FROM nl_exchange_fees WHERE order_number = $1 AND status = 'Created' AND created_at > now() - ($2 || ' days')::interval
          ORDER BY id DESC LIMIT 1`, [num, String(LINK_DAYS - 1)])).rows[0];
    if (open) return { link: open.razorpay_short_url, amount: Number(open.amount), reused: true, note: 'This link was already made for this order; send it again.' };

    const link = await razorpay.client().paymentLink.create({
        amount: FEE * 100,
        currency: 'INR',
        accept_partial: false,
        description: `Normless exchange fee for order ${num}`,
        customer: {
            name: customer_name || 'Customer',
            ...(contact(customer_phone) ? { contact: contact(customer_phone) } : {}),
            ...(customer_email || order.email ? { email: customer_email || order.email } : {}),
        },
        notify: { sms: false, email: false },
        reminder_enable: false,
        expire_by: Math.floor(Date.now() / 1000) + LINK_DAYS * 86400,
        notes: { source: 'normless-exchange', order_number: num },
    });
    await db.query(
        `INSERT INTO nl_exchange_fees (order_number, request, amount, customer_name, customer_phone, customer_email,
                wa_conversation_id, email_thread_id, razorpay_payment_link_id, razorpay_short_url, razorpay_mode, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [num, what.slice(0, 1000), FEE, customer_name || null, customer_phone || null, customer_email || order.email || null,
            wa_conversation_id, email_thread_id, link.id, link.short_url, razorpay.MODE, actor]);
    return { link: link.short_url, amount: FEE, note: 'Put this link in your reply. Once they pay, the exchange ticket is raised by itself and they are told its number.' };
}

/** The fee links for a chat, a thread or some orders, checked with Razorpay if still open. */
async function forCustomer({ wa_conversation_id = null, email_thread_id = null, orders = [] }) {
    const r = await db.query(
        `SELECT f.*, t.ref_no AS ticket_ref FROM nl_exchange_fees f LEFT JOIN support_tickets t ON t.id = f.ticket_id
          WHERE (f.wa_conversation_id = $1 OR f.email_thread_id = $2 OR f.order_number = ANY($3))
            AND f.created_at > now() - INTERVAL '30 days'
          ORDER BY f.id DESC LIMIT 5`, [wa_conversation_id, email_thread_id, orders]);
    for (const f of r.rows.filter(x => x.status === 'Created')) await check(f).catch(() => {});
    const fresh = await db.query(
        `SELECT f.*, t.ref_no AS ticket_ref FROM nl_exchange_fees f LEFT JOIN support_tickets t ON t.id = f.ticket_id
          WHERE f.id = ANY($1) ORDER BY f.id DESC`, [r.rows.map(x => x.id)]);
    return fresh.rows.map(shape);
}

/** Ask Razorpay where one link stands, and settle it if paid. */
async function check(fee) {
    const link = await razorpay.client().paymentLink.fetch(fee.razorpay_payment_link_id);
    await db.query(`UPDATE nl_exchange_fees SET last_checked_at = now() WHERE id = $1`, [fee.id]);
    if (link.status === 'paid') {
        const p = (link.payments || []).find(x => x.status === 'captured') || (link.payments || [])[0];
        return settle(fee.razorpay_payment_link_id, p?.payment_id || null);
    }
    if (['cancelled', 'expired'].includes(link.status)) {
        await db.query(`UPDATE nl_exchange_fees SET status = $2 WHERE id = $1 AND status = 'Created'`, [fee.id, link.status === 'expired' ? 'Expired' : 'Cancelled']);
    }
    return null;
}

/**
 * Paid: record it, then raise the exchange ticket with the payment on it. Safe to run twice
 * (webhook and check both arrive): the ticket is claimed before it is raised.
 */
async function settle(linkId, paymentId) {
    await db.query(
        `UPDATE nl_exchange_fees SET status = 'Paid', paid_at = COALESCE(paid_at, now()), razorpay_payment_id = COALESCE(razorpay_payment_id, $2)
          WHERE razorpay_payment_link_id = $1`, [linkId, paymentId]);
    const fee = (await db.query(
        `UPDATE nl_exchange_fees SET ticket_id = -1 WHERE razorpay_payment_link_id = $1 AND ticket_id IS NULL RETURNING *`, [linkId])).rows[0];
    if (!fee) return null;
    try {
        const agent = require('./nl-agent');
        const proof = `Manual exchange fee ₹${Number(fee.amount)} paid on Razorpay: payment ${fee.razorpay_payment_id || '(id not given)'}, link ${fee.razorpay_payment_link_id}.`;
        const id = await agent.createTicket({
            actor: 'ai-agent', source: fee.email_thread_id && !fee.wa_conversation_id ? 'Email' : 'WhatsApp',
            order_number: fee.order_number, reason: 'Initiate Replacement',
            request: `${fee.request}\n${proof} Start the return by hand.`,
            customer_name: fee.customer_name, customer_phone: fee.customer_phone, customer_email: fee.customer_email,
            wa_conversation_id: fee.wa_conversation_id, email_thread_id: fee.email_thread_id,
        });
        await db.query(`UPDATE support_tickets SET payment_status = 'Paid', ops_note = $2 WHERE id = $1`, [id, proof]);
        await db.query(`UPDATE nl_exchange_fees SET ticket_id = $2 WHERE id = $1`, [fee.id, id]);
        const row = (await db.query(
            `SELECT id, ref_no, order_number, customer_name, customer_phone, reason, nature, request, wa_conversation_id FROM support_tickets WHERE id = $1`, [id])).rows[0];
        console.log(`💸 Exchange fee paid for ${fee.order_number} (${fee.razorpay_payment_id}) — ${ref(row.ref_no)} raised`);
        if (fee.wa_conversation_id) {
            await require('./support-files').addChatPhotos(id, fee.wa_conversation_id).catch(() => 0);
            await db.query(`INSERT INTO wa_activity (conversation_id, kind, body, actor) VALUES ($1,'ticket',$2,'ai-agent')`,
                [fee.wa_conversation_id, `Exchange fee ₹${Number(fee.amount)} paid (${fee.razorpay_payment_id}); ${ref(row.ref_no)} raised`]);
            await require('./nl-automations').ticketRaised(row).catch(err => console.error('exchange fee ticket message:', err.message));
        } else if (fee.email_thread_id) {
            const name = String(fee.customer_name || '').trim().split(/\s+/)[0] || 'there';
            await require('./email-inbox').reply(fee.email_thread_id,
                `Hi ${name},\n\nWe've received your ₹${Number(fee.amount)} exchange payment for order ${fee.order_number}, and raised ticket ${ref(row.ref_no)} for the exchange. Our team will arrange the pickup and keep you updated here.\n\nWarm regards,\nTeam Normless`,
                { type: 'ai', user: 'ai-agent' }).catch(err => console.error('exchange fee email:', err.message));
        }
        return row;
    } catch (err) {
        await db.query(`UPDATE nl_exchange_fees SET ticket_id = NULL WHERE id = $1 AND ticket_id = -1`, [fee.id]);
        console.error('exchange fee ticket failed:', err.message);
        throw err;
    }
}

/** Razorpay's webhook, for a link of ours. True if it was one. */
async function fromWebhook(linkId, paymentId) {
    const fee = (await db.query(`SELECT id FROM nl_exchange_fees WHERE razorpay_payment_link_id = $1`, [linkId])).rows[0];
    if (!fee) return false;
    await settle(linkId, paymentId);
    return true;
}

/** Every two minutes: open links from the last week, and paid ones whose ticket didn't get raised. */
async function sweep() {
    try {
        if (!razorpay.isConfigured) return;
        const r = await db.query(
            `SELECT * FROM nl_exchange_fees
              WHERE (status = 'Created' AND created_at > now() - ($1 || ' days')::interval)
                 OR (status = 'Paid' AND ticket_id IS NULL)
              ORDER BY id LIMIT 50`, [String(LINK_DAYS + 1)]);
        for (const f of r.rows) {
            if (f.status === 'Paid') await settle(f.razorpay_payment_link_id, f.razorpay_payment_id).catch(() => {});
            else await check(f).catch(err => console.error(`exchange fee check ${f.id}:`, err.error?.description || err.message));
        }
    } catch (err) {
        console.error('exchange fee sweep:', err.message);
    }
}

function start() { setInterval(sweep, CHECK_MS); }

module.exports = { FEE, linkFor, forCustomer, fromWebhook, sweep, start };
