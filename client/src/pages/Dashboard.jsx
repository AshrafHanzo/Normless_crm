import { useState, useEffect } from 'react'
import { useApi } from '../App'

export default function Dashboard() {
  const apiFetch = useApi()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadDashboard()
  }, [])

  const loadDashboard = async () => {
    setLoading(true)
    const result = await apiFetch('/api/dashboard')
    if (result) setData(result)
    setLoading(false)
  }

  const formatCurrency = (val) => {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(val || 0)
  }

  if (loading) {
    return (
      <div className="page-enter">
        <div className="page-header">
          <h1>Dashboard</h1>
          <p>Loading your store analytics...</p>
        </div>
        <div className="loader"><div className="spinner"></div></div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="page-enter">
        <div className="page-header">
          <h1>Dashboard</h1>
          <p>No data available. Please sync your Shopify data first from Settings.</p>
        </div>
      </div>
    )
  }

  const { metrics, topCustomers, recentOrders, statusBreakdown, dailyRevenue } = data
  const maxRevenue = dailyRevenue.length > 0 ? Math.max(...dailyRevenue.map(d => d.revenue)) : 1

  return (
    <div className="page-enter">
      <div className="page-header">
        <h1>Dashboard</h1>
        <p>Your Normless store at a glance</p>
      </div>

      {/* Metrics */}
      <div className="metrics-grid">
        <div className="metric-card">
          <div className="metric-icon" style={{ background: 'var(--primary-glow)', color: 'var(--primary-light)' }}>👥</div>
          <div className="metric-value">{metrics.totalCustomers.toLocaleString()}</div>
          <div className="metric-label">Total Customers</div>
          <div className="metric-change positive">+{metrics.newCustomersThisMonth} this month</div>
        </div>

        <div className="metric-card">
          <div className="metric-icon" style={{ background: 'var(--success-bg)', color: 'var(--success)' }}>📦</div>
          <div className="metric-value">{metrics.totalOrders.toLocaleString()}</div>
          <div className="metric-label">Total Orders</div>
          <div className="metric-change positive">+{metrics.ordersThisMonth} this month</div>
        </div>

        <div className="metric-card">
          <div className="metric-icon" style={{ background: 'var(--warning-bg)', color: 'var(--warning)' }}>💰</div>
          <div className="metric-value">{formatCurrency(metrics.totalRevenue)}</div>
          <div className="metric-label">Total Revenue</div>
          <div className="metric-change positive">{formatCurrency(metrics.revenueThisMonth)} this month</div>
        </div>

        <div className="metric-card">
          <div className="metric-icon" style={{ background: 'var(--info-bg)', color: 'var(--info)' }}>📈</div>
          <div className="metric-value">{formatCurrency(metrics.avgOrderValue)}</div>
          <div className="metric-label">Avg Order Value</div>
        </div>
      </div>

      {/* Charts + Top Customers */}
      <div className="grid-2" style={{ marginBottom: '20px' }}>
        {/* Revenue Chart */}
        <div className="data-table-wrapper">
          <div className="data-table-header">
            <h3>Revenue (Last 30 Days)</h3>
          </div>
          <div className="chart-container">
            {dailyRevenue.length > 0 ? (
              <div className="bar-chart">
                {dailyRevenue.map((d, i) => (
                  <div
                    key={i}
                    className="bar"
                    style={{ height: `${(d.revenue / maxRevenue) * 100}%` }}
                  >
                    <div className="bar-tooltip">
                      {d.date}: {formatCurrency(d.revenue)} ({d.order_count} orders)
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <p>No revenue data yet</p>
              </div>
            )}
          </div>
        </div>

        {/* Order Status Breakdown */}
        <div className="data-table-wrapper">
          <div className="data-table-header">
            <h3>Order Status</h3>
          </div>
          <div style={{ padding: '20px 24px' }}>
            {statusBreakdown.map((s, i) => {
              const total = statusBreakdown.reduce((sum, x) => sum + x.count, 0)
              const pct = total > 0 ? ((s.count / total) * 100).toFixed(1) : 0
              return (
                <div key={i} style={{ marginBottom: '16px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <span style={{ fontSize: '13px', fontWeight: 500 }}>{s.fulfillment_status || 'Unknown'}</span>
                    <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>{s.count} ({pct}%)</span>
                  </div>
                  <div style={{ height: '6px', background: 'var(--surface)', borderRadius: '3px', overflow: 'hidden' }}>
                    <div style={{
                      height: '100%',
                      width: `${pct}%`,
                      background: 'linear-gradient(90deg, var(--primary), var(--primary-light))',
                      borderRadius: '3px',
                      transition: 'width 0.5s ease'
                    }} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Tables */}
      <div className="grid-2">
        {/* Top Customers */}
        <div className="data-table-wrapper">
          <div className="data-table-header">
            <h3>Top Customers</h3>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Orders</th>
                <th>Total Spent</th>
              </tr>
            </thead>
            <tbody>
              {topCustomers.map(c => (
                <tr key={c.id}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <div className="avatar">
                        {(c.first_name || '?').charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: '14px' }}>
                          {c.first_name} {c.last_name}
                        </div>
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{c.email}</div>
                      </div>
                    </div>
                  </td>
                  <td>{c.orders_count}</td>
                  <td style={{ fontWeight: 600, color: 'var(--success)' }}>{formatCurrency(c.total_spent)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Recent Orders */}
        <div className="data-table-wrapper">
          <div className="data-table-header">
            <h3>Recent Orders</h3>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Status</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {recentOrders.map(o => (
                <tr key={o.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{o.order_number}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                      {o.first_name} {o.last_name}
                    </div>
                  </td>
                  <td>
                    <span className={`status-badge ${(o.fulfillment_status || '').toLowerCase().includes('fulfill') ? 'fulfilled' : 'unfulfilled'}`}>
                      {o.fulfillment_status || 'Unfulfilled'}
                    </span>
                  </td>
                  <td style={{ fontWeight: 600 }}>{formatCurrency(o.total_price)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
