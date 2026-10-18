/**
 * Who a WhatsApp conversation goes to.
 *
 * Three settings decide it, all kept in the database so they change without a deploy:
 *
 *   - the mode: 'least_busy' hands a new chat to whoever carries the fewest open ones,
 *     'round_robin' to whoever was handed one longest ago, and 'manual' to nobody — the chat waits
 *     in Unassigned until somebody takes it;
 *   - the rules: "a chat from an ad goes to Sales", "a mockup request goes to Design". Checked top
 *     to bottom, first match wins, and a match picks the person from inside that team only;
 *   - each person's cap: somebody already carrying their maximum is skipped.
 *
 * Only people ticked as taking new enquiries (`is_sales_agent`) are ever picked automatically.
 */

const db = require('../db/connection');

const MODES = ['least_busy', 'round_robin', 'manual'];
const RULE_FIELDS = ['source', 'menu_option', 'lead_status'];

async function setting(c, key) {
    const r = await c.query('SELECT value FROM wa_settings WHERE key = $1', [key]);
    return r.rows[0]?.value ?? null;
}

async function mode(c = db) {
    const m = await setting(c, 'assign_mode');
    return MODES.includes(m) ? m : 'least_busy';
}

/**
 * The next person, from everyone on the rota or from one team.
 *
 * `c` is a client or the pool, so this runs inside the transaction that creates a conversation.
 */
async function nextAgent(c, { teamId = null } = {}) {
    const how = await mode(c);
    if (how === 'manual') return null;

    const params = [];
    let team = '';
    if (teamId) {
        params.push(teamId);
        team = `AND EXISTS (SELECT 1 FROM wa_team_members t
                             WHERE t.team_id = $1 AND LOWER(t.username) = LOWER(u.username))`;
    }
    // Least busy counts open threads; round robin looks at when each person was last handed one,
    // open or not, so clearing an inbox does not jump somebody to the front of the queue.
    const order = how === 'round_robin'
        ? 'MAX(v.created_at) ASC NULLS FIRST, LOWER(u.username)'
        : `COUNT(v.id) FILTER (WHERE v.status = 'open') ASC, MAX(v.created_at) ASC NULLS FIRST, LOWER(u.username)`;

    const r = await c.query(
        `SELECT u.username
           FROM admin_users u
           LEFT JOIN wa_conversations v ON LOWER(v.assigned_to) = LOWER(u.username)
          WHERE COALESCE(u.is_active, true) = true
            AND COALESCE(u.is_sales_agent, false) = true
            ${team}
          GROUP BY u.username, u.wa_max_open
         HAVING u.wa_max_open IS NULL
             OR COUNT(v.id) FILTER (WHERE v.status = 'open') < u.wa_max_open
          ORDER BY ${order}
          LIMIT 1`, params);
    return r.rows[0]?.username || null;
}

/** The team the first matching rule names, or null. */
async function matchRule(c, field, value) {
    if (value == null || value === '') return null;
    const r = await c.query(
        `SELECT team_id FROM wa_assign_rules
          WHERE is_active = true AND field = $1 AND LOWER(value) = LOWER($2)
          ORDER BY sort_order, id LIMIT 1`, [field, String(value)]);
    return r.rows[0]?.team_id || null;
}

/** The team to fall back on when no rule matches, if one is set. */
async function fallbackTeam(c) {
    const v = await setting(c, 'fallback_team_id');
    return v ? Number(v) || null : null;
}

/** Who a brand-new conversation goes to. */
async function forNewConversation(c, { fromAd }) {
    const teamId = await matchRule(c, 'source', fromAd ? 'ad' : 'direct') || await fallbackTeam(c);
    return nextAgent(c, { teamId });
}

/**
 * Something happened mid-conversation that a rule may care about: the customer tapped a menu
 * option, or somebody moved the lead to a new status. A match moves the conversation to that team
 * — unless the person it is with is already in that team, who is left alone.
 */
async function reroute(conversationId, field, value) {
    const teamId = await matchRule(db, field, value);
    if (!teamId) return null;
    const conv = (await db.query('SELECT assigned_to FROM wa_conversations WHERE id = $1', [conversationId])).rows[0];
    if (!conv) return null;
    if (conv.assigned_to) {
        const inTeam = await db.query(
            `SELECT 1 FROM wa_team_members WHERE team_id = $1 AND LOWER(username) = LOWER($2)`,
            [teamId, conv.assigned_to]);
        if (inTeam.rows[0]) return null;
    }
    const who = await nextAgent(db, { teamId });
    if (!who) return null;
    await db.query(
        `UPDATE wa_conversations SET assigned_to = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [conversationId, who]);
    return who;
}

module.exports = { MODES, RULE_FIELDS, mode, nextAgent, forNewConversation, reroute };
