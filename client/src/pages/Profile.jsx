import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth, useApi } from '../App'

export default function Profile() {
  const navigate = useNavigate()
  const { user, logout } = useAuth()
  const apiFetch = useApi()
  const [changePassword, setChangePassword] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [message, setMessage] = useState('')

  const handleChangePassword = async () => {
    if (!currentPassword || !newPassword || !confirmPassword) {
      setMessage('❌ All fields required')
      return
    }

    if (newPassword !== confirmPassword) {
      setMessage('❌ Passwords do not match')
      return
    }

    if (newPassword.length < 6) {
      setMessage('❌ Password must be at least 6 characters')
      return
    }

    const result = await apiFetch('/api/admin/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword })
    })

    if (result?.success) {
      setMessage('✅ Password changed successfully')
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setChangePassword(false)
    } else {
      setMessage('❌ ' + (result?.error || 'Failed to change password'))
    }
  }

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  const permissions = {
    dashboard: { name: 'Dashboard Access', icon: '📊', color: '#6366f1' },
    customers: { name: 'Customer Management', icon: '👥', color: '#8b5cf6' },
    orders: { name: 'Order Management', icon: '📦', color: '#ec4899' },
    scanner: { name: 'Barcode Scanner', icon: '🎯', color: '#f59e0b' },
    sync: { name: 'Data Synchronization', icon: '🔄', color: '#10b981' }
  }

  return (
    <div className="page-enter">
      {/* Header with gradient */}
      <div className="profile-header-advanced">
        <div className="profile-header-blur"></div>
        <div className="profile-header-content">
          <div className="profile-avatar-advanced">
            {user?.username?.charAt(0).toUpperCase() || 'A'}
          </div>
          <div className="profile-header-info">
            <h1>{user?.username || 'Administrator'}</h1>
            <p>System Administrator</p>
            <div className="profile-badges">
              <span className="badge-primary">👮 Full Access</span>
              <span className="badge-secondary">✅ Active</span>
            </div>
          </div>
        </div>
      </div>

      {/* Stats Row */}
      <div className="profile-stats-grid">
        <div className="profile-stat-card">
          <div className="stat-icon">🏢</div>
          <div className="stat-content">
            <div className="stat-label">Account Status</div>
            <div className="stat-value">Active</div>
          </div>
        </div>
        <div className="profile-stat-card">
          <div className="stat-icon">🔐</div>
          <div className="stat-content">
            <div className="stat-label">Security Level</div>
            <div className="stat-value">Maximum</div>
          </div>
        </div>
        <div className="profile-stat-card">
          <div className="stat-icon">✨</div>
          <div className="stat-content">
            <div className="stat-label">Session Status</div>
            <div className="stat-value">Online</div>
          </div>
        </div>
      </div>

      {/* Account Information */}
      <div className="glass-card profile-section">
        <div className="section-header">
          <h3>📋 Account Information</h3>
          <span className="section-badge">Personal</span>
        </div>
        <div className="account-info-grid">
          <div className="account-info-item">
            <label>Email Address</label>
            <div className="info-value">{user?.username || 'N/A'}</div>
          </div>
          <div className="account-info-item">
            <label>Account Type</label>
            <div className="info-value">Administrator</div>
          </div>
          <div className="account-info-item">
            <label>Status</label>
            <div className="info-value" style={{ color: 'var(--success)' }}>● Active</div>
          </div>
          <div className="account-info-item">
            <label>Member Since</label>
            <div className="info-value">January 2026</div>
          </div>
        </div>
      </div>

      {/* Permissions Grid */}
      <div className="glass-card profile-section">
        <div className="section-header">
          <h3>🔐 Access Permissions</h3>
          <span className="section-badge">5 Enabled</span>
        </div>
        <div className="permissions-grid-advanced">
          {Object.entries(permissions).map(([key, perm]) => (
            <div key={key} className="permission-card-advanced">
              <div className="permission-card-top">
                <div className="permission-card-icon-large">{perm.icon}</div>
                <div className="permission-badge-enabled">✅</div>
              </div>
              <div className="permission-card-name">{perm.name}</div>
              <div className="permission-card-description">Full access</div>
              <div className="permission-indicator-bar" style={{ background: perm.color }}></div>
            </div>
          ))}
        </div>
      </div>

      {/* Security Section */}
      <div className="glass-card profile-section">
        <div className="section-header">
          <h3>🔑 Security & Password</h3>
          <span className="section-badge">Important</span>
        </div>

        {!changePassword ? (
          <div className="security-info">
            <div style={{ marginBottom: '16px' }}>
              <p style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
                Protect your account by changing your password regularly. Passwords must be at least 6 characters long.
              </p>
            </div>
            <button
              className="btn btn-primary"
              onClick={() => {
                setChangePassword(true)
                setMessage('')
              }}
            >
              🔐 Change Password
            </button>
          </div>
        ) : (
          <div>
            {message && (
              <div
                className={`password-message ${message.includes('✅') ? 'success' : 'error'}`}
              >
                {message}
              </div>
            )}

            <div className="input-group">
              <label>Current Password</label>
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Enter your current password"
              />
            </div>

            <div className="input-group">
              <label>New Password</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Enter new password (min. 6 characters)"
              />
            </div>

            <div className="input-group">
              <label>Confirm New Password</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm your new password"
              />
            </div>

            <div style={{ display: 'flex', gap: '12px' }}>
              <button className="btn btn-primary btn-sm" onClick={handleChangePassword}>
                ✅ Update Password
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  setChangePassword(false)
                  setMessage('')
                  setCurrentPassword('')
                  setNewPassword('')
                  setConfirmPassword('')
                }}
              >
                ❌ Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Danger Zone */}
      <div className="glass-card profile-section danger-zone">
        <div className="section-header">
          <h3>⚠️ Session Management</h3>
          <span className="section-badge danger">Caution</span>
        </div>
        <p style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
          Logging out will end your current session. You will need to login again to access the system.
        </p>
        <button className="btn btn-danger" onClick={handleLogout}>
          🚪 Logout
        </button>
      </div>
    </div>
  )
}
