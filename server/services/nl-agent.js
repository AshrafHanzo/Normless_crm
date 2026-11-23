/**
 * The Normless AI agent: answers the chats that are waiting for a person.
 *
 * The bot (nl-bot) answers the easy questions and hands the rest to the team. This picks those
 * chats up and works them as a person on the team would: it reads the chat, the customer's orders,
 * their tickets and the live Delhivery tracking (including a shipment re-made as "12598A"), and
 * replies. What it was taught on the AI agent page — standing lessons and dated announcements —
 * is in its instructions every time.
 *
 * When it doesn't know, it doesn't guess: it asks the team (ask_team), tells the customer it is
 * checking, and waits. A person answers in the inbox or on the AI agent page; the agent turns that
 * answer into the reply, and "Remember this" saves it as a lesson so it isn't asked again.
 *
 * What keeps it safe is what it can do. Its tools read, send information, raise a support ticket
 * (address or size change, damaged, wrong or failed parcel) and close a chat that needs nothing
 * more. None of them refunds, cancels, discounts or changes an order. Any ₹ figure it writes must
 * appear in what it was allowed to read, or the reply isn't sent and the team is asked instead.
 *
 * It stays out of a chat a person is in: one a team member wrote in during the last half hour
 * (Settings: quiet_minutes), one somebody paused it on, and one with a question to the team still
 * unanswered. It stops for the month when the budget on the AI agent page is spent.
 */

const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db/connection');
const wa = require('./whatsapp');
const lines = require('./wa-line');
const shop = require('./nl-shop');
const bot = require('./nl-bot');
const handover = require('./nl-handover');
const usage = require('./ai-usage');
const files = require('./support-files');
const { readSettings, isOpen, clock } = require('./nl-settings');

const MAX_ROUNDS = 8;          // tool rounds before it gives up and asks the team
const HISTORY = 20;            // messages of context
const SETTLE_MS = 20_000;      // let a burst of messages finish (and the bot hand over) first
const SWEEP_MS = 5 * 60_000;   // look for waiting chats this often
const SWEEP_MAX = 15;          // chats per sweep, oldest first
// A chat the agent hasn't answered this long after the customer wrote shows in "Needs a person".
const GRACE_MINUTES = 60;
// Cheapest sensible first: the first is the default. Sonnet answers these chats well at half
// Opus's price; Haiku is about a fortieth of it.
const MODELS = ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'];
// Minutes of silence after the agent's last reply before it closes the chat (Settings).
const IDLE_CLOSE_DEFAULT = 15;
const IDLE_MS = 60_000;

/**
 * What every agent request carries besides the prompt. Haiku has no server-side fallback (a
 * `fallbacks` list is a 400 there). The top-level cache_control caches the whole conversation as it
 * stands, so each tool round after the first reads it back at a twentieth of the price.
 */
function requestFor(model) {
    const fallback = /haiku/.test(model) ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };
    return { model, max_tokens: 8000, output_config: { effort: 'low' }, cache_control: { type: 'ephemeral' }, ...fallback };
}
const REFUND_POLICY = 'https://normless.store/policies/refund-policy';
// Support reasons the agent may raise a ticket for, and the nature each one is filed under.
const TICKET_REASONS = {
    'Address update': 'Order Edits (Pre-fulfilment)',
    'Size Change': 'Order Edits (Pre-fulfilment)',
    'Initiate Replacement': 'Return & Replacement',     // a size exchange after delivery
    'Damaged product': 'Return & Replacement',
    'Wrong product': 'Return & Replacement',
    'Failed Shipment': 'Reship',
};

let client = null;
const anthropic = () => {
    if (!client) client = new (Anthropic.default || Anthropic)({ timeout: 90_000, maxRetries: 2 });
    return client;
};

/* ── Whether it may run ───────────────────────────────────────────────────────────────────── */

async function settingsFor(lineId) {
    const s = await readSettings(lineId);
    return { all: s, agent: { ...s.agent, model: MODELS.includes(s.agent.model) ? s.agent.model : MODELS[0] } };
}

/** Switched on, a key on the server, and money left in the month's budget. */
async function status(lineId) {
    const { agent } = await settingsFor(lineId);
    if (!process.env.ANTHROPIC_API_KEY) return { on: false, why: 'No Anthropic API key on the server' };
    if (!agent.enabled) return { on: false, why: 'Switched off' };
    const spent = await usage.monthSpend();
    if (agent.budget_usd > 0 && spent >= agent.budget_usd) return { on: false, why: `This month's budget ($${agent.budget_usd}) is spent`, spent };
    return { on: true, spent };
}

const LAST = (col) => `(SELECT m.${col} FROM wa_messages m WHERE m.conversation_id = c.id AND m.type <> 'reaction'
                         ORDER BY COALESCE(m.sent_at, m.created_at) DESC, m.id DESC LIMIT 1)`;

/** The chat, if it is one the agent should answer now — with why not when it isn't. */
async function waiting(conversationId, lineId, { quietMinutes = 30, force = false } = {}) {
    const c = (await db.query(
        `SELECT c.*, k.phone, k.profile_name, k.customer_id,
                NULLIF(TRIM(CONCAT(cu.first_name, ' ', cu.last_name)), '') AS customer_name,
                ${LAST('direction')} AS last_direction, ${LAST('id')} AS last_id,
                (SELECT MAX(created_at) FROM wa_messages p WHERE p.conversation_id = c.id AND p.direction = 'out'
                    AND p.sender_type IN ('user','phone')) AS person_at,
                EXISTS (SELECT 1 FROM nl_ai_questions q WHERE q.conversation_id = c.id AND q.status = 'open') AS asked,
                EXISTS (SELECT 1 FROM vendors v WHERE v.phone IS NOT NULL AND v.phone = RIGHT(k.phone, 10)) AS vendor
           FROM wa_conversations c JOIN wa_contacts k ON k.id = c.contact_id
           LEFT JOIN customers cu ON cu.id = k.customer_id
          WHERE c.id = $1 AND c.line_id = $2`, [conversationId, lineId])).rows[0];
    if (!c) return { why: 'No such chat' };
    if (c.phone === handover.DEMO_PHONE) return { why: 'The demo chat' };
    if (c.vendor) return { why: 'A vendor' };
    if (c.status !== 'open') return { why: 'Closed' };
    if (c.ai_paused) return { why: 'Paused on this chat' };
    if (force) return { conversation: c };
    if (c.mode !== 'human') return { why: 'The bot has it' };
    if (c.last_direction !== 'in') return { why: 'Nothing new from the customer' };
    if (c.settled_msg_id && Number(c.settled_msg_id) === Number(c.last_id)) return { why: 'Marked as needing no reply' };
    if (!wa.windowOpen(c.last_inbound_at)) return { why: 'Past the 24-hour window' };
    if (c.asked) return { why: 'Waiting for the team to answer its question' };
    if (c.person_at && Date.now() - new Date(c.person_at).getTime() < quietMinutes * 60_000) return { why: 'A person is in this chat' };
    return { conversation: c };
}

