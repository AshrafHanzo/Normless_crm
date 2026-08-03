import { useState, useEffect } from 'react'
import { useApi, useAuth } from '../../App'
import { useToast } from '../../components/Toast'
import { cleanMobile, mobileError, isValidMobile, mobileInputProps } from '../../utils/phone'

const fmt = (v) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v || 0)
const PRINTING = ['Front', 'Back', 'Front & Back', 'Front Chest & Back', 'No Print']
const STANDARD_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL']

// "XS-2, S-5, M-3" -> { XS: '2', S: '5', M: '3' }. Returns null if the text doesn't
// cleanly match that shape (e.g. free-typed kids sizing) — caller falls back to manual mode.
function parseSimpleSizeBreakdown(text) {
  if (!text) return {}
  const parts = text.split(',').map(p => p.trim()).filter(Boolean)
  if (!parts.length) return {}
  const counts = {}
  for (const part of parts) {
    const m = part.match(/^([A-Za-z0-9]+)\s*-\s*(\d+)$/)
    if (!m) return null
    const label = STANDARD_SIZES.find(s => s.toLowerCase() === m[1].toLowerCase())
    if (!label) return null
    counts[label] = m[2]
  }
  return counts
}
const buildSizeBreakdown = (sizes) => STANDARD_SIZES.filter(s => Number(sizes[s]) > 0).map(s => `${s}-${sizes[s]}`).join(', ')

function priceFor(product, qty) {
  if (!product || !qty) return null
  let price = null
  for (const [label, val] of (product.tiers || [])) {
    if (typeof val !== 'number') continue
    const n = (label.match(/\d+/g) || [0])[0]
    if (qty >= parseInt(n, 10)) price = val
  }
  return price
}

// Courier tariff (By Air), from the tariff sheet: flat rate up to a weight, then per-kg beyond 3kg.
const SHIP_ZONES = {
  'Chennai': { flat: [[0.25, 40], [0.5, 60], [1, 80], [2, 150], [3, 180]], perKg: [[10, 45], [24, 35], [Infinity, 30]] },
  'Tamil Nadu': { flat: [[0.25, 60], [0.5, 80], [1, 110], [2, 180], [3, 250]], perKg: [[10, 55], [24, 45], [Infinity, 40]] },
  'South (KA/AP/KL/TLN)': { flat: [[0.25, 100], [0.5, 120], [1, 170], [2, 300], [3, 450]], perKg: [[10, 100], [24, 75], [Infinity, 70]] },
  'Metro (MUM/DEL/KOL/AMD)': { flat: [[0.25, 150], [0.5, 250], [1, 270], [2, 500], [3, 600]], perKg: [[10, 200], [24, 200], [Infinity, 200]] },
  'ROI (North/East/West)': { flat: [[0.25, 200], [0.5, 250], [1, 300], [2, 550], [3, 675]], perKg: [[10, 250], [24, 250], [Infinity, 250]] },
  'Jammu & Andaman': { flat: [[0.25, 200], [0.5, 250], [1, 300], [2, 550], [3, 700]], perKg: [[10, 280], [24, 210], [Infinity, 200]] },
}
const SHIP_REGIONS = Object.keys(SHIP_ZONES)
const PIECE_WEIGHT_KG = 0.5 // assume 500g per t-shirt

function shippingFor(region, qty) {
  const zone = SHIP_ZONES[region]
  if (!zone || !qty) return null
  const weightKg = qty * PIECE_WEIGHT_KG
  for (const [maxKg, price] of zone.flat) if (weightKg <= maxKg) return price
  for (const [maxKg, rate] of zone.perKg) if (weightKg <= maxKg) return Math.ceil(weightKg) * rate
  return null
}

function blankItem() {
  return {
    product: '', color: '', printing: 'Front & Back', qty: '', unit_price: '', product_total: '', size_breakdown: '',
    _sizeMode: 'standard', _sizes: {}, _pendingMock: [], _pendingProd: [],
  }
}
// Local calendar date (YYYY-MM-DD). toISOString() would report yesterday for any IST time
// before 05:30, which is exactly when a late-night order would get the wrong date.
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

export function blankOrder() {
  // Order date defaults to today (still editable). The deadline is deliberately left blank —
  // it's set to advance payment date + 7 days once the advance actually lands, since the
  // production clock starts on payment, not on when the order was keyed in.
  return {
    status: 'Pending', payment_status: 'Pending', layout_status: 'Pending', customer_type: 'New',
    order_date: todayStr(),
    _gstPct: 5, shipping: '', ship_region: 'Tamil Nadu', whatsapp_number: '', line_items: [blankItem()],
  }
}
const waSource = (order) => order.whatsapp_number || order.contact_number || order.billing_mobile

// order-level totals: qty & product subtotal are summed straight from the line items as given
// (each item's own total is maintained by the item handlers, not recalculated here)
function recompute(f) {
  const items = f.line_items || []
  const qty = items.reduce((s, it) => s + (parseInt(it.qty) || 0), 0)
  const pt = items.reduce((s, it) => s + (it.product_total !== undefined && it.product_total !== '' ? Number(it.product_total) : 0), 0)
  const ship = Number(f.shipping) || 0
  const gstPct = f._gstPct ?? 0
  const gst = Math.round((pt + ship) * gstPct / 100)
  const grand = pt + ship + gst
  const advance = Math.round(grand / 2)
  return { product_total: pt, gst_amount: gst, grand_total: grand, advance, balance: grand - advance, total_cost: grand, qty }
}

const PAYMENT_LINK_PLACEHOLDER = '[PAYMENT LINK]'
const dash = (v) => (v === undefined || v === null || v === '' ? '—' : v)

// Client-facing order confirmation, formatted for pasting straight into WhatsApp
// (single-asterisk *bold*, not markdown's **bold**).
function buildDescription(f) {
  const items = (f.line_items || []).filter(it => it.product || it.qty)
  const L = ['Thank you for sharing the details 🙌', '', 'Please review your order confirmation below:', '']
  items.forEach((it, i) => {
    if (items.length > 1) L.push(`*— Product ${i + 1} —*`)
    L.push(`📦 *Product:* ${dash(it.product)}${it.color ? ` (${it.color})` : ''}`)
    L.push(`👕 *Quantity:* ${dash(it.qty)}`)
    L.push(`💵 *Price Per Piece:* ₹${it.unit_price || 0}`)
    L.push(`🎨 *Printing:* ${dash(it.printing)}`)
    L.push(`📏 *Size Breakdown:* ${dash(it.size_breakdown)}`)
    L.push('')
  })
  L.push(`📍 *Delivery Address:* ${dash(f.delivery_location)}`, '')
  L.push('🧾 *Billing Details:*')
  L.push(`🏢 *Billing Name / Company:* ${dash(f.billing_name)}`)
  L.push(`👤 *Contact Person:* ${dash(f.contact_person)}`)
  L.push(`📞 *Mobile Number:* ${dash(f.billing_mobile)}`)
  L.push(`📧 *Email Address:* ${dash(f.billing_email)}`)
  L.push(`🧾 *GST Number:* ${f.gst_number || 'NA'}`, '')
  L.push(`💰 *Product Subtotal:* ₹${f.product_total || 0}`)
  L.push(`🚚 *Shipping Charges:* ₹${f.shipping || 0}`)
  L.push(`🧾 *GST (${f._gstPct ?? 0}%):* ₹${f.gst_amount || 0}`)
  L.push(`💵 *Grand Total:* ₹${f.grand_total || 0}`, '')
  L.push(`💳 *Advance Payable (50%):* ₹${f.advance || 0}`)
  L.push(`💵 *Balance Payable Before Dispatch:* ₹${f.balance || 0}`, '')
  L.push('Please complete the advance payment using the link below to begin production:', '')
  // Once an advance link exists it goes straight into the summary; until then the placeholder
  // stays so the SO can still paste a link in by hand.
  L.push(`🔗 ${f._advanceLink || PAYMENT_LINK_PLACEHOLDER}`, '')
  L.push('Kindly verify all the above details before making the payment.', '')
  L.push('Once the payment is completed, please share the payment confirmation screenshot here.', '')
  L.push('Production will begin immediately after payment verification. 🚀')
  return L.join('\n')
}

