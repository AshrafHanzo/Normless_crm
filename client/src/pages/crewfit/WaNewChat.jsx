import { useState, useEffect } from 'react'
import { useApi, useAuth } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'

/**
 * New chat: the team writing to a customer first.
 *
 * A number from a phone call, or a customer whose order has a problem. The chat is found or made
 * by number; if the customer wrote in the last 24 hours it simply opens. Otherwise WhatsApp only
 * accepts an approved template as the first message, so one is chosen here — the short "this is
 * Anu from Crewfit…" openers first — and the chat opens once it has gone. When the customer
 * replies, the chat is open for 24 hours like any other.
 */

const fill = (text, values) => String(text || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (m, n) => values?.[Number(n) - 1] || m)
const myName = (user) => {
  const local = String(user?.username || '').split('@')[0]
  const first = local.split(/[._\-+\s]/)[0].replace(/\d+/g, '') || local
  return first ? first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() : ''
}
const STATUS = { APPROVED: 'Approved', PENDING: 'In review at Meta', IN_APPEAL: 'In review at Meta', REJECTED: 'Rejected by Meta' }

export default function WaNewChat({ API, brandName, onClose, onOpened }) {
  const apiFetch = useApi()
  const toast = useToast()
  const { user } = useAuth()
  const [phone, setPhone] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [conv, setConv] = useState(null)              // the thread, once found or made
  const [openers, setOpeners] = useState([])
  const [templates, setTemplates] = useState([])
  const [picked, setPicked] = useState(null)          // { name, language, body, variables }
  const [values, setValues] = useState([])
  const [canSubmit, setCanSubmit] = useState(false)

  useEffect(() => {
    apiFetch(`${API}/openers`).then(r => { if (r && !r.error) { setOpeners(r.openers); setCanSubmit(!!r.canSubmit) } })
    apiFetch(`${API}/templates`).then(r => r && !r.error && setTemplates(r.templates || []))
  }, [API]) // eslint-disable-line react-hooks/exhaustive-deps

  const pickOpener = (o, customer = conv?.display_name || name) => {
    setPicked({ name: o.name, language: o.language, body: o.body, variables: o.gaps.length })
    setValues(o.gaps.map(g => (g === 'name' ? String(customer || '').split(' ')[0] : g === 'me' ? myName(user) : '')))
  }
  const pickTemplate = (t) => {
    setPicked({ name: t.name, language: t.language, body: t.body_text, variables: t.variables || 0 })
    setValues(Array.from({ length: t.variables || 0 }, (_, i) => (i === 0 ? String(conv?.display_name || name || '').split(' ')[0] : '')))
  }

  const start = async (e) => {
    e.preventDefault()
    setBusy(true)
    const r = await apiFetch(`${API}/conversations/start`, { method: 'POST', body: JSON.stringify({ phone, name }) })
    setBusy(false)
    if (!r || r.error) return toast.error(r?.error || 'Could not start that chat')
    if (r.conversation?.window_open) {
      toast.success(r.existed ? 'They wrote in the last 24 hours — the chat is open' : 'Chat started')
      return onOpened(r.conversation.id)
    }
    setConv({ ...r.conversation, existed: r.existed })
    setOpeners(r.openers || openers)
    const first = (r.openers || openers).find(o => o.status === 'APPROVED')
    if (first) pickOpener(first, r.conversation?.display_name || name)
  }

  const send = async () => {
    if (values.slice(0, picked.variables).some(v => !String(v).trim())) return toast.error('Fill in every gap first')
    setBusy(true)
    const r = await apiFetch(`${API}/conversations/${conv.id}/template`, {
      method: 'POST', body: JSON.stringify({ name: picked.name, language: picked.language, variables: values.slice(0, picked.variables) }),
    })
    setBusy(false)
    if (!r || r.error) return toast.error(r?.error || 'Could not send that', { duration: 0 })
    toast.success('Sent — the chat opens fully when they reply')
    onOpened(conv.id)
  }

  const submitOpeners = async () => {
    setBusy(true)
    const r = await apiFetch(`${API}/openers`, { method: 'POST' })
    setBusy(false)
    if (!r || r.error) return toast.error(r?.error || 'Meta refused that', { duration: 0 })
    setOpeners(r.openers)
    const bad = r.results.filter(x => x.status === 'FAILED')
    if (bad.length) toast.error(`Meta refused ${bad.map(x => x.name).join(', ')}: ${bad[0].error}`, { duration: 0 })
    else toast.success('Sent to Meta for review — usually approved within minutes. Sync templates to see when.')
  }

  const approvedOpeners = openers.filter(o => o.status === 'APPROVED')
  const missing = openers.filter(o => !o.status)
  const others = templates.filter(t => /^(nl_|nlcrm_|normless_|crewfit_)/.test(t.name) && !/\d{13}$/.test(t.name) && !openers.some(o => o.name === t.name))

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="New chat">
        <div className="drawer-header">
          <div>
            <h2>New chat</h2>
            <div className="packed-sub">Message a customer first — a new number from a call, or about their order.</div>
          </div>
          <button type="button" className="btn-icon" aria-label="Close" onClick={onClose}><Icon name="close" size={16} /></button>
        </div>

        {!conv ? (
          <form className="drawer-body wnc-body" onSubmit={start}>
            <div className="input-group">
              <label htmlFor="wnc-phone">WhatsApp number</label>
              <input id="wnc-phone" inputMode="tel" autoFocus required value={phone} placeholder="98765 43210 or +971 50 123 4567"
                onChange={e => setPhone(e.target.value)} />
              <span className="was-hint">A 10-digit number is taken as Indian (+91).</span>
            </div>
            <div className="input-group">
              <label htmlFor="wnc-name">Name <span className="label-hint">optional</span></label>
              <input id="wnc-name" value={name} placeholder="Rahul" onChange={e => setName(e.target.value)} />
            </div>
            <div className="wnc-rule">
              <Icon name="info" size={15} />
              <p>WhatsApp lets you write freely only within 24 hours of the customer’s last message. To write first, the first message must be an approved template — you’ll pick one next. Once they reply, you can chat normally.</p>
            </div>
            <div className="drawer-footer wnc-footer">
              <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={busy || !phone.trim()}>{busy ? 'Finding…' : 'Continue'}</button>
            </div>
          </form>
        ) : (
          <>
            <div className="drawer-body wnc-body">
              <div className="wnc-who">
                <b>{conv.display_name || conv.phone_pretty}</b>
                <span className="was-hint">{conv.phone_pretty} · {conv.existed ? 'chat found' : 'no message from them in the last 24 hours'}</span>
              </div>

              <div className="wnc-section">
                <span className="wnc-label">Start with</span>
                {approvedOpeners.map(o => (
                  <button key={o.name} type="button" className={`nl-pick${picked?.name === o.name ? ' on' : ''}`} onClick={() => pickOpener(o)} aria-pressed={picked?.name === o.name}>
                    <span className="nl-pick-head"><b>{o.label}</b><span className="status-badge success">Ready</span></span>
                    <span className="nl-pick-body">{fill(o.body, o.examples)}</span>
                  </button>
                ))}
                {openers.filter(o => o.status && o.status !== 'APPROVED').map(o => (
                  <div key={o.name} className="wnc-note"><b>{o.label}</b> <span className={`status-badge ${o.status === 'REJECTED' ? 'error' : 'pending'}`}>{STATUS[o.status] || o.status}</span></div>
                ))}
                {!!missing.length && (canSubmit ? (
                  <div className="wnc-note">
                    <span>{brandName}’s follow-up templates aren’t set up yet (“following up on our call”, “about your order”).</span>
                    <button type="button" className="mini-btn mini-btn-active" disabled={busy} onClick={submitOpeners}>Submit them to Meta</button>
                  </div>
                ) : <p className="was-hint">The follow-up templates aren’t set up yet — ask someone with WhatsApp settings access to add them from New chat.</p>)}
                {!!others.length && (
                  <details className="nl-picker-more">
                    <summary>Other approved templates ({others.length})</summary>
                    {others.map(t => (
                      <button key={`${t.name}|${t.language}`} type="button" className={`nl-pick${picked?.name === t.name ? ' on' : ''}`} onClick={() => pickTemplate(t)}>
                        <span className="nl-pick-head"><b>{t.name}</b></span>
                        <span className="nl-pick-body">{t.body_text}</span>
                      </button>
                    ))}
                  </details>
                )}
              </div>

              {picked && (
                <div className="wnc-section">
                  <span className="wnc-label">Fill in</span>
                  {Array.from({ length: picked.variables }, (_, i) => (
                    <label key={i} className="nl-auto-gap">
                      <code>{`{{${i + 1}}}`}</code>
                      <input value={values[i] || ''} placeholder={['Customer’s name', 'Your name', 'Order number'][i] || 'Value'}
                        onChange={e => setValues(v => { const n = [...v]; n[i] = e.target.value; return n })} />
                    </label>
                  ))}
                  <div className="nl-tpl-phone wnc-preview" aria-label="Preview">
                    <div className="nl-tpl-bubble"><div className="nl-tpl-body">{fill(picked.body, values)}</div><span className="nl-tpl-time">now</span></div>
                  </div>
                </div>
              )}
            </div>
            <div className="drawer-footer">
              <button type="button" className="btn btn-secondary" onClick={() => onOpened(conv.id)}>Just open the chat</button>
              <button type="button" className="btn btn-primary" disabled={busy || !picked} onClick={send}>{busy ? 'Sending…' : 'Send'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
