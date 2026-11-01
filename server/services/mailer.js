/**
 * Email from the CRM's Gmail account (GMAIL_USER / GMAIL_APP_PASSWORD), shared by the Team
 * section's notifications and payslips.
 *
 * Never throws: an email is the lesser half of whatever caused it. Without the Gmail settings
 * (a test server) it logs what it would have sent and reports false.
 */

const nodemailer = require('nodemailer');

let transporter = null;
function transport() {
    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return null;
    if (!transporter) {
        transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
        });
    }
    return transporter;
}

const appUrl = (path = '') => `${(process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '')}${path}`;
const looksLikeEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));

/** { to, subject, html, text, attachments } → true when handed to Gmail. */
async function send({ to, subject, html, text, attachments }) {
    if (!looksLikeEmail(to)) return false;
    const t = transport();
    if (!t) {
        console.log(`✉️  (mail not configured) to ${to}: ${subject}`);
        return false;
    }
    try {
        await t.sendMail({
            from: `"Normless CRM" <${process.env.GMAIL_USER}>`,
            to, subject, html, text, attachments,
        });
        return true;
    } catch (err) {
        console.error('mail send failed:', err.message);
        return false;
    }
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The one email layout: a greeting, some lines, a button. Plain enough for any mail app. */
function layout({ greeting, lines = [], button, footer }) {
    const body = lines.map(l => `<p style="margin:0 0 10px">${l}</p>`).join('');
    const btn = button
        ? `<p style="margin:18px 0"><a href="${esc(button.href)}" style="background:#6d5cf0;color:#ffffff;text-decoration:none;font-weight:600;padding:11px 18px;border-radius:8px;display:inline-block">${esc(button.label)}</a></p>`
        : '';
    return `<div style="font-family:Inter,Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.55;color:#1a1c22;max-width:560px">
        ${greeting ? `<p style="margin:0 0 12px">${esc(greeting)}</p>` : ''}${body}${btn}
        <p style="margin:18px 0 0;font-size:12px;color:#4a4f5c">${footer || `<a href="${esc(appUrl('/team/me'))}" style="color:#4b3fd1">Change which emails you get</a>`}</p>
    </div>`;
}

module.exports = { send, layout, esc, appUrl, looksLikeEmail };
