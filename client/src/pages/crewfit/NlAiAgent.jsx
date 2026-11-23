import { useEffect, useState, useCallback } from 'react'
import { NavLink, Navigate, Link, useParams } from 'react-router-dom'
import { useApi, useAuth, useMainMenu } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import { Head, Toggle, Loading, SaveButton } from './waSettingsUi'
import { WA_BRANDS, WaBrandContext } from './waBrand'

/**
 * The Normless AI agent's page: switch it on, teach it, answer its questions, see what it costs.
 *
 * The agent answers the chats the bot hands to the team (server/services/nl-agent.js). What it is
 * taught here — lessons, and announcements that run out on a date — goes into its instructions on
 * every reply. Its questions are the chats it couldn't answer; answering one replies to the
 * customer, and "Remember this" saves the answer as a lesson.
 */

const brand = WA_BRANDS.normless
const API = `${brand.api}/nl/ai`

const TABS = [
  { key: 'overview', label: 'Overview', icon: 'spark' },
  { key: 'playbook', label: 'Playbook', icon: 'note' },
  { key: 'questions', label: 'Questions', icon: 'users' },
  { key: 'spend', label: 'Spend', icon: 'wallet' },
]

const usd = (v, d = 2) => `$${(Number(v) || 0).toFixed(d)}`
const inr = (v, rate) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format((Number(v) || 0) * (rate || 88))
const both = (v, rate, d = 2) => `${usd(v, d)} · ≈ ${inr(v, rate)}`
const when = (v) => (v ? new Date(v).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '')
const day = (v) => (v ? new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '')
const short = (u) => String(u || '').split('@')[0]
const count = (v) => new Intl.NumberFormat('en-IN').format(Math.round(Number(v) || 0))

export default function NlAiAgent() {
  const { tab = 'overview' } = useParams()
  const { openMenu } = useMainMenu()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin' || user?.role === 'owner'
  if (!TABS.some(t => t.key === tab)) return <Navigate to="/whatsapp/ai/overview" replace />
  const Pane = { overview: OverviewTab, playbook: PlaybookTab, questions: QuestionsTab, spend: SpendTab }[tab]
  return (
    <WaBrandContext.Provider value={brand}>
      <div className="page">
        <header className="wa-topbar">
          <button type="button" className="btn-icon wa-menu-btn" aria-label="Open the main menu" title="Main menu" onClick={openMenu}>
            <Icon name="dashboard" size={18} />
          </button>
          <h1>Normless WhatsApp</h1>
          <nav className="wa-seg" aria-label="WhatsApp">
            <NavLink to={brand.path} end className="wa-seg-item">Inbox</NavLink>
            {(isAdmin || user?.can_view_wa_nl_dashboard) && <NavLink to={`${brand.path}/dashboard`} className="wa-seg-item">Dashboard</NavLink>}
            <NavLink to={`${brand.path}/ai`} className="wa-seg-item wa-seg-on">AI agent</NavLink>
            {(isAdmin || user?.can_manage_wa_nl_settings) && <NavLink to={`${brand.path}/settings`} className="wa-seg-item">Settings</NavLink>}
          </nav>
        </header>
        <div className="was-layout">
          <nav className="was-nav" aria-label="AI agent">
            {TABS.map(t => (
              <NavLink key={t.key} to={`${brand.path}/ai/${t.key}`} className={({ isActive }) => `was-nav-item${isActive ? ' was-nav-on' : ''}`}>
                <Icon name={t.icon} size={15} /> {t.label}
              </NavLink>
            ))}
          </nav>
          <main className="was-main"><Pane /></main>
        </div>
      </div>
    </WaBrandContext.Provider>
  )
}

/* ── Overview: on/off, settings, the key, try it ─────────────────────────────────────────── */

