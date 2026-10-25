/**
 * Razorpay Magic Checkout's abandoned-cart webhook, for Normless.
 *
 * Razorpay posts a checkout here when a customer leaves it (Magic Checkout › Platform Settings ›
 * abandoned cart webhook). It sends no signature, so the address itself carries a secret made by
 * the CRM (/api/hooks/carts/abandoned?api_key=<uuid>: Razorpay's dashboard refuses an address
 * containing the word "razorpay") — shown in WhatsApp settings › Templates › Abandoned cart — and anything posted to a
 * wrong address is refused. Answered at once; the reminders go out later (nl-automations).
 */

const crypto = require('crypto');
const express = require('express');
const lines = require('../services/wa-line');
const auto = require('../services/nl-automations');

const router = express.Router();

const same = (a, b) => {
    const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Whether the key on the address is ours. Razorpay may check the address with a plain GET. */
async function allowed(req) {
    const line = lines.get('normless');
    if (!line?.id) return null;
    const cfg = await auto.config(line.id);
    return same(req.query.api_key || req.params.secret, cfg.webhook_secret) ? line : null;
}

router.get(['/abandoned', '/abandoned/:secret'], async (req, res) => {
    try { res.status((await allowed(req)) ? 200 : 404).json({ ok: true }); }
    catch { res.status(500).json({ error: 'not ready' }); }
});

router.post(['/abandoned', '/abandoned/:secret'], async (req, res) => {
    try {
        const line = await allowed(req);
        if (!line) return res.status(404).json({ error: 'not found' });
        const out = await auto.onAbandoned(line.id, req.body || {});
        res.json({ ok: out.ok });
    } catch (err) {
        console.error('razorpay abandoned cart:', err.message);
        res.status(500).json({ error: 'could not take that' });
    }
});

module.exports = router;
