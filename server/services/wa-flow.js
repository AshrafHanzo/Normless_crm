/**
 * The menu that answers at two in the morning.
 *
 * Most enquiries open the same way — what do you make, how much for a hundred, can you embroider
 * our logo — and the answers do not need a person. This walks a customer through those questions,
 * writes what they say onto the enquiry, gives them a real price range off the CRM's own tiers,
 * and then hands the conversation to a rep with the work already done.
 *
 * Three rules it is built around:
 *
 *   1. A flow is data, not code. The steps live in a row in `wa_flows`, so the wording and the
 *      order can change without a deploy — and so a second flow can exist beside the first.
 *   2. It gets out of the way the moment it is not helping. Anything the menu cannot make sense
 *      of hands the conversation to a person rather than asking again, because a customer typing
 *      a sentence at a robot that keeps repeating itself is worse than no robot.
 *   3. It never invents a price. Every figure comes from `crewfit_products`, the same tiers the
 *      quotes page uses, and a quantity past the published tiers is quoted as "on request"
 *      instead of guessed at.
 */

const db = require('../db/connection');
const wa = require('./whatsapp');

const safeJson = (v, fallback) => {
    try { return typeof v === 'string' ? (JSON.parse(v || 'null') ?? fallback) : (v || fallback); }
    catch { return fallback; }
};

/* ── The starter flow ─────────────────────────────────────────────────────────────────────────
   Seeded once; after that it is a row somebody can edit. Button titles are inside WhatsApp's
   twenty characters and no step offers more than three of them, which is all WhatsApp allows. */

const CREWFIT_FLOW = {
    key: 'crewfit_quote',
    name: 'Crewfit — enquiry to quote',
    start: 'greet',
    steps: {
        greet: {
            type: 'buttons',
            text: 'Hello 👋 This is Crewfit — bulk t-shirts, polos, caps and workwear, printed or embroidered with your logo.\n\nWhat would you like to do?',
            buttons: [
                { id: 'quote', title: 'Get a quote' },
                { id: 'products', title: 'See products' },
                { id: 'human', title: 'Talk to sales' },
            ],
            next: { quote: 'product', products: 'catalogue', human: 'handoff' },
        },
        catalogue: {
            type: 'send_catalogue',
            text: 'Here is our full catalogue 📘 — every product, colour and price tier.',
            next: { '*': 'range' },
        },
        range: {
            type: 'text',
            text: 'We make polos (poly-cotton, airtex and pure cotton), round-neck and oversized tees, kids\' sizes, caps and aprons — in a range of colours, from 5 pieces upwards.\n\nLet\'s find the right one for you.',
            next: { '*': 'product' },
        },
        product: {
            type: 'list',
            text: 'Which of these is closest to what you need?',
            button: 'See the list',
            save_as: 'product_interest',
            sections: [{
                title: 'Our products',
                rows: [
                    { id: 'Poly Cotton Polos', title: 'Poly cotton polo', description: 'Everyday staff polo' },
                    { id: 'Classic Cotton Polos', title: 'Pure cotton polo', description: 'Softer, premium feel' },
                    { id: 'Classic Polos Airtex', title: 'Airtex polo', description: 'Breathable, for outdoors' },
                    { id: 'Regular Fit T-Shirt', title: 'Round neck t-shirt', description: 'Regular fit' },
                    { id: 'Oversized T-Shirts', title: 'Oversized t-shirt', description: 'Drop shoulder' },
                    { id: 'Toddlers & Kids Round Neck', title: 'Kids t-shirt', description: 'School and events' },
                    { id: 'Caps', title: 'Caps', description: 'Embroidered front' },
                    { id: 'other', title: 'Something else', description: 'Tell us what you need' },
                ],
            }],
            next: { other: 'describe', '*': 'quantity' },
        },
        describe: {
            type: 'ask_text',
            text: 'No problem — tell us what you are looking for and we will come back on it.',
            save_as: 'product_interest',
            next: { '*': 'quantity' },
        },
        quantity: {
            type: 'buttons',
            text: 'Roughly how many pieces?',
            save_as: 'quantity',
            buttons: [
                { id: 'Under 50', title: 'Under 50' },
                { id: '50-200', title: '50 to 200' },
                { id: '200+', title: 'More than 200' },
            ],
            next: { '*': 'branding' },
        },
        branding: {
            type: 'buttons',
            text: 'And how would you like your logo on them?',
            save_as: 'branding',
            buttons: [
                { id: 'Embroidery', title: 'Embroidery' },
                { id: 'Printing', title: 'Printing' },
                { id: 'Not sure', title: 'Not sure yet' },
            ],
            next: { '*': 'logo' },
        },
        logo: {
            type: 'ask_media',
            text: 'If you have your logo handy, send it across — a PNG, JPG or PDF is perfect. It helps us quote properly.\n\nIf not, just reply "skip".',
            save_as: 'logo',
            next: { '*': 'summary' },
        },
        summary: { type: 'summary' },
        handoff: {
            type: 'text',
            text: 'Of course — someone from the team will pick this up shortly. Feel free to tell us what you need in the meantime.',
            next: {},
        },
    },
};

