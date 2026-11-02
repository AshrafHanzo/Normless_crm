/**
 * The two statuses a Crewfit lead moves to by itself.
 *
 * Need mockup: everything a designer needs is in — what product, what colour, how many, and the
 * customer's logo. The chat goes to whoever the assignment rules give mockups to.
 *
 * Important: more than 50 pieces. A big order is worth answering first.
 *
 * Both only ever move a lead forward from the early statuses; a lead somebody already took further
 * (mock completed, paid…) is never moved back. Need mockup is the later of the two, so a big lead
 * that sends its logo goes on to the designer.
 */

const db = require('../db/connection');

const EARLY = ['new', 'enquiry', 'qualified', 'followup'];
const BIG = 50;

const safeJson = (v, f) => { try { return typeof v === 'string' ? (JSON.parse(v || 'null') ?? f) : (v ?? f); } catch { return f; } };
const pieces = (q) => { const m = String(q ?? '').replace(/,/g, '').match(/\d+/); return m ? Number(m[0]) : 0; };

/** The lead's products as [{ product, color, quantity }], from the list or the single fields. */
function itemsOf(lead) {
    const list = safeJson(lead.products, []);
    if (Array.isArray(list) && list.length) return list;
    return lead.product_interest ? [{ product: lead.product_interest, color: lead.color || '', quantity: lead.quantity || '' }] : [];
}

/** How many pieces in all, counting only quantities given as numbers. */
function totalPieces(lead) {
    const items = itemsOf(lead);
    const sum = items.reduce((n, i) => n + pieces(i.quantity), 0);
    return sum || pieces(lead.quantity);
}

/** Is everything a mockup needs here? Returns what is missing, or [] when complete. */
function missingForMockup(lead) {
    const items = itemsOf(lead);
    const missing = [];
    if (!items.some(i => i.product)) missing.push('product');
    if (!items.some(i => i.color)) missing.push('colour');
    if (!items.some(i => pieces(i.quantity))) missing.push('quantity');
    if (!lead.logo_url) missing.push('logo');
    return missing;
}

/**
 * Move the lead on if it should be. Returns the new status, or null if nothing changed.
 * `conversationId` is where the change is noted (and rerouted, for a mockup).
 */
async function apply(leadId, conversationId, { told = false } = {}) {
    const lead = (await db.query('SELECT * FROM crewfit_leads WHERE id = $1', [leadId])).rows[0];
    if (!lead) return null;
    const statuses = new Set((await db.query('SELECT key FROM wa_lead_statuses')).rows.map(r => r.key));
    let next = null;
    let why = '';
    if ([...EARLY, 'important'].includes(lead.status) && statuses.has('need_mockup') && !missingForMockup(lead).length) {
        next = 'need_mockup';
        why = 'the customer sent the product, colour, quantity and their logo';
    } else if (EARLY.includes(lead.status) && statuses.has('important') && totalPieces(lead) > BIG) {
        next = 'important';
        why = `${totalPieces(lead)} pieces — more than ${BIG}`;
    }
    if (!next || next === lead.status) return null;

    await db.query('UPDATE crewfit_leads SET status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [leadId, next]);
    if (conversationId) {
        const name = (await db.query('SELECT name FROM wa_lead_statuses WHERE key = $1', [next])).rows[0]?.name || next;
        await db.query(`INSERT INTO wa_activity (conversation_id, kind, body, detail) VALUES ($1,'status',$2,$3)`,
            [conversationId, `Marked ${name} automatically — ${why}`, next]);
        // A mockup request goes to the design team, if the assignment rules say so.
        try { await require('./wa-routing').reroute(conversationId, 'lead_status', next); }
        catch (err) { console.error('lead rules reroute:', err.message); }
        // The customer hears that the designers have it.
        if (next === 'need_mockup') {
            try { await require('./cf-mockup').detailsReceived(leadId, conversationId, { told }); }
            catch (err) { console.error('need mockup notice:', err.message); }
        }
    }
    return next;
}

module.exports = { apply, itemsOf, totalPieces, missingForMockup, pieces, BIG };
