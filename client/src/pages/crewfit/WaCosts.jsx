import { useEffect, useMemo, useState } from 'react'
import { useApi } from '../../App'
import { useWaBrand } from './waBrand'
import { Head, Loading } from './waSettingsUi'

/**
 * What WhatsApp costs, from Meta's own figures, for Crewfit's number and Normless's.
 *
 * Meta charges per delivered template, by category; replies inside the 24-hour window and
 * everything in the 72 hours after an ad are free. The page shows what was charged, what went
 * free and why, the average rate per category, the cost day by day, and — from the CRM's own
 * records — which of our messages the charges came from.
 */

const CATEGORY = {
  marketing: { label: 'Marketing', color: '#f472b6', what: 'Offers, cart reminders, campaigns and anything that sells. Charged for every delivered message, except in the 72 hours after a customer comes from an ad.' },
  marketing_lite: { label: 'Marketing (lite)', color: '#fb923c', what: 'Marketing messages sent through the lite API. Charged like marketing.' },
  utility: { label: 'Utility', color: '#60a5fa', what: 'Order updates, payment links, delivery notes. Free when sent inside the 24 hours after the customer last wrote; charged outside it.' },
  authentication: { label: 'Authentication', color: '#a78bfa', what: 'One-time codes for logging in. Always charged.' },
  authentication_international: { label: 'Authentication (international)', color: '#c084fc', what: 'One-time codes to numbers in other countries, at Meta’s international rate.' },
  service: { label: 'Service', color: '#34d399', what: 'Anything typed back inside the 24-hour window — free.' },
  referral_conversion: { label: 'Ad referral', color: '#2dd4bf', what: 'Conversations started from a click-to-WhatsApp ad.' },
}
const look = (c) => CATEGORY[c] || { label: c, color: '#94a3b8', what: '' }
const SENDER = { team: 'Typed by the team', bot: 'Bot and automatic messages', phone: 'Sent from the WhatsApp phone app' }

const pad = (n) => String(n).padStart(2, '0')
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const PRESETS = [
  ['month', 'This month', () => { const n = new Date(); return [iso(new Date(n.getFullYear(), n.getMonth(), 1)), iso(n)] }],
  ['last', 'Last month', () => { const n = new Date(); return [iso(new Date(n.getFullYear(), n.getMonth() - 1, 1)), iso(new Date(n.getFullYear(), n.getMonth(), 0))] }],
  ['30', 'Last 30 days', () => { const n = new Date(); return [iso(new Date(n.getFullYear(), n.getMonth(), n.getDate() - 29)), iso(n)] }],
  ['90', 'Last 90 days', () => { const n = new Date(); return [iso(new Date(n.getFullYear(), n.getMonth(), n.getDate() - 89)), iso(n)] }],
  ['year', 'This year', () => { const n = new Date(); return [iso(new Date(n.getFullYear(), 0, 1)), iso(n)] }],
]

const count = (v) => new Intl.NumberFormat('en-IN').format(Math.round(Number(v) || 0))
const shortDate = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
const longDate = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })

/** Sum the brands' figures into one, for "Both". Only when they bill in the same currency. */
function combine(list) {
  const totals = { cost: 0, charged: 0, free: 0, free_service: 0, free_entry: 0 }
  const cats = new Map()
  const days = new Map()
  const senders = new Map()
  for (const b of list) {
    for (const k of Object.keys(totals)) totals[k] += b.totals[k] || 0
    for (const c of b.byCategory) {
      const o = cats.get(c.category) || { category: c.category, charged: 0, free_service: 0, free_entry: 0, cost: 0 }
      o.charged += c.charged; o.free_service += c.free_service; o.free_entry += c.free_entry; o.cost += c.cost
      cats.set(c.category, o)
    }
    for (const d of b.series) {
      const o = days.get(d.date) || { date: d.date, cost: 0, charged: 0, free: 0, byCategory: {} }
      o.cost += d.cost; o.charged += d.charged; o.free += d.free
      for (const [k, v] of Object.entries(d.byCategory)) o.byCategory[k] = (o.byCategory[k] || 0) + v
      days.set(d.date, o)
    }
    for (const s of b.senders) {
      const key = `${s.sender}|${s.category}`
      const o = senders.get(key) || { ...s, sent: 0, billed: 0, templates: 0, estimate: null }
      o.sent += s.sent; o.billed += s.billed; o.templates += s.templates
      if (s.estimate != null) o.estimate = (o.estimate || 0) + s.estimate
      senders.set(key, o)
    }
  }
  return {
    totals,
    byCategory: [...cats.values()].map(c => ({ ...c, rate: c.charged ? c.cost / c.charged : null })).sort((a, b) => b.cost - a.cost),
    series: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    senders: [...senders.values()],
    sendersSince: list.map(b => b.sendersSince).filter(Boolean).sort()[0] || null,
  }
}

