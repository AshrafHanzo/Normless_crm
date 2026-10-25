/**
 * Normless's automatic WhatsApp messages: abandoned carts, new orders, COD confirmation, shipping,
 * cancellations and refunds — what the old third-party provider sent, sent from the CRM instead.
 *
 * Where events come from:
 *   - Abandoned carts: Razorpay Magic Checkout posts each one to our webhook (routes/nl-razorpay).
 *     They wait here and up to three reminders go out at the delays a manager set, stopping the
 *     moment the customer places an order.
 *   - Orders, shipments, cancellations, refunds: Shopify, read every few minutes (the CRM's
 *     Shopify app can read orders, not subscribe to them). Only what happens after this was first
 *     switched on is ever messaged — turning it on never sends to last month's customers.
 *
 * Every send is one row in nl_auto_sends keyed by (event, order/cart/shipment), written before the
 * message goes, so a restart or an overlapping poll can never send the same message twice.
 *
 * COD confirmation: the customer taps Confirm or Cancel on the template. The answer is written on
 * the send and in the chat; a cancel is handed to the team to cancel in Shopify (the CRM can't).
 */

const crypto = require('crypto');
const db = require('../db/connection');
const wa = require('./whatsapp');
const lines = require('./wa-line');
const shopify = require('./shopify');
const links = require('./nl-links');
const set = require('./nl-template-set');
const { last10, STORE } = require('./nl-shop');

const DEMO_PHONE = '910000000000';
const safeJson = (v, fallback = null) => { try { return typeof v === 'string' ? (JSON.parse(v || 'null') ?? fallback) : (v ?? fallback); } catch { return fallback; } };

/** The events, grouped the way the settings page shows them. Delays are minutes. */
const EVENTS = [
    { key: 'cart_1', group: 'cart', label: 'Abandoned cart 1', hint: 'The first reminder after a checkout is left.', delay: 30, links: ['checkout', 'store'] },
    { key: 'cart_2', group: 'cart', label: 'Abandoned cart 2', hint: 'If they still haven’t ordered.', delay: 6 * 60, links: ['checkout', 'store'] },
    { key: 'cart_3', group: 'cart', label: 'Abandoned cart 3', hint: 'The last nudge — usually with a coupon.', delay: 24 * 60, links: ['checkout', 'store'] },
    { key: 'order_prepaid', group: 'order', label: 'New prepaid order', hint: 'Paid online in full.', links: ['order', 'store'] },
    { key: 'order_partial_cod', group: 'order', label: 'New partial COD order', hint: 'An advance paid, the rest on delivery.', links: ['order', 'store'] },
    { key: 'order_cod', group: 'order', label: 'New COD order', hint: 'Nothing paid yet. Use this or COD confirmation, not usually both.', links: ['order', 'store'] },
    { key: 'order_cancelled', group: 'order', label: 'Order cancelled', hint: 'When an order is cancelled in Shopify.', links: ['store', 'order'] },
    { key: 'cod_confirm', group: 'cod', label: 'COD confirmation', hint: 'Asks a COD customer to confirm or cancel before it ships.', links: ['order', 'store'] },
    { key: 'fulfilled', group: 'fulfillment', label: 'Shipped with tracking', hint: 'When an order is fulfilled with a tracking number.', links: ['tracking', 'order', 'store'] },
    { key: 'refund', group: 'payment', label: 'Refund issued', hint: 'When a refund is made in Shopify.', links: ['order', 'store'] },
];
const EVENT = Object.fromEntries(EVENTS.map(e => [e.key, e]));

/** Carts are only reminded in the daytime (India): a 2 am marketing message loses customers. */
const CART_HOURS = { start: 9, end: 21 };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/* ── Settings ─────────────────────────────────────────────────────────────────────────────── */

const blankEvent = (e) => {
    const t = set.byEvent(e.key);
    return { enabled: false, template: null, vars: t ? [...t.vars] : [], link: t?.link?.source || e.links[0], delay: e.delay ?? 0, coupon: '' };
};

/** The automations as saved on the line, over the blanks. Makes the webhook secret the first time. */
async function config(lineId) {
    const row = (await db.query('SELECT settings FROM wa_lines WHERE id = $1', [lineId])).rows[0];
    const saved = safeJson(row?.settings, {})?.automations || {};
    // A UUID, sent as ?api_key=: Razorpay's dashboard refused the earlier base64 secret in the
    // path as an invalid URL, and accepts addresses of this shape.
    const secret = saved.webhook_secret;
    if (!UUID.test(secret || '')) {
        const fresh = crypto.randomUUID();
        await saveRaw(lineId, (a) => ({ ...a, webhook_secret: UUID.test(a.webhook_secret || '') ? a.webhook_secret : fresh }));
        return config(lineId);
    }
    const events = Object.fromEntries(EVENTS.map(e => [e.key, { ...blankEvent(e), ...(saved.events?.[e.key] || {}) }]));
    return { webhook_secret: secret, started_at: saved.started_at || null, events };
}

