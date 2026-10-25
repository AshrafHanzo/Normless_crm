/**
 * WhatsApp voice calls.
 *
 * Meta's Calling API carries the call's signalling and nothing else: we hand it an SDP offer or
 * answer, it hands one back through the `calls` webhook, and the audio flows directly between the
 * customer's phone and the browser of whoever took the call (WebRTC: ICE, DTLS-SRTP, Opus). The
 * server never touches a byte of sound. What it does keep is the record — who called whom, who
 * answered, how long it lasted — and the one piece of state two browsers must agree on: which of
 * them picked up a ringing call.
 *
 * The rules Meta enforces, so the routes can say them before Meta refuses:
 *   - Calling must be switched on for the number (POST /{phone-number-id}/settings), and that
 *     needs a messaging limit of 2,000 a day or more. Coexistence numbers cannot use it at all.
 *   - We may only ring a customer who has said yes: a call permission request they accepted
 *     (lasts 7 days, or for good if they chose "always"), or the permission they give
 *     automatically by calling us when callback permission is on.
 *   - A permission request may be sent once a day and twice a week per customer.
 *   - A customer's call has to be answered within about 30–60 seconds or WhatsApp gives up.
 *
 * Everything here runs on the line in force (wa-line), like every other send.
 */

const db = require('../db/connection');
const wa = require('./whatsapp');
const lines = require('./wa-line');

// The Calling API arrived in Graph v23; older versions in .env must not break calls.
const VERSION = (() => {
    const v = parseFloat(String(process.env.WA_API_VERSION || 'v21.0').replace(/^v/, ''));
    return v >= 23 ? `v${v.toFixed(1)}` : 'v23.0';
})();
const graph = (path, opts = {}) => wa.graph(path, { ...opts, version: VERSION });

/** How long a call may ring before we stop showing it, whatever Meta says or fails to say. */
const RING_SECONDS = 75;

/** Meta's calling error codes, in words a rep can act on. */
const CALL_ERRORS = {
    138000: 'Calling is not switched on for this WhatsApp number yet — a manager can turn it on from the call button.',
    138001: 'This customer cannot take WhatsApp calls (not on WhatsApp, or an old app version).',
    138003: 'There is already a call going on with this customer.',
    138004: 'WhatsApp could not connect the call. Try again.',
    138005: 'This number has made too many calls for now.',
    138006: 'The customer has not allowed calls from us yet — ask them for permission first.',
    138007: 'The call timed out before it connected.',
    138009: 'A call permission request was already sent recently (WhatsApp allows one a day, two a week).',
    138012: 'WhatsApp allows 100 connected calls a day to one customer, and that has been reached.',
    138013: 'WhatsApp does not allow business-initiated calls from this number’s country.',
    138014: 'WhatsApp has paused calling on this number because of low call quality.',
    138015: 'WhatsApp will not switch calling on for this number. It needs a messaging limit of 2,000 a day or more, and cannot be a number shared with the WhatsApp Business app (Coexistence).',
    138017: 'The customer has already allowed calls permanently — you can just call.',
    // Meta: calling can't be switched on until an app on the WhatsApp account subscribes to the `calls` webhook field.
    138018: 'WhatsApp won’t switch calling on yet: in the Meta app, subscribe the webhook to the “calls” field (WhatsApp › Configuration › Webhook fields), then try again.',
    131030: 'This number is not in the test number’s allowed list.',
};

function explain(err) {
    if (err instanceof wa.WhatsAppError && CALL_ERRORS[err.code]) {
        return new wa.WhatsAppError(CALL_ERRORS[err.code], { code: err.code, status: err.status, detail: err.detail });
    }
    return err;
}
const call = async (fn) => { try { return await fn(); } catch (err) { throw explain(err); } };

/* ── Meta ─────────────────────────────────────────────────────────────────────────────────── */

