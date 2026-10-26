import { useState, useEffect } from 'react'
import { useApi } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import { SaveButton, Head, Toggle, Loading } from './waSettingsUi'
import { useWaBrand } from './waBrand'
import { NlTemplateLibrary, TemplatePreview, TemplateEditor } from './NlSettings'
import { STATUS_LOOK, formFrom } from './nlTemplates'
import WaMarketing from './WaMarketing'
import WaReopen from './WaReopen'

/**
 * Normless's templates, grouped by what sends them — abandoned carts, orders, COD confirmation,
 * shipping, refunds — the way the old provider's automation screen was, plus the full library.
 *
 * Each event is a card: switch it on, pick the approved template it sends, say what fills each
 * gap and where its button goes, and (for carts) how long to wait and which coupon to offer.
 * The CRM has its own template for every event, with our /go/ links; one tap submits it to Meta.
 */

const GROUPS = [
  { key: 'cart', label: 'Abandoned cart', icon: 'wallet', intro: 'Reminders for checkouts left on Razorpay. They stop the moment the customer orders, and only go out between 9 am and 9 pm.' },
  { key: 'order', label: 'Order', icon: 'box', intro: 'Sent when an order is placed or cancelled in Shopify.' },
  { key: 'cod', label: 'COD confirmation', icon: 'check', intro: 'Asks a cash-on-delivery customer to confirm before it ships. A Confirm is noted on the chat; a Cancel goes to the team to cancel in Shopify.' },
  { key: 'fulfillment', label: 'Shipping', icon: 'truck', intro: 'Sent when an order is fulfilled in Shopify with a tracking number.' },
  { key: 'payment', label: 'Payment & refund', icon: 'card', intro: 'Sent when a refund is made in Shopify.' },
  { key: 'reopen', label: 'Reopen chats', icon: 'refresh' },
  { key: 'marketing', label: 'Marketing', icon: 'spark' },
  { key: 'library', label: 'All templates', icon: 'mail' },
]

const UNITS = [['m', 'minutes', 1], ['h', 'hours', 60], ['d', 'days', 1440]]
const splitDelay = (min) => {
  const u = [...UNITS].reverse().find(([, , f]) => min % f === 0) || UNITS[0]
  return { n: min / u[2], unit: u[0] }
}
const fmtWhen = (v) => (v ? new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const keyOf = (t) => `${t.name}|${t.language}`

function useAutomations() {
  const apiFetch = useApi()
  const toast = useToast()
  const brand = useWaBrand()
  const [data, setData] = useState(null)
  const [templates, setTemplates] = useState([])
  const [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false)
  const load = () => Promise.all([apiFetch(`${brand.api}/nl/automations`), apiFetch(`${brand.api}/tpl/templates`)]).then(([a, t]) => {
    if (!a || a.error) return toast.error(a?.error || 'Could not read the automatic messages')
    // Whatever is being edited survives a reload; everything else takes what was saved.
    setDraft(d => d ? { ...a.config, ...Object.fromEntries(Object.entries(d).filter(([k, v]) => !same(v, data?.config?.[k]))) } : a.config)
    setData(a)
    setTemplates(t && !t.error ? t.templates : [])
  })
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const setEvent = (key, patch) => setDraft(d => ({ ...d, [key]: { ...d[key], ...patch } }))
  const dirtyKeys = (keys) => keys.filter(k => draft && data && !same(draft[k], data.config[k]))
  const save = async (keys) => {
    setSaving(true)
    const events = Object.fromEntries(dirtyKeys(keys).map(k => [k, draft[k]]))
    const r = await apiFetch(`${brand.api}/nl/automations`, { method: 'PUT', body: JSON.stringify({ events }) })
    setSaving(false)
    if (!r || r.error) return toast.error(r?.error || 'Could not save that')
    setData(d => ({ ...d, config: r.config, started_at: r.started_at }))
    setDraft(d => ({ ...d, ...Object.fromEntries(keys.map(k => [k, r.config[k]])) }))
    toast.success('Saved')
  }
  return { data, templates, draft, setEvent, dirtyKeys, save, saving, load }
}

/** The Razorpay address to paste into Magic Checkout, and how the carts are doing. */
function WebhookCard({ data }) {
  const toast = useToast()
  const [shown, setShown] = useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(data.webhook); toast.success('Copied') }
    catch { toast.error('Could not copy — select it and copy by hand') }
  }
  const c = data.carts || {}
  return (
    <section className="was-card">
      <div className="was-card-head"><h3>Abandoned-cart webhook for Razorpay</h3>
        <span className={`status-badge ${c.last_at ? 'success' : 'pending'}`}>{c.last_at ? `Last cart ${fmtWhen(c.last_at)}` : 'No carts received yet'}</span>
      </div>
      {data.webhook ? (
        <>
          <div className="was-inline nl-auto-hook">
            <input readOnly aria-label="Webhook address" value={shown ? data.webhook : data.webhook.replace(/(api_key=).*$/, '$1••••••••••••')} onFocus={e => e.target.select()} />
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShown(v => !v)}><Icon name="eye" size={13} /> {shown ? 'Hide' : 'Show'}</button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={copy}><Icon name="copy" size={13} /> Copy</button>
          </div>
          <p className="was-hint">In Razorpay: Magic Checkout › Platform Settings › switch on the abandoned cart webhook and paste this address. The end of it is a secret — don’t share it.</p>
        </>
      ) : <p className="was-hint">A WhatsApp manager can see the address to paste into Razorpay.</p>}
      <div className="was-facts">
        <div><span>Carts, last 30 days</span><b>{c.total ?? 0}</b></div>
        <div><span>Ordered after</span><b>{c.recovered ?? 0}</b></div>
        <div><span>Waiting</span><b>{c.waiting ?? 0}</b></div>
      </div>
    </section>
  )
}

