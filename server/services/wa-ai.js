/**
 * The agent that answers when the menu cannot.
 *
 * A menu handles the enquiry that arrives in the shape the menu expects. Most do not: people ask
 * whether the cotton is combed, whether you can match a Pantone, whether 80 pieces in two colours
 * counts as 80 or as two orders of 40. This answers those, from the CRM's own catalogue, and
 * stops the moment it is out of its depth.
 *
 * What keeps it honest is not the prompt, it is what it is able to do. It has four tools and no
 * others: look up products, look up a price, write something onto the enquiry, and hand over. It
 * cannot confirm an order, discount anything or promise a date, because nothing here can do those
 * things. And every rupee it says is checked against what the price tool actually returned before
 * the message is allowed out — a figure the model made up is a conversation handed to a person,
 * not a message sent.
 */

const db = require('../db/connection');
const wa = require('./whatsapp');
const flow = require('./wa-flow');

const MODEL = process.env.WA_AI_MODEL || 'claude-sonnet-5-5';
const API = 'https://api.anthropic.com/v1/messages';
const MAX_TURNS = 4;             // tool calls before we stop and let a person take it
const HISTORY = 16;              // messages of context: enough to follow, cheap to send
const DIGITISING_CHARGE = 800;   // a real, fixed Crewfit charge the agent may quote

const safeJson = (v, fallback) => {
    try { return typeof v === 'string' ? (JSON.parse(v || 'null') ?? fallback) : (v || fallback); }
    catch { return fallback; }
};

/** Is there a key, and has anybody switched it on? */
async function enabled() {
    if (!process.env.ANTHROPIC_API_KEY) return false;
    const r = await db.query(`SELECT value FROM wa_settings WHERE key = 'ai_enabled'`);
    return r.rows[0]?.value === 'true';
}

const SYSTEM = `You answer WhatsApp enquiries for Crewfit, an Indian manufacturer of bulk garments:
polo shirts, round-neck and oversized t-shirts, kids' sizes, caps and aprons, branded with a
customer's logo by embroidery or printing. You are talking to a business customer on WhatsApp.

How to write:
- Short. Two or three sentences, as a person types on a phone. No bullet lists unless you are
  listing products, no markdown, no headings.
- Warm and direct. British-Indian business English. Rupees as ₹.
- One question at a time. You are gathering: what product, how many, what branding, by when.

What you may say:
- Only what the tools tell you. Use get_products before describing what is available, and
  get_price before saying what anything costs. Never state a price the price tool did not return.
- Embroidery carries a one-off ₹${DIGITISING_CHARGE} digitising charge for the logo. This is the
  only figure you may give without a tool.
- Prices are before GST unless the tool says otherwise, and they are estimates until a colleague
  confirms them.

What you must never do:
- Confirm an order, take payment, or say an order is placed.
- Offer a discount, a special rate, or match a competitor.
- Promise a delivery date, a dispatch date or a lead time. If asked, say a colleague will confirm
  it, and hand over.
- Invent stock, fabric weights, certifications or colours that get_products did not list.

Hand over with handoff_to_human, immediately and without arguing, when: the customer asks for a
call or a person; they are unhappy or repeating themselves; they want to place or change an order;
they ask about an existing order, payment or delivery; the quantity is above 500; or you simply do
not know. Handing over early is always the right call — say that a colleague will pick it up.

Use save_lead_details whenever you learn the company name, what they want, how many, or how they
want it branded, so the team has it written down.`;

