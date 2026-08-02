import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApi } from '../../App'
import CrewfitOrderDrawer from './CrewfitOrderDrawer'

const fmt = (v) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v || 0)
const statusClass = (s) => { s = (s || '').toLowerCase(); if (s.includes('dispatch') && s.includes('ready')) return 'pending'; if (s.includes('dispatch')) return 'fulfilled'; if (s.includes('cancel')) return 'refunded'; return 'pending' }
const payClass = (s) => (s === 'Fully Paid' ? 'fulfilled' : s === 'Pending' ? 'refunded' : 'pending')

export default function CrewfitOrders() {
  const apiFetch = useApi()
  const [params, setParams] = useSearchParams()
  const [meta, setMeta] = useState(null)
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState({ search: '', status: '', payment_status: '', so: '', vendor: '' })
  const [target, setTarget] = useState(null) // null | 'new' | order object

  useEffect(() => {
    apiFetch('/api/crewfit/meta').then(m => setMeta(m && m.statuses ? m : null))
  }, [])
  useEffect(() => { load() }, [filters])

  const load = async () => {
    setLoading(true)
    const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString()
    const res = await apiFetch('/api/crewfit/orders' + (qs ? '?' + qs : ''))
    const list = res?.orders || []
    setOrders(list); setLoading(false)
    const focus = params.get('focus')
    if (focus) { const f = list.find(o => String(o.id) === focus); if (f) setTarget(f); params.delete('focus'); setParams(params, { replace: true }) }
  }

  const quickUpdate = async (id, patch) => { setOrders(os => os.map(o => o.id === id ? { ...o, ...patch } : o)); await apiFetch(`/api/crewfit/orders/${id}`, { method: 'PUT', body: JSON.stringify(patch) }) }
  const InlineSelect = ({ o, field, options, cls }) => {
    const opts = options || []
    return (<select className={`inline-select ${cls ? 'sb-' + cls(o[field]) : ''}`} value={o[field] || ''} onClick={e => e.stopPropagation()} onChange={e => quickUpdate(o.id, { [field]: e.target.value })}>
      {(o[field] && !opts.includes(o[field])) && <option value={o[field]}>{o[field]}</option>}{opts.map(v => <option key={v} value={v}>{v}</option>)}</select>)
  }

  return (
    <div className="page-enter">
      <div className="dash-toolbar">
        <div><h1>Crewfit · Bulk Orders</h1><p style={{ color: 'var(--text-muted)' }}>{orders.length} orders · manage everything here</p></div>
        <button className="btn btn-primary" onClick={() => setTarget('new')}>+ New Order</button>
      </div>

      <div className="filters-row">
        <div className="search-bar"><span className="search-icon">🔍</span><input placeholder="Search customer, phone, order #…" value={filters.search} onChange={e => setFilters(f => ({ ...f, search: e.target.value }))} /></div>
        <select value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value }))} style={{ width: 'auto' }}><option value="">All statuses</option>{(meta?.statuses || []).map(s => <option key={s}>{s}</option>)}</select>
        <select value={filters.payment_status} onChange={e => setFilters(f => ({ ...f, payment_status: e.target.value }))} style={{ width: 'auto' }}><option value="">All payments</option>{(meta?.payments || []).map(s => <option key={s}>{s}</option>)}</select>
        <select value={filters.so} onChange={e => setFilters(f => ({ ...f, so: e.target.value }))} style={{ width: 'auto' }}><option value="">All SO</option>{(meta?.sos || []).map(s => <option key={s}>{s}</option>)}</select>
        <select value={filters.vendor} onChange={e => setFilters(f => ({ ...f, vendor: e.target.value }))} style={{ width: 'auto' }}><option value="">All vendors</option>{(meta?.vendors || []).map(s => <option key={s}>{s}</option>)}</select>
      </div>

      <div className="data-table-wrapper">
        {loading ? <div className="loader"><div className="spinner" /></div> : orders.length === 0 ? (
          <div className="empty-state"><div className="empty-icon">📦</div><p>No orders yet — click “+ New Order”.</p></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead><tr><th>#</th><th>Date</th><th>Customer</th><th>Product</th><th style={{ textAlign: 'center' }}>Qty</th><th style={{ textAlign: 'right' }}>Total</th><th>Deadline</th><th>Status</th><th>Payment</th><th>Layout</th></tr></thead>
              <tbody>
                {orders.map(o => (
                  <tr key={o.id} onClick={() => setTarget(o)}>
                    <td style={{ color: 'var(--text-muted)' }}>{o.sl_no}</td>
                    <td style={{ fontSize: 12.5 }}>{(o.order_date || '').slice(0, 10) || '—'}</td>
                    <td><div style={{ fontWeight: 600 }}>{o.customer_name}</div><div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{o.contact_number}</div></td>
                    <td style={{ fontSize: 12.5, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.product || '—'}</td>
                    <td style={{ textAlign: 'center' }}>{o.qty || '—'}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{o.total_cost ? fmt(o.total_cost) : '—'}</td>
                    <td style={{ fontSize: 12.5 }}>{(o.deadline_at || '').slice(0, 10) || <span style={{ color: 'var(--text-muted)' }}>{o.deadline_text || '—'}</span>}</td>
                    <td>{meta && <InlineSelect o={o} field="status" options={meta.statuses.filter(s => s !== 'Dispatched')} cls={statusClass} />}</td>
                    <td>{meta && <InlineSelect o={o} field="payment_status" options={meta.payments} cls={payClass} />}</td>
                    <td>{meta && <InlineSelect o={o} field="layout_status" options={meta.layouts} cls={(v) => v === 'Done' ? 'fulfilled' : 'refunded'} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <CrewfitOrderDrawer target={target} onClose={() => setTarget(null)} onSaved={() => { setTarget(null); load() }} />
    </div>
  )
}
