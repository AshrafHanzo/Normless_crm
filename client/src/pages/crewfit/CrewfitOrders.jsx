import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApi } from '../../App'
import DateRangeFilter from '../../components/DateRangeFilter'
import CrewfitOrderDrawer from './CrewfitOrderDrawer'

const fmt = (v) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v || 0)
const statusClass = (s) => { s = (s || '').toLowerCase(); if (s.includes('dispatch') && s.includes('ready')) return 'pending'; if (s.includes('dispatch')) return 'fulfilled'; if (s.includes('cancel')) return 'refunded'; return 'pending' }
const payClass = (s) => (s === 'Fully Paid' ? 'fulfilled' : s === 'Pending' ? 'refunded' : 'pending')
const photoClass = (s) => (s === 'Complete' ? 'fulfilled' : s === 'Partial' ? 'pending' : '')

const emptyFilters = { search: '', status: '', payment_status: '', layout_status: '', so: '', vendor: '', mock_status: '', prod_status: '' }

export default function CrewfitOrders() {
  const apiFetch = useApi()
  const [params, setParams] = useSearchParams()
  const [meta, setMeta] = useState(null)
  const [orders, setOrders] = useState([])
  const [pagination, setPagination] = useState({ total: 0, page: 1, limit: 25, totalPages: 1 })
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState(emptyFilters)
  const [searchTerm, setSearchTerm] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [page, setPage] = useState(1)
  const [limit, setLimit] = useState(25)
  const [target, setTarget] = useState(null) // null | 'new' | order object

  useEffect(() => {
    apiFetch('/api/crewfit/meta').then(m => setMeta(m && m.statuses ? m : null))
  }, [])

  // Debounce free-text search so we don't hit the API on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => { setFilters(f => ({ ...f, search: searchTerm })); setPage(1) }, 350)
    return () => clearTimeout(t)
  }, [searchTerm])

  useEffect(() => { load() }, [filters, startDate, endDate, page, limit])

  const load = async () => {
    setLoading(true)
    const qs = new URLSearchParams(Object.entries({ ...filters, startDate, endDate, page, limit }).filter(([, v]) => v)).toString()
    const res = await apiFetch('/api/crewfit/orders' + (qs ? '?' + qs : ''))
    const list = res?.orders || []
    setOrders(list)
    setPagination(res?.pagination || { total: list.length, page: 1, limit, totalPages: 1 })
    setLoading(false)
    const focus = params.get('focus')
    if (focus) { const f = list.find(o => String(o.id) === focus); if (f) setTarget(f); params.delete('focus'); setParams(params, { replace: true }) }
  }

  const setFilter = (k, v) => { setFilters(f => ({ ...f, [k]: v })); setPage(1) }
  const applyDateFilter = (s, e) => { setStartDate(s); setEndDate(e); setPage(1) }
  const clearDateFilter = () => { setStartDate(''); setEndDate(''); setPage(1) }

  const quickUpdate = async (id, patch) => { setOrders(os => os.map(o => o.id === id ? { ...o, ...patch } : o)); await apiFetch(`/api/crewfit/orders/${id}`, { method: 'PUT', body: JSON.stringify(patch) }) }
  const InlineSelect = ({ o, field, options, cls }) => {
    const opts = options || []
    return (<select className={`inline-select ${cls ? 'sb-' + cls(o[field]) : ''}`} value={o[field] || ''} onClick={e => e.stopPropagation()} onChange={e => quickUpdate(o.id, { [field]: e.target.value })}>
      {(o[field] && !opts.includes(o[field])) && <option value={o[field]}>{o[field]}</option>}{opts.map(v => <option key={v} value={v}>{v}</option>)}</select>)
  }

  const totalPages = pagination.totalPages || 1
  const rangeStart = pagination.total ? (page - 1) * limit + 1 : 0
  const rangeEnd = Math.min(page * limit, pagination.total || 0)

  return (
    <div className="page-enter">
      <div className="dash-toolbar">
        <div><h1>Crewfit · Bulk Orders</h1><p style={{ color: 'var(--text-muted)' }}>{pagination.total || 0} orders · manage everything here</p></div>
        <div style={{ display: 'flex', gap: 10 }}>
          <DateRangeFilter startDate={startDate} endDate={endDate} onApply={applyDateFilter} onClear={clearDateFilter} />
          <button className="btn btn-primary" onClick={() => setTarget('new')}>+ New Order</button>
        </div>
      </div>

      <div className="filters-row filters-row-search">
        <div className="search-bar"><span className="search-icon" /><input placeholder="Search anything — customer, phone, product, or order number…" value={searchTerm} onChange={e => setSearchTerm(e.target.value)} /></div>
      </div>
      <div className="search-hint">Order number search works in any format — try <b>45</b>, <b>CF-45</b> or <b>#45</b>, no need to match the exact style.</div>

      <div className="filters-row">
        <select value={filters.status} onChange={e => setFilter('status', e.target.value)} style={{ width: 'auto' }}><option value="">All statuses</option>{(meta?.statuses || []).map(s => <option key={s}>{s}</option>)}</select>
        <select value={filters.payment_status} onChange={e => setFilter('payment_status', e.target.value)} style={{ width: 'auto' }}><option value="">All payments</option>{(meta?.payments || []).map(s => <option key={s}>{s}</option>)}</select>
        <select value={filters.layout_status} onChange={e => setFilter('layout_status', e.target.value)} style={{ width: 'auto' }}><option value="">All layouts</option>{(meta?.layouts || []).map(s => <option key={s}>{s}</option>)}</select>
        <select value={filters.mock_status} onChange={e => setFilter('mock_status', e.target.value)} style={{ width: 'auto' }}><option value="">All mock photos</option>{(meta?.photoStatuses || []).map(s => <option key={s} value={s}>Mock: {s}</option>)}</select>
        <select value={filters.prod_status} onChange={e => setFilter('prod_status', e.target.value)} style={{ width: 'auto' }}><option value="">All production photos</option>{(meta?.photoStatuses || []).map(s => <option key={s} value={s}>Production: {s}</option>)}</select>
        <select value={filters.so} onChange={e => setFilter('so', e.target.value)} style={{ width: 'auto' }}><option value="">All SO</option>{(meta?.sos || []).map(s => <option key={s}>{s}</option>)}</select>
        <select value={filters.vendor} onChange={e => setFilter('vendor', e.target.value)} style={{ width: 'auto' }}><option value="">All vendors</option>{(meta?.vendors || []).map(s => <option key={s}>{s}</option>)}</select>
      </div>

      <div className="data-table-wrapper">
        {loading ? <div className="loader"><div className="spinner" /></div> : orders.length === 0 ? (
          <div className="empty-state"><div className="empty-icon">📦</div><p>No orders match these filters.</p></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead><tr><th>#</th><th>Date</th><th>Customer</th><th>Product</th><th style={{ textAlign: 'center' }}>Qty</th><th style={{ textAlign: 'right' }}>Total</th><th>Deadline</th><th>Status</th><th>Payment</th><th>Layout</th><th>Photos</th></tr></thead>
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
                    <td onClick={e => e.stopPropagation()}>
                      <div className="photo-status-badges">
                        <span className={`status-badge ${photoClass(o.mock_photo_status)}`}>Mock: {o.mock_photo_status}</span>
                        <span className={`status-badge ${photoClass(o.prod_photo_status)}`}>Prod: {o.prod_photo_status}</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!loading && orders.length > 0 && (
          <div className="pagination">
            <span className="pagination-info">Showing {rangeStart}–{rangeEnd} of {pagination.total}</span>
            <div className="pagination-pages">
              <button disabled={page <= 1} onClick={() => setPage(p => p - 1)}>‹</button>
              {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                const p = i + 1
                return <button key={p} className={page === p ? 'active' : ''} onClick={() => setPage(p)}>{p}</button>
              })}
              {totalPages > 7 && <button disabled>…</button>}
              <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>›</button>
            </div>
            <label className="pagination-limit">
              Rows per page
              <select value={limit} onChange={e => { setLimit(Number(e.target.value)); setPage(1) }}>
                <option value={10}>10</option>
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
            </label>
          </div>
        )}
      </div>

      <CrewfitOrderDrawer target={target} onClose={() => setTarget(null)} onSaved={() => { setTarget(null); load() }} />
    </div>
  )
}
