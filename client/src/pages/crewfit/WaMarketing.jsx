import { useState, useEffect, useRef } from 'react'
import { useApi, useAuth } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import { Head, Loading } from './waSettingsUi'
import { useWaBrand } from './waBrand'
import { TemplatePreview, TemplateEditor } from './NlSettings'
import { formFrom } from './nlTemplates'

/**
 * Templates › Marketing, for either brand: the brand's promotional templates, and broadcasts —
 * one template sent to many customers at once.
 *
 * A broadcast is made as a draft (template, what fills each gap, photo, link, who it goes to),
 * can be tried on your own number, and is then sent in the background at a steady pace. Anybody
 * who replied STOP or tapped "Stop promotions" is left out automatically.
 */

const STATUS = {
  draft: ['', 'Draft'], sending: ['pending', 'Sending'], paused: ['pending', 'Paused'], done: ['success', 'Sent'], cancelled: ['error', 'Cancelled'],
}
const TPL_STATUS = { APPROVED: ['success', 'Approved'], PENDING: ['pending', 'In review'], IN_APPEAL: ['pending', 'In review'], REJECTED: ['error', 'Rejected'] }
const fmtWhen = (v) => (v ? new Date(v).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—')
const num = (v) => Number(v || 0).toLocaleString('en-IN')
const keyOf = (t) => `${t.name}|${t.language}`

const SOURCES = {
  normless: [
    ['customers', 'Shopify customers'],
    ['chatted', 'People who have chatted on WhatsApp'],
    ['numbers', 'Paste numbers'],
  ],
  crewfit: [
    ['leads', 'Leads'],
    ['customers', 'Past order customers'],
    ['chatted', 'People who have chatted on WhatsApp'],
    ['numbers', 'Paste numbers'],
  ],
}

function Progress({ b }) {
  const done = (b.sent || 0) + (b.failed || 0) + (b.skipped || 0)
  const pctDone = b.total ? Math.round(done / b.total * 100) : 0
  return (
    <div className="wmk-progress" role="progressbar" aria-valuenow={pctDone} aria-valuemin={0} aria-valuemax={100} aria-label="Sent so far">
      <div style={{ width: `${pctDone}%` }} />
    </div>
  )
}

/** One broadcast's results, live while it sends. */
function BroadcastDrawer({ id, onClose, onChanged, canSend }) {
  const apiFetch = useApi()
  const toast = useToast()
  const brand = useWaBrand()
  const [b, setB] = useState(null)
  const [busy, setBusy] = useState(false)
  const load = () => apiFetch(`${brand.api}/marketing/broadcasts/${id}`).then(r => r && !r.error && setB(r.broadcast))
  useEffect(() => { load() }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (b?.status !== 'sending') return
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [b?.status]) // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (action) => {
    if (action === 'start' && !await toast.confirm({ title: `Send to ${num(b.total)} people?`, message: 'Meta charges for each marketing message delivered. People who replied STOP are left out. This can be paused while it sends.', confirmLabel: 'Send now' })) return
    if (action === 'cancel' && !await toast.confirm({ title: 'Cancel this broadcast?', message: 'Nobody else gets it. What has gone stays gone.', confirmLabel: 'Cancel it', danger: true })) return
    setBusy(true)
    const r = await apiFetch(`${brand.api}/marketing/broadcasts/${id}/${action}`, { method: 'POST' })
    setBusy(false)
    if (!r || r.error) return toast.error(r?.error || 'Could not do that')
    setB(r.broadcast); onChanged()
  }
  const c = b?.counts || {}
  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Broadcast">
        <div className="drawer-header">
          <div><h2>{b?.name || 'Broadcast'}</h2><div className="packed-sub">{b ? `${b.template} · made ${fmtWhen(b.created_at)}${b.created_by ? ` by ${b.created_by.split('@')[0]}` : ''}` : ''}</div></div>
          <button type="button" className="btn-icon" aria-label="Close" onClick={onClose}><Icon name="close" size={16} /></button>
        </div>
        {!b ? <Loading /> : (
          <div className="drawer-body wmk-report">
            <div className="was-inline"><span className={`status-badge ${STATUS[b.status]?.[0] || ''}`}>{STATUS[b.status]?.[1] || b.status}</span>
              <span className="was-hint">{num((b.sent || 0) + (b.failed || 0) + (b.skipped || 0))} of {num(b.total)} done</span></div>
            <Progress b={b} />
            {b.error && <p className="was-bad">{b.error}</p>}
            <div className="wdb-mini">
              <div><span className="wdb-lbl">Sent</span><b>{num(c.sent)}</b></div>
              <div><span className="wdb-lbl">Delivered</span><b>{num(c.delivered)}</b></div>
              <div><span className="wdb-lbl">Read</span><b>{num(c.read)}</b></div>
              <div><span className="wdb-lbl">Replied</span><b>{num(c.replied)}</b></div>
              <div><span className="wdb-lbl">Link taps</span><b>{num(c.taps)}</b></div>
              <div><span className="wdb-lbl">Not sent</span><b className={c.failed ? 'wdb-bad' : ''}>{num(c.failed)}</b><span className="wdb-sub">{num(b.skipped)} opted out since</span></div>
            </div>
            {!!b.errors?.length && (
              <div className="wmk-errors">
                <span className="wdb-lbl">Why some weren’t sent</span>
                {b.errors.map(e => <div key={e.error}><b>{num(e.n)}</b> {e.error}</div>)}
                <p className="was-hint">“Healthy ecosystem” means Meta held back marketing to that person because they’ve had many recently — it isn’t charged.</p>
              </div>
            )}
            <div className="was-hint">Audience: {b.audience?.source || '—'}{b.audience?.opted_out ? ` · ${num(b.audience.opted_out)} left out for saying STOP` : ''}</div>
          </div>
        )}
        {b && canSend && (
          <div className="drawer-footer">
            {['draft', 'paused'].includes(b.status) && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act('start')}>{b.status === 'paused' ? 'Carry on sending' : `Send to ${num(b.total)}`}</button>}
            {b.status === 'sending' && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => act('pause')}>Pause</button>}
            {['draft', 'sending', 'paused'].includes(b.status) && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => act('cancel')}>Cancel broadcast</button>}
          </div>
        )}
      </div>
    </div>
  )
}

