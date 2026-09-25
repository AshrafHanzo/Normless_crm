import { useState, useEffect } from 'react'
import { useApi, useAuth } from '../../App'
import { useToast } from '../../components/Toast'
import useServerTable from '../../hooks/useServerTable'
import SortTh from '../../components/SortTh'
import Pagination from '../../components/Pagination'
import Icon from '../../components/Icon'

const money = (v) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v || 0)
const stamp = (v) => (v ? new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—')
const today = () => new Date().toLocaleDateString('en-CA')   // YYYY-MM-DD in local time

/**
 * Everything the bench has packed and handed to the courier.
 *
 * Opens on today, because the question this tab answers at the bench is "did that one go out?"
 * — and today's parcels are the ones anyone is still asking about. The stored row is a snapshot
 * taken at the moment of packing, so it keeps reading correctly after the order changes.
 */
export default function PackedTab() {
  const apiFetch = useApi()
  const toast = useToast()
  const { user } = useAuth()
  const isAdmin = ['owner', 'admin'].includes(user?.role)

  const [rows, setRows] = useState([])
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [term, setTerm] = useState('')
  const [onlyToday, setOnlyToday] = useState(true)
  const [busy, setBusy] = useState(null)
  const t = useServerTable({ sort: 'packed_at', dir: 'desc' })

  useEffect(() => {
    const timer = setTimeout(() => { setTerm(search); t.resetPage() }, 350)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  const load = async () => {
    setLoading(true)
    const q = { ...(term && { search: term }), ...(onlyToday ? { from: today(), to: today() } : {}) }
    const res = await apiFetch('/api/scanner/packed?' + t.query(q))
    if (res && !res.error) {
      setRows(res.packed || [])
      setSummary(res.summary || null)
      if (res.pagination) t.setPagination(res.pagination)
    }
    setLoading(false)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [term, onlyToday, t.key])

  const fetchAwb = async (row) => {
    setBusy(row.id)
    const res = await apiFetch(`/api/scanner/packed/${row.id}/awb`, { method: 'POST', body: JSON.stringify({}) })
    setBusy(null)
    if (!res || res.error) { toast.error(res?.error || 'Could not read a tracking number'); return }
    toast.success(`${row.order_number} · AWB ${res.packed.awb}`)
    load()
  }

  const remove = async (row) => {
    if (!await toast.confirm({
      title: `Remove ${row.order_number} from the dispatch log?`,
      message: 'Only do this if it was marked packed by mistake — the parcel record disappears for good.',
      confirmLabel: 'Remove', cancelLabel: 'Keep it', danger: true,
    })) return
    const res = await apiFetch(`/api/scanner/packed/${row.id}`, { method: 'DELETE' })
    if (!res || res.error) { toast.error(res?.error || 'Failed'); return }
    toast.success(`${row.order_number} removed`)
    load()
  }

  return (
    <div className="packed-tab">
      <div className="packed-toolbar">
        <div className="packed-stats">
          <span className="packed-stat"><b>{summary?.today ?? 0}</b> packed today</span>
          <span className="packed-stat packed-stat-muted"><b>{summary?.total ?? 0}</b> in total</span>
          {!!summary?.missing_awb && (
            <span className="packed-stat packed-stat-warn"><b>{summary.missing_awb}</b> without an AWB</span>
          )}
        </div>
        <div className="packed-filters">
          <div className="search-bar">
            <span className="search-icon" />
            <input placeholder="Order number, AWB, customer or phone…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <button type="button" className={`mini-btn ${onlyToday ? 'mini-btn-active' : ''}`}
            onClick={() => { setOnlyToday(v => !v); t.resetPage() }}>
            {onlyToday ? 'Today' : 'All days'}
          </button>
        </div>
      </div>

      <div className="data-table-wrapper">
        {loading ? <div className="loader"><div className="spinner" /></div> : !rows.length ? (
          <div className="empty-state">
            <div className="empty-icon">📦</div>
            <p>{term ? 'Nothing matches that.' : onlyToday ? 'Nothing packed yet today.' : 'No parcels have been confirmed packed yet.'}</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead><tr>
                <SortTh label="Order" col="order_number" sort={t.sort} onSort={t.toggle} />
                <SortTh label="AWB" col="awb" sort={t.sort} onSort={t.toggle} />
                <SortTh label="Customer" col="customer_name" sort={t.sort} onSort={t.toggle} />
                <th>Contents</th>
                <SortTh label="Value" col="total_price" sort={t.sort} onSort={t.toggle} />
                <SortTh label="Packed by" col="packed_by" sort={t.sort} onSort={t.toggle} />
                <SortTh label="Packed at" col="packed_at" sort={t.sort} onSort={t.toggle} />
                {isAdmin && <th />}
              </tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id}>
                    <td data-label="Order" className="cell-primary">{r.order_number}</td>
                    <td data-label="AWB">
                      {r.awb ? (
                        <>
                          {r.tracking_url
                            ? <a href={r.tracking_url} target="_blank" rel="noreferrer" className="packed-awb">{r.awb}</a>
                            : <span className="packed-awb">{r.awb}</span>}
                          {r.courier && <div className="packed-sub">{r.courier}</div>}
                        </>
                      ) : (
                        <button type="button" className="mini-btn" disabled={busy === r.id} onClick={() => fetchAwb(r)}>
                          {busy === r.id ? 'Checking…' : 'Fetch AWB'}
                        </button>
                      )}
                    </td>
                    <td data-label="Customer">
                      {r.customer_name || '—'}
                      <div className="packed-sub">
                        {[r.customer_phone, [r.ship_city, r.ship_state].filter(Boolean).join(', ')].filter(Boolean).join(' · ') || '—'}
                      </div>
                    </td>
                    <td data-label="Contents">
                      <span className="packed-qty">{r.total_qty} {r.total_qty === 1 ? 'unit' : 'units'}</span>
                      <div className="packed-sub">{(r.items || []).map(i => `${i.title}${i.variant ? ` (${i.variant})` : ''} ×${i.quantity}`).join(', ') || '—'}</div>
                    </td>
                    <td data-label="Value">{money(r.total_price)}</td>
                    <td data-label="Packed by">{r.packed_by || '—'}</td>
                    <td data-label="Packed at">{stamp(r.packed_at)}</td>
                    {isAdmin && (
                      <td data-label="">
                        <button type="button" className="mini-btn" style={{ color: 'var(--danger)' }} onClick={() => remove(r)} title="Marked packed by mistake">
                          <Icon name="trash" size={14} />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <Pagination table={t} noun="parcels" />
    </div>
  )
}