/**
 * The inbox's two Normless queues, as SQL over wa_conversations c / wa_contacts k. `base` is the
 * inbox's own "customer spoke last, a person has it" condition. With the agent on, a chat it is
 * about to answer is the agent's, not the team's; it comes back to "Needs a person" when the agent
 * asks the team, is paused on it, a person is in it, or it hasn't answered within the grace time.
 */
const ASKED = `EXISTS (SELECT 1 FROM nl_ai_questions aq WHERE aq.conversation_id = c.id AND aq.status = 'open')`;
const TOUCHED = `(EXISTS (SELECT 1 FROM wa_messages am WHERE am.conversation_id = c.id AND am.sender_user = 'ai-agent' AND am.created_at > NOW() - INTERVAL '7 days')
                 OR EXISTS (SELECT 1 FROM wa_activity aa WHERE aa.conversation_id = c.id AND aa.actor = 'ai-agent' AND aa.created_at > NOW() - INTERVAL '7 days'))`;
async function inboxSql(lineId, base) {
    const st = await status(lineId);
    const { agent } = await settingsFor(lineId);
    const quiet = Math.max(0, Math.round(Number(agent.quiet_minutes) || 0));
    const personIn = `EXISTS (SELECT 1 FROM wa_messages pm WHERE pm.conversation_id = c.id AND pm.direction = 'out'
                        AND pm.sender_type IN ('user','phone') AND pm.created_at > NOW() - INTERVAL '${quiet} minutes')`;
    const vendor = `EXISTS (SELECT 1 FROM vendors vv WHERE vv.phone IS NOT NULL AND vv.phone = RIGHT(k.phone, 10))`;
    const aiHas = st.on
        ? `(${base} AND NOT c.ai_paused AND c.last_inbound_at > NOW() - INTERVAL '${GRACE_MINUTES} minutes' AND NOT ${personIn} AND NOT ${ASKED} AND NOT ${vendor})`
        : 'FALSE';
    return {
        on: st.on,
        waiting: `(((${base}) OR (c.status = 'open' AND ${ASKED})) AND NOT ${aiHas})`,
        ai: `(${TOUCHED} OR ${ASKED} OR ${aiHas})`,
        aiHas,
    };
}

/** Per chat, for the inbox list: what the agent is doing on it. */
async function inboxStates(ids) {
    if (!ids.length) return new Map();
    const r = await db.query(
        `SELECT c.id,
                (SELECT q.question FROM nl_ai_questions q WHERE q.conversation_id = c.id AND q.status = 'open' ORDER BY q.id DESC LIMIT 1) AS question,
                (SELECT MAX(m.created_at) FROM wa_messages m WHERE m.conversation_id = c.id AND m.sender_user = 'ai-agent') AS replied_at,
                (SELECT a.created_at FROM wa_activity a WHERE a.conversation_id = c.id AND a.actor = 'ai-agent' AND a.body LIKE 'AI agent closed%'
                  ORDER BY a.id DESC LIMIT 1) AS closed_at,
                c.ai_paused, c.status
           FROM wa_conversations c WHERE c.id = ANY($1)`, [ids]);
    return new Map(r.rows.map(x => [x.id, {
        state: x.question ? 'asked' : x.ai_paused ? 'paused' : x.status === 'closed' && x.closed_at ? 'closed' : x.replied_at ? 'replied' : null,
        question: x.question, replied_at: x.replied_at, closed_at: x.closed_at,
    }]));
}

/* ── What it is told ──────────────────────────────────────────────────────────────────────── */

const STABLE = `You are the Normless team's AI agent on WhatsApp. Normless (normless.store) is an Indian
streetwear brand: oversized tees, hoodies, joggers and accessories. The chats you get are the ones the
Normless bot could not handle and handed to the team: late orders, tracking problems, cancellations,
address or size changes, complaints. You answer them the way a careful, kind person on the team would.

How you work:
- Read the whole chat first, including what the team and the bot already told this customer. Never
  repeat a reply they already got word for word; if they ask again, acknowledge that and add what's new.
- The customer's orders are in "This chat" below, found by their WhatsApp number. If none are there,
  or they ask about another order, and they give a different phone number or an email address, call
  find_orders with it. Before saying where a parcel is, use the live tracking in "This chat" or call
  track_shipment for that order: it gives Delhivery's live status, and finds a shipment re-made under
  the order number with an "A" on the end (e.g. 12598A) when the first one was cancelled. Give the
  new tracking ID and link when there is one.
- Photos and videos the customer sent in this chat are attached to any ticket you raise, and ones
  sent later are added to their open ticket, so you don't need to ask for them again.
- Follow the team's lessons and announcements below. They override anything else here. If one says
  not to promise something, don't.
- You cannot refund, cancel, discount, change an order, or promise a delivery or dispatch date unless
  a lesson or the team's answer says you can. Never say you have done any of these.
- Raise a support ticket with raise_ticket for: an address change before dispatch (get the full new
  address with pincode), a size change before dispatch (reason "Size Change", with the new size), a
  size exchange after delivery (reason "Initiate Replacement": item unworn, unwashed, tags on; get the
  size they want), a damaged or wrong item (after photos or the unboxing video arrived), a failed
  delivery. The customer is sent the ticket number automatically, so your reply only needs to say the
  team is on it and will update them here.
- Their tickets are in "This chat" below with status, progress and what the team did. When a customer
  asks about one, tell them where it stands in plain words (never quote internal notes).
- When you don't know the answer, the customer asks for something only the team can decide (a refund,
  a call back, an exception), they are angry after two replies, or anything is unclear: call ask_team
  with a precise question and what you already checked, and write nothing else. Never guess.
- If the customer's last message needs no reply ("ok", "thanks", a thumbs up) and nothing is pending,
  call close_chat.

How you write: like a real person on the Normless customer care team typing on WhatsApp. Short and
warm, 1 to 4 short sentences, natural and specific to this customer, never templated or robotic.
Plain text, *single asterisks* for bold if needed, no headings, no bullet lists, paste links as plain
URLs. Apologise once, sincerely, when we are late or wrong; don't grovel. Use the customer's first
name when known. Write as "we" / "I" from the Normless team. Don't sign with a name and don't start
with a label in brackets. Never mention AI, bots, assistants, automation, tools, "the system" or
"checking my data". If a customer sincerely asks whether they are talking to a bot or a real person,
don't answer that yourself and never claim to be human: call ask_team so a person on the team takes
the chat. Reply in the customer's language if they don't write in English.

The refund policy is at ${REFUND_POLICY}.`;

