/**
 * Marketing on WhatsApp: the brands' promotional templates, and broadcasts — one template sent to
 * a list of customers.
 *
 * Templates: a starter set for each brand (a new drop, a sale, back in stock, a thank-you offer for
 * Normless; custom apparel, festive offers, a new range and repeat orders for Crewfit). Every one
 * says how to stop and carries a "Stop promotions" button, which opts the customer out of further
 * marketing on that number (order messages still go).
 *
 * Broadcasts: the audience is worked out when a broadcast is created — Shopify customers, Crewfit
 * leads and order contacts, people who have chatted, or pasted numbers — minus anybody who opted
 * out, once per number. Sending happens in the background at a steady pace, survives a restart,
 * and every message is written into that customer's chat so a reply lands with its context.
 */

const db = require('../db/connection');
const wa = require('./whatsapp');
const lines = require('./wa-line');
const links = require('./nl-links');
const shopify = require('./shopify');

const STOP_FOOTER = 'Reply STOP to opt out';
// Meta refuses a template that starts or ends on a gap, so every body here ends in words.
const EXAMPLE_CODE = 'k3Jx9aQ';

/** `gaps`: what each {{n}} is, for the broadcast form (first_name is filled per customer). */
const TEMPLATES = {
    normless: [
        {
            name: 'normless_mkt_new_drop', label: 'New drop', image: true, link: 'Shop the drop',
            body: 'Hi {{1}}, the new Normless drop is here 🔥\n\n{{2}}\n\nFresh styles in limited numbers. Grab yours before your size sells out.',
            gaps: [['first_name', 'Meera'], ['What’s in the drop', 'Oversized tees inspired by F1 legends']],
        },
        {
            name: 'normless_mkt_sale', label: 'Sale', image: true, link: 'Shop the sale',
            body: 'Hi {{1}}, the Normless sale is live! Get {{2}} off on {{3}} with code {{4}}.\n\nThe offer ends {{5}}, so grab your favourites before they sell out.',
            gaps: [['first_name', 'Meera'], ['Discount', '20%'], ['On what', 'all oversized tees'], ['Coupon code', 'NORMLESS20'], ['Ends', 'Sunday midnight']],
        },
        {
            name: 'normless_mkt_back_in_stock', label: 'Back in stock', image: true, link: 'Shop now',
            body: 'Hi {{1}}, good news: {{2}} is back in stock. Popular sizes go fast, so grab yours now.',
            gaps: [['first_name', 'Meera'], ['Product', 'the AMG Petronas oversized tee']],
        },
        {
            name: 'normless_mkt_thank_you', label: 'Thank-you offer', image: false, link: 'Shop now',
            body: 'Hi {{1}}, thank you for being a Normless customer! Here is {{2}} off your next order with code {{3}}, valid till {{4}}. We can’t wait to see you again.',
            gaps: [['first_name', 'Meera'], ['Discount', '10%'], ['Coupon code', 'THANKYOU10'], ['Valid till', '30 November']],
        },
    ],
    crewfit: [
        {
            name: 'crewfit_mkt_custom_tees', label: 'Custom apparel', image: false, replies: ['Get a free quote'],
            body: 'Hi {{1}}, planning custom T-shirts for your team, college or event? Crewfit makes printed and embroidered apparel from {{2}} pieces, delivered in {{3}} days. Tap below for a free quote.',
            gaps: [['first_name', 'Rahul'], ['Minimum pieces', '20'], ['Delivery days', '10']],
        },
        {
            name: 'crewfit_mkt_festive', label: 'Festive offer', image: false, replies: ['Get a quote'],
            body: 'Hi {{1}}, {{2}} is coming up! Get custom T-shirts, hoodies and gifts for your team with {{3}} off on orders placed this month.',
            gaps: [['first_name', 'Rahul'], ['Occasion', 'Diwali'], ['Discount', '10%']],
        },
        {
            name: 'crewfit_mkt_new_range', label: 'New range', image: false, replies: ['Send the catalogue'],
            body: 'Hi {{1}}, our new {{2}} range is here: polos, hoodies, jerseys and more, made with your logo. Tap below to see the catalogue.',
            gaps: [['first_name', 'Rahul'], ['Range', 'winter']],
        },
        {
            name: 'crewfit_mkt_reorder', label: 'Repeat order', image: false, replies: ['Reorder'],
            body: 'Hi {{1}}, it has been a while since your last Crewfit order. Need more for your team? Tap below and we will get your repeat order going.',
            gaps: [['first_name', 'Rahul']],
        },
    ],
};