async function saveRaw(lineId, change) {
    await db.transaction(async (c) => {
        const row = (await c.query('SELECT settings FROM wa_lines WHERE id = $1 FOR UPDATE', [lineId])).rows[0];
        const all = safeJson(row?.settings, {}) || {};
        all.automations = change(all.automations || {});
        await c.query('UPDATE wa_lines SET settings = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [lineId, JSON.stringify(all)]);
    });
}

const SOURCE_KEYS = Object.keys(set.SOURCES);
/** One event's settings, cleaned. */
function cleanEvent(e, v) {
    return {
        enabled: !!v?.enabled,
        template: typeof v?.template === 'string' && /^[a-z0-9_]{1,512}\|[A-Za-z_]{2,10}$/.test(v.template) ? v.template : null,
        vars: (Array.isArray(v?.vars) ? v.vars : []).slice(0, 10).map(x => (SOURCE_KEYS.includes(x) ? x : null)),
        link: e.links.includes(v?.link) ? v.link : e.links[0],
        delay: e.group === 'cart' ? Math.min(7 * 24 * 60, Math.max(5, Math.round(Number(v?.delay) || e.delay))) : 0,
        coupon: String(v?.coupon || '').trim().slice(0, 40),
    };
}

/** Save what the page sent for some events. Switching anything on for the first time starts the clock. */
async function saveEvents(lineId, incoming) {
    await saveRaw(lineId, (a) => {
        const events = { ...(a.events || {}) };
        for (const e of EVENTS) if (incoming?.[e.key]) events[e.key] = cleanEvent(e, incoming[e.key]);
        const anyOn = Object.values(events).some(x => x.enabled);
        return { ...a, events, started_at: a.started_at || (anyOn ? new Date().toISOString() : null) };
    });
    return config(lineId);
}

/* ── Filling a template ───────────────────────────────────────────────────────────────────── */

const money = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n.toLocaleString('en-IN', { maximumFractionDigits: n % 1 ? 2 : 0 }) : '';
};
const firstNameOf = (...names) => {
    for (const n of names) {
        const f = String(n || '').trim().split(/\s+/)[0];
        if (f) return f.charAt(0).toUpperCase() + f.slice(1);
    }
    return 'there';
};
const itemLine = (items) => {
    const text = items.map(i => `${i.title}${i.variant ? ` (${i.variant})` : ''} × ${i.quantity}`).join(', ');
    return text.length > 300 ? `${text.slice(0, 297)}…` : text;
};
const rupees = (v) => { const m = money(v); return m ? `₹${m}` : ''; };
const addressLine = (a) => [a.address1, a.address2, a.city, a.province, a.zip].map(x => String(x || '').trim()).filter(Boolean).join(', ');
const STORE_NAME = 'Normless';
const productName = (items) => (items[0] ? `${items[0].title}${items.length > 1 ? ` and ${items.length - 1} more` : ''}` : 'your items');

/** A photo for the header: the product's own, else any product's, so a photo template still sends. */
async function productImage(items) {
    const withImage = items.find(i => i.image);
    if (withImage) return withImage.image;
    try {
        const products = await shopify.fetchProducts();
        for (const i of items) {
            const p = products.find(x => String(x.id) === String(i.product_id));
            const v = p?.variants.find(x => String(x.id) === String(i.variant_id));
            if (v?.image || p?.image) return v?.image || p.image;
        }
        return products.find(p => p.image)?.image || null;
    } catch { return null; }
}

/** The facts one event is about, in the shape the sources read. */
function orderFacts(o) {
    const items = (o.line_items || []).filter(li => (li.current_quantity ?? li.quantity) > 0).map(li => ({
        title: li.title, variant: li.variant_title && li.variant_title !== 'Default Title' ? li.variant_title : '',
        quantity: li.current_quantity ?? li.quantity, product_id: li.product_id, variant_id: li.variant_id, image: null,
    }));
    const a = o.shipping_address || o.billing_address || {};
    return {
        phone: wa.normalisePhone(o.phone || a.phone || o.billing_address?.phone || o.customer?.phone),
        name: [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(' ') || a.name || null,
        first_name: firstNameOf(o.customer?.first_name, a.first_name, o.billing_address?.first_name),
        order_number: o.name, order_total: money(o.total_price), order_total_inr: rupees(o.total_price),
        cod_amount: money(o.total_outstanding ?? o.total_price), cod_amount_inr: rupees(o.total_outstanding ?? o.total_price),
        address: addressLine(a), store_name: STORE_NAME, currency: o.currency || 'INR', refund_note: 'Refund',
        items: itemLine(items), product_name: productName(items), itemList: items,
        urls: { order: o.order_status_url || STORE, store: STORE },
    };
}

/** An object's keys in lower case, one level deep. */
const lower = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).map(([k, v]) => [k.toLowerCase(), v]));

