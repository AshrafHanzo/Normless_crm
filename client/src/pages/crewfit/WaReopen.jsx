import { useState, useEffect } from 'react'
import { useApi } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import { Loading } from './waSettingsUi'
import { useWaBrand } from './waBrand'
import { TemplatePreview, TemplateEditor } from './NlSettings'
import { STATUS_LOOK } from './nlTemplates'

/**
 * Templates › Reopen chats, for either brand: the templates the team sends to start a chat, or to
 * pick one up again once the customer has been quiet for more than a day (the chat's Template
 * button and New chat show these first). Each can be submitted to Meta and edited here.
 */

export default function WaReopen() {
  const apiFetch = useApi()
  const toast = useToast()
  const brand = useWaBrand()
  const [data, setData] = useState(null)
  const [byName, setByName] = useState({})
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(null)
  const load = () => Promise.all([apiFetch(`${brand.api}/openers`), apiFetch(`${brand.api}/tpl/templates`)]).then(([o, t]) => {
    if (!o || o.error) return toast.error(o?.error || 'Could not load the templates')
    setData(o)
    if (t && !t.error) setByName(Object.fromEntries(t.templates.map(x => [x.name, x])))
  })
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    setBusy(true)
    const r = await apiFetch(`${brand.api}/openers`, { method: 'POST' })
    setBusy(false)
    if (!r || r.error) return toast.error(r?.error || 'Meta refused that', { duration: 0 })
    const bad = r.results.filter(x => x.status === 'FAILED')
    if (bad.length) toast.error(`Meta refused ${bad.map(x => x.name).join(', ')}: ${bad[0].error}`, { duration: 0 })
    else toast.success('Sent to Meta for review — usually approved within minutes')
    load()
  }

  if (!data) return <Loading />
  const missing = data.openers.filter(o => !o.status)
  return (
    <>
      <div className="nl-auto-bar">
        <p className="was-hint">WhatsApp lets you write freely only within 24 hours of the customer’s last message. After that — or to message someone first — start with one of these. They show first in a chat’s Template button and in New chat. Once the customer replies, the chat is open as usual.</p>
        {data.canSubmit && !!missing.length && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={submit}>{busy ? 'Sending…' : `Submit ${missing.length} to Meta`}</button>}
      </div>
      <section className="was-card">
        <div className="wmk-templates">
          {data.openers.map(o => {
            const t = byName[o.name]
            const [look, word] = o.status ? [STATUS_LOOK[o.status] || '', o.status === 'APPROVED' ? 'Approved' : o.status === 'REJECTED' ? 'Rejected' : 'In review'] : ['', 'Not submitted']
            return (
              <div key={o.name} className="wmk-template">
                <div className="nl-pick-head">
                  <b>{o.label}</b><span className={`status-badge ${look}`}>{word}</span>
                  {data.canSubmit && t && <button type="button" className="mini-btn" onClick={() => setEditing(t)}><Icon name="edit" size={11} /> Edit</button>}
                </div>
                <TemplatePreview body={t?.body_text || o.body} examples={o.examples} footer="" buttons={[]} />
                <span className="was-hint">{o.name} · fills in: {o.gaps.map(g => (g === 'name' ? 'their name' : g === 'me' ? 'your name' : 'the order')).join(', ')}</span>
                {t?.rejected_reason && t.rejected_reason !== 'NONE' && <span className="was-bad">Meta: {t.rejected_reason}</span>}
              </div>
            )
          })}
        </div>
      </section>
      {editing && <TemplateEditor template={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load() }} />}
    </>
  )
}
