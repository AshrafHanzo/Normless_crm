/**
 * Normless's WhatsApp settings as stored on its line: what a manager set, over the defaults.
 * Shared by the Settings page and the bot, so the bot always runs on what the page shows.
 */

const db = require('../db/connection');

const EXCHANGE_CENTER = 'https://normless.store/apps/aftership-returns-center';

/** What a section holds before anybody has saved it. The policy facts are Normless's own. */
const DEFAULTS = {
    bot: { enabled: false, tone: 'friendly', language: 'en' },
    faqs: [
        { q: 'Is the COD advance refundable?', a: 'No — any advance on a partial COD order is non-refundable.' },
        { q: 'Do you ship outside India?', a: 'Yes. Charges are shown at checkout; delivery takes 7–21 business days.' },
        { q: 'How long does a refund take?', a: 'Approved refunds are processed within 10 business days.' },
    ],
    handoff: {
        refund: true, damaged: true, asks_person: true, unsure: true, no_order: true, upset: true,
        big_order: false, big_order_amount: 5000,
    },
    menu: {
        greeting: 'Hi {name}, welcome to Normless. What can we help with?',
        options: ['Track my order', 'Size help', 'Exchange or return', 'Something else'],
        exchange_url: EXCHANGE_CENTER,
    },
    hours: {
        days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '18:00',
        away: 'Thanks for messaging Normless! Our team replies 9 am – 6 pm, Monday to Saturday. We have your message and will get back to you then.',
    },
};
const SECTIONS = Object.keys(DEFAULTS);

const safeJson = (v) => { try { return JSON.parse(v || 'null'); } catch { return null; } };

async function readSettings(lineId) {
    const r = await db.query('SELECT settings FROM wa_lines WHERE id = $1', [lineId]);
    const saved = safeJson(r.rows[0]?.settings) || {};
    return Object.fromEntries(SECTIONS.map(k => [k,
        Array.isArray(DEFAULTS[k]) ? (Array.isArray(saved[k]) ? saved[k] : DEFAULTS[k]) : { ...DEFAULTS[k], ...(saved[k] || {}) }]));
}


/** Is it working hours for the team right now (India time)? */
function isOpen(hours, date = new Date()) {
    const ist = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    if (!(hours.days || []).includes(ist.getDay())) return false;
    const mins = ist.getHours() * 60 + ist.getMinutes();
    const at = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
    return mins >= at(hours.start) && mins < at(hours.end);
}

/** "9 am", "6:30 pm" */
const clock = (hhmm) => {
    const [h, m] = String(hhmm || '0:0').split(':').map(Number);
    return `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'am' : 'pm'}`;
};

module.exports = { DEFAULTS, SECTIONS, readSettings, isOpen, clock, EXCHANGE_CENTER };