/** The message in a line or two, with sample values in its gaps, so templates can be told apart. */
const gist = (t, samples = []) => String(t.body_text || '')
  .replace(/\{\{\s*(\d+)\s*\}\}/g, (m, n) => samples[Number(n) - 1] || '…')
  .replace(/[*_~]/g, '').replace(/\s+/g, ' ').trim()
const HOPPER = /prizmacommunicator/i
/** A template whose link button still goes through Updatrr's redirector: never offered. */
const viaUpdatrr = (t) => (t.components || []).some(c => (c.buttons || []).some(b => b.type === 'URL' && HOPPER.test(b.url || '')))

function TemplateOption({ t, on, tag, onPick, disabled, samples }) {
  return (
    <button type="button" className={`nl-pick${on ? ' on' : ''}`} disabled={disabled} onClick={onPick} aria-pressed={on}>
      <span className="nl-pick-head">
        <b>{t.name}</b>
        {tag && <span className="status-badge success">{tag}</span>}
        <span className={`status-badge ${STATUS_LOOK[t.status] || ''}`}>{t.status === 'APPROVED' ? 'Approved' : t.status === 'REJECTED' ? 'Rejected' : 'In review'}</span>
        {(t.components || []).some(c => c.type === 'HEADER' && c.format === 'IMAGE') && <span className="was-hint">· photo</span>}
      </span>
      <span className="nl-pick-body">{gist(t, samples)}</span>
    </button>
  )
}