/** Meta's parts for one of ours. */
function components(t, imageHandle) {
    const out = [];
    if (t.image) out.push({ type: 'HEADER', format: 'IMAGE', example: { header_handle: [imageHandle] } });
    out.push({ type: 'BODY', text: t.body, example: { body_text: [t.gaps.map(g => g[1])] } });
    out.push({ type: 'FOOTER', text: STOP_FOOTER });
    const buttons = [];
    if (t.link) buttons.push({ type: 'URL', text: t.link, url: `${links.BUTTON_BASE()}{{1}}`, example: [`${links.BUTTON_BASE()}${EXAMPLE_CODE}`] });
    for (const r of t.replies || []) buttons.push({ type: 'QUICK_REPLY', text: r });
    buttons.push({ type: 'QUICK_REPLY', text: 'Stop promotions' });
    out.push({ type: 'BUTTONS', buttons });
    return out;
}

/** Ours for a line, with where each stands at Meta. */
async function listTemplates(line) {
    const defs = TEMPLATES[line.brand] || [];
    const rows = (await db.query(
        `SELECT name, language, status FROM wa_templates WHERE line_id = $1 AND name = ANY($2)`, [line.id, defs.map(d => d.name)])).rows;
    return defs.map(d => ({ ...d, components: components(d, null), language: rows.find(r => r.name === d.name)?.language || 'en', status: rows.find(r => r.name === d.name)?.status || null }));
}

/** Submit the ones not on the account yet. Runs on the request's line. */
async function submitTemplates(line) {
    const todo = (await listTemplates(line)).filter(t => !t.status);
    let handle = null;
    if (todo.some(t => t.image)) handle = await require('./nl-template-copies').sampleHandle();
    const out = [];
    for (const t of todo) {
        try {
            const comps = components(t, handle);
            const created = await wa.graph(`/${wa.wabaId()}/message_templates`, {
                method: 'POST', body: { name: t.name, language: 'en', category: 'MARKETING', components: comps },
            });
            await db.query(
                `INSERT INTO wa_templates (name, language, category, status, body_text, variables, header_kind, synced_at, line_id, meta_id, components)
                 VALUES ($1,'en','MARKETING',$2,$3,$4,$5,CURRENT_TIMESTAMP,$6,$7,$8)
                 ON CONFLICT (line_id, name, language) DO UPDATE SET status = EXCLUDED.status, meta_id = EXCLUDED.meta_id, components = EXCLUDED.components`,
                [t.name, created?.status || 'PENDING', t.body, t.gaps.length, t.image ? 'IMAGE' : null, line.id, created?.id || null, JSON.stringify(comps)]);
            out.push({ name: t.name, status: created?.status || 'PENDING' });
        } catch (err) {
            out.push({ name: t.name, status: 'FAILED', error: err.message });
        }
    }
    return out;
}

/* ── Audiences ────────────────────────────────────────────────────────────────────────────── */

const last10 = (v) => String(v || '').replace(/\D+/g, '').slice(-10);
const firstName = (n) => {
    const f = String(n || '').replace(/^~/, '').trim().split(/\s+/)[0] || '';
    return f ? f.charAt(0).toUpperCase() + f.slice(1).toLowerCase() : '';
};

/**
 * Who a broadcast goes to. `a` = { source, min_orders, ordered_within_days, not_ordered_days,
 * min_spent, statuses, numbers }. Returns [{ phone, name }] — opted-out numbers and repeats removed.
 */