/** Razorpay's prices: rupees, or paise when they are a hundred times Shopify's. */
async function cartItems(payload) {
    let products = [];
    try { products = await shopify.fetchProducts(); } catch { /* prices stay as sent */ }
    const raw = (payload.line_items || []).map(li => ({
        title: li.title || li.name || 'Item', variant: li.variant_title && li.variant_title !== 'Default Title' ? li.variant_title : '',
        quantity: Number(li.quantity) || 1, price: Number(li.price ?? li.variant_price) || 0,
        product_id: li.product_id, variant_id: li.variant_id, image: li.image_url || null,
    }));
    // Shopify's own price settles it when the variant is found; otherwise whole-number prices
    // are taken as paise, which is how Razorpay writes amounts.
    const variants = products.flatMap(p => p.variants);
    const known = raw.map(i => ({ i, v: variants.find(x => String(x.id) === String(i.variant_id)) })).filter(x => x.v?.price && x.i.price);
    const paise = known.length
        ? known.some(({ i, v }) => Math.abs(i.price / 100 - Number(v.price)) < 1)
        : (payload.line_items || []).every(li => Number.isInteger(li.price ?? li.variant_price) && (li.price ?? li.variant_price) >= 100);
    return { items: raw.map(i => ({ ...i, price: paise ? i.price / 100 : i.price })), paise };
}

function cartFacts(cart) {
    const items = safeJson(cart.items, []);
    const ship = lower(lower(safeJson(cart.payload, {}).customer).shipping_address);
    return {
        phone: cart.phone, name: cart.name, first_name: firstNameOf(cart.name),
        store_name: STORE_NAME, currency: cart.currency || 'INR', address: addressLine(ship),
        cart_total_inr: rupees(cart.total), order_total_inr: rupees(cart.total),
        product_name: productName(items), items: itemLine(items), itemList: items,
        cart_total: money(cart.total), order_total: money(cart.total),
        urls: { checkout: cart.checkout_url || STORE, store: STORE },
    };
}

/** The approved template an event is set to use, with what its parts need. */
async function templateFor(lineId, key) {
    if (!key) return null;
    const [name, language] = key.split('|');
    const t = (await db.query(
        `SELECT name, language, category, status, body_text, variables, components FROM wa_templates WHERE line_id = $1 AND name = $2 AND language = $3`,
        [lineId, name, language])).rows[0];
    if (!t) return null;
    const comps = safeJson(t.components, []);
    const header = comps.find(c => c.type === 'HEADER');
    const buttons = comps.find(c => c.type === 'BUTTONS')?.buttons || [];
    return { ...t, header, buttons };
}

/**
 * Send one event's template, once. `ref` is what makes it unique (the order, cart or shipment);
 * `facts` fill its gaps. Returns the send row, or null when it was already sent or isn't set up.
 */
