/**
 * Crewfit's helper on WhatsApp: qualifying leads from what customers send, and answering product
 * questions from the catalogue while nobody on the team has the chat yet.
 *
 * Qualifying: a lead still at "New" or "Enquiry" moves to "Qualified" as soon as the customer sends
 * any of what a quote needs — their logo (a photo or file), a quantity, billing details (a GST
 * number or a billing address), or a product from the catalogue. What was found is written onto the
 * lead (quantity, product, GST number, logo) where it is still empty, and noted on the chat.
 *
 * Answering: a customer asking about a product ("polo price?", "do you have hoodies") gets its photo,
 * material, colours and price tiers from Settings › Catalogue; a general ask ("price list",
 * "catalogue") gets the range with prices. Asking for a person gets a line saying someone will reply,
 * and the chat waits in "Needs a person". Nothing is sent once a person has the chat.
 */

const db = require('../db/connection');
const wa = require('./whatsapp');
const lines = require('./wa-line');

const PUBLIC_BASE = () => (process.env.PUBLIC_BASE_URL || 'https://ops.normless.store').replace(/\/+$/, '');
const safeJson = (v, f) => { try { return typeof v === 'string' ? (JSON.parse(v || 'null') ?? f) : (v ?? f); } catch { return f; } };
const GSTIN = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/i;
const QTY = /(?:\b(?:qty|quantity)\s*[:\-=]?\s*(\d{1,5})\b)|(?:\b(\d{1,5})\s*(?:pcs|pc|pieces?|nos|numbers|units|qty|t-?shirts?|tees|shirts?|polos?|hoodies?|jerseys?|caps?|uniforms?)\b)/i;
const ASK_PERSON = /\b(talk|speak|connect|call)\b.*\b(team|person|someone|human|agent|executive|you)\b|\bcall me\b|\bhuman\b/i;
const ASK_RANGE = /\b(catalog(ue)?|price ?list|rate ?card|rates|all products|what (do )?you (have|sell|make))\b/i;
const ASK_PRICE = /\b(price|cost|rate|how much|quote|moq|minimum)\b/i;

async function products() {
    const rows = (await db.query(
        `SELECT id, name, category, fit, gsm, material, from_price, blurb, colors, tiers, image_url
           FROM crewfit_products WHERE active AND COALESCE(wa_visible, true) ORDER BY sort_order, id`)).rows;
    return rows.map(p => ({ ...p, colors: safeJson(p.colors, []), tiers: safeJson(p.tiers, []) }));
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
    return scored.sort((a, b) => b.score - a.score).map(x => x.p);
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
        `SELECT l.id, l.status, l.quantity, l.product_interest, l.gst_number, l.logo_url, l.billing_address
           FROM wa_conversations c JOIN wa_contacts k ON k.id = c.contact_id JOIN crewfit_leads l ON l.id = k.lead_id
          WHERE c.id = $1`, [conversationId])).rows[0];
    if (!row) return [];
    const found = [];
    const set = {};
    const type = message?.type;
    if ((type === 'image' || type === 'document') && mediaUrl) {
        found.push('a logo or design');
        if (!row.logo_url && type === 'image') set.logo_url = mediaUrl;
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
    const hits = matchProducts(text, await products());
    if (hits.length) {
        found.push(`interest in ${hits[0].name}`);
        if (!row.product_interest) set.product_interest = hits[0].name;
    }
    if (!found.length) return [];

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
    return found;
}

/* ── Answering from the catalogue ─────────────────────────────────────────────────────────── */

/**
 * Answer a product question while nobody has the chat. Returns true when it replied.
 * `conversation` needs id, phone, mode, assigned_to, status.
 */
async function answer(conversation, text) {
    if (!text || conversation.assigned_to || conversation.mode !== 'human' || conversation.status === 'closed') return false;
    const phone = conversation.phone;

    if (ASK_PERSON.test(text)) {
        if (await saidRecently(conversation.id, 'someone from our team')) return true;
        const body = 'Sure — someone from our team will reply to you here shortly.';
        await record(conversation.id, await wa.sendText(phone, body), body);
        return true;
    }

    const list = await products();
    if (!list.length) return false;
    const hits = matchProducts(text, list);
    if (hits.length) {
        let sent = 0;
        for (const p of hits.slice(0, 3)) {
            if (await saidRecently(conversation.id, `*${p.name}*`)) continue;
            const cap = caption(p);
            if (p.image_url) {
                const link = /^https?:\/\//.test(p.image_url) ? p.image_url : `${PUBLIC_BASE()}${p.image_url}`;
                await record(conversation.id, await wa.sendImageLink(phone, link, cap), cap, 'image', p.image_url);
            } else {
                await record(conversation.id, await wa.sendText(phone, cap), cap);
            }
            sent++;
        }
        if (sent) {
            const next = 'Prices are for the garment. Reply with the quantity, sizes and your logo, and we’ll send you a quote.';
            if (!(await saidRecently(conversation.id, 'send you a quote'))) await record(conversation.id, await wa.sendText(phone, next), next);
        }
        return sent > 0 || hits.length > 0;
    }
    if (ASK_RANGE.test(text) || (ASK_PRICE.test(text) && String(text).length < 80)) {
        if (await saidRecently(conversation.id, 'Here’s our range')) return true;
        const body = `Here’s our range (price per piece, from):\n\n${list.map(p => `• ${p.name}${p.from_price ? ` — ${rupees(p.from_price)}` : ''}`).join('\n')}\n\nTell us which one you like and we’ll send photos and the full price list.`;
        await record(conversation.id, await wa.sendText(phone, body), body);
        return true;
    }
    return false;
}

/** Both, for one Crewfit message. Never throws: the message is already saved. */
async function onInbound(conversationId, message, { text, mediaUrl }) {
    try {
        await qualify(conversationId, message, { text, mediaUrl });
        const c = (await db.query(
            `SELECT c.id, c.mode, c.assigned_to, c.status, k.phone FROM wa_conversations c JOIN wa_contacts k ON k.id = c.contact_id WHERE c.id = $1`,
            [conversationId])).rows[0];
        if (c && lines.current()?.brand === 'crewfit' && wa.configured()) await answer(c, text);
    } catch (err) {
        console.error('crewfit assist error:', err.message);
    }
}

module.exports = { qualify, answer, onInbound, matchProducts, caption, products, QTY, GSTIN };
