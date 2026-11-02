/**
 * Crewfit's helper on WhatsApp: qualifying leads from what customers send, and answering product
 * questions from the catalogue while nobody on the team has the chat yet.
 *
 * Qualifying: a lead still at "New" or "Enquiry" moves to "Qualified" as soon as the customer sends
 * any of what a quote needs — their logo (a photo or file), a quantity, billing details (a GST
 * number or a billing address), or a product from the catalogue. What was found is written onto the
 * lead (quantity, product, GST number, logo) where it is still empty, and noted on the chat.
 *
 * Answering, from the catalogue and the team's saved answers, whenever no person has written in
 * the chat for two hours (so it never talks over a salesperson):
 *   - a product ("polo price?", "do you have hoodies"): its photo, material, colours and price tiers;
 *   - "catalogue", "brochure", "pdf": the catalogue PDF;
 *   - "size chart", "sizes", "measurements": the product's catalogue page with its size chart;
 *   - "samples", "photos of your work": up to 30 production photos of the product, one colour after
 *     another;
 *   - "what colours": the product's colours;
 *   - "price list", "rates": the range with prices;
 *   - anything in Settings › Bot answers (MOQ, address, payment terms…);
 *   - asking for a person: a line saying someone will reply.
 * When it can't tell which product is meant, it asks with a list, and the tap is answered here too.
 *
 * Then the lead rules (cf-lead-rules): more than 50 pieces is Important; product, colour, quantity
 * and logo all in is Need mockup.
 */

const db = require('../db/connection');
const wa = require('./whatsapp');
const lines = require('./wa-line');

const PUBLIC_BASE = () => (process.env.PUBLIC_BASE_URL || 'https://ops.normless.store').replace(/\/+$/, '');
const safeJson = (v, f) => { try { return typeof v === 'string' ? (JSON.parse(v || 'null') ?? f) : (v ?? f); } catch { return f; } };
const GSTIN = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/i;
const QTY = /(?:\b(?:qty|quantity)\s*[:\-=]?\s*(\d{1,5})\b)|(?:\b(\d{1,5})\s*(?:pcs|pc|pieces?|nos|numbers|units|qty|t-?shirts?|tees|shirts?|polos?|hoodies?|jerseys?|caps?|uniforms?)\b)/i;
const ASK_PERSON = /\b(talk|speak|connect|call)\b.*\b(team|person|someone|human|agent|executive|you)\b|\bcall me\b|\bhuman\b/i;
const ASK_RANGE = /\b(price ?list|rate ?card|rates|all products|what (do )?you (have|sell|make))\b/i;
const ASK_CATALOGUE = /\b(catalog(ue)?s?|brochure|pdf|product list)\b/i;
const ASK_SIZE = /\b(size ?chart|sizes?|measurements?|chest|length|xxl|xl)\b/i;
const ASK_SAMPLES = /\b(samples?|photos?|pics?|pictures?|images?|previous (work|orders?)|your work|real (photos?|pics?))\b/i;
const ASK_COLOUR = /\b(colou?rs?|shades?)\b/i;
const QUIET_HOURS = 2;          // the bot stays out of a chat a person wrote in this recently
const ASK_PRICE = /\b(price|cost|rate|how much|quote)\b/i;

async function products() {
    const rows = (await db.query(
        `SELECT id, name, category, fit, gsm, material, from_price, blurb, colors, tiers, image_url, chart_url
           FROM crewfit_products WHERE active AND COALESCE(wa_visible, true) ORDER BY sort_order, id`)).rows;
    cachedProducts = rows.map(p => ({ ...p, colors: safeJson(p.colors, []), tiers: safeJson(p.tiers, []) }));
    return cachedProducts;
}

