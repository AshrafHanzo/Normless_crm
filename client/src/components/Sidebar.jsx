import { useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../App'
import { useTheme } from './ThemeProvider'

export default function Sidebar() {
  const { user, logout } = useAuth()
  const { isDark, toggleTheme } = useTheme()
  const navigate = useNavigate()
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  const handleNavClick = () => {
    // Close mobile menu on navigation
    setIsMobileMenuOpen(false)
  }

  const closeMenu = () => {
    setIsMobileMenuOpen(false)
  }

  return (
    <>
      {/* Sidebar */}
      <aside className={`sidebar ${isMobileMenuOpen ? 'mobile-menu-open' : ''}`}>
        <div className="sidebar-brand">
          <img src="/logo.png" alt="Normless" className="sidebar-logo" />
          <div className="brand-text">
            <h2>Normless</h2>
            <span>CRM Dashboard</span>
          </div>
        </div>

        <nav className="sidebar-nav">
          <div className="sidebar-section">
            <div className="sidebar-section-label">Main</div>
            {(user?.role === 'owner' || user?.role === 'admin' || user?.can_view_dashboard) && (
              <NavLink
                to="/"
                end
                className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
                onClick={handleNavClick}
              >
                <span className="link-icon">📊</span>
                <span>Dashboard</span>
              </NavLink>
            )}
            {(user?.role === 'owner' || user?.role === 'admin' || user?.can_view_customers) && (
              <NavLink
                to="/customers"
                className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
                onClick={handleNavClick}
              >
                <span className="link-icon">👥</span>
                <span>Customers</span>
              </NavLink>
            )}
            {(user?.role === 'owner' || user?.role === 'admin' || user?.can_view_orders) && (
              <NavLink
                to="/orders"
                className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
                onClick={handleNavClick}
              >
                <span className="link-icon">📦</span>
                <span>Orders</span>
              </NavLink>
            )}
            {(user?.role === 'owner' || user?.role === 'admin' || user?.can_scan_orders) && (
              <NavLink
                to="/scan"
                className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
                onClick={handleNavClick}
              >
                <span className="link-icon">🎯</span>
                <span>Scan Order</span>
              </NavLink>
            )}
          </div>

          <div className="sidebar-section">
            <div className="sidebar-section-label">System</div>
            {(user?.role === 'owner' || user?.role === 'admin' || user?.can_sync_data) && (
              <NavLink
                to="/settings"
                className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
                onClick={handleNavClick}
              >
                <span className="link-icon">⚙️</span>
                <span>Settings & Sync</span>
              </NavLink>
            )}
            {(user?.role === 'owner' || user?.role === 'admin') && (
              <NavLink
                to="/admin"
                className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
                onClick={handleNavClick}
              >
                <span className="link-icon">👮</span>
                <span>Admin</span>
              </NavLink>
            )}
          </div>
        </nav>

        <div className="sidebar-bottom">
          {/* Theme Toggle */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '8px 12px',
              marginBottom: '8px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--surface)',
              cursor: 'pointer'
            }}
            onClick={toggleTheme}
            title={`Switch to ${isDark ? 'light' : 'dark'} mode`}
          >
            <span style={{ fontSize: '16px' }}>{isDark ? '🌙' : '☀️'}</span>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)', flex: 1 }}>{isDark ? 'Dark' : 'Light'}</span>
          </div>

          {/* User Info Card */}
          <div className="sidebar-user-card">
            <div className="sidebar-user-avatar">{user?.username?.charAt(0).toUpperCase() || 'A'}</div>
            <div className="sidebar-user-info">
              <div className="sidebar-user-name" onClick={() => { navigate('/profile'); handleNavClick(); }}>{user?.username || 'Admin'}</div>
              <div className="sidebar-user-role">{user?.role?.charAt(0).toUpperCase() + user?.role?.slice(1) || 'Administrator'}</div>
              <div className="sidebar-user-status">● Online</div>
            </div>
            <button className="btn-icon sidebar-logout" onClick={handleLogout} title="Logout">🚪</button>
          </div>
        </div>
      </aside>

      {/* Mobile Menu Toggle Button (FAB) */}
      <button
        className="sidebar-menu-toggle"
        onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
        title={isMobileMenuOpen ? "Close menu" : "Open menu"}
      >
        {isMobileMenuOpen ? '✕' : '☰'}
      </button>

      {/* Mobile Menu Overlay */}
      <div
        className={`sidebar-overlay ${isMobileMenuOpen ? 'visible' : ''}`}
        onClick={closeMenu}
      />
    </>
  )
}

