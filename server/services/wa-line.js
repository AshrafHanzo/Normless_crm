/**
 * Which WhatsApp number we are speaking from.
 *
 * The CRM carries two lines: Crewfit's and Normless's, each its own number, its own Meta account,
 * its own inbox and its own settings. A message is always on exactly one of them, and nothing a
 * customer of one brand says may surface in the other's inbox or be answered from the other's
 * number.
 *
 * The line in force is carried by Node's AsyncLocalStorage rather than threaded through every
 * call: the webhook enters it for the number Meta says a message arrived on, the inbox's routes
 * enter it for the brand whose menu they hang under, and everything underneath — the send
 * functions, the token, the template list — reads it from here. Outside any of those (an order
 * saved in Bulk Orders firing an automatic message, a start-up job) the line is Crewfit's,
 * which is what all of that code was written for.
 *
 * Credentials come from the number connected in the CRM (Settings › Connect) and, failing that,
 * from the server's .env: WA_* for Crewfit, as it always was, and WA_NORMLESS_* for Normless.
 */

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const db = require('../db/connection');

const BRANDS = {
    crewfit: { name: 'Crewfit', env: 'WA_' },
    normless: { name: 'Normless', env: 'WA_NORMLESS_' },
};

const als = new AsyncLocalStorage();
let lines = new Map();            // brand -> line
let loading = null;

/* ── The stored token ───────────────────────────────────────────────────────────────────────
   A credential, so it is kept encrypted with a key derived from the server's own secret, and
   never sent back to the browser. */

const KEY = () => crypto.createHash('sha256')
    .update(String(process.env.WA_TOKEN_KEY || process.env.JWT_SECRET || 'normless-crm')).digest();

function seal(text) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', KEY(), iv);
    const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), body].map(b => b.toString('base64')).join('.');
}

function unseal(sealed) {
    try {
        const [iv, tag, body] = String(sealed).split('.').map(p => Buffer.from(p, 'base64'));
        const decipher = crypto.createDecipheriv('aes-256-gcm', KEY(), iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    } catch {
        return null;           // a changed server secret: the number has to be connected again
    }
}

const parse = (v) => { try { return JSON.parse(v || 'null'); } catch { return null; } };

/** A line as the rest of the code uses it: its row, plus the credentials in force. */
function shape(brand, row) {
    const env = BRANDS[brand].env;
    const connection = parse(row?.connection);
    const live = connection?.token && connection.status !== 'disconnected' ? unseal(connection.token) : null;
    if (connection?.token && connection.status !== 'disconnected' && !live) {
        console.error(`whatsapp: the stored ${brand} token could not be read — connect the number again`);
    }
    return {
        id: row?.id ?? null,
        brand,
        name: row?.name || BRANDS[brand].name,
        connection,
        // The connected number wins over .env, so connecting never needs a deploy.
        token: live || process.env[`${env}ACCESS_TOKEN`] || '',
        phoneNumberId: (live && connection.phone_number_id) || process.env[`${env}PHONE_NUMBER_ID`] || '',
        wabaId: (live && connection.waba_id) || process.env[`${env}BUSINESS_ACCOUNT_ID`] || '',
        fromEnv: !live && !!process.env[`${env}ACCESS_TOKEN`],
    };
}

/** Read every line from the database. Called at start-up and after a connect or disconnect. */
async function load() {
    const r = await db.query('SELECT * FROM wa_lines');
    const next = new Map();
    for (const brand of Object.keys(BRANDS)) next.set(brand, shape(brand, r.rows.find(x => x.brand === brand)));
    lines = next;
    return lines;
}

/** Loaded once, on first use: a webhook can arrive before start-up has finished. */
function ready() {
    if (lines.size && lines.get('crewfit')?.id) return Promise.resolve(lines);
    if (!loading) loading = load().finally(() => { loading = null; });
    return loading;
}

function get(brand) {
    if (!BRANDS[brand]) throw new Error(`Unknown WhatsApp line: ${brand}`);
    return lines.get(brand) || shape(brand, null);
}

/** The line this piece of work belongs to. Crewfit's when nothing says otherwise. */
const current = () => als.getStore() || get('crewfit');

/** Do `fn` as `line` (a line, or a brand name). */
const run = (line, fn) => als.run(typeof line === 'string' ? get(line) : line, fn);

/** Express middleware: everything after it in this request is on `brand`'s line. */
const scope = (brand) => async (req, res, next) => {
    try {
        await ready();
        req.waLine = get(brand);
        als.run(req.waLine, next);
    } catch (err) { next(err); }
};

/** Re-enter the request's line — after multer, whose callbacks lose it. */
const resume = (req, next) => (req.waLine ? als.run(req.waLine, next) : next());

/**
 * Which line a webhook is for. Meta puts the receiving number's id in every message, status
 * and echo; account events carry only the business account (the entry's id).
 */
function forWebhook(phoneNumberId, wabaId) {
    const all = [...lines.values()];
    if (phoneNumberId) {
        const hit = all.find(l => l.phoneNumberId && String(l.phoneNumberId) === String(phoneNumberId));
        if (hit) return hit;
    }
    if (wabaId) {
        const hits = all.filter(l => l.wabaId && String(l.wabaId) === String(wabaId));
        // Two numbers on one business account: only the phone number id can tell them apart.
        if (hits.length === 1) return hits[0];
    }
    return null;
}

const brandOf = (line) => (line || current()).brand;

module.exports = { BRANDS, seal, unseal, load, ready, get, current, run, scope, resume, forWebhook, brandOf };
