import { useState, useEffect, useCallback } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useApi, useAuth } from '../App'
import { useToast } from '../components/Toast'
import Icon from '../components/Icon'

const API = '/api/support-email'
const VIEWS = [
  { key: 'needs', label: 'Needs a person' },
  { key: 'ai', label: 'AI agent' },
  { key: 'open', label: 'Open' },
  { key: 'closed', label: 'Closed' },
  { key: 'all', label: 'All' },
]
const when = (v) => (v ? new Date(v).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '')
const refOf = (t) => `CS-${String(t.ref_no).padStart(4, '0')}`
const AI_LOOK = {
  asked: { label: 'AI asked the team', cls: 'em-pill-warn' },
  replied: { label: 'AI answered', cls: 'em-pill-ai' },
  closed: { label: 'No reply needed', cls: 'em-pill-quiet' },
}

/**
 * Support › Email: contact@normless.store. The AI agent answers what it can; what it can't, or
 * what it asked about, shows under "Needs a person". A person can reply here, answer the agent's
 * question (and save it as a lesson), pause the agent on one email, or close it.
 */
export default function SupportEmail() {
  const apiFetch = useApi()
  const toast = useToast()
  const { user } = useAuth()
  const canEdit = ['owner', 'admin'].includes(user?.role) || !!user?.can_edit_support
  const [params, setParams] = useSearchParams()
  const [view, setView] = useState('needs')
  const [search, setSearch] = useState('')
  const [data, setData] = useState(null)
  const [openId, setOpenId] = useState(Number(params.get('t')) || null)

  const load = useCallback(async () => {
    const r = await apiFetch(`${API}/threads?view=${view}${search ? `&search=${encodeURIComponent(search)}` : ''}`)
    if (r && !r.error) setData(r)
    else if (r?.error) toast.error(r.error)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, search])
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t) }, [load])
  useEffect(() => { const t = setInterval(load, 30000); return () => clearInterval(t) }, [load])

  const open = (id) => { setOpenId(id); if (id) setParams({ t: String(id) }, { replace: true }); else setParams({}, { replace: true }) }

  const sync = async () => {
    const r = await apiFetch(`${API}/sync`, { method: 'POST' })
    if (!r || r.error) return toast.error(r?.error || 'Could not read the mailbox')
    toast.success(r.new_threads ? `${r.new_threads} new email${r.new_threads > 1 ? 's' : ''}` : 'No new email')
    load()
  }

  const mb = data?.mailbox
  return (
    <div className="page-enter">
      <div className="dash-toolbar">
        <div>
          <h1>Email</h1>
          <p style={{ color: 'var(--text-muted)' }}>
            {mb?.mailbox || 'contact@normless.store'} · {!mb ? '…' : !mb.configured ? 'not connected yet' : mb.last_error ? `can’t read it: ${mb.last_error}` : `checked ${when(mb.last_run_at) || 'soon'}`}
            {data && ` · AI agent ${data.agent_on ? 'answering' : 'not answering'}`}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <Link className="btn btn-secondary" to="/support">Tickets</Link>
          {canEdit && mb?.configured && <button className="btn btn-primary" onClick={sync}><Icon name="refresh" size={15} /> Check now</button>}
        </div>
      </div>

      {mb && !mb.configured && (
        <section className="was-card em-setup">
          <h3>Connect contact@normless.store</h3>
          <p>The server needs the mailbox and a Google app password for it (SUPPORT_MAIL_USER, SUPPORT_MAIL_PASSWORD). Once they are set, new email shows here within two minutes, and the AI agent answers it when “Answer emails” is ticked on the AI agent page.</p>
        </section>
      )}

      <div className="scan-tabs" style={{ marginBottom: 12 }}>
        {VIEWS.map(v => (
          <button key={v.key} className={view === v.key ? 'active' : ''} onClick={() => setView(v.key)}>
            {v.label}
            {v.key === 'needs' && data?.counts?.needs > 0 && <span className="tab-badge">{data.counts.needs}</span>}
          </button>
        ))}
      </div>

      <div className="em-layout">
        <div className="em-list">
          <input className="input" placeholder="Search name, email or subject" value={search} onChange={e => setSearch(e.target.value)} />
          {!data ? <p className="em-muted">Loading…</p>
            : !data.threads.length ? <p className="em-muted">Nothing here.</p>
              : data.threads.map(t => (
                <button key={t.id} type="button" className={`em-row${openId === t.id ? ' active' : ''}`} onClick={() => open(t.id)}>
                  <div className="em-row-top">
                    <b>{t.customer_name || t.customer_email}</b>
                    <span>{when(t.last_message_at)}</span>
                  </div>
                  <div className="em-row-subj">{t.subject}</div>
                  <div className="em-row-prev">{t.last_direction === 'out' ? (t.last_sender === 'ai' ? 'AI: ' : 'You: ') : ''}{t.preview}</div>
                  <div className="em-row-tags">
                    {t.ai_paused && <span className="em-pill em-pill-quiet">AI paused</span>}
                    {AI_LOOK[t.ai_state] && <span className={`em-pill ${AI_LOOK[t.ai_state].cls}`}>{AI_LOOK[t.ai_state].label}</span>}
                    {t.status === 'closed' && <span className="em-pill em-pill-quiet">Closed</span>}
                  </div>
                </button>
              ))}
        </div>
        <div className="em-thread">
          {openId ? <Thread id={openId} canEdit={canEdit} onChanged={load} />
            : <p className="em-muted em-empty">Pick an email on the left.</p>}
        </div>
      </div>
    </div>
  )
}

