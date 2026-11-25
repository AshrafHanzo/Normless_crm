/**
 * The AI agent on contact@normless.store: the WhatsApp agent's rules, lessons and tools, answering
 * email instead of chats.
 *
 * It reads the thread, the orders placed with the sender's email (and live tracking for the latest),
 * their tickets, and replies as the Normless team. It raises support tickets with the photos the
 * customer attached, asks the team when it doesn't know (the thread then shows under "Needs a
 * person" on the Email page), and leaves alone mail that needs no answer.
 *
 * It runs only when the agent is on and "Answer emails" is ticked on the AI agent page, and it
 * stays out of a thread a person replied in recently, one paused, and one with a question open.
 */

const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db/connection');
const lines = require('./wa-line');
const shop = require('./nl-shop');
const bot = require('./nl-bot');
const agent = require('./nl-agent');
const exchangeFee = require('./exchange-fee');
const inbox = require('./email-inbox');
const files = require('./support-files');
const usage = require('./ai-usage');
const { readSettings, isOpen, clock } = require('./nl-settings');

const MAX_ROUNDS = 8;
const HISTORY = 12;
const SETTLE_MS = 30_000;
const SWEEP_MS = 5 * 60_000;
const REFUND_POLICY = 'https://normless.store/policies/refund-policy';

let client = null;
const anthropic = () => {
    if (!client) client = new (Anthropic.default || Anthropic)({ timeout: 90_000, maxRetries: 2 });
    return client;
};

const safeJson = (v) => { try { return typeof v === 'string' ? (JSON.parse(v || '[]') || []) : (v || []); } catch { return []; } };

async function status() {
    const line = lines.get('normless');
    if (!line?.id) return { on: false, why: 'No Normless line' };
    if (!inbox.configured()) return { on: false, why: 'The contact@ mailbox is not connected on the server' };
    const st = await agent.status(line.id);
    if (!st.on) return st;
    const s = await readSettings(line.id);
    if (!s.agent.email_enabled) return { on: false, why: 'Answering emails is switched off on the AI agent page' };
    return { on: true };
}

/* ── What it is told ──────────────────────────────────────────────────────────────────────── */

const STABLE = `You are on the Normless customer care team, answering email sent to contact@normless.store.
Normless (normless.store) is an Indian streetwear brand: oversized tees, hoodies, joggers and accessories.
Customers write about late orders, tracking, cancellations, address or size changes, exchanges, damaged
or wrong items, and product questions. You answer the way a careful, kind person on the team would.

You answer order questions only: where an order is, tracking, dispatch delays, cancellation or refund
requests about an order, address or size changes, exchanges, damaged or wrong items, failed deliveries,
and questions about a product before ordering. Anything else that a person wrote (a collaboration or
business enquiry, a job, press, a legal or payment dispute, a chargeback threat, a complaint about the
brand itself, a sales or marketing pitch): call ask_team with a one-line summary and no holding_message,
so the team picks it up. Only obvious spam, newsletters and auto-replies ("out of office"): call no_reply.

How you work:
- Read the whole thread first, including what the team already replied. Don't repeat yourself.
- The orders placed with the sender's email are in "This email" below, with live tracking for the latest.
  If they write about another order, use lookup_order (it checks the order belongs to this email) or
  find_orders with the phone number they placed it with. Use track_shipment for any other order: it also
  finds a shipment re-made under the order number with an "A" on the end after the first was cancelled.
- Follow the team's lessons and announcements below. They override anything else here.
- You cannot refund, cancel, discount, change an order, or promise a dispatch or delivery date unless a
  lesson or the team's answer says you can. Never say you have done any of these.
- Raise a support ticket with raise_ticket for: an address change before dispatch (full new address with
  pincode), a size change before dispatch ("Size Change", with the new size), a damaged or wrong item
  (once the unboxing video or photos are attached), a failed delivery, a cancellation agreed with the
  customer, a hold. Photos attached to the thread go on the ticket automatically. Give the customer the
  ticket number in your reply and say the team will update them.
${agent.AFTER_DELIVERY}
- Once Delhivery has picked the parcel up from our warehouse (tracking shows it picked up, in transit,
  out for delivery or later; check with track_shipment when you can't tell), its pincode and state can't
  be changed. Say so plainly: the parcel goes to the original address, and if nobody takes it there it
  comes back to us as an RTO (return to origin). Don't raise a ticket for a new pincode or state then.
  A change within the same pincode (house or flat number, landmark, phone) can still go on an
  "Address update" ticket. The size can't change after pickup either: once it is delivered they can ask
  for a size exchange. Before pickup (no AWB yet, or an AWB not picked up), these go on a ticket as usual.
- Their tickets are in "This email" with status and what the team did. Explain where one stands in plain words.
- When you don't know, the customer asks for something only the team can decide (a refund, an exception),
  they are angry after two replies, or anything is unclear: call ask_team with a precise question and what
  you checked, and write nothing else. Never guess.
- If the email needs no answer (a thank-you, an auto-reply, spam, a newsletter), call no_reply.

How you write: a short, warm email from a real person on the Normless customer care team. Start with
"Hi <first name>," (or "Hi there," if unknown), then 1 to 3 short paragraphs, specific to this customer,
never templated. Plain text, no markdown, no bullet lists unless giving steps, paste links as plain URLs.
Apologise once, sincerely, when we are late or wrong. Write as "we" / "I" from the Normless team. End with
"Warm regards,\\nTeam Normless". Everything you write as text is sent exactly as it is: write only the email, never a note
to yourself or a word about lessons or instructions. Never mention AI, bots, automation, tools or "the system". If a customer
sincerely asks whether a person is answering, call ask_team; never claim to be human. Reply in the
customer's language if they don't write in English.

The refund policy is at ${REFUND_POLICY}.`;

