import { useState, useEffect } from 'react'
import { useApi } from '../App'

/**
 * Meta ads daily report.
 *
 * Read-only on purpose: nothing here is entered in the CRM. A scheduled Claude task posts the
 * day's numbers to /api/meta-ads-reports overnight and this page reads back the latest one, so
 * the page's job is to make the state of the account legible — not to edit it.
 *
 * The scorecard leads because that is the "should I worry today" question; the action items sit
 * directly under it because they are the answer when it is yes.
 */

const money = (v) => v === null || v === undefined
  ? '—'
  : new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(v))
const dec = (v, p = 2) => v === null || v === undefined ? '—' : Number(v).toFixed(p)
const pct = (v) => v === null || v === undefined ? '—' : `${Number(v).toFixed(2)}%`
const whole = (v) => v === null || v === undefined ? '—' : Math.round(Number(v)).toLocaleString('en-IN')

// green / amber / red arrive already decided by the sender — the CRM doesn't second-guess the
// thresholds, it only colours them.
const Pill = ({ status }) => {
  if (!status) return null
  const cls = status === 'green' ? 'fulfilled' : status === 'red' ? 'refunded' : 'pending'
  return <span className={`status-badge ${cls}`}>{status}</span>
}

export default function MetaAds() {
  const apiFetch = useApi()
  const [data, setData] = useState(null)
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [tab, setTab] = useState('campaigns')

  const load = async () => {
    setLoading(true); setError(null)
    const r = await apiFetch('/api/meta-ads')
    if (!r || r.error) {
      // A 404 is the ordinary "nothing has been posted yet" case, not a failure worth shouting about.
      setError(r?.status === 404 ? 'none' : (r?.error || 'Could not load the report'))
      setLoading(false)
      return
    }
    setData(r)
    const h = await apiFetch('/api/meta-ads/history?days=30')
    if (h && !h.error) setHistory(h)
    setLoading(false)
  }

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <div className="loader"><div className="spinner" /><span>Loading ads report…</span></div>

  if (error === 'none') return (
    <div className="page-enter">
      <div className="page-header"><h1>Meta Ads</h1><p>Daily report from the Meta ad account</p></div>
      <div className="empty-state">
        <div className="empty-icon">📡</div>
        <h3>No report received yet</h3>
        <p>The scheduled job posts the day's numbers to <code>/api/meta-ads-reports</code>.
          Once the first one lands, it shows up here.</p>
      </div>
    </div>
  )

  if (error) return <div className="page-enter"><div className="login-error" style={{ maxWidth: 480 }}>{error}</div></div>

  const r = data.report
  const s = data.campaigns || []
  const ads = data.ads || []
  const actions = data.action_items || []

  const kpis = [
    { label: 'ROAS', value: dec(r.roas_today), sub: `${dec(r.roas_avg_7d)} avg 7d`, status: r.roas_status },
    { label: 'Spend', value: money(r.spend_today), sub: `${money(r.spend_avg_7d_daily)}/day avg 7d` },
    { label: 'Revenue', value: money(r.revenue_today), sub: `${money(r.revenue_avg_7d_daily)}/day avg 7d` },
    { label: 'Purchases', value: whole(r.purchases_today), sub: `${dec(r.purchases_avg_7d_daily, 1)}/day avg 7d` },
    { label: 'CPA', value: money(r.cpa_today), sub: `${money(r.cpa_avg_7d)} avg 7d`, status: r.cpa_status },
    { label: 'Frequency', value: dec(r.frequency_today), sub: `${dec(r.frequency_avg_7d)} avg 7d`, status: r.frequency_status },
  ]

  const maxRoas = history.length ? Math.max(...history.map(h => Number(h.roas_today) || 0), 1) : 1

  return (
    <div className="page-enter">
      <div className="page-header">
        <h1>Meta Ads</h1>
        <p>
          Account {r.account_id} · report for {r.report_date}
          {r.window_7d_start && <> · 7-day window {r.window_7d_start} → {r.window_7d_end}</>}
        </p>
      </div>

      <div className="kpi-grid">
        {kpis.map((k, i) => (
          <div className="kpi-card" key={i}>
            <div className="kpi-head">
              <div className="kpi-label">{k.label}</div>
              <Pill status={k.status} />
            </div>
            <div className="kpi-value">{k.value}</div>
            <div className="kpi-label" style={{ color: 'var(--text-muted)' }}>{k.sub}</div>
          </div>
        ))}
      </div>

      {actions.length > 0 && (
        <div className="glass-card" style={{ marginTop: 24 }}>
          <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 14 }}>
            Needs attention <span className="tab-badge">{actions.length}</span>
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {actions.map((a) => (
              <div key={a.id} style={{
                padding: '12px 14px', borderRadius: 'var(--radius-md)',
                background: 'var(--danger-bg)', borderLeft: '3px solid var(--danger)',
              }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                  {a.entity_name}
                  <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 13 }}>
                    {' '}· {a.metric?.toUpperCase()} {dec(a.value)} vs {dec(a.threshold)} threshold
                  </span>
                </div>
                <div style={{ fontSize: 13.5, color: 'var(--text-secondary)' }}>{a.message}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {history.length > 1 && (
        <div className="panel" style={{ marginTop: 24 }}>
          <div className="panel-head">
            <div>
              <div className="panel-title">Daily ROAS</div>
              <div className="panel-sub">Last {history.length} reports</div>
            </div>
          </div>
          <div className="panel-body">
            <div className="chart">
              {history.map((h, i) => (
                <div key={i} className="chart-bar"
                  style={{ height: `${Math.max((Number(h.roas_today) / maxRoas) * 100, 1.5)}%` }}
                  title={`${h.report_date} — ROAS ${dec(h.roas_today)} · ${money(h.spend_today)} spend`} />
              ))}
            </div>
            <div className="chart-axis">
              <span>{history[0]?.report_date}</span>
              <span>{history[history.length - 1]?.report_date}</span>
            </div>
          </div>
        </div>
      )}

      <div className="scan-tabs" style={{ margin: '24px 0 14px' }}>
        <button className={tab === 'campaigns' ? 'active' : ''} onClick={() => setTab('campaigns')}>
          Campaigns <span className="tab-badge">{s.length}</span>
        </button>
        <button className={tab === 'ads' ? 'active' : ''} onClick={() => setTab('ads')}>
          Ads <span className="tab-badge">{ads.length}</span>
        </button>
      </div>

      <div className="data-table-wrapper">
        {tab === 'campaigns' ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>Campaign</th>
                <th style={{ textAlign: 'right' }}>Budget/day</th>
                <th style={{ textAlign: 'right' }}>ROAS 7d</th>
                <th style={{ textAlign: 'right' }}>Δ vs prev</th>
                <th style={{ textAlign: 'right' }}>CPA</th>
                <th style={{ textAlign: 'right' }}>CTR</th>
                <th style={{ textAlign: 'right' }}>CPM</th>
                <th style={{ textAlign: 'right' }}>Freq</th>
                <th style={{ textAlign: 'right' }}>Purch.</th>
                <th style={{ textAlign: 'right' }}>Spend 7d</th>
                <th style={{ textAlign: 'right' }}>Net profit</th>
              </tr>
            </thead>
            <tbody>
              {s.map((c) => {
                const delta = c.roas_delta === null ? null : Number(c.roas_delta)
                const profit = c.net_profit_7d === null ? null : Number(c.net_profit_7d)
                return (
                  <tr key={c.id}>
                    <td style={{ fontWeight: 600 }}>{c.name}</td>
                    <td style={{ textAlign: 'right' }}>{money(c.daily_budget)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <span style={{ marginRight: 6 }}>{dec(c.roas_7d)}</span><Pill status={c.roas_status} />
                    </td>
                    <td style={{ textAlign: 'right', color: delta === null ? 'var(--text-muted)' : delta >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                      {delta === null ? '—' : `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <span style={{ marginRight: 6 }}>{money(c.cpa_7d)}</span><Pill status={c.cpa_status} />
                    </td>
                    <td style={{ textAlign: 'right' }}>{pct(c.ctr_7d)}</td>
                    <td style={{ textAlign: 'right' }}>{money(c.cpm_7d)}</td>
                    <td style={{ textAlign: 'right' }}>{dec(c.frequency_7d)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{whole(c.purchases_7d)}</td>
                    <td style={{ textAlign: 'right' }}>{money(c.spend_7d)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: profit === null ? 'var(--text-muted)' : profit >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                      {money(c.net_profit_7d)}
                    </td>
                  </tr>
                )
              })}
              {s.length === 0 && <tr><td colSpan={11} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No campaigns in this report</td></tr>}
            </tbody>
          </table>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Ad</th>
                <th>Campaign</th>
                <th style={{ textAlign: 'right' }}>ROAS 7d</th>
                <th style={{ textAlign: 'right' }}>CPA</th>
                <th style={{ textAlign: 'right' }}>CTR</th>
                <th style={{ textAlign: 'right' }}>CPM</th>
                <th style={{ textAlign: 'right' }}>Freq</th>
                <th style={{ textAlign: 'right' }}>Purch.</th>
                <th style={{ textAlign: 'right' }}>Spend 7d</th>
              </tr>
            </thead>
            <tbody>
              {ads.map((a) => (
                <tr key={a.id}>
                  <td style={{ fontWeight: 600 }}>{a.name}</td>
                  <td style={{ color: 'var(--text-secondary)' }}>{a.campaign_name}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{dec(a.roas_7d)}</td>
                  <td style={{ textAlign: 'right' }}>{money(a.cpa_7d)}</td>
                  <td style={{ textAlign: 'right' }}>
                    <span style={{ marginRight: 6 }}>{pct(a.ctr_7d)}</span><Pill status={a.ctr_status} />
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span style={{ marginRight: 6 }}>{money(a.cpm_7d)}</span><Pill status={a.cpm_status} />
                  </td>
                  <td style={{ textAlign: 'right' }}>{dec(a.frequency_7d)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{whole(a.purchases_7d)}</td>
                  <td style={{ textAlign: 'right' }}>{money(a.spend_7d)}</td>
                </tr>
              ))}
              {ads.length === 0 && <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No ads in this report</td></tr>}
            </tbody>
          </table>
        )}
      </div>

      <p style={{ marginTop: 16, fontSize: 12.5, color: 'var(--text-muted)' }}>
        Received {r.received_at ? new Date(r.received_at).toLocaleString('en-IN') : '—'}
      </p>
    </div>
  )
}
