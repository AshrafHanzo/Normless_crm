import { useState, useEffect } from 'react'
import { useApi } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import { SaveButton, Head, Toggle, Loading } from './waSettingsUi'
import { useWaBrand } from './waBrand'

/**
 * Settings › Calls & new chats, for either brand: whether WhatsApp calling is on for the number,
 * whether calls taken in the CRM are recorded (and what the customer is told), and the follow-up
 * templates the team uses to write to a customer first.
 */

const CALL_STATUS = {
  ENABLED: ['success', 'On'], DISABLED: ['', 'Off'], NOT_SET: ['', 'Not switched on'],
  NOT_CONFIGURED: ['error', 'Number not connected'], ERROR: ['error', 'Could not check'],
}
const TEMPLATE_STATUS = { APPROVED: ['success', 'Approved'], PENDING: ['pending', 'In review'], IN_APPEAL: ['pending', 'In review'], REJECTED: ['error', 'Rejected'] }
const fill = (text, values) => String(text || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (m, n) => values?.[Number(n) - 1] || m)

export function WaCallsTab() {
  const apiFetch = useApi()
  const toast = useToast()
  const brand = useWaBrand()
  const [calling, setCalling] = useState(null)
  const [rec, setRec] = useState(null)
  const [saved, setSaved] = useState(null)
  const [openers, setOpeners] = useState(null)
  const [busy, setBusy] = useState('')

  const load = (fresh = false) => Promise.all([apiFetch(`${brand.api}/calls/settings${fresh ? '?fresh=1' : ''}`), apiFetch(`${brand.api}/openers`)]).then(([c, o]) => {
    if (c) { setCalling(c); if (c.recording) { setRec(c.recording); setSaved(c.recording) } }
    if (o && !o.error) setOpeners(o)
  })
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const canEdit = !!calling?.canSettings
  const switchCalling = async (on) => {
    setBusy('calling')
    const r = await apiFetch(`${brand.api}/calls/settings`, { method: 'PUT', body: JSON.stringify({ enabled: on }) })
    setBusy('')
    if (!r || r.error) return toast.error(r?.error || 'WhatsApp refused that', { duration: 0 })
    setCalling(c => ({ ...c, ...r })); toast.success(on ? 'Calling is on for this number' : 'Calling is off')
  }
  const saveRec = async () => {
    setBusy('rec')
    const r = await apiFetch(`${brand.api}/calls/recording`, { method: 'PUT', body: JSON.stringify(rec) })
    setBusy('')
    if (!r || r.error) return toast.error(r?.error || 'Could not save that')
    setRec(r.recording); setSaved(r.recording); toast.success('Saved')
  }
  const submitOpeners = async () => {
    setBusy('openers')
    const r = await apiFetch(`${brand.api}/openers`, { method: 'POST' })
    setBusy('')
    if (!r || r.error) return toast.error(r?.error || 'Meta refused that', { duration: 0 })
    setOpeners(o => ({ ...o, openers: r.openers }))
    const bad = r.results.filter(x => x.status === 'FAILED')
    if (bad.length) toast.error(`Meta refused ${bad.map(x => x.name).join(', ')}: ${bad[0].error}`, { duration: 0 })
    else toast.success('Sent to Meta for review — sync templates to see when they are approved')
  }

  if (!calling || !openers) return <Loading />
  const [look, word] = CALL_STATUS[calling.status] || ['', calling.status]
  const dirty = rec && saved && JSON.stringify(rec) !== JSON.stringify(saved)

  return (
    <>
      <Head title="Calls & new chats">Calling customers from the inbox, recording those calls, and the templates for writing to a customer first.</Head>

      <section className="was-card">
        <div className="was-card-head">
          <h3>WhatsApp calling</h3>
          <span className={`status-badge ${look}`}>{word}</span>
        </div>
        <p className="was-hint">Lets the team call customers from a chat, and customers call this number on WhatsApp — the call rings in the inbox.</p>
        {calling.error && <p className="was-bad">{calling.error}</p>}
        {canEdit && calling.status !== 'NOT_CONFIGURED' && (
          <div className="was-inline">
            {calling.enabled
              ? <button type="button" className="btn btn-secondary btn-sm" disabled={busy === 'calling'} onClick={() => switchCalling(false)}>Switch calling off</button>
              : <button type="button" className="btn btn-primary btn-sm" disabled={busy === 'calling'} onClick={() => switchCalling(true)}><Icon name="phone" size={13} /> Switch calling on</button>}
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => load(true)}><Icon name="refresh" size={13} /> Check again</button>
          </div>
        )}
        {!calling.enabled && <p className="was-hint">Before it can be switched on, the Meta app connected to this number must have its webhook subscribed to the <b>calls</b> field (developers.facebook.com › your app › WhatsApp › Configuration › Webhook fields).</p>}
      </section>

      {rec && (
        <section className="was-card">
          <div className="was-card-head"><h3>Call recording</h3>{canEdit && <SaveButton dirty={dirty} saving={busy === 'rec'} onClick={saveRec} />}</div>
          <div className="was-switch-row">
            <div><b>Record calls taken in the CRM</b><p className="was-hint">Both voices, recorded in the browser on the call and kept on the call’s line in the chat. Calls answered on a phone or a SIM can’t be recorded.</p></div>
            <Toggle on={rec.record} label="Record calls" disabled={!canEdit} onChange={v => setRec(r => ({ ...r, record: v }))} />
          </div>
          <div className="was-switch-row">
            <div><b>Tell the customer in the chat</b><p className="was-hint">Sent once when a recorded call connects, if WhatsApp allows a message then (within 24 hours of their last message). If it doesn’t, the person on the call is reminded to say it.</p></div>
            <Toggle on={rec.notice_in_chat} label="Send the recording notice" disabled={!canEdit || !rec.record} onChange={v => setRec(r => ({ ...r, notice_in_chat: v }))} />
          </div>
          <div className="input-group">
            <label htmlFor="wcs-notice">Notice</label>
            <input id="wcs-notice" maxLength={300} value={rec.notice} disabled={!canEdit || !rec.record} onChange={e => setRec(r => ({ ...r, notice: e.target.value }))} />
          </div>
        </section>
      )}

      <section className="was-card">
        <div className="was-card-head">
          <h3>Follow-up templates</h3>
          {canEdit && openers.openers.some(o => !o.status) && (
            <button type="button" className="btn btn-primary btn-sm" disabled={busy === 'openers'} onClick={submitOpeners}>{busy === 'openers' ? 'Sending…' : 'Submit to Meta'}</button>
          )}
        </div>
        <p className="was-hint">What <b>New chat</b> sends first when the customer hasn’t written in the last 24 hours — WhatsApp allows only an approved template then. Once they reply, the chat is open as usual.</p>
        {openers.openers.map(o => {
          const [l, w] = TEMPLATE_STATUS[o.status] || ['', o.status ? o.status.toLowerCase() : 'Not submitted']
          return (
            <div key={o.name} className="wcs-opener">
              <div className="nl-pick-head"><b>{o.label}</b><span className={`status-badge ${l}`}>{w}</span><span className="was-hint">{o.name}</span></div>
              <div className="nl-pick-body">{fill(o.body, o.examples)}</div>
            </div>
          )
        })}
      </section>
    </>
  )
}
