import { useState, useEffect } from 'react'
import { useApi, useAuth } from '../App'

export default function AdminManagement() {
  const apiFetch = useApi()
  const { user } = useAuth()
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [editingUser, setEditingUser] = useState(null)
  const [stats, setStats] = useState(null)

  // Form state
  const [formData, setFormData] = useState({
    username: '',
    password: '',
    role: 'operator',
    permissions: {
      dashboard: true,
      customers: true,
      orders: true,
      scanner: true,
      sync: false
    }
  })

  useEffect(() => {
    loadUsers()
    loadStats()
  }, [])

  const loadUsers = async () => {
    setLoading(true)
    const result = await apiFetch('/api/admin/users')
    if (result && !result.error) {
      setUsers(result)
    }
    setLoading(false)
  }

  const loadStats = async () => {
    const result = await apiFetch('/api/admin/stats')
    if (result) setStats(result)
  }

  const handleCreateUser = async () => {
    if (!formData.username || !formData.password) {
      alert('Username and password required')
      return
    }

    const result = await apiFetch('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify(formData)
    })

    if (result?.success) {
      setFormData({
        username: '',
        password: '',
        role: 'operator',
        permissions: {
          dashboard: true,
          customers: true,
          orders: true,
          scanner: true,
          sync: false
        }
      })
      setShowCreateForm(false)
      loadUsers()
      loadStats()
    }
  }

  const handleUpdateUser = async (userId, updates) => {
    const result = await apiFetch(`/api/admin/users/${userId}`, {
      method: 'PUT',
      body: JSON.stringify(updates)
    })

    if (result?.success) {
      loadUsers()
      setEditingUser(null)
    }
  }

  const handleDeleteUser = async (userId) => {
    if (confirm('Are you sure? This cannot be undone.')) {
      const result = await apiFetch(`/api/admin/users/${userId}`, {
        method: 'DELETE'
      })

      if (result?.success) {
        loadUsers()
        loadStats()
      }
    }
  }

  const handlePermissionChange = (permission, value) => {
    setFormData({
      ...formData,
      permissions: {
        ...formData.permissions,
        [permission]: value
      }
    })
  }

  return (
    <div className="page-enter">
      <div className="admin-header">
        <div className="admin-header-icon">⚙️</div>
        <div className="admin-header-content">
          <h2>Admin Management</h2>
          <p>Manage users, permissions, and system settings</p>
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid-3" style={{ marginBottom: '24px' }}>
          <div className="glass-card" style={{ textAlign: 'center', padding: '20px' }}>
            <div style={{ fontSize: '28px', fontWeight: '700', color: 'var(--primary)', marginBottom: '8px' }}>
              {stats.totalUsers}
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Total Users</div>
          </div>
          <div className="glass-card" style={{ textAlign: 'center', padding: '20px' }}>
            <div style={{ fontSize: '28px', fontWeight: '700', color: 'var(--success)', marginBottom: '8px' }}>
              {stats.activeUsers}
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Active Users</div>
          </div>
          <div className="glass-card" style={{ textAlign: 'center', padding: '20px' }}>
            <div style={{ fontSize: '28px', fontWeight: '700', color: 'var(--info)', marginBottom: '8px' }}>
              {stats.operators}
            </div>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Operators</div>
          </div>
        </div>
      )}

      {/* Create User Form */}
      {showCreateForm && (
        <div className="glass-card" style={{ marginBottom: '24px' }}>
          <h3 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '16px' }}>➕ Create New User</h3>

          <div className="form-row">
            <div className="input-group" style={{ marginBottom: 0 }}>
              <label>Username</label>
              <input
                type="text"
                value={formData.username}
                onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                placeholder="Enter username"
              />
            </div>
            <div className="input-group" style={{ marginBottom: 0 }}>
              <label>Password</label>
              <input
                type="password"
                value={formData.password}
                onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                placeholder="Enter password"
              />
            </div>
          </div>

          <div className="form-row">
            <div className="input-group" style={{ marginBottom: 0 }}>
              <label>Role</label>
              <select
                value={formData.role}
                onChange={(e) => setFormData({ ...formData, role: e.target.value })}
              >
                <option value="operator">Operator (Limited Access)</option>
                <option value="admin">Admin (Full Access)</option>
              </select>
            </div>
          </div>

          <div style={{ marginBottom: '16px' }}>
            <h4 style={{ fontSize: '13px', fontWeight: '600', marginBottom: '12px', color: 'var(--text-secondary)' }}>
              Permissions
            </h4>
            {['dashboard', 'customers', 'orders', 'scanner', 'sync'].map((perm) => (
              <div key={perm} className="permission-item">
                <input
                  type="checkbox"
                  className="permission-checkbox"
                  checked={formData.permissions[perm] || false}
                  onChange={(e) => handlePermissionChange(perm, e.target.checked)}
                  id={`perm-${perm}`}
                />
                <label htmlFor={`perm-${perm}`} className="permission-label" style={{ marginBottom: 0 }}>
                  {perm.charAt(0).toUpperCase() + perm.slice(1).replace('scanner', 'Barcode Scanner')}
                </label>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: '12px' }}>
            <button className="btn btn-primary btn-sm" onClick={handleCreateUser}>
              ✅ Create User
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => setShowCreateForm(false)}>
              ❌ Cancel
            </button>
          </div>
        </div>
      )}

      {/* Create Button */}
      {!showCreateForm && (
        <button
          className="btn btn-primary"
          onClick={() => setShowCreateForm(true)}
          style={{ marginBottom: '24px' }}
        >
          ➕ Create New User
        </button>
      )}

      {/* Users List */}
      <div className="glass-card">
        <h3 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '16px' }}>👥 Users</h3>

        {loading ? (
          <div className="loader"><div className="spinner"></div></div>
        ) : users.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
            No users found
          </div>
        ) : (
          <div className="user-list">
            {users.map((u) => (
              <div key={u.id} className="user-card">
                <div className="user-card-info">
                  <div className="user-card-avatar">{u.username.charAt(0).toUpperCase()}</div>
                  <div className="user-card-details">
                    <h4>{u.username}</h4>
                    <p>
                      Role: <strong>{u.role}</strong> • Last login: {u.last_login ? new Date(u.last_login).toLocaleDateString() : 'Never'}
                    </p>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <div className="user-card-status">
                    <span
                      className={u.is_active ? 'status-active' : 'status-inactive'}
                    >
                      {u.is_active ? '✅ Active' : '🔴 Inactive'}
                    </span>
                  </div>
                  <div className="user-card-actions">
                    <button
                      className="btn-icon"
                      onClick={() => setEditingUser(u.id)}
                      title="Edit"
                    >
                      ✏️
                    </button>
                    {u.id !== user.id && (
                      <button
                        className="btn-icon"
                        onClick={() => handleDeleteUser(u.id)}
                        title="Delete"
                        style={{ color: 'var(--danger)' }}
                      >
                        🗑️
                      </button>
                    )}
                  </div>
                </div>

                {/* Edit Panel */}
                {editingUser === u.id && (
                  <div style={{ gridColumn: '1/-1', padding: '12px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', marginTop: '12px' }}>
                    <h4 style={{ fontSize: '13px', marginBottom: '12px' }}>Edit User</h4>

                    <div style={{ marginBottom: '12px' }}>
                      <label style={{ fontSize: '12px' }}>Status</label>
                      <select
                        value={u.is_active ? '1' : '0'}
                        onChange={(e) => handleUpdateUser(u.id, { is_active: e.target.value === '1' })}
                        style={{ width: '100%', padding: '8px', borderRadius: 'var(--radius-sm)' }}
                      >
                        <option value="1">Active</option>
                        <option value="0">Inactive</option>
                      </select>
                    </div>

                    <div style={{ marginBottom: '12px' }}>
                      <label style={{ fontSize: '12px' }}>Permissions</label>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
                        {['dashboard', 'customers', 'orders', 'scanner', 'sync'].map((perm) => (
                          <label key={perm} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', cursor: 'pointer' }}>
                            <input
                              type="checkbox"
                              checked={u[`can_view_${perm}` === 'can_view_scanner' ? 'can_scan_orders' : perm === 'sync' ? 'can_sync_data' : `can_view_${perm}`] || false}
                              onChange={(e) => {
                                const permKey = perm === 'scanner' ? 'can_scan_orders' : perm === 'sync' ? 'can_sync_data' : `can_view_${perm}`
                                handleUpdateUser(u.id, { permissions: { [permKey]: e.target.checked } })
                              }}
                            />
                            {perm.charAt(0).toUpperCase() + perm.slice(1)}
                          </label>
                        ))}
                      </div>
                    </div>

                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => setEditingUser(null)}
                    >
                      Done
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
