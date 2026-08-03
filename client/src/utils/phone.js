// Every mobile number captured anywhere in the app is a plain 10-digit Indian mobile.
// Historic rows hold things like "98430 - 88300", "918320804061 / +447760193135" and even
// "self pickup by salman", so these helpers exist to stop any more of that getting in.

// Typing filter: keep digits only and never let the field exceed 10. Used as the onChange
// transform so a bad number cannot physically be entered, rather than only being caught on save.
export const cleanMobile = (v) => String(v ?? '').replace(/\D/g, '').slice(0, 10)

export const isValidMobile = (v) => /^\d{10}$/.test(String(v ?? '').trim())

// Blank is left to the field's own `required` flag — this only reports a malformed number,
// so optional fields don't get an error just for being empty.
export const mobileError = (v) => {
  const s = String(v ?? '').trim()
  if (!s) return null
  return isValidMobile(s) ? null : `Must be exactly 10 digits (currently ${s.replace(/\D/g, '').length})`
}

// Shared props for a mobile <input>: numeric keypad on phones, hard 10-digit cap, and the
// browser's own validity check as a last line of defence behind the JS checks.
export const mobileInputProps = {
  type: 'tel',
  inputMode: 'numeric',
  maxLength: 10,
  pattern: '\\d{10}',
  placeholder: '10-digit mobile',
}
