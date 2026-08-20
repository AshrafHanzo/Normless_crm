import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import useServerTable from '../../hooks/useServerTable'
import SortTh from '../../components/SortTh'
import Pagination from '../../components/Pagination'
import DateRangeFilter from '../../components/DateRangeFilter'
import { useApi } from '../../App'

const dt = (v) => (v ? new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—')
const dash = (v) => (v === null || v === undefined || v === '' ? '—' : v)

export default function CrewfitActivity() {
  const apiFetch = useApi()
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState({ user: '', field: '', search: '' })
  const [searchTerm, setSearchTerm] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const t = useServerTable({ sort: 'changed_at', dir: 'desc', limit: 50 })

  useEffect(() => {
    const timer = setTimeout(() => { setFilters(f => ({ ...f, search: searchTerm })); t.resetPage() }, 350)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [filters, startDate, endDate, t.key])

  const load = async () => {
    setLoading(true)
    const r = await apiFetch('/api/crewfit/activity?' + t.query({ ...filters, from: startDate, to: endDate }))
    if (r && !r.error) { setData(r); t.setPagination(r.pagination) }
    setLoading(false)
  }

  const setFilter = (k, v) => { setFilters(f => ({ ...f, [k]: v })); t.resetPage() }
  const labels = data?.fields || {}

  return (
    <div className="page-enter">
      <div className="dash-toolbar">
        <div>
          <h1>Crewfit · Activity</h1>
          <p style={{ color: 'var(--text-muted)' }}>
            Every change to an order — who made it and when. {t.pagination.total || 0} entries.
          </p>
        </div>
        <DateRangeFilter startDate={startDate} endDate={endDate}
          onApply={(s, e) => { setStartDate(s); setEndDate(e); t.resetPage() }}
          onClear={() => { setStartDate(''); setEndDate(''); t.resetPage() }} />
      </div>

      <div className="filters-row filters-row-search">
        <div className="search-bar"><span className="search-icon" />
          <input placeholder="Search by customer, order number, or what it was changed to…"
            value={searchTerm} onChange={e => setSearchTerm(e.target.value)} />
        </div>
      </div>

      <div className="filters-row">
        <select value={filters.user} onChange={e => setFilter('user', e.target.value)} style={{ width: 'auto' }}>
          <option value="">Everyone</option>
          {(data?.users || []).map(u => <option key={u.changed_by} value={u.changed_by}>{u.changed_by} ({u.n})</option>)}
        </select>
        <select value={filters.field} onChange={e => setFilter('field', e.target.value)} style={{ width: 'auto' }}>
          <option value="">All changes</option>
          {Object.entries(labels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>

      <div className="data-table-wrapper">
        {loading ? <div className="loader"><div className="spinner" /></div> : !(data?.activity || []).length ? (
          <div className="empty-state"><div className="empty-icon">🕓</div><p>No changes match these filters.</p></div>
        ) : (
          <table className="data-table">
            <thead><tr>
              <SortTh label="When" col="changed_at" sort={t.sort} onSort={t.toggle} />
              <SortTh label="Who" col="changed_by" sort={t.sort} onSort={t.toggle} />
              <SortTh label="Order" col="sl_no" sort={t.sort} onSort={t.toggle} />
              <SortTh label="Changed" col="field" sort={t.sort} onSort={t.toggle} />
              <SortTh label="From" />
              <SortTh label="To" />
            </tr></thead>
            <tbody>
              {(data.activity || []).map(a => (
                <tr key={a.id} onClick={() => navigate(`/crewfit/orders?focus=${a.order_id}`)} style={{ cursor: 'pointer' }}>
                  <td data-label="When" style={{ fontSize: 12 }}>{dt(a.changed_at)}</td>
                  <td data-label="Who" className="cell-primary">{dash(a.changed_by)}</td>
                  <td data-label="Order">
                    <div style={{ fontWeight: 600 }}>#{a.sl_no}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{a.customer_name}</div>
                  </td>
                  <td data-label="Changed">
                    {a.action === 'create'
                      ? <span className="status-badge fulfilled">Order created</span>
                      : (labels[a.field] || a.field)}
                  </td>
                  <td data-label="From" style={{ color: 'var(--text-muted)' }}>{dash(a.old_value)}</td>
                  <td data-label="To" style={{ fontWeight: 600 }}>{dash(a.new_value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {!loading && <Pagination table={t} noun="changes" />}
    </div>
  )
}