// The balance-collection message, sent once production photos have gone across. Mirrors the
// order-summary template but recaps what's already been paid and asks only for the remainder —
// so it reads as the closing step of the order rather than a fresh quote.
function buildBalanceMessage(f, payment) {
  const items = (f.line_items || []).filter(it => it.product || it.qty)
  const grand = Number(f.grand_total) || 0
  const balance = payment ? Number(payment.amount) : (Number(f.balance) || 0)
  const paid = Math.max(0, grand - balance)

  const L = [`Hi ${f.customer_name || 'there'}! 🎉`, '']
  L.push(`Great news — your Crewfit order (Ref: CF-${f.sl_no}) is *production complete* and ready for dispatch! ✅`, '')
  L.push('📸 Please check the production photos shared above.', '')
  L.push('*— Order Summary —*')
  items.forEach((it, i) => {
    if (items.length > 1) L.push(`*Product ${i + 1}*`)
    L.push(`📦 *Product:* ${dash(it.product)}${it.color ? ` (${it.color})` : ''}`)
    L.push(`👕 *Quantity:* ${dash(it.qty)}`)
    L.push(`🎨 *Printing:* ${dash(it.printing)}`)
    L.push(`📏 *Size Breakdown:* ${dash(it.size_breakdown)}`)
    L.push('')
  })
  L.push(`💵 *Grand Total:* ₹${grand.toLocaleString('en-IN')}`)
  L.push(`✅ *Advance Already Paid:* ₹${paid.toLocaleString('en-IN')}`)
  L.push(`💰 *Balance Payable Now:* ₹${balance.toLocaleString('en-IN')}`, '')
  L.push('Kindly complete the balance payment using the secure link below so we can dispatch your order right away:', '')
  L.push(`🔗 ${payment?.razorpay_short_url || PAYMENT_LINK_PLACEHOLDER}`, '')
  L.push(`📍 *Delivery Address:* ${dash(f.delivery_location)}`, '')
  L.push('Once the payment is confirmed, we will dispatch your order and share the tracking details with you. 🚚', '')
  L.push('Thank you for choosing Crewfit! 🙌')
  return L.join('\n')
}

// Short, standalone nudge for one payment link — used when chasing the advance or the
// balance on its own, rather than resending the whole order summary.
function buildPaymentMessage(order, payment) {
  const half = payment.kind === 'advance' ? 'advance (50%)' : payment.kind === 'balance' ? 'balance' : 'payment';
  const L = [`Hi ${order.customer_name || 'there'}! 👋`, '']
  L.push(`Here's the secure payment link for the ${half} of your Crewfit order (Ref: CF-${order.sl_no}):`, '')
  L.push(`💵 *Amount:* ₹${Number(payment.amount).toLocaleString('en-IN')}`)
  L.push(`🔗 ${payment.razorpay_short_url}`, '')
  L.push(payment.kind === 'balance'
    ? 'Once this is paid we will dispatch your order right away. 🚚'
    : 'Production begins as soon as this payment is confirmed. 🚀')
  L.push('', 'Thank you for choosing Crewfit! 🙌')
  return L.join('\n')
}

// Indian mobile → wa.me expects digits only with country code, no leading 0/+.
function toWaNumber(phone) {
  let digits = (phone || '').replace(/\D/g, '')
  if (!digits) return null
  if (digits.length === 10) digits = '91' + digits
  else if (digits.length === 11 && digits.startsWith('0')) digits = '91' + digits.slice(1)
  return digits
}

// Only ST Courier has a public trace page we can deep-link into by consignment number.
// Every other MOT gets the bare tracking ID — pointing a DTDC or Delhivery number at
// ST Courier's tracker just lands the customer on a "not found" page.
export const trackingUrl = (order) =>
  order?.mot === 'ST Courier' && order?.tracking_link
    ? `https://trackcourier.io/track-and-trace/st-courier/${String(order.tracking_link).trim()}`
    : null

// Porter deliveries don't come with a tracking ID — a different, shorter template
// is used instead of the tracking-details one.
function buildDispatchMessage(order) {
  if (order.mot === 'Porter') {
    const L = [`Hi ${order.customer_name || 'there'}! 🎉`, '', `Your Crewfit order (Ref: CF-${order.sl_no}) has been dispatched through *Porter*.`, '']
    if (order.dispatch_date) L.push(`📅 *Dispatched On:* ${order.dispatch_date}`)
    L.push('', 'We hope you are happy with our service! 🙌', '', 'Thank you for choosing Crewfit!')
    return L.join('\n')
  }
  const L = [`Hi ${order.customer_name || 'there'}! 🎉`, '', `Your Crewfit order (Ref: CF-${order.sl_no}) has been dispatched${order.mot ? ` via ${order.mot}` : ''}.`, '']
  L.push(`📦 *Tracking ID:* ${order.tracking_link || '—'}`)
  const url = trackingUrl(order)
  if (url) L.push(`🔗 *Track your parcel here:* ${url}`)
  if (order.dispatch_date) L.push(`📅 *Dispatched On:* ${order.dispatch_date}`)
  L.push('', 'Thank you for choosing Crewfit! We hope to serve you again. 🙌')
  return L.join('\n')
}

// wa.me links are text-only, so production photos go across as plain image URLs the
// client can tap open — same limitation the order-summary/dispatch templates work within.
function buildPhotosMessage(order, apiUrl) {
  const items = (order.line_items || []).filter(it => (it.prodImages || []).length)
  const L = [`Hi ${order.customer_name || 'there'}! 👕`, '', `Here are the production photos for your Crewfit order (Ref: CF-${order.sl_no}):`, '']
  items.forEach((it, i) => {
    L.push(`*${it.product || `Product ${i + 1}`}*`)
    it.prodImages.forEach(u => L.push(`${apiUrl}${u}`))
    L.push('')
  })
  L.push('Please have a look — once you\'re happy with these, kindly complete the balance payment so we can proceed with dispatch. 🙌')
  return L.join('\n')
}

// The label PDF is served inline, so it opens in a new tab where the SO can print it straight
// away. It's blob-fetched rather than plain-linked because the endpoint needs the auth header —
// and popup blockers get a download fallback. Shared with the orders table.
export async function openShippingLabel(apiFetch, order, toast) {
  const res = await apiFetch(`/api/crewfit/orders/${order.id}/shipping-label`, { responseType: 'blob' })
  if (!res || res.error) { toast?.error(res?.error || 'Failed to generate shipping label'); return }
  const url = URL.createObjectURL(res.blob)
  const win = window.open(url, '_blank')
  if (!win) {
    const a = document.createElement('a')
    a.href = url; a.download = res.filename || `Shipping-Label-CF-${order.sl_no}.pdf`
    document.body.appendChild(a); a.click(); a.remove()
  }
  // The new tab still needs the object URL alive — let it settle before releasing.
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}

// Uploaded (server-backed) + pending (picked but not saved yet, local blob preview) images for
// one product line item's mock/production set — a homogeneous shape the grid and lightbox share.
function imageThumbs(item, kind, apiUrl) {
  const uploadedKey = kind === 'mock' ? 'mockImages' : 'prodImages'
  const pendingKey = kind === 'mock' ? '_pendingMock' : '_pendingProd'
  const uploaded = (item[uploadedKey] || []).map(url => ({ src: `${apiUrl}${url}`, pending: false, ref: url }))
  const pending = (item[pendingKey] || []).map(p => ({ src: p.previewUrl, pending: true, ref: p }))
  return [...uploaded, ...pending]
}

// Instagram-style tile grid: existing thumbnails + a dashed "add" tile, up to `max`. Uploads are
// always available, even before the order is first saved — new orders queue picks as "pending"
// (dashed amber outline) and they're pushed to the server right after the order is created.
// Clicking a thumbnail hands off to the parent's lightbox instead of opening a new tab.
function ImageUploadGrid({ icon, label, thumbs, max = 5, busy, onUpload, onView, onDownloadAll, downloadBusy }) {
  const uploadedCount = thumbs.filter(t => !t.pending).length
  return (
    <div className="img-upload-block">
      <div className="img-upload-head">
        <span className="img-upload-label">{icon} {label}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {uploadedCount > 1 && (
            <button type="button" className="mini-btn" onClick={onDownloadAll} disabled={downloadBusy}>{downloadBusy ? 'Downloading…' : '⬇ Download all'}</button>
          )}
          <span className="img-count-badge">{thumbs.length}/{max}</span>
        </span>
      </div>
      <div className="img-thumb-grid">
        {thumbs.map((t, i) => (
          <div className={`img-thumb ${t.pending ? 'img-thumb-pending' : ''}`} key={t.pending ? t.src : t.ref} onClick={() => onView(i)} title={t.pending ? 'Pending upload — click to view' : 'Click to view'}>
            <img src={t.src} alt={label} />
            {t.pending && <span className="img-pending-badge" title="Will upload once the order is saved" />}
          </div>
        ))}
        {thumbs.length < max && (
          <label className={`img-thumb img-thumb-add ${busy ? 'img-thumb-busy' : ''}`}>
            {busy ? <span className="img-spinner" /> : <span className="img-thumb-add-icon">+</span>}
            <input type="file" accept="image/png,image/jpeg,image/webp" multiple hidden disabled={busy}
              onChange={e => { onUpload(e.target.files); e.target.value = '' }} />
          </label>
        )}
      </div>
    </div>
  )
}