const TOOLS = [
    ...bot.TOOLS.filter(t => ['search_products', 'get_policy'].includes(t.name)),
    {
        name: 'lookup_order',
        description: 'One order by its number. Released only if it was placed with this email, or the customer gave the delivery pincode.',
        input_schema: { type: 'object', properties: { order_number: { type: 'string' }, pincode: { type: 'string' } }, required: ['order_number'] },
    },
    {
        name: 'find_orders',
        description: 'Orders placed with another phone number or email address the customer gives.',
        input_schema: { type: 'object', properties: { phone: { type: 'string' }, email: { type: 'string' } } },
    },
    {
        name: 'track_shipment',
        description: 'Live Delhivery status for one order, including a shipment re-made as the order number with "A" on the end.',
        input_schema: { type: 'object', properties: { order_number: { type: 'string' } }, required: ['order_number'] },
    },
    {
        name: 'raise_ticket',
        description: 'Raise a Normless support ticket for the team to act on, with the photos attached to this thread. Returns the ticket number to give the customer.',
        input_schema: {
            type: 'object',
            properties: {
                order_number: { type: 'string' },
                reason: { type: 'string', enum: Object.keys(agent.TICKET_REASONS) },
                request: { type: 'string', description: 'Exactly what the team must do, with the details' },
                top_priority: { type: 'boolean', description: 'True when the customer is very angry, or the delay is ours and they have waited long' },
            },
            required: ['order_number', 'reason', 'request'],
        },
    },
    agent.EXCHANGE_FEE_TOOL,
    {
        name: 'ask_team',
        description: "Ask the Normless team when you don't know or it isn't yours to decide. Write nothing else.",
        input_schema: {
            type: 'object',
            properties: {
                question: { type: 'string' },
                checked: { type: 'string', description: 'What you already looked up and found' },
                holding_message: { type: 'string', description: 'A short email telling the customer we are checking with the team and will reply soon. Empty if we already said so.' },
            },
            required: ['question'],
        },
    },
    {
        name: 'no_reply',
        description: 'This email needs no answer (thanks, auto-reply, obvious spam). The thread is closed.',
        input_schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
    },
];

