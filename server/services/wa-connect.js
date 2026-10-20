/**
 * Connecting the shop's existing WhatsApp Business app number to the CRM — Meta's "Coexistence".
 *
 * The number stays on the phone app: staff keep chatting there as before, and every message, in
 * or out, also lands in the CRM. Meta's Embedded Signup popup (opened from Settings › Connect
 * WhatsApp) hands back the account IDs and a one-time code; this file turns that into a working
 * connection:
 *
 *   1. swap the code for a business token (the code lives 30 seconds, so it is done at once);
 *   2. subscribe this app to the WhatsApp account's webhooks;
 *   3. check the number really is on the phone app and Cloud API together;
 *   4. ask Meta to send the contacts and the last 180 days of chats — each can be asked for once
 *      only, within 24 hours of connecting, so it is done straight away and the result kept.
 *
 * The number is NOT registered (step "register" in Meta's normal onboarding): a coexistence
 * number is registered already, and registering it again would take it off the phone.
 *
 * The token is a credential, so it is stored encrypted, with a key derived from the server's own
 * secret, and never sent back to the browser.
 */

const crypto = require('crypto');
const db = require('../db/connection');
const wa = require('./whatsapp');

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
        return null;           // a changed server secret: the token has to be connected again
    }
}

async function getSetting(key) {
    const r = await db.query('SELECT value FROM wa_settings WHERE key = $1', [key]);
    try { return JSON.parse(r.rows[0]?.value || 'null'); } catch { return null; }
}

async function putSetting(key, value, who = null) {
    await db.query(
        `INSERT INTO wa_settings (key, value, updated_by, updated_at) VALUES ($1,$2,$3,CURRENT_TIMESTAMP)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`,
        [key, value == null ? null : JSON.stringify(value), who]);
}

/** Put a stored connection to use. Called once at start-up. */
async function load() {
    const c = await getSetting('connection');
    if (!c?.token || c.status === 'disconnected') { wa.useConnection(null); return null; }
    const token = unseal(c.token);
    if (!token) { console.error('whatsapp: the stored token could not be read — connect again'); return null; }
    wa.useConnection({ token, phoneNumberId: c.phone_number_id, wabaId: c.waba_id });
    return c;
}

/** What the settings page shows. Never the token. */
async function status() {
    const c = await getSetting('connection');
    const history = await getSetting('history_import');
    const contacts = await getSetting('contacts_import');
    const { token, ...safe } = c || {};
    return {
        connection: c ? { ...safe, has_token: !!token } : null,
        history, contacts,
        usingEnv: !c?.token && !!process.env.WA_ACCESS_TOKEN,
        appId: process.env.WA_APP_ID || null,
        configId: process.env.WA_EMBEDDED_CONFIG_ID || null,
        graphVersion: process.env.WA_API_VERSION || 'v21.0',
    };
}

class ConnectError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
}