async function audience(line, a = {}) {
    const people = [];
    const source = a.source;
    if (source === 'customers' && line.brand === 'normless') {
        const params = [];
        const where = [`COALESCE(c.phone, '') <> ''`];
        if (Number(a.min_orders) > 0) { params.push(Number(a.min_orders)); where.push(`c.orders_count >= $${params.length}`); }
        if (Number(a.min_spent) > 0) { params.push(Number(a.min_spent)); where.push(`c.total_spent >= $${params.length}`); }
        if (Number(a.ordered_within_days) > 0) {
            params.push(Number(a.ordered_within_days));
            where.push(`EXISTS (SELECT 1 FROM orders o WHERE o.customer_shopify_id = c.shopify_id AND o.created_at > NOW() - ($${params.length} || ' days')::interval)`);
        }
        if (Number(a.not_ordered_days) > 0) {
            params.push(Number(a.not_ordered_days));
            where.push(`c.orders_count > 0 AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_shopify_id = c.shopify_id AND o.created_at > NOW() - ($${params.length} || ' days')::interval)`);
        }
        const rows = (await db.query(`SELECT c.phone, TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) AS name FROM customers c WHERE ${where.join(' AND ')}`, params)).rows;
        people.push(...rows);
    } else if (source === 'leads' && line.brand === 'crewfit') {
        const statuses = (Array.isArray(a.statuses) ? a.statuses : []).filter(Boolean);
        const rows = (await db.query(
            `SELECT phone, COALESCE(contact_person, name) AS name FROM crewfit_leads
              WHERE COALESCE(phone, '') <> '' ${statuses.length ? 'AND status = ANY($1)' : ''}`, statuses.length ? [statuses] : [])).rows;
        people.push(...rows);
    } else if (source === 'customers' && line.brand === 'crewfit') {
        const rows = (await db.query(
            `SELECT DISTINCT ON (RIGHT(REGEXP_REPLACE(COALESCE(whatsapp_number, contact_number, billing_mobile, ''), '\\D', '', 'g'), 10))
                    COALESCE(whatsapp_number, contact_number, billing_mobile) AS phone, COALESCE(contact_person, customer_name) AS name
               FROM crewfit_orders WHERE COALESCE(whatsapp_number, contact_number, billing_mobile, '') <> '' AND COALESCE(status, '') <> 'Cancelled'
              ORDER BY RIGHT(REGEXP_REPLACE(COALESCE(whatsapp_number, contact_number, billing_mobile, ''), '\\D', '', 'g'), 10), order_date DESC`)).rows;
        people.push(...rows);
    } else if (source === 'chatted') {
        const params = [line.id];
        let extra = '';
        if (Number(a.chatted_within_days) > 0) {
            params.push(Number(a.chatted_within_days));
            extra = `AND EXISTS (SELECT 1 FROM wa_conversations c WHERE c.contact_id = k.id AND c.last_inbound_at > NOW() - ($2 || ' days')::interval)`;
        }
        const rows = (await db.query(`SELECT k.phone, k.profile_name AS name FROM wa_contacts k WHERE k.line_id = $1 AND k.phone <> '910000000000' ${extra}`, params)).rows;
        people.push(...rows);
    } else if (source === 'numbers') {
        for (const raw of String(a.numbers || '').split(/\n+/)) {
            const [p, ...rest] = raw.split(/[,\t;]/);
            if (p && p.trim()) people.push({ phone: p.trim(), name: rest.join(' ').trim() });
        }
    }

    // One per number (by its last ten digits), never anybody who said STOP on this line.
    const stopped = new Set((await db.query(
        `SELECT phone FROM wa_contacts WHERE line_id = $1 AND opted_out_at IS NOT NULL`, [line.id])).rows.map(r => last10(r.phone)));
    const seen = new Set();
    const out = [];
    let optedOut = 0;
    for (const p of people) {
        const phone = wa.normalisePhone(p.phone);
        const key = last10(phone);
        if (!phone || key.length < 10 || phone.length > 15 || seen.has(key)) continue;
        seen.add(key);
        if (stopped.has(key)) { optedOut++; continue; }
        out.push({ phone, name: String(p.name || '').trim().slice(0, 120) || null });
    }
    out.optedOut = optedOut;
    return out;
}

/* ── Broadcasts ───────────────────────────────────────────────────────────────────────────── */

const SEND_PER_TICK = 8;          // every second: well under Meta's throughput, gentle on quality
const SHAPE = `id, line_id, name, template, language, vars, header_image, link_url, audience, status, total, sent, failed,
               skipped, created_by, created_at, started_at, finished_at, error`;
const safeJson = (v, f) => { try { return typeof v === 'string' ? (JSON.parse(v || 'null') ?? f) : (v ?? f); } catch { return f; } };
const shape = (b) => b && ({ ...b, vars: safeJson(b.vars, []), audience: safeJson(b.audience, {}) });

async function templateRow(lineId, key) {
    const [name, language] = String(key || '').split('|');
    const t = (await db.query(
        `SELECT name, language, category, status, body_text, variables, components FROM wa_templates WHERE line_id = $1 AND name = $2 AND language = $3`,
        [lineId, name, language || 'en'])).rows[0];
    if (!t) return null;
    const comps = safeJson(t.components, []);
    return { ...t, header: comps.find(c => c.type === 'HEADER') || null, buttons: comps.find(c => c.type === 'BUTTONS')?.buttons || [] };
}

