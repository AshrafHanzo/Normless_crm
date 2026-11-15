/**
 * Our own short links: https://share.normless.store/go/k3Jx9a → wherever it was made for.
 *
 * Built on the share address (never the CRM's): it is what customers see and tap. Templates
 * approved before the move still carry ops.normless.store/go/{{1}}; those keep working, and are
 * still recognised as ours (isOurs).
 *
 * Template buttons end in a gap that is filled each time a message is sent ({{1}}). The links
 * Normless's old provider used sent every tap through its redirector; these keep the checkout,
 * order and tracking links on our own domain, and count the taps.
 */

const crypto = require('crypto');
const db = require('../db/connection');

const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const { opsBase, shareBase } = require('../utils/public-urls');
// The CRM's own address — for webhooks and anything only the team sees.
const PUBLIC_BASE = opsBase;
/** What a template's link button is set to; its {{1}} is a code from here. */
const BUTTON_BASE = () => `${shareBase()}/go/`;
/** Is this button address one of ours — on the share address, or the CRM's from before the move? */
const isOurs = (url) => [BUTTON_BASE(), `${opsBase()}/go/`].some(b => String(url || '').startsWith(b));

function code(length = 7) {
    const bytes = crypto.randomBytes(length);
    return Array.from(bytes, b => ALPHABET[b % ALPHABET.length]).join('');
}

/** A short code for a link. Only https links are ever stored, so /go can't be made to point anywhere odd. */
async function shorten(url, { kind = null, ref = null } = {}) {
    if (!/^https:\/\//i.test(String(url || ''))) throw new Error('Only https links can be shortened');
    for (let i = 0; i < 5; i++) {
        const c = code();
        const r = await db.query(
            `INSERT INTO nl_links (code, url, kind, ref) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO NOTHING RETURNING code`,
            [c, String(url), kind, ref == null ? null : String(ref)]);
        if (r.rows[0]) return c;
    }
    throw new Error('Could not make a short link');
}

/** Where a code goes, counting the tap. Null when there is no such code. */
async function resolve(c) {
    if (!/^[A-Za-z0-9]{4,32}$/.test(String(c || ''))) return null;
    const r = await db.query(
        `UPDATE nl_links SET clicks = clicks + 1, last_click_at = CURRENT_TIMESTAMP WHERE code = $1 RETURNING url`, [c]);
    return r.rows[0]?.url || null;
}

/** GET /go/:code — public, no login: it is what a customer taps. Unknown codes go to the shop. */
function router() {
    const express = require('express');
    const r = express.Router();
    r.get('/:code', async (req, res) => {
        try {
            const url = await resolve(req.params.code);
            res.set('Cache-Control', 'no-store');
            res.redirect(302, url || 'https://normless.store');
        } catch (err) {
            console.error('normless link error:', err.message);
            res.redirect(302, 'https://normless.store');
        }
    });
    return r;
}

module.exports = { shorten, resolve, router, BUTTON_BASE, PUBLIC_BASE, isOurs };