const TOOLS = [
    ...bot.TOOLS.filter(t => ['search_products', 'send_product', 'send_size_chart', 'lookup_order', 'get_policy'].includes(t.name)),
    {
        name: 'find_orders',
        description: "Find a customer's orders by the phone number or email address they placed them with, when it isn't this WhatsApp number (no orders in \"This chat\", or they mention another one). Returns each order with items, payment, status and tracking.",
        input_schema: {
            type: 'object',
            properties: {
                phone: { type: 'string', description: '10-digit Indian mobile number the order was placed with' },
                email: { type: 'string', description: 'Email address the order was placed with' },
            },
        },
    },
    {
        name: 'track_shipment',
        description: 'Live Delhivery status for one order: every shipment made for it, including one re-made as the order number with "A" on the end after the first was cancelled. Returns AWB, status, last scan and tracking link for each.',
        input_schema: { type: 'object', properties: { order_number: { type: 'string', description: 'e.g. #12598' } }, required: ['order_number'] },
    },
    {
        name: 'raise_ticket',
        description: 'Raise a Normless support ticket for the team to act on. The customer is sent the ticket number on WhatsApp automatically. Only once you have everything the team needs (the full new address with pincode, the new size, photos received).',
        input_schema: {
            type: 'object',
            properties: {
                order_number: { type: 'string' },
                reason: { type: 'string', enum: Object.keys(TICKET_REASONS) },
                request: { type: 'string', description: 'Exactly what the team must do, with the details: e.g. "Change size of Venom Hoodie from L to XL" or the full new address' },
            },
            required: ['order_number', 'reason', 'request'],
        },
    },
    {
        name: 'ask_team',
        description: "Ask the Normless team when you don't know or it isn't yours to decide. The customer is told we are checking; the team's answer comes back to you. Write nothing else in the same reply.",
        input_schema: {
            type: 'object',
            properties: {
                question: { type: 'string', description: 'The precise question, e.g. "Customer on #13043 says the courier asked for ₹200 more on a prepaid order. What should I tell them?"' },
                checked: { type: 'string', description: 'What you already looked up and found' },
                holding_message: { type: 'string', description: 'Short message to the customer saying we are checking with the team and will reply here. Leave empty if we already told them that in the last hour.' },
            },
            required: ['question'],
        },
    },
    {
        name: 'close_chat',
        description: "Close the chat when the customer's last message needs no reply and nothing is pending. They get a short note that they can write again anytime.",
        input_schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
    },
];