/** What gets sent to one person: the gaps filled, the photo, the link and the opt-out button. */
async function message(b, t, person, broadcastId) {
    const vars = safeJson(b.vars, []);
    const variables = Array.from({ length: t.variables || 0 }, (_, i) => {
        const v = vars[i] || {};
        return v.source === 'first_name' ? (firstName(person.name) || v.fallback || 'there') : String(v.value || '');
    });
    const empty = variables.findIndex(v => !String(v).trim());
    if (empty >= 0) throw new Error(`Nothing to put in {{${empty + 1}}}`);
    const buttons = [];
    for (const [index, btn] of t.buttons.entries()) {
        if (btn.type === 'URL' && /\{\{1\}\}/.test(btn.url || '')) {
            const dest = b.link_url || (lines.current().brand === 'normless' ? 'https://normless.store' : null);
            if (!dest) throw new Error('This template has a link button — say where it goes');
            buttons.push({ index, text: String(btn.url).startsWith(links.BUTTON_BASE()) ? await links.shorten(dest, { kind: 'broadcast', ref: broadcastId }) : dest });
        } else if (btn.type === 'QUICK_REPLY') {
            buttons.push({ index, payload: /stop/i.test(btn.text || '') ? 'optout' : `bcast:${broadcastId}` });
        }
    }
    if (t.header?.format === 'IMAGE' && !b.header_image) throw new Error('This template has a photo — choose one');
    return { variables, headerImage: t.header?.format === 'IMAGE' ? b.header_image : null, buttons };
}

/** Create a broadcast (a draft) with its recipients worked out now. */
async function create(line, input, user) {
    const t = await templateRow(line.id, input.template);
    if (!t) throw Object.assign(new Error('That template isn’t on this account — sync templates'), { status: 400 });
    if (t.status !== 'APPROVED') throw Object.assign(new Error(`Meta has that template as ${String(t.status).toLowerCase()}`), { status: 400 });
    const people = await audience(line, input.audience || {});
    if (!people.length) throw Object.assign(new Error('Nobody in that audience (after removing repeats and people who said STOP)'), { status: 400 });
    if (people.length > 50000) throw Object.assign(new Error('That is more than 50,000 people — narrow the audience'), { status: 400 });
    const vars = (Array.isArray(input.vars) ? input.vars : []).slice(0, 10).map(v => ({
        source: v?.source === 'first_name' ? 'first_name' : 'text', value: String(v?.value || '').slice(0, 200), fallback: String(v?.fallback || '').slice(0, 40),
    }));
    const link = /^https:\/\//.test(String(input.link_url || '')) ? String(input.link_url).slice(0, 1000) : null;
    const image = /^https:\/\//.test(String(input.header_image || '')) ? String(input.header_image).slice(0, 1000) : null;
    // Try one message's parts before anything is saved: a gap left empty fails here, not 5,000 times.
    await message({ vars: JSON.stringify(vars), link_url: link, header_image: image }, t, { name: 'Test' }, 0);
    return db.transaction(async (c) => {
        const b = (await c.query(
            `INSERT INTO wa_broadcasts (line_id, name, template, language, vars, header_image, link_url, audience, status, total, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9,$10) RETURNING ${SHAPE}`,
            [line.id, String(input.name || t.name).slice(0, 120), t.name, t.language, JSON.stringify(vars), image, link,
                JSON.stringify({ ...(input.audience || {}), opted_out: people.optedOut || 0 }), people.length, user || null])).rows[0];
        for (let i = 0; i < people.length; i += 1000) {
            const chunk = people.slice(i, i + 1000);
            await c.query(
                `INSERT INTO wa_broadcast_recipients (broadcast_id, phone, name)
                 SELECT $1, x.phone, x.name FROM json_to_recordset($2::json) AS x(phone text, name text)`,
                [b.id, JSON.stringify(chunk)]);
        }
        return shape(b);
    });
}

/** Send one to a single number (your own) to see it on a phone first. Nothing is recorded. */
async function testSend(line, input, phone) {
    const t = await templateRow(line.id, input.template);
    if (!t || t.status !== 'APPROVED') throw Object.assign(new Error('Pick an approved template first'), { status: 400 });
    const to = wa.normalisePhone(phone);
    if (!to) throw Object.assign(new Error('Which number should the test go to?'), { status: 400 });
    const m = await message({ vars: JSON.stringify(input.vars || []), link_url: input.link_url, header_image: input.header_image }, t, { name: input.test_name || '' }, 0);
    return wa.sendTemplate(to, { name: t.name, language: t.language, ...m });
}

