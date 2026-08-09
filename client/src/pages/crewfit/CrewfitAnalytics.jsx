import { useState, useEffect } from 'react'
import { useApi } from '../../App'
import Icon from '../../components/Icon'
import DateRangeFilter from '../../components/DateRangeFilter'
import { AreaChart } from '../Dashboard'

const fmt = (v) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v || 0)
const pct = (v) => (v == null ? '—' : `${v.toFixed(0)}%`)

const STATUS_COLORS = {
  'Pending': 'var(--text-muted)', 'Consignment Ordered': 'var(--info)', 'Consignment Received': 'var(--info)',
  'Ongoing Production': 'var(--primary)', 'Ready for Dispatch': 'var(--warning)', 'Dispatch Pending': 'var(--info)',
  'Dispatched': 'var(--success)', 'Awaiting Payment': 'var(--warning)', 'Cancelled': 'var(--danger)',
}
const PAYMENT_COLORS = { 'Pending': 'var(--danger)', '50% Paid': 'var(--warning)', 'Fully Paid': 'var(--success)' }
const TYPE_COLORS = { 'New': 'var(--primary)', 'Returning': 'var(--success)', 'Unknown': 'var(--text-muted)' }
const BUCKET_COLORS = ['var(--success)', 'var(--info)', 'var(--warning)', 'var(--danger)']

// Shared with Dashboard.jsx's Order Status panel — a labeled row + proportional bar per entry.
function BarList({ rows, colorFor }) {
  const total = rows.reduce((s, r) => s + r.count, 0) || 1
  return (
    <div className="status-list">
      {rows.map((r, i) => {
        const pctVal = (r.count / total) * 100
        const color = colorFor(r, i)
        return (
          <div key={r.label}>
            <div className="status-row">
              <span className="status-name"><span className="status-dot" style={{ background: color }} />{r.label}</span>
              <span className="status-count">{r.count}{r.amount != null ? ` · ${fmt(r.amount)}` : ''} · {pctVal.toFixed(0)}%</span>
            </div>
            <div className="status-track"><div className="status-fill" style={{ width: `${pctVal}%`, background: color }} /></div>
          </div>
        )
      })}
    </div>
  )
}

const emptyRow = (colSpan) => <tr><td colSpan={colSpan} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '24px 0' }}>No data yet</td></tr>

// Ranked leaderboard bars — top 3 get medal-style badges, bar width scales to the leader's revenue.
// Without revenue permission the same chart ranks by units instead, so the panel stays useful
// rather than rendering a row of empty bars (the server sends no revenue field at all).
function TopProductsChart({ products, showRevenue }) {
  const metric = (p) => (showRevenue ? p.revenue : p.qty)
  const max = Math.max(...products.map(metric), 1)
  return (
    <div className="rank-bar-list">
      {products.map((p, i) => (
        <div className={`rank-bar-row rank-${i + 1}`} key={p.product}>
          <span className="rank-badge">{i + 1}</span>
          <div className="rank-bar-main">
            <div className="rank-bar-head">
              <span className="rank-bar-name" title={p.product}>{p.product}</span>
              <span className="rank-bar-value">{showRevenue ? fmt(p.revenue) : `${p.qty} units`}</span>
            </div>
            <div className="rank-bar-track"><div className="rank-bar-fill" style={{ width: `${(metric(p) / max) * 100}%` }} /></div>
            <div className="rank-bar-sub">{p.qty} units sold</div>
          </div>
        </div>
      ))}
    </div>
  )
}

