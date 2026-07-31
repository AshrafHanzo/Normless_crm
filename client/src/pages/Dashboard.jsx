import { useState, useEffect } from 'react'
import { useApi } from '../App'
import Icon from '../components/Icon'

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
      setData(result || null); if (result?.error) setError(result.error)
    } catch { setError('Error loading dashboard') }
    setLoading(false)
  }
  const applyFilter = () => { if (startDate && endDate) loadDashboard(`/api/dashboard?startDate=${startDate}&endDate=${endDate}`) }
  const clearFilter = () => { setStartDate(''); setEndDate(''); loadDashboard('/api/dashboard') }

  const fmt = (v) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v || 0)
  const shortNum = (v) => { v = Number(v) || 0; if (v >= 1e7) return (v / 1e7).toFixed(2) + 'Cr'; if (v >= 1e5) return (v / 1e5).toFixed(2) + 'L'; if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K'; return String(v) }
  const statusColor = (name) => { const s = (name || '').toLowerCase(); if (s.includes('unfulfilled') || s.includes('pending') || s === 'null') return 'var(--warning)'; if (s.includes('partial')) return 'var(--info)'; if (s.includes('restock') || s.includes('cancel') || s.includes('refund')) return 'var(--danger)'; if (s.includes('fulfilled')) return 'var(--success)'; return 'var(--primary)' }

  if (loading) return <div className="loader"><div className="spinner" /><span>Loading dashboard…</span></div>
  if (error) return <div className="page-enter"><div className="login-error" style={{ maxWidth: 480 }}>Error: {error}</div></div>
  if (!data?.metrics) return <div className="empty-state"><Icon name="dashboard" size={44} /><p>No data available yet</p></div>

  const m = data.metrics
  const daily = data.dailyRevenue || []
  const statuses = data.statusBreakdown || []
  const statusTotal = statuses.reduce((s, x) => s + Number(x.count), 0) || 1

  const kpis = [
    { icon: 'wallet', label: 'Total Revenue', value: fmt(m.totalRevenue), trend: `${fmt(m.revenueThisMonth)} this mo`, cls: 'up' },
    { icon: 'box', label: 'Total Orders', value: shortNum(m.totalOrders), trend: `+${m.ordersThisMonth} this mo`, cls: 'up' },
    { icon: 'users', label: 'Total Customers', value: shortNum(m.totalCustomers), trend: `+${m.newCustomersThisMonth} this mo`, cls: 'up' },
    { icon: 'trending', label: 'Avg Order Value', value: fmt(m.avgOrderValue), trend: 'per order', cls: 'neutral' },
  ]

  return (
    <div className="page-enter">
      <div className="dash-toolbar">
        <div><h1>Dashboard</h1><p style={{ color: 'var(--text-muted)' }}>Real-time analytics &amp; insights</p></div>
        <div className="date-filter">
          <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
          <span style={{ color: 'var(--text-muted)' }}>→</span>
          <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} />
          <button className="btn btn-primary btn-sm" onClick={applyFilter} disabled={!startDate || !endDate}>Apply</button>
          {(startDate || endDate) && <button className="btn btn-secondary btn-sm" onClick={clearFilter}>Clear</button>}
        </div>
      </div>

      <div className="kpi-grid">
        {kpis.map((k, i) => (
          <div className="kpi-card" key={i}>
            <div className="kpi-head"><div className="kpi-icon"><Icon name={k.icon} size={22} /></div><span className={`kpi-trend ${k.cls}`}>{k.trend}</span></div>
            <div className="kpi-value">{k.value}</div>
            <div className="kpi-label">{k.label}</div>
          </div>
        ))}
      </div>

      <div className="dash-row charts">
        <div className="panel">
          <div className="panel-head"><div><div className="panel-title">Revenue Trend</div><div className="panel-sub">{startDate && endDate ? 'Selected range' : 'Last 30 days'}</div></div></div>
          <div className="panel-body">
            {daily.length ? <AreaChart data={daily} fmt={fmt} /> : <div className="chart-empty">No revenue data for this range</div>}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head"><div className="panel-title">Order Status</div></div>
          <div className="panel-body">
            {statuses.length ? (
              <div className="status-list">
                {statuses.map((s, i) => {
                  const pct = (Number(s.count) / statusTotal) * 100, color = statusColor(s.fulfillment_status)
                  return (
                    <div key={i}>
                      <div className="status-row"><span className="status-name"><span className="status-dot" style={{ background: color }} />{s.fulfillment_status || 'Unfulfilled'}</span><span className="status-count">{s.count} · {pct.toFixed(0)}%</span></div>
                      <div className="status-track"><div className="status-fill" style={{ width: `${pct}%`, background: color }} /></div>
                    </div>
                  )
                })}
              </div>
            ) : <div className="empty-state" style={{ padding: '30px 0' }}>No status data</div>}
          </div>
        </div>
      </div>

      <div className="dash-row tables">
        <div className="panel">
          <div className="panel-head"><div className="panel-title">Top Customers</div><span className="panel-sub">by spend</span></div>
          <table className="data-table">
            <thead><tr><th>Customer</th><th style={{ textAlign: 'center' }}>Orders</th><th style={{ textAlign: 'right' }}>Spent</th></tr></thead>
            <tbody>
              {(data.topCustomers || []).slice(0, 8).map((c) => (
                <tr key={c.id}>
                  <td><div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><div className="avatar" style={{ width: 30, height: 30, fontSize: 12 }}>{(c.first_name || '?').charAt(0)}</div><span>{c.first_name} {c.last_name}</span></div></td>
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
                return (<tr key={o.id}><td style={{ fontWeight: 700 }}>{o.order_number}</td><td style={{ textAlign: 'center' }}><span className={`status-badge ${fulfilled ? 'fulfilled' : 'pending'}`}>{o.fulfillment_status || 'Pending'}</span></td><td style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(o.total_price)}</td></tr>)
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// SVG area + line chart (single series, gradient fill)
function AreaChart({ data, fmt }) {
  const W = 1000, H = 240, top = 16, bot = 24
  const max = Math.max(...data.map(d => d.revenue), 1)
  const n = data.length
  const x = (i) => (n <= 1 ? W / 2 : (i / (n - 1)) * W)
  const y = (v) => top + (1 - v / max) * (H - top - bot)
  const line = data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.revenue).toFixed(1)}`).join(' ')
  const area = `${line} L${W},${H - bot} L0,${H - bot} Z`
  const grid = [0.25, 0.5, 0.75, 1].map(f => top + f * (H - top - bot))
  return (
    <div className="area-chart">
      <div className="chart-ymax">{fmt(max)}</div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: 230 }}>
        <defs>
          <linearGradient id="revfill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {grid.map((gy, i) => <line key={i} x1="0" y1={gy} x2={W} y2={gy} stroke="var(--border)" strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
        <path d={area} fill="url(#revfill)" />
        <path d={line} fill="none" stroke="var(--primary)" strokeWidth="2.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        {data.map((d, i) => <circle key={i} cx={x(i)} cy={y(d.revenue)} r="7" fill="transparent"><title>{`${d.date}: ${fmt(d.revenue)} (${d.order_count} orders)`}</title></circle>)}
      </svg>
      <div className="chart-axis"><span>{data[0]?.date}</span><span>{data[data.length - 1]?.date}</span></div>
    </div>
  )
}
