/**
 * Collecting a customer's billing details in the chat, for the order form.
 *
 * The shop has always asked for these in one message — billing name, addresses, contact, email,
 * GST — and then copied the answer into the order by hand. This sends that same message, reads
 * the reply, and fills the fields. Whatever the reply did not cover is asked for one at a time,
 * so a customer who answers half the list is not sent the whole list again. When everything
 * required is in, the details go onto the lead, where "Create order" picks them up.
 *
 * While it runs the conversation is in mode 'billing'. A rep can take over at any point, exactly
 * as with the menu.
 *
 * Reading the reply: customers mostly paste the list back with their answers after each label,
 * so labels are matched first; an email, a GSTIN and a mobile number are also found by their
 * shape wherever they are. When the reply has no labels at all and the assistant is configured,
 * Claude is asked to read it — and anything still unclear is simply asked again.
 */

const db = require('../db/connection');
const wa = require('./whatsapp');

// Only a name, a number to reach them on and where to deliver are needed to start an order; the
// rest is welcome but never chased. The mobile defaults to the WhatsApp number they are writing
// from, so in practice only the name and the delivery address are ever asked for.
const FIELDS = [
    { key: 'contact_person', label: 'Name', required: true },
    { key: 'billing_mobile', label: 'Contact Number', required: true },
    { key: 'delivery_address', label: 'Delivery Address', required: true },
    { key: 'billing_name', label: 'Billing / Company Name (optional)', required: false },
    { key: 'billing_address', label: 'Billing Address (optional)', required: false },
    { key: 'billing_email', label: 'Email Address (optional)', required: false },
    { key: 'gst_number', label: 'GST Number (if applicable)', required: false },
];

const DEFAULT_REQUEST = [
    'Great 🙌 To proceed with your custom order, please share the following details:',
    '',
    '✅ Name',
    '✅ Delivery Address (with pincode)',
    '✅ Contact Number (if different from this WhatsApp number)',
    '',
    'For a GST invoice, also send (optional):',
    '• Billing / Company Name',
    '• Billing Address',
    '• Email Address',
    '• GST Number',
    '',
    'Payment Terms:',
    '* 50% advance payment to begin production',
    '* Remaining 50% payable before dispatch',
    '',
    'As these are custom-made printed products created specifically for your requirement, production will begin once the advance payment is confirmed.',
    '',
    'Once we receive the above details, we’ll share the payment link and proceed 🚀',
].join('\n');

const safeJson = (v, fallback) => {
    try { return typeof v === 'string' ? (JSON.parse(v || 'null') ?? fallback) : (v || fallback); }
    catch { return fallback; }
};

/* ── Reading a reply ─────────────────────────────────────────────────────────────────────── */

