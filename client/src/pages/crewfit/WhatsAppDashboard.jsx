import { useState, useEffect } from 'react'
import { NavLink, Link, useSearchParams } from 'react-router-dom'
import { useApi, useAuth, useMainMenu } from '../../App'
import Icon from '../../components/Icon'
import { WA_BRANDS, WaBrandContext } from './waBrand'

/**
 * WhatsApp › Dashboard, for either brand, and a Crewfit salesperson's own page.
 *
 * Normless: how much the menu/bot settled on its own, what went to the team and how fast they
 * answered, what customers asked about, carts and order messages, calls, and each person.
 * Crewfit: orders and units closed per salesperson, leads, replies and calls. Everyone on
 * Crewfit's inbox also has "My performance" — their own orders, units and the chats waiting on them.
 *
 * Every number comes from /dashboard (or /dashboard/me) for the chosen dates; each headline is set
 * against the same number of days just before.
 */

const DAY = 86400000
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const today = () => new Date()

const PRESETS = {
  normless: [
    ['today', 'Today', () => [today(), today()]],
    ['7d', 'Last 7 days', () => [new Date(Date.now() - 6 * DAY), today()]],
    ['30d', 'Last 30 days', () => [new Date(Date.now() - 29 * DAY), today()]],
  ],
  crewfit: [
    ['week', 'This week', () => { const d = today(); return [new Date(d.getTime() - ((d.getDay() + 6) % 7) * DAY), d] }],
    ['month', 'This month', () => { const d = today(); return [new Date(d.getFullYear(), d.getMonth(), 1), d] }],
    ['last', 'Last month', () => { const d = today(); return [new Date(d.getFullYear(), d.getMonth() - 1, 1), new Date(d.getFullYear(), d.getMonth(), 0)] }],
  ],
}

