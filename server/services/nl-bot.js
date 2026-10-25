/**
 * The Normless WhatsApp bot.
 *
 * Answers every customer message it can — sizes, products, stock, where an order is, how
 * exchanges and returns work — from the shop's own data: Shopify's products, size charts and
 * policies, and the CRM's orders and dispatch log. Hands the chat to a person (nl-handover) for
 * what it must not decide or cannot answer: refunds, damaged or wrong items, an upset customer, a
 * question with no grounded answer.
 *
 * What keeps it honest is what it is able to do. Its tools only read and send information; none
 * can refund, discount, change an order or promise a date, so it can't do those things however it
 * is asked. Every rupee figure in a reply must appear in something a tool returned or in the
 * shop's own policies and answers; a reply with an invented figure is never sent — the chat goes
 * to a person instead.
 *
 * One reply per burst: customers send three messages in a row, so the bot waits a moment for the
 * burst to finish and answers once, and never runs twice on the same chat at the same time.
 */

const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db/connection');
const wa = require('./whatsapp');
const lines = require('./wa-line');
const shop = require('./nl-shop');
const shopify = require('./shopify');
const handover = require('./nl-handover');
const { readSettings, isOpen, clock } = require('./nl-settings');

const MODEL = process.env.NL_BOT_MODEL || 'claude-opus-5-5';
const MAX_TURNS = 6;          // tool rounds before it stops and hands over
const HISTORY = 24;           // messages of context
const SETTLE_MS = 2500;       // wait for a burst of messages to finish

let client = null;
const anthropic = () => {
    if (!client) client = new (Anthropic.default || Anthropic)({ timeout: 60_000, maxRetries: 2 });
    return client;
};

/** Switched on in Settings, and a key to answer with. */
async function enabled(lineId) {
    if (!process.env.ANTHROPIC_API_KEY) return false;
    return !!(await readSettings(lineId)).bot.enabled;
}

/* ── What it is told ──────────────────────────────────────────────────────────────────────── */

const STABLE = `You are the WhatsApp assistant for Normless (normless.store), an Indian streetwear brand:
oversized tees, tanks, joggers, hoodies and accessories. You answer customers on Normless's WhatsApp
number on behalf of the Normless team.

How you work:
- Answer from your tools and the shop facts below, never from memory. Look products up before
  describing them, look orders up before saying anything about one, and read the policy before
  explaining returns, exchanges, refunds or shipping.
- When a customer asks about a product, find it and send it with send_product so they get the photo,
  price, sizes in stock and the link. For size questions, send the product's size chart with
  send_size_chart and suggest a size from it; if the product has no size chart, hand over.
- For "where is my order", use get_my_orders first. If they give an order number that isn't theirs
  by phone, lookup_order will ask for the email or delivery pincode on the order — ask the customer
  for it. Never share details of an order that the tool hasn't released.
- You cannot refund, approve a replacement, discount, change an order or address, cancel, or promise
  a delivery date. Never say you will. Those go to a person.
- Hand over with hand_over (and write nothing else) when: a rule below says so, the customer asks for
  a person, they are upset or abusive, it is sensitive (legal, payment disputes, harassment), or you
  can't answer from your tools. Give a short reason and a summary the person can act on without
  re-reading the chat.

How you write: WhatsApp messages, short and warm — usually 1–3 short sentences, a list only for steps.
Plain text; *single asterisks* for bold if needed; no headings, no markdown links (paste the URL).
Use the customer's first name when you know it. Prices in ₹ exactly as the tools give them.`;