const singular = (w) => w.replace(/ies$/, 'y').replace(/(s|es)$/, '');
/** Catalogue products the words mention, best first. */
function matchProducts(text, list) {
    const words = String(text || '').toLowerCase().replace(/t-?shirts?/g, 'tshirt').split(/[^a-z0-9]+/).filter(w => w.length > 2).map(singular);
    if (!words.length) return [];
    const scored = list.map(p => {
        const name = String(p.name).toLowerCase().replace(/t-?shirts?/g, 'tshirt').split(/[^a-z0-9]+/).map(singular);
        const cat = String(p.category || '').toLowerCase().split(/[^a-z0-9]+/).map(singular);
        const score = words.reduce((n, w) => n + (name.includes(w) ? 3 : 0) + (cat.includes(w) ? 1 : 0), 0);
        return { p, score };
    }).filter(x => x.score > 0);
    // The best match only (or the ones tied for it): "poly cotton polos" is that product, not
    // every polo.
    const top = Math.max(0, ...scored.map(x => x.score));
    return scored.filter(x => x.score === top).map(x => x.p);
}

const rupees = (v) => (Number.isFinite(Number(v)) ? `₹${Number(v).toLocaleString('en-IN')}` : String(v));
function caption(p) {
    const bits = [p.material, p.gsm ? `${p.gsm} GSM` : null, p.fit].filter(x => x && String(x).trim()).map(x => String(x).trim());
    const colours = p.colors.length ? `Colours: ${p.colors.slice(0, 5).join(', ')}${p.colors.length > 5 ? ` +${p.colors.length - 5} more` : ''}` : null;
    const tiers = p.tiers.length ? `Price per piece: ${p.tiers.map(([q, v]) => `${q}: ${typeof v === 'number' ? rupees(v) : String(v).toLowerCase()}`).join(' · ')}` : (p.from_price ? `From ${rupees(p.from_price)} a piece` : null);
    return [`*${p.name}*${p.category ? ` (${p.category})` : ''}`, bits.join(' · '), p.blurb, colours, tiers]
        .filter(x => x && String(x).trim()).join('\n');
}