/** The number's calling settings, as Meta has them. */
const settingsCache = new Map();          // brand -> { at, value }
async function getSettings({ fresh = false } = {}) {
    const brand = lines.current().brand;
    const hit = settingsCache.get(brand);
    if (!fresh && hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.value;
    const data = await call(() => graph(`/${wa.phoneNumberId()}/settings`));
    const value = data?.calling || { status: 'NOT_SET' };
    settingsCache.set(brand, { at: Date.now(), value });
    return value;
}

/**
 * Switch calling on (or off). Callback permission is switched on with it: a customer who calls
 * us may then be called back for a week without being asked.
 */
async function setEnabled(enabled) {
    const calling = enabled
        ? { status: 'ENABLED', call_icon_visibility: 'DEFAULT', callback_permission_status: 'ENABLED' }
        : { status: 'DISABLED' };
    await call(() => graph(`/${wa.phoneNumberId()}/settings`, { method: 'POST', body: { calling } }));
    settingsCache.delete(lines.current().brand);
    return getSettings({ fresh: true });
}

/** May we ring this customer, and may we ask? */
async function permission(phone) {
    const data = await call(() => graph(`/${wa.phoneNumberId()}/call_permissions?user_wa_id=${encodeURIComponent(phone)}`));
    const can = (name) => {
        const a = (data?.actions || []).find(x => x.action_name === name);
        return a ? a.can_perform_action !== false : null;
    };
    return {
        status: data?.permission?.status || 'no_permission',          // no_permission | temporary | permanent
        expires_at: data?.permission?.expiration_time
            ? new Date(Number(data.permission.expiration_time) * 1000).toISOString() : null,
        can_call: can('start_call'),
        can_ask: can('send_call_permission_request'),
    };
}

/** The "May we call you?" message, with WhatsApp's own Allow / Don't allow buttons. */
async function sendPermissionRequest(phone, text) {
    const data = await call(() => graph(`/${wa.phoneNumberId()}/messages`, {
        method: 'POST',
        body: {
            messaging_product: 'whatsapp', recipient_type: 'individual', to: phone, type: 'interactive',
            interactive: {
                type: 'call_permission_request',
                action: { name: 'call_permission_request' },
                body: { text: String(text || '').slice(0, 1024) },
            },
        },
    }));
    return data?.messages?.[0]?.id || null;
}

const action = (body) => call(() => graph(`/${wa.phoneNumberId()}/calls`, {
    method: 'POST', body: { messaging_product: 'whatsapp', ...body },
}));

/* ── The record ───────────────────────────────────────────────────────────────────────────── */

const CALL_FIELDS = `id, line_id, conversation_id, wacid, direction, status, started_by, answered_by,
                     answered_at, ended_at, duration_sec, error, created_at`;

/** What the thread and the list preview say about a call. */
function summary(c) {
    const mins = (s) => (s >= 60 ? `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ''}`.trim() : `${s} s`);
    const voice = c.direction === 'in' ? 'Voice call from customer' : 'Voice call';
    switch (c.status) {
        case 'completed': return `📞 ${voice}${c.duration_sec ? ` · ${mins(c.duration_sec)}` : ''}`;
        case 'missed': return '📞 Missed voice call';
        case 'rejected': return c.direction === 'in' ? '📞 Declined voice call' : '📞 Voice call declined';
        case 'no_answer': return '📞 Voice call · no answer';
        case 'failed': return '📞 Voice call failed';
        default: return `📞 ${voice}`;
    }
}

/** Write the call into the thread as a message, so it reads in order with the chat. */
async function addToThread(callRow) {
    const r = await db.query(
        `INSERT INTO wa_messages (conversation_id, direction, sender_type, sender_user, type, body, interactive_payload, status)
         VALUES ($1, $2, $3, $4, 'call', $5, $6, NULL) RETURNING id`,
        [callRow.conversation_id, callRow.direction, callRow.direction === 'in' ? 'customer' : 'user',
            callRow.started_by || null, summary(callRow), JSON.stringify({ kind: 'call', call_id: callRow.id })]);
    await db.query(`UPDATE wa_calls SET message_id = $2 WHERE id = $1`, [callRow.id, r.rows[0].id]);
    await db.query(
        `UPDATE wa_conversations SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = $2,
                updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [callRow.conversation_id, summary(callRow)]);
}

/** Keep the thread's line about the call in step with how the call went. */
async function refreshThread(callRow) {
    if (!callRow?.message_id) return;
    await db.query(`UPDATE wa_messages SET body = $2 WHERE id = $1`, [callRow.message_id, summary(callRow)]);
    await db.query(
        `UPDATE wa_conversations SET last_message_preview = $2
          WHERE id = $1 AND last_message_preview LIKE '📞%'`, [callRow.conversation_id, summary(callRow)]);
}

/** A business-initiated call: the row first, so the webhook always has something to find. */
async function startOutbound({ conversation, username, sdp }) {
    const row = (await db.query(
        `INSERT INTO wa_calls (line_id, conversation_id, direction, status, started_by, offer_sdp)
         VALUES ($1, $2, 'out', 'calling', $3, $4) RETURNING *`,
        [lines.current().id, conversation.id, username, sdp])).rows[0];
    try {
        const data = await action({
            to: conversation.phone, action: 'connect',
            session: { sdp_type: 'offer', sdp }, biz_opaque_callback_data: `crm-call-${row.id}`,
        });
        const wacid = data?.calls?.[0]?.id || null;
        const updated = (await db.query(
            `UPDATE wa_calls SET wacid = $2, status = CASE WHEN status = 'calling' THEN 'ringing' ELSE status END,
                    updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`, [row.id, wacid])).rows[0];
        await addToThread(updated);
        return updated;
    } catch (err) {
        await db.query(`DELETE FROM wa_calls WHERE id = $1`, [row.id]);
        throw err;
    }
}

/**
 * Take a ringing customer call. Only one person can: the row is claimed in one UPDATE, so two
 * reps pressing Answer at once cannot both talk to the customer.
 */
async function preAccept({ callId, username, sdp }) {
    const claimed = (await db.query(
        `UPDATE wa_calls SET status = 'connecting', answered_by = $2, answer_sdp = $3, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND direction = 'in' AND status = 'ringing' AND answered_by IS NULL
          RETURNING *`, [callId, username, sdp])).rows[0];
    if (!claimed) return null;
    try {
        await action({ call_id: claimed.wacid, action: 'pre_accept', session: { sdp_type: 'answer', sdp } });
    } catch (err) {
        await db.query(`UPDATE wa_calls SET status = 'failed', error = $2, ended_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [callId, err.message]);
        await refreshThread({ ...claimed, status: 'failed' });
        throw err;
    }
    return claimed;
}

