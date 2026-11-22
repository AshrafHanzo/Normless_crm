/**
 * Delhivery's B2C API, as documented at one.delhivery.com/developer-portal (read 22 Nov 2026).
 *
 * The token stays on the server: DELHIVERY_API_TOKEN in .env, never sent to the browser.
 * DELHIVERY_API_BASE switches between production (track.delhivery.com) and staging
 * (staging-express.delhivery.com).
 *
 * What the API does not have, and the CRM therefore works out itself: a list of pickups, a count
 * of what each pickup took, the wallet balance, and the auto-cancel rule.
 */

const BASE = () => (process.env.DELHIVERY_API_BASE || 'https://track.delhivery.com').replace(/\/+$/, '');
const TOKEN = () => process.env.DELHIVERY_API_TOKEN || '';
const configured = () => !!TOKEN();

class DelhiveryError extends Error {
    constructor(message, { status, body } = {}) {
        super(message);
        this.status = status;
        this.body = body;
    }
}

async function call(path, { method = 'GET', json, form, timeout = 30000 } = {}) {
    if (!configured()) throw new DelhiveryError('Delhivery is not connected: DELHIVERY_API_TOKEN is not set on the server');
    const headers = { Authorization: `Token ${TOKEN()}`, Accept: 'application/json' };
    let body;
    if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    if (form !== undefined) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = form; }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
        res = await fetch(`${BASE()}${path}`, { method, headers, body, signal: ctrl.signal });
    } catch (err) {
        throw new DelhiveryError(err.name === 'AbortError' ? 'Delhivery took too long to answer' : `Could not reach Delhivery: ${err.message}`);
    } finally {
        clearTimeout(t);
    }
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
        const msg = (data && (data.error || data.detail || data.rmk || data.message)) || `Delhivery answered ${res.status}`;
        throw new DelhiveryError(typeof msg === 'string' ? msg : JSON.stringify(msg), { status: res.status, body: data });
    }
    return data;
}

const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

/** Serviceability of one pincode: { serviceable, cod, prepaid, pickup, oda, district, state }. */
async function pincode(pin) {
    const d = await call(`/c/api/pin-codes/json/?filter_codes=${encodeURIComponent(pin)}`);
    const p = d?.delivery_codes?.[0]?.postal_code;
    if (!p) return { serviceable: false };
    return {
        serviceable: true,
        cod: p.cod === 'Y', prepaid: p.pre_paid === 'Y', pickup: p.pickup === 'Y',
        oda: p.is_oda === 'Y', district: p.district, state: p.state_code, remarks: p.remarks || '',
    };
}

/** Estimated charge. mode 'S' surface or 'E' express; paymentType 'COD' or 'Pre-paid'. */
async function charges({ originPin, destPin, grams, mode = 'S', paymentType = 'Pre-paid', cod = 0 }) {
    const q = new URLSearchParams({ md: mode, ss: 'Delivered', d_pin: destPin, o_pin: originPin, cgm: String(grams || 500), pt: paymentType, cod: String(cod || 0) });
    const d = await call(`/api/kinko/v1/invoice/charges/.json?${q}`);
    const row = Array.isArray(d) ? d[0] : d;
    return row ? { total: Number(row.total_amount) || 0, gross: Number(row.gross_amount) || 0, cod: Number(row.charge_COD) || 0, zone: row.zone, charged_weight: row.charged_weight } : null;
}

/**
 * Create shipments ("manifest"). The order id may carry "#", which the raw JSON body rejects, so
 * the payload goes URL-encoded as the documentation says.
 * Returns Delhivery's answer: { success, packages: [{ waybill, refnum, status, remarks }], rmk }.
 */
async function createShipments(shipments, pickupLocation) {
    const data = JSON.stringify({ shipments, pickup_location: { name: pickupLocation } });
    return call('/api/cmu/create.json', { method: 'POST', form: `format=json&data=${encodeURIComponent(data)}`, timeout: 60000 });
}

/** Label PDFs, one link per waybill: [{ waybill, url }]. size '4R' (4×6) or 'A4'. */
async function labels(awbs, size = '4R') {
    const out = [];
    for (const group of chunks(awbs, 25)) {
        const d = await call(`/api/p/packing_slip?wbns=${group.map(encodeURIComponent).join(',')}&pdf=true&pdf_size=${size}`, { timeout: 90000 });
        for (const p of d?.packages || []) out.push({ waybill: String(p.wbn || p.waybill || ''), url: p.pdf_download_link || p.pdf_link || null });
        // Some accounts answer with one merged file rather than one per waybill.
        if (!d?.packages && (d?.pdf_download_link || d?.packages_found)) out.push({ waybill: group.join(','), url: d.pdf_download_link || null });
    }
    return out;
}

/** Book a pickup. date YYYY-MM-DD, time hh:mm:ss. */
async function requestPickup({ date, time, location, count }) {
    return call('/fm/request/new/', { method: 'POST', json: { pickup_time: time, pickup_date: date, pickup_location: location, expected_package_count: count } });
}

/** Cancel: allowed while Manifested, In Transit or Pending. */
async function cancel(awb) {
    return call('/api/p/edit', { method: 'POST', json: { waybill: String(awb), cancellation: 'true' } });
}

/** Edit name, phone, address, weight or size. Allowed while Manifested, In Transit or Pending. */
async function edit(awb, fields) {
    return call('/api/p/edit', { method: 'POST', json: { waybill: String(awb), ...fields } });
}

/** Ask for another delivery attempt. Asynchronous: returns a request id (UPL) to check later. */
async function reattempt(awbs) {
    return call('/api/p/update', { method: 'POST', json: { data: awbs.map(w => ({ waybill: String(w), act: 'RE-ATTEMPT' })) } });
}

async function requestStatus(upl) {
    return call(`/api/cmu/get_bulk_upl/${encodeURIComponent(upl)}?verbose=true`);
}

/** Tracking by waybill, 50 per call. Returns Delhivery's Shipment objects. */
async function track(awbs) {
    const out = [];
    for (const group of chunks([...new Set(awbs.filter(Boolean).map(String))], 50)) {
        const d = await call(`/api/v1/packages/json/?waybill=${group.join(',')}`);
        for (const x of d?.ShipmentData || []) if (x?.Shipment) out.push(x.Shipment);
    }
    return out;
}

/** Tracking by order id ("#13584"), 50 per call — how shipments made in the portal are found. */
async function trackByOrder(orderNumbers) {
    const out = [];
    for (const group of chunks([...new Set(orderNumbers.filter(Boolean).map(String))], 50)) {
        const d = await call(`/api/v1/packages/json/?waybill=&ref_ids=${group.map(encodeURIComponent).join(',')}`);
        for (const x of d?.ShipmentData || []) if (x?.Shipment) out.push(x.Shipment);
    }
    return out;
}

module.exports = {
    configured, DelhiveryError,
    pincode, charges, createShipments, labels, requestPickup, cancel, edit, reattempt, requestStatus, track, trackByOrder,
};
