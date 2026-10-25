/**
 * Normless's old provider's templates, copied with our own links.
 *
 * Updatrr's templates send every link button through its redirector
 * (prizmacommunicator…/urlhopper?redirectionUrl={{1}}). Meta doesn't let a template's button
 * address change without a re-review that would break Updatrr while it is still sending, so
 * each one is submitted again as a new template — same wording, photo header, footer and buttons
 * — named nl_<old name>, with the link pointing at ops.normless.store/go/{{1}}. Exact duplicates
 * among the old ones are submitted once.
 *
 * Also here: what fills each gap in those templates (and in Updatrr's link-free ones, which can
 * be used as they are), read from their wording, so picking one for an event needs no mapping.
 */

const db = require('../db/connection');
const wa = require('./whatsapp');
const lines = require('./wa-line');
const shopify = require('./shopify');
const { BUTTON_BASE } = require('./nl-links');

const HOPPER = /prizmacommunicator\.prizmacommerce\.com\/urlhopper/i;
const WA_BUTTON = /prizmacommunicator\.prizmacommerce\.com\/whatsappbutton\?phoneNumber=\+?(\d+)/i;
const EXAMPLE_CODE = 'k3Jx9aQ';
const safeJson = (v, fallback = null) => { try { return typeof v === 'string' ? (JSON.parse(v || 'null') ?? fallback) : (v ?? fallback); } catch { return fallback; } };

/**
 * What fills each gap, which events a template suits, and where its link goes — from its words.
 * Null when the wording isn't one we recognise; the page then asks.
 */
function suggest(body, buttons = []) {
    const b = String(body || '');
    const n = new Set((b.match(/\{\{\s*(\d+)\s*\}\}/g) || [])).size;
    const rs = (i) => (new RegExp(`₹\\s*\\{\\{${i}\\}\\}`).test(b) ? '' : '_inr');      // "₹{{3}}" or a bare "{{3}}"
    const hasLink = buttons.some(x => x.type === 'URL');
    const out = (vars, events, link = null) => ({ vars, events, link: hasLink ? link : null });

    if (/left something behind|quick reminder about your|still waiting in your/i.test(b)) {
        const ev = /left something/i.test(b) ? 'cart_1' : /quick reminder/i.test(b) ? 'cart_2' : 'cart_3';
        return out(['first_name', 'store_name', 'product_name', ...(n >= 4 ? ['coupon'] : [])], [ev, 'cart_1', 'cart_2', 'cart_3'].filter((x, i, a) => a.indexOf(x) === i), 'checkout');
    }
    if (/order is almost complete\.?\s*\n\s*Order Details/i.test(b)) {
        return out(n >= 4 ? ['first_name', 'product_name', 'currency', 'cart_total'] : ['first_name', 'product_name', `cart_total${rs(3)}`], ['cart_1', 'cart_2', 'cart_3'], 'checkout');
    }
    if (/Wohoo! Your order is almost complete/i.test(b)) return out([], ['cart_1', 'cart_2', 'cart_3'], 'checkout');
    if (/checking out some amazing items/i.test(b)) {
        return out(n >= 4 ? ['store_name', 'product_name', 'coupon', null] : ['store_name', 'coupon', null], ['cart_1', 'cart_2', 'cart_3'], 'checkout');
    }
    if (/Outstanding Amount/i.test(b)) {
        return out(['first_name', 'order_number', `cod_amount${rs(3)}`, `order_total${rs(4)}`, 'items'], ['order_partial_cod'], 'order');
    }
    if (/Order Confirmation Required|Please confirm your order/i.test(b) || (/Cash On Delivery/i.test(b) && buttons.some(x => x.type === 'QUICK_REPLY'))) {
        // With or without the greeting: the order number moves to {{1}} when there's no name.
        const greet = /\{\{1\}\}/.test(b.split('\n')[0]);
        const v = greet ? ['first_name', 'order_number', `order_total${rs(3)}`, 'items', 'address'] : ['order_number', `order_total${rs(2)}`, 'items', 'address'];
        return out(v, ['cod_confirm', 'order_cod'], 'order');
    }
    if (/Thank you for your order with us/i.test(b) && /Address:/i.test(b)) {
        return out(['first_name', 'order_number', `order_total${rs(3)}`, 'items', 'address'], ['order_cod', 'order_prepaid'], 'order');
    }
    if (/Thank you for your order with us/i.test(b)) {
        return out(['first_name', 'order_number', `order_total${rs(3)}`, 'items'], ['order_prepaid', 'order_cod'], 'order');
    }
    if (/has been confirmed!/i.test(b)) return out(['first_name', 'order_number', `order_total${rs(3)}`], ['order_prepaid', 'order_cod'], 'order');
    if (/shipped part of your order/i.test(b)) return out(['first_name', 'order_number', 'items'], ['fulfilled'], 'tracking');
    if (/has shipped|on its way and will reach/i.test(b)) return out(['first_name', 'order_number'], ['fulfilled'], 'tracking');
    if (/has been successfully cancel+ed/i.test(b)) return out(['first_name', 'order_number'], ['order_cancelled'], 'store');
    if (/refund for Order/i.test(b)) return out(['first_name', 'order_number', `refund_amount${rs(3)}`, 'refund_note'], ['refund'], 'order');
    if (/leave us a quick review/i.test(b)) return out(['first_name', 'product_name'], [], 'store');
    if (/received your payment for Order/i.test(b)) return out(['first_name', 'order_number', `order_total${rs(3)}`], ['order_prepaid'], 'order');
    if (/out for delivery/i.test(b)) return out(n >= 4 ? ['first_name', 'order_number', 'product_name', `order_total${rs(4)}`] : n === 1 ? ['order_number'] : ['first_name', 'order_number'], [], 'tracking');
    if (/was delivered/i.test(b)) return out(['first_name', 'order_number'], [], 'order');
    if (/request to cancel Order/i.test(b)) return out(['first_name', 'order_number'], [], 'order');
    return null;
}