function dynamic(settings, context) {
    const h = settings.handoff;
    const rules = [
        h.refund && 'the customer asks for a refund',
        h.damaged && 'the item arrived damaged, defective or wrong — first ask for clear photos and the unboxing video, then hand over once they are sent',
        h.asks_person && 'the customer asks for a person',
        h.unsure && 'you have twice been unable to answer from your tools',
        h.no_order && 'no order can be found after you have asked once for the order number',
        h.upset && 'the customer is upset or repeats the same question three times',
        h.big_order && `the order is worth more than ₹${h.big_order_amount}`,
    ].filter(Boolean);
    const tone = { friendly: 'Friendly and short.', formal: 'Polite and formal.', playful: 'Playful, streetwear voice — but always clear.' }[settings.bot.tone] || 'Friendly and short.';
    const lang = settings.bot.language === 'customer' ? 'Reply in the language the customer writes in.' : 'Always reply in English.';
    const open = isOpen(settings.hours);
    return `Tone: ${tone} ${lang}

Hand over to a person when: ${rules.join('; ') || 'the customer asks for a person'}.

Team hours: ${clock(settings.hours.start)}–${clock(settings.hours.end)}, India time. ${open ? 'The team is online now.' : 'The team is offline right now; a handed-over chat is answered when they are back.'}

Shop facts:
- Size exchanges: unworn, unwashed, tags and packaging on; ₹198 exchange fee; raised by the customer
  at the Returns & Exchange Center: ${settings.menu.exchange_url} (order ID + email). A courier picks
  the item up; the new size ships after QC. Read the refund policy for the rest.
- Damaged or wrong item: must be reported within 24 hours of delivery with an unboxing video.
${settings.faqs.map(f => `- Q: ${f.q} A: ${f.a}`).join('\n')}

This chat: ${context}`;
}

const TOOLS = [
    {
        name: 'search_products',
        description: 'Search Normless products by name, type, colour or theme. Returns title, handle, price (₹), sizes in stock, link and whether it has a size chart.',
        input_schema: { type: 'object', properties: { query: { type: 'string', description: 'What the customer is looking for, e.g. "black oversized tee" or "CR7"' } }, required: ['query'] },
    },
    {
        name: 'send_product',
        description: 'Send the customer one product: its photo with name, price, sizes in stock and the link to buy it. Use the handle from search_products.',
        input_schema: { type: 'object', properties: { handle: { type: 'string' } }, required: ['handle'] },
    },
    {
        name: 'send_size_chart',
        description: 'Send the customer the size chart for one product (from its Shopify photos). Returns an error if the product has none.',
        input_schema: { type: 'object', properties: { handle: { type: 'string' } }, required: ['handle'] },
    },
    {
        name: 'get_my_orders',
        description: "The orders placed with this chat's WhatsApp number: items, sizes, payment, status, shipped date and tracking link.",
        input_schema: { type: 'object', properties: {} },
    },
    {
        name: 'lookup_order',
        description: 'Look up an order by its number. If it was placed with another phone number, call again with the email or the delivery pincode on the order.',
        input_schema: {
            type: 'object',
            properties: {
                order_number: { type: 'string', description: 'e.g. #12151' },
                email: { type: 'string', description: 'Only when asked for verification' },
                pincode: { type: 'string', description: 'Only when asked for verification' },
            },
            required: ['order_number'],
        },
    },
    {
        name: 'get_policy',
        description: "Read Normless's own published policy text before explaining it.",
        input_schema: { type: 'object', properties: { topic: { type: 'string', enum: ['refund_and_exchange', 'shipping', 'privacy', 'terms'] } }, required: ['topic'] },
    },
    {
        name: 'hand_over',
        description: 'Give the chat to a person on the Normless team. The customer is told who will help them. Write nothing else in the same reply.',
        input_schema: {
            type: 'object',
            properties: {
                reason: { type: 'string', description: 'Short, e.g. "Refund request", "Damaged product — photos and video received"' },
                summary: { type: 'string', description: 'What the customer wants and what you already know (order number, sizes, what they sent)' },
            },
            required: ['reason', 'summary'],
        },
    },
];

/* ── What it can do ────────────────────────────────────────────────────────────────────────── */

const POLICY = { refund_and_exchange: /refund/i, shipping: /shipping/i, privacy: /privacy/i, terms: /terms/i };

/** A short caption for a product, the way a shop assistant would send it. */
const caption = (p) => [
    `*${p.title}*`,
    p.price != null ? `₹${p.price}` : null,
    p.sold_out ? 'Sold out right now' : p.sizes_in_stock.length ? `Sizes in stock: ${p.sizes_in_stock.join(', ')}` : null,
    p.url,
].filter(Boolean).join('\n');

/**
 * Run one tool. `ctx.dry` is the Settings › Try it panel: nothing is sent and no chat is changed,
 * the reply just says what would have happened.
 */