// The words a customer uses for each field, most specific first: "billing address" must win over
// "billing name", and "delivery address" over plain "address".
const LABELS = [
    ['billing_address', /(billing|invoice|company|office)\s*address/i],
    ['delivery_address', /(delivery|shipping|ship\s*to|deliver(y)?\s*to)\s*(address)?/i],
    ['billing_name', /(billing\s*name|company\s*name|business\s*name|firm\s*name|billing\s*\/\s*company|name\s*\/\s*company|company)/i],
    ['contact_person', /(contact\s*person|contact\s*name|person\s*name|your\s*name|^name)/i],
    ['billing_email', /(e-?mail)/i],
    ['gst_number', /(gst(in)?\s*(no|number|#)?)/i],
    ['billing_mobile', /(mobile|phone|contact\s*(no|number)|whats\s*app|cell)/i],
];

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const GSTIN = /\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]\b/i;
const MOBILE = /(?:\+?91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b/;
const SKIP = /^(na|n\/a|nil|none|no|not applicable|-|skip|no gst|not available)\.?$/i;
const SAME = /^(same|same as (above|billing)( address)?|as above)\.?$/i;

/** Strip the bullets, ticks and stars customers paste back with the list. */
const clean = (line) => String(line).replace(/^[\s✅☑️✔️•*\-–>#\d.)]+/u, '').replace(/\*+/g, '').trim();

/** Labelled answers: "Billing Name: Kochi Strikers", with multi-line addresses carried on. */
function parseLabelled(text) {
    const out = {};
    let current = null;
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = clean(raw);
        if (!line) { current = null; continue; }
        const m = line.match(/^([^:–\-=]{2,45})\s*[:–\-=]\s*(.*)$/);
        const field = m && LABELS.find(([, re]) => re.test(m[1]))?.[0];
        if (field) {
            current = field;
            if (m[2].trim()) out[field] = m[2].trim();
            continue;
        }
        // A label on its own line, answer below it.
        const bare = LABELS.find(([, re]) => re.test(line) && line.length < 45 && !/\d{3}/.test(line))?.[0];
        if (bare && !out[bare]) { current = bare; continue; }
        // The rest of an address or a name that ran onto the next line.
        if (current && /address/.test(current)) out[current] = out[current] ? `${out[current].replace(/[,\s]+$/, '')}, ${line}` : line;
        else if (current && !out[current]) out[current] = line;
    }
    return out;
}

/** What can be found by its shape, wherever it is. */
function parseShapes(text) {
    const out = {};
    const email = String(text).match(EMAIL); if (email) out.billing_email = email[0];
    const gst = String(text).match(GSTIN); if (gst) out.gst_number = gst[0].toUpperCase();
    const mobile = String(text).match(MOBILE); if (mobile) out.billing_mobile = mobile[0].replace(/\D/g, '').slice(-10);
    return out;
}

/** Ask Claude to read an unlabelled reply, when the assistant is set up. Null when it is not. */
async function parseWithClaude(text) {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    try {
        const { MODEL } = require('./wa-ai');
        const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
            body: JSON.stringify({
                model: MODEL, max_tokens: 500,
                system: 'Extract billing details from a customer message. Reply with only a JSON object with these keys, using null for anything not clearly stated: billing_name, billing_address, delivery_address, contact_person, billing_mobile, billing_email, gst_number. Never guess. If they say the delivery address is the same as billing, set delivery_address to "SAME".',
                messages: [{ role: 'user', content: String(text).slice(0, 3000) }],
            }),
            signal: AbortSignal.timeout(20000),
        });
        const data = await res.json();
        const raw = (data?.content || []).map(c => c.text || '').join('');
        const json = safeJson(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1), null);
        if (!json) return null;
        return Object.fromEntries(Object.entries(json).filter(([k, v]) => FIELDS.some(f => f.key === k) && v && String(v).trim()));
    } catch (err) {
        console.error('billing details read failed:', err.message);
        return null;
    }
}

/** Every field this reply answers. */
async function readReply(text, { asking = null } = {}) {
    const t = String(text || '').trim();
    if (!t) return {};
    // Answering the one question just asked: the whole reply is the answer.
    if (asking) {
        if (asking === 'gst_number' && SKIP.test(t)) return { gst_number: 'NA' };
        if (asking === 'delivery_address' && SAME.test(t)) return { delivery_address: 'SAME' };
        const shapes = parseShapes(t);
        if (asking === 'billing_email') return shapes.billing_email ? { billing_email: shapes.billing_email } : {};
        if (asking === 'billing_mobile') return shapes.billing_mobile ? { billing_mobile: shapes.billing_mobile } : {};
        if (asking === 'gst_number') return shapes.gst_number ? { gst_number: shapes.gst_number } : {};
        return { [asking]: t.replace(/\s*\n\s*/g, ', ') };
    }
    // Labels give the fields; the shapes give clean values for the ones that have a shape.
    let found = { ...parseLabelled(t), ...parseShapes(t) };
    const labelled = Object.keys(parseLabelled(t)).length;
    if (labelled < 2) found = { ...found, ...(await parseWithClaude(t) || {}) };
    if (found.gst_number && SKIP.test(found.gst_number)) found.gst_number = 'NA';
    if (found.delivery_address && SAME.test(found.delivery_address)) found.delivery_address = 'SAME';
    return found;
}

/* ── Running it ──────────────────────────────────────────────────────────────────────────── */

async function sendText(conversation, text) {
    const wamid = await wa.sendText(conversation.phone, text);
    await db.query(
        `INSERT INTO wa_messages (conversation_id, wamid, direction, sender_type, type, body, status)
         VALUES ($1,$2,'out','bot','text',$3,'sent')`, [conversation.id, wamid, text]);
    await db.query(
        `UPDATE wa_conversations SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = $2,
                updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [conversation.id, text.slice(0, 200)]);
}

async function requestText() {
    const r = await db.query(`SELECT value FROM wa_settings WHERE key = 'billing_request'`);
    return r.rows[0]?.value || DEFAULT_REQUEST;
}

/** Ask for the details. `user` is the rep who started it. */
async function start(conversation, user) {
    await sendText(conversation, await requestText());
    await db.query(
        `UPDATE wa_conversations SET mode = 'billing', flow_id = 'billing', flow_step = NULL, flow_data = '{}',
                assigned_to = COALESCE(assigned_to, $2), updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [conversation.id, user || null]);
}

const missing = (got) => FIELDS.filter(f => f.required && !got[f.key]);

/** Write what has been collected onto the lead. */
async function saveToLead(leadId, got) {
    const values = { ...got };
    if (values.delivery_address === 'SAME') values.delivery_address = values.billing_address || null;
    const keys = FIELDS.map(f => f.key).filter(k => values[k] != null);
    if (!leadId || !keys.length) return;
    await db.query(
        `UPDATE crewfit_leads SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [leadId, ...keys.map(k => String(values[k]).slice(0, 1000))]);
}

/**
 * A customer's reply while their details are being collected. Returns true when it was handled.
 */
async function handle(conversation, message) {
    if (conversation.mode !== 'billing') return false;
    const got = safeJson(conversation.flow_data, {});
    const asking = conversation.flow_step || null;
    // The number they are writing from is a contact number already.
    if (!got.billing_mobile && conversation.phone) got.billing_mobile = String(conversation.phone).slice(-10);
    const found = await readReply(message.body, { asking });
    Object.assign(got, Object.fromEntries(Object.entries(found).filter(([, v]) => v)));
    if (!got.contact_person && got.billing_name) got.contact_person = got.billing_name;
    await saveToLead(conversation.lead_id, got);

    const next = missing(got)[0];
    if (next) {
        const lines = [];
        const answered = Object.keys(found).length;
        if (answered && !asking) lines.push('Thank you! 🙏 Just one more thing:');
        if (next.key === 'delivery_address') lines.push(`Could you share the *Delivery Address* (with pincode)?${got.billing_address ? ' Reply “same” if it is the billing address.' : ''}`);
        else if (next.key === 'contact_person') lines.push('Could you share the *name* we should put the order under?');
        else lines.push(`Could you share the *${next.label}*?`);
        await sendText(conversation, lines.join('\n'));
        await db.query(`UPDATE wa_conversations SET flow_step = $2, flow_data = $3 WHERE id = $1`,
            [conversation.id, next.key, JSON.stringify(got)]);
        return true;
    }

    // Everything is in: read it back, and hand the chat to the rep for the payment link.
    const show = { ...got, delivery_address: got.delivery_address === 'SAME' ? got.billing_address : got.delivery_address };
    // Only what they gave: a list of dashes for the optional fields reads like a form they failed.
    const summary = ['Thank you! ✅ We have your details:', '',
        ...FIELDS.filter(f => show[f.key] && show[f.key] !== 'NA').map(f => `*${f.label.replace(/ \((optional|if applicable)\)/, '')}:* ${show[f.key]}`),
        '', 'We will share the payment link shortly 🚀'].join('\n');
    await sendText(conversation, summary);
    await db.query(
        `UPDATE wa_conversations SET mode = 'human', flow_id = NULL, flow_step = NULL, flow_data = $2,
                unread_count = unread_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [conversation.id, JSON.stringify(got)]);
    await require('./wa-orders').logActivity({ conversationId: conversation.id, kind: 'order', body: 'Billing details received — ready for the order form' });
    return true;
}

module.exports = { FIELDS, DEFAULT_REQUEST, start, handle, readReply, requestText };
