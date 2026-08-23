import { useState, useEffect } from 'react'
import useDirtyGuard from '../hooks/useDirtyGuard'
import { useApi, useAuth } from '../App'
import { useToast } from '../components/Toast'
import Icon from '../components/Icon'

const GROUPS = [
  { brand: 'normless', label: 'Normless', glyph: 'activity', pages: [
    { key: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
    { key: 'customers', label: 'Customers', icon: 'users' },
    { key: 'orders', label: 'Orders', icon: 'box' },
    { key: 'scanner', label: 'Scan Order', icon: 'scan' },
    { key: 'marketing', label: 'Marketing', icon: 'spark' },
    { key: 'meta_ads', label: 'Meta Ads', icon: 'trending' },
    { key: 'invoices', label: 'Invoices', icon: 'invoice' },
    { key: 'inventory', label: 'Inventory', icon: 'box' },
    { key: 'inventory_edit', label: 'Inventory — can edit', icon: 'edit', sub: 'inventory' },
  ] },
  { brand: 'crewfit', label: 'Crewfit', glyph: 'shirt', pages: [
    { key: 'crewfit_analytics', label: 'Dashboard', icon: 'dashboard' },
    { key: 'crewfit_followups', label: 'Follow-ups', icon: 'bell' },
    { key: 'crewfit_orders', label: 'Bulk Orders', icon: 'box' },
    { key: 'crewfit_orders_edit', label: 'Bulk Orders — can edit', icon: 'edit', sub: 'crewfit_orders' },
    { key: 'crewfit_customers', label: 'Customers', icon: 'users' },
    { key: 'crewfit_catalog', label: 'Catalog', icon: 'shirt' },
    { key: 'crewfit_calculator', label: 'Quotes', icon: 'spark' },
    { key: 'crewfit_payments', label: 'Payments', icon: 'card' },
    { key: 'crewfit_vendors', label: 'Vendor Orders', icon: 'truck' },
    { key: 'crewfit_invoices', label: 'Invoices', icon: 'invoice' },
  ] },
]

const blankForm = () => ({ username: '', password: '', role: 'operator', normless: true, dashboard: true, customers: true, orders: true, scanner: true, marketing: false, marketing_dispatch: false, marketing_approve: false, meta_ads: false, invoices: false, crewfit: false, crewfit_analytics: false, crewfit_followups: false, crewfit_orders: false, crewfit_catalog: false, crewfit_calculator: false, crewfit_payments: false, crewfit_customers: false, crewfit_vendors: false, crewfit_invoices: false, crewfit_orders_edit: false, inventory: false, inventory_edit: false, revenue: false })
const fromUser = (u) => ({
  id: u.id, username: u.username, password: '', role: u.role,
  normless: !!u.can_access_normless, dashboard: !!u.can_view_dashboard, customers: !!u.can_view_customers, orders: !!u.can_view_orders, scanner: !!u.can_scan_orders, invoices: !!u.can_view_invoices,
  marketing: !!u.can_view_marketing, marketing_dispatch: !!u.can_dispatch_marketing, marketing_approve: !!u.can_approve_marketing, meta_ads: !!u.can_view_meta_ads,
  crewfit: !!u.can_access_crewfit, crewfit_analytics: !!u.can_view_crewfit_analytics, crewfit_followups: !!u.can_view_crewfit_followups, crewfit_orders: !!u.can_view_crewfit_orders, crewfit_catalog: !!u.can_view_crewfit_catalog, crewfit_calculator: !!u.can_view_crewfit_calculator, crewfit_payments: !!u.can_view_crewfit_payments, crewfit_customers: !!u.can_view_crewfit_customers, crewfit_vendors: !!u.can_view_crewfit_vendors, crewfit_invoices: !!u.can_view_crewfit_invoices, crewfit_orders_edit: !!u.can_edit_crewfit_orders, inventory: !!u.can_view_inventory, inventory_edit: !!u.can_edit_inventory, revenue: !!u.can_view_revenue,
})
const buildPerms = (f) => {
  // Owner and admin both hold every page; the server short-circuits permission checks for them
  // either way, so these columns are really just kept consistent with the role.
  if (f.role === 'admin' || f.role === 'owner') return { normless: true, crewfit: true, dashboard: true, customers: true, orders: true, scanner: true, marketing: true, marketing_dispatch: true, marketing_approve: true, meta_ads: true, invoices: true, crewfit_analytics: true, crewfit_followups: true, crewfit_orders: true, crewfit_catalog: true, crewfit_calculator: true, crewfit_payments: true, crewfit_customers: true, crewfit_vendors: true, crewfit_invoices: true, crewfit_orders_edit: true, inventory: true, inventory_edit: true, revenue: true, sync: f.role === 'owner' }
  return {
    normless: !!f.normless, crewfit: !!f.crewfit, sync: false,
    dashboard: !!(f.normless && f.dashboard), customers: !!(f.normless && f.customers), orders: !!(f.normless && f.orders), scanner: !!(f.normless && f.scanner), invoices: !!(f.normless && f.invoices),
    marketing: !!(f.normless && f.marketing),
    // Dispatch is a sub-permission of the page: it can't be held without it.
    marketing_dispatch: !!(f.normless && f.marketing && f.marketing_dispatch),
    marketing_approve: !!(f.normless && f.marketing && f.marketing_approve),
    meta_ads: !!(f.normless && f.meta_ads),
    crewfit_analytics: !!(f.crewfit && f.crewfit_analytics), crewfit_followups: !!(f.crewfit && f.crewfit_followups), crewfit_orders: !!(f.crewfit && f.crewfit_orders), crewfit_catalog: !!(f.crewfit && f.crewfit_catalog), crewfit_calculator: !!(f.crewfit && f.crewfit_calculator), crewfit_payments: !!(f.crewfit && f.crewfit_payments), crewfit_customers: !!(f.crewfit && f.crewfit_customers), crewfit_vendors: !!(f.crewfit && f.crewfit_vendors), crewfit_invoices: !!(f.crewfit && f.crewfit_invoices),
    // Editing is a sub-permission of seeing the page: it can't be held without it.
    crewfit_orders_edit: !!(f.crewfit && f.crewfit_orders && f.crewfit_orders_edit),
    inventory: !!(f.normless && f.inventory), inventory_edit: !!(f.normless && f.inventory && f.inventory_edit), revenue: !!f.revenue,
  }
}

export default function AdminManagement() {
  const apiFetch = useApi()
  const { user } = useAuth()
  const toast = useToast()
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState(null)
  const [form, setForm] = useState(null)
  const guard = useDirtyGuard({
    snapshot: form,
    identity: form ? (form.id ?? 'new') : null,
    onDiscard: () => setForm(null),
    confirm: toast.confirm,
  })
  const [saving, setSaving] = useState(false)
  const isOwner = user?.role === 'owner'

  useEffect(() => { loadUsers(); loadStats() }, [])
  const loadUsers = async () => { setLoading(true); const r = await apiFetch('/api/admin/users'); if (r && !r.error) setUsers(r); setLoading(false) }
  const loadStats = async () => { const r = await apiFetch('/api/admin/stats'); if (r) setStats(r) }
  const setF = (patch) => setForm(f => ({ ...f, ...patch }))

  const save = async () => {
    if (!form.username || (!form.id && !form.password)) { toast.error('Username and password are required'); return }
    // Promoting to owner hands over the owner-only actions, so it gets an explicit confirmation
    // rather than going through on a stray dropdown change.
    const wasOwner = users.find(u => u.id === form.id)?.role === 'owner'
    if (form.role === 'owner' && !wasOwner && !await toast.confirm({
      title: `Make ${form.username} an owner?`,
      message: 'They will be able to delete orders, edit the Crewfit catalog, run a full sync, and promote or demote other users — including you.',
      confirmLabel: 'Make owner', cancelLabel: 'Cancel', danger: true,
    })) return
    setSaving(true)
    const permissions = buildPerms(form)
    let res
    if (form.id) res = await apiFetch(`/api/admin/users/${form.id}`, { method: 'PUT', body: JSON.stringify({ role: form.role, permissions }) })
    else res = await apiFetch('/api/admin/users', { method: 'POST', body: JSON.stringify({ username: form.username, password: form.password, role: form.role, permissions }) })
    setSaving(false)
    if (res?.success) { guard.reset(); setForm(null); loadUsers(); loadStats(); toast.success(form.id ? 'User updated' : 'User created') } else toast.error(res?.error || 'Save failed')
  }

  const del = async (id) => {
    if (!await toast.confirm({ title: 'Delete this user?', message: 'They will lose access immediately. This cannot be undone.', confirmLabel: 'Delete user', danger: true })) return
    const r = await apiFetch(`/api/admin/users/${id}`, { method: 'DELETE' })
    if (r?.success) { loadUsers(); loadStats(); toast.success('User deleted') } else toast.error(r?.error || 'Failed to delete user')
  }

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
            <div className="input-group" style={{ marginBottom: 0 }}><label>Role</label>
              {/* An admin may not grant owner, nor change an existing owner — the select is
                  locked rather than silently showing a role the server would reject. */}
              <select value={form.role} disabled={!isOwner && form.role === 'owner'} onChange={e => setF({ role: e.target.value })}>
                <option value="operator">Operator (limited)</option>
                <option value="admin">Admin (full access)</option>
                {(isOwner || form.role === 'owner') && <option value="owner">Owner (full control)</option>}
              </select>
              {!isOwner && form.role === 'owner' && <div className="img-upload-hint">Only another owner can change this.</div>}
            </div>
          </div>

          {form.role === 'owner' ? (
            <div className="admin-note"><Icon name="shield" size={16} /> Owners get everything an admin does, plus the owner-only actions: deleting orders, editing the Crewfit catalog, running a full sync, and promoting other users to owner. There can be more than one owner.</div>
          ) : form.role === 'admin' ? (
            <div className="admin-note"><Icon name="shield" size={16} /> Admins get full access to both brands and all pages.</div>
          ) : (
            <>
            {/* Cuts across pages rather than unlocking one, so it sits outside the brand cards. */}
            <div className="access-card data-access-card">
              <label className="page-check" style={{ margin: 0 }}>
                <input type="checkbox" checked={!!form.revenue} onChange={e => setF({ revenue: e.target.checked })} />
                <Icon name="wallet" size={15} />
                <span>
                  <b>See revenue totals</b>
                  <em>Collected &amp; outstanding totals on Payments, combined lifetime value on Customers, and all money figures on the dashboard. Individual order and payment amounts stay visible either way.</em>
                </span>
              </label>
            </div>
            {/* Also cross-cutting: which half of an influencer order this user may write. */}
            {form.normless && form.marketing && (
              <div className="access-card data-access-card">
                <label className="page-check" style={{ margin: 0 }}>
                  <input type="checkbox" checked={!!form.marketing_dispatch} onChange={e => setF({ marketing_dispatch: e.target.checked })} />
                  <Icon name="truck" size={15} />
                  <span>
                    <b>Dispatch influencer orders</b>
                    <em>Fill in the shipping partner, AWB and tracking link on a Marketing order, and mark it dispatched. Without this, the user can still raise orders and read the dispatch details — production owns that half.</em>
                  </span>
                </label>
                {/* Sign-off is deliberately separate from raising an order: the point of the stage
                    is that a second person releases it. */}
                <label className="page-check" style={{ margin: '10px 0 0' }}>
                  <input type="checkbox" checked={!!form.marketing_approve} onChange={e => setF({ marketing_approve: e.target.checked })} />
                  <Icon name="check" size={15} />
                  <span>
                    <b>Approve influencer orders</b>
                    <em>Release a Pending Approval order for dispatch, or send it back. Nothing ships until someone with this signs it off, and their name is recorded against it.</em>
                  </span>
                </label>
              </div>
            )}
            <div className="access-grid">
              {GROUPS.map(g => (
                <div key={g.brand} className={`access-card ${form[g.brand] ? 'on' : ''}`}>
                  <div className="access-head">
                    <div className="access-brand"><span className={`brand-mark brand-mark-${g.brand}`} style={{ width: 30, height: 30, borderRadius: 8 }}><Icon name={g.glyph} size={16} /></span>{g.label}</div>
                    <button className={`toggle ${form[g.brand] ? 'on' : ''}`} onClick={() => setF({ [g.brand]: !form[g.brand] })}><span /></button>
                  </div>
                  <div className="access-pages">
                    {g.pages.map(p => {
                      // A sub-permission can't be held without the page it belongs to, so it greys
                      // out with its parent and sits indented under it.
                      const blocked = !form[g.brand] || (p.sub && !form[p.sub])
                      return (
                        <label key={p.key} className={`page-check ${blocked ? 'disabled' : ''} ${p.sub ? 'page-check-sub' : ''}`}>
                          <input type="checkbox" disabled={blocked} checked={!!form[p.key] && !blocked} onChange={e => setF({ [p.key]: e.target.checked })} />
                          <Icon name={p.icon} size={15} /><span>{p.label}</span>
                        </label>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
            </>
          )}

          <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
            <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : (form.id ? 'Save changes' : 'Create user')}</button>
            <button className="btn btn-secondary" onClick={guard.requestClose}>Cancel</button>
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
                  {/* An owner may remove another owner — the server still refuses to delete the
                      last one. Admins can't touch an owner at all. */}
                  {u.id !== user.id && (u.role !== 'owner' || isOwner) && <button className="btn-icon" onClick={() => del(u.id)} title="Delete" style={{ color: 'var(--danger)' }}><Icon name="trash" size={15} /></button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