/** Days into weeks or months when there are too many to read as bars. */
function bucket(series) {
  if (series.length <= 31) return series.map(d => ({ ...d, label: shortDate(d.date), title: longDate(d.date) }))
  const monthly = series.length > 120
  const out = new Map()
  for (const d of series) {
    const dt = new Date(`${d.date}T00:00:00`)
    const start = monthly ? new Date(dt.getFullYear(), dt.getMonth(), 1) : new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() - ((dt.getDay() + 6) % 7))
    const key = iso(start)
    const o = out.get(key) || { date: key, cost: 0, charged: 0, free: 0, byCategory: {}, last: d.date }
    o.cost += d.cost; o.charged += d.charged; o.free += d.free; o.last = d.date
    for (const [k, v] of Object.entries(d.byCategory)) o.byCategory[k] = (o.byCategory[k] || 0) + v
    out.set(key, o)
  }
  return [...out.values()].map(o => ({
    ...o,
    label: monthly ? new Date(`${o.date}T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }) : shortDate(o.date),
    title: monthly ? new Date(`${o.date}T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) : `Week of ${longDate(o.date)}`,
  }))
}

export function WaCostsTab() {
  const apiFetch = useApi()
  const brand = useWaBrand()
  const [preset, setPreset] = useState('month')
  const [range, setRange] = useState(() => PRESETS[0][2]())
  const [show, setShow] = useState('both')
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [hover, setHover] = useState(null)

  useEffect(() => {
    let live = true
    setLoading(true); setError('')
    apiFetch(`${brand.api}/admin/costs?from=${range[0]}&to=${range[1]}`).then(r => {
      if (!live) return
      if (!r || r.error) { setError(r?.error || 'Could not load the costs'); setData(null) } else setData(r)
      setLoading(false)
    })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range[0], range[1]])

  const ready = (data?.brands || []).filter(b => b.connected && !b.error)
  const currencies = [...new Set(ready.map(b => b.currency))]
  const view = useMemo(() => {
    if (!data) return null
    if (show === 'both') return currencies.length <= 1 ? combine(ready) : null
    const b = data.brands.find(x => x.brand === show)
    return b && b.connected && !b.error ? b : null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, show])
  const currency = show === 'both' ? (currencies[0] || 'INR') : (data?.brands.find(b => b.brand === show)?.currency || 'INR')
  const money = (v, digits = 2) => new Intl.NumberFormat('en-IN', { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Number(v) || 0)
  const shown = show === 'both' ? data?.brands || [] : (data?.brands || []).filter(b => b.brand === show)
  const problems = shown.filter(b => !b.connected || b.error)

  const bars = view ? bucket(view.series) : []
  const top = Math.max(...bars.map(b => b.cost), 0)
  const chartCats = view ? view.byCategory.filter(c => c.cost > 0).map(c => c.category) : []

  return (
    <>
      <Head title="WhatsApp costs">
        What Meta charges for each number, from its own figures. Meta counts a message when it is delivered and bills the
        approximate amount shown here on its monthly invoice.
      </Head>

      <div className="was-card wac">
        <div className="voa-head">
          <div className="voa-controls">
            <div className="voa-seg" role="group" aria-label="Which number">
              {[['both', 'Both'], ['crewfit', 'Crewfit'], ['normless', 'Normless']].map(([k, label]) => (
                <button key={k} type="button" className={show === k ? 'active' : ''} aria-pressed={show === k} onClick={() => setShow(k)}>{label}</button>
              ))}
            </div>
          </div>
          <div className="voa-controls">
            <div className="voa-seg wac-presets" role="group" aria-label="Dates">
              {PRESETS.map(([k, label, get]) => (
                <button key={k} type="button" className={preset === k ? 'active' : ''} aria-pressed={preset === k}
                  onClick={() => { setPreset(k); setRange(get()) }}>{label}</button>
              ))}
            </div>
            <label className="wac-date">From
              <input type="date" value={range[0]} max={range[1]} onChange={e => { if (e.target.value) { setPreset(''); setRange([e.target.value, range[1]]) } }} />
            </label>
            <label className="wac-date">To
              <input type="date" value={range[1]} min={range[0]} onChange={e => { if (e.target.value) { setPreset(''); setRange([range[0], e.target.value]) } }} />
            </label>
          </div>
        </div>

        {loading ? <Loading /> : error ? <p className="voa-warn">{error}</p> : (
          <>
            {problems.map(b => <p key={b.brand} className="voa-warn"><b>{b.name}:</b> {b.error}</p>)}
            {show === 'both' && currencies.length > 1 && (
              <p className="voa-warn">The two numbers are billed in different currencies ({currencies.join(' and ')}), so they can’t be added up. Pick one number.</p>
            )}
            {view && (
              <>
                <div className="voa-kpis">
                  <div className="voa-kpi"><span>Charged by Meta</span><b>{money(view.totals.cost)}</b>
                    <em>{longDate(range[0])} – {longDate(range[1])}</em></div>
                  <div className="voa-kpi"><span>Messages charged</span><b>{count(view.totals.charged)}</b>
                    <em>{view.totals.charged ? `${money(view.totals.cost / view.totals.charged)} a message on average` : 'Nothing charged'}</em></div>
                  <div className="voa-kpi voa-k-paid"><span>Messages free</span><b>{count(view.totals.free)}</b>
                    <em>{count(view.totals.free_service)} in the 24-hour window · {count(view.totals.free_entry)} after an ad</em></div>
                  <div className="voa-kpi"><span>Share that was free</span>
                    <b>{view.totals.free + view.totals.charged ? Math.round((view.totals.free / (view.totals.free + view.totals.charged)) * 100) : 0}<small>%</small></b>
                    <em>of {count(view.totals.free + view.totals.charged)} delivered</em></div>
                </div>

                {show === 'both' && ready.length > 1 && (
                  <div className="wac-split">
                    {ready.map(b => (
                      <button key={b.brand} type="button" className="wac-line" onClick={() => setShow(b.brand)} title={`Show only ${b.name}`}>
                        <span>{b.name}{b.number ? ` · ${b.number}` : ''}</span>
                        <b>{money(b.totals.cost)}</b>
                        <em>{count(b.totals.charged)} charged · {count(b.totals.free)} free</em>
                        <span className="voa-meter"><span style={{ width: `${view.totals.cost ? (b.totals.cost / view.totals.cost) * 100 : 0}%` }} /></span>
                      </button>
                    ))}
                  </div>
                )}

                <div className="voa-chart">
                  <div className="wac-chart-head">
                    <h3>Cost over time</h3>
                    <div className="voa-legend">
                      {chartCats.map(c => <span key={c}><i style={{ background: look(c).color }} />{look(c).label}</span>)}
                    </div>
                  </div>
                  {top === 0 ? <p className="voa-muted">Nothing was charged in these dates.</p> : (
                    <div className="voa-bars" style={{ gridTemplateColumns: `repeat(${bars.length}, minmax(0, 1fr))` }}>
                      {bars.map((b, i) => (
                        <div key={b.date} className={`voa-col${hover === i ? ' on' : ''}`} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
                          tabIndex={0} onFocus={() => setHover(i)} onBlur={() => setHover(null)} aria-label={`${b.title}: ${money(b.cost)}`}>
                          <div className="voa-stack" style={{ height: `${(b.cost / top) * 100}%` }}>
                            {chartCats.map(c => b.byCategory[c] > 0 && <span key={c} style={{ flex: b.byCategory[c], background: look(c).color }} />)}
                          </div>
                          {(bars.length <= 16 || i % Math.ceil(bars.length / 12) === 0) && <span className="voa-x">{b.label}</span>}
                          {hover === i && (
                            <div className={`voa-tip${i > bars.length / 2 ? ' left' : ''}`}>
                              <b>{b.title}</b>
                              <span>{money(b.cost)} · {count(b.charged)} charged · {count(b.free)} free</span>
                              {chartCats.filter(c => b.byCategory[c] > 0).map(c => <span key={c}>{look(c).label}: {money(b.byCategory[c])}</span>)}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="data-table-wrapper">
                  <table className="data-table">
                    <thead><tr>
                      <th>Kind of message</th><th className="num">Charged</th><th className="num">Free (24-hour window)</th>
                      <th className="num">Free (after an ad)</th><th className="num">Cost</th><th className="num">Per charged message</th>
                    </tr></thead>
                    <tbody>
                      {!view.byCategory.length && <tr><td colSpan={6} className="voa-muted">Meta has no messages for these dates.</td></tr>}
                      {view.byCategory.map(c => (
                        <tr key={c.category}>
                          <td><span className="cell-primary"><i className="wac-dot" style={{ background: look(c.category).color }} />{look(c.category).label}</span>
                            <div className="voa-muted">{look(c.category).what}</div></td>
                          <td className="num">{count(c.charged)}</td>
                          <td className="num">{count(c.free_service)}</td>
                          <td className="num">{count(c.free_entry)}</td>
                          <td className="num"><b>{money(c.cost)}</b></td>
                          <td className="num">{c.rate != null ? money(c.rate, 4) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="voa-split">
                  <div className="voa-products">
                    <h4>Where the charges came from</h4>
                    {!view.senders.length ? (
                      <p className="voa-muted" style={{ margin: 0 }}>
                        The CRM started noting how Meta prices each message with this update, so this fills in from messages sent from now on.
                      </p>
                    ) : (
                      <>
                        <ul>
                          {view.senders.filter(s => s.sent).sort((a, b) => (b.estimate || 0) - (a.estimate || 0) || b.sent - a.sent).map(s => (
                            <li key={`${s.sender}|${s.category}`} className="wac-sender">
                              <div className="voa-prow">
                                <span>{SENDER[s.sender] || s.sender} · {look(s.category).label}</span>
                                <b>{s.estimate != null ? `≈ ${money(s.estimate)}` : s.billed ? '—' : 'Free'}</b>
                              </div>
                              <div className="voa-muted">{count(s.sent)} sent · {count(s.billed)} charged{s.templates ? ` · ${count(s.templates)} templates` : ''}</div>
                            </li>
                          ))}
                        </ul>
                        <p className="voa-muted" style={{ margin: '10px 0 0' }}>
                          Estimated: the CRM’s own messages priced at Meta’s average rate above.
                          {view.sendersSince ? ` Recorded since ${longDate(String(view.sendersSince).slice(0, 10))}.` : ''}
                        </p>
                      </>
                    )}
                  </div>
                  <div className="voa-products">
                    <h4>How WhatsApp charges</h4>
                    <ul className="wac-rules">
                      <li><b>Per delivered message.</b> Meta charges each template when it reaches the customer, never for one that fails.</li>
                      <li><b>Replies are free for 24 hours.</b> Once a customer writes, anything typed back — and utility templates — cost nothing until 24 hours after their last message.</li>
                      <li><b>Ad leads are free for 72 hours.</b> A customer who comes from a click-to-WhatsApp ad can be sent anything, templates included, for 72 hours if we reply within the first 24.</li>
                      <li><b>Marketing is always charged</b> outside those 72 hours, even while the chat is open.</li>
                      <li><b>Rates depend on the customer’s country and the category</b>, and utility and authentication rates drop as the month’s volume grows. The “per charged message” column is what Meta actually charged us.</li>
                    </ul>
                    <a className="wac-link" href="https://developers.facebook.com/docs/whatsapp/pricing" target="_blank" rel="noreferrer">Meta’s current rate card ↗</a>
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </>
  )
}
