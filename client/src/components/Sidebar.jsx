import { useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../App'
import { useTheme } from './ThemeProvider'
import Icon from './Icon'

const BRANDS = {
  normless: { name: 'Normless', tag: 'Retail CRM', glyph: 'activity' },
  crewfit: { name: 'Crewfit', tag: 'Bulk Orders', glyph: 'shirt' },
}

const NAV = {
  normless: [
    { to: '/', end: true, icon: 'dashboard', label: 'Dashboard', perm: 'can_view_dashboard' },
    { to: '/customers', icon: 'users', label: 'Customers', perm: 'can_view_customers' },
    { to: '/orders', icon: 'box', label: 'Orders', perm: 'can_view_orders' },
    { to: '/scan', icon: 'scan', label: 'Scan Order', perm: 'can_scan_orders' },
    { to: '/invoices', icon: 'invoice', label: 'Invoices', perm: 'can_view_invoices' },
  ],
  crewfit: [
    { to: '/crewfit/dashboard', icon: 'dashboard', label: 'Dashboard', perm: 'can_view_crewfit_analytics' },
    { to: '/crewfit', end: true, icon: 'bell', label: 'Follow-ups', perm: 'can_view_crewfit_followups' },
    { to: '/crewfit/orders', icon: 'box', label: 'Bulk Orders', perm: 'can_view_crewfit_orders' },
    { to: '/crewfit/customers', icon: 'users', label: 'Customers', perm: 'can_view_crewfit_customers' },
    { to: '/crewfit/catalog', icon: 'shirt', label: 'Catalog', perm: 'can_view_crewfit_catalog' },
    { to: '/crewfit/quotes', icon: 'spark', label: 'Quotes', perm: 'can_view_crewfit_calculator' },
    { to: '/crewfit/payments', icon: 'card', label: 'Payments', perm: 'can_view_crewfit_payments' },
    { to: '/crewfit/vendor-orders', icon: 'truck', label: 'Vendor Orders', perm: 'can_view_crewfit_vendors' },
  ],
}

export default function Sidebar() {
  const { user, logout, brand, setBrand } = useAuth()
  const { isDark, toggleTheme } = useTheme()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  const b = BRANDS[brand] || BRANDS.normless
  const canSee = (item) => !item.perm || user?.role === 'owner' || user?.role === 'admin' || user?.[item.perm]
  const items = (NAV[brand] || NAV.normless).filter(canSee)
  const close = () => setOpen(false)
  const switchBrand = (key) => { setBrand(key); navigate(key === 'crewfit' ? '/crewfit' : '/'); close() }
  const handleLogout = () => { logout(); navigate('/login') }

  const mainItems = items.filter(i => !i.section)
  const systemItems = items.filter(i => i.section === 'System')
  const isAdmin = user?.role === 'owner' || user?.role === 'admin'

  return (
    <>
      <aside className={`sidebar brand-${brand} ${open ? 'mobile-menu-open' : ''}`}>
        <div className="sidebar-brand">
          {/* Both brands ship a real mark now, so the gradient chip + glyph is retired here. */}
          <div className={`brand-mark brand-mark-${brand} ${brand === 'crewfit' ? 'cf-logo' : 'n-logo'}`} role="img" aria-label={b.name} />
          <div className="brand-text"><h2>{b.name}</h2><span>{b.tag}</span></div>
        </div>

        {(() => {
          const brands = Object.entries(BRANDS).filter(([key]) => isAdmin || user?.[`can_access_${key}`])
          return brands.length > 1 ? (
            <div className="brand-switch">
              {brands.map(([key, val]) => (
                <button key={key} className={brand === key ? 'active' : ''} onClick={() => switchBrand(key)}>
                  <Icon name={val.glyph} size={15} strokeWidth={2.2} />{val.name}
                </button>
              ))}
            </div>
          ) : null
        })()}

        <nav className="sidebar-nav">
          <div className="sidebar-section">
            <div className="sidebar-section-label">Main</div>
            {mainItems.map(item => (
              <NavLink key={item.to} to={item.to} end={item.end} onClick={close} className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
                <span className="link-icon"><Icon name={item.icon} size={19} /></span><span>{item.label}</span>
              </NavLink>
            ))}
          </div>

          {(systemItems.length > 0 || isAdmin) && (
            <div className="sidebar-section">
              <div className="sidebar-section-label">System</div>
              {systemItems.map(item => (
                <NavLink key={item.to} to={item.to} end={item.end} onClick={close} className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
                  <span className="link-icon"><Icon name={item.icon} size={19} /></span><span>{item.label}</span>
                </NavLink>
              ))}
              {isAdmin && (
                <NavLink to="/admin" onClick={close} className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
                  <span className="link-icon"><Icon name="shield" size={19} /></span><span>Admin</span>
                </NavLink>
              )}
            </div>
          )}
        </nav>

        <div className="sidebar-bottom">
          <button className="theme-toggle-row" onClick={toggleTheme} title={`Switch to ${isDark ? 'light' : 'dark'} mode`}>
            <Icon name={isDark ? 'moon' : 'sun'} size={16} />
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)', flex: 1, textAlign: 'left' }}>{isDark ? 'Dark' : 'Light'} mode</span>
          </button>

          <div className="sidebar-user-card">
            <div className="sidebar-user-avatar">{user?.username?.charAt(0).toUpperCase() || 'A'}</div>
            <div className="sidebar-user-info">
              <div className="sidebar-user-name" onClick={() => { navigate('/profile'); close() }}>{user?.username || 'Admin'}</div>
              <div className="sidebar-user-role">{user?.role ? user.role.charAt(0).toUpperCase() + user.role.slice(1) : 'Administrator'}</div>
            </div>
            <button className="btn-icon sidebar-logout" onClick={handleLogout} title="Logout"><Icon name="logout" size={16} /></button>
          </div>
        </div>
      </aside>

      <button className="sidebar-menu-toggle" onClick={() => setOpen(!open)} title="Menu"><Icon name={open ? 'close' : 'dashboard'} size={20} /></button>
      <div className={`sidebar-overlay ${open ? 'visible' : ''}`} onClick={close} />
    </>
  )
}
