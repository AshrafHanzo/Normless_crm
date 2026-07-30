import { useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../App'
import { useTheme } from './ThemeProvider'

const BRANDS = {
  normless: { name: 'Normless', tag: 'Retail CRM', logo: 'N' },
  crewfit: { name: 'Crewfit', tag: 'Bulk Orders', logo: 'C' },
}

const NAV = {
  normless: [
    { to: '/', end: true, icon: '📊', label: 'Dashboard', perm: 'can_view_dashboard' },
    { to: '/customers', icon: '👥', label: 'Customers', perm: 'can_view_customers' },
    { to: '/orders', icon: '📦', label: 'Orders', perm: 'can_view_orders' },
    { to: '/scan', icon: '🎯', label: 'Scan Order', perm: 'can_scan_orders' },
    { to: '/settings', icon: '⚙️', label: 'Settings & Sync', perm: 'can_sync_data', section: 'System' },
  ],
  crewfit: [
    { to: '/crewfit', end: true, icon: '🔔', label: 'Follow-ups' },
    { to: '/crewfit/orders', icon: '📦', label: 'Bulk Orders' },
  ],
}

export default function Sidebar() {
  const { user, logout, brand, setBrand } = useAuth()
  const { isDark, toggleTheme } = useTheme()
  const navigate = useNavigate()
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)

  const b = BRANDS[brand] || BRANDS.normless
  const canSee = (item) => !item.perm || user?.role === 'owner' || user?.role === 'admin' || user?.[item.perm]
  const items = (NAV[brand] || NAV.normless).filter(canSee)
  const closeMenu = () => setIsMobileMenuOpen(false)

  const switchBrand = (key) => {
    setBrand(key)
    navigate(key === 'crewfit' ? '/crewfit' : '/')
    closeMenu()
  }
  const handleLogout = () => { logout(); navigate('/login') }

  const mainItems = items.filter(i => !i.section)
  const systemItems = items.filter(i => i.section === 'System')

  return (
    <>
      <aside className={`sidebar brand-${brand} ${isMobileMenuOpen ? 'mobile-menu-open' : ''}`}>
        <div className="sidebar-brand">
          <div className={`sidebar-logo brand-logo-${brand}`}>{b.logo}</div>
          <div className="brand-text">
            <h2>{b.name}</h2>
            <span>{b.tag}</span>
          </div>
        </div>

        {/* Brand switcher */}
        <div className="brand-switch">
          {Object.entries(BRANDS).map(([key, val]) => (
            <button key={key} className={brand === key ? 'active' : ''} onClick={() => switchBrand(key)}>{val.name}</button>
          ))}
        </div>

        <nav className="sidebar-nav">
          <div className="sidebar-section">
            <div className="sidebar-section-label">Main</div>
            {mainItems.map(item => (
              <NavLink key={item.to} to={item.to} end={item.end} onClick={closeMenu}
                className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
                <span className="link-icon">{item.icon}</span><span>{item.label}</span>
              </NavLink>
            ))}
          </div>

          {(systemItems.length > 0 || user?.role === 'owner' || user?.role === 'admin') && (
            <div className="sidebar-section">
              <div className="sidebar-section-label">System</div>
              {systemItems.map(item => (
                <NavLink key={item.to} to={item.to} end={item.end} onClick={closeMenu}
                  className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
                  <span className="link-icon">{item.icon}</span><span>{item.label}</span>
                </NavLink>
              ))}
              {(user?.role === 'owner' || user?.role === 'admin') && (
                <NavLink to="/admin" onClick={closeMenu} className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
                  <span className="link-icon">👮</span><span>Admin</span>
                </NavLink>
              )}
            </div>
          )}
        </nav>

        <div className="sidebar-bottom">
          <div className="theme-toggle-row" onClick={toggleTheme} title={`Switch to ${isDark ? 'light' : 'dark'} mode`}>
            <span style={{ fontSize: '16px' }}>{isDark ? '🌙' : '☀️'}</span>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)', flex: 1 }}>{isDark ? 'Dark' : 'Light'} mode</span>
          </div>

          <div className="sidebar-user-card">
            <div className="sidebar-user-avatar">{user?.username?.charAt(0).toUpperCase() || 'A'}</div>
            <div className="sidebar-user-info">
              <div className="sidebar-user-name" onClick={() => { navigate('/profile'); closeMenu() }}>{user?.username || 'Admin'}</div>
              <div className="sidebar-user-role">{user?.role ? user.role.charAt(0).toUpperCase() + user.role.slice(1) : 'Administrator'}</div>
              <div className="sidebar-user-status">● Online</div>
            </div>
            <button className="btn-icon sidebar-logout" onClick={handleLogout} title="Logout">🚪</button>
          </div>
        </div>
      </aside>

      <button className="sidebar-menu-toggle" onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)} title="Menu">
        {isMobileMenuOpen ? '✕' : '☰'}
      </button>
      <div className={`sidebar-overlay ${isMobileMenuOpen ? 'visible' : ''}`} onClick={closeMenu} />
    </>
  )
}