function Thread({ id, canEdit, onChanged }) {
  const apiFetch = useApi()
  const toast = useToast()
  const [d, setD] = useState(null)
  const [reply, setReply] = useState('')
  const [answer, setAnswer] = useState('')
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const r = await apiFetch(`${API}/threads/${id}`)
    if (r && !r.error) setD(r)
    else toast.error(r?.error || 'Could not open it')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])
  useEffect(() => { setD(null); setReply(''); setAnswer(''); load() }, [load])

  const post = async (path, body, ok) => {
    setBusy(true)
    const r = await apiFetch(`${API}/threads/${id}/${path}`, { method: 'POST', body: JSON.stringify(body || {}) })
    setBusy(false)
    if (!r || r.error) { toast.error(r?.error || 'That didn’t work'); return null }
    if (ok) toast.success(typeof ok === 'function' ? ok(r) : ok)
    load(); onChanged?.()
    return r
  }

  if (!d) return <p className="em-muted">Loading…</p>
  const t = d.thread
  return (
    <div className="em-thread-inner">
      <div className="em-thread-head">
        <div>
          <h3>{t.subject}</h3>
          <span className="em-muted">{t.customer_name ? `${t.customer_name} · ` : ''}{t.customer_email}</span>
        </div>
        {canEdit && (
          <div className="em-actions">
            <button className="mini-btn" disabled={busy} onClick={() => post('state', { ai_paused: !t.ai_paused }, t.ai_paused ? 'The AI agent may answer this email again' : 'The AI agent stays out of this email')}>
              {t.ai_paused ? 'Let the AI reply' : 'I’ll handle this one'}
            </button>
            {t.status === 'open'
              ? <button className="mini-btn" disabled={busy} onClick={() => post('state', { status: 'closed' }, 'Closed')}>Close</button>
              : <button className="mini-btn" disabled={busy} onClick={() => post('state', { status: 'open' }, 'Reopened')}>Reopen</button>}
          </div>
        )}
      </div>

      {!!d.tickets.length && (
        <div className="em-tickets">
          {d.tickets.map(k => <Link key={k.id} to={`/support?focus=${k.id}`} className="em-pill em-pill-ai">{refOf(k)} · {k.reason || 'Ticket'} · {k.status}</Link>)}
        </div>
      )}

      <div className="em-msgs">
        {d.messages.map(m => (
          <div key={m.id} className={`em-msg em-msg-${m.direction}${m.sender_type === 'ai' ? ' em-msg-ai' : ''}`}>
            <div className="em-msg-head">
              <b>{m.direction === 'in' ? (m.from_name || m.from_email) : m.sender_type === 'ai' ? 'AI agent' : (m.sender_user || 'Team').split('@')[0]}</b>
              <span>{when(m.created_at)}{m.status === 'failed' ? ' · not sent' : ''}</span>
            </div>
            <div className="em-msg-body">{m.body || <i className="em-muted">(no text)</i>}</div>
            {m.error && <div className="em-error">{m.error}</div>}
            {!!m.attachments.length && (
              <div className="em-atts">
                {m.attachments.map(a => String(a.mime).startsWith('image/')
                  ? <a key={a.url} href={a.url} target="_blank" rel="noreferrer"><img src={a.url} alt={a.name} /></a>
                  : <a key={a.url} href={a.url} target="_blank" rel="noreferrer" className="em-file"><Icon name="note" size={13} /> {a.name}</a>)}
              </div>
            )}
          </div>
        ))}
      </div>

      {t.ai_state === 'asked' && (
        <section className="was-card em-question">
          <h4><Icon name="spark" size={13} /> The AI agent asked</h4>
          <p>{t.ai_question}</p>
          {canEdit && (
            <>
              <textarea className="input" rows={3} placeholder="Your answer. The agent writes the email to the customer from it." value={answer} onChange={e => setAnswer(e.target.value)} />
              <div className="em-row-actions">
                <label className="nla-check"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} /> Remember this for next time</label>
                <button className="btn btn-primary" disabled={busy || !answer.trim()} onClick={async () => {
                  const r = await post('answer', { answer, remember }, (x) => x.replied ? 'The agent replied to the customer' : `Answer saved${x.skipped ? `: ${x.skipped}` : ''}`)
                  if (r) setAnswer('')
                }}>Send to the agent</button>
              </div>
            </>
          )}
        </section>
      )}

      {canEdit && (
        <div className="em-compose">
          <textarea className="input" rows={5} placeholder={`Reply to ${t.customer_name || t.customer_email} yourself`} value={reply} onChange={e => setReply(e.target.value)} />
          <div className="em-row-actions">
            {d.agent?.on && !t.ai_paused && <button className="mini-btn" disabled={busy} onClick={() => post('run', {}, (x) => x.replied ? 'The agent replied' : x.asked ? 'The agent has a question' : x.skipped || 'Nothing to do')}>Let the AI answer now</button>}
            <button className="btn btn-primary" disabled={busy || !reply.trim()} onClick={async () => {
              const r = await post('reply', { body: reply }, 'Sent')
              if (r) setReply('')
            }}>Send reply</button>
          </div>
        </div>
      )}
    </div>
  )
}