async function runTool(name, input, ctx) {
    const { conversation, dry, sent } = ctx;
    if (name === 'search_products') return { products: await shop.searchProducts(input?.query) };

    if (name === 'send_product' || name === 'send_size_chart') {
        const p = await shop.productByHandle(input?.handle);
        if (!p) return { error: 'No product with that handle — search again.' };
        const shaped = shop.shapeProduct(p);
        const image = name === 'send_product' ? p.image : p.size_chart;
        if (!image) return { error: name === 'send_size_chart' ? 'This product has no size chart. Hand over so a person can share the measurements.' : 'This product has no photo.' };
        const text = name === 'send_product' ? caption(shaped) : `Size chart — ${shaped.title}`;
        sent.push({ kind: name === 'send_product' ? 'product' : 'size_chart', image, text });
        if (!dry) {
            const wamid = await wa.sendImageLink(conversation.phone, image, text);
            await db.query(
                `INSERT INTO wa_messages (conversation_id, wamid, direction, sender_type, type, body, media_url, media_mime, status)
                 VALUES ($1,$2,'out','bot','image',$3,$4,'image/jpeg','sent')`, [conversation.id, wamid, text, image]);
        }
        return { sent: true, product: shaped };
    }

    if (name === 'get_my_orders') {
        if (dry && !conversation.id) return { orders: [], note: 'Test chat — no real customer, so no orders.' };
        const data = await shop.customerFor(conversation);
        return {
            customer_first_name: data.customer?.first_name || null,
            orders: data.orders.slice(0, 5).map(o => ({
                order_number: o.order_number, ordered: o.created_at, state: o.state, payment: o.payment.label,
                total: o.total_price, items: o.items, shipped: o.shipped_at,
                courier: o.dispatch?.courier || null, tracking: o.dispatch?.tracking_url || null,
            })),
        };
    }

    if (name === 'lookup_order') {
        if (dry && !conversation.id) return { needs_verification: true, message: 'Test chat — ask for the email or pincode, as you would for a real customer.' };
        return shop.orderByNumber(conversation, input?.order_number, { email: input?.email, pincode: input?.pincode });
    }

    if (name === 'get_policy') {
        const re = POLICY[input?.topic];
        const p = re && (await shopify.fetchPolicies()).find(x => re.test(x.title));
        return p ? { title: p.title, text: p.text.slice(0, 7000) } : { error: 'No such policy is published.' };
    }

    return { error: 'No such tool' };
}

/* ── Checking what it wants to say ─────────────────────────────────────────────────────────── */

/** Every ₹ figure in the reply must appear somewhere it was allowed to read it. */
function inventedFigure(text, allowedText) {
    const known = new Set((String(allowedText).match(/\d[\d,]*(\.\d+)?/g) || []).map(n => Number(n.replace(/,/g, ''))));
    for (const raw of String(text).match(/₹\s?[\d,]+(\.\d+)?/g) || []) {
        const value = Number(raw.replace(/[₹,\s]/g, ''));
        if (Number.isFinite(value) && !known.has(value)) return value;
    }
    return null;
}

/* ── Answering ─────────────────────────────────────────────────────────────────────────────── */

/** The chat so far, as the model reads it. Media becomes a note of what arrived. */
async function history(conversationId) {
    const r = await db.query(
        `SELECT direction, sender_type, body, type, media_mime FROM wa_messages
          WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2`, [conversationId, HISTORY]);
    return r.rows.reverse().map(m => {
        const media = m.media_mime ? `[sent a ${m.media_mime.startsWith('video/') ? 'video' : m.media_mime.startsWith('image/') ? 'photo' : 'file'}] ` : '';
        const who = m.direction === 'out' && m.sender_type !== 'bot' && m.sender_type !== 'auto' ? '[Normless team member] ' : '';
        return { role: m.direction === 'in' ? 'user' : 'assistant', text: `${who}${media}${m.body || ''}`.trim() };
    });
}

/** Turn a history into the alternating turns the API wants, starting with the customer. */
function asMessages(turns) {
    const out = [];
    for (const t of turns) {
        if (!t.text) continue;
        const last = out[out.length - 1];
        if (last && last.role === t.role) last.content += `\n${t.text}`;
        else out.push({ role: t.role, content: t.text });
    }
    while (out.length && out[0].role !== 'user') out.shift();
    return out;
}

/**
 * The model's reply to a conversation, with its tools run. Returns what to do:
 * { text } to send, { handOver: { reason, summary } }, or { error }. Nothing is sent here.
 */
