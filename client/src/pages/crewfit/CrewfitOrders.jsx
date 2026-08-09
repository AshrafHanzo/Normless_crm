import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApi } from '../../App'
import { useToast } from '../../components/Toast'
import DateRangeFilter from '../../components/DateRangeFilter'
import CrewfitOrderDrawer, { openShippingLabel } from './CrewfitOrderDrawer'
import Icon from '../../components/Icon'
import useServerTable from '../../hooks/useServerTable'
import SortTh from '../../components/SortTh'
import Pagination from '../../components/Pagination'

const fmt = (v) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v || 0)
// Only "Dispatched" is a finished state — "Dispatch Pending" is still work in progress.
const statusClass = (s) => { s = (s || '').toLowerCase(); if (s === 'dispatched') return 'fulfilled'; if (s.includes('cancel')) return 'refunded'; return 'pending' }
const payClass = (s) => (s === 'Fully Paid' ? 'fulfilled' : s === 'Pending' ? 'refunded' : 'pending')
const photoClass = (s) => (s === 'Complete' ? 'fulfilled' : s === 'Partial' ? 'pending' : '')

const emptyFilters = { search: '', status: '', payment_status: '', layout_status: '', so: '', vendor: '', mock_status: '', prod_status: '' }

export default function CrewfitOrders() {
  const apiFetch = useApi()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const [meta, setMeta] = useState(null)
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState(emptyFilters)
  const [searchTerm, setSearchTerm] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  // Server-side sort + page: a header click reorders every matching order, not this page's 25.
  const t = useServerTable({ sort: 'sl_no', dir: 'desc' })
  const [labelBusy, setLabelBusy] = useState(null)
  const [target, setTarget] = useState(null) // null | 'new' | order object

  useEffect(() => {
    apiFetch('/api/crewfit/meta').then(m => setMeta(m && m.statuses ? m : null))
  }, [])

  // Debounce free-text search so we don't hit the API on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => { setFilters(f => ({ ...f, search: searchTerm })); t.resetPage() }, 350)
    return () => clearTimeout(timer)
  }, [searchTerm])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [filters, startDate, endDate, t.key])

  const load = async () => {
    setLoading(true)
    const res = await apiFetch('/api/crewfit/orders?' + t.query({ ...filters, startDate, endDate }))
    const list = res?.orders || []
    setOrders(list)
    if (res?.pagination) t.setPagination(res.pagination)
    setLoading(false)
    const focus = params.get('focus')
    if (focus) { const f = list.find(o => String(o.id) === focus); if (f) setTarget(f); params.delete('focus'); setParams(params, { replace: true }) }
  }

  const setFilter = (k, v) => { setFilters(f => ({ ...f, [k]: v })); t.resetPage() }
  const applyDateFilter = (s, e) => { setStartDate(s); setEndDate(e); t.resetPage() }
  const clearDateFilter = () => { setStartDate(''); setEndDate(''); t.resetPage() }

  const printLabel = async (o) => { setLabelBusy(o.id); await openShippingLabel(apiFetch, o, toast); setLabelBusy(null) }
  const quickUpdate = async (id, patch) => { setOrders(os => os.map(o => o.id === id ? { ...o, ...patch } : o)); await apiFetch(`/api/crewfit/orders/${id}`, { method: 'PUT', body: JSON.stringify(patch) }) }
  const InlineSelect = ({ o, field, options, cls }) => {
    const opts = options || []
    return (<select className={`inline-select ${cls ? 'sb-' + cls(o[field]) : ''}`} value={o[field] || ''} onClick={e => e.stopPropagation()} onChange={e => quickUpdate(o.id, { [field]: e.target.value })}>
      {(o[field] && !opts.includes(o[field])) && <option value={o[field]}>{o[field]}</option>}{opts.map(v => <option key={v} value={v}>{v}</option>)}</select>)
  }


  return (
    <div className="page-enter">
      <div className="dash-toolbar">
        <div><h1>Crewfit · Bulk Orders</h1><p style={{ color: 'var(--text-muted)' }}>{t.pagination.total || 0} orders · manage everything here</p></div>
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
              <thead><tr>
                <SortTh label="#" col="sl_no" sort={t.sort} onSort={t.toggle} />
                <SortTh label="Date" col="order_date" sort={t.sort} onSort={t.toggle} />
                <SortTh label="Customer" col="customer_name" sort={t.sort} onSort={t.toggle} />
                <SortTh label="Product" col="product" sort={t.sort} onSort={t.toggle} />
                <SortTh label="Qty" col="qty" sort={t.sort} onSort={t.toggle} align="center" />
                <SortTh label="Total" col="total_cost" sort={t.sort} onSort={t.toggle} align="right" />
                <SortTh label="Deadline" col="deadline_at" sort={t.sort} onSort={t.toggle} />
                <SortTh label="Status" col="status" sort={t.sort} onSort={t.toggle} />
                <SortTh label="Payment" col="payment_status" sort={t.sort} onSort={t.toggle} />
                <SortTh label="Layout" col="layout_status" sort={t.sort} onSort={t.toggle} />
                <SortTh label="Photos" col="prod_photo_status" sort={t.sort} onSort={t.toggle} />
                <SortTh label="Label" align="center" />
              </tr></thead>
              <tbody>
                {orders.map(o => (
                  <tr key={o.id} onClick={() => setTarget(o)} className={o.notes?.trim() ? 'has-note' : ''}>
                    <td data-label="Order #" style={{ color: 'var(--text-muted)' }}>
                      <span className="order-no">
                        {o.sl_no}
                        {o.notes?.trim() && (
                          <span className="note-flag" title={o.notes} aria-label="Has an internal note">
                            <Icon name="note" size={13} />
                          </span>
                        )}
                      </span>
                    </td>
                    <td data-label="Date" style={{ fontSize: 12.5 }}>{(o.order_date || '').slice(0, 10) || '—'}</td>
                    <td className="cell-primary">
                      <div style={{ fontWeight: 600 }}>{o.customer_name}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{o.contact_number}</div>
                      {o.notes?.trim() && <div className="note-preview" title={o.notes}>{o.notes.trim()}</div>}
                    </td>
                    <td data-label="Product" style={{ fontSize: 12.5, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.product || '—'}</td>
                    <td data-label="Qty" style={{ textAlign: 'center' }}>{o.qty || '—'}</td>
                    <td data-label="Total" style={{ textAlign: 'right', fontWeight: 700 }}>{o.total_cost ? fmt(o.total_cost) : '—'}</td>
                    <td data-label="Deadline" style={{ fontSize: 12.5 }}>{(o.deadline_at || '').slice(0, 10) || <span style={{ color: 'var(--text-muted)' }}>{o.deadline_text || '—'}</span>}</td>
                    <td data-label="Status">{meta && <InlineSelect o={o} field="status" options={meta.statuses.filter(s => s !== 'Dispatched')} cls={statusClass} />}</td>
                    <td data-label="Payment">{meta && <InlineSelect o={o} field="payment_status" options={meta.payments} cls={payClass} />}</td>
                    <td data-label="Layout">{meta && <InlineSelect o={o} field="layout_status" options={meta.layouts} cls={(v) => v === 'Done' ? 'fulfilled' : 'refunded'} />}</td>
                    <td data-label="Photos" onClick={e => e.stopPropagation()}>
                      <div className="photo-status-badges">
                        <span className={`status-badge ${photoClass(o.mock_photo_status)}`}>Mock: {o.mock_photo_status}</span>
                        <span className={`status-badge ${photoClass(o.prod_photo_status)}`}>Prod: {o.prod_photo_status}</span>
                      </div>
                    </td>
                    <td className="cell-actions" data-label="Shipping label" style={{ textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                      <button className="btn-icon" title="Print shipping label" disabled={labelBusy === o.id} onClick={() => printLabel(o)}>
                        <Icon name="printer" size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!loading && <Pagination table={t} noun="orders" />}
      </div>

      <CrewfitOrderDrawer target={target} onClose={() => setTarget(null)} onSaved={() => { setTarget(null); load() }} />
    </div>
  )
}
