/**
 * The Normless shop as WhatsApp sees it: who a customer is, what they ordered, where it is, and
 * what the shop sells.
 *
 * Shared by the inbox's side panel and the Normless bot, so a person and the bot always see the
 * same orders and the same tracking for a chat. Read-only: nothing here changes the shop.
 */

const db = require('../db/connection');
const shopify = require('./shopify');

const last10 = (v) => String(v || '').replace(/\D+/g, '').slice(-10);
const safeJson = (v, fallback) => { try { return typeof v === 'string' ? (JSON.parse(v || 'null') ?? fallback) : (v || fallback); } catch { return fallback; } };
const trackingUrl = (dispatch) => dispatch?.tracking_url
    || (dispatch?.awb ? `https://www.delhivery.com/track-v2/package/${encodeURIComponent(dispatch.awb)}` : null);

/** Payment as the refund policy reads it: a partial-COD advance is never refunded. */
function paymentKind(financialStatus) {
    const s = String(financialStatus || '').toUpperCase();
    if (s === 'PAID') return { key: 'prepaid', label: 'Prepaid' };
    if (s === 'PARTIALLY_PAID') return { key: 'partial_cod', label: 'Partial COD — the advance is not refundable' };
    if (s === 'PENDING') return { key: 'cod', label: 'Cash on delivery' };
    if (s.includes('REFUNDED')) return { key: 'refunded', label: s === 'REFUNDED' ? 'Refunded' : 'Partly refunded' };
    return { key: 'other', label: s ? s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ') : 'Unknown' };
}

const ORDER_FIELDS = `o.order_number, o.shopify_id, o.created_at, o.total_price, o.financial_status,
                      o.fulfillment_status, o.cancelled_at, o.on_hold, o.fulfilled_at, o.line_items_json,
                      o.customer_shopify_id`;

/** One order, shaped for the panel and the bot, with its parcel if it has gone out. */
function shapeOrder(o, dispatch, ticketIds = []) {
    return {
        order_number: o.order_number,
        created_at: o.created_at,
        total_price: o.total_price,
        payment: paymentKind(o.financial_status),
        state: o.cancelled_at ? 'Cancelled' : o.on_hold ? 'On hold'
            : dispatch || String(o.fulfillment_status).toUpperCase() === 'FULFILLED' ? 'Shipped' : 'Not shipped yet',
        shipped_at: dispatch?.packed_at || o.fulfilled_at || null,
        items: safeJson(o.line_items_json, []).map(i => ({ title: i.title, variant: i.variant, quantity: i.quantity, price: i.price })),
        dispatch: dispatch && {
            awb: dispatch.awb, courier: dispatch.courier, tracking_url: trackingUrl(dispatch),
            city: dispatch.ship_city, pincode: dispatch.ship_pincode,
        },
        tickets: ticketIds,
    };
}

async function dispatchesFor(numbers) {
    if (!numbers.length) return new Map();
    const rows = (await db.query(
        `SELECT order_number, awb, courier, tracking_url, packed_at, ship_city, ship_pincode
           FROM packed_orders WHERE order_number = ANY($1)`, [numbers])).rows;
    return new Map(rows.map(p => [p.order_number, p]));
}

/**
 * Everything the shop knows about the person on a chat: the Shopify customer with this phone
 * number, their orders (by customer, and by the phone a parcel went to), their support tickets and
 * what they have sent in the chat. Matches the customer onto the chat when it was not yet.
 */
/**
 * The Shopify customer behind a phone number: the one whose profile has it, or — when the profile
 * has no phone, as with Razorpay checkouts that put it only on the order — the customer on the
 * latest order placed with it.
 */
async function findCustomerId(phone10) {
    if (String(phone10).length !== 10) return null;
    const byProfile = (await db.query(
        `SELECT id FROM customers
          WHERE RIGHT(REGEXP_REPLACE(COALESCE(phone, ''), '\\D', '', 'g'), 10) = $1
          ORDER BY orders_count DESC NULLS LAST, id LIMIT 1`, [phone10])).rows[0];
    if (byProfile) return byProfile.id;
    const byOrder = (await db.query(
        `SELECT c.id FROM orders o JOIN customers c ON c.shopify_id = o.customer_shopify_id
          WHERE $1 = ANY(o.phones) ORDER BY o.created_at DESC NULLS LAST LIMIT 1`, [phone10])).rows[0];
    return byOrder?.id || null;
}

/**
 * Orders placed with this phone in the last week, asked of Shopify directly — for the minutes
 * between someone ordering and the sync bringing the order in. Cached for a minute.
 */
let recentCache = { at: 0, orders: [] };
async function recentShopifyOrders(phone10) {
    if (!process.env.SHOPIFY_STORE_DOMAIN || String(phone10).length !== 10) return [];
    if (Date.now() - recentCache.at > 60000) {
        try {
            const since = new Date(Date.now() - 7 * 86400000).toISOString();
            let url = `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2026-04/orders.json?status=any&limit=250&created_at_min=${encodeURIComponent(since)}`
                + '&fields=id,name,created_at,total_price,financial_status,fulfillment_status,cancelled_at,customer,line_items,phone,shipping_address,billing_address';
            const orders = [];
            for (let page = 0; url && page < 8; page++) {
                const res = await fetch(url, { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN }, signal: AbortSignal.timeout(15000) });
                if (!res.ok) throw new Error(`Shopify ${res.status}`);
                orders.push(...((await res.json()).orders || []));
                url = (res.headers.get('Link') || '').match(/<([^>]+)>;\s*rel="next"/)?.[1] || null;
            }
            recentCache = { at: Date.now(), orders };
        } catch (err) {
            console.error('normless recent orders:', err.message);
            return [];
        }
    }
    return recentCache.orders.filter(o => shopify.orderPhones(o).includes(phone10)).map(o => ({
        order_number: o.name, shopify_id: `gid://shopify/Order/${o.id}`, created_at: o.created_at, total_price: Number(o.total_price) || 0,
        financial_status: String(o.financial_status || '').toUpperCase(), fulfillment_status: String(o.fulfillment_status || 'unfulfilled').toUpperCase(),
        cancelled_at: o.cancelled_at || null, on_hold: false, fulfilled_at: null,
        line_items_json: JSON.stringify((o.line_items || []).map(li => ({ title: li.title, variant: li.variant_title || '', quantity: li.current_quantity ?? li.quantity, price: li.price }))),
        customer_shopify_id: o.customer?.id ? `gid://shopify/Customer/${o.customer.id}` : null,
    }));
}