async function fire(lineId, eventKey, ref, facts, { label = null } = {}) {
    const cfg = (await config(lineId)).events[eventKey];
    if (!cfg?.enabled || !cfg.template) return null;
    if (!facts.phone || facts.phone === DEMO_PHONE) return null;

    const claim = (await db.query(
        `INSERT INTO nl_auto_sends (line_id, event, ref, label, phone, template) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (line_id, event, ref) DO NOTHING RETURNING id`,
        [lineId, eventKey, String(ref), label, facts.phone, cfg.template])).rows[0];
    if (!claim) return null;
    const fail = async (error) => {
        await db.query(`UPDATE nl_auto_sends SET status = 'failed', error = $2 WHERE id = $1`, [claim.id, String(error).slice(0, 500)]);
        return { id: claim.id, status: 'failed', error };
    };

    try {
        const t = await templateFor(lineId, cfg.template);
        if (!t) return await fail(`The template ${cfg.template.split('|')[0]} isn’t on this account — sync templates`);
        if (t.status !== 'APPROVED') return await fail(`The template ${t.name} is ${String(t.status).toLowerCase()} at Meta`);
        // Someone who replied STOP gets order updates, never offers or reminders.
        if (t.category === 'MARKETING') {
            const out = (await db.query(`SELECT opted_out_at FROM wa_contacts WHERE line_id = $1 AND phone = $2`, [lineId, facts.phone])).rows[0];
            if (out?.opted_out_at) {
                await db.query(`UPDATE nl_auto_sends SET status = 'skipped', error = 'The customer replied STOP' WHERE id = $1`, [claim.id]);
                return { id: claim.id, status: 'skipped' };
            }
        }

        const value = (source) => (source === 'coupon' ? cfg.coupon : facts[source]) ?? '';
        const variables = Array.from({ length: t.variables || 0 }, (_, i) => value(cfg.vars[i]));
        const gap = variables.findIndex(v => !String(v).trim());
        if (gap >= 0) return await fail(`Nothing to put in {{${gap + 1}}} (${cfg.vars[gap] ? set.SOURCES[cfg.vars[gap]]?.label : 'not set'})`);

        let headerImage = null;
        if (t.header?.format === 'IMAGE') {
            headerImage = await productImage(facts.itemList || []);
            if (!headerImage) return await fail('The template has a photo header and no product photo was found');
        }
        const headerText = t.header?.format === 'TEXT' && /\{\{1\}\}/.test(t.header.text || '') ? facts.first_name : null;

        // Link buttons: ours take a short code; anything else (an old provider's redirector) takes
        // the whole address, as that is what it was built for.
        const buttons = [];
        const dest = facts.urls?.[cfg.link] || facts.urls?.store || STORE;
        for (const [index, b] of t.buttons.entries()) {
            if (b.type === 'URL' && /\{\{1\}\}/.test(b.url || '')) {
                const ours = String(b.url).startsWith(links.BUTTON_BASE());
                buttons.push({ index, text: ours ? await links.shorten(dest, { kind: eventKey, ref }) : dest });
            } else if (b.type === 'COPY_CODE') {
                if (!cfg.coupon) return await fail('The template has a “Copy offer code” button — set a coupon code');
                buttons.push({ index, coupon: cfg.coupon });
            } else if (b.type === 'QUICK_REPLY') {
                buttons.push({ index, payload: `nlauto:${claim.id}:${index}` });
            }
        }

        const conv = await threadFor(lineId, facts);
        const wamid = await lines.run('normless', () => wa.sendTemplate(facts.phone, {
            name: t.name, language: t.language, variables, headerImage, headerText, buttons,
        }));
        const body = wa.renderTemplate(t.body_text, variables);
        await db.query(
            `INSERT INTO wa_messages (conversation_id, wamid, direction, sender_type, type, body, media_url, media_mime, status)
             VALUES ($1,$2,'out','auto','template',$3,$4,$5,'sent')`,
            [conv.id, wamid, body, headerImage, headerImage ? 'image/jpeg' : null]);
        await db.query(
            `UPDATE wa_conversations SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [conv.id, body.slice(0, 200)]);
        await db.query(
            `INSERT INTO wa_activity (conversation_id, kind, body) VALUES ($1,'automation',$2)`,
            [conv.id, `Sent “${EVENT[eventKey].label}”${label ? ` for ${label}` : ''} (${t.name})`]);
        await db.query(`UPDATE nl_auto_sends SET status = 'sent', wamid = $2, conversation_id = $3 WHERE id = $1`, [claim.id, wamid, conv.id]);
        return { id: claim.id, status: 'sent', wamid };
    } catch (err) {
        console.error(`normless automation ${eventKey} ${ref}:`, err.message);
        return fail(err.message);
    }
}

/** The customer's chat on Normless's line, made if they have never written. */
async function threadFor(lineId, facts) {
    return db.transaction(async (c) => {
        const contact = (await c.query(
            `INSERT INTO wa_contacts (line_id, phone, profile_name) VALUES ($1,$2,$3)
             ON CONFLICT (line_id, phone) DO UPDATE SET profile_name = COALESCE(wa_contacts.profile_name, EXCLUDED.profile_name)
             RETURNING id`, [lineId, facts.phone, facts.name || null])).rows[0];
        return (await c.query(
            `INSERT INTO wa_conversations (contact_id, line_id, last_message_at) VALUES ($1,$2,CURRENT_TIMESTAMP)
             ON CONFLICT (contact_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP RETURNING id`,
            [contact.id, lineId])).rows[0];
    });
}

/* ── Abandoned carts (Razorpay) ───────────────────────────────────────────────────────────── */

/** Razorpay sent a checkout someone left. Kept (or refreshed, if it sent the same cart again). */
async function onAbandoned(lineId, payload) {
    const token = String(payload?.cart_token || payload?.token || payload?.id || '').slice(0, 200);
    if (!token) return { ok: false, reason: 'no cart token' };
    // Razorpay capitalises the address's keys (Shipping_address.Phone, First_name), so every
    // field is read without regard to case.
    const c = lower(payload.customer);
    const ship = lower(c.shipping_address);
    const real = (v) => (v && !/^<.*>$/.test(String(v)) ? String(v).trim() : null);   // the docs' "<email>"
    const phone = wa.normalisePhone(real(payload.phone) || real(c.phone) || real(ship.phone));
    const name = [real(c.first_name), real(c.last_name)].filter(Boolean).join(' ')
        || [real(ship.first_name), real(ship.last_name)].filter(Boolean).join(' ') || real(ship.name) || null;
    const email = (real(payload.email) || real(c.email) || '').toLowerCase() || null;
    const { items } = await cartItems(payload);
    const total = items.reduce((n, i) => n + i.price * i.quantity, 0);
    const url = /^https:\/\//.test(payload.abandoned_checkout_url || '') ? payload.abandoned_checkout_url : null;
    const r = await db.query(
        `INSERT INTO nl_carts (line_id, token, phone, email, name, checkout_url, items, total, currency, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (line_id, token) DO UPDATE SET phone = COALESCE(EXCLUDED.phone, nl_carts.phone),
             email = COALESCE(EXCLUDED.email, nl_carts.email), name = COALESCE(EXCLUDED.name, nl_carts.name),
             checkout_url = COALESCE(EXCLUDED.checkout_url, nl_carts.checkout_url), items = EXCLUDED.items,
             total = EXCLUDED.total, payload = EXCLUDED.payload, updated_at = CURRENT_TIMESTAMP
         RETURNING id, (xmax = 0) AS fresh`,
        [lineId, token, phone, email, name, url,
            JSON.stringify(items), total || null, payload.currency || 'INR', JSON.stringify(payload).slice(0, 20000)]);
    return { ok: true, id: r.rows[0].id, fresh: r.rows[0].fresh };
}

const istHour = (d = new Date()) => Number(new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).getHours());

/** Orders placed by anyone with these phones or emails since `since`, as Shopify has them now. */
async function ordersSince(since) {
    const orders = [];
    let url = `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2026-04/orders.json?status=any&limit=250`
        + `&created_at_min=${encodeURIComponent(new Date(since).toISOString())}&fields=id,name,created_at,phone,email,customer,shipping_address,billing_address`;
    for (let page = 0; url && page < 10; page++) {
        const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN } });
        if (!res.ok) throw new Error(`Shopify ${res.status}`);
        orders.push(...((await res.json()).orders || []));
        url = (res.headers.get('Link') || '').match(/<([^>]+)>;\s*rel="next"/)?.[1] || null;
    }
    return orders;
}

/** Mark carts whose customer has since ordered. */
async function recoverCarts(lineId, orders) {
    let n = 0;
    for (const o of orders) {
        const phones = [o.phone, o.shipping_address?.phone, o.billing_address?.phone, o.customer?.phone].map(last10).filter(p => p.length === 10);
        const email = String(o.email || o.customer?.email || '').toLowerCase() || null;
        if (!phones.length && !email) continue;
        const r = await db.query(
            `UPDATE nl_carts SET recovered_at = CURRENT_TIMESTAMP, order_name = $4
              WHERE line_id = $1 AND recovered_at IS NULL AND created_at <= $5::timestamptz + INTERVAL '5 minutes'
                AND created_at > $5::timestamptz - INTERVAL '8 days'
                AND (RIGHT(REGEXP_REPLACE(COALESCE(phone,''), '\\D', '', 'g'), 10) = ANY($2) OR (email IS NOT NULL AND email = $3))`,
            [lineId, phones, email, o.name, o.created_at]);
        n += r.rowCount;
    }
    return n;
}

/** Once a minute: the reminders that are due, unless the customer has ordered since. */
async function cartTick(lineId, now = new Date()) {
    const cfg = await config(lineId);
    const steps = ['cart_1', 'cart_2', 'cart_3'].filter(k => cfg.events[k].enabled && cfg.events[k].template);
    if (!steps.length) return { sent: 0 };
    const hour = istHour(now);
    if (hour < CART_HOURS.start || hour >= CART_HOURS.end) return { sent: 0, quiet: true };

    const carts = (await db.query(
        `SELECT * FROM nl_carts WHERE line_id = $1 AND recovered_at IS NULL AND phone IS NOT NULL
            AND created_at > $2::timestamptz - INTERVAL '8 days' ORDER BY created_at`, [lineId, now])).rows;
    if (!carts.length) return { sent: 0 };
    const done = new Set((await db.query(
        `SELECT event || ':' || ref AS k FROM nl_auto_sends WHERE line_id = $1 AND event LIKE 'cart_%' AND ref = ANY($2)`,
        [lineId, carts.map(c => c.token)])).rows.map(r => r.k));

    // One reminder per cart per tick: the earliest one that is due and not yet sent.
    const due = [];
    for (const cart of carts) {
        const step = steps.find(k => !done.has(`${k}:${cart.token}`));
        if (step && now - new Date(cart.created_at) >= cfg.events[step].delay * 60000) due.push({ cart, step });
    }
    if (!due.length) return { sent: 0 };

    // Has any of them ordered since? Asked of Shopify now, not left to the next order poll.
    try {
        const since = Math.min(...due.map(d => new Date(d.cart.created_at).getTime()));
        await recoverCarts(lineId, await ordersSince(since));
    } catch (err) {
        console.error('normless cart check:', err.message);
        return { sent: 0, error: err.message };           // never remind someone who may have bought
    }
    const still = new Set((await db.query(
        `SELECT id FROM nl_carts WHERE id = ANY($1) AND recovered_at IS NULL`, [due.map(d => d.cart.id)])).rows.map(r => r.id));

    let sent = 0;
    for (const { cart, step } of due) {
        if (!still.has(cart.id)) continue;
        const out = await fire(lineId, step, cart.token, cartFacts(cart), { label: cart.name || cart.phone });
        if (out?.status === 'sent') sent++;
    }
    return { sent };
}

/* ── Orders (Shopify) ─────────────────────────────────────────────────────────────────────── */

const ORDER_FIELDS = 'id,name,created_at,updated_at,cancelled_at,financial_status,total_price,total_outstanding,currency,'
    + 'customer,phone,email,shipping_address,billing_address,line_items,fulfillments,refunds,order_status_url,payment_gateway_names';

async function state(lineId, key, value) {
    if (value === undefined) {
        return (await db.query('SELECT value FROM nl_auto_state WHERE line_id = $1 AND key = $2', [lineId, key])).rows[0]?.value ?? null;
    }
    await db.query(
        `INSERT INTO nl_auto_state (line_id, key, value) VALUES ($1,$2,$3) ON CONFLICT (line_id, key) DO UPDATE SET value = EXCLUDED.value`,
        [lineId, key, value]);
}

const isCod = (o) => (o.payment_gateway_names || []).some(g => /cod|cash/i.test(g));

/** What one order's events are, given when automations started. */
function orderEvents(o, startedAt) {
    const after = (t) => t && new Date(t) >= startedAt;
    const out = [];
    const facts = orderFacts(o);
    if (after(o.created_at) && !o.cancelled_at) {
        const fs = String(o.financial_status || '').toLowerCase();
        if (fs === 'partially_paid') out.push(['order_partial_cod', o.id]);
        else if (fs === 'pending' || (isCod(o) && fs !== 'paid')) { out.push(['order_cod', o.id]); out.push(['cod_confirm', o.id]); }
        else if (fs === 'paid' || fs === 'authorized') out.push(['order_prepaid', o.id]);
    }
    if (after(o.cancelled_at)) out.push(['order_cancelled', o.id]);
    for (const f of o.fulfillments || []) {
        if (!after(f.created_at) || !f.tracking_number || f.status === 'cancelled') continue;
        const trackUrl = f.tracking_url || f.tracking_urls?.[0]
            || `https://www.delhivery.com/track-v2/package/${encodeURIComponent(f.tracking_number)}`;
        out.push(['fulfilled', f.id, { courier: f.tracking_company || 'our courier', tracking_number: f.tracking_number, urls: { ...facts.urls, tracking: trackUrl } }]);
    }
    for (const r of o.refunds || []) {
        if (!after(r.created_at)) continue;
        const amount = (r.transactions || []).filter(t => t.kind === 'refund' && t.status === 'success').reduce((n, t) => n + Number(t.amount || 0), 0);
        if (amount > 0) out.push(['refund', r.id, { refund_amount: money(amount), refund_amount_inr: rupees(amount), refund_note: r.note || 'Refund' }]);
    }
    return out.map(([event, ref, extra]) => ({ event, ref, facts: { ...facts, ...(extra || {}) } }));
}

/** Every few minutes: orders Shopify changed since the last look. */
async function orderTick(lineId) {
    const cfg = await config(lineId);
    const anyOrderEvent = EVENTS.some(e => e.group !== 'cart' && cfg.events[e.key].enabled);
    const anyCart = ['cart_1', 'cart_2', 'cart_3'].some(k => cfg.events[k].enabled);
    if (!cfg.started_at || (!anyOrderEvent && !anyCart)) return { orders: 0 };
    const startedAt = new Date(cfg.started_at);

    const since = (await state(lineId, 'orders_since')) || cfg.started_at;
    const orders = [];
    let url = `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2026-04/orders.json?status=any&limit=250&order=updated_at+asc`
        + `&updated_at_min=${encodeURIComponent(since)}&fields=${ORDER_FIELDS}`;
    for (let page = 0; url && page < 20; page++) {
        const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN } });
        if (!res.ok) throw new Error(`Shopify ${res.status}: ${(await res.text()).slice(0, 200)}`);
        orders.push(...((await res.json()).orders || []));
        url = (res.headers.get('Link') || '').match(/<([^>]+)>;\s*rel="next"/)?.[1] || null;
    }

    await recoverCarts(lineId, orders.filter(o => new Date(o.created_at) >= new Date(new Date(since).getTime() - 3600000)));
    let sent = 0;
    for (const o of orders) {
        for (const ev of orderEvents(o, startedAt)) {
            if (!cfg.events[ev.event].enabled) continue;
            const out = await fire(lineId, ev.event, ev.ref, ev.facts, { label: o.name });
            if (out?.status === 'sent') sent++;
        }
    }
    // The next look starts from the newest change seen (re-reading it is harmless: sends are once).
    const newest = orders.reduce((m, o) => (o.updated_at > m ? o.updated_at : m), since);
    await state(lineId, 'orders_since', newest);
    return { orders: orders.length, sent };
}