/** One event: what it sends, whether it's on, what fills the gaps, and editing the template. */
function EventCard({ ev, cfg, data, templates, onChange, onEdit, canEdit }) {
  const [choosing, setChoosing] = useState(false)
  const picked = cfg.template && templates.find(t => keyOf(t) === cfg.template)
  const recKey = data.recommended?.[ev.key]
  const rec = recKey && templates.find(t => keyOf(t) === recKey)
  const hint = (name) => data.set.find(x => x.name === name) || data.suggest?.[name] || null
  const usable = templates.filter(t => t.ours && !viaUpdatrr(t))
  const suits = (t) => keyOf(t) === recKey || (data.suggest?.[t.name]?.events || []).includes(ev.key) || data.set.some(x => x.name === t.name && x.event === ev.key)
  const fitting = usable.filter(suits).sort((x, y) => (keyOf(y) === recKey) - (keyOf(x) === recKey) || (y.status === 'APPROVED') - (x.status === 'APPROVED'))
  const others = usable.filter(t => !suits(t))

  const f = picked ? formFrom(picked) : null
  const comps = picked?.components || []
  const hasImage = comps.some(c => c.type === 'HEADER' && c.format === 'IMAGE')
  const btns = comps.find(c => c.type === 'BUTTONS')?.buttons || []
  const urlButton = btns.find(b => b.type === 'URL' && /\{\{1\}\}/.test(b.url || ''))
  const needsCoupon = cfg.vars.includes('coupon') || btns.some(b => b.type === 'COPY_CODE')
  const gapCount = picked?.variables || 0
  const missing = Array.from({ length: gapCount }, (_, i) => i).filter(i => !cfg.vars[i])
  const examples = Array.from({ length: gapCount }, (_, i) => {
    const src = cfg.vars[i]
    return src === 'coupon' ? (cfg.coupon || data.sources.coupon.example) : data.sources[src]?.example || `{{${i + 1}}}`
  })
  const pick = (t) => {
    const h = hint(t.name)
    const link = h?.link && ev.links.includes(h.link) ? h.link : null
    onChange({ template: keyOf(t), vars: h ? [...h.vars] : Array.from({ length: t.variables || 0 }, () => null), ...(link ? { link } : {}) })
    setChoosing(false)
  }
  const ready = picked?.status === 'APPROVED' && !missing.length && (!needsCoupon || cfg.coupon)
  const why = !picked ? 'Choose a template first' : picked.status !== 'APPROVED' ? 'Waiting for Meta to approve it'
    : missing.length ? 'Say what fills every gap' : needsCoupon && !cfg.coupon ? 'Set the coupon code' : null
  const d = splitDelay(cfg.delay || ev.delay || 30)
  const setDelay = (n, unit) => onChange({ delay: Math.max(1, Number(n) || 1) * UNITS.find(u => u[0] === unit)[2] })
  const showPicker = canEdit && choosing
  const samplesFor = (t) => (hint(t.name)?.vars || []).map(v => data.sources[v]?.example)

  return (
    <section className={`was-card nl-auto-card${cfg.enabled ? ' on' : ''}`}>
      <div className="nl-auto-head">
        <div>
          <h3>{ev.label}</h3>
          <p className="was-hint">{ev.hint}</p>
        </div>
        <span className="nl-auto-switch">
          <span className={cfg.enabled ? 'nl-on' : 'was-hint'}>{cfg.enabled ? 'On' : why && !cfg.enabled ? why : 'Off'}</span>
          <Toggle on={cfg.enabled} label={`Send ${ev.label}`} disabled={!canEdit || (!cfg.enabled && !ready)} onChange={v => onChange({ enabled: v })} />
        </span>
      </div>
      <div className="nl-auto-body">
        <div className="nl-auto-form">
          <div className="nl-auto-sends">
            <span className="nl-auto-label">Sends</span>
            {picked ? (
              <div className="nl-auto-chosen">
                <b>{picked.name}</b>
                <span className={`status-badge ${STATUS_LOOK[picked.status] || ''}`}>{picked.status === 'APPROVED' ? 'Approved' : String(picked.status).toLowerCase()}</span>
                {canEdit && <button type="button" className="mini-btn" onClick={() => setChoosing(v => !v)}>{choosing ? 'Keep this one' : 'Change'}</button>}
                {canEdit && <button type="button" className="mini-btn" onClick={() => onEdit(picked)}><Icon name="edit" size={11} /> Edit</button>}
              </div>
            ) : rec && canEdit ? (
              <div className="nl-auto-chosen">
                <span className="was-hint">Nothing chosen. Recommended:</span> <b>{rec.name}</b>
                <button type="button" className="mini-btn mini-btn-active" onClick={() => pick(rec)}>Use it</button>
                <button type="button" className="mini-btn" onClick={() => setChoosing(v => !v)}>{choosing ? 'Close the list' : 'Choose another'}</button>
              </div>
            ) : canEdit ? (
              <div className="nl-auto-chosen"><span className="was-hint">Nothing chosen yet.</span>
                <button type="button" className="mini-btn mini-btn-active" onClick={() => setChoosing(true)}>Choose a template</button></div>
            ) : <span className="was-hint">Nothing chosen yet.</span>}
          </div>

          {showPicker && (
            <div className="nl-picker">
              <span className="was-hint">Templates for “{ev.label}”</span>
              {fitting.length ? fitting.map(t => (
                <TemplateOption key={keyOf(t)} t={t} samples={samplesFor(t)} on={keyOf(t) === cfg.template} tag={keyOf(t) === recKey ? 'Recommended' : null} onPick={() => pick(t)} />
              )) : <p className="was-hint">None written for this yet — pick from the rest below.</p>}
              {!!others.length && (
                <details className="nl-picker-more">
                  <summary>All other templates ({others.length})</summary>
                  {others.map(t => <TemplateOption key={keyOf(t)} t={t} samples={samplesFor(t)} on={keyOf(t) === cfg.template} onPick={() => pick(t)} />)}
                </details>
              )}
            </div>
          )}

          {picked && ev.group === 'cart' && (
            <div className="form-row">
              <div className="input-group">
                <label htmlFor={`after-${ev.key}`}>Send after</label>
                <div className="was-inline">
                  <input id={`after-${ev.key}`} type="number" min={1} value={d.n} disabled={!canEdit} onChange={e => setDelay(e.target.value, d.unit)} />
                  <select aria-label="Unit" value={d.unit} disabled={!canEdit} onChange={e => setDelay(d.n, e.target.value)}>
                    {UNITS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                  </select>
                </div>
              </div>
              {needsCoupon && (
                <div className="input-group">
                  <label htmlFor={`coupon-${ev.key}`}>Coupon code <span className="label-hint">goes in the message</span></label>
                  <input id={`coupon-${ev.key}`} value={cfg.coupon} maxLength={15} placeholder="COMEBACK10" disabled={!canEdit}
                    onChange={e => onChange({ coupon: e.target.value.toUpperCase().replace(/\s/g, '') })} />
                </div>
              )}
            </div>
          )}
          {picked && ev.group !== 'cart' && needsCoupon && (
            <div className="input-group">
              <label htmlFor={`coupon-${ev.key}`}>Coupon code</label>
              <input id={`coupon-${ev.key}`} value={cfg.coupon} maxLength={15} placeholder="COMEBACK10" disabled={!canEdit}
                onChange={e => onChange({ coupon: e.target.value.toUpperCase().replace(/\s/g, '') })} />
            </div>
          )}

          {urlButton && (
            <div className="input-group">
              <label htmlFor={`link-${ev.key}`}>“{urlButton.text}” button opens</label>
              <select id={`link-${ev.key}`} value={cfg.link} disabled={!canEdit} onChange={e => onChange({ link: e.target.value })}>
                {ev.links.map(k => <option key={k} value={k}>{data.links[k]}</option>)}
              </select>
            </div>
          )}

          {gapCount > 0 && (
            <details className="nl-auto-gaps" open={missing.length > 0}>
              <summary>What fills the message{missing.length ? <span className="was-bad"> — {missing.length} not set</span> : <span className="was-hint"> — all set</span>}</summary>
              {Array.from({ length: gapCount }, (_, i) => (
                <label key={i} className="nl-auto-gap">
                  <code>{`{{${i + 1}}}`}</code>
                  <select value={cfg.vars[i] || ''} disabled={!canEdit} onChange={e => { const v = [...cfg.vars]; v[i] = e.target.value || null; onChange({ vars: v }) }}>
                    <option value="">Choose…</option>
                    {Object.entries(data.sources).map(([k, x]) => <option key={k} value={k}>{x.label}</option>)}
                  </select>
                </label>
              ))}
            </details>
          )}
        </div>
        <div className="nl-auto-preview">
          {f ? <TemplatePreview header={f.header} headerExample={data.sources.first_name.example} body={f.body} examples={examples} footer={f.footer} buttons={f.buttons} image={hasImage || null} />
            : rec ? <><div className="was-hint">Recommended, as the customer would see it</div><TemplatePreview {...(() => { const r = formFrom(rec); return { header: r.header, body: r.body, footer: r.footer, buttons: r.buttons, examples: (hint(rec.name)?.vars || []).map(v => data.sources[v]?.example) } })()} image={(rec.components || []).some(c => c.type === 'HEADER' && c.format === 'IMAGE') || null} /></>
              : <p className="was-hint">Pick a template to preview it.</p>}
        </div>
      </div>
    </section>
  )
}

/** Updatrr's linked templates, submitted again with our links. */
function CopiesCard({ data, onDone }) {
  const apiFetch = useApi()
  const toast = useToast()
  const brand = useWaBrand()
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState(null)
  const todo = (data.copies || []).filter(c => !c.exists)
  const originals = (data.copies || []).reduce((n, c) => n + c.from.length, 0)
  // Once everything is with Meta there is nothing to do here, so the card goes.
  if (!data.copies?.length || (!todo.length && !results)) return null
  const submit = async () => {
    if (!await toast.confirm({ title: `Submit ${todo.length} templates to Meta?`, message: 'Each is one of Updatrr’s templates with the same wording and photo, its link changed to ops.normless.store. Updatrr’s own templates are not touched. Meta usually reviews them within minutes to hours.', confirmLabel: 'Submit' })) return
    setBusy(true)
    const r = await apiFetch(`${brand.api}/nl/automations/copy-updatrr`, { method: 'POST' })
    setBusy(false)
    if (!r || r.error) return toast.error(r?.error || 'Meta refused that', { duration: 0 })
    setResults(r.results)
    const failed = r.results.filter(x => x.status === 'FAILED').length
    if (failed) toast.error(`${failed} of ${r.results.length} were refused — see the list`, { duration: 0 })
    else toast.success(`${r.results.length} templates sent to Meta for review`)
    onDone()
  }
  return (
    <section className="was-card">
      <div className="was-card-head">
        <h3>Updatrr’s templates, with our links</h3>
        {todo.length
          ? data.canEdit && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={submit}>{busy ? 'Submitting…' : `Submit ${todo.length} to Meta`}</button>
          : <span className="status-badge success">All {data.copies.length} submitted</span>}
      </div>
      <p className="was-hint">
        {originals} of Updatrr’s templates send their button through Updatrr’s redirector. Each is copied as nl_… with the same words and photo, the button going through ops.normless.store instead
        {originals > data.copies.length ? ` — ${data.copies.length} templates, as some were exact duplicates` : ''}. Templates without links can be used as they are.
      </p>
      {results && (
        <ul className="nl-auto-results">
          {results.map(x => (
            <li key={x.name}><b>{x.name}</b> <span className={`status-badge ${x.status === 'FAILED' ? 'error' : 'pending'}`}>{x.status === 'FAILED' ? 'Refused' : 'In review'}</span>
              {x.error && <span className="was-hint"> {x.error}</span>}</li>
          ))}
        </ul>
      )}
    </section>
  )
}

const OUTCOME = {
  sent: ['success', 'Sent'], failed: ['error', 'Failed'], sending: ['pending', 'Sending'], skipped: ['', 'Opted out'],
}

function RecentSends({ rows, events }) {
  const label = Object.fromEntries(events.map(e => [e.key, e.label]))
  if (!rows.length) return <p className="was-hint">Nothing sent yet.</p>
  return (
    <div className="table-wrap">
      <table className="data-table nl-auto-log">
        <thead><tr><th>When</th><th>Message</th><th>For</th><th>Status</th></tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td>{fmtWhen(r.created_at)}</td>
              <td>{label[r.event] || r.event}</td>
              <td>{r.label || r.phone || '—'}</td>
              <td>
                <span className={`status-badge ${OUTCOME[r.status]?.[0] || ''}`}>{OUTCOME[r.status]?.[1] || r.status}</span>
                {r.reply && <span className={`status-badge ${r.reply === 'confirmed' ? 'success' : 'error'}`}>{r.reply === 'confirmed' ? 'Confirmed' : 'Asked to cancel'}</span>}
                {r.error && <div className="was-hint">{r.error}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function NlTemplatesTab() {
  const apiFetch = useApi()
  const toast = useToast()
  const brand = useWaBrand()
  const a = useAutomations()
  const [group, setGroup] = useState('cart')
  const [syncing, setSyncing] = useState(false)
  const [libKey, setLibKey] = useState(0)
  const [editing, setEditing] = useState(null)
  const sync = async () => {
    setSyncing(true)
    const r = await apiFetch(`${brand.api}/templates/sync`, { method: 'POST' })
    setSyncing(false)
    if (!r || r.error) return toast.error(r?.error || 'Could not read the templates from Meta')
    await a.load(); setLibKey(k => k + 1); toast.success(`${r.synced} templates synced, ${r.approved} approved`)
  }
  const g = GROUPS.find(x => x.key === group)
  const events = a.data ? a.data.events.filter(e => e.group === group) : []
  const keys = events.map(e => e.key)
  const on = (key) => a.data ? a.data.events.filter(e => e.group === key && a.data.config[e.key]?.enabled).length : 0
  return (
    <>
      <Head title="Templates" actions={
        <button type="button" className="btn btn-secondary btn-sm" disabled={syncing} onClick={sync}><Icon name="refresh" size={13} /> {syncing ? 'Syncing…' : 'Sync from Meta'}</button>
      }>
        What Normless sends on its own — cart reminders, order updates, COD confirmation, shipping and refunds — and every template Meta approved.
      </Head>
      <div className="scan-tabs nl-auto-tabs" role="tablist" aria-label="Template groups">
        {GROUPS.map(x => (
          <button key={x.key} type="button" role="tab" aria-selected={group === x.key} className={group === x.key ? 'active' : ''} onClick={() => setGroup(x.key)}>
            <Icon name={x.icon} size={13} /> {x.label}{!['library', 'marketing', 'reopen'].includes(x.key) && on(x.key) > 0 && <span className="tab-count">{on(x.key)} on</span>}
          </button>
        ))}
      </div>
      {group === 'reopen' ? <WaReopen /> : group === 'marketing' ? <WaMarketing /> : group === 'library' ? <NlTemplateLibrary embedded reloadKey={libKey} /> : !a.data || !a.draft ? <Loading /> : (
        <>
          <div className="nl-auto-bar">
            <p className="was-hint">{g.intro}{!a.data.started_at && ' Nothing has been sent yet: only orders and carts from the moment you switch one on are ever messaged.'}</p>
            {a.data.canEdit && <SaveButton dirty={a.dirtyKeys(keys).length > 0} saving={a.saving} onClick={() => a.save(keys)} />}
          </div>
          <CopiesCard data={a.data} onDone={async () => { await a.load(); setLibKey(k => k + 1) }} />
          {group === 'cart' && <WebhookCard data={a.data} />}
          {events.map(ev => (
            <EventCard key={ev.key} ev={ev} cfg={a.draft[ev.key]} data={a.data} templates={a.templates} canEdit={a.data.canEdit}
              onChange={(patch) => a.setEvent(ev.key, patch)} onEdit={setEditing} />
          ))}
          {editing && (
            <TemplateEditor template={editing} onClose={() => setEditing(null)}
              onSaved={async () => { setEditing(null); await a.load(); setLibKey(k => k + 1) }} />
          )}
          <section className="was-card">
            <div className="was-card-head"><h3>Recently sent</h3></div>
            <RecentSends rows={a.data.recent.filter(r => keys.includes(r.event))} events={a.data.events} />
          </section>
        </>
      )}
    </>
  )
}