/** Steps 1–4 above. `who` is the admin who connected. */
async function connect({ code, wabaId, phoneNumberId, businessId, finishType }, who) {
    const appId = process.env.WA_APP_ID;
    const secret = process.env.WA_APP_SECRET;
    if (!appId || !secret) throw new ConnectError('WA_APP_ID and WA_APP_SECRET have to be set on the server first');
    if (!code) throw new ConnectError('Meta did not return a code — try connecting again');
    if (!wabaId || !phoneNumberId) throw new ConnectError('Meta did not say which account and number were chosen — try again and finish every step in the popup');

    const graph = (p) => `https://graph.facebook.com/${process.env.WA_API_VERSION || 'v21.0'}${p}`;
    const call = async (url, { method = 'GET', token, body } = {}) => {
        const res = await fetch(url, {
            method,
            headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(30000),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new ConnectError(data?.error?.message || `Meta refused that (${res.status})`, 502);
        return data;
    };

    // 1. The code, for a business token. Server to server: the app secret never leaves here.
    const qs = new URLSearchParams({ client_id: appId, client_secret: secret, code });
    const { access_token: token } = await call(graph(`/oauth/access_token?${qs}`));
    if (!token) throw new ConnectError('Meta did not return a token for that code', 502);

    // 2. This app hears the account's webhooks: messages, the phone app's echoes, history.
    await call(graph(`/${wabaId}/subscribed_apps`), { method: 'POST', token });

    // 3. Is it really a coexistence number? Both of these should say so.
    const phone = await call(graph(`/${phoneNumberId}?fields=display_phone_number,verified_name,is_on_biz_app,platform_type`), { token });

    const connection = {
        status: 'connected',
        coexistence: !!phone.is_on_biz_app,
        platform_type: phone.platform_type || null,
        waba_id: String(wabaId),
        phone_number_id: String(phoneNumberId),
        business_id: businessId ? String(businessId) : null,
        display_phone_number: phone.display_phone_number || null,
        business_phone: wa.normalisePhone(phone.display_phone_number || ''),
        verified_name: phone.verified_name || null,
        finish_type: finishType || null,
        connected_at: new Date().toISOString(),
        connected_by: who || null,
        token: seal(token),
    };
    await putSetting('connection', connection, who);
    wa.useConnection({ token, phoneNumberId: connection.phone_number_id, wabaId: connection.waba_id });

    // 4. Contacts and chat history, once each, within 24 hours. Asked for now; what comes back
    //    arrives over the webhooks and is counted in history_import / contacts_import.
    const sync = {};
    if (connection.coexistence) {
        for (const type of ['smb_app_state_sync', 'history']) {
            try {
                const r = await call(graph(`/${phoneNumberId}/smb_app_data`), {
                    method: 'POST', token, body: { messaging_product: 'whatsapp', sync_type: type },
                });
                sync[type] = { requested_at: new Date().toISOString(), request_id: r.request_id || null };
            } catch (err) {
                sync[type] = { error: err.message, requested_at: new Date().toISOString() };
            }
        }
        await putSetting('contacts_import', { status: sync.smb_app_state_sync?.error ? 'failed' : 'requested', ...sync.smb_app_state_sync, contacts: 0 }, who);
        await putSetting('history_import', { status: sync.history?.error ? 'failed' : 'requested', ...sync.history, threads: 0, messages: 0, chunks: 0 }, who);
    }
    return { ...connection, token: undefined, sync };
}

/**
 * Ask for one sync again — only meant for a request that failed in the first 24 hours. Meta
 * runs each sync once per connection; a second successful request is refused by Meta.
 */
async function requestSync(type, who) {
    const c = await getSetting('connection');
    const token = c?.token && unseal(c.token);
    if (!token) throw new ConnectError('Connect the number first');
    if (Date.now() - new Date(c.connected_at).getTime() > 24 * 3600 * 1000) {
        throw new ConnectError('More than 24 hours have passed since connecting — Meta only allows the sync in that window. Disconnect in the WhatsApp Business app and connect again to import history.');
    }
    const res = await fetch(`https://graph.facebook.com/${process.env.WA_API_VERSION || 'v21.0'}/${c.phone_number_id}/smb_app_data`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', sync_type: type }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new ConnectError(data?.error?.message || 'Meta refused the sync request', 502);
    const key = type === 'history' ? 'history_import' : 'contacts_import';
    const prev = (await getSetting(key)) || {};
    await putSetting(key, { ...prev, status: 'requested', error: null, request_id: data.request_id || null, requested_at: new Date().toISOString() }, who);
    return data;
}

/** Stop using the stored connection. The phone app is unaffected; Meta's side is the app's to undo. */
async function disconnect(who) {
    const c = await getSetting('connection');
    if (!c) return;
    await putSetting('connection', { ...c, status: 'disconnected', token: null, disconnected_at: new Date().toISOString(), disconnected_by: who }, who);
    wa.useConnection(null);
}

/** Meta says the account changed: removed, offboarded, reconnected. */
async function accountUpdate(value) {
    const c = await getSetting('connection');
    if (!c) return;
    const event = value?.event || null;
    const patch = { last_account_event: event, last_account_event_at: new Date().toISOString() };
    if (['PARTNER_REMOVED', 'ACCOUNT_OFFBOARDED'].includes(event)) Object.assign(patch, { status: 'disconnected', disconnect_reason: value?.disconnection_info?.reason || event });
    if (event === 'ACCOUNT_RECONNECTED') patch.status = 'connected';
    await putSetting('connection', { ...c, ...patch });
    if (patch.status === 'disconnected') wa.useConnection(null);
}

module.exports = { load, status, connect, requestSync, disconnect, accountUpdate, getSetting, putSetting, ConnectError };