function OverviewTab() {
  const apiFetch = useApi()
  const toast = useToast()
  const [o, setO] = useState(null)
  const [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false)
  const load = () => apiFetch(`${API}/overview`).then(r => {
    if (!r || r.error) return toast.error(r?.error || 'Could not load the AI agent')
    setO(r); setDraft(r.settings)
  })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [])
  if (!o || !draft) return <Loading />
  const dirty = JSON.stringify(draft) !== JSON.stringify(o.settings)
  const set = (patch) => setDraft(d => ({ ...d, ...patch }))
  const save = async (next = draft) => {
    setSaving(true)
    const r = await apiFetch(`${API}/settings`, { method: 'PUT', body: JSON.stringify(next) })
    setSaving(false)
    if (!r || r.error) return toast.error(r?.error || 'Could not save')
    toast.success(next.enabled ? 'Saved — the agent is answering' : 'Saved')
    load()
  }
  const used = o.settings.budget_usd ? Math.min(100, (o.month_spend / o.settings.budget_usd) * 100) : 0
  return (
    <>
      <Head title="AI agent" actions={<SaveButton dirty={dirty} saving={saving} label="Save" onClick={() => save()} />}>
        Answers the chats the bot hands to the team, using your orders, tickets, Delhivery tracking and everything in the
        Playbook. When it doesn’t know, it asks you under Questions instead of guessing.
      </Head>

      <section className={`was-card nla-status ${o.status.on ? 'nla-on' : 'nla-off'}`}>
        <div className="nla-status-main">
          <span className="nla-dot" aria-hidden="true" />
          <div>
            <h3>{o.status.on ? 'Answering customers' : 'Not answering'}</h3>
            <p className="was-hint" style={{ margin: 0 }}>
              {o.status.on ? `${o.chats_today} chat${o.chats_today === 1 ? '' : 's'} answered in the last 24 hours. It stays out of a chat for ${o.settings.quiet_minutes} minutes after a person writes in it.`
                : o.status.why}
            </p>
          </div>
        </div>
        <label className="nl-switch-row">
          <Toggle on={draft.enabled} label="AI agent on" disabled={!o.key_set} onChange={v => { const next = { ...draft, enabled: v }; setDraft(next); save(next) }} />
          <span>{draft.enabled ? 'On' : 'Off'}</span>
        </label>
      </section>

      {!o.key_set && <KeyHelp missing />}

      <div className="voa-kpis">
        <div className="voa-kpi"><span>Spent this month</span><b>{usd(o.month_spend)}</b><em>≈ {inr(o.month_spend, o.settings.usd_inr)} of {usd(o.settings.budget_usd, 0)} budget</em>
          <span className="voa-meter"><span style={{ width: `${used}%`, background: used > 90 ? '#f87171' : undefined }} /></span></div>
        <Link to="/whatsapp/ai/questions" className="voa-kpi nla-kpi-link"><span>Waiting for your answer</span><b>{o.open_questions}</b><em>questions from the agent</em></Link>
        <Link to="/whatsapp/ai/playbook" className="voa-kpi nla-kpi-link"><span>Lessons</span><b>{o.lessons}</b><em>{o.announcements} announcement{o.announcements === 1 ? '' : 's'} running</em></Link>
      </div>

      <div className="nl-grid">
        <div className="nl-col">
          <section className="was-card">
            <h3>How it works</h3>
            <div className="nla-form">
              <label>Model
                <select className="input" value={draft.model} onChange={e => set({ model: e.target.value })}>
                  <option value="claude-sonnet-5-5">Claude Sonnet 5.5: recommended, half the price of Opus</option>
                  <option value="claude-haiku-5-5">Claude Haiku 5.5: cheapest by far, simpler answers</option>
                  <option value="claude-opus-5-5">Claude Opus 5.5: most careful, about twice Sonnet's cost</option>
                </select>
              </label>
              <label>Monthly budget (US $)
                <input className="input" type="number" min="0" step="5" value={draft.budget_usd} onChange={e => set({ budget_usd: e.target.value })} />
                <small>It stops answering for the rest of the month when this is spent. 0 means no limit.</small>
              </label>
              <label>Dollar rate (₹ for $1)
                <input className="input" type="number" min="1" step="0.5" value={draft.usd_inr} onChange={e => set({ usd_inr: e.target.value })} />
                <small>Only for showing rupees on this page. Anthropic bills in dollars.</small>
              </label>
              <label>Stay out after a person writes (minutes)
                <input className="input" type="number" min="0" step="5" value={draft.quiet_minutes} onChange={e => set({ quiet_minutes: e.target.value })} />
                <small>So it never talks over someone who is in the chat.</small>
              </label>
              <label>Close a chat after the customer goes quiet (minutes)
                <input className="input" type="number" min="0" step="5" value={draft.idle_close_minutes ?? 15} onChange={e => set({ idle_close_minutes: e.target.value })} />
                <small>After the agent’s reply, with no answer from the customer. No message is sent; the chat reopens when they write. 0 means never.</small>
              </label>
              <label className="nla-check">
                <input type="checkbox" checked={draft.close_when_done} onChange={e => set({ close_when_done: e.target.checked })} />
                Close chats that need no reply (“ok”, “thanks”)
              </label>
              <label className="nla-check">
                <input type="checkbox" checked={!!draft.email_enabled} onChange={e => set({ email_enabled: e.target.checked })} />
                Answer emails to contact@normless.store too (see <Link to="/support/email">Support › Email</Link>)
              </label>
            </div>
          </section>
          <section className="was-card">
            <h3>What it never does</h3>
            <ul className="nla-list">
              <li>Refund, cancel, discount or change an order — it has no way to. It asks you instead.</li>
              <li>Promise a dispatch or delivery date, unless a lesson or your answer says it may.</li>
              <li>Write an amount it didn’t read from your data. A reply with an unknown ₹ figure becomes a question to you.</li>
              <li>Reply in a chat somebody paused it on, or one a person wrote in recently.</li>
              <li>Claim to be a person: if a customer sincerely asks, it hands the chat to you.</li>
            </ul>
          </section>
          {o.key_set && <KeyHelp />}
        </div>
        <AgentTry ready={o.key_set} />
      </div>
    </>
  )
}