async function contextFor(thread, settings) {
    const mine = await shop.ordersByContact({ email: thread.customer_email }).catch(() => ({ orders: [] }));
    const orders = (mine.orders || []).slice(0, 6).map(o => ({
        order: o.order_number, placed: o.created_at, state: o.state, payment: o.payment?.label, total: o.total_price,
        items: (o.items || []).map(i => `${i.title}${i.variant ? ` (${i.variant})` : ''} x${i.quantity || 1}`),
        awb: o.dispatch?.awb || null, tracking: o.dispatch?.tracking_url || null,
    }));
    const live = [];
    for (const o of orders.filter(x => x.state !== 'Cancelled' && Date.now() - new Date(x.placed || 0).getTime() < 45 * 86400000).slice(0, 2)) {
        try { live.push(await agent.trackShipment(o.order)); } catch { /* the tool is there */ }
    }
    const tickets = (await db.query(
        `SELECT ref_no, order_number, reason, status, progress, action, TO_CHAR(raised_on,'YYYY-MM-DD') AS raised
           FROM support_tickets
          WHERE email_thread_id = $1 OR LOWER(customer_email) = $2 OR order_number = ANY($3)
          ORDER BY id DESC LIMIT 6`, [thread.id, thread.customer_email, orders.map(o => o.order)])).rows
        .map(t => ({ ref: `CS-${String(t.ref_no).padStart(4, '0')}`, order: t.order_number, reason: t.reason, raised: t.raised, status: t.status, progress: t.progress, done_by_team: t.action || null }));
    // The same customer often writes several separate emails: what was said in the others counts.
    const others = (await db.query(
        `SELECT t.subject, m.direction, m.sender_type, LEFT(m.body, 600) AS body
           FROM email_threads t JOIN email_messages m ON m.thread_id = t.id AND m.status <> 'failed'
          WHERE LOWER(t.customer_email) = $1 AND t.id <> $2 AND m.created_at > now() - INTERVAL '14 days'
          ORDER BY m.created_at DESC LIMIT 8`, [thread.customer_email, thread.id])).rows.reverse();
    const fees = await exchangeFee.forCustomer({ email_thread_id: thread.id, orders: orders.map(o => o.order) }).catch(() => []);
    const ist = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    return [
        `Now: ${ist} (India). Team hours ${clock(settings.hours.start)} to ${clock(settings.hours.end)}; the team is ${isOpen(settings.hours) ? 'online' : 'offline'} now.`,
        `Customer: ${thread.customer_name || 'name unknown'} <${thread.customer_email}>. Subject: ${thread.subject}.`,
        `Orders placed with this email: ${orders.length ? JSON.stringify(orders) : 'none found. Ask for the order number, or the phone number they ordered with.'}`,
        live.length ? `Live Delhivery tracking, checked just now: ${JSON.stringify(live)}` : null,
        `Their support tickets: ${tickets.length ? JSON.stringify(tickets) : 'none.'}`,
        `Exchange fee links (₹198 manual exchange), checked with Razorpay just now: ${fees.length ? JSON.stringify(fees) : 'none sent.'}`,
        others.length ? `Their other recent emails to us (separate threads; stay consistent with what we told them there):\n${others.map(o => `- [${o.subject}] ${o.direction === 'in' ? 'Customer' : o.sender_type === 'ai' ? 'We replied' : 'Team replied'}: ${String(o.body || '').replace(/\s+/g, ' ')}`).join('\n')}` : null,
    ].filter(Boolean).join('\n\n');
}

async function history(threadId) {
    const r = await db.query(
        `SELECT direction, sender_type, sender_user, body, attachments FROM email_messages
          WHERE thread_id = $1 AND status <> 'failed' ORDER BY created_at DESC, id DESC LIMIT $2`, [threadId, HISTORY]);
    return r.rows.reverse().map(m => {
        const att = safeJson(m.attachments);
        const note = att.length ? `[attached: ${att.map(a => `${a.mime?.startsWith('image/') ? 'photo' : a.mime?.startsWith('video/') ? 'video' : 'file'} ${a.name}`).join(', ')}] ` : '';
        const who = m.direction === 'in' ? '' : m.sender_type === 'user' ? `[Team: ${String(m.sender_user || 'a person').split('@')[0]}] ` : '';
        return { role: m.direction === 'in' ? 'user' : 'assistant', text: `${who}${note}${m.body || ''}`.trim() };
    });
}

/* ── Its tools ─────────────────────────────────────────────────────────────────────────────── */

async function raiseTicket(thread, input) {
    const reason = Object.keys(agent.TICKET_REASONS).includes(input.reason) ? input.reason : null;
    const digits = String(input.order_number || '').match(/\d{3,}/)?.[0];
    if (!reason) return { error: 'Pick one of the listed reasons' };
    if (!digits) return { error: 'Give the order number' };
    if (!String(input.request || '').trim()) return { error: 'Say what the team must do' };
    const num = `#${digits}`;
    const dup = (await db.query(
        `SELECT id, ref_no FROM support_tickets WHERE order_number = $1 AND reason = $2 AND status = 'Open' LIMIT 1`, [num, reason])).rows[0];
    if (dup) {
        await attachThreadPhotos(dup.id, thread.id);
        return { already_open: `CS-${String(dup.ref_no).padStart(4, '0')}`, note: 'A ticket for this is already open; the team is on it. Any photos were added to it.' };
    }
    const phone = (await db.query(`SELECT customer_phone FROM packed_orders WHERE order_number = $1 AND customer_phone IS NOT NULL LIMIT 1`, [num])).rows[0]?.customer_phone || null;
    const id = await agent.createTicket({
        actor: 'ai-agent', source: 'Email', order_number: num, reason, request: input.request,
        customer_name: thread.customer_name, customer_phone: phone, customer_email: thread.customer_email, email_thread_id: thread.id,
    });
    const photos = await attachThreadPhotos(id, thread.id);
    const ref = `CS-${String((await db.query('SELECT ref_no FROM support_tickets WHERE id = $1', [id])).rows[0].ref_no).padStart(4, '0')}`;
    const extra = await agent.afterTicket(id, ref, reason, num, input);
    return { raised: ref, photos_attached: photos, ...extra, note: 'Give the customer this ticket number in your reply.' };
}

