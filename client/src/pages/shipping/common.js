// Shared bits for the Shipping pages.

export const BUCKETS = [
  { key: 'pending', label: 'Pending AWB' },
  { key: 'waiting_pickup', label: 'Waiting for pickup' },
  { key: 'not_ready', label: 'Not ready at pickup', sub: true },
  { key: 'in_transit', label: 'In transit' },
  { key: 'out_for_delivery', label: 'Out for delivery' },
  { key: 'ndr', label: 'Delivery failed', tone: 'warning' },
  { key: 'rto_transit', label: 'RTO in transit' },
  { key: 'rto_returned', label: 'Returned (RTO)' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'cancelled_open', label: 'Auto-cancelled', tone: 'danger' },
  { key: 'cancelled', label: 'All cancelled', sub: true },
  { key: 'all', label: 'All shipments' },
]

export const BUCKET_LABEL = Object.fromEntries(BUCKETS.map(b => [b.key, b.label]))
BUCKET_LABEL.lost = 'Lost'

// Which status-badge colour each bucket wears.
export const BUCKET_BADGE = {
  waiting_pickup: 'pending', in_transit: 'partial', out_for_delivery: 'partial', ndr: 'on-hold',
  rto_transit: 'refunded', rto_returned: 'refunded', delivered: 'fulfilled', cancelled: 'cancelled', lost: 'error',
}

export const NOT_READY_CODES = ['FMEOD-152', 'X-PNP']

export const trackingUrl = (awb) => `https://www.delhivery.com/track-v2/package/${encodeURIComponent(awb)}`

export const day = (v) => (v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '—')
export const dayTime = (v) => (v ? new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—')
export const money = (v) => `₹${Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
export const daysSince = (v) => (v ? Math.floor((Date.now() - new Date(v).getTime()) / 86400000) : null)
export const ago = (v) => {
  if (!v) return '—'
  const m = Math.round((Date.now() - new Date(v).getTime()) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}

// Delhivery's words for where a parcel is, with the two pickup codes made plain.
export const statusText = (s) => {
  if (!s) return '—'
  if (s.status_code === 'FMEOD-152') return 'Not ready when Delhivery came'
  if (s.status_code === 'X-PNP') return 'Not handed over to Delhivery'
  return s.instructions || s.status || '—'
}

export const plural = (n, word, many) => `${n} ${n === 1 ? word : (many || `${word}s`)}`
