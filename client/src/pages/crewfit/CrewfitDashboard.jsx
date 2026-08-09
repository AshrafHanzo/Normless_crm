import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApi } from '../../App'
import CrewfitOrderDrawer from './CrewfitOrderDrawer'

const fmt = (v) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v || 0)
const toneVar = { danger: 'var(--danger)', warning: 'var(--warning)', info: 'var(--info)', primary: 'var(--primary)', muted: 'var(--text-muted)' }

function daysLabel(dstr) {
  if (!dstr) return null
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const d = new Date(dstr + 'T00:00:00')
  const diff = Math.round((d - today) / 86400000)
  if (diff < 0) return { text: `${Math.abs(diff)}d overdue`, tone: 'danger' }
  if (diff === 0) return { text: 'Due today', tone: 'danger' }
  if (diff <= 2) return { text: `In ${diff}d`, tone: 'warning' }
  return { text: `In ${diff}d`, tone: 'muted' }
}

export default function CrewfitDashboard() {
  const apiFetch = useApi()
  const navigate = useNavigate()
  const [stats, setStats] = useState(null)
  const [reminders, setReminders] = useState(null)
  const [loading, setLoading] = useState(true)
  const [target, setTarget] = useState(null)

  useEffect(() => { load() }, [])
  const load = async () => {
    setLoading(true)
    const [s, r] = await Promise.all([apiFetch('/api/crewfit/stats'), apiFetch('/api/crewfit/reminders')])
    setStats(s); setReminders(r); setLoading(false)
  }

  if (loading) return <div className="loader"><div className="spinner" /><span>Loading follow-ups…</span></div>

  const kpis = (stats && typeof stats.total === 'number') ? [
    // Units ride inside the orders card — 12 orders can be 20 pieces or 2,000, but it isn't a
    // headline number in its own right.
    { icon: '📦', label: 'Total Orders', value: stats.total, sub: `${(stats.totalUnits ?? 0).toLocaleString('en-IN')} units`, tone: 'primary' },
    { icon: '🔄', label: 'Active (in pipeline)', value: stats.active, sub: `${(stats.activeUnits ?? 0).toLocaleString('en-IN')} units`, tone: 'info' },
    { icon: '✅', label: 'Dispatched', value: stats.dispatched, tone: 'success' },
    { icon: '💰', label: 'Pending Payments', value: fmt(stats.pendingPayments), tone: 'warning' },
  ] : []

  return (
    <div className="page-enter">
      <div className="page-header">
        <h1>Crewfit · Follow-ups</h1>
        <p>Everything that needs your attention — reminders start 2 days ahead.</p>
      </div>

      <div className="kpi-grid">
        {kpis.map((k, i) => (
          <div className="kpi-card" key={i}>
            <div className="kpi-head"><div className="kpi-icon">{k.icon}</div></div>
            <div className="kpi-value" style={{ fontSize: typeof k.value === 'string' ? 22 : 30 }}>
              {k.value}{k.sub && <span className="kpi-sub">{k.sub}</span>}
            </div>
            <div className="kpi-label">{k.label}</div>
          </div>
        ))}
      </div>

      <div className="reminders-grid">
        {(reminders?.groups || []).map(g => (
          <div className="panel reminder-panel" key={g.key} style={{ '--tone': toneVar[g.tone] }}>
            <div className="panel-head reminder-head">
              <div className="reminder-title"><span className="reminder-ico">{g.icon}</span><span className="panel-title">{g.label}</span></div>
              <span className="reminder-count">{g.count}</span>
            </div>
            <div className="reminder-body">
              {(g.orders || []).length === 0 ? (
                <div className="reminder-empty">✓ All clear</div>
              ) : (g.orders || []).slice(0, 8).map(o => {
                const dl = daysLabel(o.deadline_at)
                const showDue = g.key === 'readyToCollect'
                const due = o.payment_status === '50% Paid' ? o.balance : o.grand_total
                const items = Array.isArray(o.line_items) ? o.line_items : []
                const photographed = items.filter(it => (it.prodImages || []).length > 0).length
                return (
                  <div className="reminder-row" key={o.id} onClick={() => setTarget(o)}>
                    <div className="reminder-cust">
                      <div className="reminder-name">{o.customer_name}</div>
                      <div className="reminder-sub">#{o.sl_no} · {o.status} · {o.payment_status}</div>
                    </div>
                    <div className="reminder-meta">
                      {g.key === 'trackingPending' ? (
                        <div className="reminder-amt" style={{ fontSize: 12 }}>{o.tracking_link || '—'}{o.mot ? ` · ${o.mot}` : ''}</div>
                      ) : g.key === 'photosPending' ? (
                        <div className="reminder-amt" style={{ fontSize: 12 }}>📸 {photographed}/{items.length} products photographed</div>
                      ) : (
                        <div className="reminder-amt">{showDue ? `Due: ${fmt(due)}` : fmt(o.total_cost)}</div>
                      )}
                      {dl && <span className="reminder-chip" style={{ color: toneVar[dl.tone], background: 'color-mix(in srgb,' + toneVar[dl.tone] + ' 14%, transparent)' }}>{dl.text}</span>}
                    </div>
                  </div>
                )
              })}
              {(g.orders || []).length > 8 && <div className="reminder-more" onClick={() => navigate('/crewfit/orders')}>+{(g.orders || []).length - 8} more →</div>}
            </div>
          </div>
        ))}
      </div>

      <CrewfitOrderDrawer target={target} onClose={() => setTarget(null)} onSaved={() => { setTarget(null); load() }} />
    </div>
  )
}
