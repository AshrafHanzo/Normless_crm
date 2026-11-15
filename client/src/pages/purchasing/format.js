/** Shared by the Purchasing pages. */
export const BRAND_LABEL = { both: 'Both brands', normless: 'Normless', crewfit: 'Crewfit' }
export const inr = (v) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(v) || 0)
export const day = (v) => (v ? new Date(`${v}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—')
/** status-badge class per worked-out payment status. */
export const PAY_CLASS = { 'Not Paid': 'pending', 'Part Paid': 'partial', Paid: 'fulfilled', Overpaid: 'refunded' }
export const MODES = ['NEFT', 'IMPS', 'UPI', 'RTGS', 'Cheque', 'Cash']
export const todayYmd = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

/** Open a payment's proof in a new tab — fetched with the login, since a plain link can't carry it. */
export async function openProof(apiFetch, toast, id) {
  const res = await apiFetch(`/api/vendor-payments/${id}/proof`, { responseType: 'blob' })
  if (!res || res.error) { toast.error(res?.error || 'Couldn’t open the proof'); return }
  const url = URL.createObjectURL(res.blob)
  if (!window.open(url, '_blank')) {
    const a = document.createElement('a'); a.href = url; a.download = res.filename || 'proof'
    document.body.appendChild(a); a.click(); a.remove()
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}

/** status-badge class per instalment status. */
export const INSTALMENT_CLASS = { Paid: 'fulfilled', Overdue: 'refunded', Due: 'pending', 'Due soon': 'pending', Upcoming: 'partial', 'On delivery': '', 'No date': '' }

/** One line saying when an instalment falls due. */
export function dueText(i) {
  if (i.status === 'Paid') return 'Paid'
  if (i.due_kind === 'delivery') return i.status === 'Due' ? 'Due — delivered' : 'On delivery'
  if (!i.due_date) return 'Date to be fixed'
  if (i.days < 0) return `${-i.days} day${i.days === -1 ? '' : 's'} overdue · ${day(i.due_date)}`
  if (i.days === 0) return `Due today · ${day(i.due_date)}`
  return `${day(i.due_date)}${i.days <= 7 ? ` · in ${i.days} day${i.days === 1 ? '' : 's'}` : ''}`
}

/** Open a privately stored file (proof, quotation) in a new tab — fetched with the login. */
export async function openFile(apiFetch, toast, url) {
  const res = await apiFetch(url, { responseType: 'blob' })
  if (!res || res.error) { toast.error(res?.error || 'Couldn’t open the file'); return }
  const href = URL.createObjectURL(res.blob)
  if (!window.open(href, '_blank')) {
    const a = document.createElement('a'); a.href = href; a.download = res.filename || 'file'
    document.body.appendChild(a); a.click(); a.remove()
  }
  setTimeout(() => URL.revokeObjectURL(href), 60000)
}

/** status-badge class per quotation status (Expired is an open one past its date). */
export const QUOTE_CLASS = { Received: 'partial', Expired: 'pending', Accepted: 'fulfilled', Rejected: 'refunded' }