async function think({ settings, context, turns, conversation, dry }) {
    const messages = asMessages(turns);
    if (!messages.length || messages[messages.length - 1].role !== 'user') return { nothing: true };
    const ctx = { conversation, dry, sent: [] };
    let seen = `${JSON.stringify(settings.faqs)} 198 24`;

    for (let round = 0; round < MAX_TURNS; round++) {
        const response = await anthropic().beta.messages.create({
            model: MODEL,
            max_tokens: 16000,
            // A short chat reply doesn't need deep thinking; low effort keeps answers quick.
            output_config: { effort: 'low' },
            // If a reply is declined by a safety check, the API answers with a fallback model.
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            system: [
                { type: 'text', text: STABLE, cache_control: { type: 'ephemeral' } },
                { type: 'text', text: dynamic(settings, context) },
            ],
            tools: TOOLS,
            messages,
        });

        if (response.stop_reason === 'refusal') return { handOver: { reason: 'The bot could not answer this', summary: 'The message needs a person.' }, sent: ctx.sent };
        messages.push({ role: 'assistant', content: response.content });

        const calls = response.content.filter(b => b.type === 'tool_use');
        const handing = calls.find(c => c.name === 'hand_over');
        if (handing) return { handOver: { reason: handing.input?.reason || 'Needs a person', summary: handing.input?.summary || '' }, sent: ctx.sent };

        if (!calls.length || response.stop_reason === 'end_turn') {
            const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
            if (!text) return { nothing: true, sent: ctx.sent };
            const bad = inventedFigure(text, seen);
            if (bad != null) return { handOver: { reason: `The bot wasn't sure of a price (₹${bad})`, summary: `It wanted to say: "${text.slice(0, 300)}"` }, sent: ctx.sent };
            return { text, sent: ctx.sent };
        }

        const results = [];
        for (const call of calls) {
            let result;
            try { result = await runTool(call.name, call.input || {}, ctx); }
            catch (err) { result = { error: `That didn't work: ${err.message}` }; }
            const json = JSON.stringify(result);
            seen += ` ${json}`;
            results.push({ type: 'tool_result', tool_use_id: call.id, content: json, ...(result?.error ? { is_error: true } : {}) });
        }
        messages.push({ role: 'user', content: results });
    }
    return { handOver: { reason: 'The bot went round in circles', summary: 'It used its tools too many times without an answer.' }, sent: ctx.sent };
}

/** What the bot should know about this chat before it starts. */
async function contextFor(conversation) {
    const name = conversation.customer_name || conversation.profile_name;
    const parts = [name ? `the customer's name on WhatsApp is ${String(name).replace(/^~/, '')}` : 'the customer has no name on WhatsApp'];
    if (conversation.customer_id) parts.push('they are a Normless customer — use get_my_orders for their orders');
    else parts.push('no Shopify customer has this phone number; ask for an order number if they mention an order');
    return parts.join('; ') + '.';
}

/** Answer the latest messages on one chat, for real. */
async function answer(conversationId) {
    const line = lines.current();
    const conversation = (await db.query(
        `SELECT c.*, k.phone, k.profile_name, k.customer_id,
                NULLIF(TRIM(CONCAT(cu.first_name, ' ', cu.last_name)), '') AS customer_name
           FROM wa_conversations c JOIN wa_contacts k ON k.id = c.contact_id
           LEFT JOIN customers cu ON cu.id = k.customer_id
          WHERE c.id = $1 AND c.line_id = $2`, [conversationId, line.id])).rows[0];
    if (!conversation || conversation.mode !== 'ai' || conversation.status !== 'open') return;
    if (!wa.windowOpen(conversation.last_inbound_at)) return;

    const settings = await readSettings(line.id);
    let outcome;
    try {
        outcome = await think({
            settings, context: await contextFor(conversation), turns: await history(conversation.id), conversation, dry: false,
        });
    } catch (err) {
        console.error('normless bot failed:', err.message);
        outcome = { handOver: { reason: 'The bot ran into a problem', summary: `It couldn't answer (${String(err.message).slice(0, 120)}).` } };
    }

    // A person may have taken the chat while it was thinking: then it says nothing.
    const now = (await db.query('SELECT mode FROM wa_conversations WHERE id = $1', [conversation.id])).rows[0];
    if (now?.mode !== 'ai') return;

    if (outcome.handOver) {
        await db.query('UPDATE wa_conversations SET nl_handoff_at = CURRENT_TIMESTAMP WHERE id = $1', [conversation.id]);
        await handover.handOver(conversation, outcome.handOver);
        return;
    }
    if (outcome.text) {
        const wamid = await wa.sendText(conversation.phone, outcome.text);
        await handover.record(conversation.id, wamid, outcome.text, 'bot');
    }
}

