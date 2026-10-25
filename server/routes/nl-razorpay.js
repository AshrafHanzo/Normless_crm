/**
 * Razorpay Magic Checkout's abandoned-cart webhook, for Normless.
 *
 * Razorpay posts a checkout here when a customer leaves it (Magic Checkout › Platform Settings ›
 * abandoned cart webhook). It sends no signature, so the address itself carries a secret made by
 * the CRM — shown in WhatsApp settings › Templates › Abandoned cart — and anything posted to a
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

router.post('/abandoned/:secret', async (req, res) => {
    try {
        const line = lines.get('normless');
        if (!line?.id) return res.status(503).json({ error: 'not ready' });
        const cfg = await auto.config(line.id);
        if (!same(req.params.secret, cfg.webhook_secret)) return res.status(404).json({ error: 'not found' });
        const out = await auto.onAbandoned(line.id, req.body || {});
        res.json({ ok: out.ok });
    } catch (err) {
        console.error('razorpay abandoned cart:', err.message);
        res.status(500).json({ error: 'could not take that' });
    }
});

module.exports = router;
