import { useState, useEffect } from 'react'
import { useApi } from '../App'

export default function Orders() {
  const apiFetch = useApi()
  const [orders, setOrders] = useState([])
  const [pagination, setPagination] = useState({})
  const [search, setSearch] = useState('')
  const [financialFilter, setFinancialFilter] = useState('')
  const [fulfillmentFilter, setFulfillmentFilter] = useState('')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [expandedOrder, setExpandedOrder] = useState(null)

  useEffect(() => {
    loadOrders()
  }, [page, search, financialFilter, fulfillmentFilter])

  const loadOrders = async () => {
    setLoading(true)
    const params = new URLSearchParams({
      page, limit: 20, search,
      ...(financialFilter && { financial_status: financialFilter }),
      ...(fulfillmentFilter && { fulfillment_status: fulfillmentFilter }),
    })
    const result = await apiFetch(`/api/orders?${params}`)
    if (result) {
      setOrders(result.orders)
      setPagination(result.pagination)
    }
    setLoading(false)
  }

  const formatCurrency = (val) => new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 0
  }).format(val || 0)

  const formatDate = (d) => d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '-'

  let searchTimeout
  const handleSearch = (val) => {
    clearTimeout(searchTimeout)
    searchTimeout = setTimeout(() => {
      setSearch(val)
      setPage(1)
    }, 400)
  }

  const getStatusClass = (status) => {
    if (!status) return 'unfulfilled'
    const s = status.toLowerCase()
    if (s.includes('paid') || s.includes('fulfill')) return 'fulfilled'
    if (s.includes('pending') || s.includes('unfulfill')) return 'unfulfilled'
    if (s.includes('refund') || s.includes('cancel') || s.includes('void')) return 'refunded'
    if (s.includes('partial')) return 'partial'
    return 'pending'
  }

  const toggleExpand = (orderId) => {
    setExpandedOrder(expandedOrder === orderId ? null : orderId)
  }

  return (
    <div className="page-enter">
      <div className="page-header">
        <h1>Orders</h1>
        <p>{pagination.total || 0} total orders synced from Shopify</p>
      </div>

      {/* Filters */}
      <div className="filters-row">
        <div className="search-bar">
          <span className="search-icon">🔍</span>
          <input type="search" placeholder="Search by order number..." onChange={e => handleSearch(e.target.value)} />
        </div>
        <select value={financialFilter} onChange={e => { setFinancialFilter(e.target.value); setPage(1) }}>
          <option value="">All Payment Status</option>
          <option value="PAID">Paid</option>
          <option value="PENDING">Pending</option>
          <option value="REFUNDED">Refunded</option>
          <option value="PARTIALLY_REFUNDED">Partially Refunded</option>
          <option value="VOIDED">Voided</option>
        </select>
        <select value={fulfillmentFilter} onChange={e => { setFulfillmentFilter(e.target.value); setPage(1) }}>
          <option value="">All Fulfillment</option>
          <option value="FULFILLED">Fulfilled</option>
          <option value="UNFULFILLED">Unfulfilled</option>
          <option value="PARTIALLY_FULFILLED">Partially Fulfilled</option>
        </select>
      </div>

      {/* Table */}
      <div className="data-table-wrapper">
        {loading ? (
          <div className="loader"><div className="spinner"></div></div>
        ) : orders.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">📦</div>
            <h3>No orders found</h3>
            <p>Try adjusting your filters or sync data from Settings.</p>
          </div>
        ) : (
          <>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Customer</th>
                  <th>Date</th>
                  <th>Payment</th>
                  <th>Fulfillment</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {orders.map(o => (
                  <>
                    <tr key={o.id} onClick={() => toggleExpand(o.id)}>
                      <td style={{ fontWeight: 600, color: 'var(--primary-light)' }}>{o.order_number}</td>
                      <td>
                        <div style={{ fontWeight: 500 }}>{o.first_name || ''} {o.last_name || ''}</div>
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{o.customer_email || ''}</div>
                      </td>
                      <td style={{ color: 'var(--text-secondary)' }}>{formatDate(o.created_at)}</td>
                      <td>
                        <span className={`status-badge ${getStatusClass(o.financial_status)}`}>
                          {o.financial_status || 'Unknown'}
                        </span>
                      </td>
                      <td>
                        <span className={`status-badge ${getStatusClass(o.fulfillment_status)}`}>
                          {o.fulfillment_status || 'Unfulfilled'}
                        </span>
                      </td>
                      <td style={{ fontWeight: 700 }}>{formatCurrency(o.total_price)}</td>
                    </tr>
                    {expandedOrder === o.id && o.line_items_json && (
                      <tr key={`${o.id}-details`}>
                        <td colSpan="6" style={{ padding: '0 20px 16px', background: 'var(--surface)' }}>
                          <div style={{ padding: '16px', borderRadius: 'var(--radius-md)', background: 'var(--bg-secondary)' }}>
                            <h4 style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '12px' }}>Line Items</h4>
                            {JSON.parse(o.line_items_json).map((item, idx) => (
                              <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: idx < JSON.parse(o.line_items_json).length - 1 ? '1px solid var(--border)' : 'none' }}>
                                <div>
                                  <span style={{ fontWeight: 500 }}>{item.title}</span>
                                  {item.variant && item.variant !== 'Default Title' && (
                                    <span style={{ color: 'var(--text-muted)', fontSize: '12px', marginLeft: '8px' }}>({item.variant})</span>
                                  )}
                                </div>
                                <div style={{ color: 'var(--text-secondary)' }}>
                                  {item.quantity} × {formatCurrency(parseFloat(item.price))}
                                </div>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>

            {/* Pagination */}
            {pagination.totalPages > 1 && (
              <div className="pagination">
                <button disabled={page <= 1} onClick={() => setPage(p => p - 1)}>‹</button>
                {Array.from({ length: Math.min(pagination.totalPages, 7) }, (_, i) => {
                  const p = i + 1
                  return (
                    <button key={p} className={page === p ? 'active' : ''} onClick={() => setPage(p)}>{p}</button>
                  )
                })}
                {pagination.totalPages > 7 && <button disabled>...</button>}
                <button disabled={page >= pagination.totalPages} onClick={() => setPage(p => p + 1)}>›</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