/* ── COD replies ──────────────────────────────────────────────────────────────────────────── */

/**
 * A tap on a template's quick reply. Handles the COD confirmation's Confirm and Cancel; anything
 * else is left to the bot (returns false).
 */
async function onReply(conversationId, payload) {
    const m = String(payload?.id || '').match(/^nlauto:(\d+):(\d+)$/);
    if (payload?.kind !== 'template_button' || !m) return false;
    const line = lines.current();
    const send = (await db.query(`SELECT * FROM nl_auto_sends WHERE id = $1 AND line_id = $2`, [m[1], line.id])).rows[0];
    if (!send || send.event !== 'cod_confirm') return false;

    const cancel = /cancel|no\b/i.test(payload.title || '');
    const conv = (await db.query(
        `SELECT c.*, k.phone, k.profile_name FROM wa_conversations c JOIN wa_contacts k ON k.id = c.contact_id WHERE c.id = $1`,
        [conversationId])).rows[0];
    const order = send.label || 'your order';
    if (send.reply) {
        // Tapped again: say what we already have, don't act twice.
        const { tell } = require('./nl-handover');
        await tell(conv, send.reply === 'confirmed' ? `Order ${order} is already confirmed — thank you!` : `We already have your cancellation request for ${order}; our team is on it.`);
        return true;
    }
    await db.query(`UPDATE nl_auto_sends SET reply = $2, replied_at = CURRENT_TIMESTAMP WHERE id = $1`, [send.id, cancel ? 'cancel_requested' : 'confirmed']);
    const { tell, handOver } = require('./nl-handover');
    if (!cancel) {
        await tell(conv, `Thank you! Order ${order} is confirmed — we’ll ship it soon and send the tracking here.`);
        await db.query(`INSERT INTO wa_activity (conversation_id, kind, body) VALUES ($1,'automation',$2)`, [conv.id, `Customer confirmed COD order ${order}`]);
        return true;
    }
    await tell(conv, `Okay — we’ve asked our team to cancel order ${order}. They’ll confirm here shortly.`);
    await handOver(conv, { reason: `COD order ${order}: the customer tapped Cancel. Cancel it in Shopify, then let them know here.` });
    return true;
}