/** The photos attached anywhere in a thread, onto a ticket. */
async function attachThreadPhotos(ticketId, threadId) {
    const r = await db.query(`SELECT attachments FROM email_messages WHERE thread_id = $1 AND direction = 'in' ORDER BY id`, [threadId]);
    const list = r.rows.flatMap(m => safeJson(m.attachments)).filter(a => files.isImage(a.mime));
    return files.addImages(ticketId, list.map(a => ({ key: `mail-${a.url.split('/').pop().split('.')[0]}`, mime: a.mime, url: a.url })));
}

/** Photos that arrived after a ticket was raised from the thread go onto it. */
async function attachmentsArrived(threadId) {
    const t = (await db.query(`SELECT id FROM support_tickets WHERE email_thread_id = $1 AND status = 'Open'`, [threadId])).rows;
    for (const x of t) await attachThreadPhotos(x.id, threadId);
}

async function notifyTeam(thread, question) {
    const users = thread.assigned_to ? [thread.assigned_to] : (await db.query(
        `SELECT username FROM admin_users WHERE COALESCE(is_active, true) AND (role IN ('owner','admin') OR can_edit_support)`)).rows.map(r => r.username);
    if (!users.length) return;
    await require('./notify').notify({
        usernames: users, kind: 'support', actor: 'ai-agent', link: `/support/email?t=${thread.id}`,
        title: `The AI agent needs your answer on an email: ${thread.customer_name || thread.customer_email}`, body: String(question).slice(0, 300),
    });
}

/* ── Thinking and acting ───────────────────────────────────────────────────────────────────── */

async function think({ thread, lineId, settings, task }) {
    const book = await agent.playbook(lineId);
    const msgs = bot.asMessages(await history(thread.id));
    if (task) {
        const note = `[From the Normless team, not the customer] ${task}`;
        if (msgs.length && msgs[msgs.length - 1].role === 'user') msgs[msgs.length - 1].content += `\n\n${note}`;
        else msgs.push({ role: 'user', content: note });
    }
    if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return { nothing: true };
    const context = await contextFor(thread, settings);
    let seen = `${book.text} ${context} 198 24`;
    const did = [];

    for (let round = 0; round < MAX_ROUNDS; round++) {
        const response = await anthropic().beta.messages.create({
            ...agent.requestFor(settings.agent.model),
            system: [
                { type: 'text', text: STABLE, cache_control: { type: 'ephemeral' } },
                { type: 'text', text: book.text, cache_control: { type: 'ephemeral' } },
                { type: 'text', text: `This email:\n${context}` },
            ],
            tools: TOOLS,
            messages: msgs,
        });
        await usage.record('email_agent', response, { ref: `email:${thread.id}` });
        if (response.stop_reason === 'refusal') return { ask: { question: 'The AI agent could not answer this email. Please reply to the customer.' }, did };
        msgs.push({ role: 'assistant', content: response.content });
        const calls = response.content.filter(b => b.type === 'tool_use');
        const asking = calls.find(x => x.name === 'ask_team');
        if (asking) return { ask: asking.input || {}, did };
        const skip = calls.find(x => x.name === 'no_reply');
        if (skip) return { close: skip.input?.reason || 'Needs no answer', did };
        if (!calls.length || response.stop_reason === 'end_turn') {
            let text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
            // A note to itself before the greeting never reaches the customer.
            const greet = text.search(/^(Hi|Hello|Dear)\b/m);
            if (greet > 0) text = text.slice(greet).trim();
            if (!text) return { nothing: true, did };
            if (/\b(lessons?|playbook|instructions?|system prompt)\b/i.test(text)) {
                return { ask: { question: `My draft mentions our internal notes, so I didn't send it: "${text.slice(0, 600)}" Please reply to the customer.` }, did };
            }
            const bad = bot.inventedFigure(text, seen);
            if (bad != null) return { ask: { question: `I wanted to reply with an amount (₹${bad}) I couldn't verify. My draft: "${text.slice(0, 600)}" What should I say?` }, did };
            return { text, did };
        }
        const results = [];
        for (const call of calls) {
            let result;
            try {
                const input = call.input || {};
                if (call.name === 'track_shipment') result = await agent.trackShipment(input.order_number);
                else if (call.name === 'find_orders') result = await shop.ordersByContact(input);
                else if (call.name === 'lookup_order') result = await shop.orderByNumber({ phone: '' }, input.order_number, { email: thread.customer_email, pincode: input.pincode });
                else if (call.name === 'raise_ticket') { result = await raiseTicket(thread, input); if (result.raised) did.push(`ticket ${result.raised}`); }
                else if (call.name === 'exchange_fee_link') {
                    const phone = (await db.query(`SELECT customer_phone FROM packed_orders WHERE order_number = $1 AND customer_phone IS NOT NULL LIMIT 1`,
                        [`#${String(input.order_number || '').match(/\d{3,}/)?.[0] || ''}`])).rows[0]?.customer_phone || null;
                    result = await exchangeFee.linkFor({ ...input, email_thread_id: thread.id, customer_name: thread.customer_name, customer_email: thread.customer_email, customer_phone: phone });
                    if (result?.link) did.push(`exchange fee link for ${input.order_number}`);
                }
                else result = await bot.runTool(call.name, input, { conversation: { id: null }, dry: true, sent: [] });
            } catch (err) { result = { error: `That didn't work: ${err.message}` }; }
            const json = JSON.stringify(result);
            seen += ` ${json}`;
            results.push({ type: 'tool_result', tool_use_id: call.id, content: json, ...(result?.error ? { is_error: true } : {}) });
        }
        msgs.push({ role: 'user', content: results });
    }
    return { ask: { question: 'I went round in circles on this email and could not settle on an answer. Please take a look.' }, did };
}