/** Media is flowing on our side: tell WhatsApp to connect the customer. */
async function accept({ callRow }) {
    await action({
        call_id: callRow.wacid, action: 'accept',
        session: { sdp_type: 'answer', sdp: callRow.answer_sdp }, biz_opaque_callback_data: `crm-call-${callRow.id}`,
    });
    const row = (await db.query(
        `UPDATE wa_calls SET status = 'accepted', answered_at = COALESCE(answered_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND status IN ('connecting', 'ringing') RETURNING *`, [callRow.id])).rows[0];
    await db.query(
        `UPDATE wa_conversations SET assigned_to = COALESCE(assigned_to, $2), unread_count = 0 WHERE id = $1`,
        [callRow.conversation_id, callRow.answered_by]);
    return row || callRow;
}

async function reject({ callRow, username }) {
    await db.query(
        `UPDATE wa_calls SET status = 'rejected', answered_by = COALESCE(answered_by, $2), ended_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status IN ('ringing', 'connecting')`, [callRow.id, username]);
    await refreshThread({ ...callRow, status: 'rejected' });
    if (callRow.wacid) await action({ call_id: callRow.wacid, action: 'reject' }).catch(e => console.error('call reject:', e.message));
}

async function hangUp({ callRow }) {
    // Ended locally at once; the terminate webhook fills in Meta's own duration when it comes.
    const ended = (await db.query(
        `UPDATE wa_calls SET
                status = CASE WHEN status = 'accepted' THEN 'completed'
                              WHEN direction = 'out' THEN 'no_answer' ELSE 'missed' END,
                ended_at = CURRENT_TIMESTAMP,
                duration_sec = CASE WHEN answered_at IS NOT NULL
                                    THEN GREATEST(0, EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - answered_at))::int) END,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND ended_at IS NULL RETURNING *`, [callRow.id])).rows[0];
    if (ended) await refreshThread(ended);
    if (callRow.wacid) await action({ call_id: callRow.wacid, action: 'terminate' }).catch(e => console.error('call terminate:', e.message));
}

/* ── The webhook ──────────────────────────────────────────────────────────────────────────── */

const unix = (t) => (t ? new Date(Number(t) * 1000) : null);
const opaqueId = (s) => { const m = /^crm-call-(\d+)$/.exec(String(s || '')); return m ? Number(m[1]) : null; };

async function findCall(wacid, opaque) {
    const byOpaque = opaqueId(opaque);
    const r = await db.query(
        `SELECT * FROM wa_calls WHERE line_id = $3 AND (wacid = $1 OR id = $2) ORDER BY (wacid = $1) DESC NULLS LAST LIMIT 1`,
        [wacid || '', byOpaque || -1, lines.current().id]);
    return r.rows[0] || null;
}

/**
 * One `calls` webhook change. `threadFor(phone, name)` comes from the inbox routes, so a call
 * from a number we have never spoken to opens a thread exactly the way a first message does.
 */
