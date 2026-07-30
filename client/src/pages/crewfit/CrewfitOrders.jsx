import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApi } from '../../App'

const fmt = (v) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v || 0)

const statusClass = (s) => {
  s = (s || '').toLowerCase()
  if (s.includes('dispatch') && s.includes('ready')) return 'pending'
  if (s.includes('dispatch')) return 'fulfilled'
  if (s.includes('cancel')) return 'refunded'
  return 'pending'
}
const payClass = (s) => (s === 'Fully Paid' ? 'fulfilled' : s === 'Pending' ? 'refunded' : 'pending')

export default function CrewfitOrders() {
  const apiFetch = useApi()
  const [params, setParams] = useSearchParams()
  const [meta, setMeta] = useState(null)
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState({ search: '', status: '', payment_status: '', so: '', vendor: '' })
  const [active, setActive] = useState(null) // drawer order

  useEffect(() => { apiFetch('/api/crewfit/meta').then(m => setMeta(m && m.statuses ? m : null)) }, [])
  useEffect(() => { load() }, [filters])

  const load = async () => {
    setLoading(true)
    const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString()
    const res = await apiFetch('/api/crewfit/orders' + (qs ? '?' + qs : ''))
    const list = res?.orders || []
    setOrders(list)
    setLoading(false)
    const focus = params.get('focus')
    if (focus) { const f = list.find(o => String(o.id) === focus); if (f) setActive(f); params.delete('focus'); setParams(params, { replace: true }) }
  }

  const update = async (id, patch) => {
    setOrders(os => os.map(o => o.id === id ? { ...o, ...patch } : o))
    setActive(a => (a && a.id === id ? { ...a, ...patch } : a))
    await apiFetch(`/api/crewfit/orders/${id}`, { method: 'PUT', body: JSON.stringify(patch) })
  }

  const Select = ({ o, field, options, cls }) => {
    const opts = options || []
    return (
      <select className={`inline-select ${cls ? 'sb-' + cls(o[field]) : ''}`} value={o[field] || ''} onClick={e => e.stopPropagation()} onChange={e => update(o.id, { [field]: e.target.value })}>
        {(o[field] && !opts.includes(o[field])) && <option value={o[field]}>{o[field]}</option>}
        {opts.map(v => <option key={v} value={v}>{v}</option>)}
      </select>
    )
  }

  return (
    <div className="page-enter">
      <div className="page-header">
        <h1>Crewfit · Bulk Orders</h1>
        <p>{orders.length} orders · change any dropdown to update instantly</p>
      </div>

      <div className="filters-row">
        <div className="search-bar">
          <span className="search-icon">🔍</span>
          <input placeholder="Search customer, phone, order #…" value={filters.search} onChange={e => setFilters(f => ({ ...f, search: e.target.value }))} />
        </div>
        <select value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value }))} style={{ width: 'auto' }}>
          <option value="">All statuses</option>{(meta?.statuses || []).map(s => <option key={s}>{s}</option>)}
        </select>
        <select value={filters.payment_status} onChange={e => setFilters(f => ({ ...f, payment_status: e.target.value }))} style={{ width: 'auto' }}>
          <option value="">All payments</option>{(meta?.payments || []).map(s => <option key={s}>{s}</option>)}
        </select>
        <select value={filters.so} onChange={e => setFilters(f => ({ ...f, so: e.target.value }))} style={{ width: 'auto' }}>
          <option value="">All SO</option>{(meta?.sos || []).map(s => <option key={s}>{s}</option>)}
        </select>
        <select value={filters.vendor} onChange={e => setFilters(f => ({ ...f, vendor: e.target.value }))} style={{ width: 'auto' }}>
          <option value="">All vendors</option>{(meta?.vendors || []).map(s => <option key={s}>{s}</option>)}
        </select>
      </div>

      <div className="data-table-wrapper">
        {loading ? <div className="loader"><div className="spinner" /></div> : orders.length === 0 ? (
          <div className="empty-state"><div className="empty-icon">📦</div><p>No orders match your filters</p></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead><tr>
                <th>#</th><th>Customer</th><th style={{ textAlign: 'center' }}>Qty</th><th style={{ textAlign: 'right' }}>Total</th>
                <th>Deadline</th><th>Status</th><th>Payment</th><th>Layout</th><th>Vendor</th>
              </tr></thead>
              <tbody>
                {orders.map(o => (
                  <tr key={o.id} onClick={() => setActive(o)}>
                    <td style={{ color: 'var(--text-muted)' }}>{o.sl_no}</td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{o.customer_name}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{o.contact_number}</div>
                    </td>
                    <td style={{ textAlign: 'center' }}>{o.qty || '—'}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{o.total_cost ? fmt(o.total_cost) : '—'}</td>
                    <td style={{ fontSize: 12.5 }}>{o.deadline_at || <span style={{ color: 'var(--text-muted)' }}>{o.deadline_text || '—'}</span>}</td>
                    <td>{meta && <Select o={o} field="status" options={meta.statuses} cls={statusClass} />}</td>
                    <td>{meta && <Select o={o} field="payment_status" options={meta.payments} cls={payClass} />}</td>
                    <td>{meta && <Select o={o} field="layout_status" options={meta.layouts} cls={(v) => v === 'Done' ? 'fulfilled' : 'refunded'} />}</td>
                    <td>{meta && <Select o={o} field="vendor" options={meta.vendors} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {active && meta && (
        <>
          <div className="drawer-overlay" onClick={() => setActive(null)} />
          <div className="drawer">
            <div className="drawer-header">
              <div>
                <h2>{active.customer_name}</h2>
                <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Order #{active.sl_no} · {active.contact_number}</div>
              </div>
              <button className="btn-icon" onClick={() => setActive(null)}>✕</button>
            </div>
            <div className="drawer-body">
              <div className="form-row">
                <div className="input-group"><label>Status</label><Select o={active} field="status" options={meta.statuses} /></div>
                <div className="input-group"><label>Payment</label><Select o={active} field="payment_status" options={meta.payments} /></div>
                <div className="input-group"><label>Layout</label><Select o={active} field="layout_status" options={meta.layouts} /></div>
                <div className="input-group"><label>Customer Type</label><Select o={active} field="customer_type" options={meta.customerTypes} /></div>
                <div className="input-group"><label>Sales Officer</label><Select o={active} field="so" options={meta.sos} /></div>
                <div className="input-group"><label>Vendor</label><Select o={active} field="vendor" options={meta.vendors} /></div>
                <div className="input-group"><label>Dispatch (MOT)</label><Select o={active} field="mot" options={meta.mots} /></div>
                <div className="input-group"><label>Deadline</label><input type="date" value={active.deadline_at || ''} onChange={e => update(active.id, { deadline_at: e.target.value })} /></div>
              </div>

              <div className="input-group"><label>Tracking link</label>
                <input value={active.tracking_link || ''} placeholder="Courier tracking URL" onChange={e => update(active.id, { tracking_link: e.target.value })} />
              </div>

              {active.mock_folder && <a href={active.mock_folder} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm">🎨 Open mock folder</a>}

              <div className="input-group"><label>Order details</label>
                <div className="order-block">{active.description || 'No details'}</div>
              </div>

              <div className="input-group"><label>Notes</label>
                <textarea rows={3} value={active.notes || ''} placeholder="Add a note…" onChange={e => update(active.id, { notes: e.target.value })} />
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