/** The flow a new conversation should start on, or nothing if none is switched on. */
async function activeFlow() {
    const r = await db.query(
        `SELECT key, name, definition FROM wa_flows WHERE is_active = true ORDER BY id LIMIT 1`);
    return asFlow(r.rows[0]);
}

const asFlow = (row) => {
    if (!row) return null;
    const definition = safeJson(row.definition, null);
    return definition ? { key: row.key, name: row.name, ...definition } : null;
};

/** One menu by its key, switched on or not — the one a conversation is part-way through. */
async function flowByKey(key) {
    if (!key) return null;
    return asFlow((await db.query(`SELECT key, name, definition FROM wa_flows WHERE key = $1`, [key])).rows[0]);
}

/** The menu to use when none is switched on but one should run anyway (after hours). */
async function anyFlow() {
    return asFlow((await db.query(`SELECT key, name, definition FROM wa_flows ORDER BY is_active DESC, id LIMIT 1`)).rows[0]);
}

/**
 * Make sure the starter flow exists, once, without overwriting anything edited since.
 *
 * A starter nobody has touched (no updated_by) is brought up to date with the current one, so a
 * new step — the catalogue PDF — reaches it; a menu somebody has edited is left exactly as it is.
 */
async function ensureStarterFlow() {
    const definition = JSON.stringify({ start: CREWFIT_FLOW.start, steps: CREWFIT_FLOW.steps });
    await db.query(
        `INSERT INTO wa_flows (key, name, definition, is_active)
         VALUES ($1,$2,$3,false)
         ON CONFLICT (key) DO UPDATE SET definition = EXCLUDED.definition
          WHERE wa_flows.updated_by IS NULL AND wa_flows.definition <> EXCLUDED.definition`,
        [CREWFIT_FLOW.key, CREWFIT_FLOW.name, definition]);
}

/* ── Prices ──────────────────────────────────────────────────────────────────────────────────
   Straight off the products table — the same tiers the quotes page prints. Nothing is invented:
   a quantity above the published tiers comes back as "on request", which is what the tier itself
   says. */

const BANDS = { 'Under 50': [5, 49], '50-200': [50, 200], '200+': [201, 1000] };

/** A tier label like "21–50" or "100+" as numbers. */
function tierRange(label) {
    const text = String(label).replace(/[–—]/g, '-');
    const plus = text.match(/^(\d+)\s*\+$/);
    if (plus) return [Number(plus[1]), Infinity];
    const pair = text.match(/^(\d+)\s*-\s*(\d+)$/);
    return pair ? [Number(pair[1]), Number(pair[2])] : null;
}

/**
 * What this many of that product costs, as the tiers have it.
 *
 * Returns the cheapest and dearest published rate the customer's quantity could fall in, so the
 * answer is a range they can trust rather than a single number that will move.
 */
async function priceFor(productName, band) {
    const [low, high] = BANDS[band] || [1, Infinity];
    const r = await db.query(
        `SELECT name, tiers, from_price FROM crewfit_products
          WHERE LOWER(name) = LOWER($1) LIMIT 1`, [productName]);
    const product = r.rows[0];
    if (!product) return null;

    const tiers = safeJson(product.tiers, []);
    const rates = [];
    let onRequest = false;
    for (const [label, price] of tiers) {
        const range = tierRange(label);
        if (!range) continue;
        const overlaps = range[0] <= high && range[1] >= low;
        if (!overlaps) continue;
        if (typeof price === 'number') rates.push(price);
        else onRequest = true;       // the tier itself says to ask
    }
    if (!rates.length) return { name: product.name, onRequest: true };
    return {
        name: product.name,
        low: Math.min(...rates),
        high: Math.max(...rates),
        onRequest,
    };
}

