import { useState, useEffect } from 'react'
import { useApi, useAuth } from '../App'
import Icon from '../components/Icon'

const GROUPS = [
  { brand: 'normless', label: 'Normless', glyph: 'activity', pages: [
    { key: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
    { key: 'customers', label: 'Customers', icon: 'users' },
    { key: 'orders', label: 'Orders', icon: 'box' },
    { key: 'scanner', label: 'Scan Order', icon: 'scan' },
  ] },
  { brand: 'crewfit', label: 'Crewfit', glyph: 'shirt', pages: [
    { key: 'crewfit_analytics', label: 'Dashboard', icon: 'dashboard' },
    { key: 'crewfit_followups', label: 'Follow-ups', icon: 'bell' },
    { key: 'crewfit_orders', label: 'Bulk Orders', icon: 'box' },
    { key: 'crewfit_catalog', label: 'Catalog', icon: 'shirt' },
    { key: 'crewfit_calculator', label: 'Quotes', icon: 'spark' },
  ] },
]

const blankForm = () => ({ username: '', password: '', role: 'operator', normless: true, dashboard: true, customers: true, orders: true, scanner: true, crewfit: false, crewfit_analytics: false, crewfit_followups: false, crewfit_orders: false, crewfit_catalog: false, crewfit_calculator: false })
const fromUser = (u) => ({
  id: u.id, username: u.username, password: '', role: u.role,
  normless: !!u.can_access_normless, dashboard: !!u.can_view_dashboard, customers: !!u.can_view_customers, orders: !!u.can_view_orders, scanner: !!u.can_scan_orders,
  crewfit: !!u.can_access_crewfit, crewfit_analytics: !!u.can_view_crewfit_analytics, crewfit_followups: !!u.can_view_crewfit_followups, crewfit_orders: !!u.can_view_crewfit_orders, crewfit_catalog: !!u.can_view_crewfit_catalog, crewfit_calculator: !!u.can_view_crewfit_calculator,
})
const buildPerms = (f) => {
  if (f.role === 'admin') return { normless: true, crewfit: true, dashboard: true, customers: true, orders: true, scanner: true, crewfit_analytics: true, crewfit_followups: true, crewfit_orders: true, crewfit_catalog: true, crewfit_calculator: true, sync: false }
  return {
    normless: !!f.normless, crewfit: !!f.crewfit, sync: false,
    dashboard: !!(f.normless && f.dashboard), customers: !!(f.normless && f.customers), orders: !!(f.normless && f.orders), scanner: !!(f.normless && f.scanner),
    crewfit_analytics: !!(f.crewfit && f.crewfit_analytics), crewfit_followups: !!(f.crewfit && f.crewfit_followups), crewfit_orders: !!(f.crewfit && f.crewfit_orders), crewfit_catalog: !!(f.crewfit && f.crewfit_catalog), crewfit_calculator: !!(f.crewfit && f.crewfit_calculator),
  }
}

export default function AdminManagement() {
  const apiFetch = useApi()
  const { user } = useAuth()
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState(null)
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => { loadUsers(); loadStats() }, [])
  const loadUsers = async () => { setLoading(true); const r = await apiFetch('/api/admin/users'); if (r && !r.error) setUsers(r); setLoading(false) }
  const loadStats = async () => { const r = await apiFetch('/api/admin/stats'); if (r) setStats(r) }
  const setF = (patch) => setForm(f => ({ ...f, ...patch }))

  const save = async () => {
    if (!form.username || (!form.id && !form.password)) { alert('Username and password are required'); return }
    setSaving(true)
    const permissions = buildPerms(form)
    let res
    if (form.id) res = await apiFetch(`/api/admin/users/${form.id}`, { method: 'PUT', body: JSON.stringify({ role: form.role, permissions }) })
    else res = await apiFetch('/api/admin/users', { method: 'POST', body: JSON.stringify({ username: form.username, password: form.password, role: form.role, permissions }) })
    setSaving(false)
    if (res?.success) { setForm(null); loadUsers(); loadStats() } else alert(res?.error || 'Save failed')
  }

  const del = async (id) => { if (!confirm('Delete this user? This cannot be undone.')) return; const r = await apiFetch(`/api/admin/users/${id}`, { method: 'DELETE' }); if (r?.success) { loadUsers(); loadStats() } }

  const statCards = stats ? [
    { icon: 'users', label: 'Total Users', value: stats.totalUsers, color: 'var(--primary)' },
    { icon: 'check', label: 'Active', value: stats.activeUsers, color: 'var(--success)' },
    { icon: 'shield', label: 'Operators', value: stats.operators, color: 'var(--info)' },
  ] : []

  return (
    <div className="page-enter">
      <div className="admin-header">
        <div className="admin-header-icon"><Icon name="shield" size={26} /></div>
        <div className="admin-header-content"><h1>Team &amp; Access</h1><p>Create operators and control exactly which brand &amp; pages they can open</p></div>
      </div>

      {stats && (
        <div className="grid-3" style={{ marginBottom: 24 }}>
          {statCards.map((s, i) => (
            <div className="glass-card" key={i} style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div className="stat-icon" style={{ color: s.color }}><Icon name={s.icon} size={22} /></div>
              <div><div style={{ fontSize: 26, fontWeight: 800 }}>{s.value}</div><div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{s.label}</div></div>
            </div>
          ))}
        </div>
      )}

      {!form && <button className="btn btn-primary" onClick={() => setForm(blankForm())} style={{ marginBottom: 24 }}><Icon name="plus" size={16} /> New User</button>}

      {form && (
        <div className="glass-card" style={{ marginBottom: 24 }}>
          <h3 style={{ marginBottom: 18 }}>{form.id ? `Edit ${form.username}` : 'Create New User'}</h3>
          <div className="form-row" style={{ marginBottom: 18 }}>
            <div className="input-group" style={{ marginBottom: 0 }}><label>Username</label><input value={form.username} disabled={!!form.id} onChange={e => setF({ username: e.target.value })} placeholder="e.g. anu@crewfit" /></div>
            {!form.id && <div className="input-group" style={{ marginBottom: 0 }}><label>Password</label><input type="text" value={form.password} onChange={e => setF({ password: e.target.value })} placeholder="Set a password" /></div>}
            <div className="input-group" style={{ marginBottom: 0 }}><label>Role</label><select value={form.role} onChange={e => setF({ role: e.target.value })}><option value="operator">Operator (limited)</option><option value="admin">Admin (full access)</option></select></div>
          </div>

          {form.role === 'admin' ? (
            <div className="admin-note"><Icon name="shield" size={16} /> Admins get full access to both brands and all pages.</div>
          ) : (
            <div className="access-grid">
              {GROUPS.map(g => (
                <div key={g.brand} className={`access-card ${form[g.brand] ? 'on' : ''}`}>
                  <div className="access-head">
                    <div className="access-brand"><span className={`brand-mark brand-mark-${g.brand}`} style={{ width: 30, height: 30, borderRadius: 8 }}><Icon name={g.glyph} size={16} /></span>{g.label}</div>
                    <button className={`toggle ${form[g.brand] ? 'on' : ''}`} onClick={() => setF({ [g.brand]: !form[g.brand] })}><span /></button>
                  </div>
                  <div className="access-pages">
                    {g.pages.map(p => (
                      <label key={p.key} className={`page-check ${!form[g.brand] ? 'disabled' : ''}`}>
                        <input type="checkbox" disabled={!form[g.brand]} checked={!!form[p.key]} onChange={e => setF({ [p.key]: e.target.checked })} />
                        <Icon name={p.icon} size={15} /><span>{p.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
            <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : (form.id ? 'Save changes' : 'Create user')}</button>
            <button className="btn btn-secondary" onClick={() => setForm(null)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="glass-card">
        <h3 style={{ marginBottom: 16 }}>Users</h3>
        {loading ? <div className="loader"><div className="spinner" /></div> : (
          <div className="user-list">
            {users.map(u => (
              <div key={u.id} className="user-card">
                <div className="user-card-info">
                  <div className="user-card-avatar">{u.username.charAt(0).toUpperCase()}</div>
                  <div className="user-card-details">
                    <h4>{u.username}</h4>
                    <div className="user-badges">
                      <span className="role-badge">{u.role}</span>
                      {(u.role === 'owner' || u.role === 'admin' || u.can_access_normless) && <span className="brand-badge nb">Normless</span>}
                      {(u.role === 'owner' || u.role === 'admin' || u.can_access_crewfit) && <span className="brand-badge cb">Crewfit</span>}
                    </div>
                  </div>
                </div>
                <div className="user-card-actions">
                  <button className="btn-icon" onClick={() => setForm(fromUser(u))} title="Edit access"><Icon name="edit" size={15} /></button>
                  {u.id !== user.id && u.role !== 'owner' && <button className="btn-icon" onClick={() => del(u.id)} title="Delete" style={{ color: 'var(--danger)' }}><Icon name="trash" size={15} /></button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