/** Lessons and announcements in force, as the prompt reads them. */
async function playbook(lineId) {
    const r = await db.query(
        `SELECT id, kind, title, body, expires_at FROM nl_ai_lessons
          WHERE line_id = $1 AND active AND (expires_at IS NULL OR expires_at > now())
          ORDER BY kind DESC, id`, [lineId]);
    const fmt = (l) => `- ${l.title ? `${l.title}: ` : ''}${l.body}${l.expires_at ? ` (until ${new Date(l.expires_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' })})` : ''}`;
    const ann = r.rows.filter(l => l.kind === 'announcement');
    const les = r.rows.filter(l => l.kind !== 'announcement');
    return {
        text: `What is happening right now (announcements):\n${ann.map(fmt).join('\n') || '- Nothing special.'}\n\nThe team's lessons:\n${les.map(fmt).join('\n') || '- None yet.'}`,
        rows: r.rows,
    };
}

const firstName = (c) => String(c.customer_name || c.profile_name || '').replace(/^~/, '').trim().split(/\s+/)[0] || '';
const istNow = () => new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/** What the agent should know about this chat before it starts. */
async function contextFor(c, settings) {
    const data = c.id ? await shop.customerFor(c).catch(() => ({ orders: [], tickets: [] })) : { orders: [], tickets: [] };
    const notes = (await db.query(
        `SELECT author, body FROM wa_notes WHERE conversation_id = $1 ORDER BY id DESC LIMIT 4`, [c.id || 0])).rows;
    const answers = (await db.query(
        `SELECT question, answer, answered_by FROM nl_ai_questions WHERE conversation_id = $1 AND status = 'answered'
          ORDER BY answered_at DESC LIMIT 5`, [c.id || 0])).rows;
    const assignee = c.assigned_to ? handover.displayName(await db.query(
        `SELECT username, wa_display_name FROM admin_users WHERE LOWER(username) = LOWER($1)`, [c.assigned_to]).then(r => r.rows[0] || { username: c.assigned_to })) : null;
    const orders = (data.orders || []).slice(0, 6).map(o => ({
        order: o.order_number, placed: o.created_at, state: o.state, payment: o.payment?.label, total: o.total_price,
        items: (o.items || []).map(i => `${i.title}${i.variant ? ` (${i.variant})` : ''} x${i.quantity || 1}`),
        awb: o.dispatch?.awb || null, tracking: o.dispatch?.tracking_url || null,
    }));
    // Live tracking for the latest orders still on their way, fetched before the model starts so it
    // doesn't spend a round (and a resend of the whole chat) asking for it.
    const recent = orders.filter(o => o.state !== 'Cancelled' && Date.now() - new Date(o.placed || 0).getTime() < 45 * 86400000).slice(0, 2);
    const live = [];
    for (const o of recent) {
        try { live.push(await trackShipment(o.order)); } catch { /* the tool is still there */ }
    }
    const tickets = (data.tickets || []).slice(0, 6).map(t => ({
        ref: `CS-${String(t.ref_no).padStart(4, '0')}`, order: t.order_number, reason: t.reason, raised: t.raised_on,
        status: t.status, progress: t.progress, done_by_team: t.action || null,
    }));
    return [
        `Now: ${istNow()} (India). Team hours ${clock(settings.hours.start)} to ${clock(settings.hours.end)}; the team is ${isOpen(settings.hours) ? 'online' : 'offline'} now.`,
        `Customer: ${firstName(c) || 'name unknown'}${c.phone ? `, WhatsApp +${c.phone}` : ''}.${assignee ? ` The chat is assigned to ${assignee} on the team.` : ''}`,
        `Their orders: ${orders.length ? JSON.stringify(orders) : 'none found by this phone number; ask for the order number if they mention one.'}`,
        live.length ? `Live Delhivery tracking, checked just now (no need to call track_shipment again for these): ${JSON.stringify(live)}` : null,
        `Their support tickets: ${tickets.length ? JSON.stringify(tickets) : 'none.'}`,
        notes.length ? `Team notes on this chat (newest first):\n${notes.map(n => `- ${n.author}: ${String(n.body).slice(0, 500)}`).join('\n')}` : null,
        answers.length ? `The team already answered your questions on this chat (use these):\n${answers.map(a => `- Q: ${a.question}\n  A (${String(a.answered_by || '').split('@')[0]}): ${a.answer}`).join('\n')}` : null,
    ].filter(Boolean).join('\n\n');
}

/** The chat so far. Messages from us are labelled with who sent them, so it knows who said what. */
async function history(conversationId) {
    const r = await db.query(
        `SELECT direction, sender_type, sender_user, body, type, media_mime FROM wa_messages
          WHERE conversation_id = $1 AND type <> 'reaction'
          ORDER BY COALESCE(sent_at, created_at) DESC, id DESC LIMIT $2`, [conversationId, HISTORY]);
    return r.rows.reverse().map(m => {
        const media = m.media_mime ? `[sent a ${m.media_mime.startsWith('video/') ? 'video' : m.media_mime.startsWith('image/') ? 'photo' : 'file'}] ` : '';
        const who = m.direction === 'in' ? ''
            : m.sender_type === 'user' || m.sender_type === 'phone' ? `[Team: ${String(m.sender_user || 'a person').split('@')[0]}] `
            : m.sender_type === 'bot' ? '[Bot] ' : m.sender_type === 'auto' ? '[Automatic message] ' : m.type === 'template' ? '[Template] ' : '';
        return { role: m.direction === 'in' ? 'user' : 'assistant', text: `${who}${media}${m.body || ''}`.trim() };
    });
}

/* ── Its tools ─────────────────────────────────────────────────────────────────────────────── */

const shapeTrack = (x) => ({
    awb: x.AWB, ref: x.ReferenceNo, status: x.Status?.Status, last_scan: x.Status?.Instructions || null,
    at: x.Status?.StatusDateTime || null, where: x.Status?.StatusLocation || null,
    tracking_url: x.AWB ? `https://www.delhivery.com/track-v2/package/${x.AWB}` : null,
});

async function trackShipment(orderNumber) {
    const digits = String(orderNumber || '').match(/\d{3,}/)?.[0];
    if (!digits) return { error: 'Give the order number, e.g. #12598' };
    const num = `#${digits}`;
    const known = (await db.query(
        `SELECT awb FROM shipments WHERE order_number = $1 UNION SELECT awb FROM packed_orders WHERE order_number = $1 AND awb IS NOT NULL`, [num])).rows.map(r => r.awb);
    const delhivery = require('./delhivery');
    let live = [], remade = [];
    try { live = known.length ? await delhivery.track(known) : []; } catch (err) { return { error: `Delhivery didn't answer: ${err.message}` }; }
    try { remade = await delhivery.trackByOrder([`${digits}A`]); } catch { /* no re-made shipment */ }
    const shipments = [...live.map(shapeTrack), ...remade.filter(x => !known.includes(String(x.AWB))).map(x => ({ ...shapeTrack(x), remade: true }))];
    if (!shipments.length) return { order: num, shipments: [], note: 'No shipment has been made for this order yet: it has not been dispatched.' };
    return {
        order: num, shipments,
        note: shipments.some(s => s.remade) ? 'A shipment marked remade replaced an earlier one that was cancelled; give the customer the remade one.' : undefined,
    };
}

/** A new support ticket with the next CS- number. Returns its id. */
async function createTicket(f) {
    return db.transaction(async (tx) => {
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext('support_ticket_ref'))`);
        const next = (await tx.query('SELECT COALESCE(MAX(ref_no), 0) + 1 AS n FROM support_tickets')).rows[0].n;
        return (await tx.query(
            `INSERT INTO support_tickets (ref_no, created_by, raised_on, source, order_number, customer_name, customer_phone, customer_email,
                    nature, reason, request, status, progress, wa_conversation_id, email_thread_id)
             VALUES ($1,$2,(now() AT TIME ZONE 'Asia/Kolkata')::date,$3,$4,$5,$6,$7,$8,$9,$10,'Open','Pending',$11,$12)
             RETURNING id`,
            [next, f.actor, f.source, f.order_number, f.customer_name || null, f.customer_phone || null, f.customer_email || null,
                TICKET_REASONS[f.reason], f.reason, String(f.request).slice(0, 2000), f.wa_conversation_id || null, f.email_thread_id || null])).rows[0].id;
    });
}

async function raiseTicket(c, input, actor) {
    const reason = Object.keys(TICKET_REASONS).includes(input.reason) ? input.reason : null;
    const digits = String(input.order_number || '').match(/\d{3,}/)?.[0];
    if (!reason) return { error: 'Pick one of the listed reasons' };
    if (!digits) return { error: 'Give the order number' };
    if (!String(input.request || '').trim()) return { error: 'Say what the team must do' };
    const num = `#${digits}`;
    const dup = (await db.query(
        `SELECT ref_no FROM support_tickets WHERE order_number = $1 AND reason = $2 AND status = 'Open' LIMIT 1`, [num, reason])).rows[0];
    if (dup) return { already_open: `CS-${String(dup.ref_no).padStart(4, '0')}`, note: 'A ticket for this is already open; the team is on it.' };
    const order = (await db.query(`SELECT email FROM orders WHERE order_number = $1`, [num])).rows[0];
    const id = await createTicket({
        actor, source: 'WhatsApp', order_number: num, reason, request: input.request,
        customer_name: c.customer_name || String(c.profile_name || '').replace(/^~/, '') || null,
        customer_phone: c.phone, customer_email: order?.email || null, wa_conversation_id: c.id,
    });
    const row = (await db.query(
        `SELECT id, ref_no, order_number, customer_name, customer_phone, reason, nature, request, wa_conversation_id FROM support_tickets WHERE id = $1`, [id])).rows[0];
    const ref = `CS-${String(row.ref_no).padStart(4, '0')}`;
    const photos = await files.addChatPhotos(id, c.id);
    await log(c.id, 'ticket', `AI agent raised ${ref} (${reason}) for ${num}${photos ? ` with ${photos} photo${photos > 1 ? 's' : ''} from the chat` : ''}`);
    let told = null;
    try { told = await require('./nl-automations').ticketRaised(row); } catch (err) { told = { status: 'failed', error: err.message }; }
    return { raised: ref, customer_told: told?.status === 'sent' || told?.status === 'queued' ? 'yes, automatically' : 'no — mention the ticket number in your reply' };
}

/* ── Doing things in the chat ──────────────────────────────────────────────────────────────── */

async function log(conversationId, kind, body) {
    if (!conversationId) return;
    await db.query(`INSERT INTO wa_activity (conversation_id, kind, body, actor) VALUES ($1,$2,$3,'ai-agent')`, [conversationId, kind, body]);
}

/** Send a text from the agent and write it down. */
async function say(c, text) {
    const wamid = await wa.sendText(c.phone, text);
    await db.query(
        `INSERT INTO wa_messages (conversation_id, wamid, direction, sender_type, sender_user, type, body, status)
         VALUES ($1,$2,'out','ai','ai-agent','text',$3,'sent')`, [c.id, wamid, text]);
    await db.query(
        `UPDATE wa_conversations SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = $2, unread_count = 0,
                updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [c.id, String(text).slice(0, 200)]);
    return wamid;
}

async function closeChat(c, reason, { quiet = false } = {}) {
    // Gone quiet mid-conversation: the chat stays the agent's, so when they write back (with the
    // address it asked for, say) it carries on rather than the bot starting over.
    await db.query(
        `UPDATE wa_conversations SET status = 'closed', mode = CASE WHEN $2 THEN mode ELSE 'ai' END, assigned_to = NULL,
                nl_handoff_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [c.id, quiet]);
    if (!quiet && wa.windowOpen(c.last_inbound_at)) {
        const note = 'Our team has closed this chat. If you need anything else, just send us a message here and we’ll be happy to help.';
        const wamid = await wa.sendText(c.phone, note);
        await handover.record(c.id, wamid, note, 'auto');
    }
    await log(c.id, 'status', `AI agent closed the chat: ${String(reason || '').slice(0, 200)}`);
}

/** Put a question to the team, tell the customer we're checking, and make sure a person owns it. */
async function askTeam(c, input, lineId) {
    const question = String(input.question || '').trim().slice(0, 1500) || 'The agent could not answer this chat.';
    await db.query(
        `INSERT INTO nl_ai_questions (line_id, conversation_id, question, context) VALUES ($1,$2,$3,$4)`,
        [lineId, c.id, question, String(input.checked || '').slice(0, 2000) || null]);
    await db.query(`UPDATE wa_conversations SET mode = 'human', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [c.id]);
    await log(c.id, 'ai', `AI agent asked the team: ${question.slice(0, 300)}`);
    const hold = String(input.holding_message || '').trim();
    if (hold && wa.windowOpen(c.last_inbound_at)) await say(c, hold.slice(0, 1000));
    let owner = c.assigned_to;
    if (!owner) {
        const agent = await handover.pickAgent(lineId);
        if (agent) { await handover.assign(c, agent.username, { introduce: false }); owner = agent.username; }
    }
    if (owner) {
        await require('./notify').notify({
            usernames: [owner], kind: 'whatsapp', actor: 'ai-agent', link: `/whatsapp?c=${c.id}`,
            title: `The AI agent needs your answer: ${firstName(c) || 'a customer'}`, body: question.slice(0, 300),
        });
    }
}

/* ── Thinking ──────────────────────────────────────────────────────────────────────────────── */

/**
 * The model's turn on one chat. `task` is what the team asked for this run (an answer to the
 * agent's question, or an instruction), else it just answers the customer. `dry` sends nothing.
 * Returns { text } | { asked } | { closed } | { nothing } | { error }, plus what tools did.
 */
async function think({ c, lineId, settings, task = null, turns = null, dry = false }) {
    const { agent } = settings;
    const book = await playbook(lineId);
    const msgs = bot.asMessages(turns || await history(c.id));
    const note = task ? `[From the Normless team, not the customer] ${task}` : null;
    if (note) {
        if (msgs.length && msgs[msgs.length - 1].role === 'user') msgs[msgs.length - 1].content += `\n\n${note}`;
        else msgs.push({ role: 'user', content: note });
    }
    if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return { nothing: true };

    const context = dry && !c.id ? 'This is a test from the AI agent page. There is no real customer, no orders and nothing is sent.' : await contextFor(c, settings.all);
    const did = [];
    let seen = `${book.text} ${context} 198 24`;

    for (let round = 0; round < MAX_ROUNDS; round++) {
        const response = await anthropic().beta.messages.create({
            ...requestFor(agent.model),
            system: [
                { type: 'text', text: STABLE, cache_control: { type: 'ephemeral' } },
                { type: 'text', text: book.text, cache_control: { type: 'ephemeral' } },
                { type: 'text', text: `This chat:\n${context}` },
            ],
            tools: TOOLS,
            messages: msgs,
        });
        await usage.record(dry ? 'nl_try' : 'nl_agent', response, { conversationId: c.id || null });

        if (response.stop_reason === 'refusal') return { ask: { question: 'The AI agent could not answer this chat. Please reply to the customer.' }, did };
        msgs.push({ role: 'assistant', content: response.content });
        const calls = response.content.filter(b => b.type === 'tool_use');

        const asking = calls.find(x => x.name === 'ask_team');
        if (asking) return { ask: asking.input || {}, did };
        const closing = calls.find(x => x.name === 'close_chat');
        if (closing) return { close: closing.input?.reason || 'Nothing more to answer', did };

        if (!calls.length || response.stop_reason === 'end_turn') {
            const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
                .replace(/^\[[^\]]{1,40}\]\s*/, '');
            if (!text) return { nothing: true, did };
            const bad = bot.inventedFigure(text, seen);
            if (bad != null) return { ask: { question: `I wanted to reply with an amount (₹${bad}) I couldn't verify. My draft: "${text.slice(0, 600)}" — what should I say?` }, did };
            return { text, did };
        }

        const results = [];
        for (const call of calls) {
            let result;
            try {
                if (call.name === 'track_shipment') result = await trackShipment(call.input?.order_number);
                else if (call.name === 'find_orders') result = dry ? { orders: [], message: 'Test: no real orders.' } : await shop.ordersByContact(call.input || {});
                else if (call.name === 'raise_ticket') {
                    result = dry ? { raised: 'CS-TEST', customer_told: 'yes, automatically (test: nothing raised)' }
                        : await raiseTicket(c, call.input || {}, 'ai-agent');
                } else {
                    const sent = [];
                    result = await bot.runTool(call.name, call.input || {}, { conversation: c, dry, sent });
                    if (sent.length && !dry) {
                        for (const s of sent) await db.query(`UPDATE wa_messages SET sender_type = 'ai', sender_user = 'ai-agent' WHERE conversation_id = $1 AND body = $2 AND sender_type = 'bot'`, [c.id, s.text]);
                    }
                    did.push(...sent.map(s => `${s.kind}: ${s.text.split('\n')[0]}`));
                }
                if (call.name === 'raise_ticket' && result?.raised) did.push(`ticket ${result.raised}`);
            } catch (err) { result = { error: `That didn't work: ${err.message}` }; }
            const json = JSON.stringify(result);
            seen += ` ${json}`;
            results.push({ type: 'tool_result', tool_use_id: call.id, content: json, ...(result?.error ? { is_error: true } : {}) });
        }
        msgs.push({ role: 'user', content: results });
    }
    return { ask: { question: 'I went round in circles on this chat and could not settle on an answer. Please take a look.' }, did };
}

/* ── Running it on a chat ──────────────────────────────────────────────────────────────────── */

const running = new Set();
const timers = new Map();

/**
 * Work one chat now. `task` (with `force`) is the team telling it what to do; otherwise it only
 * acts if the chat is waiting. Returns what happened, for the inbox to show.
 */
async function run(conversationId, { task = null, force = false } = {}) {
    if (running.has(conversationId)) return { skipped: 'Already working on this chat' };
    running.add(conversationId);
    try {
        const line = lines.get('normless');
        return await lines.run(line, async () => {
            const st = await status(line.id);
            if (!st.on) return { skipped: st.why };
            const settings = await settingsFor(line.id);
            const w = await waiting(conversationId, line.id, { quietMinutes: settings.agent.quiet_minutes, force });
            if (!w.conversation) return { skipped: w.why };
            const c = w.conversation;

            // Past the 24-hour window a text can't go: the team's answer waits until they write.
            if (!wa.windowOpen(c.last_inbound_at)) {
                return { skipped: 'Past the 24-hour window: the customer has to write first. The agent will use this when they do.' };
            }

            const started = Date.now();
            let out;
            try { out = await think({ c, lineId: line.id, settings, task }); }
            catch (err) {
                console.error('normless agent failed:', err.message);
                out = { ask: { question: `The AI agent ran into a problem (${String(err.message).slice(0, 150)}). Please reply to this customer.` } };
            }

            // A person may have written while it was thinking: then it stays quiet.
            const after = (await db.query(
                `SELECT status, ai_paused, (SELECT MAX(created_at) FROM wa_messages p WHERE p.conversation_id = $1 AND p.direction = 'out'
                        AND p.sender_type IN ('user','phone')) AS person_at FROM wa_conversations WHERE id = $1`, [c.id])).rows[0];
            if (!task && (after.ai_paused || after.status !== 'open' || (after.person_at && new Date(after.person_at).getTime() > started))) {
                return { skipped: 'A person replied meanwhile' };
            }

            if (out.ask) { await askTeam(c, out.ask, line.id); return { asked: out.ask.question, did: out.did }; }
            if (out.close) {
                if (!settings.agent.close_when_done) return { skipped: 'Nothing to answer (closing is switched off)' };
                await closeChat(c, out.close); return { closed: out.close, did: out.did };
            }
            if (out.text) {
                await say(c, out.text);
                await log(c.id, 'ai', `AI agent replied${task ? ' (as the team asked)' : ''}`);
                return { replied: out.text, did: out.did };
            }
            // A customer waiting and nothing to say: that is a chat for a person.
            if (!task && c.last_direction === 'in') {
                await askTeam(c, { question: 'I couldn’t work out a reply to the customer’s last message. Please answer them.' }, line.id);
                return { asked: 'No reply worked out', did: out.did };
            }
            return { nothing: true, did: out.did };
        });
    } finally {
        running.delete(conversationId);
    }
}

/** A customer wrote on a chat a person has, or the bot just handed one over: look again shortly. */
function schedule(conversationId, delay = SETTLE_MS) {
    clearTimeout(timers.get(conversationId));
    timers.set(conversationId, setTimeout(() => {
        timers.delete(conversationId);
        run(conversationId).catch(err => console.error('normless agent error:', err.message));
    }, delay));
}

/** Every few minutes: the chats waiting for a person that nobody is in. Oldest first. */
async function sweep() {
    try {
        const line = lines.get('normless');
        if (!line || !(await status(line.id)).on) return;
        const r = await db.query(
            `SELECT c.id FROM wa_conversations c
              WHERE c.line_id = $1 AND c.status = 'open' AND c.mode = 'human' AND NOT c.ai_paused
                AND c.last_inbound_at > now() - INTERVAL '23 hours'
                AND NOT EXISTS (SELECT 1 FROM vendors vv JOIN wa_contacts kk ON vv.phone = RIGHT(kk.phone, 10) WHERE kk.id = c.contact_id)
                AND ${LAST('direction')} = 'in'
                AND (c.settled_msg_id IS NULL OR ${LAST('id')} <> c.settled_msg_id)
                AND NOT EXISTS (SELECT 1 FROM nl_ai_questions q WHERE q.conversation_id = c.id AND q.status = 'open')
              ORDER BY c.last_inbound_at ASC LIMIT $2`, [line.id, SWEEP_MAX]);
        for (const { id } of r.rows) {
            if (timers.has(id)) continue;
            await run(id).catch(err => console.error('normless agent sweep error:', err.message));
        }
    } catch (err) {
        console.error('normless agent sweep failed:', err.message);
    }
}

/**
 * The first Playbook: what the team decided while answering the dispatch-delay chats by hand on
 * 23 Nov 2026. Written once, when the line has never had a lesson; edited on the page after that.
 */
const FIRST_PLAYBOOK = [
    ['lesson', 'Dr Doom Hoodie and Doomsday Mask orders', 'Never give a dispatch or delivery date. Say: sorry for the delay, we are working hard to dispatch your order, and we will share the tracking ID here as soon as it ships.'],
    ['lesson', 'Tracking shows "cancelled"', 'Because of the dispatch delay, the first tracking ID was cancelled automatically by the courier. The order itself is NOT cancelled. Check track_shipment: if there is a re-made shipment (order number with "A"), give that new tracking ID and link. If there is none yet, say a new tracking ID is being created and will be shared here.'],
    ['lesson', 'Customer wants to cancel or get a refund', `The first time: apologise for the delay, ask them kindly to wait as their order will be shipped soon, and share the refund policy (${REFUND_POLICY}) saying that if they still need to cancel they can follow it. If they insist after that, or say they already raised a refund, ask the team — refunds are the team's decision.`],
    ['lesson', 'Instagram', 'Mention Instagram only if the customer asks about it: our Instagram account is restricted for now and we have sent an appeal to Meta. They can reach us here on WhatsApp meanwhile.'],
    ['lesson', 'Address or size change', 'Get the full new address with pincode (or the new size), then raise a support ticket (Address update / Size Change). The customer gets the ticket number automatically.'],
    ['lesson', 'Worried it is a scam or their money is gone', 'Reassure them: Normless is a real brand, their payment and order are safe, and the order will be dispatched. Give the order number and what track_shipment shows.'],
];

async function seedPlaybook() {
    try {
        await lines.ready();
        const line = lines.get('normless');
        if (!line) return;
        const had = (await db.query(`SELECT 1 FROM nl_ai_lessons WHERE line_id = $1 LIMIT 1`, [line.id])).rows[0];
        if (had) return;
        for (const [kind, title, body] of FIRST_PLAYBOOK) {
            await db.query(
                `INSERT INTO nl_ai_lessons (line_id, kind, title, body, source, created_by) VALUES ($1,$2,$3,$4,'manual','set up from the 23 Nov chats')`,
                [line.id, kind, title, body]);
        }
        await db.query(
            `INSERT INTO nl_ai_lessons (line_id, kind, title, body, expires_at, source, created_by)
             VALUES ($1,'announcement','Dispatch delay',$2,'2026-11-30T23:59:00+05:30','manual','set up from the 23 Nov chats')`,
            [line.id, 'Some orders are taking a few days longer than usual to dispatch. Apologise sincerely, say we are working hard to dispatch them, and that the tracking ID will be shared here once it ships. Don\'t promise a date unless the team gave one for that customer.']);
    } catch (err) {
        console.error('normless agent playbook seed failed:', err.message);
    }
}

/**
 * Chats the agent answered where the customer has gone quiet: closed after the minutes set on the
 * AI agent page, without a message (they can write again anytime, and the chat reopens). Not a
 * chat a person wrote in since, one with a question to the team, or one somebody paused it on.
 */
async function idleClose() {
    try {
        const line = lines.get('normless');
        if (!line || !(await status(line.id)).on) return;
        const { agent } = await settingsFor(line.id);
        const minutes = Math.round(Number(agent.idle_close_minutes) || 0);
        if (minutes <= 0) return;
        const r = await db.query(
            `SELECT c.id, c.last_inbound_at FROM wa_conversations c
              WHERE c.line_id = $1 AND c.status = 'open' AND NOT c.ai_paused
                AND ${LAST('direction')} = 'out'
                AND (SELECT MAX(m.created_at) FROM wa_messages m WHERE m.conversation_id = c.id) < now() - make_interval(mins => $2)
                AND EXISTS (SELECT 1 FROM wa_messages a WHERE a.conversation_id = c.id AND a.sender_user = 'ai-agent'
                             AND a.created_at >= COALESCE(c.last_inbound_at, '-infinity'))
                AND NOT EXISTS (SELECT 1 FROM wa_messages p WHERE p.conversation_id = c.id AND p.direction = 'out'
                             AND p.sender_type IN ('user','phone') AND p.created_at >= COALESCE(c.last_inbound_at, '-infinity'))
                AND NOT EXISTS (SELECT 1 FROM nl_ai_questions q WHERE q.conversation_id = c.id AND q.status = 'open')
              LIMIT 50`, [line.id, minutes]);
        for (const c of r.rows) {
            if (running.has(c.id)) continue;
            await lines.run(line, () => closeChat(c, `no reply from the customer for ${minutes} minutes`, { quiet: true }))
                .catch(err => console.error('normless agent idle close:', err.message));
        }
    } catch (err) {
        console.error('normless agent idle close failed:', err.message);
    }
}

/**
 * A photo arrived on a chat: put it on the chat's open support tickets raised in the last two
 * weeks (the proof a damaged or wrong item needs usually comes after the ticket).
 */
async function mediaArrived(conversationId) {
    try {
        const t = (await db.query(
            `SELECT id FROM support_tickets
              WHERE wa_conversation_id = $1 AND status = 'Open' AND created_at > now() - INTERVAL '14 days'`, [conversationId])).rows;
        for (const x of t) {
            const n = await files.addChatPhotos(x.id, conversationId);
            if (n) await log(conversationId, 'ticket', `Added ${n} photo${n > 1 ? 's' : ''} from the chat to the support ticket`);
        }
    } catch (err) {
        console.error('normless ticket photos:', err.message);
    }
}

let sweeping = null;
function start() {
    if (sweeping) return;
    seedPlaybook();
    sweeping = setInterval(sweep, SWEEP_MS);
    setInterval(idleClose, IDLE_MS);
    setTimeout(sweep, 60_000);
}

/** The team answered one of its questions: reply to the customer with it, and learn it if asked. */
async function answer(questionId, { answer: text, remember = false, lesson = null, by }) {
    const line = lines.get('normless');
    const q = (await db.query(`SELECT * FROM nl_ai_questions WHERE id = $1 AND line_id = $2`, [questionId, line.id])).rows[0];
    if (!q) throw Object.assign(new Error('That question is gone'), { status: 404 });
    if (q.status !== 'open') throw Object.assign(new Error('Somebody already answered this'), { status: 409 });
    const clean = String(text || '').trim().slice(0, 3000);
    if (!clean) throw Object.assign(new Error('Write the answer first'), { status: 400 });
    let lessonId = null;
    if (remember) {
        lessonId = (await db.query(
            `INSERT INTO nl_ai_lessons (line_id, kind, title, body, source, conversation_id, created_by)
             VALUES ($1,'lesson',$2,$3,'question',$4,$5) RETURNING id`,
            [line.id, q.question.slice(0, 200), String(lesson || clean).slice(0, 3000), q.conversation_id, by])).rows[0].id;
    }
    await db.query(
        `UPDATE nl_ai_questions SET status = 'answered', answer = $2, answered_by = $3, answered_at = now(), lesson_id = $4 WHERE id = $1`,
        [q.id, clean, by, lessonId]);
    const result = await run(q.conversation_id, {
        force: true,
        task: `${String(by || '').split('@')[0]} answered your question "${q.question}": ${clean}\nNow reply to the customer using this answer.`,
    });
    return { lesson_id: lessonId, ...result };
}

/* ── Telling customers about their tickets ───────────────────────────────────────────────── */

// What the team's "action" means to a customer.
const ACTION_WORDS = {
    'Size Updated': 'your size has been updated', 'Address Changed': 'your delivery address has been updated',
    'Return Initiated': 'your return has been started', 'Replacement Initiated': 'your replacement has been started',
    'Reshipped': 'your order has been shipped again', 'Shipped': 'your order has been shipped', 'Refunded': 'your refund has been processed',
    'Cancelled': 'your order has been cancelled',
};

/** In plain words, what changed on a ticket that the customer would want to hear. Null if nothing. */
function ticketNews(before, after) {
    if (after.action && after.action !== before.action && ACTION_WORDS[after.action]) return ACTION_WORDS[after.action];
    if (after.status === 'Closed' && before.status !== 'Closed') return 'it has been resolved';
    if (after.progress === 'In Progress' && before.progress !== 'In Progress') return 'our team has started working on it';
    return null;
}

/**
 * Somebody changed a support ticket. If the change is news to the customer (an action taken, work
 * started, resolved), they hear it on WhatsApp: written by the agent inside the 24-hour window,
 * else the approved "ticket update" template. Never throws.
 */
async function ticketUpdated(before, after) {
    try {
        const news = ticketNews(before || {}, after || {});
        if (!news) return null;
        const line = lines.get('normless');
        if (!line?.id) return null;
        const ref = `CS-${String(after.ref_no ?? 0).padStart(4, '0')}`;
        const conv = after.wa_conversation_id ? (await db.query(
            `SELECT c.id, c.last_inbound_at, c.ai_paused, c.status FROM wa_conversations c WHERE c.id = $1 AND c.line_id = $2`,
            [after.wa_conversation_id, line.id])).rows[0] : null;
        const subject = `${String(after.reason || 'your request').toLowerCase()}${after.order_number ? ` on order ${after.order_number}` : ''}`;
        if (conv && wa.windowOpen(conv.last_inbound_at) && (await status(line.id)).on && !conv.ai_paused) {
            if (conv.status !== 'open') await db.query(`UPDATE wa_conversations SET status = 'open' WHERE id = $1`, [conv.id]);
            await log(conv.id, 'ticket', `${ref} updated (${news}); the AI agent is telling the customer`);
            return await run(conv.id, {
                force: true,
                task: `Support ticket ${ref} (${subject}) was just updated by the team: ${news}.${after.request ? ` The request was: ${String(after.request).slice(0, 300)}.` : ''} Tell the customer this update in one or two friendly sentences, with the ticket number. Don't promise anything beyond it.`,
            });
        }
        return await require('./nl-automations').ticketUpdated?.(after, news) || null;
    } catch (err) {
        console.error('normless ticket update message:', err.message);
        return { status: 'failed', error: err.message };
    }
}

/** Settings › Try it: a pretend chat, answered with the real lessons, nothing sent. */
async function tryIt(turns) {
    if (!process.env.ANTHROPIC_API_KEY) return { error: 'No Anthropic API key is set on the server yet.' };
    const line = lines.get('normless');
    return lines.run(line, async () => {
        const settings = await settingsFor(line.id);
        const out = await think({
            c: { id: null, phone: null }, lineId: line.id, settings, dry: true,
            turns: turns.map(t => ({ role: t.role === 'customer' ? 'user' : 'assistant', text: String(t.text || '') })),
        });
        return { reply: out.text || null, asked: out.ask?.question || null, closed: out.close || null, did: out.did || [] };
    });
}

module.exports = { run, schedule, sweep, start, answer, tryIt, status, trackShipment, inboxSql, inboxStates, ticketUpdated, ticketNews, idleClose, mediaArrived, requestFor, createTicket, MODELS, TICKET_REASONS, STABLE, playbook };