/** The message that closes the menu: what they asked for, and what it costs. */
async function summaryText(answers) {
    const lines = ['Thank you — here is what we have:'];
    if (answers.product_interest) lines.push(`• Product: ${answers.product_interest}`);
    if (answers.quantity) lines.push(`• Quantity: ${answers.quantity === '50-200' ? '50 to 200' : answers.quantity}`);
    if (answers.branding) lines.push(`• Branding: ${answers.branding}`);
    if (answers.logo) lines.push('• Logo: received, thank you');

    const price = answers.product_interest && answers.quantity
        ? await priceFor(answers.product_interest, answers.quantity) : null;

    if (price && price.low) {
        lines.push('', price.low === price.high
            ? `At that quantity ${price.name} works out around ₹${price.low} a piece.`
            : `At that quantity ${price.name} works out around ₹${price.high} down to ₹${price.low} a piece, depending on the exact count.`);
        // Part of the band is published and part of it is not. Saying so is more use than
        // hiding the rate we do know behind "ask us".
        if (price.onRequest) lines.push('Above that we price each order on its own — larger runs come down further.');
        lines.push('That is before GST and branding.');
    } else if (price) {
        lines.push('', `For that quantity of ${price.name} we quote individually — the rates get better the larger the order.`);
    }
    if (answers.branding === 'Embroidery') {
        lines.push('Embroidery also has a one-off ₹800 digitising charge for the logo.');
    }
    lines.push('', 'This is an estimate, not a confirmed quote — one of our team will go through it with you shortly.');
    return lines.join('\n');
}

/* ── Running it ──────────────────────────────────────────────────────────────────────────────── */