async function start(lineId, id) {
    const r = await db.query(
        `UPDATE wa_broadcasts SET status = 'sending', started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
          WHERE id = $1 AND line_id = $2 AND status IN ('draft', 'paused') RETURNING ${SHAPE}`, [id, lineId]);
    return shape(r.rows[0]);
}
async function pause(lineId, id) {
    const r = await db.query(`UPDATE wa_broadcasts SET status = 'paused' WHERE id = $1 AND line_id = $2 AND status = 'sending' RETURNING ${SHAPE}`, [id, lineId]);
    return shape(r.rows[0]);
}
async function cancel(lineId, id) {
    const r = await db.query(
        `UPDATE wa_broadcasts SET status = 'cancelled', finished_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND line_id = $2 AND status IN ('draft', 'sending', 'paused') RETURNING ${SHAPE}`, [id, lineId]);
    if (r.rows[0]) await db.query(`UPDATE wa_broadcast_recipients SET status = 'cancelled' WHERE broadcast_id = $1 AND status = 'pending'`, [id]);
    return shape(r.rows[0]);
}

/** A broadcast with how it went: sent, delivered, read, replied, failed. */
async function report(lineId, id) {
    const b = shape((await db.query(`SELECT ${SHAPE} FROM wa_broadcasts WHERE id = $1 AND line_id = $2`, [id, lineId])).rows[0]);
    if (!b) return null;
    const counts = (await db.query(
        `SELECT COUNT(*) FILTER (WHERE r.status = 'sent')::int AS sent,
                COUNT(*) FILTER (WHERE r.status = 'failed')::int AS failed,
                COUNT(*) FILTER (WHERE r.status = 'pending')::int AS pending,
                COUNT(*) FILTER (WHERE m.status IN ('delivered', 'read'))::int AS delivered,
                COUNT(*) FILTER (WHERE m.status = 'read')::int AS read,
                COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM wa_messages i WHERE i.conversation_id = r.conversation_id AND i.direction = 'in' AND i.created_at > r.sent_at))::int AS replied
           FROM wa_broadcast_recipients r LEFT JOIN wa_messages m ON m.wamid = r.wamid
          WHERE r.broadcast_id = $1`, [id])).rows[0];
    const errors = (await db.query(
        `SELECT error, COUNT(*)::int AS n FROM wa_broadcast_recipients WHERE broadcast_id = $1 AND status = 'failed' GROUP BY 1 ORDER BY 2 DESC LIMIT 5`, [id])).rows;
    const taps = (await db.query(`SELECT COALESCE(SUM(clicks), 0)::int AS n FROM nl_links WHERE kind = 'broadcast' AND ref = $1`, [String(id)])).rows[0].n;
    return { ...b, counts: { ...counts, taps }, errors };
}

async function list(lineId) {
    return (await db.query(`SELECT ${SHAPE} FROM wa_broadcasts WHERE line_id = $1 ORDER BY id DESC LIMIT 50`, [lineId])).rows.map(shape);
}

/** The chat for a number on this line, made quietly (closed, unassigned) if there isn't one. */
async function threadFor(lineId, phone, name) {
    return db.transaction(async (c) => {
        const k = (await c.query(
            `INSERT INTO wa_contacts (line_id, phone, profile_name) VALUES ($1,$2,$3)
             ON CONFLICT (line_id, phone) DO UPDATE SET profile_name = COALESCE(wa_contacts.profile_name, EXCLUDED.profile_name)
             RETURNING id`, [lineId, phone, name || null])).rows[0];
        const conv = (await c.query(`SELECT id FROM wa_conversations WHERE contact_id = $1`, [k.id])).rows[0];
        if (conv) return conv;
        // A broadcast isn't a conversation yet: it waits closed until they reply.
        return (await c.query(
            `INSERT INTO wa_conversations (contact_id, line_id, status) VALUES ($1,$2,'closed') RETURNING id`, [k.id, lineId])).rows[0];
    });
}