/**
 * STOP / START. Every marketing template's footer says "To opt-out, type STOP", so it has to
 * work: the customer stops getting cart reminders and offers (order updates still go).
 */
async function onText(conversationId, text) {
    const word = String(text || '').trim().toUpperCase();
    if (!['STOP', 'UNSUBSCRIBE', 'START'].includes(word)) return false;
    const stop = word !== 'START';
    const conv = (await db.query(
        `SELECT c.*, k.phone, k.profile_name FROM wa_conversations c JOIN wa_contacts k ON k.id = c.contact_id WHERE c.id = $1`,
        [conversationId])).rows[0];
    if (!conv) return false;
    await db.query(`UPDATE wa_contacts SET opted_out_at = ${stop ? 'CURRENT_TIMESTAMP' : 'NULL'} WHERE id = $1`, [conv.contact_id]);
    await db.query(`INSERT INTO wa_activity (conversation_id, kind, body) VALUES ($1,'automation',$2)`,
        [conv.id, stop ? 'Customer opted out of offers and reminders (STOP)' : 'Customer opted back in (START)']);
    const { tell } = require('./nl-handover');
    await tell(conv, stop
        ? 'You won’t get offers or cart reminders from Normless any more. You’ll still get updates about your orders. Reply START to opt back in.'
        : 'Welcome back! You’ll get offers and reminders from Normless again. Reply STOP any time to opt out.');
    return true;
}

