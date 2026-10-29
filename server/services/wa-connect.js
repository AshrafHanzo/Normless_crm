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

const db = require('../db/connection');
const wa = require('./whatsapp');
const lines = require('./wa-line');

/*
 * Each brand's number is connected on its own line (wa_lines): the connection, and the two
 * imports Coexistence allows, are columns of that row. Everything here works on the line in
 * force — the Crewfit or Normless WhatsApp settings page the admin connected from.
 */
const FIELDS = { connection: 'connection', history_import: 'history_import', contacts_import: 'contacts_import' };

async function getSetting(key) {
    const field = FIELDS[key];
    if (!field) throw new Error(`Unknown connection field: ${key}`);
    const r = await db.query(`SELECT ${field} AS value FROM wa_lines WHERE brand = $1`, [lines.current().brand]);
    try { return JSON.parse(r.rows[0]?.value || 'null'); } catch { return null; }
}

async function putSetting(key, value) {
    const field = FIELDS[key];
    if (!field) throw new Error(`Unknown connection field: ${key}`);
    await db.query(`UPDATE wa_lines SET ${field} = $2, updated_at = CURRENT_TIMESTAMP WHERE brand = $1`,
        [lines.current().brand, value == null ? null : JSON.stringify(value)]);
    if (field === 'connection') await lines.load();     // the new token is used from now on
}

/** What the settings page shows. Never the token. */
async function status() {
    const line = lines.current();
    const c = await getSetting('connection');
    const history = await getSetting('history_import');
    const contacts = await getSetting('contacts_import');
    const { token, ...safe } = c || {};
    return {
        brand: line.brand,
        connection: c ? { ...safe, has_token: !!token } : null,
        history, contacts,
        usingEnv: !c?.token && line.fromEnv,
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
        token: lines.seal(token),
    };
    // The other brand's number, connected here by mistake, would make one inbox answer for both.
    const other = Object.keys(lines.BRANDS).map(b => lines.get(b))
        .find(l => l.brand !== lines.current().brand && l.phoneNumberId && String(l.phoneNumberId) === String(phoneNumberId));
    if (other) throw new ConnectError(`That number is already connected to ${other.name}. Pick ${lines.current().name}'s number instead.`);
    await putSetting('connection', connection);

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
        await putSetting('contacts_import', { status: sync.smb_app_state_sync?.error ? 'failed' : 'requested', ...sync.smb_app_state_sync, contacts: 0 });
        await putSetting('history_import', { status: sync.history?.error ? 'failed' : 'requested', ...sync.history, threads: 0, messages: 0, chunks: 0 });
    }
    return { ...connection, token: undefined, sync };
}

/**
 * The other way in, the one Normless uses: a number registered on the Cloud API in the business's
 * own Meta account, and a permanent System User token for it. No Embedded Signup popup, so no Tech
 * Provider review — the business is only reaching its own number. The token's app must be the one
 * whose webhook points here (WA_APP_SECRET checks every delivery).
 *
 * `pin`, when given, registers the number for Cloud API messaging (Meta's two-step PIN, six
 * digits): needed once, after the number is added in WhatsApp Manager and verified by SMS.
 */
async function connectWithToken({ phoneNumberId, wabaId, token, pin }, who) {
    phoneNumberId = String(phoneNumberId || '').trim();
    wabaId = String(wabaId || '').trim();
    token = String(token || '').trim();
    if (!/^\d{6,20}$/.test(phoneNumberId)) throw new ConnectError('Give the phone number ID — the long number under the phone number in WhatsApp Manager or the app’s API Setup page');
    if (!/^\d{6,20}$/.test(wabaId)) throw new ConnectError('Give the WhatsApp Business Account ID — shown in WhatsApp Manager and on API Setup');
    if (token.length < 50) throw new ConnectError('Paste the whole System User access token');
    if (pin != null && pin !== '' && !/^\d{6}$/.test(String(pin))) throw new ConnectError('The PIN is six digits');

    const graph = (p) => `https://graph.facebook.com/${process.env.WA_API_VERSION || 'v21.0'}${p}`;
    const call = async (url, { method = 'GET', body } = {}) => {
        const res = await fetch(url, {
            method,
            headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(30000),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new ConnectError(data?.error?.message || `Meta refused that (${res.status})`, 502);
        return data;
    };

    // The token can see the number, and the number is in that account.
    const phone = await call(graph(`/${phoneNumberId}?fields=display_phone_number,verified_name,is_on_biz_app,platform_type,code_verification_status`));
    const numbers = await call(graph(`/${wabaId}/phone_numbers?fields=id&limit=100`));
    if (!(numbers.data || []).some(n => String(n.id) === phoneNumberId)) {
        throw new ConnectError('That phone number ID is not in that WhatsApp Business Account — check both IDs on the API Setup page');
    }
    if (pin) await call(graph(`/${phoneNumberId}/register`), { method: 'POST', body: { messaging_product: 'whatsapp', pin: String(pin) } });
    // This app hears the account's webhooks.
    await call(graph(`/${wabaId}/subscribed_apps`), { method: 'POST' });

    const other = Object.keys(lines.BRANDS).map(b => lines.get(b))
        .find(l => l.brand !== lines.current().brand && l.phoneNumberId && String(l.phoneNumberId) === phoneNumberId);
    if (other) throw new ConnectError(`That number is already connected to ${other.name}. Use ${lines.current().name}'s number instead.`);

    const connection = {
        status: 'connected',
        method: 'token',
        coexistence: !!phone.is_on_biz_app,
        platform_type: phone.platform_type || null,
        waba_id: wabaId,
        phone_number_id: phoneNumberId,
        business_id: null,
        display_phone_number: phone.display_phone_number || null,
        business_phone: wa.normalisePhone(phone.display_phone_number || ''),
        verified_name: phone.verified_name || null,
        connected_at: new Date().toISOString(),
        connected_by: who || null,
        token: lines.seal(token),
    };
    await putSetting('connection', connection);
    return { ...connection, token: undefined, registered: !!pin };
}

/**
 * Ask for one sync again — only meant for a request that failed in the first 24 hours. Meta
 * runs each sync once per connection; a second successful request is refused by Meta.
 */
async function requestSync(type, who) {
    const c = await getSetting('connection');
    const token = c?.token && lines.unseal(c.token);
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
    await putSetting(key, { ...prev, status: 'requested', error: null, request_id: data.request_id || null, requested_at: new Date().toISOString(), requested_by: who || null });
    return data;
}

/** Stop using the stored connection. The phone app is unaffected; Meta's side is the app's to undo. */
async function disconnect(who) {
    const c = await getSetting('connection');
    if (!c) return;
    await putSetting('connection', { ...c, status: 'disconnected', token: null, disconnected_at: new Date().toISOString(), disconnected_by: who });
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
}

module.exports = { status, connect, connectWithToken, requestSync, disconnect, accountUpdate, getSetting, putSetting, ConnectError };
