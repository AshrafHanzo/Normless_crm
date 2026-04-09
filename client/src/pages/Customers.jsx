import { useState, useEffect } from 'react'
import { useApi } from '../App'

export default function Customers() {
  const apiFetch = useApi()
  const [customers, setCustomers] = useState([])
  const [pagination, setPagination] = useState({})
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [priorityFilter, setPriorityFilter] = useState('')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [selectedCustomer, setSelectedCustomer] = useState(null)
  const [customerDetail, setCustomerDetail] = useState(null)
  const [drawerLoading, setDrawerLoading] = useState(false)

  // Interaction form
  const [interactionType, setInteractionType] = useState('note')
  const [interactionContent, setInteractionContent] = useState('')

  // Edit CRM fields
  const [editStatus, setEditStatus] = useState('')
  const [editPriority, setEditPriority] = useState('')
  const [editNotes, setEditNotes] = useState('')

  useEffect(() => {
    loadCustomers()
  }, [page, search, statusFilter, priorityFilter])

  const loadCustomers = async () => {
    setLoading(true)
    const params = new URLSearchParams({
      page, limit: 20, search,
      ...(statusFilter && { status: statusFilter }),
      ...(priorityFilter && { priority: priorityFilter }),
    })
    const result = await apiFetch(`/api/customers?${params}`)
    if (result) {
      setCustomers(result.customers)
      setPagination(result.pagination)
    }
    setLoading(false)
  }

  const openDetail = async (customer) => {
    setSelectedCustomer(customer)
    setDrawerLoading(true)
    const result = await apiFetch(`/api/customers/${customer.id}`)
    if (result) {
      setCustomerDetail(result)
      setEditStatus(result.customer.crm_status || 'Lead')
      setEditPriority(result.customer.crm_priority || 'Medium')
      setEditNotes(result.customer.crm_notes || '')
    }
    setDrawerLoading(false)
  }

  const closeDetail = () => {
    setSelectedCustomer(null)
    setCustomerDetail(null)
  }

  const saveCustomerFields = async () => {
    if (!customerDetail) return
    await apiFetch(`/api/customers/${customerDetail.customer.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        crm_status: editStatus,
        crm_priority: editPriority,
        crm_notes: editNotes,
      }),
    })
    loadCustomers()
    openDetail(customerDetail.customer)
  }

  const addInteraction = async () => {
    if (!interactionContent.trim() || !customerDetail) return
    await apiFetch('/api/interactions', {
      method: 'POST',
      body: JSON.stringify({
        customer_id: customerDetail.customer.id,
        type: interactionType,
        content: interactionContent,
      }),
    })
    setInteractionContent('')
    openDetail(customerDetail.customer)
  }

  const deleteInteraction = async (id) => {
    await apiFetch(`/api/interactions/${id}`, { method: 'DELETE' })
    openDetail(customerDetail.customer)
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

  return (
    <div className="page-enter">
      <div className="page-header">
        <h1>Customers</h1>
        <p>{pagination.total || 0} total customers synced from Shopify</p>
      </div>

      {/* Filters */}
      <div className="filters-row">
        <div className="search-bar">
          <span className="search-icon">🔍</span>
          <input type="search" placeholder="Search by name, email, or phone..." onChange={e => handleSearch(e.target.value)} />
        </div>
        <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(1) }}>
          <option value="">All Statuses</option>
          <option value="Lead">Lead</option>
          <option value="Active">Active</option>
          <option value="VIP">VIP</option>
          <option value="Inactive">Inactive</option>
        </select>
        <select value={priorityFilter} onChange={e => { setPriorityFilter(e.target.value); setPage(1) }}>
          <option value="">All Priorities</option>
          <option value="High">High</option>
          <option value="Medium">Medium</option>
          <option value="Low">Low</option>
        </select>
      </div>

      {/* Table */}
      <div className="data-table-wrapper">
        {loading ? (
          <div className="loader"><div className="spinner"></div></div>
        ) : customers.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">👥</div>
            <h3>No customers found</h3>
            <p>Try adjusting your search or sync data from Settings.</p>
          </div>
        ) : (
          <>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Phone</th>
                  <th>Orders</th>
                  <th>Total Spent</th>
                  <th>Status</th>
                  <th>Priority</th>
                </tr>
              </thead>
              <tbody>
                {customers.map(c => (
                  <tr key={c.id} onClick={() => openDetail(c)}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div className="avatar">{(c.first_name || '?').charAt(0).toUpperCase()}</div>
                        <div>
                          <div style={{ fontWeight: 600 }}>{c.first_name} {c.last_name}</div>
                          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{c.email}</div>
                        </div>
                      </div>
                    </td>
                    <td>{c.phone || '-'}</td>
                    <td>{c.orders_count}</td>
                    <td style={{ fontWeight: 600, color: 'var(--success)' }}>{formatCurrency(c.total_spent)}</td>
                    <td><span className={`status-badge ${(c.crm_status || '').toLowerCase()}`}>{c.crm_status || 'Lead'}</span></td>
                    <td><span className={`tag-chip`}>{c.crm_priority || 'Medium'}</span></td>
                  </tr>
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

      {/* Customer Detail Drawer */}
      {selectedCustomer && (
        <>
          <div className="drawer-overlay" onClick={closeDetail} />
          <div className="drawer">
            <div className="drawer-header">
              <h3>Customer Detail</h3>
              <button className="btn-icon" onClick={closeDetail}>✕</button>
            </div>

            {drawerLoading ? (
              <div className="loader"><div className="spinner"></div></div>
            ) : customerDetail && (
              <div className="drawer-body">
                {/* Customer Info */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '24px' }}>
                  <div className="avatar avatar-lg">{(customerDetail.customer.first_name || '?').charAt(0).toUpperCase()}</div>
                  <div>
                    <h2 style={{ fontSize: '20px', fontWeight: 700 }}>
                      {customerDetail.customer.first_name} {customerDetail.customer.last_name}
                    </h2>
                    <div style={{ color: 'var(--text-muted)', fontSize: '14px' }}>{customerDetail.customer.email}</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '14px' }}>{customerDetail.customer.phone || 'No phone'}</div>
                  </div>
                </div>

                {/* Quick Stats */}
                <div className="grid-3" style={{ marginBottom: '24px' }}>
                  <div className="glass-card" style={{ padding: '16px', textAlign: 'center' }}>
                    <div style={{ fontSize: '22px', fontWeight: 700, color: 'var(--success)' }}>{formatCurrency(customerDetail.customer.total_spent)}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Lifetime Value</div>
                  </div>
                  <div className="glass-card" style={{ padding: '16px', textAlign: 'center' }}>
                    <div style={{ fontSize: '22px', fontWeight: 700 }}>{customerDetail.customer.orders_count}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Orders</div>
                  </div>
                  <div className="glass-card" style={{ padding: '16px', textAlign: 'center' }}>
                    <div style={{ fontSize: '22px', fontWeight: 700, color: 'var(--primary-light)' }}>{customerDetail.customer.crm_priority || 'Med'}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Priority</div>
                  </div>
                </div>

                {/* CRM Fields */}
                <div className="glass-card" style={{ marginBottom: '24px' }}>
                  <h4 style={{ marginBottom: '16px', fontSize: '15px' }}>CRM Settings</h4>
                  <div className="grid-2" style={{ marginBottom: '12px' }}>
                    <div className="input-group" style={{ marginBottom: 0 }}>
                      <label>Status</label>
                      <select value={editStatus} onChange={e => setEditStatus(e.target.value)}>
                        <option>Lead</option><option>Active</option><option>VIP</option><option>Inactive</option>
                      </select>
                    </div>
                    <div className="input-group" style={{ marginBottom: 0 }}>
                      <label>Priority</label>
                      <select value={editPriority} onChange={e => setEditPriority(e.target.value)}>
                        <option>High</option><option>Medium</option><option>Low</option>
                      </select>
                    </div>
                  </div>
                  <div className="input-group">
                    <label>Notes</label>
                    <textarea value={editNotes} onChange={e => setEditNotes(e.target.value)} placeholder="Internal notes about this customer..." />
                  </div>
                  <button className="btn btn-primary btn-sm" onClick={saveCustomerFields}>Save Changes</button>
                </div>

                {/* Add Interaction */}
                <div className="glass-card" style={{ marginBottom: '24px' }}>
                  <h4 style={{ marginBottom: '16px', fontSize: '15px' }}>Log Interaction</h4>
                  <div className="input-group">
                    <label>Type</label>
                    <select value={interactionType} onChange={e => setInteractionType(e.target.value)}>
                      <option value="note">📝 Note</option>
                      <option value="call">📞 Call</option>
                      <option value="email">📧 Email</option>
                      <option value="whatsapp">💬 WhatsApp</option>
                      <option value="meeting">🤝 Meeting</option>
                    </select>
                  </div>
                  <div className="input-group">
                    <label>Content</label>
                    <textarea value={interactionContent} onChange={e => setInteractionContent(e.target.value)} placeholder="What happened?" />
                  </div>
                  <button className="btn btn-primary btn-sm" onClick={addInteraction}>Add Interaction</button>
                </div>

                {/* Interaction Timeline */}
                {customerDetail.interactions.length > 0 && (
                  <div style={{ marginBottom: '24px' }}>
                    <h4 style={{ marginBottom: '16px', fontSize: '15px' }}>Interaction History</h4>
                    <div className="timeline">
                      {customerDetail.interactions.map(int => (
                        <div key={int.id} className="timeline-item">
                          <div className="timeline-type">{int.type}</div>
                          <div className="timeline-content">{int.content}</div>
                          <div className="timeline-meta">
                            {formatDate(int.created_at)} • by {int.created_by || 'admin'}
                            <button className="btn-icon" style={{ width: '24px', height: '24px', fontSize: '12px', marginLeft: '8px', display: 'inline-flex' }}
                              onClick={() => deleteInteraction(int.id)}>🗑</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Order History */}
                {customerDetail.orders.length > 0 && (
                  <div>
                    <h4 style={{ marginBottom: '16px', fontSize: '15px' }}>Order History</h4>
                    {customerDetail.orders.map(o => (
                      <div key={o.id} className="glass-card" style={{ marginBottom: '8px', padding: '14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <div style={{ fontWeight: 600 }}>{o.order_number}</div>
                          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{formatDate(o.created_at)}</div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontWeight: 600, color: 'var(--success)' }}>{formatCurrency(o.total_price)}</div>
                          <span className={`status-badge ${(o.fulfillment_status || '').toLowerCase().includes('fulfill') ? 'fulfilled' : 'unfulfilled'}`} style={{ fontSize: '11px' }}>
                            {o.fulfillment_status || 'Unfulfilled'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