/* ── When to answer ────────────────────────────────────────────────────────────────────────── */

const timers = new Map();     // conversation id -> pending answer
const running = new Map();    // conversation id -> answer in progress

function schedule(conversationId) {
    clearTimeout(timers.get(conversationId));
    const line = lines.current();
    timers.set(conversationId, setTimeout(() => {
        timers.delete(conversationId);
        lines.run(line, async () => {
            if (running.has(conversationId)) { schedule(conversationId); return; }
            const job = answer(conversationId).catch(err => console.error('normless bot error:', err.message))
                .finally(() => running.delete(conversationId));
            running.set(conversationId, job);
        });
    }, SETTLE_MS));
}

/**
 * Who answers Normless chats right now: the AI bot when it is switched on and has a key, else the
 * menu (nl-flow) when that is on, else nobody — every chat waits for a person.
 */
async function engine(lineId) {
    const settings = await readSettings(lineId);
    if (process.env.ANTHROPIC_API_KEY && settings.bot.enabled) return 'ai';
    if (settings.menu.enabled !== false) return 'flow';
    return null;
}

// One menu step at a time per chat: two quick taps must not be answered side by side.
const flowChains = new Map();
function inTurnFor(conversationId, job) {
    const run = (flowChains.get(conversationId) || Promise.resolve()).then(job);
    const tail = run.catch(err => console.error('normless menu error:', err.message));
    flowChains.set(conversationId, tail);
    tail.then(() => { if (flowChains.get(conversationId) === tail) flowChains.delete(conversationId); });
    return run;
}

/**
 * A customer message arrived on Normless's line. The bot or the menu takes the chat unless a
 * person has it: a chat nobody is assigned to is theirs, except for a day after one was handed
 * over and nobody has picked it up yet — then it stays with the team rather than being answered
 * again by a machine.
 */
async function onInbound(conversation) {
    if (conversation.phone === handover.DEMO_PHONE) return;
    const line = lines.current();
    const who = await engine(line.id);
    if (!who) return;
    const c = (await db.query(
        `SELECT mode, assigned_to, status, nl_handoff_at FROM wa_conversations WHERE id = $1`, [conversation.id])).rows[0];
    if (!c || c.status !== 'open') return;
    if (c.mode === 'human') {
        const recentHandoff = c.nl_handoff_at && Date.now() - new Date(c.nl_handoff_at).getTime() < 24 * 3600 * 1000;
        if (c.assigned_to || recentHandoff) return;
    }
    // The chat moves to whichever machine is answering now — the menu until there's a key.
    if (c.mode !== who) {
        await db.query(
            `UPDATE wa_conversations SET mode = $2, flow_step = CASE WHEN $2 = 'flow' THEN NULL ELSE flow_step END,
                    flow_data = CASE WHEN $2 = 'flow' THEN '{}' ELSE flow_data END, updated_at = CURRENT_TIMESTAMP
              WHERE id = $1`, [conversation.id, who]);
    }
    if (who === 'ai') return schedule(conversation.id);
    return inTurnFor(conversation.id, () => lines.run(line, () => require('./nl-flow').handle(conversation.id)));
}

/** Settings › Try it: a pretend conversation, answered without sending anything. */
async function tryIt(lineId, turns) {
    if (!process.env.ANTHROPIC_API_KEY) return { error: 'No Anthropic API key is set on the server, so the bot cannot answer yet.' };
    const settings = await readSettings(lineId);
    const outcome = await think({
        settings, context: 'this is a test from the Settings page; there is no real customer.',
        turns: turns.map(t => ({ role: t.role === 'customer' ? 'user' : 'assistant', text: String(t.text || '') })),
        conversation: { id: null, phone: null }, dry: true,
    });
    return {
        reply: outcome.text || null,
        handOver: outcome.handOver || null,
        sent: outcome.sent || [],
    };
}

module.exports = { onInbound, tryIt, enabled, engine, inventedFigure, asMessages, MODEL };
