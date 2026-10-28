/**
 * Handing a Normless chat to a person.
 *
 * The bot answers everything it can. When it can't — a refund, a damaged parcel, an upset
 * customer, a question it has no grounded answer to — the chat goes to somebody on the Normless
 * team — chosen as Settings › Assignment says, or left for someone to take — and the customer is told who:
 * "Hi Meera, this is Priya from the Normless team…". The same introduction is sent whenever a
 * person takes a chat or a manager hands it to someone, so the customer always knows who they are
 * talking to.
 *
 * Everything here runs on Normless's line; the caller is already inside it.
 */

const db = require('../db/connection');
const wa = require('./whatsapp');
const lines = require('./wa-line');
const { readSettings, isOpen, clock } = require('./nl-settings');

const DEMO_PHONE = '910000000000';

/**
 * The name a customer sees for a person: their WhatsApp display name when one was set in
 * Settings › Team, otherwise taken from their login — "priya.s@normless.store" becomes "Priya".
 */
function displayName(user) {
    if (user?.wa_display_name) return String(user.wa_display_name).trim();
    const local = String(user?.username || '').split('@')[0];
    const first = local.split(/[._\-+\s]/)[0].replace(/\d+/g, '') || local;
    return first ? first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() : 'our team';
}

async function userByName(username) {
    if (!username) return null;
    return (await db.query(
        `SELECT username, wa_display_name FROM admin_users WHERE LOWER(username) = LOWER($1)`, [username])).rows[0] || null;
}

/**
 * Who gets a chat the bot hands over, as Settings › Assignment says: nobody when it is set to
 * manual; otherwise someone with the Normless inbox grant (owners and admins only when they have
 * been given it too, so the founders' inboxes don't fill with returns) who hasn't been switched
 * off and isn't at their cap — the one with the fewest open Normless chats, or for round robin
 * whoever was handed one longest ago.
 */
async function pickAgent(lineId) {
    const { assignment } = await readSettings(lineId);
    if (assignment.mode === 'manual') return null;
    const order = assignment.mode === 'round_robin'
        ? 'last_given ASC NULLS FIRST, LOWER(username) ASC'
        : 'open_chats ASC, last_given ASC NULLS FIRST, LOWER(username) ASC';
    const r = await db.query(
        `SELECT * FROM (
            SELECT u.username, u.wa_display_name,
                   (SELECT COUNT(*) FROM wa_conversations c
                     WHERE c.line_id = $1 AND c.status = 'open' AND LOWER(c.assigned_to) = LOWER(u.username)) AS open_chats,
                   (SELECT MAX(a.created_at) FROM wa_activity a JOIN wa_conversations c ON c.id = a.conversation_id
                     WHERE c.line_id = $1 AND a.kind = 'assign' AND a.body ILIKE '%' || u.username || '%') AS last_given
              FROM admin_users u
             WHERE COALESCE(u.is_active, true) = true AND COALESCE(u.can_view_wa_normless, false) = true
               AND NOT (LOWER(u.username) = ANY($2::text[]))) t
          WHERE ($3::jsonb ->> LOWER(username)) IS NULL OR open_chats < ($3::jsonb ->> LOWER(username))::int
          ORDER BY ${order}
          LIMIT 1`, [lineId, assignment.off || [], JSON.stringify(assignment.caps || {})]);
    return r.rows[0] || null;
}

/** Write down something the business sent automatically, and move the thread on. */
async function record(conversationId, wamid, body, sender = 'auto') {
    await db.query(
        `INSERT INTO wa_messages (conversation_id, wamid, direction, sender_type, type, body, status)
         VALUES ($1,$2,'out',$3,'text',$4,'sent')`, [conversationId, wamid, sender, body]);
    await db.query(
        `UPDATE wa_conversations SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = $2,
                updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [conversationId, String(body).slice(0, 200)]);
}

async function logActivity(conversationId, kind, body, actor = null) {
    await db.query(
        `INSERT INTO wa_activity (conversation_id, kind, body, actor) VALUES ($1,$2,$3,$4)`,
        [conversationId, kind, body, actor]);
}

/** Send a line to the customer if WhatsApp allows it now. Never throws: the assignment stands. */
async function tell(conversation, body) {
    if (conversation.phone === DEMO_PHONE || !wa.windowOpen(conversation.last_inbound_at)) return false;
    try {
        const wamid = await wa.sendText(conversation.phone, body);
        await record(conversation.id, wamid, body, 'auto');
        return true;
    } catch (err) {
        console.error('normless handover message failed:', err.message);
        return false;
    }
}

const firstName = (conversation) => String(conversation.customer_name || conversation.profile_name || '')
    .replace(/^~/, '').trim().split(/\s+/)[0] || '';

/**
 * Give a chat to a person and introduce them. `introduce: false` when the person asked for it
 * silently (a manager reshuffling the queue after hours, say). Returns the person's display name.
 */
async function assign(conversation, username, { actor = null, introduce = true } = {}) {
    const user = await userByName(username);
    const name = displayName(user || { username });
    await db.query(
        `UPDATE wa_conversations SET assigned_to = $2, mode = 'human', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [conversation.id, user?.username || username]);
    await logActivity(conversation.id, 'assign',
        `${actor ? `${String(actor).split('@')[0]} gave` : 'Handed'} the chat to ${name} (${user?.username || username})`, actor);
    if (introduce) {
        const settings = await readSettings(lines.current().id);
        const open = isOpen(settings.hours);
        const hi = firstName(conversation);
        await tell(conversation, open
            ? `Hi${hi ? ` ${hi}` : ''}, this is ${name} from the Normless team. I'm looking into this for you now.`
            : `Hi${hi ? ` ${hi}` : ''}, this is ${name} from the Normless team. We're offline right now — I'll reply here from ${clock(settings.hours.start)} tomorrow.`);
    }
    return name;
}

/**
 * The bot stops and a person takes over. The reason and the bot's summary are left as a note for
 * them; the chat goes to the next person on the team (Settings › Assignment), who is introduced
 * to the customer. With assignment set to manual, or nobody to give it to, it waits in "Needs a
 * person" and the customer is told someone will reply.
 */
async function handOver(conversation, { reason, summary = null }) {
    await db.query(
        `UPDATE wa_conversations SET mode = 'human', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [conversation.id]);
    await db.query(
        `INSERT INTO wa_notes (conversation_id, author, body) VALUES ($1,'bot',$2)`,
        [conversation.id, `Bot handed this over — ${String(reason).slice(0, 200)}${summary ? `\n${String(summary).slice(0, 1500)}` : ''}`]);
    await logActivity(conversation.id, 'handoff', `Bot handed this over: ${String(reason).slice(0, 200)}`);

    const agent = conversation.assigned_to ? await userByName(conversation.assigned_to) : await pickAgent(lines.current().id);
    if (agent) return { assigned_to: agent.username, name: await assign(conversation, agent.username) };

    const settings = await readSettings(lines.current().id);
    await tell(conversation, isOpen(settings.hours)
        ? 'I’ve passed this to our team — someone will reply here shortly.'
        : `I’ve passed this to our team — they reply ${clock(settings.hours.start)} to ${clock(settings.hours.end)}, and someone will get back to you here then.`);
    return { assigned_to: null };
}

module.exports = { displayName, pickAgent, assign, handOver, record, tell, DEMO_PHONE };