// One half of an order's payment: generate the Razorpay link, share it, then watch it settle.
// "Check status" is the manual fallback for a webhook that never arrived.
function PaymentCard({ title, amount, payment, busy, disabled, disabledLabel, onGenerate, onCopy, onSend, onCancel }) {
  const state = payment?.status === 'Paid' ? 'issued' : payment ? 'ready' : disabled ? 'locked' : 'ready';
  return (
    <div className={`invoice-card invoice-card-${state}`}>
      <div className="invoice-card-head">
        <span className="invoice-card-icon">{payment?.status === 'Paid' ? '✅' : '🔗'}</span>
        <div className="invoice-card-heading">
          <div className="invoice-card-title">{title}</div>
          <div className="invoice-card-amount">{fmt(amount)}</div>
        </div>
        <span className={`invoice-status-pill invoice-status-${state}`}>
          {payment?.status === 'Paid' ? 'Paid' : payment ? 'Link sent' : disabled ? 'Locked' : 'Not sent'}
        </span>
      </div>
      {payment && (
        <div className="invoice-card-meta" style={{ display: 'block' }}>
          <a href={payment.razorpay_short_url} target="_blank" rel="noreferrer" className="pay-link">{payment.razorpay_short_url}</a>
          <div style={{ marginTop: 4 }}>
            {payment.status === 'Paid'
              ? `Paid ${payment.paid_at ? new Date(payment.paid_at).toLocaleString('en-IN') : ''}`
              : payment.sent_at ? `Sent ${new Date(payment.sent_at).toLocaleDateString('en-IN')}` : 'Not shared yet'}
          </div>
        </div>
      )}
      {!payment ? (
        <button type="button" className="btn btn-secondary invoice-card-btn" disabled={busy || disabled} onClick={onGenerate}>
          {busy ? 'Creating…' : disabled ? disabledLabel : 'Generate payment link'}
        </button>
      ) : payment.status === 'Paid' ? (
        <button type="button" className="btn btn-secondary invoice-card-btn" onClick={onCopy}>📋 Copy link</button>
      ) : (
        <div className="pay-card-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onSend}>💬 WhatsApp</button>
          <button type="button" className="mini-btn" onClick={onCopy}>📋 Copy</button>
          <button type="button" className="mini-btn" onClick={onCancel} style={{ color: 'var(--danger)' }}>Cancel</button>
          <span className="pay-live-dot" title="Checked with Razorpay every 10 seconds"><i />watching</span>
        </div>
      )}
    </div>
  );
}

function InvoiceCard({ title, amount, invoice, busy, locked, lockedLabel, onGenerate }) {
  const status = invoice ? 'issued' : locked ? 'locked' : 'ready'
  return (
    <div className={`invoice-card invoice-card-${status}`}>
      <div className="invoice-card-head">
        <span className="invoice-card-icon">🧾</span>
        <div className="invoice-card-heading">
          <div className="invoice-card-title">{title}</div>
          <div className="invoice-card-amount">{fmt(amount)}</div>
        </div>
        <span className={`invoice-status-pill invoice-status-${status}`}>{status === 'issued' ? 'Issued' : status === 'locked' ? 'Locked' : 'Ready'}</span>
      </div>
      {invoice && (
        <div className="invoice-card-meta">
          <span>{invoice.number}</span>
          <span>{invoice.date}</span>
        </div>
      )}
      <button type="button" className="btn btn-secondary invoice-card-btn" disabled={busy || (!invoice && locked)} onClick={onGenerate}>
        {busy ? 'Generating…' : invoice ? '⬇ Download PDF' : locked ? lockedLabel : 'Generate Invoice'}
      </button>
    </div>
  )
}

