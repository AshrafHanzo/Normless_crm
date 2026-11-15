/**
 * The two addresses the CRM lives at.
 *
 *   ops.normless.store   — the CRM itself, for the team. Webhooks (Meta, Razorpay) call it too.
 *   share.normless.store — everything sent to a customer or a vendor: vendor pages, short links
 *                          in template buttons, PDFs and photos sent on WhatsApp. It answers
 *                          only those public paths (see SHARE_PATHS), so a link someone was sent
 *                          never leads to the CRM's login or its API.
 *
 * Anything a customer or vendor will see or tap must be built on shareBase(); never on the ops
 * address.
 */

const clean = (u) => String(u || '').replace(/\/+$/, '');

/** The CRM's own address (team, webhooks). */
const opsBase = () => clean(process.env.PUBLIC_BASE_URL || 'https://ops.normless.store');

/** The address for anything shared outside the team. */
const shareBase = () => clean(process.env.SHARE_BASE_URL || 'https://share.normless.store');

const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return null; } };

/**
 * What the share address may answer. Everything else there is "not found":
 *   /v/…                the vendor's page (the app shell; it calls only /api/portal/…)
 *   /go/…               short links
 *   /api/portal/…       the vendor page's data and invoice upload
 *   /assets/…           the page's scripts and styles
 *   /uploads/…, /api/thumb/…   files and photos sent on WhatsApp (already public on ops)
 *   top-level images, icons and the manifest the page loads
 */
const SHARE_PATHS = /^\/(?:v\/[^/]+\/?$|go\/|api\/portal\/|assets\/|uploads\/|api\/thumb\/|logo\/|[^/]+\.(?:png|svg|ico|webp|jpe?g|webmanifest)$)/i;

/**
 * Express middleware: on the share address, only the public paths. The CRM, login and every
 * other API are not there at all. nginx enforces the same list; this is the second lock.
 */
function shareGuard() {
    return (req, res, next) => {
        const share = hostOf(shareBase());
        if (!share || String(req.hostname || '').toLowerCase() !== share) return next();
        req.isShareHost = true;
        if (req.path === '/robots.txt') return res.type('text/plain').send('User-agent: *\nDisallow: /\n');
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        if (SHARE_PATHS.test(req.path)) return next();
        if (req.path === '/') return res.redirect(302, 'https://normless.store');
        return res.status(404).type('text/plain').send('Not found');
    };
}

module.exports = { opsBase, shareBase, shareGuard, SHARE_PATHS, hostOf };