/** Making a broadcast: template, gaps, photo, link, audience, a test, then save. */
function NewBroadcast({ data, onClose, onMade }) {
  const apiFetch = useApi()
  const toast = useToast()
  const brand = useWaBrand()
  const { user } = useAuth()
  const approved = data.approved
  const ours = data.ours
  // The brand's own marketing templates first, in their own order; anything else approved after.
  const ownApproved = ours.map(o => approved.find(t => t.name === o.name)).filter(Boolean)
  const otherApproved = approved.filter(t => !ours.some(o => o.name === t.name))
  const [tplKey, setTplKey] = useState(() => {
    const first = ownApproved[0] || approved[0]
    return first ? keyOf(first) : ''
  })
  const t = approved.find(x => keyOf(x) === tplKey)
  const def = t && ours.find(o => o.name === t.name)
  // A fresh set of gaps for a template: our own templates say what each one is.
  const varsFor = (key) => {
    const tt = approved.find(x => keyOf(x) === key)
    const dd = tt && ours.find(o => o.name === tt.name)
    return Array.from({ length: tt?.variables || 0 }, (_, i) => {
      const g = dd?.gaps?.[i]
      if (g?.[0] === 'first_name' || (!dd && i === 0)) return { source: 'first_name', value: '', fallback: 'there' }
      return { source: 'text', value: '', label: g?.[0], example: g?.[1] }
    })
  }
  const labelFor = (key) => { const tt = approved.find(x => keyOf(x) === key); return (tt && ours.find(o => o.name === tt.name)?.label) || tt?.name || '' }
  const [name, setName] = useState(() => labelFor(tplKey))
  const [vars, setVars] = useState(() => varsFor(tplKey))
  const [image, setImage] = useState('')
  const [link, setLink] = useState(brand.key === 'normless' ? 'https://normless.store' : '')
  const [aud, setAud] = useState({ source: SOURCES[brand.key][0][0], min_orders: 1 })
  const [count, setCount] = useState(null)
  const [products, setProducts] = useState([])
  const [testPhone, setTestPhone] = useState('')
  const [busy, setBusy] = useState('')
  const countKey = useRef('')

  const comps = t?.components || []
  const hasImage = comps.some(c => c.type === 'HEADER' && c.format === 'IMAGE')
  const urlBtn = (comps.find(c => c.type === 'BUTTONS')?.buttons || []).find(b => b.type === 'URL' && /\{\{1\}\}/.test(b.url || ''))
  const f = t ? formFrom(t) : null

  useEffect(() => {
    if (brand.key === 'normless') apiFetch(`${brand.api}/marketing/products`).then(r => r && !r.error && setProducts(r.products || []))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const payload = () => ({ name, template: tplKey, vars, header_image: image, link_url: link, audience: aud })
  const setA = (patch) => { setAud(a => ({ ...a, ...patch })); setCount(null) }
  const doCount = async () => {
    setBusy('count')
    const key = JSON.stringify(aud)
    countKey.current = key
    const r = await apiFetch(`${brand.api}/marketing/audience`, { method: 'POST', body: JSON.stringify({ audience: aud }) })
    setBusy('')
    if (countKey.current !== key) return
    if (!r || r.error) return toast.error(r?.error || 'Could not count that')
    setCount(r)
  }
  const test = async () => {
    setBusy('test')
    const me = String(user?.username || '').split('@')[0]
    const r = await apiFetch(`${brand.api}/marketing/test`, { method: 'POST', body: JSON.stringify({ ...payload(), phone: testPhone, test_name: me.charAt(0).toUpperCase() + me.slice(1) }) })
    setBusy('')
    if (!r || r.error) return toast.error(r?.error || 'Could not send the test', { duration: 0 })
    toast.success('Test sent — check your WhatsApp')
  }
  const save = async () => {
    setBusy('save')
    const r = await apiFetch(`${brand.api}/marketing/broadcasts`, { method: 'POST', body: JSON.stringify(payload()) })
    setBusy('')
    if (!r || r.error) return toast.error(r?.error || 'Could not make that broadcast', { duration: 0 })
    toast.success(`Saved for ${num(r.broadcast.total)} people — send it when ready`)
    onMade(r.broadcast.id)
  }
  const setVar = (i, patch) => setVars(v => v.map((x, k) => (k === i ? { ...x, ...patch } : x)))
  const ready = t && name.trim() && vars.every(v => v.source === 'first_name' || v.value.trim()) && (!hasImage || /^https:\/\//.test(image)) && (!urlBtn || /^https:\/\//.test(link))
  const examples = vars.map(v => (v.source === 'first_name' ? 'Meera' : v.value || `{{…}}`))

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer drawer-wide" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="New broadcast">
        <div className="drawer-header">
          <div><h2>New broadcast</h2><div className="packed-sub">One marketing template to many customers. People who said STOP are left out.</div></div>
          <button type="button" className="btn-icon" aria-label="Close" onClick={onClose}><Icon name="close" size={16} /></button>
        </div>
        <div className="drawer-body nl-tpl-editor">
          <div className="nl-tpl-form">
            {!approved.length ? <p className="was-hint">No approved marketing template yet — submit the marketing templates to Meta first.</p> : (
              <>
                <div className="form-row">
                  <div className="input-group">
                    <label htmlFor="wmk-tpl">Template</label>
                    <select id="wmk-tpl" value={tplKey} onChange={e => { setTplKey(e.target.value); setVars(varsFor(e.target.value)); setName(labelFor(e.target.value)) }}>
                      {!!ownApproved.length && <optgroup label={`${brand.name} marketing`}>{ownApproved.map(x => <option key={keyOf(x)} value={keyOf(x)}>{ours.find(o => o.name === x.name)?.label}</option>)}</optgroup>}
                      {!!otherApproved.length && <optgroup label="Other marketing templates">{otherApproved.map(x => <option key={keyOf(x)} value={keyOf(x)}>{x.name}</option>)}</optgroup>}
                    </select>
                  </div>
                  <div className="input-group">
                    <label htmlFor="wmk-name">Broadcast name <span className="label-hint">for you</span></label>
                    <input id="wmk-name" value={name} maxLength={120} placeholder="Diwali sale" onChange={e => setName(e.target.value)} />
                  </div>
                </div>

                {!!vars.length && (
                  <div className="nl-auto-gaps">
                    <span className="wnc-label">What fills the message</span>
                    {vars.map((v, i) => (
                      <div key={i} className="wmk-gap">
                        <code>{`{{${i + 1}}}`}</code>
                        {def ? <span className="wmk-gap-label">{v.source === 'first_name' ? 'Customer’s first name' : v.label}</span> : (
                          <select aria-label={`What fills {{${i + 1}}}`} value={v.source} onChange={e => setVar(i, { source: e.target.value })}>
                            <option value="first_name">Customer’s first name</option><option value="text">The same text for everyone</option>
                          </select>
                        )}
                        {v.source === 'first_name'
                          ? <input aria-label="When there’s no name" value={v.fallback} placeholder="When there’s no name" onChange={e => setVar(i, { fallback: e.target.value })} />
                          : <input aria-label={`Text for {{${i + 1}}}`} value={v.value} placeholder={v.example ? `e.g. ${v.example}` : 'Text'} onChange={e => setVar(i, { value: e.target.value })} />}
                      </div>
                    ))}
                  </div>
                )}

                {hasImage && (
                  <div className="input-group">
                    <label htmlFor="wmk-img">Photo</label>
                    {!!products.length && (
                      <select aria-label="Use a product’s photo" value="" onChange={e => { const p = products[Number(e.target.value)]; if (p) { setImage(p.image); if (p.url) setLink(p.url) } }}>
                        <option value="">Use a product’s photo (and link)…</option>
                        {products.map((p, i) => <option key={i} value={i}>{p.title}</option>)}
                      </select>
                    )}
                    <input id="wmk-img" value={image} placeholder="https://… link to a JPG or PNG" onChange={e => setImage(e.target.value)} />
                  </div>
                )}
                {urlBtn && (
                  <div className="input-group">
                    <label htmlFor="wmk-link">“{urlBtn.text}” opens</label>
                    <input id="wmk-link" value={link} placeholder="https://normless.store/collections/…" onChange={e => setLink(e.target.value)} />
                    <span className="was-hint">Sent through our own short link, so taps are counted.</span>
                  </div>
                )}

                <div className="wnc-section">
                  <span className="wnc-label">Who it goes to</span>
                  <div className="nl-days" role="group" aria-label="Audience">
                    {SOURCES[brand.key].map(([k, label]) => (
                      <button key={k} type="button" className={`chip${aud.source === k ? ' chip-on' : ''}`} aria-pressed={aud.source === k} onClick={() => setA({ source: k })}>{label}</button>
                    ))}
                  </div>
                  {aud.source === 'customers' && brand.key === 'normless' && (
                    <div className="form-row">
                      <div className="input-group"><label htmlFor="wmk-mo">At least … orders</label><input id="wmk-mo" type="number" min={0} value={aud.min_orders ?? ''} onChange={e => setA({ min_orders: e.target.value })} /></div>
                      <div className="input-group"><label htmlFor="wmk-ow">Ordered in the last … days</label><input id="wmk-ow" type="number" min={0} placeholder="any time" value={aud.ordered_within_days ?? ''} onChange={e => setA({ ordered_within_days: e.target.value, not_ordered_days: '' })} /></div>
                      <div className="input-group"><label htmlFor="wmk-no">Not ordered in … days</label><input id="wmk-no" type="number" min={0} placeholder="win-back" value={aud.not_ordered_days ?? ''} onChange={e => setA({ not_ordered_days: e.target.value, ordered_within_days: '' })} /></div>
                      <div className="input-group"><label htmlFor="wmk-ms">Spent at least ₹</label><input id="wmk-ms" type="number" min={0} value={aud.min_spent ?? ''} onChange={e => setA({ min_spent: e.target.value })} /></div>
                    </div>
                  )}
                  {aud.source === 'leads' && (
                    <div className="nl-days" role="group" aria-label="Lead status">
                      {data.statuses.map(s => {
                        const on = (aud.statuses || []).includes(s.key)
                        return <button key={s.key} type="button" className={`chip${on ? ' chip-on' : ''}`} aria-pressed={on}
                          onClick={() => setA({ statuses: on ? aud.statuses.filter(x => x !== s.key) : [...(aud.statuses || []), s.key] })}>{s.name}</button>
                      })}
                      <span className="was-hint">{(aud.statuses || []).length ? '' : 'All statuses'}</span>
                    </div>
                  )}
                  {aud.source === 'chatted' && (
                    <div className="input-group"><label htmlFor="wmk-cw">Wrote to us in the last … days</label><input id="wmk-cw" type="number" min={0} placeholder="any time" value={aud.chatted_within_days ?? ''} onChange={e => setA({ chatted_within_days: e.target.value })} /></div>
                  )}
                  {aud.source === 'numbers' && (
                    <div className="input-group">
                      <label htmlFor="wmk-nums">Numbers <span className="label-hint">one per line, optionally “, name”</span></label>
                      <textarea id="wmk-nums" rows={5} value={aud.numbers || ''} placeholder={'98765 43210, Rahul\n+971 50 123 4567'} onChange={e => setA({ numbers: e.target.value })} />
                    </div>
                  )}
                  <div className="was-inline">
                    <button type="button" className="btn btn-secondary btn-sm" disabled={busy === 'count'} onClick={doCount}>{busy === 'count' ? 'Counting…' : 'Count people'}</button>
                    {count && <span><b>{num(count.count)}</b> people{count.opted_out ? <span className="was-hint"> · {num(count.opted_out)} left out for saying STOP</span> : null}</span>}
                  </div>
                </div>

                <div className="wnc-section">
                  <span className="wnc-label">Try it on your phone first</span>
                  <div className="was-inline">
                    <input aria-label="Your WhatsApp number" inputMode="tel" value={testPhone} placeholder="Your number" onChange={e => setTestPhone(e.target.value)} />
                    <button type="button" className="btn btn-secondary btn-sm" disabled={!ready || !testPhone.trim() || busy === 'test'} onClick={test}>{busy === 'test' ? 'Sending…' : 'Send test'}</button>
                  </div>
                </div>
              </>
            )}
          </div>
          <div className="nl-tpl-preview-col">
            <div className="was-hint">Preview, with “Meera” as the customer</div>
            {f && <TemplatePreview header={f.header} headerExample="" body={f.body} examples={examples} footer={f.footer} buttons={f.buttons} image={hasImage ? (image || true) : null} />}
          </div>
        </div>
        <div className="drawer-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!ready || busy === 'save'} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save — send from the next screen'}</button>
        </div>
      </div>
    </div>
  )
}

export default function WaMarketing() {
  const apiFetch = useApi()
  const toast = useToast()
  const brand = useWaBrand()
  const [data, setData] = useState(null)
  const [making, setMaking] = useState(false)
  const [open, setOpen] = useState(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(null)
  const [byName, setByName] = useState({})               // template rows (with ids) for Edit
  const load = () => Promise.all([apiFetch(`${brand.api}/marketing`), apiFetch(`${brand.api}/tpl/templates`)]).then(([r, t]) => {
    if (!r || r.error) toast.error(r?.error || 'Could not load marketing'); else setData(r)
    if (t && !t.error) setByName(Object.fromEntries(t.templates.map(x => [x.name, x])))
  })
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!data?.broadcasts?.some(b => b.status === 'sending')) return
    const t = setInterval(load, 4000)
    return () => clearInterval(t)
  }, [data]) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    setBusy(true)
    const r = await apiFetch(`${brand.api}/marketing/templates`, { method: 'POST' })
    setBusy(false)
    if (!r || r.error) return toast.error(r?.error || 'Meta refused that', { duration: 0 })
    const bad = r.results.filter(x => x.status === 'FAILED')
    if (bad.length) toast.error(`Meta refused ${bad.map(x => x.name).join(', ')}: ${bad[0].error}`, { duration: 0 })
    else toast.success('Sent to Meta for review — marketing templates usually take minutes to a day')
    load()
  }

  if (!data) return <Loading />
  const missing = data.ours.filter(t => !t.status)
  return (
    <>
      <div className="nl-auto-bar">
        <p className="was-hint">Offers and news to many customers at once. Meta charges for each marketing message delivered, and may hold some back for people who get a lot of marketing. Everyone can reply STOP or tap “Stop promotions” to opt out.</p>
        {data.canSend && <button type="button" className="btn btn-primary btn-sm" disabled={!data.approved.length} onClick={() => setMaking(true)}><Icon name="plus" size={13} /> New broadcast</button>}
      </div>

      <section className="was-card">
        <div className="was-card-head"><h3>Broadcasts</h3></div>
        {!data.broadcasts.length ? <p className="was-hint">None yet.{data.approved.length ? ' Make one with New broadcast.' : ' Once a marketing template is approved, make one with New broadcast.'}</p> : (
          <div className="data-table-wrapper wdb-table">
            <table className="data-table">
              <thead><tr><th scope="col">Broadcast</th><th scope="col">Template</th><th scope="col">People</th><th scope="col">Progress</th><th scope="col">Status</th><th scope="col">Made</th></tr></thead>
              <tbody>
                {data.broadcasts.map(b => (
                  <tr key={b.id} onClick={() => setOpen(b.id)} style={{ cursor: 'pointer' }}>
                    <td data-label=""><button type="button" className="wmk-link" onClick={(e) => { e.stopPropagation(); setOpen(b.id) }}>{b.name}</button></td>
                    <td data-label="Template">{data.ours.find(o => o.name === b.template)?.label || b.template}</td>
                    <td data-label="People">{num(b.total)}</td>
                    <td data-label="Progress"><div className="wmk-prog-cell"><Progress b={b} /><span className="was-hint">{num(b.sent)} sent{b.failed ? ` · ${num(b.failed)} not` : ''}</span></div></td>
                    <td data-label="Status"><span className={`status-badge ${STATUS[b.status]?.[0] || ''}`}>{STATUS[b.status]?.[1] || b.status}</span></td>
                    <td data-label="Made">{fmtWhen(b.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="was-card">
        <div className="was-card-head">
          <h3>{brand.name}’s marketing templates</h3>
          {data.canSend && !!missing.length && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={submit}>{busy ? 'Sending…' : `Submit ${missing.length} to Meta`}</button>}
        </div>
        <div className="wmk-templates">
          {data.ours.map(t => {
            const [look, word] = TPL_STATUS[t.status] || ['', t.status ? String(t.status).toLowerCase() : 'Not submitted']
            const ff = formFrom({ components: t.components })
            return (
              <div key={t.name} className="wmk-template">
                <div className="nl-pick-head"><b>{t.label}</b><span className={`status-badge ${look}`}>{word}</span>
                  {data.canSend && byName[t.name] && <button type="button" className="mini-btn" onClick={() => setEditing(byName[t.name])}><Icon name="edit" size={11} /> Edit</button>}</div>
                <TemplatePreview header={ff.header} body={ff.body} examples={t.gaps.map(g => g[1])} footer={ff.footer} buttons={ff.buttons} image={t.image || null} />
                <span className="was-hint">{t.name}</span>
              </div>
            )
          })}
        </div>
        {data.approved.filter(t => !data.ours.some(o => o.name === t.name)).length > 0 && (
          <p className="was-hint">Also approved for marketing: {data.approved.filter(t => !data.ours.some(o => o.name === t.name)).map(t => t.name).join(', ')}.</p>
        )}
      </section>

      {editing && <TemplateEditor template={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load() }} />}
      {making && <NewBroadcast data={data} onClose={() => setMaking(false)} onMade={(id) => { setMaking(false); load(); setOpen(id) }} />}
      {open && <BroadcastDrawer id={open} canSend={data.canSend} onClose={() => setOpen(null)} onChanged={load} />}
    </>
  )
}