async function customerFor(conversation) {
    const phone10 = last10(conversation.phone);

    let customerId = conversation.customer_id;
    if (!customerId && phone10.length === 10) {
        customerId = await findCustomerId(phone10);
        if (customerId) {
            await db.query(
                `UPDATE wa_contacts SET customer_id = $2
                  WHERE id = (SELECT contact_id FROM wa_conversations WHERE id = $1)`, [conversation.id, customerId]);
        }
    }
    const customer = customerId ? (await db.query(
        `SELECT id, shopify_id, first_name, last_name, email, phone, orders_count, total_spent, tags, created_at
           FROM customers WHERE id = $1`, [customerId])).rows[0] || null : null;

    // Theirs: placed by their Shopify customer, placed with this phone on the order itself, or
    // shipped to this phone.
    const orders = (await db.query(
        `SELECT ${ORDER_FIELDS}
           FROM orders o
          WHERE ($1::text IS NOT NULL AND o.customer_shopify_id = $1)
             OR ($2 <> '' AND $2 = ANY(o.phones))
             OR o.order_number IN (SELECT p.order_number FROM packed_orders p
                                    WHERE $2 <> '' AND RIGHT(REGEXP_REPLACE(COALESCE(p.customer_phone, ''), '\\D', '', 'g'), 10) = $2)
          ORDER BY o.created_at DESC NULLS LAST
          LIMIT 12`, [customer?.shopify_id || null, phone10])).rows;
    // An order from the last few minutes may not have synced yet: Shopify is asked directly.
    for (const o of await recentShopifyOrders(phone10)) {
        if (!orders.some(x => x.order_number === o.order_number)) orders.push(o);
    }
    orders.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    const numbers = orders.map(o => o.order_number);
    const dispatchOf = await dispatchesFor(numbers);

    const tickets = (await db.query(
        `SELECT id, ref_no, order_number, nature, reason, status, progress, action,
                TO_CHAR(raised_on,'YYYY-MM-DD') AS raised_on, wa_conversation_id
           FROM support_tickets
          WHERE order_number = ANY($1)
             OR ($2 <> '' AND RIGHT(REGEXP_REPLACE(COALESCE(customer_phone, ''), '\\D', '', 'g'), 10) = $2)
             OR wa_conversation_id = $3
          ORDER BY raised_on DESC, id DESC LIMIT 20`, [numbers, phone10, conversation.id])).rows;

    const media = (await db.query(
        `SELECT COUNT(*) FILTER (WHERE media_mime LIKE 'image/%')::int AS photos,
                COUNT(*) FILTER (WHERE media_mime LIKE 'video/%')::int AS videos
           FROM wa_messages WHERE conversation_id = $1 AND direction = 'in' AND media_url IS NOT NULL`,
        [conversation.id])).rows[0];

    return {
        customer: customer && {
            ...customer,
            name: [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim() || null,
        },
        orders: orders.map(o => shapeOrder(o, dispatchOf.get(o.order_number) || null,
            tickets.filter(t => t.order_number === o.order_number).map(t => t.id))),
        tickets,
        media,
    };
}

/**
 * An order the customer names by number. Shown only if it is theirs: placed by the Shopify
 * customer with this chat's phone, or shipped to this phone, or — for an order placed with another
 * number — when they give the email or the delivery pincode on it.
 */
async function orderByNumber(conversation, orderNumber, { email = null, pincode = null } = {}) {
    const digits = String(orderNumber || '').match(/\d{3,}/);
    if (!digits) return { error: 'That doesn’t look like an order number. Normless order numbers look like #12151.' };
    const number = `#${digits[0]}`;
    const o = (await db.query(
        `SELECT ${ORDER_FIELDS}, c.phone AS customer_phone, COALESCE(o.email, c.email) AS customer_email, o.phones
           FROM orders o LEFT JOIN customers c ON c.shopify_id = o.customer_shopify_id
          WHERE o.order_number = $1`, [number])).rows[0];
    const dispatch = (await dispatchesFor([number])).get(number) || null;
    if (!o && !dispatch) return { error: `No order ${number} found. It may be older than the CRM's records — a person can check.` };

    const phone10 = last10(conversation.phone);
    const ownPhone = (o?.phones || []).includes(phone10) || [o?.customer_phone, dispatch && (await db.query(
        'SELECT customer_phone FROM packed_orders WHERE order_number = $1', [number])).rows[0]?.customer_phone]
        .some(p => p && last10(p) === phone10);
    const emailOk = email && o?.customer_email && String(email).trim().toLowerCase() === String(o.customer_email).trim().toLowerCase();
    const pinOk = pincode && dispatch?.ship_pincode && String(pincode).replace(/\D/g, '') === String(dispatch.ship_pincode).replace(/\D/g, '');
    if (!ownPhone && !emailOk && !pinOk) {
        return {
            needs_verification: true,
            message: `${number} wasn't placed with this WhatsApp number. Ask the customer for the email address or the delivery pincode on the order, then look it up again with it.`,
        };
    }
    return { order: o ? shapeOrder(o, dispatch) : { order_number: number, state: 'Shipped', dispatch: { awb: dispatch.awb, courier: dispatch.courier, tracking_url: trackingUrl(dispatch) } } };
}

/* ── The catalogue ─────────────────────────────────────────────────────────────────────────── */

const STORE = 'https://normless.store';
const productUrl = (p) => (p.handle ? `${STORE}/products/${p.handle}` : STORE);

function shapeProduct(p) {
    const inStock = p.variants.filter(v => v.available == null || v.available > 0);
    const sizes = [...new Set(inStock.map(v => String(v.title || '').split('/').pop().trim()).filter(Boolean))];
    const prices = p.variants.map(v => Number(v.price)).filter(Number.isFinite);
    return {
        title: p.title, handle: p.handle, type: p.product_type || null,
        price: prices.length ? Math.min(...prices) : null,
        sizes_in_stock: sizes, sold_out: !inStock.length,
        url: productUrl(p), has_size_chart: !!p.size_chart,
    };
}

/** Products whose name or type matches the words asked about, best match first. */
async function searchProducts(query, limit = 6) {
    const products = await shopify.fetchProducts();
    const words = String(query || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1);
    const scored = products.map(p => {
        const hay = `${p.title} ${p.product_type || ''} ${(p.variants || []).map(v => v.title).join(' ')}`.toLowerCase();
        const score = words.reduce((n, w) => n + (hay.includes(w) ? (p.title.toLowerCase().includes(w) ? 3 : 1) : 0), 0);
        return { p, score };
    }).filter(x => !words.length || x.score > 0).sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(x => shapeProduct(x.p));
}

async function productByHandle(handle) {
    const products = await shopify.fetchProducts();
    const want = String(handle || '').trim().toLowerCase();
    return products.find(p => String(p.handle || '').toLowerCase() === want)
        || products.find(p => p.title.toLowerCase() === want) || null;
}

module.exports = { findCustomerId, recentShopifyOrders, customerFor, orderByNumber, searchProducts, productByHandle, shapeProduct, productUrl, paymentKind, last10, STORE };