function KeyHelp({ missing }) {
  return (
    <section className={`was-card ${missing ? 'was-warn-card' : ''}`}>
      <h3>{missing ? 'Add an Anthropic API key to switch it on' : 'The Anthropic account'}</h3>
      <ol className="nla-list">
        <li>Sign in at <a href="https://platform.claude.com" target="_blank" rel="noreferrer">platform.claude.com</a> (Anthropic’s developer console) with the company email.</li>
        <li><b>Billing</b>: add a card and buy prepaid credits (start with $10–20). Turn on auto-reload if you don’t want it to stop when credits run out.</li>
        <li><b>API keys</b> → Create key, name it “Normless CRM”. Copy it once; it isn’t shown again.</li>
        <li>On the server, put it in the CRM’s <code>.env</code> as <code>ANTHROPIC_API_KEY=…</code> and restart the CRM.</li>
        <li>Set a monthly spend limit in the console as well (Settings → Limits), as a second safety net.</li>
      </ol>
      <p className="was-hint" style={{ margin: 0 }}>The credit balance and invoices are on the console. This CRM shows what each feature spent, from the token counts on every reply.</p>
    </section>
  )
}

function AgentTry({ ready }) {
  const apiFetch = useApi()
  const toast = useToast()
  const [turns, setTurns] = useState([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const ask = async () => {
    const text = draft.trim()
    if (!text) return
    const next = [...turns, { role: 'customer', text }]
    setTurns(next); setDraft(''); setBusy(true)
    const r = await apiFetch(`${API}/try`, { method: 'POST', body: JSON.stringify({ turns: next.filter(t => t.text).map(t => ({ role: t.role, text: t.text })) }) })
    setBusy(false)
    if (!r || r.error) { toast.error(r?.error || 'The agent could not answer'); return }
    setTurns(t => [...t, { role: 'agent', text: r.reply || '', asked: r.asked, closed: r.closed, did: r.did }])
  }
  return (
    <aside className="was-card nl-try" aria-label="Try the agent">
      <div className="was-card-head">
        <h3>Try it</h3>
        {!!turns.length && <button type="button" className="mini-btn" onClick={() => setTurns([])}>Start over</button>}
      </div>
      <p className="was-hint" style={{ margin: 0 }}>Write like a customer. It uses the real Playbook; nothing is sent and no ticket is raised.</p>
      <div className="nl-try-feed nl-try-chat">
        {!ready && <div className="nl-try-note"><Icon name="alert" size={16} /><span>Needs the Anthropic API key on the server first.</span></div>}
        {ready && !turns.length && <div className="nl-try-note"><Icon name="spark" size={16} /><span>Try “my tracking says cancelled”, “I want to cancel, it’s been 10 days” or “change my size to XL”.</span></div>}
        {turns.map((t, i) => (
          <div key={i} className={`nl-try-msg ${t.role === 'agent' ? 'bot' : 'customer'}`}>
            {t.text && <div className="nl-try-text">{t.text}</div>}
            {t.did?.length > 0 && <div className="nl-try-handover">Did: {t.did.join(' · ')}</div>}
            {t.asked && <div className="nl-try-handover">Would ask the team: {t.asked}</div>}
            {t.closed && <div className="nl-try-handover">Would close the chat: {t.closed}</div>}
          </div>
        ))}
        {busy && <div className="nl-try-msg bot"><div className="nl-try-text"><span className="wa-spin" aria-hidden="true" /> Thinking…</div></div>}
      </div>
      <form className="was-inline" onSubmit={e => { e.preventDefault(); ask() }}>
        <input className="input" aria-label="Test message" placeholder="Type a message…" value={draft} disabled={!ready || busy}
          onChange={e => setDraft(e.target.value)} style={{ flex: 1 }} />
        <button type="submit" className="btn btn-primary btn-sm" disabled={!ready || busy || !draft.trim()}>Send</button>
      </form>
    </aside>
  )
}

/* ── Playbook: lessons and announcements ─────────────────────────────────────────────────── */

const blankLesson = (kind = 'lesson') => ({ kind, title: '', body: '', expires_at: '', active: true })
const SOURCE = { manual: 'Added here', question: 'From an answer', correction: 'From a correction' }

function PlaybookTab() {
  const apiFetch = useApi()
  const toast = useToast()
  const [list, setList] = useState(null)
  const [form, setForm] = useState(null)      // a lesson being written or edited
  const [saving, setSaving] = useState(false)
  const load = useCallback(() => apiFetch(`${API}/lessons`).then(r => (r && !r.error ? setList(r.lessons) : toast.error(r?.error || 'Could not load the playbook'))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [])
  useEffect(() => { load() }, [load])
  if (!list) return <Loading />
  const save = async () => {
    setSaving(true)
    const body = { ...form, expires_at: form.expires_at ? new Date(`${form.expires_at}T23:59:00+05:30`).toISOString() : null }
    const r = await apiFetch(form.id ? `${API}/lessons/${form.id}` : `${API}/lessons`, { method: form.id ? 'PUT' : 'POST', body: JSON.stringify(body) })
    setSaving(false)
    if (!r || r.error) return toast.error(r?.error || 'Could not save')
    toast.success('Saved — the agent uses it from its next reply')
    setForm(null); load()
  }
  const flip = async (l) => {
    const r = await apiFetch(`${API}/lessons/${l.id}`, { method: 'PUT', body: JSON.stringify({ ...l, active: !l.active }) })
    if (!r || r.error) return toast.error(r?.error || 'Could not change it')
    load()
  }
  const remove = async (l) => {
    if (!window.confirm('Delete this for good? Switching it off keeps it for later.')) return
    const r = await apiFetch(`${API}/lessons/${l.id}`, { method: 'DELETE' })
    if (!r || r.error) return toast.error(r?.error || 'Could not delete it')
    load()
  }
  const edit = (l) => setForm({ ...l, title: l.title || '', expires_at: l.expires_at ? new Date(l.expires_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) : '' })
  const announcements = list.filter(l => l.kind === 'announcement')
  const lessons = list.filter(l => l.kind !== 'announcement')
  const Item = ({ l }) => (
    <li className={`nla-lesson${!l.active || l.expired ? ' nla-lesson-off' : ''}`}>
      <div className="nla-lesson-main">
        {l.title && <b>{l.title}</b>}
        <p>{l.body}</p>
        <span className="was-hint">
          {SOURCE[l.source] || l.source}{l.created_by ? ` by ${short(l.created_by)}` : ''} · {day(l.created_at)}
          {l.expires_at && (l.expired ? ` · ended ${day(l.expires_at)}` : ` · until ${day(l.expires_at)}`)}
          {l.conversation_id && <> · <Link to={`/whatsapp?c=${l.conversation_id}`}>chat</Link></>}
        </span>
      </div>
      <div className="was-row-actions">
        <Toggle on={l.active} label={l.active ? 'In use' : 'Off'} onChange={() => flip(l)} />
        <button type="button" className="mini-btn" onClick={() => edit(l)}>Edit</button>
        <button type="button" className="mini-btn" onClick={() => remove(l)} aria-label="Delete">✕</button>
      </div>
    </li>
  )
  return (
    <>
      <Head title="Playbook" actions={!form && <>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setForm(blankLesson('announcement'))}><Icon name="plus" size={13} /> Announcement</button>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setForm(blankLesson())}><Icon name="plus" size={13} /> Lesson</button>
      </>}>
        Everything here goes into the agent’s instructions on every reply. Write it the way you would brief a new team member.
        Answers you save with “Remember this” and corrections from the inbox land here too.
      </Head>

      {form && (
        <section className="was-card nla-edit">
          <h3>{form.id ? 'Edit' : 'New'} {form.kind === 'announcement' ? 'announcement' : 'lesson'}</h3>
          <div className="nla-form">
            <div className="voa-seg" role="group" aria-label="Kind">
              {[['lesson', 'Lesson (always)'], ['announcement', 'Announcement (until a date)']].map(([k, label]) => (
                <button key={k} type="button" className={form.kind === k ? 'active' : ''} onClick={() => setForm(f => ({ ...f, kind: k }))}>{label}</button>
              ))}
            </div>
            <label>When (optional)
              <input className="input" placeholder={form.kind === 'announcement' ? 'e.g. Dispatch delay' : 'e.g. Dr Doom Hoodie orders'} value={form.title}
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
            </label>
            <label>What the agent should know or do
              <textarea className="input" rows={4} value={form.body} onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
                placeholder={form.kind === 'announcement'
                  ? 'e.g. Orders placed 10–20 Nov are delayed by 3–4 days. Apologise and say we are working hard to dispatch them. Don’t give a date.'
                  : 'e.g. Never give a dispatch date for Dr Doom Hoodie. Say: sorry for the delay, we are working hard to dispatch your order.'} />
            </label>
            {form.kind === 'announcement' && (
              <label>Runs until (it stops being used after this day)
                <input className="input" type="date" value={form.expires_at} onChange={e => setForm(f => ({ ...f, expires_at: e.target.value }))} />
              </label>
            )}
            <div className="was-inline">
              <button type="button" className="btn btn-primary btn-sm" disabled={saving || !form.body.trim()} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setForm(null)}>Cancel</button>
            </div>
          </div>
        </section>
      )}

      <section className="was-card">
        <h3>Announcements <span className="was-hint">· what’s happening right now</span></h3>
        {!announcements.length ? <p className="was-hint">None. Add one for a delay, a sale, Instagram being down — anything customers will ask about this week.</p>
          : <ul className="nla-lessons">{announcements.map(l => <Item key={l.id} l={l} />)}</ul>}
      </section>
      <section className="was-card">
        <h3>Lessons <span className="was-hint">· how to handle things, always</span></h3>
        {!lessons.length ? <p className="was-hint">None yet.</p> : <ul className="nla-lessons">{lessons.map(l => <Item key={l.id} l={l} />)}</ul>}
      </section>
    </>
  )
}