async function receive(value, { threadFor }) {
    const names = new Map((value.contacts || []).map(c => [c.wa_id, c?.profile?.name || null]));

    for (const ev of value.calls || []) {
        if (!ev?.id) continue;
        const existing = await findCall(ev.id, ev.biz_opaque_callback_data);

        if (ev.event === 'connect' && ev.direction !== 'BUSINESS_INITIATED' && ev.session?.sdp_type === 'offer') {
            if (existing) continue;                          // Meta resent it
            const phone = wa.normalisePhone(ev.from);
            if (!phone) continue;
            const { conversation } = await threadFor(phone, names.get(ev.from) || null);
            const row = (await db.query(
                `INSERT INTO wa_calls (line_id, conversation_id, wacid, direction, status, offer_sdp, created_at)
                 VALUES ($1, $2, $3, 'in', 'ringing', $4, COALESCE($5, CURRENT_TIMESTAMP))
                 ON CONFLICT (wacid) DO NOTHING RETURNING *`,
                [lines.current().id, conversation.id, ev.id, ev.session.sdp, unix(ev.timestamp)])).rows[0];
            if (row) await addToThread(row);
            continue;
        }

        if (ev.event === 'connect' && ev.session?.sdp_type === 'answer') {
            if (!existing) { console.warn('whatsapp call answer for a call we did not place:', ev.id); continue; }
            await db.query(
                `UPDATE wa_calls SET answer_sdp = $2, wacid = COALESCE(wacid, $3), updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                [existing.id, ev.session.sdp, ev.id]);
            continue;
        }

        if (ev.event === 'terminate') {
            if (!existing) continue;
            const failed = String(ev.status || '').toUpperCase() === 'FAILED';
            const duration = Number.isFinite(Number(ev.duration)) ? Number(ev.duration) : null;
            const answered = !!(duration || ev.start_time || existing.answered_at);
            const err = value.errors?.[0] || ev.errors?.[0];
            const status = existing.status === 'rejected' ? 'rejected'
                : answered ? 'completed'
                : failed ? 'failed'
                : existing.direction === 'in' ? 'missed' : 'no_answer';
            const row = (await db.query(
                `UPDATE wa_calls SET status = $2, duration_sec = COALESCE($3, duration_sec),
                        answered_at = COALESCE(answered_at, $4), ended_at = COALESCE($5, ended_at, CURRENT_TIMESTAMP),
                        error = COALESCE($6, error), updated_at = CURRENT_TIMESTAMP
                  WHERE id = $1 RETURNING *`,
                [existing.id, status, duration, unix(ev.start_time), unix(ev.end_time),
                    err ? (err.error_data?.details || err.message || err.title || `Call error ${err.code}`) : null])).rows[0];
            await refreshThread(row);
            // A customer's call nobody took is something to come back to.
            if (status === 'missed') {
                await db.query(`UPDATE wa_conversations SET unread_count = unread_count + 1, status = 'open' WHERE id = $1`,
                    [row.conversation_id]);
            }
        }
    }

    // RINGING / ACCEPTED / REJECTED for the calls we place.
    for (const st of value.statuses || []) {
        if (st?.type !== 'call' || !st.id) continue;
        const existing = await findCall(st.id, st.biz_opaque_callback_data);
        if (!existing || existing.ended_at) continue;
        const s = String(st.status || '').toUpperCase();
        if (s === 'RINGING') {
            await db.query(`UPDATE wa_calls SET status = 'ringing', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'calling'`, [existing.id]);
        } else if (s === 'ACCEPTED') {
            await db.query(
                `UPDATE wa_calls SET status = 'accepted', answered_at = COALESCE(answered_at, $2, CURRENT_TIMESTAMP),
                        updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [existing.id, unix(st.timestamp)]);
        } else if (s === 'REJECTED') {
            const row = (await db.query(
                `UPDATE wa_calls SET status = 'rejected', ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP),
                        updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`, [existing.id])).rows[0];
            await refreshThread(row);
        }
    }
}

/** A customer's answer to "may we call you?", as the thread shows it. */
function describePermissionReply(reply) {
    if (!reply) return '';
    if (reply.response === 'accept') return reply.is_permanent ? '📞 Allowed calls from us (always)' : '📞 Allowed calls from us for 7 days';
    if (reply.response === 'reject') return '📞 Declined calls from us';
    return '📞 Answered the call permission request';
}

/** Ended calls Meta never told us about stop ringing after RING_SECONDS. */
async function sweepStale() {
    const r = await db.query(
        `UPDATE wa_calls SET status = CASE WHEN direction = 'in' THEN 'missed' ELSE 'no_answer' END,
                ended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE ended_at IS NULL AND status IN ('calling', 'ringing')
            AND created_at < CURRENT_TIMESTAMP - ($1 || ' seconds')::interval
          RETURNING *`, [String(RING_SECONDS)]);
    for (const row of r.rows) await refreshThread(row);
}

module.exports = {
    VERSION, RING_SECONDS, CALL_FIELDS, getSettings, setEnabled, permission, sendPermissionRequest,
    startOutbound, preAccept, accept, reject, hangUp, receive, describePermissionReply, sweepStale, summary,
};