const running = new Set();
const timers = new Map();

/** Answer one thread now if it is waiting (or the team told it to, with `task`). */
async function run(threadId, { task = null } = {}) {
    if (running.has(threadId)) return { skipped: 'Already working on this email' };
    running.add(threadId);
    try {
        const st = await status();
        if (!st.on) return { skipped: st.why };
        const line = lines.get('normless');
        return await lines.run(line, async () => {
            const settings = await readSettings(line.id);
            const quiet = Math.max(0, Number(settings.agent.quiet_minutes) || 0);
            const thread = (await db.query(
                `SELECT t.*,
                        (SELECT direction FROM email_messages m WHERE m.thread_id = t.id AND m.status <> 'failed' ORDER BY created_at DESC, id DESC LIMIT 1) AS last_direction,
                        (SELECT MAX(created_at) FROM email_messages m WHERE m.thread_id = t.id AND m.sender_type = 'user') AS person_at
                   FROM email_threads t WHERE t.id = $1`, [threadId])).rows[0];
            if (!thread) return { skipped: 'No such email' };
            if (thread.ai_paused) return { skipped: 'Paused on this email' };
            if (!task) {
                if (thread.status !== 'open') return { skipped: 'Closed' };
                if (thread.ai_state === 'asked') return { skipped: 'Waiting for the team to answer its question' };
                if (thread.last_direction !== 'in') return { skipped: 'Nothing new from the customer' };
                if (thread.person_at && Date.now() - new Date(thread.person_at).getTime() < quiet * 60_000) return { skipped: 'A person is on this email' };
            }
            const started = Date.now();
            let out;
            try { out = await think({ thread, lineId: line.id, settings, task }); }
            catch (err) {
                console.error('email agent failed:', err.message);
                out = { ask: { question: `The AI agent ran into a problem (${String(err.message).slice(0, 150)}). Please reply to this customer.` } };
            }
            const after = (await db.query(
                `SELECT ai_paused, (SELECT MAX(created_at) FROM email_messages m WHERE m.thread_id = $1 AND m.sender_type = 'user') AS person_at
                   FROM email_threads WHERE id = $1`, [threadId])).rows[0];
            if (!task && (after.ai_paused || (after.person_at && new Date(after.person_at).getTime() > started))) return { skipped: 'A person replied meanwhile' };

            if (out.ask) {
                const q = String(out.ask.question || '').trim().slice(0, 1500) || 'The agent could not answer this email.';
                await db.query(`UPDATE email_threads SET ai_state = 'asked', ai_question = $2, status = 'open' WHERE id = $1`, [threadId, q]);
                const hold = String(out.ask.holding_message || '').trim();
                if (hold) await inbox.reply(threadId, hold.slice(0, 2000), { type: 'ai', user: 'ai-agent' }).catch(err => console.error('email hold:', err.message));
                await notifyTeam(thread, q);
                return { asked: q, did: out.did };
            }
            if (out.close) {
                await db.query(`UPDATE email_threads SET status = 'closed', ai_state = 'closed' WHERE id = $1`, [threadId]);
                return { closed: out.close, did: out.did };
            }
            if (out.text) {
                try { await inbox.reply(threadId, out.text, { type: 'ai', user: 'ai-agent' }); }
                catch (err) {
                    // Not retried by the sweep (that would pay for the same answer again): a person sends it.
                    const q = `My reply could not be sent (${String(err.message).slice(0, 150)}). My draft: "${out.text.slice(0, 800)}"`;
                    await db.query(`UPDATE email_threads SET ai_state = 'asked', ai_question = $2 WHERE id = $1`, [threadId, q]);
                    await notifyTeam(thread, q);
                    return { asked: q };
                }
                await db.query(`UPDATE email_threads SET ai_state = 'replied', ai_question = NULL WHERE id = $1`, [threadId]);
                return { replied: out.text, did: out.did };
            }
            if (!task) {
                const q = 'I couldn’t work out a reply to this email. Please answer it.';
                await db.query(`UPDATE email_threads SET ai_state = 'asked', ai_question = $2 WHERE id = $1`, [threadId, q]);
                await notifyTeam(thread, q);
                return { asked: q };
            }
            return { nothing: true };
        });
    } finally {
        running.delete(threadId);
    }
}

