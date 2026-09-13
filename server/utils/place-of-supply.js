/**
 * Which state a Crewfit order is supplied to. Place of supply picks the tax head — CGST+SGST at
 * home, IGST anywhere else — so the register cannot file a row without it, and a blank one used
 * to be filed as inter-state by default (seven Tamil Nadu rows went into the August 2026 return
 * as IGST that way).
 *
 * Evidence in order of reliability: the GSTIN's state code, a pincode in the address, a state
 * name at the tail of the address, a well-known city. Lifted from db/backfill-crewfit-invoices.js
 * so the order save path derives the same answer the migration did.
 */

// GST state codes — the first two digits of a GSTIN identify the state.
const STATE_BY_CODE = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka',
  '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
};
const STATE_NAMES = [...new Set(Object.values(STATE_BY_CODE))].sort();

// PIN prefix (first three digits) → state. Far more reliable than looking for a state name in the
// address: "Near Kerala furniture, Madurai ... Tamilnadu" filed a Tamil Nadu sale under Kerala on
// a name match. Narrow ranges come first because several sit inside broader ones (605 Puducherry
// inside Tamil Nadu, 682 Lakshadweep inside Kerala, 814–835 Jharkhand inside Bihar).
const PIN_RANGES = [
  [160, 160, 'Chandigarh'], [403, 403, 'Goa'], [605, 605, 'Puducherry'], [682, 682, 'Lakshadweep'],
  [737, 737, 'Sikkim'], [744, 744, 'Andaman and Nicobar Islands'], [248, 263, 'Uttarakhand'],
  [814, 835, 'Jharkhand'], [110, 110, 'Delhi'], [121, 136, 'Haryana'], [140, 152, 'Punjab'],
  [171, 177, 'Himachal Pradesh'], [180, 194, 'Jammu and Kashmir'], [201, 285, 'Uttar Pradesh'],
  [301, 345, 'Rajasthan'], [360, 396, 'Gujarat'], [400, 445, 'Maharashtra'],
  [450, 488, 'Madhya Pradesh'], [490, 497, 'Chhattisgarh'], [500, 509, 'Telangana'],
  [515, 535, 'Andhra Pradesh'], [560, 591, 'Karnataka'], [600, 643, 'Tamil Nadu'],
  [670, 695, 'Kerala'], [700, 743, 'West Bengal'], [751, 770, 'Odisha'], [781, 788, 'Assam'],
  [790, 792, 'Arunachal Pradesh'], [793, 794, 'Meghalaya'], [795, 795, 'Manipur'],
  [796, 796, 'Mizoram'], [797, 798, 'Nagaland'], [799, 799, 'Tripura'], [800, 855, 'Bihar'],
];
const stateForPin = (pin) => (PIN_RANGES.find(([lo, hi]) => pin >= lo && pin <= hi) || [])[2] || null;

/** Six digits, tolerating the space people write mid-pincode ("600 018"). Last one wins. */
function pinIn(text) {
  const hits = String(text).match(/\b(\d{3})\s?(\d{3})\b/g) || [];
  if (!hits.length) return null;
  return parseInt(hits[hits.length - 1].replace(/\s/g, '').slice(0, 3), 10);
}

/** A state name, but only near the end where addresses actually put it, and ignoring spacing
 *  so "Tamilnadu" matches "Tamil Nadu". */
function trailingState(addr) {
  const tail = String(addr).slice(-40).toLowerCase().replace(/[^a-z]/g, '');
  return STATE_NAMES.find(s => tail.includes(s.toLowerCase().replace(/[^a-z]/g, ''))) || null;
}

// Last resort for addresses written without a pincode — weaker evidence than a GSTIN or a PIN.
const CITY_STATE = {
  chennai: 'Tamil Nadu', coimbatore: 'Tamil Nadu', madurai: 'Tamil Nadu', trichy: 'Tamil Nadu',
  tiruchirappalli: 'Tamil Nadu', salem: 'Tamil Nadu', erode: 'Tamil Nadu', tirupur: 'Tamil Nadu',
  vellore: 'Tamil Nadu', thanjavur: 'Tamil Nadu', bengaluru: 'Karnataka', bangalore: 'Karnataka',
  mumbai: 'Maharashtra', pune: 'Maharashtra', hyderabad: 'Telangana', kolkata: 'West Bengal',
  ahmedabad: 'Gujarat', kochi: 'Kerala', cochin: 'Kerala', trivandrum: 'Kerala',
};
function cityState(addr) {
  const hay = String(addr).toLowerCase();
  const hit = Object.keys(CITY_STATE).find(c => hay.includes(c));
  return hit ? { state: CITY_STATE[hit], city: hit } : null;
}

/**
 * Best reading of an order's place of supply: { state, from, weak }. `state` is null when the
 * order gives nothing to go on — the caller decides whether to fall back to the home state.
 */
function derivePlaceOfSupply(order) {
  const code = (order.gst_number || '').trim().slice(0, 2);
  if (STATE_BY_CODE[code]) return { state: STATE_BY_CODE[code], from: `GSTIN ${code}` };

  const addr = [order.billing_address, order.delivery_location].filter(Boolean).join('\n');
  const pin = pinIn(addr);
  const byPin = pin ? stateForPin(pin) : null;
  if (byPin) return { state: byPin, from: `PIN ${pin}xxx` };

  const byName = trailingState(addr);
  if (byName) return { state: byName, from: 'address' };

  const byCity = cityState(addr);
  if (byCity) return { state: byCity.state, from: `city ${byCity.city}`, weak: true };

  return { state: null, from: 'unknown' };
}

/** The canonical spelling of a state, for whatever an operator typed; null if unrecognised. */
function normaliseState(text) {
  const key = String(text || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!key) return null;
  return STATE_NAMES.find(s => s.toLowerCase().replace(/[^a-z]/g, '') === key) || null;
}

module.exports = { STATE_BY_CODE, STATE_NAMES, derivePlaceOfSupply, normaliseState, pinIn, stateForPin };