/* ── For the settings page ────────────────────────────────────────────────────────────────── */

async function recent(lineId, { group = null, limit = 30 } = {}) {
    const keys = group ? EVENTS.filter(e => e.group === group).map(e => e.key) : EVENTS.map(e => e.key);
    return (await db.query(
        `SELECT id, event, ref, label, phone, template, status, error, reply, replied_at, created_at, conversation_id
           FROM nl_auto_sends WHERE line_id = $1 AND event = ANY($2) ORDER BY created_at DESC LIMIT $3`,
        [lineId, keys, limit])).rows;
}

async function cartStats(lineId) {
    return (await db.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE recovered_at IS NOT NULL)::int AS recovered,
                COUNT(*) FILTER (WHERE recovered_at IS NULL AND created_at > NOW() - INTERVAL '8 days')::int AS waiting,
                MAX(created_at) AS last_at
           FROM nl_carts WHERE line_id = $1 AND created_at > NOW() - INTERVAL '30 days'`, [lineId])).rows[0];
}

/**
 * Submit our own template for an event to Meta. A photo header needs a sample photo, uploaded
 * from one of the shop's products.
 */
async function createSetTemplate(lineId, eventKey) {
    const t = set.byEvent(eventKey);
    if (!t) throw new Error('No CRM template for that event');
    let handle = null;
    if (t.image) {
        const products = await shopify.fetchProducts();
        const photo = products.find(p => p.image && /\.(jpe?g|png)(\?|$)/i.test(p.image))?.image;
        if (!photo) throw new Error('No product photo in Shopify to use as the sample');
        const res = await fetch(photo);
        if (!res.ok) throw new Error('Could not download the sample photo from Shopify');
        const buf = Buffer.from(await res.arrayBuffer());
        const mime = /\.png(\?|$)/i.test(photo) ? 'image/png' : 'image/jpeg';
        handle = await lines.run('normless', () => wa.uploadSample(buf, mime));
    }
    const components = set.components(t, handle);
    const created = await lines.run('normless', () => wa.graph(`/${wa.wabaId()}/message_templates`, {
        method: 'POST', body: { name: t.name, language: 'en', category: t.category, components },
    }));
    const body = components.find(c => c.type === 'BODY').text;
    await db.query(
        `INSERT INTO wa_templates (name, language, category, status, body_text, variables, header_kind, synced_at, line_id, meta_id, components)
         VALUES ($1,'en',$2,$3,$4,$5,$6,CURRENT_TIMESTAMP,$7,$8,$9)
         ON CONFLICT (line_id, name, language) DO UPDATE SET status = EXCLUDED.status, body_text = EXCLUDED.body_text,
             variables = EXCLUDED.variables, header_kind = EXCLUDED.header_kind, meta_id = EXCLUDED.meta_id,
             components = EXCLUDED.components, synced_at = CURRENT_TIMESTAMP`,
        [t.name, t.category, created?.status || 'PENDING', body, t.vars.length, t.image ? 'IMAGE' : null, lineId, created?.id || null, JSON.stringify(components)]);
    return { name: t.name, status: created?.status || 'PENDING' };
}

/* ── The clock ────────────────────────────────────────────────────────────────────────────── */

let timers = [];
function start() {
    const line = () => lines.get('normless');
    const guard = (name, fn) => {
        let busy = false;
        return async () => {
            if (busy || !line()?.id || !process.env.SHOPIFY_STORE_DOMAIN) return;
            busy = true;
            try { await fn(line().id); }
            catch (err) { console.error(`normless ${name}:`, err.message); }
            finally { busy = false; }
        };
    };
    timers.push(setInterval(guard('carts', cartTick), 60 * 1000));
    timers.push(setInterval(guard('orders', orderTick), 3 * 60 * 1000));
    timers.forEach(t => t.unref());
}

module.exports = {
    EVENTS, config, saveEvents, fire, onAbandoned, onText, cartTick, orderTick, orderEvents, onReply, recent, cartStats,
    createSetTemplate, recoverCarts, start, CART_HOURS,
};
