/**
 * The Normless WhatsApp menu: answers customers by taps, from Shopify and the CRM, with no AI.
 *
 * What it covers is what customers ask most: where is my order, what size should I take, show
 * me the products, how do I exchange, can I get a refund. Every answer comes from the shop's own
 * data — orders and waybills from the CRM, products, stock, photos and size charts from Shopify,
 * the exchange and refund rules from the published policy — and every step ends with a way back
 * to the menu or to a person. Whatever it can't settle (a refund, a damaged parcel, an order it
 * can't find, a question it doesn't understand twice) goes to somebody on the team, who is
 * introduced to the customer by name (nl-handover).
 *
 * State lives on the conversation: mode 'flow', flow_step says what the customer was last asked,
 * flow_data holds what has been collected so far.
 */

const db = require('../db/connection');
const wa = require('./whatsapp');
const lines = require('./wa-line');
const shop = require('./nl-shop');
const shopify = require('./shopify');
const handover = require('./nl-handover');
const { readSettings } = require('./nl-settings');

const safeJson = (v, fallback) => { try { return typeof v === 'string' ? (JSON.parse(v || 'null') ?? fallback) : (v || fallback); } catch { return fallback; } };
const day = (v) => (v ? new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) : '');
const cut = (v, n) => { const s = String(v ?? '').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

const MENU = { id: 'menu', title: 'Main menu' };
const PERSON = { id: 'person', title: 'Talk to our team' };

/* ── Sending, and writing down what was sent ───────────────────────────────────────────────── */

async function note(conversationId, wamid, body, extra = {}) {
    await db.query(
        `INSERT INTO wa_messages (conversation_id, wamid, direction, sender_type, type, body, media_url, media_mime, interactive_payload, status)
         VALUES ($1,$2,'out','bot',$3,$4,$5,$6,$7,'sent')`,
        [conversationId, wamid, extra.type || 'text', body, extra.media || null, extra.media ? 'image/jpeg' : null,
            extra.payload ? JSON.stringify(extra.payload) : null]);
    await db.query(
        `UPDATE wa_conversations SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [conversationId, String(body).slice(0, 200)]);
}

const say = async (c, text) => note(c.id, await wa.sendText(c.phone, text), text);

const buttons = async (c, text, list) => note(c.id, await wa.sendButtons(c.phone, text, list), text,
    { type: 'interactive', payload: { kind: 'buttons', options: list.map(b => b.title) } });

const menuList = async (c, text, button, rows, title = 'Choose') => note(c.id,
    await wa.sendList(c.phone, text, { button, sections: [{ title, rows }] }), text,
    { type: 'interactive', payload: { kind: 'list', options: rows.map(r => r.title) } });

const image = async (c, url, caption) => note(c.id, await wa.sendImageLink(c.phone, url, caption), caption, { type: 'image', media: url });

const link = async (c, text, label, url) => note(c.id, await wa.sendCtaUrl(c.phone, text, { label, url }), `${text}\n${url}`,
    { type: 'interactive', payload: { kind: 'cta_url', url } });

async function setStep(c, step, data = undefined) {
    if (data === undefined) await db.query(`UPDATE wa_conversations SET flow_step = $2 WHERE id = $1`, [c.id, step]);
    else await db.query(`UPDATE wa_conversations SET flow_step = $2, flow_data = $3 WHERE id = $1`, [c.id, step, JSON.stringify(data)]);
    c.flow_step = step;
    if (data !== undefined) c.flow_data = data;
}

/** Back to the menu or to a person — the end of every answer. */
const afterAnswer = (c, text = 'Anything else?', extra = []) => buttons(c, text, [...extra, MENU, PERSON].slice(0, 3));

/* ── The menu ──────────────────────────────────────────────────────────────────────────────── */

const firstName = (c) => String(c.customer_name || c.profile_name || '').replace(/^~/, '').trim().split(/\s+/)[0] || '';

async function showMenu(c, settings, lead = null) {
    const items = settings.menu.items.filter(i => i.enabled);
    const greeting = lead || settings.menu.greeting.replace('{name}', firstName(c)).replace(/\s+,/, ',').replace('Hi ,', 'Hi,');
    await setStep(c, 'menu', { misses: c.flow_data?.misses || 0 });
    await menuList(c, greeting, 'See options', items.map(i => ({ id: i.key, title: i.label })), 'Normless');
}

/** Free text at the menu: guess what they mean from the words, so typing works as well as tapping. */
function guess(text) {
    const t = String(text || '').toLowerCase();
    if (/\b(track|tracking|where|status|awb|courier|deliver|delivery|shipped|dispatch|order\s*#?\d|#\d{4,})/.test(t)) return 'track';
    if (/\b(refund|money back|return|damaged|torn|defect|wrong (item|product|size sent)|broken|hole)/.test(t)) return 'refund';
    if (/\b(exchange|replace|swap|change (the )?size)/.test(t)) return 'exchange';
    if (/\b(size|sizes|chart|fit|measurement|xl|xxl|small|medium|large)\b/.test(t)) return 'size';
    if (/\b(price|cost|available|stock|tee|t-shirt|tshirt|shirt|hoodie|tank|jogger|pants|product|collection|new|buy)\b/.test(t)) return 'products';
    if (/\b(human|person|agent|someone|call|talk|team|executive|support)\b/.test(t)) return 'person';
    return null;
}

/* ── Tracking ──────────────────────────────────────────────────────────────────────────────── */

function orderStatus(o) {
    const items = (o.items || []).map(i => `${i.title}${i.variant ? ` (${i.variant})` : ''}${i.quantity > 1 ? ` ×${i.quantity}` : ''}`).join(', ');
    const lines_ = [`*Order ${o.order_number}*${items ? `\n${items}` : ''}`];
    if (o.state === 'Cancelled') lines_.push('This order was cancelled.');
    else if (o.state === 'Shipped') {
        lines_.push(`Shipped${o.shipped_at ? ` on ${day(o.shipped_at)}` : ''}${o.dispatch?.courier ? ` with ${o.dispatch.courier}` : ''}.`);
        if (o.dispatch?.awb) lines_.push(`Tracking number: ${o.dispatch.awb}`);
        if (o.dispatch?.tracking_url) lines_.push(`Track it here: ${o.dispatch.tracking_url}`);
    } else if (o.state === 'On hold') lines_.push('It’s on hold for a moment — our team will update you here.');
    else lines_.push('We’re getting it ready — orders ship within 1–3 business days, and you’ll get the tracking link as soon as it leaves.');
    return lines_.join('\n');
}

async function startTrack(c) {
    const data = await shop.customerFor(c);
    const orders = data.orders.slice(0, 9);
    if (!orders.length) {
        await setStep(c, 'track_ask_number', { tries: 0 });
        return say(c, 'I couldn’t find an order on this WhatsApp number. Please type your order number — it looks like #12151 and is in your order confirmation email.');
    }
    if (orders.length === 1) {
        await say(c, orderStatus(orders[0]));
        await setStep(c, 'answered');
        return afterAnswer(c);
    }
    await setStep(c, 'track_pick');
    return menuList(c, 'Which order?', 'Your orders', [
        ...orders.map(o => ({ id: `o:${o.order_number}`, title: cut(o.order_number, 24), description: cut(`${o.state} · ${o.items.map(i => i.title).join(', ')}`, 72) })),
        { id: 'o:other', title: 'Another order', description: 'Type an order number' },
    ], 'Recent orders');
}

async function onTrackNumber(c, text) {
    const data = c.flow_data || {};
    const r = await shop.orderByNumber(c, text);
    if (r.order) { await say(c, orderStatus(r.order)); await setStep(c, 'answered', {}); return afterAnswer(c); }
    if (r.needs_verification) {
        await setStep(c, 'track_verify', { order_number: text, tries: 0 });
        return say(c, 'That order was placed with a different phone number. To keep it private, please type the email address or the delivery pincode on the order.');
    }
    if ((data.tries || 0) >= 1) return handOff(c, 'Order not found', `Customer gave order number "${cut(text, 40)}" twice; not in the CRM.`);
    await setStep(c, 'track_ask_number', { tries: (data.tries || 0) + 1 });
    return say(c, `${r.error || 'I couldn’t find that order.'} Please check the number and type it again.`);
}

async function onTrackVerify(c, text) {
    const data = c.flow_data || {};
    const isEmail = /@/.test(text);
    const r = await shop.orderByNumber(c, data.order_number, isEmail ? { email: text.trim() } : { pincode: text });
    if (r.order) { await say(c, orderStatus(r.order)); await setStep(c, 'answered', {}); return afterAnswer(c); }
    if ((data.tries || 0) >= 1) return handOff(c, 'Couldn’t verify an order', `Order ${data.order_number}: the email/pincode given didn’t match.`);
    await setStep(c, 'track_verify', { ...data, tries: (data.tries || 0) + 1 });
    return say(c, 'That doesn’t match the order. Please try the email address or the 6-digit delivery pincode again.');
}

/* ── Products, photos and size charts ──────────────────────────────────────────────────────── */

const productRows = (list) => list.slice(0, 10).map(p => ({
    id: `p:${p.handle}`, title: cut(p.title, 24),
    description: cut([p.price != null ? `₹${p.price}` : null, p.sold_out ? 'Sold out' : p.sizes_in_stock.length ? `Sizes: ${p.sizes_in_stock.join(' ')}` : null].filter(Boolean).join(' · '), 72),
}));

const caption = (p) => [
    `*${p.title}*`,
    p.price != null ? `₹${p.price}` : null,
    p.sold_out ? 'Sold out right now' : p.sizes_in_stock.length ? `Sizes in stock: ${p.sizes_in_stock.join(', ')}` : null,
    p.url,
].filter(Boolean).join('\n');

async function startProducts(c) {
    const products = await shopify.fetchProducts();
    const types = [...products.reduce((m, p) => m.set(p.product_type || 'Other', (m.get(p.product_type || 'Other') || 0) + 1), new Map())]
        .sort((a, b) => b[1] - a[1]).slice(0, 9);
    await setStep(c, 'products_type', {});
    return menuList(c, 'What are you looking for? Pick a category, or just type a product name.', 'Categories', [
        ...types.map(([t, n]) => ({ id: `t:${t}`, title: cut(t, 24), description: `${n} product${n === 1 ? '' : 's'}` })),
        { id: 't:search', title: 'Search by name', description: 'Type what you’re looking for' },
    ], 'Shop');
}

async function showType(c, type) {
    const products = (await shopify.fetchProducts()).filter(p => (p.product_type || 'Other') === type).map(shop.shapeProduct);
    // In stock first: a list of sold-out tees is not much of a shop window.
    products.sort((a, b) => Number(a.sold_out) - Number(b.sold_out));
    await setStep(c, c.flow_data?.purpose === 'size' ? 'size_pick' : 'products_pick', c.flow_data || {});
    await menuList(c, `${type}: ${products.length} product${products.length === 1 ? '' : 's'}${products.length > 10 ? ' — here are 10. Type a name to find another.' : '.'}`,
        'Products', productRows(products), cut(type, 24));
}

async function searchAndList(c, text, purpose) {
    const found = await shop.searchProducts(text, 10);
    if (!found.length) {
        const misses = (c.flow_data?.misses || 0) + 1;
        if (misses >= 2) return handOff(c, purpose === 'size' ? 'Size help — product not found' : 'Product question', `Customer searched for "${cut(text, 80)}" and nothing matched.`);
        await setStep(c, c.flow_step, { ...(c.flow_data || {}), purpose, misses });
        return say(c, `I couldn’t find “${cut(text, 40)}”. Try another word from the product name, like “AMG”, “hoodie” or “tank”.`);
    }
    if (found.length === 1) return purpose === 'size' ? sendChart(c, found[0].handle) : sendProduct(c, found[0].handle);
    await setStep(c, purpose === 'size' ? 'size_pick' : 'products_pick', { purpose });
    return menuList(c, `Here’s what I found for “${cut(text, 40)}”:`, 'Products', productRows(found), 'Results');
}

async function sendProduct(c, handle) {
    const p = await shop.productByHandle(handle);
    if (!p) return say(c, 'That product isn’t available any more.');
    const shaped = shop.shapeProduct(p);
    if (p.image) await image(c, p.image, caption(shaped));
    else await say(c, caption(shaped));
    await setStep(c, 'answered', { handle });
    return afterAnswer(c, p.size_chart ? 'Want the size chart for it?' : 'Anything else?', p.size_chart ? [{ id: `chart:${handle}`, title: 'Size chart' }] : []);
}

async function sendChart(c, handle) {
    const p = await shop.productByHandle(handle);
    if (!p) return say(c, 'That product isn’t available any more.');
    if (!p.size_chart) return handOff(c, 'Size help — no size chart', `${p.title} has no size chart in Shopify; customer wants sizing help.`,
        `${p.title} doesn’t have a size chart yet, so I’m passing you to our team for the measurements.`);
    const shaped = shop.shapeProduct(p);
    await image(c, p.size_chart, `Size chart — ${shaped.title}${shaped.sizes_in_stock.length ? `\nIn stock: ${shaped.sizes_in_stock.join(', ')}` : ''}\n${shaped.url}`);
    await setStep(c, 'answered', { handle });
    return afterAnswer(c, 'Compare it with a tee that fits you well. Still unsure? Our team can help.');
}

async function startSize(c) {
    await setStep(c, 'size_ask', { purpose: 'size' });
    return say(c, 'Which product do you need the size chart for? Type its name — for example “AMG Petronas” or “Acid Wash Tank”.');
}

/* ── Exchange and refund — the published policy, then a person where one is needed ─────────── */

async function startExchange(c, settings) {
    await link(c, [
        '*Size exchange*',
        '• The item must be unworn and unwashed, with tags and packaging.',
        '• There’s a ₹198 exchange fee.',
        '• Raise it at our Returns & Exchange Center with your order ID and email. Our courier picks the item up from you, and the new size ships once it passes QC.',
        '• Sale items, gift cards and items without tags can’t be exchanged.',
    ].join('\n'), 'Start exchange', settings.menu.exchange_url);
    await setStep(c, 'answered');
    return afterAnswer(c, 'Need anything else?', [{ id: 'size', title: 'Check sizes' }]);
}

async function startRefund(c) {
    await setStep(c, 'refund_reason', {});
    return buttons(c, [
        '*Returns and refunds*',
        'We don’t accept general returns. If your item arrived *damaged, defective or wrong*, tell us within 24 hours of delivery with an unboxing video and we’ll replace or refund it.',
        'For other reasons (size, change of mind), the item comes back at your cost and 50% of the product value is refunded after QC. For a different size, a size exchange is usually better.',
        'What happened?',
    ].join('\n\n'), [
        { id: 'r:damaged', title: 'Damaged or wrong' },
        { id: 'r:other', title: 'Other reason' },
        { id: 'exchange', title: 'Exchange instead' },
    ]);
}

async function startDamaged(c) {
    const data = await shop.customerFor(c);
    const orders = data.orders.slice(0, 9);
    if (orders.length) {
        await setStep(c, 'damaged_pick', {});
        return menuList(c, 'Sorry about that. Which order is it?', 'Your orders', [
            ...orders.map(o => ({ id: `o:${o.order_number}`, title: cut(o.order_number, 24), description: cut(o.items.map(i => i.title).join(', '), 72) })),
            { id: 'o:other', title: 'Another order', description: 'Type an order number' },
        ], 'Recent orders');
    }
    await setStep(c, 'damaged_number', {});
    return say(c, 'Sorry about that. Please type the order number (it looks like #12151).');
}

async function askDamageProof(c, orderNumber) {
    const since = (await db.query(`SELECT COALESCE(MAX(id), 0) AS id FROM wa_messages WHERE conversation_id = $1`, [c.id])).rows[0].id;
    await setStep(c, 'damaged_media', { order_number: orderNumber, since });
    return buttons(c, `Please send clear photos of the problem and your unboxing video for ${orderNumber} here. Tap Done when you’ve sent them.`, [
        { id: 'r:done', title: 'Done' }, PERSON,
    ]);
}

async function damagedDone(c) {
    const data = c.flow_data || {};
    const m = (await db.query(
        `SELECT COUNT(*) FILTER (WHERE media_mime LIKE 'image/%')::int AS photos, COUNT(*) FILTER (WHERE media_mime LIKE 'video/%')::int AS videos
           FROM wa_messages WHERE conversation_id = $1 AND direction = 'in' AND id > $2`, [c.id, data.since || 0])).rows[0];
    if (!m.photos && !m.videos) return buttons(c, 'I haven’t received any photos or video yet. Please send them here, then tap Done.', [{ id: 'r:done', title: 'Done' }, PERSON]);
    return handOff(c, 'Damaged or wrong item',
        `Order ${data.order_number}: ${m.photos} photo${m.photos === 1 ? '' : 's'} and ${m.videos} video${m.videos === 1 ? '' : 's'} received in the chat.${m.videos ? '' : ' No unboxing video yet.'}`,
        'Thank you — I’ve got them.');
}

/* ── Handing over ──────────────────────────────────────────────────────────────────────────── */

async function handOff(c, reason, summary, lead = null) {
    if (lead) await say(c, lead);
    await setStep(c, null, {});
    await db.query('UPDATE wa_conversations SET nl_handoff_at = CURRENT_TIMESTAMP WHERE id = $1', [c.id]);
    return handover.handOver(c, { reason, summary });
}

/* ── One customer message ──────────────────────────────────────────────────────────────────── */

/** Do what a menu choice asks. */
async function choose(c, settings, key) {
    if (key === 'menu') return showMenu(c, settings, 'Sure — what can we help with?');
    if (key === 'track') return startTrack(c);
    if (key === 'size') return startSize(c);
    if (key === 'products') return startProducts(c);
    if (key === 'exchange') return startExchange(c, settings);
    if (key === 'refund') return startRefund(c);
    if (key === 'person') return handOff(c, 'Customer asked for a person', `Asked from the menu (last step: ${c.flow_step || 'menu'}).`);
    return null;
}

async function handle(conversationId) {
    const line = lines.current();
    const c = (await db.query(
        `SELECT c.*, k.phone, k.profile_name, k.customer_id,
                NULLIF(TRIM(CONCAT(cu.first_name, ' ', cu.last_name)), '') AS customer_name
           FROM wa_conversations c JOIN wa_contacts k ON k.id = c.contact_id LEFT JOIN customers cu ON cu.id = k.customer_id
          WHERE c.id = $1 AND c.line_id = $2`, [conversationId, line.id])).rows[0];
    if (!c || c.mode !== 'flow' || c.status !== 'open' || !wa.windowOpen(c.last_inbound_at)) return;
    c.flow_data = safeJson(c.flow_data, {});
    const settings = await readSettings(line.id);

    const last = (await db.query(
        `SELECT body, interactive_payload, media_mime FROM wa_messages
          WHERE conversation_id = $1 AND direction = 'in' ORDER BY id DESC LIMIT 1`, [c.id])).rows[0];
    if (!last) return;
    const tap = safeJson(last.interactive_payload, null)?.id || null;
    const text = String(last.body || '').trim();

    // Photos and videos while proof is being collected are just collected.
    if (c.flow_step === 'damaged_media' && last.media_mime && !tap) return;

    // A tap on a menu option, or the words that bring the menu back, work from anywhere.
    if (tap && await choose(c, settings, tap) !== null) return;
    if (!tap && /^(hi|hii+|hello|hey|menu|start|main menu|options)\W*$/i.test(text)) return showMenu(c, settings);
    // A new chat: if the first message already says what they want, go straight there.
    if (!c.flow_step) {
        const first = guess(text);
        return first && first !== 'products' ? choose(c, settings, first) : showMenu(c, settings);
    }

    switch (c.flow_step) {
        case 'track_pick':
            if (tap === 'o:other') { await setStep(c, 'track_ask_number', { tries: 0 }); return say(c, 'Please type the order number (it looks like #12151).'); }
            if (tap?.startsWith('o:')) return onTrackNumber(c, tap.slice(2));
            return onTrackNumber(c, text);
        case 'track_ask_number': return onTrackNumber(c, text);
        case 'track_verify': return onTrackVerify(c, text);

        case 'products_type':
            if (tap === 't:search') { await setStep(c, 'products_search', {}); return say(c, 'Type the product name or what you’re looking for.'); }
            if (tap?.startsWith('t:')) return showType(c, tap.slice(2));
            return searchAndList(c, text, 'products');
        case 'products_search': return searchAndList(c, text, 'products');
        case 'products_pick':
            if (tap?.startsWith('p:')) return sendProduct(c, tap.slice(2));
            return searchAndList(c, text, 'products');

        case 'size_ask': return searchAndList(c, text, 'size');
        case 'size_pick':
            if (tap?.startsWith('p:')) return sendChart(c, tap.slice(2));
            return searchAndList(c, text, 'size');

        case 'refund_reason':
            if (tap === 'r:damaged') return startDamaged(c);
            if (tap === 'r:other') return handOff(c, 'Refund request', 'Customer wants a refund for a reason other than damage (size, change of mind).',
                'I’m passing this to our team — they’ll take you through the return.');
            break;
        case 'damaged_pick':
            if (tap === 'o:other') { await setStep(c, 'damaged_number', {}); return say(c, 'Please type the order number (it looks like #12151).'); }
            if (tap?.startsWith('o:')) return askDamageProof(c, tap.slice(2));
            return askDamageProof(c, cut(text, 30));
        case 'damaged_number': return askDamageProof(c, cut(text, 30));
        case 'damaged_media':
            if (tap === 'r:done' || /^done\b/i.test(text)) return damagedDone(c);
            return buttons(c, 'Send the photos and unboxing video here, then tap Done.', [{ id: 'r:done', title: 'Done' }, PERSON]);

        case 'answered':
            if (tap?.startsWith('chart:')) return sendChart(c, tap.slice(6));
            break;
        default: break;
    }

    if (tap?.startsWith('chart:')) return sendChart(c, tap.slice(6));

    // Typed words that don't fit the step: try to tell what they want, else show the menu once,
    // and give it to a person the second time.
    const intent = guess(text);
    if (intent === 'products' && text.split(/\s+/).length <= 6) return searchAndList(c, text, 'products');
    if (intent) return choose(c, settings, intent);
    const misses = (c.flow_data?.misses || 0) + 1;
    if (misses >= 2) return handOff(c, 'The menu couldn’t answer', `Customer wrote: "${cut(text, 200)}"`);
    await setStep(c, 'menu', { misses });
    return showMenu(c, settings, 'Sorry, I didn’t get that. Please choose an option below — or tap “Talk to our team”.');
}

/** Start the menu on a chat that has just been handed to it. */
async function start(c, settings) {
    await db.query(`UPDATE wa_conversations SET mode = 'flow', flow_step = NULL, flow_data = '{}' WHERE id = $1`, [c.id]);
    return showMenu({ ...c, flow_data: {} }, settings);
}

module.exports = { handle, start, guess, orderStatus };
