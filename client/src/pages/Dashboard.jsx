import { useState, useEffect } from 'react'
import { useApi } from '../App'

export default function Dashboard() {
  const apiFetch = useApi()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')

  useEffect(() => {
    loadDashboard('')
  }, [])

  const loadDashboard = async (url) => {
    setLoading(true)
    setError(null)
    try {
      const finalUrl = url || '/api/dashboard'
      const result = await apiFetch(finalUrl)
      setData(result || null)
      if (result?.error) setError(result.error)
    } catch (err) {
      setError('Error loading dashboard')
    }
    setLoading(false)
  }

  const applyFilter = () => {
    if (startDate && endDate) {
      loadDashboard(`/api/dashboard?startDate=${startDate}&endDate=${endDate}`)
    }
  }

  const clearFilter = () => {
    setStartDate('')
    setEndDate('')
    loadDashboard('/api/dashboard')
  }

  const fmt = (val) => {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0 }).format(val || 0)
  }

  const shortNum = (val) => {
    if (val >= 1000000) return (val / 1000000).toFixed(1) + 'M'
    if (val >= 1000) return (val / 1000).toFixed(1) + 'K'
    return val.toString()
  }

  if (loading) return <div style={{ padding: '40px', color: 'var(--text-muted)', textAlign: 'center' }}>Loading dashboard...</div>
  if (error) return <div style={{ padding: '40px', background: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: '8px' }}>Error: {error}</div>
  if (!data?.metrics) return <div style={{ padding: '40px', textAlign: 'center' }}>No data available</div>

  const m = data.metrics
  const daily = data.dailyRevenue || []
  const maxRev = daily.length > 0 ? Math.max(...daily.map(d => d.revenue)) : 1

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: '28px' }}>
        <h1 style={{ fontSize: '32px', fontWeight: '700', marginBottom: '8px' }}>Dashboard</h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>Real-time analytics & insights</p>
      </div>

      {/* Date Filter */}
      <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: '12px', padding: '20px', marginBottom: '28px', display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={{ padding: '8px 12px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '13px' }} />
        <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} style={{ padding: '8px 12px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '13px' }} />
        <button onClick={applyFilter} disabled={!startDate || !endDate} style={{ padding: '8px 20px', background: startDate && endDate ? 'var(--primary)' : 'rgba(99,102,241,0.3)', color: 'white', border: 'none', borderRadius: '6px', fontWeight: '600', cursor: startDate && endDate ? 'pointer' : 'not-allowed' }}>Apply</button>
        {startDate || endDate ? <button onClick={clearFilter} style={{ padding: '8px 16px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: '6px', cursor: 'pointer' }}>Clear</button> : null}
      </div>

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px', marginBottom: '28px' }}>
        <div style={{ background: 'var(--bg-secondary)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: '12px', padding: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
            <span style={{ fontSize: '28px' }}>📦</span>
            <span style={{ background: 'var(--success-bg)', color: 'var(--success)', padding: '3px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: '600' }}>+{m.ordersThisMonth}</span>
          </div>
          <div style={{ fontSize: '32px', fontWeight: '700', marginBottom: '4px' }}>{shortNum(m.totalOrders)}</div>
          <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Total Orders</div>
        </div>

        <div style={{ background: 'var(--bg-secondary)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: '12px', padding: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
            <span style={{ fontSize: '28px' }}>💰</span>
            <span style={{ background: 'var(--success-bg)', color: 'var(--success)', padding: '3px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: '600' }}>{fmt(m.revenueThisMonth)}</span>
          </div>
          <div style={{ fontSize: '28px', fontWeight: '700', marginBottom: '4px' }}>{fmt(m.totalRevenue)}</div>
          <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Total Revenue</div>
        </div>

        <div style={{ background: 'var(--bg-secondary)', border: '1px solid rgba(59,130,246,0.3)', borderRadius: '12px', padding: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
            <span style={{ fontSize: '28px' }}>👥</span>
            <span style={{ background: 'var(--success-bg)', color: 'var(--success)', padding: '3px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: '600' }}>+{m.newCustomersThisMonth}</span>
          </div>
          <div style={{ fontSize: '32px', fontWeight: '700', marginBottom: '4px' }}>{shortNum(m.totalCustomers)}</div>
          <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Total Customers</div>
        </div>

        <div style={{ background: 'var(--bg-secondary)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: '12px', padding: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
            <span style={{ fontSize: '28px' }}>📈</span>
            <span style={{ background: 'var(--info-bg)', color: 'var(--info)', padding: '3px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: '600' }}>Avg</span>
          </div>
          <div style={{ fontSize: '28px', fontWeight: '700', marginBottom: '4px' }}>{fmt(m.avgOrderValue)}</div>
          <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Avg Order Value</div>
        </div>
      </div>

      {/* Charts */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '20px', marginBottom: '28px' }}>
        {/* Revenue Chart */}
        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: '12px', padding: '24px' }}>
          <h3 style={{ marginBottom: '16px' }}>Revenue Trend</h3>
          {daily.length > 0 ? (
            <div style={{ display: 'flex', alignItems: 'flex-end', height: '240px', gap: '2px' }}>
              {daily.map((d, i) => (
                <div key={i} style={{ flex: 1, height: `${maxRev > 0 ? (d.revenue / maxRev) * 100 : 1}%`, minHeight: '2px', background: 'linear-gradient(to top, #6366f1, #818cf8)', borderRadius: '2px 2px 0 0', cursor: 'pointer' }} title={`${d.date}: ${fmt(d.revenue)}`} onMouseEnter={(e) => e.target.style.opacity = '0.7'} onMouseLeave={(e) => e.target.style.opacity = '1'} />
              ))}
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>No data</div>
          )}
        </div>

        {/* Order Status */}
        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: '12px', padding: '24px' }}>
          <h3 style={{ marginBottom: '16px' }}>Order Status</h3>
          {data.statusBreakdown && data.statusBreakdown.length > 0 ? (
            <div>
              {data.statusBreakdown.map((s, i) => {
                const t = data.statusBreakdown.reduce((sum, x) => sum + x.count, 0)
                const pct = ((s.count / t) * 100).toFixed(1)
                const colors = ['#6366f1', '#10b981', '#f59e0b', '#ef4444']
                return (
                  <div key={i} style={{ marginBottom: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '4px' }}>
                      <span>{s.fulfillment_status || 'Unknown'}</span>
                      <span>{pct}%</span>
                    </div>
                    <div style={{ height: '6px', background: 'var(--surface)', borderRadius: '3px', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${pct}%`, background: colors[i % colors.length], borderRadius: '3px' }} />
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div style={{ color: 'var(--text-muted)' }}>No status data</div>
          )}
        </div>
      </div>

      {/* Tables */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
        {/* Top Customers */}
        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden' }}>
          <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)' }}>
            <h3>Top Customers</h3>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={{ padding: '12px 16px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--text-muted)' }}>Name</th>
                <th style={{ padding: '12px 16px', textAlign: 'center', fontSize: '12px', fontWeight: '600', color: 'var(--text-muted)' }}>Orders</th>
                <th style={{ padding: '12px 16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: 'var(--text-muted)' }}>Spent</th>
              </tr>
            </thead>
            <tbody>
              {data.topCustomers && data.topCustomers.slice(0, 8).map((c, i) => (
                <tr key={c.id} style={{ borderBottom: '1px solid var(--border)', background: i % 2 === 0 ? '' : 'rgba(0,0,0,0.1)' }}>
                  <td style={{ padding: '12px 16px', fontSize: '13px' }}>{c.first_name} {c.last_name}</td>
                  <td style={{ padding: '12px 16px', textAlign: 'center', fontSize: '13px', fontWeight: '600' }}>{c.orders_count}</td>
                  <td style={{ padding: '12px 16px', textAlign: 'right', fontSize: '13px', fontWeight: '600', color: 'var(--success)' }}>{fmt(c.total_spent)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Recent Orders */}
        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden' }}>
          <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border)' }}>
            <h3>Recent Orders</h3>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={{ padding: '12px 16px', textAlign: 'left', fontSize: '12px', fontWeight: '600', color: 'var(--text-muted)' }}>Order</th>
                <th style={{ padding: '12px 16px', textAlign: 'center', fontSize: '12px', fontWeight: '600', color: 'var(--text-muted)' }}>Status</th>
                <th style={{ padding: '12px 16px', textAlign: 'right', fontSize: '12px', fontWeight: '600', color: 'var(--text-muted)' }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {data.recentOrders && data.recentOrders.slice(0, 8).map((o, i) => (
                <tr key={o.id} style={{ borderBottom: '1px solid var(--border)', background: i % 2 === 0 ? '' : 'rgba(0,0,0,0.1)' }}>
                  <td style={{ padding: '12px 16px', fontSize: '13px', fontWeight: '600' }}>{o.order_number}</td>
                  <td style={{ padding: '12px 16px', textAlign: 'center' }}>
                    <span style={{ background: o.fulfillment_status?.toLowerCase().includes('fulfilled') ? 'var(--success-bg)' : 'var(--warning-bg)', color: o.fulfillment_status?.toLowerCase().includes('fulfilled') ? 'var(--success)' : 'var(--warning)', padding: '2px 8px', borderRadius: '3px', fontSize: '11px', fontWeight: '600' }}>
                      {o.fulfillment_status || 'Pending'}
                    </span>
                  </td>
                  <td style={{ padding: '12px 16px', textAlign: 'right', fontSize: '13px', fontWeight: '600' }}>{fmt(o.total_price)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
