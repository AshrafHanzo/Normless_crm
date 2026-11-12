/**
 * The Crewfit office, sent into a chat: its address with a directions button, and a request for a
 * Google review.
 *
 * The address goes with one "Get directions" button that opens Google Maps routed to the office.
 * Not WhatsApp's own location pin: its coordinates dropped the customer at the wrong spot, and the
 * team's link routes to the office itself. The review request is a message with one "Write a review" button that opens
 * Google's review box for the office. Its link and wording are in Settings › Order messages; the
 * defaults below are what goes until somebody changes them.
 *
 * Both are session messages: inside WhatsApp's 24-hour window only. The review request after the
 * tracking details falls back on its template outside it (see wa-orders.js).
 */

const db = require('../db/connection');
const wa = require('./whatsapp');

// Directions to the office as the team gave them: Google Maps routed to its listing.
const OFFICE = {
    name: 'Crewfit office',
    address: 'Plot no 2, 2nd Floor, Dhanalakshmi Nagar, Moulivakkam, Iyyappanthangal, Chennai, Tamil Nadu 600125',
    directions: 'https://www.google.com/maps?um=1&ie=UTF-8&fb=1&gl=in&sa=X&geocode=KQHrpfCJYVI6MSzD0FzDI3vw'
        + '&daddr=Plot+no+2,+Dhanalakshmi+Nagar,+Moulivakkam,+Iyyappanthangal,+Mowlivakkam,+Tamil+Nadu+600125',
};
const DIRECTIONS_BUTTON = '📍 Get directions';

// The "Ask for reviews" link from the office's Google Business Profile: opens the review box on
// any phone, in the Maps app where it is installed. Settings can point it somewhere else.
const DEFAULT_REVIEW_LINK = 'https://g.page/r/CQXZqo2XhlMxEBM/review';
const DEFAULT_REVIEW_TEXT = [
    'Hi {name}! 😊',
    '',
    'Thank you for choosing Crewfit. We hope you and your team love your order.',
    '',
    'If you are happy with it, could you spare a minute to leave us a Google review? ⭐ It helps other businesses find us, and we read every one.',
    '',
    'Just tap the button below. Thank you!',
].join('\n');
const REVIEW_BUTTON = '⭐ Write a review';

async function reviewSettings() {
    const r = await db.query(`SELECT key, value FROM wa_settings WHERE key IN ('review_link', 'review_text')`);
    const s = Object.fromEntries(r.rows.map(x => [x.key, x.value]));
    return { link: s.review_link || DEFAULT_REVIEW_LINK, text: s.review_text || DEFAULT_REVIEW_TEXT };
}

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';

async function record(conversation, { wamid, type, body, senderType, user, payload = null }) {
    const row = (await db.query(
        `INSERT INTO wa_messages (conversation_id, wamid, direction, sender_type, sender_user, type, body, interactive_payload, status)
         VALUES ($1,$2,'out',$3,$4,$5,$6,$7,'sent')
         RETURNING id, conversation_id, wamid, direction, sender_type, sender_user, type, body, interactive_payload, status, error, sent_at`,
        [conversation.id, wamid, senderType, user, type, body, payload ? JSON.stringify(payload) : null])).rows[0];
    await db.query(
        `UPDATE wa_conversations SET last_message_at = CURRENT_TIMESTAMP, last_message_preview = $2,
                status = 'open', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [conversation.id, String(body).split('\n')[0].slice(0, 200)]);
    return row;
}

/** The office's address with its directions button. Returns the message row. */
async function sendLocation(conversation, { senderType = 'user', user = null } = {}) {
    const text = `📍 *${OFFICE.name}*\n${OFFICE.address}\n\nTap below for directions.`;
    const wamid = await wa.sendCtaUrl(conversation.phone, text, { label: DIRECTIONS_BUTTON, url: OFFICE.directions });
    return record(conversation, {
        wamid, type: 'interactive', senderType, user, body: text,
        payload: { kind: 'cta_url', label: DIRECTIONS_BUTTON, url: OFFICE.directions },
    });
}

/** The review request with its button. `name` is who it greets. Returns the message row. */
async function sendReview(conversation, { name = null, senderType = 'user', user = null } = {}) {
    const s = await reviewSettings();
    const text = s.text.replace(/\{name\}/g, firstName(name || conversation.lead_name || conversation.profile_name));
    const wamid = await wa.sendCtaUrl(conversation.phone, text, { label: REVIEW_BUTTON, url: s.link });
    return record(conversation, {
        wamid, type: 'interactive', senderType, user, body: text,
        payload: { kind: 'cta_url', label: REVIEW_BUTTON, url: s.link },
    });
}

module.exports = { OFFICE, DEFAULT_REVIEW_LINK, DEFAULT_REVIEW_TEXT, reviewSettings, sendLocation, sendReview };
