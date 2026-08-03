// Mobile numbers are stored as a bare 10-digit Indian mobile everywhere. The UI stops bad
// input at the keyboard, but the API is the actual boundary — quotes, payments and orders can
// all be posted to directly, and imports have historically dropped in things like
// "98430 - 88300" and "self pickup by salman".

const isValidMobile = (v) => /^\d{10}$/.test(String(v ?? '').trim());

// Human labels for the fields carrying a mobile number, so errors name the field the user sees.
const PHONE_FIELDS = {
  contact_number: 'Contact number',
  whatsapp_number: 'WhatsApp number',
  billing_mobile: 'Billing mobile',
};

// Returns an error string for the first bad field, or null.
// `previous` lets updates skip fields that aren't actually changing: 14 historic orders hold
// malformed numbers, and re-validating an untouched value would lock those rows out of every
// unrelated edit (adding a tracking ID, moving status) until someone retyped the phone.
function validatePhoneFields(body, previous = null) {
  for (const [field, label] of Object.entries(PHONE_FIELDS)) {
    if (body[field] === undefined) continue;
    const value = String(body[field] ?? '').trim();
    if (!value) continue; // blank is a required-field question, not a format one
    if (previous && String(previous[field] ?? '').trim() === value) continue;
    if (!isValidMobile(value)) {
      return `${label} must be exactly 10 digits (got "${body[field]}")`;
    }
  }
  return null;
}

module.exports = { isValidMobile, validatePhoneFields, PHONE_FIELDS };