// target: null (closed) | 'new' (blank order) | an order object to edit.
export default function CrewfitOrderDrawer({ target, onClose, onSaved }) {
  const apiFetch = useApi()
  const { API_URL, user } = useAuth()
  const toast = useToast()
  // Deleting an order is unrecoverable and takes its photos with it — owner only, matching
  // the server-side guard on DELETE /orders/:id.
  const isOwner = user?.role === 'owner'
  const [meta, setMeta] = useState(null)
  const [products, setProducts] = useState([])
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const [invoiceBusy, setInvoiceBusy] = useState(null)
  const [imgBusy, setImgBusy] = useState(null) // `${idx}-mock` | `${idx}-prod` while an upload is in flight
  const [lightbox, setLightbox] = useState(null) // { idx, kind, images, index } | null
  const [bulkDownloading, setBulkDownloading] = useState(null) // key string while a "download all" is in flight
  const [labelBusy, setLabelBusy] = useState(false)
  const [payments, setPayments] = useState([])
  const [payBusy, setPayBusy] = useState(null) // 'advance' | 'balance' while a link call is in flight
  const [deleting, setDeleting] = useState(false)
  const [custHistory, setCustHistory] = useState(null) // prior orders on this phone, or null while unknown

  useEffect(() => {
    apiFetch('/api/crewfit/meta').then(m => setMeta(m && m.statuses ? m : null))
    apiFetch('/api/crewfit/products').then(r => setProducts(r?.products || []))
  }, [])

  useEffect(() => {
    if (!lightbox) return
    const onKey = e => { if (e.key === 'Escape') setLightbox(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightbox])

  // New vs Returning is decided by whether the phone number has ordered before, so it follows the
  // number rather than being picked by hand. Debounced because it fires while the SO is still
  // typing; the order being edited is excluded so an existing order never counts itself.
  const phoneKey = (form?.contact_number || '').replace(/\D/g, '').slice(-10)
  useEffect(() => {
    if (!form) return
    if (phoneKey.length < 10) { setCustHistory(null); return }
    let cancelled = false
    const t = setTimeout(async () => {
      const qs = new URLSearchParams({ phone: phoneKey, ...(form.id ? { excludeId: String(form.id) } : {}) })
      const r = await apiFetch(`/api/crewfit/customers/lookup?${qs}`)
      if (cancelled || !r || r.error) return
      setCustHistory(r)
      setForm(f => (f && f.customer_type !== r.customer_type ? { ...f, customer_type: r.customer_type } : f))
    }, 400)
    return () => { cancelled = true; clearTimeout(t) }
  }, [phoneKey, form?.id])

  useEffect(() => {
    if (target === 'new') setForm(blankOrder())
    else if (target) openEdit(target)
    else setForm(null)
    setPayments([])
    if (target && target !== 'new' && target.id) loadPayments(target.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  const loadPayments = async (orderId) => {
    const res = await apiFetch(`/api/crewfit/payments/for-order/${orderId}`)
    if (res && !res.error) setPayments(res.payments || [])
    return res
  }

  // While an unpaid link is on screen, re-check it with Razorpay every 10s so the card flips to
  // Paid on its own. Scoped to this order, paused when the tab is hidden, and the server applies
  // its own per-link cooldown so this stays cheap even with the Payments tab open alongside.
  const openLinkCount = payments.filter(p => p.status === 'Created').length
  useEffect(() => {
    if (!form?.id || !openLinkCount) return
    let inFlight = false
    const tick = async () => {
      if (document.hidden || inFlight) return
      inFlight = true
      try {
        const res = await apiFetch('/api/crewfit/payments/sync-pending', { method: 'POST', body: JSON.stringify({ orderId: form.id }) })
        if (res && !res.error) {
          await loadPayments(form.id)
          // A settled payment may have moved the order's status/deadline — pull those back in.
          if (res.nowPaid) {
            const fresh = await apiFetch(`/api/crewfit/orders/${form.id}`)
            if (fresh && !fresh.error) setF({ payment_status: fresh.payment_status, status: fresh.status, deadline_at: fresh.deadline_at })
          }
        }
      } finally { inFlight = false }
    }
    const id = setInterval(tick, 10000)
    const onVisible = () => { if (!document.hidden) tick() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form?.id, openLinkCount])

  const openEdit = (o) => {
    const base = (Number(o.product_total) || 0) + (Number(o.shipping) || 0)
    let items = Array.isArray(o.line_items) && o.line_items.length ? o.line_items : null
    if (!items) {
      // legacy single-product order — synthesize one line item from the flat fields
      items = (o.product || o.qty || o.product_total) ? [{
        product: o.product || '', color: o.color || '', printing: o.printing || 'Front & Back', qty: o.qty || '',
        unit_price: o.unit_price ?? (o.product_total && o.qty ? Math.round((o.product_total / o.qty) * 100) / 100 : ''),
        product_total: o.product_total ?? '', size_breakdown: o.size_breakdown || ''
      }] : [blankItem()]
    }
    // _saved marks a row the server already knows about (or, for legacy flat orders, one it will
    // materialize on first write) — only those can take image uploads by index right away.
    items = items.map(it => {
      const parsedSizes = parseSimpleSizeBreakdown(it.size_breakdown)
      return { ...it, _saved: true, _sizeMode: parsedSizes ? 'standard' : 'manual', _sizes: parsedSizes || {} }
    })
    setForm({
      ...o,
      _gstPct: o.gst_amount != null && base ? Math.round(o.gst_amount / base * 100) : 5,
      ship_region: o.ship_region || 'Tamil Nadu',
      line_items: items
    })
  }

  const revokePendingUrls = (items) => {
    items.forEach(it => {
      ;(it._pendingMock || []).forEach(p => URL.revokeObjectURL(p.previewUrl))
      ;(it._pendingProd || []).forEach(p => URL.revokeObjectURL(p.previewUrl))
    })
  }
  const closeDrawer = () => {
    if (form) revokePendingUrls(form.line_items)
    setForm(null); setLightbox(null); onClose?.()
  }

  // set order-level fields + recompute money
  const setF = (patch, recalc = false) => setForm(f => { const nf = { ...f, ...patch }; return recalc ? { ...nf, ...recompute(nf) } : nf })

  const updateItem = (idx, patch) => {
    const items = form.line_items.map((it, i) => i === idx ? { ...it, ...patch } : it)
    setF({ line_items: items }, true)
  }
  const onItemProduct = (idx, name) => {
    const item = form.line_items[idx]
    const p = products.find(x => x.name === name)
    const qty = parseInt(item.qty) || 0
    const pp = priceFor(p, qty)
    updateItem(idx, { product: name, ...(pp != null ? { unit_price: pp, product_total: pp * qty } : {}) })
  }
  const onItemQty = (idx, q, extra = {}) => {
    const item = form.line_items[idx]
    const product = products.find(x => x.name === item.product)
    const qty = parseInt(q) || 0
    const catalogPrice = priceFor(product, qty)
    const up = catalogPrice != null ? catalogPrice : (item.unit_price !== undefined && item.unit_price !== '' ? Number(item.unit_price) : null)
    const items = form.line_items.map((it, i) => i === idx ? { ...it, qty: q, ...extra, ...(up != null ? { unit_price: up, product_total: up * qty } : {}) } : it)
    const totalQty = items.reduce((s, it) => s + (parseInt(it.qty) || 0), 0)
    const ship = shippingFor(form.ship_region, totalQty)
    setF({ line_items: items, ...(ship != null ? { shipping: ship } : {}) }, true)
  }
  const onItemUnitPrice = (idx, v) => {
    const item = form.line_items[idx]
    const qty = parseInt(item.qty) || 0
    updateItem(idx, { unit_price: v, ...(qty && v !== '' ? { product_total: Number(v) * qty } : {}) })
  }
  const onItemSizeCount = (idx, size, value) => {
    const item = form.line_items[idx]
    const sizes = { ...(item._sizes || {}), [size]: value }
    const totalQty = STANDARD_SIZES.reduce((sum, s) => sum + (parseInt(sizes[s]) || 0), 0)
    onItemQty(idx, totalQty ? String(totalQty) : '', { _sizes: sizes, size_breakdown: buildSizeBreakdown(sizes) })
  }
  const setItemSizeMode = (idx, mode) => {
    const item = form.line_items[idx]
    if (mode === 'standard') {
      const parsed = parseSimpleSizeBreakdown(item.size_breakdown) || {}
      updateItem(idx, { _sizeMode: 'standard', _sizes: parsed, size_breakdown: buildSizeBreakdown(parsed) })
    } else {
      updateItem(idx, { _sizeMode: 'manual' })
    }
  }
  const addItem = () => setF({ line_items: [...form.line_items, blankItem()] })
  const removeItem = (idx) => {
    revokePendingUrls([form.line_items[idx]])
    const items = form.line_items.filter((_, i) => i !== idx)
    setF({ line_items: items.length ? items : [blankItem()] }, true)
  }
  // Merge the server's freshly-saved line_items (images, confirmation flags) back onto the
  // form without clobbering the UI-only _sizeMode/_sizes fields the server doesn't know about.
  const applyServerOrder = (res) => {
    setForm(f => {
      const saved = (res.line_items || []).map((sv, i) => ({ ...(f.line_items[i] || {}), ...sv, _saved: true }))
      // Rows added in the drawer but not saved yet aren't in the server's copy — keep them.
      const unsaved = f.line_items.slice(saved.length)
      return { ...f, line_items: [...saved, ...unsaved], invoices: res.invoices }
    })
  }
  // Before the order has an id — or before a freshly added product row has been saved onto it —
  // picked files can't go anywhere server-side yet. Queue them locally (with a blob preview) and
  // they're uploaded for real right after the order is saved.
  const addPendingImages = (idx, kind, files) => {
    const uploadedKey = kind === 'mock' ? 'mockImages' : 'prodImages'
    const pendingKey = kind === 'mock' ? '_pendingMock' : '_pendingProd'
    const item = form.line_items[idx]
    const room = 5 - (item[uploadedKey] || []).length - (item[pendingKey] || []).length
    if (room <= 0) { toast.warning(`Max 5 ${kind === 'mock' ? 'mock' : 'production'} images per product`); return }
    const accepted = files.slice(0, room)
    if (accepted.length < files.length) toast.warning(`Only ${accepted.length} of ${files.length} file(s) added — max 5 images per product`)
    const withPreview = accepted.map(file => ({ file, previewUrl: URL.createObjectURL(file) }))
    const items = form.line_items.map((it, i) => i === idx ? { ...it, [pendingKey]: [...(it[pendingKey] || []), ...withPreview] } : it)
    setF({ line_items: items })
  }
  const removePendingImage = (idx, kind, pendingRef) => {
    const pendingKey = kind === 'mock' ? '_pendingMock' : '_pendingProd'
    URL.revokeObjectURL(pendingRef.previewUrl)
    const items = form.line_items.map((it, i) => i === idx ? { ...it, [pendingKey]: (it[pendingKey] || []).filter(p => p !== pendingRef) } : it)
    setF({ line_items: items })
  }
  const uploadItemImages = async (idx, kind, fileList) => {
    const files = Array.from(fileList || [])
    if (!files.length) return
    if (!form.id || !form.line_items[idx]?._saved) { addPendingImages(idx, kind, files); return }
    setImgBusy(`${idx}-${kind}`)
    const fd = new FormData()
    fd.append('kind', kind); fd.append('itemIndex', idx)
    files.forEach(f => fd.append('images', f))
    const res = await apiFetch(`/api/crewfit/orders/${form.id}/images`, { method: 'POST', body: fd })
    setImgBusy(null)
    if (res && !res.error) applyServerOrder(res)
    else toast.error(res?.error || 'Upload failed')
  }
  const deleteItemImage = async (idx, kind, url) => {
    if (!form.id) return
    const res = await apiFetch(`/api/crewfit/orders/${form.id}/images`, { method: 'DELETE', body: JSON.stringify({ kind, itemIndex: idx, url }) })
    if (res && !res.error) applyServerOrder(res)
    else toast.error(res?.error || 'Failed to delete image')
  }
  // Fetched as a blob (not a plain <a href download>) so it downloads reliably even when the
  // frontend and backend are on different origins in dev — a cross-origin `download` attribute
  // is silently ignored by browsers, but a same-origin blob: URL always forces the save dialog.
  const downloadImage = async (url) => {
    const res = await apiFetch(url, { responseType: 'blob' })
    if (!res || res.error) { toast.error(res?.error || 'Failed to download image'); return }
    const blobUrl = URL.createObjectURL(res.blob)
    const a = document.createElement('a')
    a.href = blobUrl; a.download = res.filename || url.split('/').pop()
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(blobUrl)
  }
  // key distinguishes concurrent "download all" triggers (per-product mock/prod grids vs the
  // order-wide production-photos banner) so clicking one doesn't show a spinner on another.
  const downloadImages = async (urls, key) => {
    if (!urls.length) return
    setBulkDownloading(key)
    for (const url of urls) await downloadImage(url)
    setBulkDownloading(null)
  }
  const downloadAllPhotos = () => downloadImages(form.line_items.flatMap(it => it.prodImages || []), 'order-prod-all')
  const openLightbox = (idx, kind, images, index) => setLightbox({ idx, kind, images, index })
  const removeLightboxImage = async () => {
    if (!lightbox) return
    const { idx, kind, images, index } = lightbox
    const img = images[index]
    const rest = images.filter((_, i) => i !== index)
    if (!rest.length) setLightbox(null)
    else setLightbox(l => ({ ...l, images: rest, index: Math.min(l.index, rest.length - 1) }))
    if (img.pending) removePendingImage(idx, kind, img.ref)
    else await deleteItemImage(idx, kind, img.ref)
  }
  const toggleMockConfirmed = async (idx) => {
    const items = form.line_items.map((it, i) => i === idx ? { ...it, mockConfirmed: !it.mockConfirmed } : it)
    setF({ line_items: items })
    if (form.id) {
      const payload = items.map(({ _sizeMode, _sizes, ...rest }) => rest)
      await apiFetch(`/api/crewfit/orders/${form.id}`, { method: 'PUT', body: JSON.stringify({ line_items: payload }) })
    }
  }
  const onShipRegion = (region) => {
    const totalQty = form.line_items.reduce((s, it) => s + (parseInt(it.qty) || 0), 0)
    const ship = shippingFor(region, totalQty)
    setF({ ship_region: region, ...(ship != null ? { shipping: ship } : {}) }, true)
  }
  // Filling in a tracking ID is the only way an order becomes Dispatched — mirrored here for
  // instant UI feedback; the server enforces the same rule regardless of how the field was set.
  const onTrackingChange = (v) => {
    const patch = { tracking_link: v }
    if (v && !['Dispatched', 'Cancelled'].includes(form.status)) {
      patch.status = 'Dispatched'
      if (!form.dispatch_date) patch.dispatch_date = todayStr()
    }
    setF(patch)
  }
  // Payment-driven status moves, mirrored from the server so the drawer updates as you pick:
  // recording the advance starts production, collecting the balance clears the order to ship.
  const onPaymentChange = (v) => {
    const patch = { payment_status: v }
    if (form.status === 'Awaiting Payment' && v && v !== 'Pending') patch.status = 'Pending'
    else if (form.status === 'Ready for Dispatch' && v === 'Fully Paid') patch.status = 'Dispatch Pending'
    setF(patch)
  }
  // Porter doesn't issue a tracking ID — this is the alternate path to Dispatched for that MOT.
  const markDispatchedViaPorter = () => {
    setF({ status: 'Dispatched', dispatch_date: form.dispatch_date || todayStr() })
  }
  const sendDispatchWhatsApp = async () => {
    const num = toWaNumber(waSource(form))
    const msg = encodeURIComponent(buildDispatchMessage(form))
    window.open(num ? `https://wa.me/${num}?text=${msg}` : `https://wa.me/?text=${msg}`, '_blank')
    if (form.id) {
      const sentAt = new Date().toISOString()
      setF({ tracking_sent_at: sentAt })
      await apiFetch(`/api/crewfit/orders/${form.id}`, { method: 'PUT', body: JSON.stringify({ tracking_sent_at: sentAt }) })
    }
  }
  const copyDispatchMessage = () => navigator.clipboard?.writeText(buildDispatchMessage(form))
  const printLabel = async () => { setLabelBusy(true); await openShippingLabel(apiFetch, form, toast); setLabelBusy(false) }

  // ---- Razorpay payment links -------------------------------------------------
  const paymentFor = (kind) => payments.find(p => p.kind === kind && ['Created', 'Paid'].includes(p.status))
  // Baked into the order summary so the SO shares one message carrying both the
  // confirmation and the link to pay it.
  const advanceLink = () => paymentFor('advance')?.razorpay_short_url
  const generatePaymentLink = async (kind) => {
    setPayBusy(kind)
    const res = await apiFetch(`/api/crewfit/payments/order/${form.id}`, { method: 'POST', body: JSON.stringify({ kind }) })
    setPayBusy(null)
    if (!res || res.error) { toast.error(res?.error || 'Failed to create payment link'); return }
    toast.success(`${kind === 'advance' ? 'Advance' : 'Balance'} payment link created`)
    await loadPayments(form.id)
  }
  const copyPaymentLink = (payment) => navigator.clipboard?.writeText(payment.razorpay_short_url)
  const sendPaymentLink = async (payment) => {
    const num = toWaNumber(waSource(form))
    // The balance goes out with the full production-complete template; the advance and any
    // custom link use the short nudge, since the order summary already carries their context.
    const body = payment.kind === 'balance' ? buildBalanceMessage(form, payment) : buildPaymentMessage(form, payment)
    const msg = encodeURIComponent(body)
    window.open(num ? `https://wa.me/${num}?text=${msg}` : `https://wa.me/?text=${msg}`, '_blank')
    await apiFetch(`/api/crewfit/payments/${payment.id}/sent`, { method: 'POST' })
    loadPayments(form.id)
  }
  // Two-step confirm: an order carries invoices, payments and photos, and nothing here is
  // recoverable. Typing the order number is deliberate friction against a mis-click.
  const deleteOrder = async () => {
    const ref = `CF-${form.sl_no}`
    const paid = payments.some(p => p.status === 'Paid')
    if (!await toast.confirm({
      title: `Delete order ${ref}?`,
      message: `${form.customer_name}\n\nThis permanently removes the order, its production photos and its payment records${paid ? ' — including a payment already marked PAID' : ''}. It cannot be undone.`,
      requireText: String(form.sl_no), confirmLabel: 'Delete order', danger: true,
    })) return

    setDeleting(true)
    const res = await apiFetch(`/api/crewfit/orders/${form.id}`, { method: 'DELETE' })
    setDeleting(false)
    if (!res || res.error) { toast.error(res?.error || 'Failed to delete order'); return }
    toast.success(`Order ${ref} deleted`)
    setForm(null); onSaved?.()
  }

  const cancelPaymentLink = async (payment) => {
    if (!await toast.confirm({
      title: `Cancel the ${payment.kind} payment link?`,
      message: 'The customer will no longer be able to pay through it.',
      confirmLabel: 'Cancel link', cancelLabel: 'Keep it', danger: true,
    })) return
    const res = await apiFetch(`/api/crewfit/payments/${payment.id}/cancel`, { method: 'POST' })
    if (!res || res.error) { toast.error(res?.error || 'Failed to cancel link'); return }
    toast.success('Payment link cancelled')
    loadPayments(form.id)
  }
  const sendPhotosWhatsApp = async () => {
    const num = toWaNumber(waSource(form))
    const msg = encodeURIComponent(buildPhotosMessage(form, API_URL))
    window.open(num ? `https://wa.me/${num}?text=${msg}` : `https://wa.me/?text=${msg}`, '_blank')
    if (form.id) {
      const sentAt = new Date().toISOString()
      setF({ photos_sent_at: sentAt })
      await apiFetch(`/api/crewfit/orders/${form.id}`, { method: 'PUT', body: JSON.stringify({ photos_sent_at: sentAt }) })
    }
  }
  const copyPhotosMessage = () => navigator.clipboard?.writeText(buildPhotosMessage(form, API_URL))
  const sendOrderSummaryWhatsApp = () => {
    const num = toWaNumber(waSource(form))
    const msg = encodeURIComponent(preview)
    window.open(num ? `https://wa.me/${num}?text=${msg}` : `https://wa.me/?text=${msg}`, '_blank')
  }

  // Design mock / production photos picked before the order existed are queued on the line item
  // as _pendingMock/_pendingProd; once the order is created and has a real id, push them up for real.
  const uploadPendingImages = async (orderId, items) => {
    const failures = []
    for (let idx = 0; idx < items.length; idx++) {
      for (const kind of ['mock', 'prod']) {
        const pendingKey = kind === 'mock' ? '_pendingMock' : '_pendingProd'
        const pending = items[idx][pendingKey] || []
        if (!pending.length) continue
        const fd = new FormData()
        fd.append('kind', kind); fd.append('itemIndex', idx)
        pending.forEach(p => fd.append('images', p.file))
        const res = await apiFetch(`/api/crewfit/orders/${orderId}/images`, { method: 'POST', body: fd })
        if (!res || res.error) failures.push(`${kind === 'mock' ? 'design mock' : 'production'} photos for product ${idx + 1}`)
        pending.forEach(p => URL.revokeObjectURL(p.previewUrl))
      }
    }
    return failures
  }

  const save = async (e) => {
    e.preventDefault()
    // Billing mobile is optional (only filled for GST invoices), so it's checked only when present.
    const badPhone = [
      ['Contact Number', form.contact_number, true],
      ['WhatsApp Number', form.whatsapp_number, true],
      ['Billing Mobile', form.billing_mobile, false],
    ].find(([, v, required]) => (required || String(v || '').trim()) && !isValidMobile(v))
    if (badPhone) {
      toast.error(`${badPhone[0]} must be exactly 10 digits.`, { title: 'Check the mobile number' })
      return
    }
    setSaving(true)
    const items = form.line_items.map(({ _sizeMode, _sizes, _saved, _pendingMock, _pendingProd, ...rest }) => rest)
    const merged = { ...form, ...recompute(form), line_items: items }
    const payload = {
      ...merged,
      product: items.map(i => i.product).filter(Boolean).join(', '),
      color: items.map(i => i.color).filter(Boolean).join(', '),
      printing: items.length === 1 ? items[0].printing : items.map(i => i.printing).filter(Boolean).join(', '),
      size_breakdown: items.map(i => `${i.product || 'Item'}: ${i.size_breakdown}`).join(' | '),
      unit_price: items.length === 1 ? items[0].unit_price : null,
    }
    payload.description = buildDescription({ ...payload, _advanceLink: advanceLink() })
    delete payload._gstPct
    const isNew = !form.id
    const res = await apiFetch(`/api/crewfit/orders${isNew ? '' : '/' + form.id}`, { method: isNew ? 'POST' : 'PUT', body: JSON.stringify(payload) })
    if (res && !res.error) {
      // Photos queued against a row that didn't exist server-side yet (a brand-new order, or a
      // product row just added to an existing one) — now that it's saved, push them up for real.
      const hasPending = form.line_items.some(it => (it._pendingMock || []).length || (it._pendingProd || []).length)
      if (hasPending) {
        const failures = await uploadPendingImages(res.id, form.line_items)
        if (failures.length) toast.error(`These photo uploads failed: ${failures.join(', ')}. You can retry from the order's edit screen.`, { title: 'Order saved, photos did not upload', duration: 0 })
      }
      setSaving(false)
      toast.success(isNew ? `Order CF-${res.sl_no} created` : `Order CF-${res.sl_no} saved`)
      setForm(null); onSaved?.(res)
    } else {
      setSaving(false)
      toast.error(res?.error || 'Save failed')
    }
  }

  const preview = form ? buildDescription({ ...form, ...recompute(form), _advanceLink: advanceLink() }) : ''
  const balanceMessage = form ? buildBalanceMessage({ ...form, ...recompute(form) }, paymentFor('balance')) : ''
  const advInvoice = form?.invoices?.find(i => i.type === 'advance')
  const balInvoice = form?.invoices?.find(i => i.type === 'balance')

  const downloadInvoice = async (type) => {
    setInvoiceBusy(type)
    const res = await apiFetch(`/api/crewfit/orders/${form.id}/invoice/${type}`, { responseType: 'blob' })
    if (!res || res.error) { setInvoiceBusy(null); toast.error(res?.error || 'Failed to generate invoice'); return }
    const url = URL.createObjectURL(res.blob)
    const a = document.createElement('a')
    a.href = url; a.download = res.filename || `invoice-${type}-${form.sl_no}.pdf`
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
    const fresh = await apiFetch(`/api/crewfit/orders/${form.id}`)
    if (fresh && !fresh.error) setF({ invoices: fresh.invoices })
    setInvoiceBusy(null)
  }

  if (!form) return null

  return (
    <>
      <div className="drawer-overlay" onClick={closeDrawer} />
      <div className="drawer drawer-wide">
        <div className="drawer-header">
          <div><h2>{form.id ? `Edit Order #${form.sl_no}` : 'New Bulk Order'}</h2><div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Add one or more products — price & totals auto-fill</div></div>
          <button className="btn-icon" onClick={closeDrawer}>✕</button>
        </div>
        <form className="drawer-body" onSubmit={save}>
          <div className="form-section">Customer</div>
          <div className="form-row">
            <div className="input-group"><label>Customer Name *</label><input required value={form.customer_name || ''} onChange={e => setF({ customer_name: e.target.value })} /></div>
            <div className="input-group">
              <label>Contact Number *</label>
              <input {...mobileInputProps} required value={form.contact_number || ''} onChange={e => setF({ contact_number: cleanMobile(e.target.value) })} />
              {mobileError(form.contact_number) && <div className="field-error">{mobileError(form.contact_number)}</div>}
              {custHistory && (custHistory.orders_count > 0 ? (
                <div className="cust-hint returning">
                  ↩︎ Returning customer — {custHistory.orders_count} previous order{custHistory.orders_count > 1 ? 's' : ''}
                  {custHistory.lifetime_value ? ` · ₹${Number(custHistory.lifetime_value).toLocaleString('en-IN')} so far` : ''}
                  {custHistory.customer_name && custHistory.customer_name !== form.customer_name ? ` · known as "${custHistory.customer_name}"` : ''}
                </div>
              ) : (
                <div className="cust-hint">✨ First-time customer — no previous orders on this number</div>
              ))}
            </div>
            <div className="input-group">
              <label>WhatsApp Number *</label>
              <input {...mobileInputProps} required value={form.whatsapp_number || ''} onChange={e => setF({ whatsapp_number: cleanMobile(e.target.value) })} placeholder="If different from contact number" />
              {mobileError(form.whatsapp_number) && <div className="field-error">{mobileError(form.whatsapp_number)}</div>}
            </div>
            <div className="input-group">
              <label>Customer Type *</label>
              <select required value={form.customer_type || ''} onChange={e => setF({ customer_type: e.target.value })}><option value="">—</option>{(meta?.customerTypes || ['New', 'Returning']).map(v => <option key={v}>{v}</option>)}</select>
              <div className="img-upload-hint">Set automatically from the contact number's order history.</div>
            </div>
            <div className="input-group"><label>Sales Officer *</label><select required value={form.so || ''} onChange={e => setF({ so: e.target.value })}><option value="">—</option>{(meta?.sos || []).map(v => <option key={v}>{v}</option>)}</select></div>
          </div>

          <div className="form-section">Products <button type="button" className="mini-btn" onClick={addItem}>+ Add product</button></div>
          {form.line_items.map((item, idx) => {
            const itemProduct = products.find(p => p.name === item.product)
            const itemColorOptions = itemProduct?.colors || null
            const itemCatalogPrice = priceFor(itemProduct, parseInt(item.qty))
            return (
              <div key={idx} className="line-item-card">
                <div className="line-item-header">
                  <span>Product {idx + 1}</span>
                  {form.line_items.length > 1 && <button type="button" className="btn-icon" onClick={() => removeItem(idx)}>✕</button>}
                </div>
                <div className="form-row">
                  <div className="input-group"><label>Product *</label>
                    <select required value={item.product || ''} onChange={e => onItemProduct(idx, e.target.value)}>
                      <option value="">— Select from catalog —</option>
                      {products.map(p => <option key={p.id} value={p.name}>{p.name} (from ₹{p.from_price})</option>)}
                      {item.product && !products.some(p => p.name === item.product) && <option value={item.product}>{item.product}</option>}
                    </select>
                  </div>
                  <div className="input-group"><label>Color *</label>
                    {itemColorOptions ? <select required value={item.color || ''} onChange={e => updateItem(idx, { color: e.target.value })}><option value="">—</option>{itemColorOptions.map(c => <option key={c}>{c}</option>)}</select>
                      : <input required value={item.color || ''} onChange={e => updateItem(idx, { color: e.target.value })} placeholder="Color" />}
                  </div>
                  <div className="input-group"><label>Qty *</label><input required type="number" readOnly={item._sizeMode !== 'manual'} value={item.qty || ''} onChange={e => onItemQty(idx, e.target.value)} title={item._sizeMode !== 'manual' ? 'Derived from the size breakdown below' : ''} /></div>
                  <div className="input-group"><label>Printing *</label><select required value={item.printing || ''} onChange={e => updateItem(idx, { printing: e.target.value })}><option value="">—</option>{PRINTING.map(v => <option key={v}>{v}</option>)}</select></div>
                </div>
                <div className="input-group">
                  <label>Size breakdown *
                    <span style={{ marginLeft: 10 }}>
                      <button type="button" className={`mini-btn ${item._sizeMode !== 'manual' ? 'mini-btn-active' : ''}`} onClick={() => setItemSizeMode(idx, 'standard')}>Standard (XS–5XL)</button>
                      <button type="button" className={`mini-btn ${item._sizeMode === 'manual' ? 'mini-btn-active' : ''}`} style={{ marginLeft: 6 }} onClick={() => setItemSizeMode(idx, 'manual')}>Manual (e.g. Kids)</button>
                    </span>
                  </label>
                  {item._sizeMode === 'manual' ? (
                    <input required value={item.size_breakdown || ''} onChange={e => updateItem(idx, { size_breakdown: e.target.value })} placeholder="e.g. Kids M-3, Kids L-2" />
                  ) : (
                    <>
                      <div className="size-grid">
                        {STANDARD_SIZES.map(s => (
                          <div key={s} className="size-cell">
                            <label>{s}</label>
                            <input type="number" min="0" value={item._sizes?.[s] || ''} onChange={e => onItemSizeCount(idx, s, e.target.value)} />
                          </div>
                        ))}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>{item.size_breakdown || 'Enter a quantity per size — total Qty and pricing update automatically.'}</div>
                    </>
                  )}
                </div>
                <div className="form-row">
                  <div className="input-group"><label>Price per piece (₹) *{itemCatalogPrice ? <span className="unit-hint"> catalog: ₹{itemCatalogPrice}</span> : ''}</label><input required type="number" value={item.unit_price ?? ''} onChange={e => onItemUnitPrice(idx, e.target.value)} placeholder={itemCatalogPrice ? String(itemCatalogPrice) : ''} /></div>
                  <div className="input-group"><label>Line Total (₹) *</label><input required type="number" value={item.product_total ?? ''} onChange={e => updateItem(idx, { product_total: e.target.value })} /></div>
                </div>

                <ImageUploadGrid
                  icon="🎨" label="Design mock" thumbs={imageThumbs(item, 'mock', API_URL)}
                  busy={imgBusy === `${idx}-mock`}
                  onUpload={files => uploadItemImages(idx, 'mock', files)}
                  onView={i => openLightbox(idx, 'mock', imageThumbs(item, 'mock', API_URL), i)}
                  onDownloadAll={() => downloadImages(item.mockImages || [], `${idx}-mock-all`)}
                  downloadBusy={bulkDownloading === `${idx}-mock-all`}
                />
                <label className="img-confirm-check">
                  <input type="checkbox" checked={!!item.mockConfirmed} onChange={() => toggleMockConfirmed(idx)} /> Confirmed by client
                </label>

                <ImageUploadGrid
                  icon="📷" label="Production photos" thumbs={imageThumbs(item, 'prod', API_URL)}
                  busy={imgBusy === `${idx}-prod`}
                  onUpload={files => uploadItemImages(idx, 'prod', files)}
                  onView={i => openLightbox(idx, 'prod', imageThumbs(item, 'prod', API_URL), i)}
                  onDownloadAll={() => downloadImages(item.prodImages || [], `${idx}-prod-all`)}
                  downloadBusy={bulkDownloading === `${idx}-prod-all`}
                />
              </div>
            )
          })}

          <div className="form-section">Pricing</div>
          <div className="totals-bar" style={{ marginBottom: 14 }}>
            <div><span>Total Qty</span><strong>{form.qty || form.line_items.reduce((s, it) => s + (parseInt(it.qty) || 0), 0)}</strong></div>
            <div><span>Products Subtotal</span><strong>{fmt(form.product_total ?? form.line_items.reduce((s, it) => s + (Number(it.product_total) || 0), 0))}</strong></div>
          </div>
          <div className="form-row">
            <div className="input-group"><label>Shipping Region *</label><select required value={form.ship_region || 'Tamil Nadu'} onChange={e => onShipRegion(e.target.value)}>{SHIP_REGIONS.map(r => <option key={r}>{r}</option>)}</select></div>
            <div className="input-group"><label>Shipping (₹) *</label><input required type="number" value={form.shipping ?? ''} onChange={e => setF({ shipping: e.target.value }, true)} /></div>
            <div className="input-group"><label>GST *</label><select required value={form._gstPct ?? 0} onChange={e => setF({ _gstPct: Number(e.target.value) }, true)}><option value={0}>No GST</option><option value={5}>5%</option><option value={12}>12%</option><option value={18}>18%</option></select></div>
            <div className="input-group"><label>GST amount</label><input readOnly value={form.gst_amount ?? 0} /></div>
          </div>
          <div className="totals-bar">
            <div><span>Grand Total</span><strong>{fmt(form.grand_total)}</strong></div>
            <div><span>Advance (50%)</span><strong style={{ color: 'var(--warning)' }}>{fmt(form.advance)}</strong></div>
            <div><span>Balance</span><strong style={{ color: 'var(--info)' }}>{fmt(form.balance)}</strong></div>
          </div>

          {form.id && (
            <>
              <div className="form-section">Payment links
                <span className="unit-hint">Razorpay · paid links update the order automatically</span>
              </div>
              <div className="invoice-grid">
                <PaymentCard
                  title="Advance (50%)" amount={form.advance} payment={paymentFor('advance')}
                  busy={payBusy === 'advance'}
                  onGenerate={() => generatePaymentLink('advance')}
                  onCopy={() => copyPaymentLink(paymentFor('advance'))}
                  onSend={() => sendPaymentLink(paymentFor('advance'))}
                  onCancel={() => cancelPaymentLink(paymentFor('advance'))}
                />
                <PaymentCard
                  title="Balance (50%)" amount={form.balance} payment={paymentFor('balance')}
                  busy={payBusy === 'balance'}
                  disabled={form.payment_status === 'Pending'} disabledLabel="Collect the advance first"
                  onGenerate={() => generatePaymentLink('balance')}
                  onCopy={() => copyPaymentLink(paymentFor('balance'))}
                  onSend={() => sendPaymentLink(paymentFor('balance'))}
                  onCancel={() => cancelPaymentLink(paymentFor('balance'))}
                />
              </div>

              <div className="form-section">GST Invoices</div>
              <div className="invoice-grid">
                <InvoiceCard
                  title="Invoice 1 — Advance" amount={form.advance} invoice={advInvoice}
                  busy={invoiceBusy === 'advance'} locked={form.payment_status === 'Pending'}
                  lockedLabel="Awaiting advance payment" onGenerate={() => downloadInvoice('advance')}
                />
                <InvoiceCard
                  title="Invoice 2 — Balance" amount={form.balance} invoice={balInvoice}
                  busy={invoiceBusy === 'balance'} locked={form.payment_status !== 'Fully Paid'}
                  lockedLabel="Awaiting full payment" onGenerate={() => downloadInvoice('balance')}
                />
              </div>
            </>
          )}

          <div className="form-section">Delivery &amp; Billing</div>
          <div className="input-group"><label>Delivery Address *</label><input required value={form.delivery_location || ''} onChange={e => setF({ delivery_location: e.target.value })} /></div>
          <div className="form-row">
            <div className="input-group"><label>Billing Name / Company *</label><input required value={form.billing_name || ''} onChange={e => setF({ billing_name: e.target.value })} /></div>
            <div className="input-group"><label>Contact Person *</label><input required value={form.contact_person || ''} onChange={e => setF({ contact_person: e.target.value })} /></div>
            <div className="input-group">
              <label>Billing Mobile *</label>
              <input {...mobileInputProps} required value={form.billing_mobile || ''} onChange={e => setF({ billing_mobile: cleanMobile(e.target.value) })} />
              {mobileError(form.billing_mobile) && <div className="field-error">{mobileError(form.billing_mobile)}</div>}
            </div>
            <div className="input-group"><label>Email</label><input value={form.billing_email || ''} onChange={e => setF({ billing_email: e.target.value })} /></div>
            <div className="input-group"><label>GST Number</label><input value={form.gst_number || ''} onChange={e => setF({ gst_number: e.target.value })} /></div>
          </div>
          <div className="input-group"><label>Complete Billing Address *</label><input required value={form.billing_address || ''} onChange={e => setF({ billing_address: e.target.value })} /></div>

          <div className="form-section">Pipeline</div>
          <div className="form-row">
            <div className="input-group">
              <label>Status</label>
              <select value={form.status || ''} onChange={e => setF({ status: e.target.value })}>
                {(meta?.statuses || []).filter(v => v !== 'Dispatched' || form.status === 'Dispatched').map(v => <option key={v}>{v}</option>)}
              </select>
            </div>
            <div className="input-group"><label>Payment</label><select value={form.payment_status || ''} onChange={e => onPaymentChange(e.target.value)}>{(meta?.payments || []).map(v => <option key={v}>{v}</option>)}</select></div>
            <div className="input-group"><label>Layout</label><select value={form.layout_status || ''} onChange={e => setF({ layout_status: e.target.value })}>{(meta?.layouts || []).map(v => <option key={v}>{v}</option>)}</select></div>
            <div className="input-group"><label>Vendor</label><select value={form.vendor || ''} onChange={e => setF({ vendor: e.target.value })}><option value="">—</option>{(meta?.vendors || []).map(v => <option key={v}>{v}</option>)}</select></div>
          </div>
          <div className="form-row">
            <div className="input-group"><label>Order Date</label><input type="date" value={(form.order_date || '').slice(0, 10)} onChange={e => setF({ order_date: e.target.value })} /></div>
            <div className="input-group"><label>Deadline</label><input type="date" value={(form.deadline_at || '').slice(0, 10)} onChange={e => setF({ deadline_at: e.target.value })} /></div>
            <div className="input-group"><label>Dispatch Date</label><input type="date" value={(form.dispatch_date || '').slice(0, 10)} onChange={e => setF({ dispatch_date: e.target.value })} /></div>
            <div className="input-group"><label>Dispatch (MOT)</label><select value={form.mot || ''} onChange={e => setF({ mot: e.target.value })}><option value="">—</option>{(meta?.mots || []).map(v => <option key={v}>{v}</option>)}</select></div>
          </div>
          <div className="form-row">
            {form.mot === 'Porter' ? (
              <div className="input-group">
                <label>Dispatch via Porter</label>
                {form.status === 'Dispatched' ? (
                  <div className="img-upload-hint">✓ Marked dispatched{form.dispatch_date ? ` on ${form.dispatch_date}` : ''} — Porter doesn't issue a tracking ID</div>
                ) : (
                  <button type="button" className="btn btn-secondary" onClick={markDispatchedViaPorter}>Mark as Dispatched (no tracking ID)</button>
                )}
              </div>
            ) : (
              <div className="input-group">
                <label>Tracking ID / Link</label>
                <input value={form.tracking_link || ''} onChange={e => onTrackingChange(e.target.value)} placeholder="Filling this in marks the order Dispatched" />
                {trackingUrl(form) && (
                  <a className="track-link" href={trackingUrl(form)} target="_blank" rel="noreferrer">🔗 Track on ST Courier</a>
                )}
                {form.mot === 'ST Courier' && !form.tracking_link && (
                  <div className="img-upload-hint">Add the consignment number to get a trackable link.</div>
                )}
              </div>
            )}
            {form.id && (
              <div className="input-group">
                <label>Shipping label</label>
                <button type="button" className="btn btn-secondary" onClick={printLabel} disabled={labelBusy}>{labelBusy ? 'Preparing…' : '🖨 Print shipping label'}</button>
              </div>
            )}
          </div>

          {form.status === 'Dispatch Pending' && (
            <div className="dispatch-banner">
              <span>🚚 Balance collected — cleared for dispatch. Print the label, hand the parcel to {form.mot || 'the courier'}, then {form.mot === 'Porter' ? 'use the Porter button above' : 'add the tracking ID above'} to mark it Dispatched.</span>
              <span style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="btn btn-secondary" onClick={printLabel} disabled={labelBusy}>{labelBusy ? 'Preparing…' : '🖨 Print shipping label'}</button>
              </span>
            </div>
          )}
          {form.line_items.some(it => (it.prodImages || []).length > 0) && (
            <div className="dispatch-banner">
              <span>
                📷 Production photos ready — share with the client before collecting the balance payment
                {form.photos_sent_at ? <> · <span style={{ color: 'var(--success)' }}>✓ sent</span></> : ''}
              </span>
              <span style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="mini-btn" onClick={downloadAllPhotos} disabled={bulkDownloading === 'order-prod-all'}>{bulkDownloading === 'order-prod-all' ? 'Downloading…' : '⬇ Download all'}</button>
                <button type="button" className="mini-btn" onClick={copyPhotosMessage}>📋 Copy</button>
                <button type="button" className="btn btn-secondary" onClick={sendPhotosWhatsApp}>💬 {form.photos_sent_at ? 'Resend' : 'Send'} Photos via WhatsApp</button>
              </span>
            </div>
          )}

          {form.status === 'Dispatched' && (
            <div className="dispatch-banner">
              <span>
                📦 Dispatched{form.dispatch_date ? ` on ${form.dispatch_date}` : ''}{form.tracking_link ? ` · Tracking: ${form.tracking_link}` : form.mot === 'Porter' ? ' · via Porter (no tracking ID)' : ''}
                {trackingUrl(form) && <> · <a className="track-link" href={trackingUrl(form)} target="_blank" rel="noreferrer">Track</a></>}
                {form.tracking_sent_at ? <> · <span style={{ color: 'var(--success)' }}>✓ sent</span></> : ''}
              </span>
              <span style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="mini-btn" onClick={copyDispatchMessage}>📋 Copy</button>
                <button type="button" className="btn btn-secondary" onClick={sendDispatchWhatsApp}>💬 {form.tracking_sent_at ? 'Resend' : 'Send'} {form.mot === 'Porter' ? 'Dispatch Update' : 'Tracking'} via WhatsApp</button>
              </span>
            </div>
          )}

          <div className="form-section">Order summary
            <span style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="mini-btn" onClick={() => navigator.clipboard?.writeText(preview)}>📋 Copy</button>
              <button type="button" className="mini-btn" onClick={sendOrderSummaryWhatsApp}>💬 Send via WhatsApp</button>
            </span>
          </div>
          <div className="order-block">{preview || 'Fill product, qty and billing to generate the order block…'}</div>

          {paymentFor('balance') && (
            <>
              <div className="form-section">Balance payment message
                <span style={{ display: 'flex', gap: 8 }}>
                  <button type="button" className="mini-btn" onClick={() => navigator.clipboard?.writeText(balanceMessage)}>📋 Copy</button>
                  <button type="button" className="mini-btn" onClick={() => sendPaymentLink(paymentFor('balance'))}>💬 Send via WhatsApp</button>
                </span>
              </div>
              <div className="img-upload-hint" style={{ marginBottom: 8 }}>
                Send the production photos first, then share this — it recaps the order, shows what’s already paid and carries the balance link.
              </div>
              <div className="order-block">{balanceMessage}</div>
            </>
          )}

          <div className="input-group" style={{ marginTop: 14 }}><label>Internal notes</label><textarea rows={2} value={form.notes || ''} onChange={e => setF({ notes: e.target.value })} /></div>

          <div style={{ display: 'flex', gap: 10, position: 'sticky', bottom: 0, background: 'var(--bg-secondary)', padding: '12px 0' }}>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : (form.id ? 'Save changes' : 'Create order')}</button>
            <button type="button" className="btn btn-secondary" onClick={closeDrawer}>Cancel</button>
            {isOwner && form.id && (
              <button type="button" className="btn btn-danger" style={{ marginLeft: 'auto' }} disabled={deleting} onClick={deleteOrder}>
                {deleting ? 'Deleting…' : '🗑 Delete order'}
              </button>
            )}
          </div>
        </form>
      </div>

      {lightbox && (
        <div className="image-modal-overlay" onClick={() => setLightbox(null)}>
          <div className="image-modal-content" onClick={e => e.stopPropagation()}>
            <button className="image-modal-close" onClick={() => setLightbox(null)}>✕</button>
            <div className="image-modal-toolbar">
              {!lightbox.images[lightbox.index].pending && (
                <button className="image-modal-action" onClick={() => downloadImage(lightbox.images[lightbox.index].ref)}>⬇ Download</button>
              )}
              <button className="image-modal-action image-modal-action-danger" onClick={removeLightboxImage}>🗑 Remove</button>
            </div>
            {lightbox.images[lightbox.index].pending && <div className="image-modal-pending-tag">Pending upload — will be saved with the order</div>}
            <img src={lightbox.images[lightbox.index].src} alt="Preview" className="full-image" />
            {lightbox.images.length > 1 && (
              <>
                <button className="modal-carousel-nav-btn modal-carousel-prev" onClick={() => setLightbox(l => ({ ...l, index: (l.index - 1 + l.images.length) % l.images.length }))}>‹</button>
                <button className="modal-carousel-nav-btn modal-carousel-next" onClick={() => setLightbox(l => ({ ...l, index: (l.index + 1) % l.images.length }))}>›</button>
                <div className="modal-carousel-counter">{lightbox.index + 1} / {lightbox.images.length}</div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}