/* ── Questions: what it asked the team ───────────────────────────────────────────────────── */

function QuestionsTab() {
  const apiFetch = useApi()
  const [status, setStatus] = useState('open')
  const [list, setList] = useState(null)
  const load = useCallback(() => apiFetch(`${API}/questions?status=${status}`).then(r => setList(r && !r.error ? r.questions : [])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [status])
  useEffect(() => { setList(null); load() }, [load])
  return (
    <>
      <Head title="Questions from the agent" actions={
        <div className="voa-seg" role="group" aria-label="Which">
          {[['open', 'Waiting'], ['answered', 'Answered'], ['dismissed', 'Handled by a person']].map(([k, label]) => (
            <button key={k} type="button" className={status === k ? 'active' : ''} onClick={() => setStatus(k)}>{label}</button>
          ))}
        </div>
      }>
        The chats it couldn’t answer. Your answer goes back to the agent, which writes the reply to the customer. Tick
        “Remember this” when the same answer will do next time.
      </Head>
      {!list ? <Loading /> : !list.length ? <section className="was-card"><p className="was-hint" style={{ margin: 0 }}>{status === 'open' ? 'Nothing waiting. 🎉' : 'None yet.'}</p></section>
        : list.map(q => <QuestionCard key={q.id} q={q} onDone={load} />)}
    </>
  )
}

/** One question with its answer box. Used on the Questions tab and inside a chat in the inbox. */
export function QuestionCard({ q, onDone, compact = false }) {
  const apiFetch = useApi()
  const toast = useToast()
  const [answer, setAnswer] = useState('')
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)
  const name = String(q.customer_name || q.profile_name || 'Customer').replace(/^~/, '')
  const send = async () => {
    setBusy(true)
    const r = await apiFetch(`${API}/questions/${q.id}/answer`, { method: 'POST', body: JSON.stringify({ answer, remember }) })
    setBusy(false)
    if (!r || r.error) return toast.error(r?.error || 'Could not send')
    if (r.replied) toast.success(remember ? 'Replied to the customer, and saved to the Playbook' : 'Replied to the customer')
    else if (r.asked) toast.success('Answer saved — the agent has a follow-up question on the chat')
    else toast.success(`Answer saved${r.skipped ? ` — not sent yet: ${r.skipped}` : ''}`)
    onDone?.()
  }
  const dismiss = async () => {
    const r = await apiFetch(`${API}/questions/${q.id}/dismiss`, { method: 'POST' })
    if (!r || r.error) return toast.error(r?.error || 'Could not change it')
    onDone?.()
  }
  return (
    <section className={`was-card nla-q${compact ? ' nla-q-compact' : ''}`}>
      {!compact && (
        <div className="was-card-head">
          <h3>{name}</h3>
          <span className="was-hint">{when(q.created_at)}{q.assigned_to ? ` · ${short(q.assigned_to)}` : ''} · <Link to={`/whatsapp?c=${q.conversation_id}`}>Open chat</Link></span>
        </div>
      )}
      {!compact && q.last_customer_message && <p className="nla-q-said">“{String(q.last_customer_message).slice(0, 400)}”</p>}
      <p className="nla-q-text"><Icon name="spark" size={14} /> {q.question}</p>
      {q.context && <p className="was-hint" style={{ margin: 0 }}>Checked: {q.context}</p>}
      {q.status === 'open' || !q.status ? (
        <>
          <textarea className="input" rows={compact ? 2 : 3} value={answer} onChange={e => setAnswer(e.target.value)}
            placeholder="Your answer, in a few words — e.g. “Apologise, we’ll reattempt delivery tomorrow, no extra charge.”" />
          <div className="nla-q-actions">
            <label className="nla-check"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} /> Remember this for next time</label>
            <span style={{ flex: 1 }} />
            <button type="button" className="btn btn-secondary btn-sm" onClick={dismiss} title="You reply to the customer yourself">I’ll handle it</button>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || !answer.trim()} onClick={send}>{busy ? 'Sending…' : 'Answer'}</button>
          </div>
        </>
      ) : (
        <p className="nla-q-answer">{q.status === 'answered' ? <><b>{short(q.answered_by)}:</b> {q.answer}{q.lesson_id ? ' · saved to the Playbook' : ''}</> : `Handled by ${short(q.answered_by)}`}</p>
      )}
    </section>
  )
}

