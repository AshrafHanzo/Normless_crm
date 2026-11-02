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
                { id: 'info', title: 'Catalogue & sizes' },
                { id: 'human', title: 'Talk to sales' },
            ],
            next: { quote: 'product', info: 'info', human: 'handoff' },
        },
        // Everything a customer may want to look at before asking for a price.
        info: {
            type: 'list',
            text: 'What would you like to see?',
            button: 'Choose',
            sections: [{
                title: 'Crewfit',
                rows: [
                    { id: 'catalogue', title: 'Catalogue (PDF)', description: 'Every product, colour and price' },
                    { id: 'sizes', title: 'Size chart', description: 'Sizes, colours and prices of one product' },
                    { id: 'samples', title: 'Photos of our work', description: 'Real orders we have made, in different colours' },
                    { id: 'prices', title: 'Price list', description: 'Price per piece, printing included' },
                ],
            }],
            next: { catalogue: 'catalogue', sizes: 'size_product', samples: 'sample_product', prices: 'prices' },
        },
        catalogue: { type: 'send_catalogue', text: 'Here is our full catalogue 📘 — every product, colour and price tier.', next: { '*': 'after_info' } },
        size_product: { type: 'catalogue_pick', text: 'Which product would you like the size chart for?', card: false, next: { '*': 'size_chart' } },
        size_chart: { type: 'send_size_chart', next: { '*': 'after_info' } },
        sample_product: { type: 'catalogue_pick', text: 'Which product would you like to see?', card: false, next: { '*': 'samples' } },
        samples: { type: 'send_samples', next: { '*': 'after_info' } },
        prices: { type: 'send_prices', next: { '*': 'after_info' } },
        after_info: {
            type: 'buttons',
            text: 'Anything else?',
            buttons: [
                { id: 'quote', title: 'Get a quote' },
                { id: 'info', title: 'See something else' },
                { id: 'human', title: 'Talk to sales' },
            ],
            next: { quote: 'product', info: 'info', human: 'handoff' },
        },
        // The quote: product (with its photo, sizes and prices), colour, how many, and again for
        // another product; then branding, the logo, and a summary with prices.
        product: { type: 'catalogue_pick', text: 'Which product do you need?', card: true, save_as: 'product_interest', next: { other: 'describe', '*': 'color' } },
        describe: {
            type: 'ask_text',
            text: 'No problem — tell us what you are looking for and we will come back on it.',
            save_as: 'product_interest',
            next: { '*': 'quantity' },
        },
        color: { type: 'color_pick', text: 'Which colour would you like for the {product}?', save_as: 'color', next: { '*': 'quantity' } },
        quantity: { type: 'ask_number', text: 'How many pieces of {product}{ in color}? Just type the number, for example 50.', save_as: 'quantity', next: { '*': 'sizes' } },
        // The split by size for those pieces, kept on that product of the enquiry.
        sizes: {
            type: 'ask_sizes',
            text: 'What sizes do you need for the {quantity} pieces? Type the split like this:\n\nM-10, L-20, XL-20\n\nNot sure yet? Just reply "skip".',
            next: { '*': 'more' },
        },
        more: {
            type: 'buttons',
            text: 'Got it. Do you need another product as well?',
            buttons: [
                { id: 'more', title: 'Add another product' },
                { id: 'done', title: 'That’s all' },
            ],
            next: { more: 'product', '*': 'branding' },
        },
        branding: {
            type: 'buttons',
            text: 'And how would you like your logo on them?',
            save_as: 'branding',
            buttons: [
                { id: 'Printing', title: 'Printing' },
                { id: 'Embroidery', title: 'Embroidery' },
                { id: 'Not sure', title: 'Not sure yet' },
            ],
            next: { '*': 'placement' },
        },
        placement: {
            type: 'buttons',
            text: 'Where would you like the logo?',
            save_as: 'placement',
            buttons: [
                { id: 'Front only', title: 'Front only' },
                { id: 'Back only', title: 'Back only' },
                { id: 'Front & back', title: 'Front & back' },
            ],
            next: { '*': 'logo' },
        },
        logo: {
            type: 'ask_media',
            text: 'Please send your logo — a PNG, JPG or PDF is perfect. Our designer will make a mockup of your t-shirt with it for you to approve.\n\nIf you don’t have it handy, just reply "skip".',
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

    // Two questions added since — the size split after a quantity, where the logo goes after the
    // branding — go into an edited menu too, in between the same two steps, keeping its wording.
    const row = (await db.query(`SELECT id, definition FROM wa_flows WHERE key = $1`, [CREWFIT_FLOW.key])).rows[0];
    const def = safeJson(row?.definition, null);
    if (!def?.steps) return;
    let changed = false;
    for (const [after, added] of [['quantity', 'sizes'], ['branding', 'placement']]) {
        const from = def.steps[after];
        if (def.steps[added] || !from?.next?.['*']) continue;
        def.steps[added] = { ...CREWFIT_FLOW.steps[added], next: { '*': from.next['*'] } };
        from.next['*'] = added;
        changed = true;
    }
    if (changed) await db.query(`UPDATE wa_flows SET definition = $2 WHERE id = $1`, [row.id, JSON.stringify(def)]);
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
    // An exact number of pieces ("60"), or one of the old ranges ("50-200").
    const exact = /^\s*\d+\s*$/.test(String(band || '')) ? Number(band) : null;
    const [low, high] = exact ? [exact, exact] : (BANDS[band] || [1, Infinity]);
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
const bandText = (q) => (q === '50-200' ? '50 to 200' : /^\s*\d+\s*$/.test(String(q || '')) ? `${String(q).trim()} pcs` : q);

async function summaryText(answers) {
    const items = itemsOf(answers);
    const lines = ['Thank you — here is what we have:'];
    for (const it of items) lines.push(`• ${[it.product, it.color].filter(Boolean).join(' — ')}${it.quantity ? ` × ${bandText(it.quantity)}` : ''}${it.sizes ? ` (${it.sizes})` : ''}`);
    if (answers.branding) lines.push(`• Branding: ${answers.branding}${answers.placement ? `, ${answers.placement.toLowerCase()}` : ''}`);
    else if (answers.placement) lines.push(`• Logo: ${answers.placement.toLowerCase()}`);
    lines.push(answers.logo ? '• Logo: received, thank you' : '• Logo: please send it here when you can');

    // What each comes to, off the published tiers.
    const priced = [];
    for (const it of items) {
        const price = it.quantity ? await priceFor(it.product, it.quantity) : null;
        if (price?.low) priced.push(`${price.name}: ${price.low === price.high ? `₹${price.low}` : `₹${price.high} down to ₹${price.low}`} a piece${price.onRequest ? ' (larger runs priced on request)' : ''}`);
        else if (price) priced.push(`${price.name}: quoted individually at that quantity`);
    }
    if (priced.length) lines.push('', items.length > 1 ? 'At those quantities:' : 'At that quantity:', ...priced.map(p => `• ${p}`), 'Printing included; GST extra.');
    if (answers.branding === 'Embroidery') lines.push('Embroidery has a one-off ₹800 digitising charge for the logo.');
    lines.push('', answers.logo
        ? 'Our designer will now prepare a mockup with your logo and send it here for your approval ✍️'
        : 'This is an estimate — one of our team will go through it with you shortly.');
    return lines.join('\n');
}

/* ── Running it ──────────────────────────────────────────────────────────────────────────────── */

/** Write down what the bot said, so the thread reads as one conversation. */
async function record(conversation, wamid, body, type = 'text', payload = null) {
    await db.query(
        `INSERT INTO wa_messages (conversation_id, wamid, direction, sender_type, type, body, interactive_payload, status)
         VALUES ($1,$2,'out','bot',$3,$4,$5,'sent')
         ON CONFLICT (wamid) DO NOTHING`,
        [conversation.id, wamid, type, body, payload ? JSON.stringify(payload) : null]);
    await db.query(
        `UPDATE wa_conversations SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = $2,
                updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [conversation.id, String(body || '').slice(0, 200)]);
}

/* ── Steps that come from the catalogue ─────────────────────────────────────────────────────── */

const assist = () => require('./cf-assist');
/** A step's words with what was chosen so far: {product}, {color}, and "{ in color}" (" in Navy"). */
const fill = (text, answers) => String(text || '')
    .replace(/\{product\}/g, answers.product_interest || 'it')
    .replace(/\{quantity\}/g, answers.quantity || '')
    .replace(/\{ in color\}/g, answers.color ? ` in ${answers.color}` : '')
    .replace(/\{color\}/g, answers.color || '');

async function productOf(answers) {
    const list = await assist().products();
    return list.find(p => String(p.id) === String(answers._pid)) || list.find(p => p.name === answers.product_interest) || null;
}

async function remember(conversation, flow, stepId, answers) {
    await db.query(
        `UPDATE wa_conversations SET mode = 'flow', flow_id = $2, flow_step = $3, flow_data = $4,
                updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [conversation.id, flow.key, stepId, JSON.stringify(answers)]);
}

/**
 * The products as a WhatsApp list, from the catalogue as it is today: by category first when there
 * are more than fit in one list (WhatsApp allows ten rows), then the products of the one picked.
 */
async function sendPicker(conversation, flow, stepId, step, answers, category = null) {
    const list = await assist().products();
    const cats = [...new Set(list.map(p => p.category || 'Other'))];
    const other = step.next?.other ? [{ id: 'other', title: 'Something else', description: 'Tell us what you need' }] : [];
    let rows;
    let button = 'See products';
    if (!category && cats.length > 1 && list.length > 9) {
        rows = cats.slice(0, 9).map(c => ({
            id: `cat:${c}`.slice(0, 200), title: c.slice(0, 24),
            description: list.filter(p => (p.category || 'Other') === c).map(p => p.name).join(', ').slice(0, 72),
        }));
        button = 'See categories';
    } else {
        rows = list.filter(p => !category || (p.category || 'Other') === category).slice(0, 9).map(p => ({
            id: `p:${p.id}`, title: p.name.slice(0, 24),
            description: [p.name.length > 24 ? p.name : null, p.from_price ? `from ₹${Number(p.from_price)}` : null, p.gsm ? `${p.gsm} GSM` : null].filter(Boolean).join(' · ').slice(0, 72),
        }));
    }
    const text = fill(category ? `${category} — which one?` : step.text, answers);
    const wamid = await wa.sendList(conversation.phone, text, { button, sections: [{ title: category || 'Our products', rows: [...rows, ...other].slice(0, 10) }] });
    await record(conversation, wamid, text, 'interactive', { kind: 'list', button, options: [...rows, ...other].map(r => r.title) });
    await remember(conversation, flow, stepId, answers);
}

/** Send one step and remember where we are. */
async function send(conversation, flow, stepId, answers) {
    const step = flow.steps?.[stepId];
    if (!step) return handToHuman(conversation, 'the menu ran out of steps');
    const next = () => (step.next?.['*'] ? send(conversation, flow, step.next['*'], answers) : handToHuman(conversation, `nothing after ${stepId}`));

    if (step.type === 'catalogue_pick') return sendPicker(conversation, flow, stepId, step, answers);
    if (step.type === 'color_pick') {
        const p = await productOf(answers);
        const colors = p?.colors || [];
        if (!colors.length) return next();       // a product with no colours listed: nothing to ask
        const rows = [...colors.slice(0, 9).map(c => ({ id: `c:${c}`.slice(0, 200), title: c.slice(0, 24) })), { id: 'other', title: 'Another colour' }];
        const text = fill(step.text, answers);
        const wamid = await wa.sendList(conversation.phone, text, { button: 'Choose colour', sections: [{ title: `${p.name}`.slice(0, 24), rows }] });
        await record(conversation, wamid, text, 'interactive', { kind: 'list', button: 'Choose colour', options: rows.map(r => r.title) });
        return remember(conversation, flow, stepId, answers);
    }
    if (step.type === 'ask_number' || step.type === 'ask_sizes') {
        const text = fill(step.text, answers);
        await record(conversation, await wa.sendText(conversation.phone, text), text);
        return remember(conversation, flow, stepId, answers);
    }
    if (step.type === 'send_size_chart') {
        await assist().sendSizeChart(conversation, await productOf(answers));
        await remember(conversation, flow, stepId, answers);
        return next();
    }
    if (step.type === 'send_samples') {
        const p = await productOf(answers);
        if (!p || !(await assist().sendSamples(conversation, p))) {
            const text = `We'll share photos of ${p?.name || 'that'} with you shortly.`;
            await record(conversation, await wa.sendText(conversation.phone, text), text);
        }
        await remember(conversation, flow, stepId, answers);
        return next();
    }
    if (step.type === 'send_prices') {
        await assist().sendPriceList(conversation, await assist().products());
        await remember(conversation, flow, stepId, answers);
        return next();
    }

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
    // The buttons or list options, so the chat shows them as the customer sees them.
    const look = step.type === 'buttons' ? { kind: 'buttons', options: (step.buttons || []).map(b => b.title || b.text || b) }
        : step.type === 'list' ? { kind: 'list', button: step.button, options: (step.sections || []).flatMap(s => (s.rows || []).map(r => r.title)) } : null;
    await record(conversation, wamid, step.text, step.type === 'text' ? 'text' : 'interactive', look);

    await db.query(
        `UPDATE wa_conversations SET mode = 'flow', flow_id = $2, flow_step = $3, flow_data = $4,
                updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [conversation.id, flow.key, stepId, JSON.stringify(answers)]);

    // A step that only tells them something carries straight on to the next one.
    if (step.type === 'text' && step.next?.['*']) {
        return send(conversation, flow, step.next['*'], answers);
    }
}

// Conversations the menu just passed to the sales team — a finished quote, or words it could not
// answer. After hours these are the ones told when the team is back (routes/whatsapp.js), rather
// than every chat that happens to be out of the menu.
const handovers = new Set();

// A hello and nothing else: "hi", "hello sir", "good morning", "vanakkam".
const GREETING = /^(h+i+|hai|hey+|hel+o+|hlo|helo|hy|yo|good (morning|afternoon|evening|day)|gm|vanakkam|namaste|namaskaram)( (sir|madam|mam|bro|anna|team|there|crewfit|ji))*$/i;
const isGreeting = (text) => GREETING.test(String(text || '').replace(/[\p{P}\p{Extended_Pictographic}\p{S}]/gu, ' ').trim().replace(/\s+/g, ' '));
const takeHandover = (conversationId) => handovers.delete(conversationId);

/** Hand over, with the reason visible in the thread rather than only in a log. */
async function handToHuman(conversation, why) {
    await db.query(
        `UPDATE wa_conversations SET mode = 'human', flow_step = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`, [conversation.id]);
    if (why) console.log(`whatsapp flow handed conversation ${conversation.id} to a person: ${why}`);
}

/**
 * The products asked for so far. Each answer to a quantity question closes one product — the one
 * last picked — so a customer who adds another product gets a second line, not an overwrite.
 */
function collectItem(answers, step) {
    if (step.save_as !== 'quantity' || !answers.product_interest) return;
    answers.items = [...(answers.items || []), { product: answers.product_interest, color: answers.color || '', quantity: answers.quantity }];
}
const itemsOf = (answers) => (answers.items?.length ? answers.items
    : answers.product_interest ? [{ product: answers.product_interest, color: answers.color || '', quantity: answers.quantity }] : []);

/** The end of the menu: everything learned goes onto the enquiry, and a person takes over. */
async function finish(conversation, answers) {
    const sets = [];
    const params = [];
    const items = itemsOf(answers);
    // Every product asked for goes on the enquiry; the single fields carry them joined.
    const joined = items.length > 1 ? {
        product_interest: items.map(i => i.product).join(', '),
        quantity: items.map(i => `${i.product}: ${bandText(i.quantity)}`).join(', '),
    } : {};
    if (items.length) {
        params.push(JSON.stringify(items.map(i => ({ product: i.product, color: i.color || '', quantity: /^\s*\d+\s*$/.test(String(i.quantity || '')) ? String(i.quantity).trim() : bandText(i.quantity), sizes: i.sizes || '' }))));
        sets.push(`products = $${params.length}`);
    }
    for (const [key, column] of [['product_interest', 'product_interest'], ['quantity', 'quantity'],
        ['branding', 'branding'], ['logo', 'logo_url'], ['placement', 'printing_placement']]) {
        const value = joined[key] || answers[key];
        if (value) {
            params.push(String(value));
            sets.push(`${column} = $${params.length}`);
        }
    }
    if (sets.length) {
        params.push(conversation.lead_id);
        await db.query(
            `UPDATE crewfit_leads SET ${sets.join(', ')}, status = CASE WHEN status IN ('new','enquiry') THEN 'qualified' ELSE status END,
                    updated_at = CURRENT_TIMESTAMP
              WHERE id = $${params.length}`, params);
        // Over 50 pieces: Important. Product, colour, quantity and logo all in: Need mockup.
        // The summary just told a customer who sent their logo that the designer has it.
        await require('./cf-lead-rules').apply(conversation.lead_id, conversation.id, { told: !!answers.logo });
    }
    await handToHuman(conversation, 'the menu finished');
    handovers.add(conversation.id);
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

    // A product: a category opens its products; a product is chosen (its photo, sizes and prices
    // go with it); a product named in words counts too.
    if (step.type === 'catalogue_pick') {
        if (tapped?.startsWith('cat:')) {
            await sendPicker(conversation, flow, conversation.flow_step, step, answers, tapped.slice(4));
            return true;
        }
        const list = await assist().products();
        const p = tapped?.startsWith('p:') ? list.find(x => `p:${x.id}` === tapped) : (!tapped ? assist().matchProducts(text, list)[0] : null);
        if (tapped === 'other') {
            await send(conversation, flow, step.next?.other || step.next?.['*'], answers);
            return true;
        }
        if (p) {
            answers[step.save_as || 'product_interest'] = p.name;
            answers.product_interest = p.name;
            answers._pid = p.id;
            delete answers.color;
            if (step.card) await assist().sendProductCard(conversation, p);
            await send(conversation, flow, step.next?.['*'], answers);
            return true;
        }
    }

    if (step.type === 'color_pick') {
        if (tapped === 'other') {
            answers._typing = 'color';
            const ask = 'Sure — type the colour you need.';
            await record(conversation, await wa.sendText(conversation.phone, ask), ask);
            await remember(conversation, flow, conversation.flow_step, answers);
            return true;
        }
        const colour = tapped?.startsWith('c:') ? tapped.slice(2) : (!tapped && text && (answers._typing === 'color' || text.length <= 30) ? text : null);
        if (colour) {
            answers[step.save_as || 'color'] = colour;
            answers.color = colour;
            delete answers._typing;
            await send(conversation, flow, step.next?.['*'], answers);
            return true;
        }
    }

    if (step.type === 'ask_number') {
        const n = Number((String(text).replace(/,/g, '').match(/\d+/) || [])[0]);
        if (n > 0) {
            answers[step.save_as || 'quantity'] = String(n);
            delete answers._retry;
            collectItem(answers, step);
            await send(conversation, flow, step.next?.['*'], answers);
            return true;
        }
        if (!answers._retry) {
            answers._retry = 1;
            const ask = 'Please type just the number of pieces, for example 50.';
            await record(conversation, await wa.sendText(conversation.phone, ask), ask);
            await remember(conversation, flow, conversation.flow_step, answers);
            return true;
        }
    }

    // The sizes for the product just counted: kept on it, and told back if they don't add up.
    if (step.type === 'ask_sizes' && !tapped) {
        const sizes = require('./cf-sizes');
        const split = sizes.parse(text);
        const last = answers.items?.[answers.items.length - 1];
        if (split.length) {
            const got = sizes.total(split);
            const want = Number(answers.quantity) || 0;
            if (last) last.sizes = sizes.format(split);
            delete answers._retry;
            const note = want && got !== want
                ? `Noted: ${sizes.format(split)} — that is ${got} pieces, and you asked for ${want}. Our team will confirm the final split with you.`
                : `Noted: ${sizes.format(split)} ✅`;
            await record(conversation, await wa.sendText(conversation.phone, note), note);
            await send(conversation, flow, step.next?.['*'], answers);
            return true;
        }
        if (answers._retry || /^(skip|no|not sure|later|don'?t know|dont know)\b/i.test(text)) {
            delete answers._retry;
            await send(conversation, flow, step.next?.['*'], answers);
            return true;
        }
        answers._retry = 1;
        const ask = 'Please type the sizes like this: M-10, L-20, XL-20 — or reply "skip".';
        await record(conversation, await wa.sendText(conversation.phone, ask), ask);
        await remember(conversation, flow, conversation.flow_step, answers);
        return true;
    }

    // A tap that isn't an answer to this question (from an older list, or tapped before this one
    // arrived) is never saved as one: the question is asked again.
    if (tapped && ['catalogue_pick', 'color_pick', 'ask_number', 'ask_sizes'].includes(step.type)) {
        await send(conversation, flow, conversation.flow_step, answers);
        return true;
    }

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
        collectItem(answers, step);
        await send(conversation, flow, step.next?.['*'], answers);
        return true;
    }

    // A tap on a button or a list row.
    if (tapped) {
        if (step.save_as) answers[step.save_as] = tapped;
        collectItem(answers, step);
        const nextId = step.next?.[tapped] || step.next?.['*'];
        if (!nextId) {
            await handToHuman(conversation, `no step after ${tapped}`);
            return true;
        }
        await send(conversation, flow, nextId, answers);
        return true;
    }

    // A "hi" or "good morning" where a tap was expected is just a hello: show the step again.
    if (isGreeting(text)) {
        await send(conversation, flow, conversation.flow_step, answers);
        return true;
    }

    // Words where a tap was expected: the menu stops rather than repeating itself. If the words are
    // a question the catalogue answers (sizes, photos, prices…), the answer goes instead of the
    // "passing you on" line (cf-assist sends it, now that a person has the chat).
    await handToHuman(conversation, 'the customer typed instead of tapping');
    await assist().products();
    await assist().savedAnswers();
    // Only when the bot may go on answering here; in a chat the team has, they get the line below.
    if ((conversation.bot_on ?? !conversation.assigned_to) && assist().canAnswer(text)) return false;
    handovers.add(conversation.id);
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

module.exports = { activeFlow, flowByKey, ensureStarterFlow, start, handle, priceFor, summaryText, takeHandover, isGreeting, CREWFIT_FLOW };
