import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApi } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'

const fmt = (v) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v || 0)
const statusClass = (s) => { s = (s || '').toLowerCase(); if (s === 'dispatched') return 'fulfilled'; if (s.includes('cancel')) return 'refunded'; return 'pending' }
const payClass = (s) => (s === 'Fully Paid' ? 'fulfilled' : s === 'Pending' ? 'refunded' : 'pending')

// Indian mobile → wa.me wants digits only with country code.
function toWaNumber(phone) {
  let d = (phone || '').replace(/\D/g, '')
  if (!d) return null
  if (d.length === 10) d = '91' + d
  else if (d.length === 11 && d.startsWith('0')) d = '91' + d.slice(1)
  return d
}

// A customer's whole relationship at a glance: lifetime numbers on top, every order below.
function CustomerDrawer({ phone, onClose }) {
  const apiFetch = useApi()
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  // Mounted fresh per customer (the parent keys on phone), so state starts loading and the
  // effect only ever sets it after the fetch resolves — no synchronous reset needed here.
  useEffect(() => {
    if (!phone) return
    let cancelled = false
    apiFetch(`/api/crewfit/customers/${phone}`).then(r => {
      if (cancelled) return
      setData(r && !r.error ? r : null)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [phone])

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!phone) return null
  const c = data?.customer
  const wa = toWaNumber(c?.whatsapp_number || c?.phone)

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer drawer-wide" onClick={e => e.stopPropagation()}>
        <div className="drawer-header">
          <div>
            <h2 style={{ fontSize: 19 }}>{c?.customer_name || 'Customer'}</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>
              {c?.phone || phone}{c?.orders_count ? ` · ${c.orders_count} order${c.orders_count > 1 ? 's' : ''}` : ''}
            </p>
          </div>
          <button className="btn-icon" onClick={onClose}><Icon name="close" size={16} /></button>
        </div>

        <div className="drawer-body">
          {loading ? <div className="loader"><div className="spinner" /></div> : !data ? (
            <div className="empty-state"><p>Could not load this customer.</p></div>
          ) : (
            <>
              <div className="cust-stat-row" style={data.canViewRevenue ? undefined : { gridTemplateColumns: 'repeat(2, 1fr)' }}>
                {data.canViewRevenue && <div className="cust-stat"><span>Lifetime value</span><b>{fmt(c.total_value)}</b></div>}
                <div className="cust-stat"><span>Orders</span><b>{c.orders_count}</b></div>
                {data.canViewRevenue && <div className="cust-stat"><span>Avg order</span><b>{fmt(c.avg_order_value)}</b></div>}
                <div className="cust-stat"><span>Total pieces</span><b>{c.total_qty || 0}</b></div>
              </div>

              <div className="cust-meta">
                <div><span>Type</span><b><span className={`status-badge ${c.customer_type === 'Returning' ? 'fulfilled' : ''}`}>{c.customer_type}</span></b></div>
                <div><span>First order</span><b>{c.first_order_date || '—'}</b></div>
                <div><span>Last order</span><b>{c.last_order_date || '—'}</b></div>
                <div><span>Sales officer</span><b>{c.so || '—'}</b></div>
                {c.open_orders > 0 && <div><span>Open orders</span><b style={{ color: 'var(--warning)' }}>{c.open_orders}</b></div>}
                {c.unpaid_orders > 0 && <div><span>Awaiting payment</span><b style={{ color: 'var(--danger)' }}>{c.unpaid_orders}</b></div>}
                {c.gst_number && <div><span>GST</span><b>{c.gst_number}</b></div>}
              </div>

              {(c.delivery_location || c.billing_address) && (
                <div className="cust-address">
                  <span>Last known address</span>
                  <p>{c.delivery_location || c.billing_address}</p>
                </div>
              )}

              {wa && (
                <a className="btn btn-secondary" style={{ alignSelf: 'flex-start' }} href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer">
                  💬 Message on WhatsApp
                </a>
              )}

              <div>
                <div className="form-section">Order history</div>
                <div className="cust-history">
                  {data.orders.map(o => (
                    <button key={o.id} className="cust-order" onClick={() => navigate(`/crewfit/orders?focus=${o.id}`)}>
                      <div className="cust-order-top">
                        <b>CF-{o.sl_no}</b>
                        <span className="cust-order-date">{o.order_date || '—'}</span>
                        <span style={{ marginLeft: 'auto', fontWeight: 700 }}>{fmt(o.total_cost)}</span>
                      </div>
                      <div className="cust-order-mid">{o.product || '—'}{o.qty ? ` · ${o.qty} pcs` : ''}</div>
                      <div className="cust-order-badges">
                        <span className={`status-badge ${statusClass(o.status)}`}>{o.status}</span>
                        <span className={`status-badge ${payClass(o.payment_status)}`}>{o.payment_status}</span>
                        {o.tracking_link && <span className="status-badge">📦 {o.tracking_link}</span>}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export default function CrewfitCustomers() {
  const apiFetch = useApi()
  const toast = useToast()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [term, setTerm] = useState('')
  const [search, setSearch] = useState('')
  const [type, setType] = useState('')
  const [sort, setSort] = useState('recent')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState(null)

  useEffect(() => { const t = setTimeout(() => { setSearch(term); setPage(1) }, 350); return () => clearTimeout(t) }, [term])
  useEffect(() => { load() }, [search, type, sort, page])

  const load = async () => {
    setLoading(true)
    const qs = new URLSearchParams(Object.entries({ search, type, sort, page, limit: 25 }).filter(([, v]) => v)).toString()
    const res = await apiFetch('/api/crewfit/customers' + (qs ? '?' + qs : ''))
    if (res?.error) toast.error(res.error)
    setData(res && !res.error ? res : null)
    setLoading(false)
  }

  const customers = data?.customers || []
  const p = data?.pagination || { total: 0, totalPages: 1 }
  const stats = data?.stats
  // Server is the authority; default to hidden so a slow/failed load never flashes the total.
  const showRevenue = data?.canViewRevenue === true
  const totalPages = p.totalPages || 1

  return (
    <div className="page-enter">
      <div className="dash-toolbar">
        <div>
          <h1>Crewfit · Customers</h1>
          <p style={{ color: 'var(--text-muted)' }}>{p.total || 0} customers · grouped by phone number</p>
        </div>
      </div>

      {stats && (
        <div className={showRevenue ? 'grid-3' : 'grid-2'} style={{ marginBottom: 20 }}>
          <div className="glass-card"><div style={{ fontSize: 26, fontWeight: 800 }}>{stats.totalCustomers}</div><div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Total customers</div></div>
          <div className="glass-card"><div style={{ fontSize: 26, fontWeight: 800 }}>{stats.returningCustomers}</div><div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Returning customers</div></div>
          {/* Combined lifetime value is the revenue figure — server omits it unless permitted. */}
          {showRevenue && <div className="glass-card"><div style={{ fontSize: 26, fontWeight: 800 }}>{fmt(stats.lifetimeValue)}</div><div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Lifetime value</div></div>}
        </div>
      )}

      <div className="filters-row filters-row-search">
        <div className="search-bar"><span className="search-icon" /><input placeholder="Search by name or phone number…" value={term} onChange={e => setTerm(e.target.value)} /></div>
      </div>

      <div className="filters-row">
        <select value={type} onChange={e => { setType(e.target.value); setPage(1) }} style={{ width: 'auto' }}>
          <option value="">All customers</option><option value="Returning">Returning only</option><option value="New">First-time only</option>
        </select>
        <select value={sort} onChange={e => { setSort(e.target.value); setPage(1) }} style={{ width: 'auto' }}>
          <option value="recent">Most recent order</option><option value="orders">Most orders</option>
          {showRevenue && <option value="value">Highest value</option>}<option value="name">Name (A–Z)</option>
        </select>
      </div>

      <div className="data-table-wrapper">
        {loading ? <div className="loader"><div className="spinner" /></div> : customers.length === 0 ? (
          <div className="empty-state"><div className="empty-icon">👥</div><p>No customers match these filters.</p></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead><tr>
                <th>Customer</th><th style={{ textAlign: 'center' }}>Orders</th>
                {showRevenue && <><th style={{ textAlign: 'right' }}>Lifetime value</th><th style={{ textAlign: 'right' }}>Avg order</th></>}
                <th>First order</th><th>Last order</th><th>Type</th><th style={{ textAlign: 'center' }}>Chat</th>
              </tr></thead>
              <tbody>
                {customers.map(c => {
                  const wa = toWaNumber(c.whatsapp_number || c.phone)
                  return (
                    <tr key={c.phone} onClick={() => setSelected(c.phone)}>
                      <td className="cell-primary">
                        <div style={{ fontWeight: 600 }}>{c.customer_name || '—'}</div>
                        <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{c.phone}</div>
                      </td>
                      <td data-label="Orders" style={{ textAlign: 'center' }}>{c.orders_count}</td>
                      {showRevenue && <>
                        <td data-label="Lifetime value" style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(c.total_value)}</td>
                        <td data-label="Avg order" style={{ textAlign: 'right' }}>{fmt(c.avg_order_value)}</td>
                      </>}
                      <td data-label="First order" style={{ fontSize: 12.5 }}>{c.first_order_date || '—'}</td>
                      <td data-label="Last order" style={{ fontSize: 12.5 }}>{c.last_order_date || '—'}</td>
                      <td data-label="Type"><span className={`status-badge ${c.customer_type === 'Returning' ? 'fulfilled' : ''}`}>{c.customer_type}</span></td>
                      <td className="cell-actions" data-label="Chat" style={{ textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                        {wa && <a className="btn-icon" href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" title="Message on WhatsApp">💬</a>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {!loading && customers.length > 0 && totalPages > 1 && (
          <div className="pagination">
            <span className="pagination-info">Showing {(page - 1) * 25 + 1}–{Math.min(page * 25, p.total)} of {p.total}</span>
            <div className="pagination-pages">
              <button disabled={page <= 1} onClick={() => setPage(x => x - 1)}>‹</button>
              {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => (
                <button key={i + 1} className={page === i + 1 ? 'active' : ''} onClick={() => setPage(i + 1)}>{i + 1}</button>
              ))}
              {totalPages > 7 && <button disabled>…</button>}
              <button disabled={page >= totalPages} onClick={() => setPage(x => x + 1)}>›</button>
            </div>
          </div>
        )}
      </div>

      <CustomerDrawer key={selected} phone={selected} onClose={() => setSelected(null)} />
    </div>
  )
}