/* ── Spend ────────────────────────────────────────────────────────────────────────────────── */

function SpendTab() {
  const apiFetch = useApi()
  const [days, setDays] = useState(30)
  const [s, setS] = useState(null)
  const [error, setError] = useState('')
  const [hover, setHover] = useState(null)
  useEffect(() => {
    setS(null); setError('')
    apiFetch(`${API}/spend?days=${days}`).then(r => (r && !r.error ? setS(r) : setError(r?.error || 'Could not load the spend')))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days])
  const rate = s?.usd_inr
  const top = Math.max(0, ...(s?.by_day || []).map(d => d.usd))
  return (
    <>
      <Head title="What the AI costs" actions={
        <div className="voa-seg" role="group" aria-label="Dates">
          {[[7, '7 days'], [30, '30 days'], [90, '90 days']].map(([k, label]) => (
            <button key={k} type="button" className={days === k ? 'active' : ''} onClick={() => setDays(k)}>{label}</button>
          ))}
        </div>
      }>
        Every Claude call in the CRM, priced from the tokens it used at Anthropic’s rates. The real bill and your credit
        balance are on <a href="https://platform.claude.com/settings/billing" target="_blank" rel="noreferrer">platform.claude.com</a>.
      </Head>
      {error ? <p className="voa-warn">{error}</p> : !s ? <Loading /> : (
        <div className="was-card wac">
          <div className="voa-kpis">
            <div className="voa-kpi"><span>Today</span><b>{usd(s.today)}</b><em>≈ {inr(s.today, rate)}</em></div>
            <div className="voa-kpi"><span>This month</span><b>{usd(s.month)}</b><em>≈ {inr(s.month, rate)}{s.budget_usd ? ` · budget ${usd(s.budget_usd, 0)}` : ''}</em>
              {!!s.budget_usd && <span className="voa-meter"><span style={{ width: `${Math.min(100, (s.month / s.budget_usd) * 100)}%` }} /></span>}</div>
            <div className="voa-kpi"><span>Last month</span><b>{usd(s.last_month)}</b><em>≈ {inr(s.last_month, rate)}</em></div>
            <div className="voa-kpi"><span>Per chat the agent worked</span><b>{s.per_chat != null ? usd(s.per_chat, 3) : '—'}</b>
              <em>{s.per_chat != null ? `≈ ${inr(s.per_chat, rate)} · ${count(s.agent_chats)} chats` : 'No chats yet'}</em></div>
          </div>

          <div className="voa-chart">
            <div className="wac-chart-head"><h3>Day by day</h3><span className="voa-muted">{both(s.range, rate)} over {s.days} days · {count(s.calls)} calls</span></div>
            {top === 0 ? <p className="voa-muted">Nothing spent in these days.</p> : (
              <div className="voa-bars" style={{ gridTemplateColumns: `repeat(${s.by_day.length}, minmax(0, 1fr))` }}>
                {s.by_day.map((d, i) => (
                  <div key={d.day} className={`voa-col${hover === i ? ' on' : ''}`} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
                    tabIndex={0} onFocus={() => setHover(i)} onBlur={() => setHover(null)} aria-label={`${d.day}: ${usd(d.usd)}`}>
                    <div className="voa-stack" style={{ height: `${(d.usd / top) * 100}%` }}><span style={{ flex: 1, background: '#a78bfa' }} /></div>
                    {(s.by_day.length <= 16 || i % Math.ceil(s.by_day.length / 12) === 0) && <span className="voa-x">{new Date(`${d.day}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>}
                    {hover === i && <div className={`voa-tip${i > s.by_day.length / 2 ? ' left' : ''}`}><b>{day(`${d.day}T00:00:00`)}</b><span>{both(d.usd, rate, 3)}</span><span>{count(d.calls)} calls</span></div>}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="data-table-wrapper">
            <table className="data-table">
              <thead><tr><th>Feature</th><th className="num">Calls</th><th className="num">Chats</th><th className="num">Cost</th><th className="num">In rupees</th></tr></thead>
              <tbody>
                {!s.by_feature.length && <tr><td colSpan={5} className="voa-muted">Nothing yet.</td></tr>}
                {s.by_feature.map(f => (
                  <tr key={f.feature}><td className="cell-primary">{f.label}</td><td className="num">{count(f.calls)}</td><td className="num">{f.chats ? count(f.chats) : '—'}</td>
                    <td className="num"><b>{usd(f.usd, 3)}</b></td><td className="num">{inr(f.usd, rate)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="voa-split">
            <div className="voa-products">
              <h4>By model</h4>
              <ul>{s.by_model.map(m => <li key={m.model}><div className="voa-prow"><span>{m.model}</span><b>{usd(m.usd, 3)}</b></div><div className="voa-muted">{count(m.calls)} calls</div></li>)}</ul>
              <p className="voa-muted" style={{ margin: '10px 0 0' }}>{count(s.tokens_in)} tokens read · {count(s.tokens_out)} written in these days.</p>
            </div>
            <div className="voa-products">
              <h4>How Anthropic charges</h4>
              <ul className="wac-rules">
                <li><b>Per token</b>, roughly ¾ of a word. What the AI reads (the chat, orders, the Playbook) and what it writes are priced separately.</li>
                <li><b>Prepaid credits.</b> You buy credits on the console; each call is taken from them. When they run out, the AI stops until you top up (or set auto-reload).</li>
                <li><b>Repeated instructions are cheap.</b> The instructions and Playbook are cached, so most of what is read again costs a tenth.</li>
                <li><b>Billed in US dollars</b>, plus GST on the invoice. Rupees here use the rate set on the Overview.</li>
              </ul>
              <a className="wac-link" href="https://www.anthropic.com/pricing#api" target="_blank" rel="noreferrer">Anthropic’s price list ↗</a>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/* ── In the inbox: the agent on one chat ─────────────────────────────────────────────────── */

/**
 * Shown above the composer on a Normless chat: the agent's open question (answer it here), a
 * "Tell the AI" box that has it write and send a reply, and pause/resume for this chat.
 */
export function AiChatBar({ conversationId, onChanged }) {
  const apiFetch = useApi()
  const toast = useToast()
  const [s, setS] = useState(null)
  const [open, setOpen] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => {
    if (!conversationId) return
    apiFetch(`${API}/conversations/${conversationId}`).then(r => setS(r && !r.error ? r : null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId])
  useEffect(() => { setS(null); setOpen(false); setInstruction(''); load() }, [load])
  if (!s) return null
  const done = () => { load(); onChanged?.() }
  const pause = async () => {
    const r = await apiFetch(`${API}/conversations/${conversationId}/pause`, { method: 'POST', body: JSON.stringify({ paused: !s.paused }) })
    if (!r || r.error) return toast.error(r?.error || 'Could not change it')
    toast.success(r.paused ? 'The AI agent won’t reply on this chat' : 'The AI agent can reply on this chat again')
    done()
  }
  const tell = async () => {
    setBusy(true)
    const r = await apiFetch(`${API}/conversations/${conversationId}/instruct`, { method: 'POST', body: JSON.stringify({ instruction }) })
    setBusy(false)
    if (!r || r.error) return toast.error(r?.error || 'Could not pass that on')
    if (r.replied) { toast.success('The AI agent replied'); setInstruction(''); setOpen(false) }
    else if (r.asked) toast.success('The agent has a question about that — see above')
    else toast.error(r.skipped || 'The agent didn’t send anything')
    done()
  }
  if (!s.on && !s.question) return null
  return (
    <div className="nla-bar">
      {s.question && <QuestionCard q={{ ...s.question, conversation_id: conversationId, status: 'open' }} compact onDone={done} />}
      <div className="nla-bar-row">
        <span className={`nla-pill${s.paused ? ' nla-pill-off' : ''}`}><Icon name="spark" size={12} /> {s.paused ? 'AI paused here' : s.on ? 'AI agent on' : 'AI agent off'}</span>
        {s.on && !s.paused && <button type="button" className="mini-btn" onClick={() => setOpen(o => !o)}>Tell the AI what to say</button>}
        {s.on && <button type="button" className="mini-btn" onClick={pause}>{s.paused ? 'Let the AI reply' : 'I’ll handle this chat'}</button>}
      </div>
      {open && (
        <form className="was-inline nla-bar-row" onSubmit={e => { e.preventDefault(); tell() }}>
          <input className="input" style={{ flex: 1 }} value={instruction} onChange={e => setInstruction(e.target.value)} disabled={busy}
            placeholder="e.g. tell him the refund is approved and takes 5–7 working days" aria-label="What the AI should tell the customer" />
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !instruction.trim()}>{busy ? 'Writing…' : 'Send via AI'}</button>
        </form>
      )}
    </div>
  )
}

/** "Teach" on one of the agent's messages: what it should have said. Saved as a lesson. */
export function TeachButton({ message }) {
  const apiFetch = useApi()
  const toast = useToast()
  const teach = async () => {
    const correction = window.prompt('What should the AI agent have said or done instead? It will follow this from now on.')
    if (!correction || !correction.trim()) return
    const r = await apiFetch(`${API}/messages/${message.id}/teach`, { method: 'POST', body: JSON.stringify({ correction }) })
    if (!r || r.error) return toast.error(r?.error || 'Could not save that')
    toast.success('Saved to the Playbook — the agent follows it from its next reply')
  }
  return <button type="button" className="nla-teach" onClick={teach} title="Teach the AI agent what to say instead">Teach</button>
}
