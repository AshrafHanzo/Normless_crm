/**
 * Telling one person something happened.
 *
 * Notifications are rows, not a derived query: "have I seen this" is a fact about the person, and
 * the thing that caused it — a comment — may be read by ten people who each need their own answer.
 *
 * Nothing here is allowed to fail the action that triggered it. Being notified is the lesser half
 * of "post a comment": losing the notification is a nuisance, losing the comment is the work.
 */

const db = require('../db/connection');

/** The part of a username people actually say out loud: anu@normless.store → anu. */
const handleOf = (username) => String(username || '').split('@')[0].toLowerCase();

/**
 * Everyone who could be named in a comment: active accounts that can open the order being
 * discussed. Mentioning someone who cannot see it would notify them about a page they cannot
 * reach.
 */
async function mentionableUsers() {
    const r = await db.query(
        `SELECT username, role FROM admin_users
          WHERE COALESCE(is_active, true) = true
            AND (role IN ('owner','admin') OR COALESCE(can_view_crewfit_orders, false) = true)
          ORDER BY username`);
    return r.rows.map(u => ({ username: u.username, handle: handleOf(u.username), role: u.role }));
}

/**
 * The usernames a comment names.
 *
 * Read from the text rather than trusted from the client: the body is what everyone else will see,
 * so it is the only honest source of who was meant. Matched against real accounts, so a stray
 * "@9am" names nobody. Longest handles first, or "@prod" would swallow "@production".
 */
function mentionsIn(body, users) {
    const text = String(body || '');
    const byLength = [...users].sort((a, b) => b.handle.length - a.handle.length);
    const found = new Set();
    // Every @token in the text, then matched — rather than scanning per user — so the same handle
    // written twice is still one mention.
    for (const raw of text.match(/@[A-Za-z0-9._+-]+/g) || []) {
        // A handle at the end of a sentence carries the full stop into the token ("@anu."), and
        // a prefix match would let "@anushka" name Anu — so trim the punctuation, then match whole.
        const token = raw.slice(1).toLowerCase().replace(/[._+-]+$/, '');
        const hit = byLength.find(u => token === u.handle);
        if (hit) found.add(hit.username);
    }
    return [...found];
}

/** Write one notification per recipient, never to whoever caused it. */
async function notify({ usernames = [], kind, title, body, link, actor }) {
    const targets = [...new Set(usernames.filter(Boolean))].filter(u => u !== actor);
    if (!targets.length) return 0;
    try {
        for (const username of targets) {
            await db.query(
                `INSERT INTO notifications (username, kind, title, body, link, actor)
                 VALUES ($1,$2,$3,$4,$5,$6)`,
                [username, kind, title, body || null, link || null, actor || null]);
        }
        return targets.length;
    } catch (err) {
        console.error('notify failed:', err.message);
        return 0;
    }
}

module.exports = { notify, mentionableUsers, mentionsIn, handleOf };
