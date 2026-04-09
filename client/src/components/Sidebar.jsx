import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../App'

export default function Sidebar() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="brand-icon">N</div>
        <div className="brand-text">
          <h2>Normless</h2>
          <span>CRM Dashboard</span>
        </div>
      </div>

      <nav className="sidebar-nav">
        <div className="sidebar-section">
          <div className="sidebar-section-label">Main</div>
          <NavLink to="/" end className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
            <span className="link-icon">📊</span>
            Dashboard
          </NavLink>
          <NavLink to="/customers" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
            <span className="link-icon">👥</span>
            Customers
          </NavLink>
          <NavLink to="/orders" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
            <span className="link-icon">📦</span>
            Orders
          </NavLink>
        </div>

        <div className="sidebar-section">
          <div className="sidebar-section-label">System</div>
          <NavLink to="/settings" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
            <span className="link-icon">⚙️</span>
            Settings & Sync
          </NavLink>
        </div>
      </nav>

      <div style={{ padding: '16px 12px', borderTop: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px' }}>
          <div className="avatar">{user?.username?.charAt(0).toUpperCase() || 'A'}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '14px', fontWeight: 600 }}>{user?.username || 'Admin'}</div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Administrator</div>
          </div>
          <button className="btn-icon" onClick={handleLogout} title="Logout">🚪</button>
        </div>
      </div>
    </aside>
  )
}