function schedule(threadId, delay = SETTLE_MS) {
    clearTimeout(timers.get(threadId));
    timers.set(threadId, setTimeout(() => {
        timers.delete(threadId);
        run(threadId).catch(err => console.error('email agent error:', err.message));
    }, delay));
}

/** Threads still waiting for an answer (a restart, a failed run): oldest first. */
async function sweep() {
    try {
        if (!(await status()).on) return;
        const r = await db.query(
            `SELECT t.id FROM email_threads t
              WHERE t.status = 'open' AND NOT t.ai_paused AND COALESCE(t.ai_state, '') <> 'asked'
                AND t.last_inbound_at > now() - INTERVAL '3 days'
                AND (SELECT direction FROM email_messages m WHERE m.thread_id = t.id AND m.status <> 'failed' ORDER BY created_at DESC, id DESC LIMIT 1) = 'in'
              ORDER BY t.last_inbound_at ASC LIMIT 10`);
        for (const { id } of r.rows) {
            if (timers.has(id)) continue;
            await run(id).catch(err => console.error('email agent sweep:', err.message));
        }
    } catch (err) {
        console.error('email agent sweep failed:', err.message);
    }
}

/** The team answered its question: reply with it, and learn it if asked. */
async function answer(threadId, { answer: text, remember = false, by }) {
    const t = (await db.query('SELECT * FROM email_threads WHERE id = $1', [threadId])).rows[0];
    if (!t) throw Object.assign(new Error('No such email'), { status: 404 });
    if (t.ai_state !== 'asked') throw Object.assign(new Error('There is no open question on this email'), { status: 409 });
    const clean = String(text || '').trim().slice(0, 3000);
    if (!clean) throw Object.assign(new Error('Write the answer first'), { status: 400 });
    const line = lines.get('normless');
    if (remember) {
        await db.query(
            `INSERT INTO nl_ai_lessons (line_id, kind, title, body, source, created_by) VALUES ($1,'lesson',$2,$3,'question',$4)`,
            [line.id, String(t.ai_question || '').slice(0, 200), clean, by]);
    }
    const q = t.ai_question;
    await db.query(`UPDATE email_threads SET ai_state = NULL, ai_question = NULL WHERE id = $1`, [threadId]);
    return run(threadId, { task: `${String(by || '').split('@')[0]} answered your question "${q}": ${clean}\nNow reply to the customer using this answer.` });
}

let started = false;
function start() {
    if (started) return;
    started = true;
    inbox.start((fresh) => fresh.forEach(id => schedule(id)));
    setInterval(sweep, SWEEP_MS);
}

module.exports = { run, schedule, sweep, start, answer, status, attachmentsArrived, STABLE };
