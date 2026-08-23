import { useState, useEffect } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth, useApi } from '../App'
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
    { to: '/marketing', icon: 'spark', label: 'Marketing', perm: 'can_view_marketing' },
    { to: '/invoices', icon: 'invoice', label: 'Invoices', perm: 'can_view_invoices' },
    { to: '/inventory', icon: 'box', label: 'Inventory', perm: 'can_view_inventory', badge: 'rto' },
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
    { to: '/crewfit/invoices', icon: 'invoice', label: 'Invoices', perm: 'can_view_crewfit_invoices' },
    { to: '/crewfit/activity', icon: 'bell', label: 'Activity', adminOnly: true },
  ],
}

export default function Sidebar({ collapsed = false, onToggleCollapse }) {
  const { user, logout, brand, setBrand } = useAuth()
  const { isDark, toggleTheme } = useTheme()
  const apiFetch = useApi()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  // Orders that could be served from the RTO shelf. It lives here rather than on the Inventory
  // page because the whole value is being told before you open the page — the alternative is
  // printing a second garment for something already sitting in the building.
  const [rtoAlerts, setRtoAlerts] = useState(0)
  // Normless-only: Inventory is not a Crewfit menu, so there is nothing to badge over there.
  const canSeeInventory = brand === 'normless'
    && (user?.role === 'owner' || user?.role === 'admin' || !!user?.can_view_inventory)
  useEffect(() => {
    if (!canSeeInventory) return
    let live = true
    const check = async () => {
      const r = await apiFetch('/api/inventory/rto/alerts')
      if (live && r && !r.error) setRtoAlerts(r.orders || 0)
    }
    check()
    // Slow on purpose: returns arrive at courier pace, not page-refresh pace.
    const t = setInterval(check, 120000)
    return () => { live = false; clearInterval(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSeeInventory])

  const b = BRANDS[brand] || BRANDS.normless
  const isAdminRole = user?.role === 'owner' || user?.role === 'admin'
  // adminOnly wins over perm: a page that names who did what is not team-wide, and no permission
  // column should be able to open it.
  const canSee = (item) => (item.adminOnly ? isAdminRole : (!item.perm || isAdminRole || user?.[item.perm]))
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
          {onToggleCollapse && (
            <button type="button" className="sidebar-collapse-btn" onClick={onToggleCollapse}
              title={collapsed ? 'Expand menu' : 'Collapse menu'}
              aria-label={collapsed ? 'Expand menu' : 'Collapse menu'} aria-expanded={!collapsed}>
              <Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} size={16} />
            </button>
          )}
        </div>

        {(() => {
          const brands = Object.entries(BRANDS).filter(([key]) => isAdmin || user?.[`can_access_${key}`])
          return brands.length > 1 ? (
            <div className="brand-switch">
              {brands.map(([key, val]) => (
                <button key={key} className={brand === key ? 'active' : ''} onClick={() => switchBrand(key)} title={val.name}>
                  {/* Wrapped so the collapsed rail can hide the label and keep the glyph. */}
                  <Icon name={val.glyph} size={15} strokeWidth={2.2} /><span>{val.name}</span>
                </button>
              ))}
            </div>
          ) : null
        })()}

        <nav className="sidebar-nav">
          <div className="sidebar-section">
            <div className="sidebar-section-label">Main</div>
            {mainItems.map(item => {
              const count = item.badge === 'rto' ? rtoAlerts : 0
              return (
                <NavLink key={item.to} to={item.to} end={item.end} onClick={close}
                  title={count ? `${item.label} — ${count} order${count > 1 ? 's' : ''} can be served from the RTO shelf` : item.label}
                  className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
                  <span className="link-icon">
                    <Icon name={item.icon} size={19} />
                    {/* Shown on the icon too, so the collapsed rail still carries the alert. */}
                    {count > 0 && <span className="link-dot" />}
                  </span>
                  <span>{item.label}</span>
                  {count > 0 && <span className="nav-badge">{count}</span>}
                </NavLink>
              )
            })}
          </div>

          {(systemItems.length > 0 || isAdmin) && (
            <div className="sidebar-section">
              <div className="sidebar-section-label">System</div>
              {systemItems.map(item => (
                <NavLink key={item.to} to={item.to} end={item.end} onClick={close} title={item.label} className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
                  <span className="link-icon"><Icon name={item.icon} size={19} /></span><span>{item.label}</span>
                </NavLink>
              ))}
              {isAdmin && (
                <NavLink to="/admin" onClick={close} title="Admin" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>
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
