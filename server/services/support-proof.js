/**
 * Proof the team shares with the customer on a support ticket: photos of what was raised with
 * Delhivery, a courier's reply, a QC result. The operations team uploads them on the ticket and they
 * go to the customer by themselves, with a short message the AI words from the team's note:
 *
 * - WhatsApp, inside the 24-hour window: the photos, the first one captioned with the message.
 * - WhatsApp, outside it: the approved "ticket update" template says there is an update, and the
 *   photos are sent the moment the customer writes back.
 * - Email, when the ticket came by email: one reply with the photos attached.
 */

const fs = require('fs');
const path = require('path');
const db = require('../db/connection');
const wa = require('./whatsapp');
const lines = require('./wa-line');

const ROOT = path.join(__dirname, '..', 'uploads', 'support');
const ref = (t) => `CS-${String(t.ref_no ?? 0).padStart(4, '0')}`;
const subjectOf = (t) => `${String(t.reason || 'your request').toLowerCase()}${t.order_number ? ` on order ${t.order_number}` : ''}`;
const fileOf = (url) => path.join(ROOT, url.replace(/^\/uploads\/support\//, ''));
const last10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);

/** The Normless chat for a ticket: its own, or the one with the customer's number. */
async function chatFor(ticket) {
    const line = lines.get('normless');
    if (!line?.id) return null;
    const q = `SELECT c.id, c.last_inbound_at, k.phone FROM wa_conversations c JOIN wa_contacts k ON k.id = c.contact_id WHERE c.line_id = $1 AND `;
    if (ticket.wa_conversation_id) {
        const c = (await db.query(`${q} c.id = $2`, [line.id, ticket.wa_conversation_id])).rows[0];
        if (c) return c;
    }
    const p = last10(ticket.customer_phone);
    return p.length === 10 ? (await db.query(`${q} RIGHT(k.phone, 10) = $2 ORDER BY c.last_message_at DESC NULLS LAST LIMIT 1`, [line.id, p])).rows[0] || null : null;
}

/** The customer-facing words: the team's note made warm by the AI, or a plain default. */
async function messageFor(ticket, note) {
    const raw = String(note || '').trim();
    if (!raw) return `Here is the proof for your ticket ${ref(ticket)} (${subjectOf(ticket)}).`;
    const words = await require('./nl-agent').polish(raw, { ref: ref(ticket), subject: subjectOf(ticket) });
    return `Update on your ticket ${ref(ticket)}: ${words}`;
}

/** Send these proof rows on WhatsApp now (the window is open). */
async function sendWhatsApp(conv, ticket, proofs, message) {
    let first = true;
    for (const p of proofs) {
        const caption = first ? message.slice(0, 1024) : '';
        try {
            const sent = await wa.sendMedia(conv.phone, { filePath: fileOf(p.url), mime: p.mime, filename: p.name || path.basename(p.url), caption });
            await db.query(
                `INSERT INTO wa_messages (conversation_id, wamid, direction, sender_type, sender_user, type, body, media_url, media_mime, status)
                 VALUES ($1,$2,'out','ai','ai-agent','image',$3,$4,$5,'sent')`, [conv.id, sent.wamid, caption, p.url, p.mime]);
            await db.query(`UPDATE support_ticket_proofs SET wa_status = 'sent', wa_sent_at = now(), wa_error = NULL WHERE id = $1`, [p.id]);
            first = false;
        } catch (err) {
            await db.query(`UPDATE support_ticket_proofs SET wa_status = 'failed', wa_error = $2 WHERE id = $1`, [p.id, String(err.message).slice(0, 300)]);
        }
    }
    if (!first) {
        await db.query(`UPDATE wa_conversations SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = $2 WHERE id = $1`,
            [conv.id, `Shared proof for ${ref(ticket)}`]);
        await db.query(`INSERT INTO wa_activity (conversation_id, kind, body, actor) VALUES ($1,'ticket',$2,'ai-agent')`,
            [conv.id, `Shared ${proofs.length} proof photo${proofs.length > 1 ? 's' : ''} for ${ref(ticket)}`]);
    }
}

/**
 * Deliver proof rows that haven't gone yet. Called right after the team uploads them, and again
 * when a customer whose photos were waiting writes to us. Never throws.
 */
async function deliver(ticketId) {
    const out = {};
    try {
        const ticket = (await db.query(`SELECT * FROM support_tickets WHERE id = $1`, [ticketId])).rows[0];
        if (!ticket) return out;
        const fresh = (await db.query(
            `SELECT * FROM support_ticket_proofs WHERE ticket_id = $1 AND (wa_status IS NULL OR wa_status IN ('waiting','failed') OR email_status IS NULL) ORDER BY id`, [ticketId])).rows;
        if (!fresh.length) return out;
        const note = fresh.map(p => p.note).filter(Boolean).pop() || null;
        const message = await messageFor(ticket, note);

        // WhatsApp
        const toWa = fresh.filter(p => p.wa_status === null || p.wa_status === 'waiting' || p.wa_status === 'failed');
        if (toWa.length) {
            const conv = await chatFor(ticket);
            if (!conv) {
                await db.query(`UPDATE support_ticket_proofs SET wa_status = 'none' WHERE id = ANY($1)`, [toWa.map(p => p.id)]);
                out.whatsapp = 'no WhatsApp chat for this customer';
            } else if (wa.windowOpen(conv.last_inbound_at)) {
                await sendWhatsApp(conv, ticket, toWa, message);
                out.whatsapp = 'sent';
            } else if (toWa.some(p => p.wa_status === null)) {
                // Outside 24 hours only the approved template can go: it says there is an update; the
                // photos follow when they reply.
                const tpl = await require('./nl-automations').ticketUpdated(ticket,
                    'our team has shared proof photos for your ticket. Reply to this message to see them').catch(err => ({ status: 'failed', error: err.message }));
                await db.query(`UPDATE support_ticket_proofs SET wa_status = 'waiting', wa_error = $2 WHERE id = ANY($1)`,
                    [toWa.filter(p => p.wa_status === null).map(p => p.id), tpl?.error ? String(tpl.error).slice(0, 300) : null]);
                out.whatsapp = 'waiting for the customer to reply';
            }
        }

        // Email: only where the ticket came by email (a reply in that thread)
        const toMail = fresh.filter(p => p.email_status === null);
        if (toMail.length) {
            if (!ticket.email_thread_id) {
                await db.query(`UPDATE support_ticket_proofs SET email_status = 'none' WHERE id = ANY($1)`, [toMail.map(p => p.id)]);
            } else {
                const first = String(ticket.customer_name || '').trim().split(/\s+/)[0];
                const hi = first ? first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() : 'there';
                const body = `Hi ${hi},\n\n${message}\n\nThe photos are attached. If you have any questions, just reply to this email.\n\nWarm regards,\nTeam Normless`;
                try {
                    await require('./email-inbox').reply(ticket.email_thread_id, body, { type: 'ai', user: 'ticket-proof' },
                        toMail.map(p => ({ path: fileOf(p.url), filename: p.name || path.basename(p.url), mime: p.mime, url: p.url })));
                    await db.query(`UPDATE support_ticket_proofs SET email_status = 'sent', email_sent_at = now() WHERE id = ANY($1)`, [toMail.map(p => p.id)]);
                    out.email = 'sent';
                } catch (err) {
                    await db.query(`UPDATE support_ticket_proofs SET email_status = 'failed' WHERE id = ANY($1)`, [toMail.map(p => p.id)]);
                    out.email = `failed: ${err.message}`;
                }
            }
        }
        return out;
    } catch (err) {
        console.error('support proof delivery:', err.message);
        return { ...out, error: err.message };
    }
}

/** A customer wrote: photos that were waiting for the window to open go now. */
async function customerWrote(conversationId, phone) {
    const p = last10(phone);
    const r = await db.query(
        `SELECT DISTINCT t.id FROM support_ticket_proofs x JOIN support_tickets t ON t.id = x.ticket_id
          WHERE x.wa_status = 'waiting' AND (t.wa_conversation_id = $1 OR RIGHT(regexp_replace(COALESCE(t.customer_phone, ''), '\\D', '', 'g'), 10) = $2)`,
        [conversationId, p]);
    for (const { id } of r.rows) await deliver(id);
}

/** The proof rows for a ticket, for the drawer. */
async function list(ticketId) {
    return (await db.query(
        `SELECT id, url, name, mime, note, uploaded_by, created_at, wa_status, wa_sent_at, wa_error, email_status, email_sent_at
           FROM support_ticket_proofs WHERE ticket_id = $1 ORDER BY id`, [ticketId])).rows;
}

/** Save uploaded files (already on disk in the ticket's folder) as proof rows. */
async function add(ticketId, files, { note, by }) {
    for (const f of files) {
        await db.query(
            `INSERT INTO support_ticket_proofs (ticket_id, url, name, mime, note, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6)`,
            [ticketId, `/uploads/support/${ticketId}/${f.filename}`, f.originalname || f.filename, f.mimetype, String(note || '').trim().slice(0, 1000) || null, by || null]);
    }
}

/** Remove one that hasn't been sent anywhere yet. */
async function remove(ticketId, proofId) {
    const p = (await db.query(`SELECT * FROM support_ticket_proofs WHERE id = $1 AND ticket_id = $2`, [proofId, ticketId])).rows[0];
    if (!p) throw Object.assign(new Error('That photo is gone'), { status: 404 });
    if (p.wa_status === 'sent' || p.email_status === 'sent') throw Object.assign(new Error('Already sent to the customer'), { status: 409 });
    await db.query(`DELETE FROM support_ticket_proofs WHERE id = $1`, [p.id]);
    fs.unlink(fileOf(p.url), () => {});
}

module.exports = { add, deliver, list, remove, customerWrote };
