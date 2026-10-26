/**
 * Opener ("reopen the chat") templates: how a person on the team starts a WhatsApp chat themselves,
 * or picks one up again after the customer has been quiet for more than a day.
 *
 * WhatsApp only lets a business write freely within 24 hours of the customer's last message. To
 * message someone first — a new number from a phone call, or a customer whose order has a problem
 * — the first message has to be a template Meta approved. These are short, plain ones that name the
 * person writing and ask the customer to reply; once they do, the chat is open for 24 hours.
 *
 * Each brand has its own, on its own WhatsApp account. A manager submits them once from the inbox
 * (New chat), and Meta reviews them like any other template.
 */

const db = require('../db/connection');
const wa = require('./whatsapp');

/** Gaps are always: the customer's name, the person writing, and (when there is one) the order. */
const OPENERS = {
    crewfit: [
        {
            name: 'crewfit_follow_up', label: 'Following up on a call',
            body: 'Hi {{1}}, this is {{2}} from Crewfit, following up on our call. Reply to this message and we will share the details right here.',
            examples: ['Rahul', 'Anu'], gaps: ['name', 'me'],
        },
        {
            name: 'crewfit_enquiry_reply', label: 'Late reply to their enquiry',
            body: 'Hi {{1}}, sorry for the delay in getting back to you about your Crewfit enquiry. This is {{2}} from our team. Reply to this message and I will help you right away.',
            examples: ['Rahul', 'Anu'], gaps: ['name', 'me'],
        },
        {
            name: 'crewfit_quote_follow_up', label: 'Following up on a quote',
            body: 'Hi {{1}}, this is {{2}} from Crewfit, following up on the quote we shared with you. Reply to this message if you have any questions or would like to go ahead.',
            examples: ['Rahul', 'Anu'], gaps: ['name', 'me'],
        },
        {
            name: 'crewfit_order_update', label: 'About their order',
            body: 'Hi {{1}}, this is {{2}} from Crewfit about your order {{3}}. We need a quick word with you about it, please reply to this message.',
            examples: ['Rahul', 'Anu', 'CF-142'], gaps: ['name', 'me', 'order'],
        },
        {
            name: 'crewfit_details_needed', label: 'Need details for their order',
            body: 'Hi {{1}}, this is {{2}} from Crewfit. To go ahead with your order {{3}} we need a few details from you, such as sizes, logo or delivery address. Please reply to this message.',
            examples: ['Rahul', 'Anu', 'CF-142'], gaps: ['name', 'me', 'order'],
        },
    ],
    normless: [
        {
            name: 'normless_follow_up', label: 'Following up on a call',
            body: 'Hi {{1}}, this is {{2}} from Normless, following up on your call. Reply to this message and we will share the details right here.',
            examples: ['Meera', 'Priya'], gaps: ['name', 'me'],
        },
        {
            name: 'normless_query_reply', label: 'Late reply to their message',
            body: 'Hi {{1}}, sorry for the delay in getting back to you. This is {{2}} from Normless. Reply to this message and I will help you right away.',
            examples: ['Meera', 'Priya'], gaps: ['name', 'me'],
        },
        {
            name: 'normless_order_issue', label: 'About their order',
            body: 'Hi {{1}}, this is {{2}} from Normless about your order {{3}}. We need a quick confirmation from you, please reply to this message so we can sort it out.',
            examples: ['Meera', 'Priya', '#94182'], gaps: ['name', 'me', 'order'],
        },
        {
            name: 'normless_return_update', label: 'Return or exchange update',
            body: 'Hi {{1}}, this is {{2}} from Normless with an update on the return or exchange for your order {{3}}. Please reply to this message to continue.',
            examples: ['Meera', 'Priya', '#94182'], gaps: ['name', 'me', 'order'],
        },
        {
            name: 'normless_delivery_check', label: 'Confirm delivery details',
            body: 'Hi {{1}}, this is {{2}} from Normless. We need to confirm the delivery details for your order {{3}} before it ships. Please reply to this message.',
            examples: ['Meera', 'Priya', '#94182'], gaps: ['name', 'me', 'order'],
        },
    ],
};

/** The openers for a line, with where each stands at Meta. */
async function list(line) {
    const defs = OPENERS[line.brand] || [];
    const rows = (await db.query(
        `SELECT name, language, status FROM wa_templates WHERE line_id = $1 AND name = ANY($2)`, [line.id, defs.map(d => d.name)])).rows;
    return defs.map(d => {
        const t = rows.find(r => r.name === d.name);
        return { ...d, language: t?.language || 'en', status: t?.status || null };
    });
}

/** Submit the ones not on the account yet. Runs on the line the request is on. */
async function submit(line) {
    const out = [];
    for (const d of await list(line)) {
        if (d.status) { out.push({ name: d.name, status: d.status }); continue; }
        try {
            const created = await wa.createTemplate({ name: d.name, language: 'en', category: 'UTILITY', body: d.body, examples: d.examples });
            await db.query(
                `INSERT INTO wa_templates (name, language, category, status, body_text, variables, synced_at, line_id, meta_id, components)
                 VALUES ($1,'en','UTILITY',$2,$3,$4,CURRENT_TIMESTAMP,$5,$6,$7)
                 ON CONFLICT (line_id, name, language) DO UPDATE SET status = EXCLUDED.status, meta_id = EXCLUDED.meta_id`,
                [d.name, created.status || 'PENDING', d.body, d.gaps.length, line.id, created.id,
                    JSON.stringify([{ type: 'BODY', text: d.body, example: { body_text: [d.examples] } }])]);
            out.push({ name: d.name, status: created.status || 'PENDING' });
        } catch (err) {
            out.push({ name: d.name, status: 'FAILED', error: err.message });
        }
    }
    return out;
}

module.exports = { OPENERS, list, submit };