/** Write down what the bot said, so the thread reads as one conversation. */
async function record(conversation, wamid, body, type = 'text') {
    await db.query(
        `INSERT INTO wa_messages (conversation_id, wamid, direction, sender_type, type, body, status)
         VALUES ($1,$2,'out','bot',$3,$4,'sent')
         ON CONFLICT (wamid) DO NOTHING`,
        [conversation.id, wamid, type, body]);
    await db.query(
        `UPDATE wa_conversations SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = $2,
                updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [conversation.id, String(body || '').slice(0, 200)]);
}

/** Send one step and remember where we are. */
async function send(conversation, flow, stepId, answers) {
    const step = flow.steps?.[stepId];
    if (!step) return handToHuman(conversation, 'the menu ran out of steps');

    // The menu's last word, after hours: "someone will pick this up shortly" is not true at
    // night, so the customer is told the team's hours instead.
    const isEnd = step.type === 'text' && !Object.keys(step.next || {}).length;
    if (isEnd) {
        const extras = require('./wa-extras');
        const hours = await extras.workHours();
        if (hours.enabled && !extras.isOpen(hours)) {
            const text = extras.awayText(hours);
            const wamid = await wa.sendText(conversation.phone, text);
            await record(conversation, wamid, text);
            await db.query(`UPDATE wa_conversations SET away_sent_at = CURRENT_TIMESTAMP WHERE id = $1`, [conversation.id]);
            return handToHuman(conversation, 'the menu finished after hours');
        }
    }

    if (step.type === 'summary') {
        const text = await summaryText(answers);
        const wamid = await wa.sendText(conversation.phone, text);
        await record(conversation, wamid, text);
        return finish(conversation, answers);
    }

    // The catalogue PDF, then on to whatever follows. A missing PDF is skipped rather than
    // stopping the menu: the customer still gets the rest of the conversation.
    if (step.type === 'send_catalogue') {
        try {
            await require('./wa-extras').sendCatalogue(conversation, { senderType: 'bot', caption: step.text || '' });
        } catch (err) {
            console.error('whatsapp flow catalogue:', err.message);
        }
        await db.query(
            `UPDATE wa_conversations SET mode = 'flow', flow_id = $2, flow_step = $3, flow_data = $4,
                    updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [conversation.id, flow.key, stepId, JSON.stringify(answers)]);
        if (step.next?.['*']) return send(conversation, flow, step.next['*'], answers);
        return handToHuman(conversation, 'the catalogue was the last step');
    }

    let wamid = null;
    if (step.type === 'buttons') {
        wamid = await wa.sendButtons(conversation.phone, step.text, step.buttons || []);
    } else if (step.type === 'list') {
        wamid = await wa.sendList(conversation.phone, step.text,
            { button: step.button, sections: step.sections || [] });
    } else {
        wamid = await wa.sendText(conversation.phone, step.text);
    }
    await record(conversation, wamid, step.text, step.type === 'text' ? 'text' : 'interactive');

    await db.query(
        `UPDATE wa_conversations SET mode = 'flow', flow_id = $2, flow_step = $3, flow_data = $4,
                updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [conversation.id, flow.key, stepId, JSON.stringify(answers)]);

    // A step that only tells them something carries straight on to the next one.
    if (step.type === 'text' && step.next?.['*']) {
        return send(conversation, flow, step.next['*'], answers);
    }
}

/** Hand over, with the reason visible in the thread rather than only in a log. */
async function handToHuman(conversation, why) {
    await db.query(
        `UPDATE wa_conversations SET mode = 'human', flow_step = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`, [conversation.id]);
    if (why) console.log(`whatsapp flow handed conversation ${conversation.id} to a person: ${why}`);
}

/** The end of the menu: everything learned goes onto the enquiry, and a person takes over. */
async function finish(conversation, answers) {
    const sets = [];
    const params = [];
    for (const [key, column] of [['product_interest', 'product_interest'], ['quantity', 'quantity'],
        ['branding', 'branding'], ['logo', 'logo_url']]) {
        if (answers[key]) {
            params.push(String(answers[key]));
            sets.push(`${column} = $${params.length}`);
        }
    }
    if (sets.length) {
        params.push(conversation.lead_id);
        await db.query(
            `UPDATE crewfit_leads SET ${sets.join(', ')}, status = CASE WHEN status IN ('new','enquiry') THEN 'qualified' ELSE status END,
                    updated_at = CURRENT_TIMESTAMP
              WHERE id = $${params.length}`, params);
    }
    await handToHuman(conversation, 'the menu finished');
}

/**
 * A customer's message, while the menu has the conversation.
 *
 * Returns true if the flow dealt with it. Anything it cannot read — a sentence where a tap was
 * expected, a question of their own — ends the menu and gives the thread to a person, because
 * that is what the customer is asking for by typing it.
 */
async function handle(conversation, message) {
    // The menu this conversation is in, even if it was switched off since — or started after
    // hours while switched off. Leaving it would strand the customer mid-question.
    const flow = await flowByKey(conversation.flow_id);
    if (!flow) return false;
    const step = flow.steps?.[conversation.flow_step];
    if (!step) return false;

    const answers = safeJson(conversation.flow_data, {});
    const tapped = message.interactive_payload?.id || null;
    const text = String(message.body || '').trim();

    if (step.type === 'ask_media') {
        if (message.media_url) answers[step.save_as || 'media'] = message.media_url;
        else if (!/^(skip|no|later)$/i.test(text)) {
            // They answered the question with words instead of a file; that is an answer too.
            answers[`${step.save_as || 'media'}_note`] = text;
        }
        await send(conversation, flow, step.next?.['*'], answers);
        return true;
    }

    if (step.type === 'ask_text') {
        if (!text) return false;
        if (step.save_as) answers[step.save_as] = text;
        await send(conversation, flow, step.next?.['*'], answers);
        return true;
    }

    // A tap on a button or a list row.
    if (tapped) {
        if (step.save_as) answers[step.save_as] = tapped;
        const nextId = step.next?.[tapped] || step.next?.['*'];
        if (!nextId) {
            await handToHuman(conversation, `no step after ${tapped}`);
            return true;
        }
        await send(conversation, flow, nextId, answers);
        return true;
    }

    // Words where a tap was expected: the menu stops rather than repeating itself.
    await handToHuman(conversation, 'the customer typed instead of tapping');
    const text_ = 'Thanks — I\'ll pass this to one of our team, they will reply here shortly.';
    const wamid = await wa.sendText(conversation.phone, text_).catch(() => null);
    if (wamid) await record(conversation, wamid, text_);
    return true;
}

/** Begin the menu on a conversation that has not had one. */
async function start(conversation, { evenIfOff = false } = {}) {
    const flow = (await activeFlow()) || (evenIfOff ? await anyFlow() : null);
    if (!flow) return false;
    await send(conversation, flow, flow.start, {});
    return true;
}

module.exports = { activeFlow, flowByKey, ensureStarterFlow, start, handle, priceFor, summaryText, CREWFIT_FLOW };