const TOOLS = [
    {
        name: 'get_products',
        description: 'The Crewfit catalogue: every product, what it is made of, its colours and its starting price. Call this before describing what Crewfit makes.',
        input_schema: { type: 'object', properties: {} },
    },
    {
        name: 'get_price',
        description: 'What a product costs at a given quantity, from the published price tiers. The only source of a price you may quote.',
        input_schema: {
            type: 'object',
            properties: {
                product: { type: 'string', description: 'The product name exactly as get_products gives it' },
                quantity: { type: 'integer', description: 'How many pieces the customer wants' },
            },
            required: ['product', 'quantity'],
        },
    },
    {
        name: 'save_lead_details',
        description: 'Write what you have learned onto the enquiry so the team has it.',
        input_schema: {
            type: 'object',
            properties: {
                name: { type: 'string' },
                company: { type: 'string' },
                email: { type: 'string' },
                product_interest: { type: 'string' },
                quantity: { type: 'string' },
                branding: { type: 'string', description: 'Embroidery, Printing, or Not sure' },
                notes: { type: 'string', description: 'Anything else worth knowing, in one line' },
            },
        },
    },
    {
        name: 'handoff_to_human',
        description: 'Give the conversation to a colleague. Use it whenever you are unsure, asked for a person, or asked for anything you are not allowed to decide.',
        input_schema: {
            type: 'object',
            properties: { reason: { type: 'string', description: 'Why, in a few words, for the team to see' } },
            required: ['reason'],
        },
    },
];

/* ── The tools themselves ────────────────────────────────────────────────────────────────────── */

/** Every price this turn was allowed to mention, collected as the tools answer. */
function allowedFigures() {
    return new Set([DIGITISING_CHARGE]);
}

async function runTool(name, input, conversation, allowed) {
    if (name === 'get_products') {
        const r = await db.query(
            `SELECT name, category, material, gsm, from_price, colors FROM crewfit_products
              ORDER BY sort_order, name`);
        return r.rows.map(p => ({
            name: p.name, category: p.category, material: p.material, gsm: p.gsm,
            from_price: Number(p.from_price), colours: safeJson(p.colors, []),
        }));
    }

    if (name === 'get_price') {
        const quantity = Number(input?.quantity) || 0;
        const band = quantity <= 49 ? 'Under 50' : quantity <= 200 ? '50-200' : '200+';
        const price = await flow.priceFor(String(input?.product || ''), band);
        if (!price) return { error: 'No such product. Call get_products for the list.' };
        // Anything the model is now allowed to repeat.
        if (price.low) { allowed.add(price.low); allowed.add(price.high); }
        return price.low
            ? {
                product: price.name, quantity,
                price_per_piece_low: price.low, price_per_piece_high: price.high,
                note: price.onRequest
                    ? 'Above the published tiers Crewfit prices each order individually.'
                    : 'Before GST and branding. An estimate until a colleague confirms it.',
            }
            : { product: price.name, quantity, on_request: true, note: 'Quoted individually at this quantity — do not guess a figure.' };
    }

    if (name === 'save_lead_details') {
        const columns = ['name', 'company', 'email', 'product_interest', 'quantity', 'branding', 'notes'];
        const sets = [];
        const params = [];
        for (const key of columns) {
            if (input?.[key]) {
                params.push(String(input[key]).slice(0, 500));
                sets.push(`${key} = $${params.length}`);
            }
        }
        if (!sets.length) return { saved: false };
        params.push(conversation.lead_id);
        await db.query(
            `UPDATE crewfit_leads SET ${sets.join(', ')},
                    status = CASE WHEN status = 'new' THEN 'working' ELSE status END,
                    updated_at = CURRENT_TIMESTAMP
              WHERE id = $${params.length}`, params);
        return { saved: true };
    }

    if (name === 'handoff_to_human') {
        await handoff(conversation, input?.reason || 'the agent asked for help');
        return { handed_over: true };
    }

    return { error: 'No such tool' };
}

