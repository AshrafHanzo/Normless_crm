import { useState, useEffect, useRef } from 'react'
import useDirtyGuard from '../../hooks/useDirtyGuard'
import { useNavigate } from 'react-router-dom'
import { useApi } from '../../App'
import { useToast } from '../../components/Toast'
import DateRangeFilter from '../../components/DateRangeFilter'
import Icon from '../../components/Icon'
import { cleanMobile, mobileError, isValidMobile, mobileInputProps } from '../../utils/phone'
import useServerTable from '../../hooks/useServerTable'
import SortTh from '../../components/SortTh'
import Pagination from '../../components/Pagination'

const fmt = (v) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v || 0)
const statusClass = (s) => (s === 'Paid' ? 'fulfilled' : s === 'Created' ? 'pending' : 'refunded')
const KIND_LABEL = { advance: 'Advance 50%', balance: 'Balance 50%', custom: 'Custom' }

const dt = (v) => (v ? new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—')

// Indian mobile → wa.me wants digits only with country code.
function toWaNumber(phone) {
  let d = (phone || '').replace(/\D/g, '')
  if (!d) return null
  if (d.length === 10) d = '91' + d
  else if (d.length === 11 && d.startsWith('0')) d = '91' + d.slice(1)
  return d
}

function buildMessage(p) {
  const L = [`Hi ${p.customer_name || 'there'}! 👋`, '']
  L.push(p.order_sl_no ? `Payment link for your Crewfit order (Ref: CF-${p.order_sl_no}):` : 'Here is your Crewfit payment link:', '')
  L.push(`💵 *Amount:* ₹${Number(p.amount).toLocaleString('en-IN')}`)
  if (p.description) L.push(`📝 ${p.description}`)
  L.push(`🔗 ${p.razorpay_short_url}`, '')
  L.push('Thank you for choosing Crewfit! 🙌')
  return L.join('\n')
}

const blankForm = { customer_name: '', contact_number: '', email: '', amount: '', description: '' }

export default function CrewfitPayments() {
  const apiFetch = useApi()
  const toast = useToast()
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('')
  const [kind, setKind] = useState('')
  const [search, setSearch] = useState('')
  const [term, setTerm] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  // Server-side sort + page: a header click reorders every matching link, not this page's 25.
  const t = useServerTable({ sort: 'created_at', dir: 'desc' })
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState(blankForm)
  // Declared after `form` on purpose — reading it above its useState puts it in the temporal dead
  // zone, and the ternary only touches it once `creating` flips true, so the crash landed on the
  // "+ New Payment Link" click rather than on load.
  const guard = useDirtyGuard({
    snapshot: creating ? form : null,
    identity: creating ? 'new' : null,
    onDiscard: () => { setCreating(false); setForm(blankForm) },
    confirm: toast.confirm,
    title: 'Discard this payment link?',
    message: 'You have started filling in a payment link. Closing now will lose it.',
  })
  const [saving, setSaving] = useState(false)
  const [copiedId, setCopiedId] = useState(null)
  const pollRef = useRef(null)
  const inFlight = useRef(false)

  useEffect(() => { const timer = setTimeout(() => { setSearch(term); t.resetPage() }, 350); return () => clearTimeout(timer) }, [term])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [status, kind, search, startDate, endDate, t.key])

  const load = async (opts = {}) => {
    if (!opts.silent) setLoading(true)
    const res = await apiFetch('/api/crewfit/payments?' + t.query({ status, kind, search, startDate, endDate }))
    setData(res && !res.error ? res : null)
    if (res?.pagination) t.setPagination(res.pagination)
    if (!opts.silent) setLoading(false)
    return res
  }

  const openCount = (data?.payments || []).filter(p => p.status === 'Created').length

  // Razorpay's webhook is the fast path; this poll is what makes a missed webhook invisible to
  // the user. It only runs while there is something open to watch and the tab is actually
  // visible — a backgrounded tab has nobody looking at it and would just burn API calls.
  useEffect(() => {
    clearInterval(pollRef.current)
    if (!openCount || !data?.configured) return

    const tick = async () => {
      if (document.hidden || inFlight.current) return
      inFlight.current = true
      try {
        const res = await apiFetch('/api/crewfit/payments/sync-pending', { method: 'POST', body: JSON.stringify({}) })
        if (res && !res.error && res.nowPaid) {
          const total = (res.settled || []).reduce((s, p) => s + p.amount, 0)
          toast.success(`${fmt(total)} received across ${res.nowPaid} payment${res.nowPaid === 1 ? '' : 's'}.`, { title: 'Payment received' })
        }
        if (res && !res.error) await load({ silent: true })
      } finally { inFlight.current = false }
    }
    pollRef.current = setInterval(tick, 10000)
    // Coming back to the tab shouldn't wait out the rest of the interval.
    const onVisible = () => { if (!document.hidden) tick() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { clearInterval(pollRef.current); document.removeEventListener('visibilitychange', onVisible) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openCount, data?.configured, status, kind, search, startDate, endDate, t.key])

  const createLink = async (e) => {
    e.preventDefault()
    if (!isValidMobile(form.contact_number)) { toast.error('Phone must be exactly 10 digits.', { title: 'Check the mobile number' }); return }
    setSaving(true)
    const res = await apiFetch('/api/crewfit/payments', { method: 'POST', body: JSON.stringify(form) })
    setSaving(false)
    if (!res || res.error) { toast.error(res?.error || 'Failed to create payment link'); return }
    toast.success(`${fmt(res.amount)} link created for ${res.customer_name}`, { title: 'Payment link ready' })
    guard.reset()
    setForm(blankForm); setCreating(false); t.resetPage(); load()
  }

  const copyLink = (p) => { navigator.clipboard?.writeText(p.razorpay_short_url); setCopiedId(p.id); setTimeout(() => setCopiedId(null), 1600) }

  const sendLink = async (p) => {
    const num = toWaNumber(p.contact_number)
    const msg = encodeURIComponent(buildMessage(p))
    window.open(num ? `https://wa.me/${num}?text=${msg}` : `https://wa.me/?text=${msg}`, '_blank')
    await apiFetch(`/api/crewfit/payments/${p.id}/sent`, { method: 'POST' })
    load()
  }

  const cancelLink = async (p) => {
    if (!await toast.confirm({
      title: `Cancel this ${fmt(p.amount)} link?`,
      message: `${p.customer_name} will no longer be able to pay through it.`,
      confirmLabel: 'Cancel link', cancelLabel: 'Keep it', danger: true,
    })) return
    const res = await apiFetch(`/api/crewfit/payments/${p.id}/cancel`, { method: 'POST' })
    if (!res || res.error) { toast.error(res?.error || 'Failed to cancel'); return }
    toast.success('Payment link cancelled')
    load()
  }

  const payments = data?.payments || []
  // Server is the authority; default to hidden so a slow/failed load never flashes the totals.
  const showRevenue = data?.canViewRevenue === true

  return (
    <div className="page-enter">
      <div className="dash-toolbar">
        <div>
          <h1>Crewfit · Payments</h1>
          <p style={{ color: 'var(--text-muted)' }}>
            Every Razorpay link and transaction
            {data?.mode && <span className={`pay-mode-pill ${data.mode === 'live' ? 'pay-mode-live' : ''}`}>{data.mode} mode</span>}
            {openCount > 0 && <span className="pay-live-dot" title="Open links are re-checked with Razorpay every 10 seconds"><i />watching {openCount} open link{openCount === 1 ? '' : 's'}</span>}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <DateRangeFilter startDate={startDate} endDate={endDate}
            onApply={(s, e) => { setStartDate(s); setEndDate(e); t.resetPage() }}
            onClear={() => { setStartDate(''); setEndDate(''); t.resetPage() }} />
          <button className="btn btn-primary" onClick={() => setCreating(v => !v)}>+ New Payment Link</button>
        </div>
      </div>

      {data && !data.configured && (
        <div className="calc-warning" style={{ marginBottom: 18 }}>
          Razorpay is not configured on the server — payment links can’t be created until the {data.mode} keys are set.
        </div>
      )}

      {creating && (
        <form className="glass-card" style={{ marginBottom: 20 }} onSubmit={createLink}>
          <div className="form-section" style={{ marginTop: 0 }}>New payment link</div>
          <div className="form-row">
            <div className="input-group"><label>Customer name *</label>
              <input required value={form.customer_name} onChange={e => setForm(f => ({ ...f, customer_name: e.target.value }))} placeholder="e.g. Rahul Sports Club" /></div>
            <div className="input-group"><label>Phone *</label>
              <input {...mobileInputProps} required value={form.contact_number} onChange={e => setForm(f => ({ ...f, contact_number: cleanMobile(e.target.value) }))} />
              {mobileError(form.contact_number) && <div className="field-error">{mobileError(form.contact_number)}</div>}</div>
            <div className="input-group"><label>Amount (₹) *</label>
              <input required type="number" min="1" step="1" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} /></div>
            <div className="input-group"><label>Email</label>
              <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="optional" /></div>
          </div>
          <div className="input-group"><label>What is this for?</label>
            <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="e.g. Sampling charges, rush delivery top-up" /></div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="submit" className="btn btn-primary" disabled={saving || !data?.configured}>{saving ? 'Creating…' : 'Create link'}</button>
            <button type="button" className="btn btn-secondary" onClick={guard.requestClose}>Cancel</button>
          </div>
        </form>
      )}

      {/* The money roll-ups are gated by can_view_revenue; the server omits them entirely, so
          this only decides layout. The link count stays — it's operational, not financial. */}
      <div className="kpi-grid" style={{ gridTemplateColumns: `repeat(${showRevenue ? 3 : 1}, 1fr)` }}>
        {showRevenue && (
          <>
            <div className="kpi-card">
              <div className="kpi-head"><div className="kpi-icon">💰</div></div>
              <div className="kpi-value">{fmt(data?.summary.collected)}</div>
              <div className="kpi-label">Collected</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-head"><div className="kpi-icon">⏳</div></div>
              <div className="kpi-value">{fmt(data?.summary.awaiting)}</div>
              <div className="kpi-label">Awaiting payment</div>
            </div>
          </>
        )}
        <div className="kpi-card">
          <div className="kpi-head"><div className="kpi-icon">🔗</div></div>
          <div className="kpi-value">{data?.summary.count ?? 0}</div>
          <div className="kpi-label">Links generated</div>
        </div>
      </div>

      <div className="filters-row filters-row-search">
        <div className="search-bar"><span className="search-icon" />
          <input placeholder="Search customer, phone, order number or description…" value={term} onChange={e => setTerm(e.target.value)} /></div>
      </div>
      <div className="filters-row">
        <select value={status} onChange={e => { setStatus(e.target.value); t.resetPage() }} style={{ width: 'auto' }}>
          <option value="">All statuses</option><option>Created</option><option>Paid</option><option>Cancelled</option><option>Expired</option>
        </select>
        <select value={kind} onChange={e => { setKind(e.target.value); t.resetPage() }} style={{ width: 'auto' }}>
          <option value="">All types</option><option value="advance">Advance 50%</option><option value="balance">Balance 50%</option><option value="custom">Custom</option>
        </select>
      </div>

      <div className="data-table-wrapper">
        {loading ? <div className="loader"><div className="spinner" /></div> : !payments.length ? (
          <div className="empty-state"><div className="empty-icon">💳</div><p>No payment links yet.</p></div>
        ) : (
          <table className="data-table">
            <thead><tr>
              <SortTh label="Customer" col="customer_name" sort={t.sort} onSort={t.toggle} />
              <SortTh label="For" col="kind" sort={t.sort} onSort={t.toggle} />
              <SortTh label="Amount" col="amount" sort={t.sort} onSort={t.toggle} align="right" />
              <SortTh label="Status" col="status" sort={t.sort} onSort={t.toggle} />
              <SortTh label="Created" col="created_at" sort={t.sort} onSort={t.toggle} />
              <SortTh label="Paid" col="paid_at" sort={t.sort} onSort={t.toggle} />
              <SortTh label="" />
            </tr></thead>
            <tbody>
              {payments.map(p => (
                <tr key={p.id}>
                  <td className="cell-primary">
                    <div style={{ fontWeight: 600 }}>{p.customer_name || '—'}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{p.contact_number}</div>
                  </td>
                  <td data-label="For">
                    <div><span className="badge-secondary">{KIND_LABEL[p.kind] || p.kind}</span></div>
                    {p.order_sl_no && (
                      <div style={{ fontSize: 11.5, marginTop: 4 }}>
                        <span className="badge-primary" style={{ cursor: 'pointer' }} onClick={() => navigate(`/crewfit/orders?focus=${p.order_id}`)}>CF-{p.order_sl_no}</span>
                      </div>
                    )}
                    {!p.order_sl_no && p.description && <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>{p.description}</div>}
                  </td>
                  <td data-label="Amount" style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(p.amount)}</td>
                  <td data-label="Status"><span className={`status-badge ${statusClass(p.status)}`}>{p.status}</span></td>
                  <td data-label="Created" style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{dt(p.created_at)}</td>
                  <td data-label="Paid" style={{ fontSize: 12.5 }}>{p.status === 'Paid' ? dt(p.paid_at) : '—'}</td>
                  <td className="cell-actions" data-label="Actions">
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                      <button className="btn-icon" title="Copy link" onClick={() => copyLink(p)}>
                        {copiedId === p.id ? <Icon name="check" size={14} /> : <Icon name="copy" size={14} />}
                      </button>
                      {p.status === 'Created' && (<>
                        <button className="btn-icon" title="Send via WhatsApp" onClick={() => sendLink(p)}><Icon name="phone" size={14} /></button>
                        <button className="btn-icon" title="Cancel link" onClick={() => cancelLink(p)} style={{ color: 'var(--danger)' }}><Icon name="close" size={14} /></button>
                      </>)}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {!loading && <Pagination table={t} noun="links" />}
      </div>
    </div>
  )
}