/** One tick of sending, for every broadcast that is going. */
let busy = false;
async function tick() {
    if (busy) return;
    busy = true;
    try {
        const going = (await db.query(`SELECT ${SHAPE} FROM wa_broadcasts WHERE status = 'sending' ORDER BY id`)).rows;
        for (const b of going) {
            const brand = ['crewfit', 'normless'].find(x => lines.get(x)?.id === b.line_id);
            if (!brand) continue;
            await lines.run(brand, async () => {
                const t = await templateRow(b.line_id, `${b.template}|${b.language}`);
                if (!t || t.status !== 'APPROVED') {
                    await db.query(`UPDATE wa_broadcasts SET status = 'paused', error = $2 WHERE id = $1`, [b.id, `The template is ${t ? String(t.status).toLowerCase() : 'gone'} at Meta`]);
                    return;
                }
                const batch = (await db.query(
                    `UPDATE wa_broadcast_recipients SET status = 'sending'
                      WHERE id IN (SELECT id FROM wa_broadcast_recipients WHERE broadcast_id = $1 AND status = 'pending' ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)
                      RETURNING id, phone, name`, [b.id, SEND_PER_TICK])).rows;
                if (!batch.length) {
                    await db.query(
                        `UPDATE wa_broadcasts SET status = 'done', finished_at = CURRENT_TIMESTAMP,
                                sent = (SELECT COUNT(*) FROM wa_broadcast_recipients WHERE broadcast_id = $1 AND status = 'sent'),
                                failed = (SELECT COUNT(*) FROM wa_broadcast_recipients WHERE broadcast_id = $1 AND status = 'failed')
                          WHERE id = $1 AND status = 'sending'`, [b.id]);
                    return;
                }
                await Promise.all(batch.map(async (p) => {
                    try {
                        const opted = (await db.query(`SELECT 1 FROM wa_contacts WHERE line_id = $1 AND phone = $2 AND opted_out_at IS NOT NULL`, [b.line_id, p.phone])).rows[0];
                        if (opted) {
                            await db.query(`UPDATE wa_broadcast_recipients SET status = 'skipped', error = 'Opted out' WHERE id = $1`, [p.id]);
                            return;
                        }
                        const m = await message(b, t, p, b.id);
                        const wamid = await wa.sendTemplate(p.phone, { name: t.name, language: t.language, ...m });
                        const conv = await threadFor(b.line_id, p.phone, p.name);
                        const body = wa.renderTemplate(t.body_text, m.variables);
                        await db.query(
                            `INSERT INTO wa_messages (conversation_id, wamid, direction, sender_type, sender_user, type, body, media_url, media_mime, status)
                             VALUES ($1,$2,'out','auto',$3,'template',$4,$5,$6,'sent')`,
                            [conv.id, wamid, b.created_by, body, m.headerImage, m.headerImage ? 'image/jpeg' : null]);
                        await db.query(`UPDATE wa_conversations SET last_message_preview = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [conv.id, `📣 ${body}`.slice(0, 200)]);
                        await db.query(
                            `UPDATE wa_broadcast_recipients SET status = 'sent', wamid = $2, conversation_id = $3, sent_at = CURRENT_TIMESTAMP WHERE id = $1`,
                            [p.id, wamid, conv.id]);
                    } catch (err) {
                        await db.query(`UPDATE wa_broadcast_recipients SET status = 'failed', error = $2 WHERE id = $1`, [p.id, String(err.message).slice(0, 300)]);
                    }
                }));
                await db.query(
                    `UPDATE wa_broadcasts SET
                        sent = (SELECT COUNT(*) FROM wa_broadcast_recipients WHERE broadcast_id = $1 AND status = 'sent'),
                        failed = (SELECT COUNT(*) FROM wa_broadcast_recipients WHERE broadcast_id = $1 AND status = 'failed'),
                        skipped = (SELECT COUNT(*) FROM wa_broadcast_recipients WHERE broadcast_id = $1 AND status = 'skipped')
                      WHERE id = $1`, [b.id]);
            });
        }
    } catch (err) {
        console.error('whatsapp broadcast tick:', err.message);
    } finally {
        busy = false;
    }
}

let timer = null;
function startWorker() {
    if (timer) return;
    // Anything left "sending" by a crash goes back in the queue.
    db.query(`UPDATE wa_broadcast_recipients SET status = 'pending' WHERE status = 'sending'`).catch(() => {});
    timer = setInterval(tick, 1000);
    timer.unref();
}

module.exports = {
    TEMPLATES, components, listTemplates, submitTemplates, audience,
    create, testSend, start, pause, cancel, report, list, tick, startWorker,
};
