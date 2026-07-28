import { useState, useEffect } from 'react'
import { useApi } from '../App'

export default function Dashboard() {
  const apiFetch = useApi()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')

  useEffect(() => { loadDashboard('') }, [])

  const loadDashboard = async (url) => {
    setLoading(true); setError(null)
    try {
      const result = await apiFetch(url || '/api/dashboard')
      setData(result || null)
      if (result?.error) setError(result.error)
    } catch {
      setError('Error loading dashboard')
    }
    setLoading(false)
  }

  const applyFilter = () => {
    if (startDate && endDate) loadDashboard(`/api/dashboard?startDate=${startDate}&endDate=${endDate}`)
  }
  const clearFilter = () => { setStartDate(''); setEndDate(''); loadDashboard('/api/dashboard') }

  const fmt = (val) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0 }).format(val || 0)
  const shortNum = (val) => {
    val = Number(val) || 0
    if (val >= 1e7) return (val / 1e7).toFixed(2) + 'Cr'
    if (val >= 1e5) return (val / 1e5).toFixed(2) + 'L'
    if (val >= 1e3) return (val / 1e3).toFixed(1) + 'K'
    return String(val)
  }

  const statusColor = (name) => {
    const s = (name || '').toLowerCase()
    if (s.includes('unfulfilled') || s.includes('pending') || s === 'null') return 'var(--warning)'
    if (s.includes('partial')) return 'var(--info)'
    if (s.includes('restock') || s.includes('cancel') || s.includes('refund')) return 'var(--danger)'
    if (s.includes('fulfilled')) return 'var(--success)'
    return 'var(--primary)'
  }

  if (loading) return <div className="loader"><div className="spinner" /><span>Loading dashboard…</span></div>
  if (error) return <div className="page-enter"><div className="login-error" style={{ maxWidth: 480 }}>Error: {error}</div></div>
  if (!data?.metrics) return <div className="empty-state"><div className="empty-icon">📊</div><p>No data available yet</p></div>

  const m = data.metrics
  const daily = data.dailyRevenue || []
  const maxRev = daily.length ? Math.max(...daily.map(d => d.revenue), 1) : 1
  const statuses = data.statusBreakdown || []
  const statusTotal = statuses.reduce((s, x) => s + Number(x.count), 0) || 1

  const kpis = [
    { icon: '💰', label: 'Total Revenue', value: fmt(m.totalRevenue), trend: `${fmt(m.revenueThisMonth)} this mo`, cls: 'up' },
    { icon: '📦', label: 'Total Orders', value: shortNum(m.totalOrders), trend: `+${m.ordersThisMonth} this mo`, cls: 'up' },
    { icon: '👥', label: 'Total Customers', value: shortNum(m.totalCustomers), trend: `+${m.newCustomersThisMonth} this mo`, cls: 'up' },
    { icon: '📈', label: 'Avg Order Value', value: fmt(m.avgOrderValue), trend: 'per order', cls: 'neutral' },
  ]

  return (
    <div className="page-enter">
      <div className="dash-toolbar">
        <div>
          <h1>Dashboard</h1>
          <p style={{ color: 'var(--text-muted)' }}>Real-time analytics &amp; insights</p>
        </div>
        <div className="date-filter">
          <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
          <span style={{ color: 'var(--text-muted)' }}>→</span>
          <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} />
          <button className="btn btn-primary btn-sm" onClick={applyFilter} disabled={!startDate || !endDate}>Apply</button>
          {(startDate || endDate) && <button className="btn btn-secondary btn-sm" onClick={clearFilter}>Clear</button>}
        </div>
      </div>

      {/* KPIs */}
      <div className="kpi-grid">
        {kpis.map((k, i) => (
          <div className="kpi-card" key={i}>
            <div className="kpi-head">
              <div className="kpi-icon">{k.icon}</div>
              <span className={`kpi-trend ${k.cls}`}>{k.trend}</span>
            </div>
            <div className="kpi-value">{k.value}</div>
            <div className="kpi-label">{k.label}</div>
          </div>
        ))}
      </div>

      {/* Charts */}
      <div className="dash-row charts">
        <div className="panel">
          <div className="panel-head">
            <div>
              <div className="panel-title">Revenue Trend</div>
              <div className="panel-sub">{startDate && endDate ? 'Selected range' : 'Last 30 days'}</div>
            </div>
          </div>
          <div className="panel-body">
            {daily.length ? (
              <>
                <div className="chart">
                  {daily.map((d, i) => (
                    <div key={i} className="chart-bar"
                      style={{ height: `${Math.max((d.revenue / maxRev) * 100, 1.5)}%` }}
                      title={`${d.date} — ${fmt(d.revenue)} (${d.order_count} orders)`} />
                  ))}
                </div>
                <div className="chart-axis">
                  <span>{daily[0]?.date}</span>
                  <span>{daily[daily.length - 1]?.date}</span>
                </div>
              </>
            ) : <div className="chart-empty">No revenue data for this range</div>}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head"><div className="panel-title">Order Status</div></div>
          <div className="panel-body">
            {statuses.length ? (
              <div className="status-list">
                {statuses.map((s, i) => {
                  const pct = ((Number(s.count) / statusTotal) * 100)
                  const color = statusColor(s.fulfillment_status)
                  return (
                    <div key={i}>
                      <div className="status-row">
                        <span className="status-name"><span className="status-dot" style={{ background: color }} />{s.fulfillment_status || 'Unfulfilled'}</span>
                        <span className="status-count">{s.count} · {pct.toFixed(0)}%</span>
                      </div>
                      <div className="status-track"><div className="status-fill" style={{ width: `${pct}%`, background: color }} /></div>
                    </div>
                  )
                })}
              </div>
            ) : <div className="empty-state" style={{ padding: '30px 0' }}>No status data</div>}
          </div>
        </div>
      </div>

      {/* Tables */}
      <div className="dash-row tables">
        <div className="panel">
          <div className="panel-head"><div className="panel-title">Top Customers</div><span className="panel-sub">by spend</span></div>
          <table className="data-table">
            <thead><tr><th>Customer</th><th style={{ textAlign: 'center' }}>Orders</th><th style={{ textAlign: 'right' }}>Spent</th></tr></thead>
            <tbody>
              {(data.topCustomers || []).slice(0, 8).map((c) => (
                <tr key={c.id}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div className="avatar" style={{ width: 30, height: 30, fontSize: 12 }}>{(c.first_name || '?').charAt(0)}</div>
                      <span>{c.first_name} {c.last_name}</span>
                    </div>
                  </td>
                  <td style={{ textAlign: 'center', fontWeight: 600 }}>{c.orders_count}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--success)' }}>{fmt(c.total_spent)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="panel">
          <div className="panel-head"><div className="panel-title">Recent Orders</div><span className="panel-sub">latest 8</span></div>
          <table className="data-table">
            <thead><tr><th>Order</th><th style={{ textAlign: 'center' }}>Status</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
            <tbody>
              {(data.recentOrders || []).slice(0, 8).map((o) => {
                const fulfilled = o.fulfillment_status?.toLowerCase().includes('fulfilled') && !o.fulfillment_status?.toLowerCase().includes('un')
                return (
                  <tr key={o.id}>
                    <td style={{ fontWeight: 700 }}>{o.order_number}</td>
                    <td style={{ textAlign: 'center' }}>
                      <span className={`status-badge ${fulfilled ? 'fulfilled' : 'pending'}`}>{o.fulfillment_status || 'Pending'}</span>
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(o.total_price)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