const inr = (v) => {
  const x = Number(v) || 0
  if (x >= 1e7) return `₹${(x / 1e7).toFixed(2)} Cr`
  if (x >= 1e5) return `₹${(x / 1e5).toFixed(2)} L`
  return `₹${Math.round(x).toLocaleString('en-IN')}`
}
const num = (v) => (v == null ? '—' : Number(v).toLocaleString('en-IN'))
const secs = (s) => {
  if (s == null) return '—'
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`
  return `${Math.round(s / 86400)}d`
}
const pct = (v) => (v == null ? '—' : `${v}%`)
const fmtDay = (s) => new Date(`${s}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
const fmtDayW = (s) => new Date(`${s}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric' })
const ago = (t) => {
  if (!t) return ''
  const m = Math.round((Date.now() - new Date(t)) / 60000)
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
}

const overAnHour = (t) => !!t && Date.now() - new Date(t) > 3600000

/** The change from the period before, coloured by whether it's good news. */
function Delta({ now, before, better = 'up', format = (d) => num(d), unit = '' }) {
  if (now == null || before == null || (Number(before) === 0 && Number(now) === 0)) return null
  const d = Number(now) - Number(before)
  if (!d) return <span className="wdb-delta">same as before</span>
  const good = better === 'up' ? d > 0 : d < 0
  return <span className={`wdb-delta ${good ? 'good' : 'bad'}`}>{d > 0 ? '▲' : '▼'} {format(Math.abs(d))}{unit}</span>
}

function Kpi({ label, value, children, hint }) {
  return (
    <div className="wdb-kpi" title={hint}>
      <span className="wdb-lbl">{label}</span>
      <span className="wdb-num">{value}</span>
      <span className="wdb-sub">{children}</span>
    </div>
  )
}

/** Stacked columns: each item { label, total, parts: [{ value, cls }] }. */
function Columns({ items, legend, empty = 'Nothing in these dates.' }) {
  const max = Math.max(1, ...items.map(i => i.total))
  if (!items.some(i => i.total)) return <p className="wdb-empty">{empty}</p>
  return (
    <>
      {legend && <div className="wdb-legend">{legend.map(([cls, label]) => <span key={label}><i className={cls} aria-hidden="true" />{label}</span>)}</div>}
      <div className="wdb-cols" role="img" aria-label={items.map(i => `${i.label}: ${i.total}`).join(', ')}>
        {items.map(i => (
          <div key={i.key || i.label} className="wdb-col" title={i.title || `${i.label}: ${i.total}`}>
            <span className="wdb-col-n">{i.top ?? (i.total || '')}</span>
            <div className="wdb-col-bar">
              {i.parts.map((p, k) => <div key={k} className={p.cls} style={{ height: `${(p.value / max) * 100}%` }} />)}
            </div>
            <span className="wdb-col-label">{i.label}</span>
          </div>
        ))}
      </div>
    </>
  )
}

function RangeBar({ brand, data, setRange }) {
  const [params] = useSearchParams()
  const presets = PRESETS[brand]
  const from = params.get('from') || data?.range?.from || ''
  const to = params.get('to') || data?.range?.to || ''
  const active = presets.find(([, , f]) => { const [a, b] = f(); return isoDay(a) === from && isoDay(b) === to })?.[0]
  return (
    <div className="wdb-range" role="group" aria-label="Dates">
      {presets.map(([key, label, f]) => (
        <button key={key} type="button" className={`chip${active === key ? ' chip-on' : ''}`} aria-pressed={active === key}
          onClick={() => { const [a, b] = f(); setRange(isoDay(a), isoDay(b)) }}>{label}</button>
      ))}
      <label className="wdb-date"><span className="sr-only">From</span><input type="date" value={from} max={to || undefined} onChange={e => e.target.value && setRange(e.target.value, to)} /></label>
      <span className="wdb-sub">to</span>
      <label className="wdb-date"><span className="sr-only">To</span><input type="date" value={to} min={from || undefined} onChange={e => e.target.value && setRange(from, e.target.value)} /></label>
    </div>
  )
}

/** The page frame: the same top bar as the inbox and settings, with Dashboard selected. */
/** What this person may open beside the inbox: each is its own permission (admins have all). */
function useWaGrants(brand) {
  const { user } = useAuth()
  const all = user?.role === 'owner' || user?.role === 'admin'
  const cf = brand.key === 'crewfit'
  return {
    dashboard: all || !!user?.[cf ? 'can_view_wa_dashboard' : 'can_view_wa_nl_dashboard'],
    settings: all || !!user?.[cf ? 'can_manage_wa_settings' : 'can_manage_wa_nl_settings'],
  }
}

function Frame({ brand, me, children }) {
  const { openMenu } = useMainMenu()
  const can = useWaGrants(brand)
  return (
    <WaBrandContext.Provider value={brand}>
      <div className="page wdb-page">
        <header className="wa-topbar">
          <button type="button" className="btn-icon wa-menu-btn" aria-label="Open the main menu" title="Main menu" onClick={openMenu}>
            <Icon name="dashboard" size={18} />
          </button>
          <h1>{brand.key === 'crewfit' ? 'WhatsApp' : `${brand.name} WhatsApp`}</h1>
          <nav className="wa-seg" aria-label="WhatsApp">
            <NavLink to={brand.path} end className="wa-seg-item">Inbox</NavLink>
            {can.dashboard && <NavLink to={`${brand.path}/dashboard`} className="wa-seg-item">Dashboard</NavLink>}
            {brand.key === 'crewfit' && <NavLink to={`${brand.path}/me`} className="wa-seg-item">{me ? 'My performance' : 'Performance'}</NavLink>}
            {can.settings && <NavLink to={`${brand.path}/settings`} className="wa-seg-item">Settings</NavLink>}
          </nav>
        </header>
        <div className="wdb-body">{children}</div>
      </div>
    </WaBrandContext.Provider>
  )
}

/** Loads one of the dashboard endpoints for the dates in the address. */
function useDash(url) {
  const apiFetch = useApi()
  const [params, setParams] = useSearchParams()
  const [state, setState] = useState({ data: null, error: null, key: null })
  const qs = params.toString()
  const key = `${url}?${qs}`
  useEffect(() => {
    let live = true
    apiFetch(`${url}${qs ? `?${qs}` : ''}`).then(r => {
      if (!live) return
      setState({ key, data: r && !r.error ? r : null, error: !r ? 'Could not reach the server' : r.error || null })
    })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const setRange = (from, to) => setParams(p => { const n = new URLSearchParams(p); n.set('from', from); n.set('to', to); return n })
  return { ...state, loading: state.key !== key, setRange }
}

/* ── Template messages ─────────────────────────────────────────────────────────────────────────
   Every template that went out in these dates — automatic, broadcasts, and ones people sent — and
   what WhatsApp did with it, like the old provider's log. */

const MSG_STATUS = {
  read: ['success', 'Read'], delivered: ['success', 'Delivered'], sent: ['', 'Sent'],
  restricted: ['error', 'Restricted'], failed: ['error', 'Not sent'],
}
const fmtStamp = (v) => new Date(v).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })

function MessageLog({ brand }) {
  const apiFetch = useApi()
  const [params] = useSearchParams()
  const [event, setEvent] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState(null)
  const qs = new URLSearchParams({ ...Object.fromEntries(params), ...(event ? { event } : {}), page: String(page) }).toString()
  useEffect(() => {
    let live = true
    apiFetch(`${brand.api}/dashboard/messages?${qs}`).then(r => { if (live) setData(r && !r.error ? r : { error: r?.error || 'Could not load the log' }) })
    return () => { live = false }
  }, [qs]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <div className="loader"><div className="spinner" /></div>
  if (data.error) return <section className="was-card"><p className="was-bad">{data.error}</p></section>
  const k = data.kpis
  const pages = Math.max(1, Math.ceil(data.total / data.per))
  return (
    <section className="was-card wdb-msglog">
      <div className="was-card-head">
        <h3>Template messages</h3>
        <label className="wdb-event">
          <span className="sr-only">Event</span>
          <select value={event} onChange={e => { setEvent(e.target.value); setPage(1) }} aria-label="Event">
            <option value="">All events ({data.events.reduce((n, e) => n + e.count, 0)})</option>
            {data.events.map(e => <option key={e.key} value={e.key}>{e.label} ({e.count})</option>)}
          </select>
        </label>
      </div>
      <div className="wdb-msgkpis">
        <div className="wdb-msgkpi"><Icon name="mail" size={16} /><span className="wdb-lbl">Sent</span><b>{num(k.sent)}</b></div>
        <div className="wdb-msgkpi good"><Icon name="check" size={16} /><span className="wdb-lbl">Delivered</span><b>{num(k.delivered)}</b></div>
        <div className="wdb-msgkpi read"><Icon name="eye" size={16} /><span className="wdb-lbl">Read</span><b>{num(k.read)}</b></div>
        <div className="wdb-msgkpi bad"><Icon name="alert" size={16} /><span className="wdb-lbl">Restricted / not sent</span><b>{num(k.restricted)}</b></div>
        <div className="wdb-msgkpi"><Icon name="trending" size={16} /><span className="wdb-lbl">Link clicked</span><b>{num(k.clicked)}</b></div>
        <div className="wdb-msgkpi good"><Icon name="wallet" size={16} /><span className="wdb-lbl">Revenue</span><b>{k.revenue ? inr(k.revenue) : '—'}</b></div>
      </div>
      <div className="data-table-wrapper wdb-table">
        <table className="data-table">
          <thead><tr><th scope="col">Date</th><th scope="col">Phone</th><th scope="col">Event</th><th scope="col">Revenue</th><th scope="col">Link clicked</th><th scope="col">Order</th><th scope="col">Status</th></tr></thead>
          <tbody>
            {data.rows.length ? data.rows.map((x, i) => (
              <tr key={i}>
                <td data-label="Date">{fmtStamp(x.at)}</td>
                <td data-label="Phone">{x.phone ? `+${x.phone}` : "—"}</td>
                <td data-label="Event">{x.label}{x.detail ? <span className="wdb-sub"> · {x.detail}</span> : null}</td>
                <td data-label="Revenue">{x.revenue ? inr(x.revenue) : '—'}</td>
                <td data-label="Link clicked">{x.clicked ? <span className="wdb-yes" aria-label="Clicked"><Icon name="check" size={14} /></span> : '—'}</td>
                <td data-label="Order">{x.order || '—'}</td>
                <td data-label="Status"><span className={`status-badge ${MSG_STATUS[x.status]?.[0] || ''}`} title={x.error || undefined}>{MSG_STATUS[x.status]?.[1] || x.status}</span>
                  {x.error && <span className="wdb-sub wdb-err">{x.error}</span>}</td>
              </tr>
            )) : <tr><td colSpan={7} className="wdb-empty">No template messages in these dates.</td></tr>}
          </tbody>
        </table>
      </div>
      {data.total > data.per && (
        <div className="wdb-pager">
          <span className="wdb-sub">Showing {(page - 1) * data.per + 1}–{Math.min(page * data.per, data.total)} of {data.total}</span>
          <button type="button" className="btn-icon" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>‹</button>
          <button type="button" className="btn-icon" aria-label="Next page" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>›</button>
        </div>
      )}
      <p className="wdb-sub">“Restricted” means WhatsApp held the message back (usually because that person has had a lot of marketing recently); it isn’t charged.</p>
    </section>
  )
}

/* ── Normless ─────────────────────────────────────────────────────────────────────────────── */

const NL_EVENTS = {
  order_prepaid: 'New prepaid order', order_partial_cod: 'New partial COD', order_cod: 'New COD order', cod_confirm: 'COD confirmation',
  order_cancelled: 'Order cancelled', fulfilled: 'Shipped with tracking', refund: 'Refund issued',
  cart_1: 'Reminder 1', cart_2: 'Reminder 2', cart_3: 'Reminder 3',
}

function NormlessDash({ d }) {
  const k = d.kpis
  const days = d.daily.map(x => ({
    key: x.day, label: d.daily.length > 14 ? fmtDay(x.day) : fmtDayW(x.day), total: x.total, title: `${fmtDay(x.day)}: ${x.total} chats, ${x.team} went to the team`,
    parts: [{ value: x.team, cls: 'c-team' }, { value: x.total - x.team, cls: 'c-bot' }],
  }))
  const topMax = Math.max(1, ...d.topics.map(t => t.count))
  const codTotal = d.orders.cod.sent || 0
  const noReply = Math.max(0, codTotal - d.orders.cod.confirmed - d.orders.cod.cancel)
  const hourMax = Math.max(1, ...d.hours.map(h => h.count))
  return (
    <>
      <section className="wdb-kpis" aria-label="Headline numbers">
        <Kpi label="Conversations" value={num(k.conversations.now)}><Delta now={k.conversations.now} before={k.conversations.before} /> chats with a customer message</Kpi>
        <Kpi label="Solved without a person" value={pct(k.solved_share.now)}><Delta now={k.solved_share.now} before={k.solved_share.before} unit=" pts" /> menu + bot</Kpi>
        <Kpi label="Went to the team" value={num(k.team.now)}><Delta now={k.team.now} before={k.team.before} better="down" /></Kpi>
        <Kpi label="First reply by a person" value={secs(k.first_reply_secs.now)} hint="Median wait from the customer's message, or the bot handing over, to a person's reply">
          <Delta now={k.first_reply_secs.now} before={k.first_reply_secs.before} better="down" format={secs} /> median
        </Kpi>
        <Kpi label="Waiting now" value={num(k.waiting.now)}>{k.waiting.oldest ? `oldest ${ago(k.waiting.oldest)}` : 'nobody waiting'}</Kpi>
        <Kpi label="Tickets from chats" value={num(k.tickets.now)}><Delta now={k.tickets.now} before={k.tickets.before} better="down" /> returns & damage</Kpi>
      </section>

      <div className="wdb-grid">
        <section className="was-card wdb-span2">
          <h3>Conversations per day</h3>
          <Columns items={days} legend={[['c-bot', 'Solved by the menu/bot'], ['c-team', 'Went to the team']]} />
        </section>
        <section className="was-card">
          <h3>What customers ask about</h3>
          <p className="wdb-sub">From the menu options they tapped.</p>
          {d.topics.every(t => !t.count) ? <p className="wdb-empty">No menu taps in these dates.</p> : d.topics.map(t => (
            <div key={t.key} className="wdb-hbar">
              <div className="wdb-hbar-row"><span>{t.label}</span><span className="wdb-sub">{t.count}{t.bot_share != null ? ` · ${t.bot_share}% by bot` : ''}</span></div>
              <div className="wdb-track"><div className={t.bot_share != null && t.bot_share < 50 ? 'c-team' : 'c-bot'} style={{ width: `${(t.count / topMax) * 100}%` }} /></div>
            </div>
          ))}
        </section>
      </div>

      <div className="wdb-grid">
        <section className="was-card">
          <div className="was-card-head"><h3>Abandoned carts</h3><Link to="/whatsapp/settings/templates" className="wdb-link">Settings</Link></div>
          <div className="wdb-mini">
            <div><span className="wdb-lbl">Carts from Razorpay</span><b>{num(d.carts.total)}</b></div>
            <div><span className="wdb-lbl">Ordered after a reminder</span><b>{num(d.carts.after_reminder)}{d.carts.total ? <small> {Math.round(d.carts.after_reminder / d.carts.total * 100)}%</small> : null}</b></div>
            <div><span className="wdb-lbl">Ordered (any way)</span><b>{num(d.carts.recovered)}</b></div>
            <div><span className="wdb-lbl">Value of those carts</span><b>{inr(d.carts.recovered_value)}</b></div>
          </div>
          <div className="wdb-list">
            {d.carts.reminders.map(r => <div key={r.event}><span>{NL_EVENTS[r.event]}</span><span className="wdb-sub">{num(r.sent)} sent · {num(r.ordered)} ordered</span></div>)}
            <div><span>Link taps</span><span className="wdb-sub">{num(d.carts.taps)}</span></div>
          </div>
        </section>

        <section className="was-card">
          <h3>Order messages</h3>
          <div className="wdb-list">
            {d.orders.messages.map(m => <div key={m.event}><span>{NL_EVENTS[m.event]}</span><span><b>{num(m.sent)}</b>{m.taps ? <span className="wdb-sub"> · {m.taps} taps</span> : null}</span></div>)}
          </div>
          <div className="wdb-split">
            <span className="wdb-lbl">COD confirmation replies</span>
            {codTotal ? (
              <>
                <div className="wdb-stack" role="img" aria-label={`${d.orders.cod.confirmed} confirmed, ${d.orders.cod.cancel} asked to cancel, ${noReply} no reply`}>
                  <div className="c-good" style={{ width: `${d.orders.cod.confirmed / codTotal * 100}%` }} />
                  <div className="c-bad" style={{ width: `${d.orders.cod.cancel / codTotal * 100}%` }} />
                  <div className="c-none" style={{ width: `${noReply / codTotal * 100}%` }} />
                </div>
                <div className="wdb-legend"><span><i className="c-good" />{d.orders.cod.confirmed} confirmed</span><span><i className="c-bad" />{d.orders.cod.cancel} asked to cancel</span><span><i className="c-none" />{noReply} no reply</span></div>
              </>
            ) : <p className="wdb-empty">None sent in these dates.</p>}
          </div>
          <p className="wdb-sub">Failed sends: <b className={d.orders.failed ? 'wdb-bad' : ''}>{d.orders.failed}</b> · Replied STOP: {d.orders.stops}</p>
        </section>

        <CallsCard c={d.calls}>
          <div className="wdb-split">
            <span className="wdb-lbl">Busiest hours (messages + calls)</span>
            <div className="wdb-hours" role="img" aria-label={d.hours.map(h => `${h.hour}:00 ${h.count}`).join(', ')}>
              {d.hours.map(h => <div key={h.hour} title={`${h.hour}:00 — ${h.count}`} className={h.count >= hourMax * 0.8 ? 'c-bot' : 'c-soft'} style={{ height: `${Math.max(4, (h.count / hourMax) * 100)}%` }} />)}
            </div>
            <div className="wdb-hours-axis"><span>8 am</span><span>3 pm</span><span>10 pm</span></div>
          </div>
        </CallsCard>
      </div>

      <section className="was-card">
        <div className="was-card-head"><h3>Team</h3><span className="wdb-sub">Chats the bot handed over, and how fast each person answered</span></div>
        <div className="data-table-wrapper wdb-table">
          <table className="data-table">
            <thead><tr><th scope="col">Person</th><th scope="col">Chats answered</th><th scope="col">First reply (median)</th><th scope="col">Closed</th><th scope="col">Tickets raised</th><th scope="col">Calls</th><th scope="col">Waiting on them</th></tr></thead>
            <tbody>
              {d.team.length ? d.team.map(p => (
                <tr key={p.username}><td data-label=""><b>{p.name}</b></td><td data-label="Chats answered">{p.chats}</td><td data-label="First reply">{secs(p.first_reply_secs)}</td>
                  <td data-label="Closed">{p.closed}</td><td data-label="Tickets raised">{p.tickets}</td><td data-label="Calls">{p.calls}</td>
                  <td data-label="Waiting on them"><span className={`status-badge ${p.waiting ? 'error' : ''}`}>{p.waiting}</span></td></tr>
              )) : <tr><td colSpan={7} className="wdb-empty">Nobody has the Normless WhatsApp permission yet — give it to the team in Admin.</td></tr>}
            </tbody>
          </table>
        </div>
        {k.waiting.nobody > 0 && <p className="wdb-sub">Waiting for nobody in particular: <b className="wdb-bad">{k.waiting.nobody} chat{k.waiting.nobody > 1 ? 's' : ''}</b> — nobody on the team was free when the bot handed {k.waiting.nobody > 1 ? 'them' : 'it'} over.</p>}
      </section>
    </>
  )
}

function CallsCard({ c, children }) {
  return (
    <section className="was-card">
      <h3>Calls</h3>
      <div className="wdb-mini">
        <div><span className="wdb-lbl">Customers called us</span><b>{num(c.came_in)}</b><span className="wdb-sub">{c.answered} answered{c.missed ? <> · <span className="wdb-bad">{c.missed} missed</span></> : null}</span></div>
        <div><span className="wdb-lbl">We called</span><b>{num(c.went_out)}</b><span className="wdb-sub">{c.connected} connected</span></div>
        <div><span className="wdb-lbl">Talk time</span><b>{secs(c.talk)}</b></div>
        <div><span className="wdb-lbl">Average call</span><b>{secs(c.avg)}</b>{c.quick_share != null && <span className="wdb-sub">{c.quick_share}% answered in 30s</span>}</div>
      </div>
      {children}
    </section>
  )
}

/* ── Crewfit ──────────────────────────────────────────────────────────────────────────────── */

const SO_COLORS = ['c-bot', 'c-blue', 'c-team', 'c-good', 'c-pink', 'c-soft']
const SOURCE_LABEL = { ads: 'Meta ads (click-to-WhatsApp)', whatsapp: 'Wrote to us on WhatsApp', order: 'Added from an order', other: 'Other' }

function CrewfitDash({ d, brand }) {
  const k = d.kpis
  const names = [...new Set(d.weekly.flatMap(w => Object.keys(w.by)))]
  const weeks = d.weekly.map(w => ({
    key: w.week, label: fmtDay(w.week), total: w.units, title: `Week of ${fmtDay(w.week)}: ${names.map(n => `${n} ${w.by[n] || 0}`).join(', ')}`,
    parts: names.slice().reverse().map(n => ({ value: w.by[n] || 0, cls: SO_COLORS[names.indexOf(n) % SO_COLORS.length] })),
  }))
  const topUnits = Math.max(1, ...d.team.map(t => t.units))
  const funnelMax = Math.max(1, ...d.funnel.map(f => f.count))
  const sum = (f) => d.team.reduce((s, t) => s + (Number(t[f]) || 0), 0)
  return (
    <>
      <section className="wdb-kpis" aria-label="Headline numbers">
        <Kpi label="Orders closed" value={num(k.orders.now)}><Delta now={k.orders.now} before={k.orders.before} /> vs the period before</Kpi>
        <Kpi label="Units" value={num(k.units.now)}><Delta now={k.units.now} before={k.units.before} /></Kpi>
        <Kpi label="Order value" value={inr(k.value.now)}><Delta now={k.value.now} before={k.value.before} format={inr} /> incl. GST</Kpi>
        <Kpi label="Collected" value={inr(k.collected.now)}><Delta now={k.collected.now} before={k.collected.before} format={inr} /> on these orders</Kpi>
        <Kpi label="New leads" value={num(k.leads.now)}><Delta now={k.leads.now} before={k.leads.before} /> {k.leads.from_ads ? `${k.leads.from_ads} from ads` : ''}</Kpi>
        <Kpi label="First reply" value={secs(k.first_reply_secs.now)} hint="Median wait from a customer's message to a person's reply">
          <Delta now={k.first_reply_secs.now} before={k.first_reply_secs.before} better="down" format={secs} /> median
        </Kpi>
      </section>

      <section className="was-card wdb-feature">
        <div className="was-card-head"><h3>Team performance</h3><span className="wdb-sub">Orders count for the salesperson written on the order (SO). Open a person for their own page.</span></div>
        <div className="data-table-wrapper wdb-table">
          <table className="data-table">
            <thead><tr>
              <th scope="col">Salesperson</th><th scope="col">Orders</th><th scope="col">Units</th><th scope="col">Order value</th><th scope="col">Avg order</th>
              <th scope="col">Collected</th><th scope="col">Chats</th><th scope="col">First reply</th><th scope="col">Calls</th><th scope="col"><span className="sr-only">Open</span></th>
            </tr></thead>
            <tbody>
              {d.team.length ? d.team.map(p => (
                <tr key={p.so}>
                  <td data-label=""><span className="wdb-person"><span className="wdb-avatar">{p.so[0]}</span><b>{p.so}</b>{!p.username && <span className="status-badge pending" title="No CRM login matches this name, so their chats and replies can't be counted">no login</span>}</span></td>
                  <td data-label="Orders"><b>{num(p.orders)}</b></td>
                  <td data-label="Units"><span className="wdb-inline-bar"><span>{num(p.units)}</span><span className="wdb-track"><span className="c-bot" style={{ width: `${p.units / topUnits * 100}%` }} /></span></span></td>
                  <td data-label="Order value">{inr(p.value)}</td><td data-label="Avg order">{p.avg ? inr(p.avg) : '—'}</td><td data-label="Collected">{inr(p.collected)}</td>
                  <td data-label="Chats">{p.username ? p.chats : '—'}</td><td data-label="First reply">{p.username ? secs(p.first_reply_secs) : '—'}</td><td data-label="Calls">{p.username ? p.calls : '—'}</td>
                  <td data-label="">{p.username && <Link to={`${brand.path}/me?user=${encodeURIComponent(p.username)}&from=${d.range.from}&to=${d.range.to}`} className="wdb-link">Open</Link>}</td>
                </tr>
              )) : <tr><td colSpan={10} className="wdb-empty">No orders in these dates.</td></tr>}
            </tbody>
            {d.team.length > 1 && (
              <tfoot><tr><td><b>Team</b></td><td><b>{num(sum('orders'))}</b></td><td><b>{num(sum('units'))}</b></td><td><b>{inr(sum('value'))}</b></td>
                <td>{sum('orders') ? inr(sum('value') / sum('orders')) : '—'}</td><td>{inr(sum('collected'))}</td><td>{num(sum('chats'))}</td><td>{secs(k.first_reply_secs.now)}</td><td>{num(sum('calls'))}</td><td /></tr></tfoot>
            )}
          </table>
        </div>
        {d.unattributed && <p className="wdb-sub"><span className="status-badge pending">{d.unattributed.orders} order{d.unattributed.orders > 1 ? 's' : ''}</span> {d.unattributed.units} units have no salesperson written on them — they count for nobody until one is set.</p>}
      </section>

      <div className="wdb-grid">
        <section className="was-card wdb-span2">
          <h3>Units closed per week</h3>
          <Columns items={weeks} legend={names.map((n, i) => [SO_COLORS[i % SO_COLORS.length], n === '—' ? 'No salesperson' : n])} empty="No orders in the eight weeks up to these dates." />
        </section>
        <section className="was-card">
          <h3>Leads in these dates</h3>
          {d.funnel.every(f => !f.count) ? <p className="wdb-empty">No new leads.</p> : d.funnel.map(f => (
            <div key={f.key} className="wdb-hbar">
              <div className="wdb-hbar-row"><span>{f.label}</span><b>{f.count}</b></div>
              <div className="wdb-track"><div className={f.stage === 'won' ? 'c-good' : 'c-bot'} style={{ width: `${f.count / funnelMax * 100}%` }} /></div>
            </div>
          ))}
          <p className="wdb-sub">Lead → order: <b>{pct(k.conversion.now)}</b> <Delta now={k.conversion.now} before={k.conversion.before} unit=" pts" /></p>
        </section>
      </div>

      <div className="wdb-grid">
        <section className="was-card">
          <h3>Where leads come from</h3>
          <div className="wdb-list">
            {d.sources.length ? d.sources.map(s => <div key={s.source}><span>{SOURCE_LABEL[s.source] || s.source}</span><span><b>{s.leads}</b> <span className="wdb-sub">· {s.orders} ordered</span></span></div>)
              : <p className="wdb-empty">No new leads.</p>}
          </div>
        </section>
        <section className="was-card">
          <h3>Conversations</h3>
          <div className="wdb-mini">
            <div><span className="wdb-lbl">Messages in</span><b>{num(d.conversations.msgs_in)}</b></div>
            <div><span className="wdb-lbl">Messages out</span><b>{num(d.conversations.msgs_out)}</b></div>
            <div><span className="wdb-lbl">Answered by the menu</span><b>{pct(d.conversations.menu_share)}</b></div>
            <div><span className="wdb-lbl">Unanswered over 1 h</span><b className={d.conversations.stale ? 'wdb-bad' : ''}>{num(d.conversations.stale)}</b><span className="wdb-sub">right now</span></div>
          </div>
          {!!d.conversations.docs.length && <p className="wdb-sub">Sent from chats: {d.conversations.docs.map(x => `${x.kind} ${x.n}`).join(' · ')}</p>}
        </section>
        <CallsCard c={d.calls} />
      </div>
    </>
  )
}

/* ── Pages ────────────────────────────────────────────────────────────────────────────────── */

export default function WhatsAppDashboard({ brand: brandKey = 'crewfit' }) {
  const brand = WA_BRANDS[brandKey] || WA_BRANDS.crewfit
  const { data, error, loading, setRange } = useDash(`${brand.api}/dashboard`)
  return (
    <Frame brand={brand}>
      <div className="wdb-head">
        <div>
          <h2>Dashboard</h2>
          <p className="wdb-sub">{data ? `${fmtDay(data.range.from)} – ${fmtDay(data.range.to)} · compared with ${fmtDay(data.range.prev_from)} – ${fmtDay(data.range.prev_to)}` : ' '}</p>
        </div>
        <RangeBar brand={brand.key} data={data} setRange={setRange} />
      </div>
      {error ? <div className="was-card"><p>{error}</p>{brand.key === 'crewfit' && <Link to={`${brand.path}/me`} className="btn btn-primary btn-sm">See my performance</Link>}</div>
        : !data ? <div className="loader"><div className="spinner" /></div>
          : <div className={`wdb-content${loading ? ' wdb-loading' : ''}`}>
              {brand.key === 'normless' ? <NormlessDash d={data} /> : <CrewfitDash d={data} brand={brand} />}
              <MessageLog brand={brand} />
            </div>}
    </Frame>
  )
}

/** A Crewfit salesperson's own numbers (or, for a manager, someone's from the team table). */
export function WhatsAppMyPerformance() {
  const brand = WA_BRANDS.crewfit
  const { user } = useAuth()
  const { data: d, error, loading, setRange } = useDash(`${brand.api}/dashboard/me`)
  const mine = d && d.user.username.toLowerCase() === String(user?.username || '').toLowerCase()
  const weeks = (d?.weekly || []).map(w => ({ key: w.week, label: fmtDay(w.week), total: w.units, top: w.orders || '', title: `Week of ${fmtDay(w.week)}: ${w.orders} orders, ${w.units} units`, parts: [{ value: w.units, cls: 'c-bot' }] }))
  const month = d ? new Date(`${d.range.from}T00:00:00`).toLocaleDateString('en-IN', { month: 'long' }) : ''
  return (
    <Frame brand={brand} me>
      {error ? <div className="was-card"><p>{error}</p></div> : !d ? <div className="loader"><div className="spinner" /></div> : (
        <div className={`wdb-content${loading ? ' wdb-loading' : ''}`}>
          <div className="wdb-head">
            <div className="wdb-person">
              <span className="wdb-avatar wdb-avatar-lg">{(d.user.name || '?')[0]}</span>
              <div>
                <h2>{mine ? `${d.user.name}, here are your numbers` : `${d.user.name}’s numbers`}{d.range.days > 25 && d.range.days < 32 ? ` for ${month}` : ''}</h2>
                <p className="wdb-sub">{d.user.so_names.length ? `Orders with ${d.user.so_names.map(s => `“${s.charAt(0).toUpperCase()}${s.slice(1)}”`).join(' or ')} as the salesperson (SO)` : 'No order has this name as its salesperson (SO) yet'} · {fmtDay(d.range.from)} – {fmtDay(d.range.to)}</p>
              </div>
            </div>
            <div className="wdb-head-end">
              <RangeBar brand="crewfit" data={d} setRange={setRange} />
              {d.canSeeTeam && <Link to={`${brand.path}/dashboard?from=${d.range.from}&to=${d.range.to}`} className="btn btn-secondary btn-sm">Back to team</Link>}
            </div>
          </div>

          <section className="wdb-kpis wdb-kpis-5" aria-label="Numbers">
            <Kpi label="Orders closed" value={num(d.kpis.orders.now)}><Delta now={d.kpis.orders.now} before={d.kpis.orders.before} /> vs the period before</Kpi>
            <Kpi label="Units" value={num(d.kpis.units.now)}><Delta now={d.kpis.units.now} before={d.kpis.units.before} /></Kpi>
            <Kpi label="Order value" value={inr(d.kpis.value.now)}><Delta now={d.kpis.value.now} before={d.kpis.value.before} format={inr} /></Kpi>
            <Kpi label="Collected" value={inr(d.kpis.collected.now)}><Delta now={d.kpis.collected.now} before={d.kpis.collected.before} format={inr} /></Kpi>
            <Kpi label="First reply" value={secs(d.kpis.first_reply_secs.now)}><Delta now={d.kpis.first_reply_secs.now} before={d.kpis.first_reply_secs.before} better="down" format={secs} /> median · {d.kpis.chats.now} chats</Kpi>
          </section>

          <div className="wdb-grid">
            <section className="was-card wdb-span2">
              <div className="was-card-head"><h3>Units closed per week</h3><span className="wdb-sub">Number above: orders</span></div>
              <Columns items={weeks} empty="No orders in the eight weeks up to these dates." />
            </section>
            <section className="was-card">
              <h3>Waiting for your reply</h3>
              {d.followups.length ? (
                <div className="wdb-follow">
                  {d.followups.map(f => (
                    <Link key={f.id} to={`${brand.path}?c=${f.id}`} className="wdb-follow-item">
                      <span><b>{f.name}{f.company ? ` · ${f.company}` : ''}</b><span className="wdb-sub">{f.preview}</span></span>
                      <span className={`status-badge ${overAnHour(f.last_inbound_at) ? 'error' : ''}`}>{ago(f.last_inbound_at)}</span>
                    </Link>
                  ))}
                </div>
              ) : <p className="wdb-empty">Nobody is waiting on {mine ? 'you' : 'them'}.</p>}
            </section>
          </div>

          <section className="was-card">
            <div className="was-card-head"><h3>Orders in these dates</h3><Link to="/crewfit/orders" className="wdb-link">All orders</Link></div>
            <div className="data-table-wrapper wdb-table">
              <table className="data-table">
                <thead><tr><th scope="col">Order</th><th scope="col">Date</th><th scope="col">Customer</th><th scope="col">Product</th><th scope="col">Units</th><th scope="col">Value</th><th scope="col">Payment</th><th scope="col">Status</th></tr></thead>
                <tbody>
                  {d.orders.length ? d.orders.map(o => (
                    <tr key={o.id}><td data-label=""><b>CF-{o.sl_no}</b></td><td data-label="Date">{fmtDay(o.date)}</td><td data-label="Customer">{o.billing_name || o.customer_name}</td>
                      <td data-label="Product" className="wdb-wrap">{o.product}</td><td data-label="Units">{num(o.qty)}</td><td data-label="Value">{inr(o.grand_total)}</td>
                      <td data-label="Payment"><span className={`status-badge ${o.payment_status === 'Fully Paid' ? 'success' : o.payment_status === 'Pending' ? 'error' : 'pending'}`}>{o.payment_status || '—'}</span></td><td data-label="Status">{o.status}</td></tr>
                  )) : <tr><td colSpan={8} className="wdb-empty">No orders in these dates.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </Frame>
  )
}