/** Suggestions for every template on the line, by name. */
function suggestions(templates) {
    const out = {};
    for (const t of templates) {
        const c = safeJson(t.components, []);
        const s = suggest(c.find(x => x.type === 'BODY')?.text || t.body_text, c.find(x => x.type === 'BUTTONS')?.buttons || []);
        if (s) out[t.name] = s;
    }
    return out;
}

/* ── Copying ──────────────────────────────────────────────────────────────────────────────── */

const baseName = (name) => String(name).replace(/\d{13}$/, '').replace(/_+$/, '');

const chatCode = (digits) => `chat${digits}`;
/** The fixed short links a copy's static buttons point at (a WhatsApp chat with the team). */
async function ensureStaticLinks(components) {
    for (const c of components) for (const b of c.buttons || []) {
        const chat = (b.url || '').match(WA_BUTTON);
        if (chat) {
            await db.query(`INSERT INTO nl_links (code, url, kind) VALUES ($1,$2,'chat') ON CONFLICT (code) DO NOTHING`,
                [chatCode(chat[1]), `https://wa.me/${chat[1]}`]);
        }
    }
}

/** The new template's parts: everything as it was, links swapped for ours. */
function copyComponents(components, imageHandle) {
    return components.map(c => {
        if (c.type === 'HEADER') {
            if (c.format === 'IMAGE') return { type: 'HEADER', format: 'IMAGE', example: { header_handle: [imageHandle] } };
            return { type: 'HEADER', format: c.format, ...(c.text ? { text: c.text } : {}), ...(c.example?.header_text ? { example: { header_text: c.example.header_text } } : {}) };
        }
        if (c.type === 'BODY') return { type: 'BODY', text: c.text, ...(c.example?.body_text ? { example: { body_text: c.example.body_text } } : {}) };
        if (c.type === 'FOOTER') return { type: 'FOOTER', text: c.text };
        if (c.type === 'BUTTONS') {
            return {
                type: 'BUTTONS',
                buttons: c.buttons.map(b => {
                    if (b.type === 'URL' && HOPPER.test(b.url || '')) {
                        return { type: 'URL', text: b.text, url: `${BUTTON_BASE()}{{1}}`, example: [`${BUTTON_BASE()}${EXAMPLE_CODE}`] };
                    }
                    const chat = (b.url || '').match(WA_BUTTON);
                    // Meta refuses wa.me links on buttons, so the chat link goes through /go too.
                    if (b.type === 'URL' && chat) return { type: 'URL', text: b.text, url: `${BUTTON_BASE()}${chatCode(chat[1])}` };
                    if (b.type === 'URL') return { type: 'URL', text: b.text, url: b.url, ...(b.example ? { example: b.example } : {}) };
                    if (b.type === 'PHONE_NUMBER') return { type: 'PHONE_NUMBER', text: b.text, phone_number: b.phone_number };
                    if (b.type === 'COPY_CODE') return { type: 'COPY_CODE', example: Array.isArray(b.example) ? b.example[0] : b.example };
                    return { type: 'QUICK_REPLY', text: b.text };
                }),
            };
        }
        return c;
    });
}

