/**
 * The shape of a ticket as the form holds it, and how one is named.
 *
 * Its own file so both the page and the drawer can read it — a component file that also exports
 * helpers breaks fast refresh, and these are the parts with no markup in them anyway.
 */

const today = () => new Date().toLocaleDateString('en-CA')

/** "CS-0043" — short enough to say out loud on a call. */
export const refOf = (t) => `CS-${String(t?.ref_no ?? 0).padStart(4, '0')}`

export const blankTicket = () => ({
  order_number: '', customer_name: '', customer_phone: '', customer_email: '',
  source: 'WhatsApp', nature: '', reason: '', payment_status: '', request: '',
  status: 'Open', progress: 'Pending', action: '', ops_note: '',
  forward_awb: '', return_awb: '', assigned_to: '', raised_on: today(), resolved_on: '',
})

const FIELDS = Object.keys(blankTicket())
/** Only the editable fields, with nulls flattened to '' so React keeps the inputs controlled. */
export const asForm = (t) => Object.fromEntries(FIELDS.map(k => [k, t?.[k] ?? '']))