export default function CrewfitAnalytics() {
  const apiFetch = useApi()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')

  useEffect(() => { load('') }, [])

  const load = async (url) => {
    setLoading(true)
    const res = await apiFetch(url || '/api/crewfit/analytics')
    setData(res && !res.error ? res : null)
    setLoading(false)
  }
  const applyFilter = (s, e) => { setStartDate(s); setEndDate(e); load(`/api/crewfit/analytics?startDate=${s}&endDate=${e}`) }
  const clearFilter = () => { setStartDate(''); setEndDate(''); load('/api/crewfit/analytics') }

  if (loading) return <div className="loader"><div className="spinner" /><span>Loading dashboard…</span></div>
  if (!data) return <div className="empty-state"><Icon name="dashboard" size={44} /><p>No data available yet</p></div>

  const k = data.kpis || {}
  // Server is the authority and omits the money fields entirely; default to hidden so a slow
  // load never flashes them. Operational KPIs (orders, customers, timing) are unaffected.
  const showRevenue = data.canViewRevenue === true
  const kpis = [
    ...(showRevenue ? [
      { icon: 'wallet', label: 'Total Revenue', value: fmt(k.totalRevenue), trend: `${fmt(k.collectedRevenue)} collected`, cls: 'up' },
      { icon: 'card', label: 'Pending Collections', value: fmt(k.pendingRevenue), trend: k.totalRevenue ? `${((k.pendingRevenue / k.totalRevenue) * 100).toFixed(0)}% outstanding` : '—', cls: 'neutral' },
    ] : []),
    // Orders alone hide the size of the book — 12 orders can be 20 pieces or 2,000 — so the unit
    // count rides in this card rather than taking one of its own.
    { icon: 'box', label: 'Total Orders', value: k.totalOrders ?? 0, sub: `${(k.totalUnits ?? 0).toLocaleString('en-IN')} units`, trend: `${k.activeOrders ?? 0} active`, cls: 'neutral' },
    ...(showRevenue ? [{ icon: 'trending', label: 'Avg Order Value', value: fmt(k.avgOrderValue), trend: 'per order', cls: 'neutral' }] : []),
    { icon: 'users', label: 'Total Customers', value: k.totalCustomers ?? 0, trend: `${k.repeatCustomers ?? 0} repeat`, cls: 'neutral' },
    { icon: 'activity', label: 'Repeat Customer Rate', value: pct(k.repeatRate), trend: 'retention', cls: 'up' },
    { icon: 'clock', label: 'Avg Fulfillment Time', value: k.avgFulfillmentDays != null ? `${k.avgFulfillmentDays.toFixed(1)}d` : '—', trend: 'order → dispatch', cls: 'neutral' },
    { icon: 'truck', label: 'On-Time Delivery', value: pct(k.onTimeRate), trend: 'vs deadline', cls: 'up' },
  ]

  const statusRows = (data.statusBreakdown || []).map(s => ({ ...s, label: s.status }))
  const paymentRows = (data.paymentBreakdown || []).map(p => ({ ...p, label: p.status }))
  const typeRows = (data.customerTypeBreakdown || []).map(t => ({ ...t, label: t.type }))
  const bucketRows = data.fulfillmentBuckets || []
  const hasRevenue = (data.revenueSeries || []).some(d => d.revenue > 0)

  return (
    <div className="page-enter">
      <div className="dash-toolbar">
        <div><h1>Crewfit · Dashboard</h1><p style={{ color: 'var(--text-muted)' }}>{showRevenue ? 'Revenue, delivery time, customers & retention' : 'Orders, delivery time, customers & retention'}</p></div>
        <DateRangeFilter startDate={startDate} endDate={endDate} onApply={applyFilter} onClear={clearFilter} />
      </div>

      <div className="kpi-grid">
        {kpis.map((kk, i) => (
          <div className="kpi-card" key={i}>
            <div className="kpi-head"><div className="kpi-icon"><Icon name={kk.icon} size={22} /></div><span className={`kpi-trend ${kk.cls}`}>{kk.trend}</span></div>
            <div className="kpi-value">{kk.value}{kk.sub && <span className="kpi-sub">{kk.sub}</span>}</div>
            <div className="kpi-label">{kk.label}</div>
          </div>
        ))}
      </div>

      <div className="dash-row charts">
        {showRevenue && (
          <div className="panel">
            <div className="panel-head"><div><div className="panel-title">Revenue Trend</div><div className="panel-sub">{startDate && endDate ? 'Selected range' : 'Last 30 days'}</div></div></div>
            <div className="panel-body">
              {hasRevenue ? <AreaChart data={data.revenueSeries} fmt={fmt} /> : <div className="chart-empty">No revenue data for this range</div>}
            </div>
          </div>
        )}
        <div className="panel">
          <div className="panel-head"><div className="panel-title">Order Status</div></div>
          <div className="panel-body">
            {statusRows.length ? <BarList rows={statusRows} colorFor={r => STATUS_COLORS[r.status] || 'var(--primary)'} /> : <div className="empty-state" style={{ padding: '30px 0' }}>No orders yet</div>}
          </div>
        </div>
      </div>

      <div className="dash-row tables">
        <div className="panel">
          <div className="panel-head"><div className="panel-title">Delivery Time</div><span className="panel-sub">order date → dispatch</span></div>
          <div className="panel-body">
            {bucketRows.some(b => b.count > 0) ? <BarList rows={bucketRows} colorFor={(r, i) => BUCKET_COLORS[i] || 'var(--primary)'} /> : <div className="empty-state" style={{ padding: '30px 0' }}>No dispatched orders yet</div>}
          </div>
        </div>
        <div className="panel">
          <div className="panel-head"><div className="panel-title">Payment Collection</div></div>
          <div className="panel-body">
            {paymentRows.length ? <BarList rows={paymentRows} colorFor={r => PAYMENT_COLORS[r.status] || 'var(--primary)'} /> : <div className="empty-state" style={{ padding: '30px 0' }}>No orders yet</div>}
          </div>
        </div>
      </div>

      <div className="dash-row tables">
        <div className="panel">
          <div className="panel-head"><div className="panel-title">Customer Retention</div><span className="panel-sub">new vs returning</span></div>
          <div className="panel-body">
            {typeRows.length ? <BarList rows={typeRows} colorFor={r => TYPE_COLORS[r.type] || 'var(--primary)'} /> : <div className="empty-state" style={{ padding: '30px 0' }}>No orders yet</div>}
          </div>
        </div>
        <div className="panel">
          <div className="panel-head"><div className="panel-title">Sales Officer Performance</div></div>
          <table className="data-table">
            <thead><tr><th>SO</th><th style={{ textAlign: 'center' }}>Orders</th>{showRevenue && <th style={{ textAlign: 'right' }}>Revenue</th>}<th style={{ textAlign: 'right' }}>Avg Days</th></tr></thead>
            <tbody>
              {(data.soPerformance || []).map((s, i) => (
                <tr key={i}>
                  <td className="cell-primary" style={{ fontWeight: 600 }}>{s.so}</td>
                  <td data-label="Orders" style={{ textAlign: 'center' }}>{s.orders}</td>
                  {showRevenue && <td data-label="Revenue" style={{ textAlign: 'right', fontWeight: 700, color: 'var(--success)' }}>{fmt(s.revenue)}</td>}
                  <td data-label="Avg days" style={{ textAlign: 'right', color: 'var(--text-muted)' }}>{s.avgFulfillmentDays != null ? `${s.avgFulfillmentDays}d` : '—'}</td>
                </tr>
              ))}
              {!(data.soPerformance || []).length && emptyRow(showRevenue ? 4 : 3)}
            </tbody>
          </table>
        </div>
      </div>

      <div className="dash-row tables">
        <div className="panel">
          <div className="panel-head"><div className="panel-title">Top Products</div><span className="panel-sub">{showRevenue ? 'by revenue' : 'by units sold'}</span></div>
          <div className="panel-body">
            {(data.topProducts || []).length ? <TopProductsChart products={data.topProducts} showRevenue={showRevenue} /> : <div className="empty-state" style={{ padding: '30px 0' }}>No data yet</div>}
          </div>
        </div>
        <div className="panel">
          <div className="panel-head"><div className="panel-title">Top Customers</div><span className="panel-sub">{showRevenue ? 'by spend' : 'by order count'}</span></div>
          <table className="data-table">
            <thead><tr><th>Customer</th><th style={{ textAlign: 'center' }}>Orders</th>{showRevenue && <th style={{ textAlign: 'right' }}>Spent</th>}</tr></thead>
            <tbody>
              {(data.topCustomers || []).map((c, i) => (
                <tr key={i}>
                  <td className="cell-primary"><div style={{ fontWeight: 600 }}>{c.customer_name || '—'}</div><div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{c.contact_number}</div></td>
                  <td data-label="Orders" style={{ textAlign: 'center', fontWeight: 600 }}>{c.orders}</td>
                  {showRevenue && <td data-label="Revenue" style={{ textAlign: 'right', fontWeight: 700, color: 'var(--success)' }}>{fmt(c.revenue)}</td>}
                </tr>
              ))}
              {!(data.topCustomers || []).length && emptyRow(showRevenue ? 3 : 2)}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