/** Which templates would be copied, and under what names. Exact duplicates go once. */
async function plan(lineId) {
    const rows = (await db.query(
        `SELECT name, language, category, status, components FROM wa_templates
          WHERE line_id = $1 AND components LIKE '%prizmacommunicator%' AND name NOT LIKE 'nl\\_%' ORDER BY name`, [lineId])).rows;
    const existing = new Set((await db.query(`SELECT name FROM wa_templates WHERE line_id = $1`, [lineId])).rows.map(r => r.name));
    const seen = new Map();          // content → planned copy
    const names = new Set();
    const out = [];
    for (const r of rows) {
        const comps = safeJson(r.components, []);
        // Updatrr's own welcome ("This is Updatrr bot") has a Normless twin; it isn't copied.
        if (/Updatrr/i.test(JSON.stringify(comps))) continue;
        const key = JSON.stringify([r.language, comps.map(c => [c.type, c.format || null, c.text || null,
            (c.buttons || []).map(b => [b.type, b.text])])]);
        if (seen.has(key)) { seen.get(key).from.push(r.name); continue; }
        let name = `nl_${baseName(r.name)}`.slice(0, 500);
        for (let i = 2; names.has(name); i++) name = `nl_${baseName(r.name)}_${i}`;
        names.add(name);
        const item = { name, language: r.language, category: r.category, from: [r.name], components: comps, exists: existing.has(name) };
        seen.set(key, item);
        out.push(item);
    }
    return out;
}

/** A product photo for the sample Meta's reviewers see on photo headers. Uploaded once per run. */
async function sampleHandle() {
    const products = await shopify.fetchProducts();
    const photo = products.find(p => p.image && /\.(jpe?g|png)(\?|$)/i.test(p.image))?.image;
    if (!photo) throw new Error('No product photo in Shopify to use as the sample');
    const res = await fetch(photo);
    if (!res.ok) throw new Error('Could not download the sample photo from Shopify');
    const buf = Buffer.from(await res.arrayBuffer());
    return wa.uploadSample(buf, /\.png(\?|$)/i.test(photo) ? 'image/png' : 'image/jpeg');
}

/** Submit every copy not yet on the account. Returns one line per template. */
async function submit(lineId) {
    const todo = (await plan(lineId)).filter(t => !t.exists);
    if (!todo.length) return [];
    let handle = null;
    if (todo.some(t => t.components.some(c => c.type === 'HEADER' && c.format === 'IMAGE'))) {
        handle = await lines.run('normless', sampleHandle);
    }
    const results = [];
    for (const t of todo) {
        const components = copyComponents(t.components, handle);
        try {
            await ensureStaticLinks(t.components);
            const created = await lines.run('normless', () => wa.graph(`/${wa.wabaId()}/message_templates`, {
                method: 'POST', body: { name: t.name, language: t.language, category: t.category, components },
            }));
            const body = components.find(c => c.type === 'BODY');
            const vars = new Set((String(body?.text || '').match(/\{\{\s*(\d+)\s*\}\}/g) || [])).size;
            const header = components.find(c => c.type === 'HEADER');
            await db.query(
                `INSERT INTO wa_templates (name, language, category, status, body_text, variables, header_kind, synced_at, line_id, meta_id, components)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP,$8,$9,$10)
                 ON CONFLICT (line_id, name, language) DO UPDATE SET status = EXCLUDED.status, meta_id = EXCLUDED.meta_id,
                     components = EXCLUDED.components, synced_at = CURRENT_TIMESTAMP`,
                [t.name, t.language, t.category, created?.status || 'PENDING', body?.text || '', vars, header?.format || null,
                    lineId, created?.id || null, JSON.stringify(components)]);
            results.push({ name: t.name, from: t.from, status: created?.status || 'PENDING' });
        } catch (err) {
            results.push({ name: t.name, from: t.from, status: 'FAILED', error: err.message });
        }
    }
    return results;
}

module.exports = { suggest, suggestions, plan, submit, copyComponents, ensureStaticLinks, baseName };