/** Give the thread to a person, and leave the reason where the team will see it. */
async function handoff(conversation, reason) {
    await db.query(
        `UPDATE wa_conversations SET mode = 'human', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [conversation.id]);
    await db.query(
        `INSERT INTO wa_notes (conversation_id, author, body) VALUES ($1,'assistant',$2)`,
        [conversation.id, `Handed over: ${String(reason).slice(0, 300)}`]);
}

/* ── Checking what it wants to say ───────────────────────────────────────────────────────────── */

/**
 * Every figure in the reply has to be one a tool gave it.
 *
 * The prompt tells it not to invent prices; this is what makes that true. Quantities the customer
 * themselves mentioned are fine — it is money that matters — so only figures written as rupees
 * are checked.
 */
function inventedFigure(text, allowed) {
    const found = String(text).match(/₹\s?[\d,]+/g) || [];
    for (const raw of found) {
        const value = Number(raw.replace(/[₹,\s]/g, ''));
        if (!Number.isFinite(value)) continue;
        if (!allowed.has(value)) return value;
    }
    return null;
}

/* ── Answering ───────────────────────────────────────────────────────────────────────────────── */

/** The conversation so far, in the shape the model expects. */
async function recentHistory(conversationId) {
    const r = await db.query(
        `SELECT direction, sender_type, body FROM wa_messages
          WHERE conversation_id = $1 AND COALESCE(body,'') <> ''
          ORDER BY id DESC LIMIT $2`, [conversationId, HISTORY]);
    return r.rows.reverse().map(m => ({
        role: m.direction === 'in' ? 'user' : 'assistant',
        content: m.body,
    }));
}

async function ask(messages) {
    const res = await fetch(API, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model: MODEL, max_tokens: 700, system: SYSTEM, tools: TOOLS, messages }),
        signal: AbortSignal.timeout(45000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        // The key itself is never in here; Anthropic's message is.
        throw new Error(data?.error?.message || `The assistant is unavailable (${res.status})`);
    }
    return data;
}

/**
 * Answer one customer message.
 *
 * Returns true if something was said. Any failure at all — the API down, a figure that was not
 * from a tool, too many tool calls — ends with a person owning the conversation, because the one
 * outcome that must never happen is a customer left on read.
 */
async function reply(conversation) {
    if (!await enabled()) return false;

    const allowed = allowedFigures();
    let messages = await recentHistory(conversation.id);
    if (!messages.length) return false;

    try {
        for (let turn = 0; turn < MAX_TURNS; turn++) {
            const answer = await ask(messages);
            const toolCalls = (answer.content || []).filter(c => c.type === 'tool_use');
            const text = (answer.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();

            if (toolCalls.length) {
                messages = messages.concat([{ role: 'assistant', content: answer.content }]);
                const results = [];
                let handedOver = false;
                for (const call of toolCalls) {
                    const out = await runTool(call.name, call.input, conversation, allowed);
                    if (call.name === 'handoff_to_human') handedOver = true;
                    results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(out) });
                }
                messages = messages.concat([{ role: 'user', content: results }]);
                if (handedOver && !text) {
                    const closing = 'Let me put you on to a colleague — they will come back to you here shortly.';
                    await send(conversation, closing);
                    return true;
                }
                continue;
            }

            if (!text) break;

            const made_up = inventedFigure(text, allowed);
            if (made_up !== null) {
                console.warn(`whatsapp ai quoted ₹${made_up} with no price lookup — handing over instead`);
                await handoff(conversation, `tried to quote ₹${made_up} without looking it up`);
                await send(conversation, 'Let me check that properly — a colleague will confirm the figure with you shortly.');
                return true;
            }

            await send(conversation, text);
            return true;
        }
        // Went round the loop without settling on anything to say.
        await handoff(conversation, 'the assistant could not reach an answer');
        return false;
    } catch (err) {
        console.error('whatsapp ai error:', err.message);
        await handoff(conversation, `the assistant failed: ${err.message}`);
        return false;
    }
}

/** Say it, and write it down as the assistant's — never as a person's. */
async function send(conversation, text) {
    const wamid = await wa.sendText(conversation.phone, text);
    await db.query(
        `INSERT INTO wa_messages (conversation_id, wamid, direction, sender_type, type, body, status)
         VALUES ($1,$2,'out','ai','text',$3,'sent') ON CONFLICT (wamid) DO NOTHING`,
        [conversation.id, wamid, text]);
    await db.query(
        `UPDATE wa_conversations SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = $2,
                updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [conversation.id, text.slice(0, 200)]);
}

module.exports = { enabled, reply, handoff, inventedFigure, SYSTEM, TOOLS, MODEL };
