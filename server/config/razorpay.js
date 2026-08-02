// Razorpay credentials, resolved once from the RAZORPAY_MODE switch.
//
// Test and Live are entirely separate worlds at Razorpay's end: a Live key can't see a
// Test payment link, and a webhook registered under Test Mode never fires for Live
// payments (and vice versa). So the key pair AND the webhook secret must always come
// from the same mode — keeping them together here is what guarantees that.
//
// Mode is explicit rather than derived from NODE_ENV: deploying to production must never
// silently start charging real cards. Set RAZORPAY_MODE=live when you're ready.
const MODE = (process.env.RAZORPAY_MODE || 'test').trim().toLowerCase() === 'live' ? 'live' : 'test';
const PREFIX = MODE === 'live' ? 'RAZORPAY_LIVE' : 'RAZORPAY_TEST';

const keyId = process.env[`${PREFIX}_KEY_ID`] || '';
const keySecret = process.env[`${PREFIX}_KEY_SECRET`] || '';
// Razorpay lets you use the same secret string for the Test and Live webhooks, and most
// setups do — so a single RAZORPAY_WEBHOOK_SECRET is the normal case. A mode-specific one
// takes precedence for anyone who registered two different secrets.
const webhookSecret = process.env[`${PREFIX}_WEBHOOK_SECRET`] || process.env.RAZORPAY_WEBHOOK_SECRET || '';

const isConfigured = Boolean(keyId && keySecret);

// Which env vars are missing for the active mode — used in error messages so a
// misconfiguration names the exact variable to set instead of "not configured".
function missingVars() {
  return [
    !keyId && `${PREFIX}_KEY_ID`,
    !keySecret && `${PREFIX}_KEY_SECRET`,
  ].filter(Boolean);
}

function client() {
  if (!isConfigured) throw new Error(`Razorpay (${MODE} mode) is missing ${missingVars().join(' and ')}`);
  const Razorpay = require('razorpay');
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

module.exports = { MODE, keyId, keySecret, webhookSecret, isConfigured, missingVars, client };