async function record(conversationId, wamid, body, type = 'text', media = null) {
    await db.query(
        `INSERT INTO wa_messages (conversation_id, wamid, direction, sender_type, type, body, media_url, media_mime, status)
         VALUES ($1,$2,'out','bot',$3,$4,$5,$6,'sent')`, [conversationId, wamid, type, body, media, media ? 'image/jpeg' : null]);
    await db.query(`UPDATE wa_conversations SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [conversationId, String(body || '📷 Photo').slice(0, 200)]);
}

/** Has the helper already said this in the last hour? (No repeating itself on every message.) */
async function saidRecently(conversationId, needle) {
    return !!(await db.query(
        `SELECT 1 FROM wa_messages WHERE conversation_id = $1 AND sender_type = 'bot' AND created_at > NOW() - INTERVAL '1 hour' AND body ILIKE $2 LIMIT 1`,
        [conversationId, `%${needle}%`])).rows[0];
}

/* ── Qualifying ───────────────────────────────────────────────────────────────────────────── */

/**
 * What in this message tells us the lead is real. Writes it onto the lead and moves it to
 * Qualified when it is still New or an Enquiry. Returns what was found (for tests and the log).
 */
async function qualify(conversationId, message, { text = '', mediaUrl = null } = {}) {
    const row = (await db.query(
        `SELECT l.id, l.status, l.quantity, l.product_interest, l.products, l.gst_number, l.logo_url, l.billing_address
           FROM wa_conversations c JOIN wa_contacts k ON k.id = c.contact_id JOIN crewfit_leads l ON l.id = k.lead_id
          WHERE c.id = $1`, [conversationId])).rows[0];
    if (!row) return [];
    const found = [];
    const set = {};
    const type = message?.type;
    if ((type === 'image' || type === 'document') && mediaUrl) {
        found.push('a logo or design');
        if (!row.logo_url) set.logo_url = mediaUrl;
    }
    const q = String(text).match(QTY);
    const qty = q && Number(q[1] || q[2]);
    if (qty && qty >= 5 && qty <= 100000) {
        found.push(`a quantity (${qty})`);
        if (!row.quantity) set.quantity = String(qty);
    }
    const gst = String(text).match(GSTIN);
    if (gst) { found.push('a GST number'); if (!row.gst_number) set.gst_number = gst[0].toUpperCase(); }
    else if (/\bbilling\b|\bgst\b|\bcompany name\b|\binvoice (to|address)\b/i.test(text) && String(text).length > 25) found.push('billing details');
    const list = await products();
    const hits = matchProducts(text, list);
    if (hits.length) {
        found.push(`interest in ${hits[0].name}`);
        if (!row.product_interest) set.product_interest = hits[0].name;
    }
    // A colour of the product they're asking about, named in the message.
    const product = list.find(p => p.name === (set.product_interest || row.product_interest));
    const colour = product && product.colors.find(c => new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text));
    if (colour) found.push(`the colour ${colour}`);
    if (!found.length) return [];
    // The product list follows: one product picked here, its colour and quantity when given.
    const items = require('./cf-lead-rules').itemsOf({ ...row, ...set });
    if ((set.product_interest || colour || set.quantity) && items.length <= 1) {
        const it = { product: set.product_interest || row.product_interest || items[0]?.product || '', color: colour || items[0]?.color || '', quantity: set.quantity || row.quantity || items[0]?.quantity || '' };
        if (it.product) set.products = JSON.stringify([it]);
    }

    const keys = Object.keys(set);
    if (keys.length) {
        await db.query(`UPDATE crewfit_leads SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [row.id, ...keys.map(k => set[k])]);
    }
    if (['new', 'enquiry'].includes(row.status)) {
        const qualified = (await db.query(`SELECT key FROM wa_lead_statuses WHERE key = 'qualified'`)).rows[0];
        if (qualified) {
            await db.query(`UPDATE crewfit_leads SET status = 'qualified', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [row.id]);
            await db.query(`INSERT INTO wa_activity (conversation_id, kind, body) VALUES ($1,'status',$2)`,
                [conversationId, `Marked Qualified automatically — the customer sent ${found.join(', ')}`]);
        }
    }
    // Then on to Important or Need mockup, if what we now know says so.
    await require('./cf-lead-rules').apply(row.id, conversationId);
    return found;
}

/* ── Answering from the catalogue ─────────────────────────────────────────────────────────── */

const link = (url) => (/^https?:\/\//.test(url) ? url : `${PUBLIC_BASE()}${url}`);

/** A product's photo with its details, as one message (or the details alone, without a photo). */
async function sendProductCard(conversation, p) {
    const cap = caption(p);
    if (p.image_url) await record(conversation.id, await wa.sendImageLink(conversation.phone, link(p.image_url), cap), cap, 'image', p.image_url);
    else await record(conversation.id, await wa.sendText(conversation.phone, cap), cap);
}

/** The product's size chart (its catalogue page), or the catalogue PDF when it has none. */
async function sendSizeChart(conversation, p) {
    if (p?.chart_url) {
        const cap = `${p.name} — size chart, colours and prices`;
        await record(conversation.id, await wa.sendImageLink(conversation.phone, link(p.chart_url), cap), cap, 'image', p.chart_url);
        return true;
    }
    await require('./wa-extras').sendCatalogue(conversation, { senderType: 'bot', caption: `Size charts for every product are in our catalogue 📘` });
    return true;
}

async function sendPriceList(conversation, list) {
    const body = `Here’s our range (price per piece, printing included, from):\n\n${list.map(p => `• ${p.name}${p.from_price ? ` — ${rupees(p.from_price)}` : ''}`).join('\n')}\n\nTell us which one you like and we’ll send photos, sizes and the full price list.`;
    await record(conversation.id, await wa.sendText(conversation.phone, body), body);
}

/** Up to 7 production photos of the product, one colour after another. False if we have none. */
async function sendSamples(conversation, p) {
    const samples = require('./cf-samples');
    const photos = await samples.pick({ product: p.name, limit: samples.BOT_MAX });
    if (!photos.length) return false;
    const colours = [...new Set(photos.map(x => x.color).filter(Boolean))];
    await samples.send(conversation, photos, { senderType: 'bot',
        intro: `Here are ${photos.length} photos of ${p.name} we've made for other customers${colours.length > 1 ? `, in ${colours.length} colours` : ''} 👇` });
    return true;
}

/** "Which product?" as a list; the tap comes back with the id `${kind}:${productId}`. */
async function askWhichProduct(conversation, kind, question) {
    const list = await products();
    const rows = list.slice(0, 10).map(p => ({ id: `${kind}:${p.id}`, title: p.name.slice(0, 24), description: [p.category, p.from_price ? `from ${rupees(p.from_price)}` : null].filter(Boolean).join(' · ').slice(0, 72) }));
    const wamid = await wa.sendList(conversation.phone, question, { button: 'Choose product', sections: [{ title: 'Our products', rows }] });
    await record(conversation.id, wamid, question, 'interactive');
}

/** The team's saved answers (Settings › Bot answers): [{ keywords: [...], answer, on }]. */
async function savedAnswers() {
    const r = (await db.query(`SELECT value FROM wa_settings WHERE key = 'cf_bot_answers'`)).rows[0];
    cachedAnswers = safeJson(r?.value, null) || DEFAULT_ANSWERS;
    return cachedAnswers;
}
const DEFAULT_ANSWERS = [
    { on: true, keywords: ['moq', 'minimum order', 'minimum quantity', 'min order'], answer: 'Our minimum order is just 5 pieces per design. The price per piece drops as the quantity goes up — tell us how many you need and we\'ll share the exact rate.' },
    { on: true, keywords: ['sample', 'trial piece', 'one piece'], answer: 'Yes, we can make a sample before the bulk order — it costs ₹250 more than the per-piece price, with your logo printed.' },
    { on: true, keywords: ['printing charge', 'print charge', 'printing cost', 'including printing'], answer: 'Our prices include printing your logo. Embroidery has a one-off ₹800 digitising charge for the logo.' },
    { on: true, keywords: ['embroidery', 'embroidered'], answer: 'We do both printing and embroidery. Embroidery has a one-off ₹800 digitising charge for your logo; printing is included in the price.' },
    { on: true, keywords: ['advance', 'payment terms', 'how to pay', 'payment method'], answer: 'We start production after a 50% advance. The balance is paid before dispatch. We send a secure payment link — UPI, cards and net banking all work.' },
    { on: true, keywords: ['address', 'location', 'where are you', 'office', 'visit'], answer: 'We\'re at Plot no 2, 2nd Floor, Dhanalakshmi Nagar, Moulivakkam, Iyyappanthangal, Chennai, Tamil Nadu 600125.' },
    { on: true, keywords: ['email', 'mail id'], answer: 'You can email us at crewfitfashion@gmail.com.' },
    { on: false, keywords: ['delivery time', 'how many days', 'when will i get', 'dispatch'], answer: '(Write how long production and delivery usually take, then switch this on.)' },
];

/** Has a person written in this chat recently? Then the bot keeps out of it. */
async function personActive(conversationId) {
    return !!(await db.query(
        `SELECT 1 FROM wa_messages WHERE conversation_id = $1 AND direction = 'out' AND sender_type IN ('user','phone')
            AND COALESCE(sent_at, created_at) > LOCALTIMESTAMP - make_interval(hours => $2) LIMIT 1`, [conversationId, QUIET_HOURS])).rows[0];
}

/** The product the chat is about: named in the message, else the one on the lead. */
/** Has this customer ordered from us? Matched on the number, as the inbox matches orders. */
async function hasOrder(conversation) {
    const last10 = String(conversation.phone || '').replace(/\D/g, '').slice(-10);
    if (last10.length !== 10) return false;
    return (await db.query(
        `SELECT 1 FROM crewfit_orders
          WHERE RIGHT(REGEXP_REPLACE(COALESCE(whatsapp_number,''), '\\D', '', 'g'), 10) = $1
             OR RIGHT(REGEXP_REPLACE(COALESCE(contact_number,''), '\\D', '', 'g'), 10) = $1 LIMIT 1`, [last10])).rowCount > 0;
}

async function productInChat(conversation, text, list) {
    const hit = matchProducts(text, list)[0];
    if (hit) return hit;
    const lead = (await db.query(
        `SELECT l.product_interest FROM wa_conversations c JOIN wa_contacts k ON k.id = c.contact_id JOIN crewfit_leads l ON l.id = k.lead_id WHERE c.id = $1`,
        [conversation.id])).rows[0];
    return list.find(p => p.name === lead?.product_interest) || null;
}

/**
 * Answer what the bot can, unless a person is in the chat. Returns true when it replied.
 * `conversation` needs id, phone, mode, status. `tapped` is a list reply's id, if any.
 */
async function answer(conversation, text, tapped = null, { evenInMenu = false } = {}) {
    if ((conversation.mode !== 'human' && !evenInMenu) || conversation.status === 'closed') return false;
    if (await personActive(conversation.id)) return false;
    const list = await products();

    // A tap on one of the bot's own "which product?" lists.
    const m = String(tapped || '').match(/^(chart|samples|colours):(\d+)$/);
    if (m) {
        const p = list.find(x => String(x.id) === m[2]);
        if (!p) return false;
        if (m[1] === 'chart') return sendSizeChart(conversation, p);
        if (m[1] === 'colours') return sendColours(conversation, p);
        if (!(await sendSamples(conversation, p))) await sendProductCard(conversation, p);
        return true;
    }
    if (!text) return false;

    if (ASK_PERSON.test(text)) {
        // After hours "someone will reply shortly" isn't true: the hours message says when instead
        // (once — it is not repeated within 12 hours).
        const extras = require('./wa-extras');
        if (!extras.isOpen(await extras.workHours())) { await extras.maybeSendAway(conversation); return true; }
        if (await saidRecently(conversation.id, 'someone from our team')) return true;
        const body = 'Sure — someone from our team will reply to you here shortly.';
        await record(conversation.id, await wa.sendText(conversation.phone, body), body);
        return true;
    }
    if (ASK_CATALOGUE.test(text)) {
        if (await saidRecently(conversation.id, 'catalogue')) return true;
        await require('./wa-extras').sendCatalogue(conversation, { senderType: 'bot' });
        return true;
    }
    if (!list.length) return false;
    if (ASK_SIZE.test(text)) {
        const p = await productInChat(conversation, text, list);
        if (p) return sendSizeChart(conversation, p);
        await askWhichProduct(conversation, 'chart', 'Which product would you like the size chart for?');
        return true;
    }
    // "Sample" can also mean a trial piece ("sample piece price") — that's a saved answer, not photos.
    const trialPiece = /\bsamples?\s*(piece|price|cost|charges?|order|rate)\b|\b(trial|one piece)\b/i.test(text);
    if (ASK_SAMPLES.test(text) && !trialPiece && !/\b(logo|design)\b/i.test(text)) {
        // A customer with an order asking for photos means their own order's — that is the team's.
        if (await hasOrder(conversation)) return false;
        // Only the product they name in this message; otherwise they are asked, never guessed
        // from what the lead was once interested in.
        const p = matchProducts(text, list)[0];
        if (p) {
            if (await sendSamples(conversation, p)) return true;
            await sendProductCard(conversation, p);
            return true;
        }
        await askWhichProduct(conversation, 'samples', 'Happy to share photos of our work! Which product would you like to see?');
        return true;
    }
    if (ASK_COLOUR.test(text)) {
        const p = await productInChat(conversation, text, list);
        if (p) return sendColours(conversation, p);
        await askWhichProduct(conversation, 'colours', 'Which product would you like the colours for?');
        return true;
    }

    // The team's own answers, by keyword — before the general product and price replies, so
    // "what's the MOQ" gets the MOQ answer rather than the price list.
    const lower = String(text).toLowerCase();
    const saved = (await savedAnswers()).find(a => a.on && (a.keywords || []).some(k => k && lower.includes(String(k).toLowerCase())));
    if (saved) {
        if (await saidRecently(conversation.id, saved.answer.slice(0, 40))) return true;
        await record(conversation.id, await wa.sendText(conversation.phone, saved.answer), saved.answer);
        return true;
    }

    const hits = matchProducts(text, list);
    if (hits.length) {
        let sent = 0;
        for (const p of hits.slice(0, 3)) {
            if (await saidRecently(conversation.id, `*${p.name}*`)) continue;
            await sendProductCard(conversation, p);
            sent++;
        }
        if (sent) {
            const next = 'Prices include printing. Tell us the colour, how many pieces, and send your logo — we’ll prepare a mockup and quote.';
            if (!(await saidRecently(conversation.id, 'prepare a mockup'))) await record(conversation.id, await wa.sendText(conversation.phone, next), next);
        }
        return true;
    }
    if (ASK_RANGE.test(text) || (ASK_PRICE.test(text) && String(text).length < 80)) {
        if (await saidRecently(conversation.id, 'Here’s our range')) return true;
        await sendPriceList(conversation, list);
        return true;
    }
    return false;
}

/** Would answer() have something to say to these words? (Without saying it.) */
function canAnswer(text) {
    const t = String(text || '');
    if (!t.trim()) return false;
    return ASK_PERSON.test(t) || ASK_CATALOGUE.test(t) || ASK_SIZE.test(t) || ASK_SAMPLES.test(t) || ASK_COLOUR.test(t)
        || ASK_RANGE.test(t) || (ASK_PRICE.test(t) && t.length < 80) || matchProducts(t, cachedProducts).length > 0
        || cachedAnswers.some(a => a.on && (a.keywords || []).some(k => k && t.toLowerCase().includes(String(k).toLowerCase())));
}
// What canAnswer() checks against, refreshed whenever the catalogue or the answers are read.
let cachedProducts = [];
let cachedAnswers = DEFAULT_ANSWERS;

async function sendColours(conversation, p) {
    const body = p.colors.length
        ? `*${p.name}* comes in ${p.colors.length} colours: ${p.colors.join(', ')}.\n\nWhich colour would you like?`
        : `For *${p.name}*, tell us the colour you need and we'll confirm it.`;
    await record(conversation.id, await wa.sendText(conversation.phone, body), body);
    return true;
}

/** Both, for one Crewfit message. Never throws: the message is already saved. */
async function onInbound(conversationId, message, { text, mediaUrl, first = false }) {
    try {
        // A tap on a menu button or list row is the menu's to read: its title ("Polos") isn't the
        // customer naming a product in their own words.
        if (message?.type !== 'interactive') await qualify(conversationId, message, { text, mediaUrl });
        const c = (await db.query(
            `SELECT c.id, c.mode, c.assigned_to, c.status, k.phone FROM wa_conversations c JOIN wa_contacts k ON k.id = c.contact_id WHERE c.id = $1`,
            [conversationId])).rows[0];
        const tapped = message?.interactive?.list_reply?.id || message?.interactive?.button_reply?.id || null;
        // A question in the very first message ("price of polos?") is answered as well as the menu
        // greeting it; after that, the menu has the chat until it hands over.
        const evenInMenu = first && message?.type === 'text' && canAnswer(text);
        if (c && lines.current()?.brand === 'crewfit' && wa.configured()) await answer(c, text, tapped, { evenInMenu });
    } catch (err) {
        console.error('crewfit assist error:', err.message);
    }
}

module.exports = { qualify, answer, onInbound, matchProducts, caption, products, QTY, GSTIN,
    sendProductCard, sendSizeChart, sendSamples, sendPriceList, sendColours, savedAnswers, canAnswer, DEFAULT_ANSWERS };
