import { useState, useEffect, useMemo } from 'react'
import { Link, NavLink, useParams, Navigate } from 'react-router-dom'
import { useApi, useAuth, useMainMenu } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import useDirtyGuard from '../../hooks/useDirtyGuard'
import { WA_BRANDS, WaBrandContext, useWaBrand } from './waBrand'
import { SaveButton, Head, Toggle, Loading } from './waSettingsUi'
import { NlBotTab, NlKnowledgeTab, NlProductsTab, NlHandoffTab, NlMenuTab, NlRepliesTab, NlTeamTab, NlHoursTab } from './NlSettings'
import { NlTemplatesTab } from './NlAutomations'
import { WaCallsTab } from './WaCallsSettings'
import { WaImportTab } from './WaImport'
import WaMarketing from './WaMarketing'
import WaReopen from './WaReopen'
import { NlTemplateLibrary } from './NlSettings'

/**
 * WhatsApp settings.
 *
 * Six things the inbox runs on, each its own tab and its own save: the menu customers tap
 * through, the templates Meta approved, which products a rep can send, who is on the team, who a
 * new chat goes to, and the stages a lead moves through. All of it is stored in the database so
 * it changes without a deploy. Managers only — the route and every API call check it.
 */

const TABS = [
  { key: 'menu', label: 'Menu list', icon: 'note' },
  { key: 'templates', label: 'Templates', icon: 'mail' },
  { key: 'orders', label: 'Order messages', icon: 'card' },
  { key: 'catalogue', label: 'Catalogue', icon: 'box' },
  { key: 'team', label: 'Team members', icon: 'users' },
  { key: 'assignment', label: 'Assignment', icon: 'refresh' },
  { key: 'hours', label: 'Working hours', icon: 'clock' },
  { key: 'statuses', label: 'Lead statuses', icon: 'check' },
  { key: 'calls', label: 'Calls & new chats', icon: 'phone' },
  { key: 'import', label: 'Import chats', icon: 'download' },
  { key: 'connect', label: 'Connect WhatsApp', icon: 'whatsapp', adminOnly: true },
]
// Normless's settings, as the design lays them out: the bot first, then what it knows and does.
const NL_TABS = [
  { key: 'bot', label: 'Bot', icon: 'spark' },
  { key: 'knowledge', label: 'Knowledge & policies', icon: 'note' },
  { key: 'products', label: 'Products & size charts', icon: 'shirt' },
  { key: 'handoff', label: 'Handoff rules', icon: 'users' },
  { key: 'menu', label: 'Welcome menu', icon: 'note' },
  { key: 'replies', label: 'Saved replies', icon: 'copy' },
  { key: 'team', label: 'Team', icon: 'users' },
  { key: 'hours', label: 'Hours & away', icon: 'clock' },
  { key: 'templates', label: 'Templates', icon: 'mail' },
  { key: 'calls', label: 'Calls & new chats', icon: 'phone' },
  { key: 'import', label: 'Import chats', icon: 'download' },
  { key: 'connect', label: 'Connect WhatsApp', icon: 'whatsapp', adminOnly: true },
]

const short = (u) => (u ? u.split('@')[0] : '')


export default function WhatsAppSettings({ brand: brandKey = 'crewfit' }) {
  const brand = WA_BRANDS[brandKey]
  const tabs = brand.key === 'crewfit' ? TABS : NL_TABS
  const { tab = brand.defaultTab } = useParams()
  const { openMenu } = useMainMenu()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin' || user?.role === 'owner'
  if (!tabs.some(t => t.key === tab)) return <Navigate to={`${brand.path}/settings/${brand.defaultTab}`} replace />
  const Pane = brand.key !== 'crewfit' ? {
    bot: NlBotTab, knowledge: NlKnowledgeTab, products: NlProductsTab, handoff: NlHandoffTab, menu: NlMenuTab,
    replies: NlRepliesTab, team: NlTeamTab, hours: NlHoursTab, templates: NlTemplatesTab, calls: WaCallsTab, import: WaImportTab, connect: ConnectTab,
  }[tab] : { connect: ConnectTab, calls: WaCallsTab, import: WaImportTab, menu: MenuTab, templates: TemplatesTab, orders: OrderMessagesTab, hours: HoursTab, catalogue: CatalogueTab, team: TeamTab, assignment: AssignmentTab, statuses: StatusesTab }[tab]

  return (
    <WaBrandContext.Provider value={brand}>
    <div className="page">
      <header className="wa-topbar">
        <button type="button" className="btn-icon wa-menu-btn" aria-label="Open the main menu" title="Main menu" onClick={openMenu}>
          <Icon name="dashboard" size={18} />
        </button>
        <h1>{brand.key === 'crewfit' ? 'WhatsApp' : `${brand.name} WhatsApp`}</h1>
        <nav className="wa-seg" aria-label="WhatsApp">
          <NavLink to={brand.path} end className="wa-seg-item">Inbox</NavLink>
          {(isAdmin || user?.[brand.key === 'crewfit' ? 'can_view_wa_dashboard' : 'can_view_wa_nl_dashboard']) && <NavLink to={`${brand.path}/dashboard`} className="wa-seg-item">Dashboard</NavLink>}
          {brand.key === 'crewfit' && <NavLink to={`${brand.path}/me`} className="wa-seg-item">Performance</NavLink>}
          <NavLink to={`${brand.path}/settings`} className="wa-seg-item wa-seg-on">Settings</NavLink>
        </nav>
      </header>
      <div className="was-layout">
        <nav className="was-nav" aria-label="Settings">
          {tabs.filter(t => !t.adminOnly || isAdmin).map(t => (
            <NavLink key={t.key} to={`${brand.path}/settings/${t.key}`}
              className={({ isActive }) => `was-nav-item${isActive ? ' was-nav-on' : ''}`}>
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




/* ════════════════════════════════════════════════════════════════════════════════════════════
   Menu list
   ════════════════════════════════════════════════════════════════════════════════════════════ */

const STEP_KINDS = {
  buttons: 'Buttons (up to 3)',
  list: 'List (up to 10 rows)',
  text: 'Message, then carry on',
  ask_text: 'Ask a question',
  ask_media: 'Ask for a file',
  summary: 'Summary and price',
  send_catalogue: 'Send the catalogue PDF',
}
const CAP = { buttons: 3, buttonTitle: 20, rows: 10, rowTitle: 24, rowDesc: 72 }
const slugId = (t) => String(t || '').trim().replace(/\s+/g, ' ').slice(0, 60)

function MenuTab() {
  const apiFetch = useApi()
  const toast = useToast()
  const [flow, setFlow] = useState(null)
  const [def, setDef] = useState(null)
  const [selected, setSelected] = useState(null)
  const [keywords, setKeywords] = useState('')
  const [savedKeywords, setSavedKeywords] = useState('')
  const [ai, setAi] = useState(null)
  const [json, setJson] = useState(null)       // the advanced editor's text, when open
  const [saving, setSaving] = useState(false)

  const guard = useDirtyGuard({ snapshot: def, identity: flow?.key ?? null, confirm: toast.confirm })

  useEffect(() => {
    apiFetch('/api/whatsapp/flows').then(r => {
      if (!r || r.error) return toast.error(r?.error || 'Could not load the menu')
      const f = r.flows?.[0] || null
      setFlow(f)
      setDef(f?.definition || null)
      setSelected(f?.definition?.start || null)
    })
    apiFetch('/api/whatsapp/admin/menu').then(r => { if (r && !r.error) { setKeywords(r.keywords || ''); setSavedKeywords(r.keywords || '') } })
    apiFetch('/api/whatsapp/settings').then(r => r && !r.error && setAi(r))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!flow) return flow === null && def === null ? <Loading /> : null

  const steps = def?.steps || {}
  const ids = Object.keys(steps)
  const step = steps[selected]

  const setStep = (id, patch) => setDef(d => ({ ...d, steps: { ...d.steps, [id]: { ...d.steps[id], ...patch } } }))
  const setNext = (id, key, target) => setDef(d => {
    const next = { ...(d.steps[id].next || {}) }
    if (target) next[key] = target; else delete next[key]
    return { ...d, steps: { ...d.steps, [id]: { ...d.steps[id], next } } }
  })

  const options = (s) => (s?.type === 'buttons' ? s.buttons || [] : s?.type === 'list' ? (s.sections?.[0]?.rows || []) : [])
  const setOptions = (id, list) => {
    const s = steps[id]
    if (s.type === 'buttons') setStep(id, { buttons: list })
    else setStep(id, { sections: [{ ...(s.sections?.[0] || { title: 'Options' }), rows: list }, ...(s.sections || []).slice(1)] })
  }
  const editOption = (id, i, patch) => {
    const list = options(steps[id]).map((o, j) => (j === i ? { ...o, ...patch } : o))
    // A renamed option keeps whatever step it led to.
    if ('id' in patch) {
      const old = options(steps[id])[i].id
      const target = steps[id].next?.[old]
      if (target) { setNext(id, old, null); setNext(id, patch.id, target) }
    }
    setOptions(id, list)
  }
  const addOption = (id) => {
    const s = steps[id]
    const list = options(s)
    const max = s.type === 'buttons' ? CAP.buttons : CAP.rows
    if (list.length >= max) return toast.error(`WhatsApp allows ${max} here`)
    setOptions(id, [...list, { id: `option_${list.length + 1}`, title: 'New option' }])
  }
  const removeOption = (id, i) => {
    const old = options(steps[id])[i].id
    setNext(id, old, null)
    setOptions(id, options(steps[id]).filter((_, j) => j !== i))
  }

  const addStep = () => {
    let n = ids.length + 1
    while (steps[`step_${n}`]) n += 1
    const id = `step_${n}`
    setDef(d => ({ ...d, steps: { ...d.steps, [id]: { type: 'buttons', text: 'What would you like to do?', buttons: [{ id: 'yes', title: 'Yes' }], next: {} } } }))
    setSelected(id)
  }
  const removeStep = async (id) => {
    if (id === def.start) return toast.error('This is the first step — pick another one to start on first')
    if (!await toast.confirm({ title: `Remove “${id}”?`, message: 'Anything that leads to it will stop there and hand over to a person.', danger: true })) return
    setDef(d => {
      const rest = Object.fromEntries(Object.entries(d.steps).filter(([k]) => k !== id).map(([k, s]) => [k, {
        ...s, next: Object.fromEntries(Object.entries(s.next || {}).filter(([, t]) => t !== id)),
      }]))
      return { ...d, steps: rest }
    })
    setSelected(def.start)
  }

  const save = async (definition = def) => {
    setSaving(true)
    const r = await apiFetch(`/api/whatsapp/flows/${flow.key}`, { method: 'PUT', body: JSON.stringify({ definition }) })
    setSaving(false)
    if (!r || r.error) return toast.error(r?.error || 'Could not save the menu')
    setFlow(r.flow)
    setDef(r.flow.definition)
    guard.reset(r.flow.definition)
    toast.success('Menu saved')
    return true
  }

  const setActive = async (on) => {
    const r = await apiFetch(`/api/whatsapp/flows/${flow.key}`, { method: 'PUT', body: JSON.stringify({ is_active: on }) })
    if (!r || r.error) return toast.error(r?.error || 'Could not change that')
    setFlow(f => ({ ...f, is_active: r.flow.is_active }))
    toast.success(on ? 'The menu will answer new enquiries' : 'The menu is off — everything comes to a person')
  }

  const setAssistant = async (on) => {
    const r = await apiFetch('/api/whatsapp/settings', { method: 'PUT', body: JSON.stringify({ ai_enabled: on }) })
    if (!r || r.error) return toast.error(r?.error || 'Could not change that')
    setAi(s => ({ ...s, aiEnabled: on }))
  }

  const saveKeywords = async () => {
    const r = await apiFetch('/api/whatsapp/admin/menu', { method: 'PUT', body: JSON.stringify({ keywords }) })
    if (!r || r.error) return toast.error(r?.error || 'Could not save that')
    setKeywords(r.keywords)
    setSavedKeywords(r.keywords)
  }

  const saveJson = async () => {
    let parsed
    try { parsed = JSON.parse(json) } catch (err) { return toast.error('That is not valid JSON — ' + err.message) }
    if (await save(parsed)) { setJson(null); setSelected(parsed.start) }
  }

  const nextSelect = (id, key, label) => (
    <select aria-label={label} value={steps[id].next?.[key] || ''} onChange={e => setNext(id, key, e.target.value)}>
      {/* An option with no step of its own follows the step's catch-all, when there is one. */}
      <option value="">{key !== '*' && steps[id].next?.['*'] ? `Default: ${steps[id].next['*']}` : 'Hand to a person'}</option>
      {ids.filter(x => x !== id).map(x => <option key={x} value={x}>Go to {x}</option>)}
    </select>
  )

  return (
    <>
      <Head title="Menu list"
        actions={<>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setJson(JSON.stringify(def, null, 2))}>Edit as JSON</button>
          <SaveButton dirty={guard.dirty} saving={saving} onClick={() => save()} label="Save menu" idle="Menu saved" />
        </>}>
        The questions customers tap through before a person picks the chat up. Each option can lead to
        another step; one that leads nowhere hands the chat to the team.
      </Head>

      <section className="was-card">
        <h3>When it is sent</h3>
        <div className="was-switch-row">
          <Toggle on={flow.is_active} onChange={setActive} label="Send the menu on a customer's first message" />
          <div><b>On a customer’s first message</b><span>{flow.is_active ? 'On — every new chat starts with this menu' : 'Off — every new chat goes straight to a person'}</span></div>
        </div>
        <div className="was-switch-row">
          <Icon name="refresh" size={16} />
          <div style={{ flex: 1 }}>
            <label htmlFor="wa-keywords"><b>When a customer types one of these words</b></label>
            <span>Comma separated. Only while no menu or assistant is already answering.</span>
            <div className="was-inline">
              <input id="wa-keywords" value={keywords} onChange={e => setKeywords(e.target.value)} placeholder="menu" />
              <SaveButton dirty={keywords.trim() !== savedKeywords} onClick={saveKeywords} label="Save words" />
            </div>
          </div>
        </div>
        {ai?.aiAvailable && (
          <div className="was-switch-row">
            <Toggle on={ai.aiEnabled} onChange={setAssistant} label="Assistant answers what the menu cannot" />
            <div><b>Assistant answers what the menu cannot</b><span>{ai.aiEnabled ? 'On — hands over to a person when it is unsure' : 'Off — anything the menu cannot answer waits for a person'}</span></div>
          </div>
        )}
      </section>

      <div className="was-menu-grid">
        <section className="was-card was-steps">
          <div className="was-card-head">
            <h3>Steps</h3>
            <label className="was-inline-label">Starts on
              <select value={def.start} onChange={e => setDef(d => ({ ...d, start: e.target.value }))}>
                {ids.map(x => <option key={x} value={x}>{x}</option>)}
              </select>
            </label>
          </div>
          <ul className="was-step-list">
            {ids.map(id => (
              <li key={id}>
                <button type="button" className={`was-step${id === selected ? ' was-step-on' : ''}`} onClick={() => setSelected(id)}>
                  <b>{id}</b>
                  <span>{STEP_KINDS[steps[id].type] || steps[id].type}{id === def.start ? ' · first' : ''}</span>
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="btn btn-secondary btn-sm" onClick={addStep}><Icon name="plus" size={14} /> Add step</button>
        </section>

        {step && (
          <section className="was-card was-step-edit">
            <div className="was-card-head">
              <h3>{selected}</h3>
              <button type="button" className="mini-btn mini-btn-danger" onClick={() => removeStep(selected)}>Remove step</button>
            </div>
            <div className="form-row">
              <div className="input-group">
                <label htmlFor="wa-step-type">Kind</label>
                <select id="wa-step-type" value={step.type} onChange={e => {
                  const type = e.target.value
                  const patch = { type }
                  if (type === 'buttons' && !step.buttons) patch.buttons = options(step).slice(0, 3)
                  if (type === 'list' && !step.sections) patch.sections = [{ title: 'Options', rows: options(step) }]
                  // A PDF step has no question or options; it carries a caption and moves on.
                  if (type === 'send_catalogue') Object.assign(patch, { text: 'Here is our full catalogue 📘', buttons: undefined, sections: undefined, save_as: undefined })
                  setStep(selected, patch)
                }}>
                  {Object.entries(STEP_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              {['buttons', 'list', 'ask_text', 'ask_media'].includes(step.type) && (
                <div className="input-group">
                  <label htmlFor="wa-step-save">Save the answer as</label>
                  <select id="wa-step-save" value={step.save_as || ''} onChange={e => setStep(selected, { save_as: e.target.value || undefined })}>
                    <option value="">Don’t save it</option>
                    <option value="product_interest">Product</option>
                    <option value="quantity">Quantity</option>
                    <option value="branding">Branding</option>
                    <option value="logo">Logo</option>
                  </select>
                </div>
              )}
            </div>
            {step.type === 'send_catalogue' ? (
              <div className="input-group">
                <label htmlFor="wa-step-text">Caption on the PDF</label>
                <input id="wa-step-text" value={step.text || ''} maxLength={1024} placeholder="Here is our full catalogue 📘"
                  onChange={e => setStep(selected, { text: e.target.value })} />
                <span className="was-hint">Sends the current catalogue from the Catalog page, then carries on.</span>
              </div>
            ) : step.type !== 'summary' ? (
              <div className="input-group">
                <label htmlFor="wa-step-text">Message</label>
                <textarea id="wa-step-text" rows={4} value={step.text || ''} maxLength={1024}
                  onChange={e => setStep(selected, { text: e.target.value })} />
              </div>
            ) : (
              <p className="wa-flow-hint">Sends what the customer chose and a price range from the catalog tiers, then hands the chat to a person.</p>
            )}

            {step.type === 'list' && (
              <div className="form-row">
                <div className="input-group">
                  <label htmlFor="wa-step-btn">Button that opens the list</label>
                  <input id="wa-step-btn" value={step.button || ''} maxLength={CAP.buttonTitle}
                    onChange={e => setStep(selected, { button: e.target.value })} />
                </div>
                <div className="input-group">
                  <label htmlFor="wa-step-section">Section title</label>
                  <input id="wa-step-section" value={step.sections?.[0]?.title || ''} maxLength={24}
                    onChange={e => setStep(selected, { sections: [{ ...(step.sections?.[0] || {}), title: e.target.value, rows: options(step) }] })} />
                </div>
              </div>
            )}

            {(step.type === 'buttons' || step.type === 'list') && (
              <div className="was-options">
                <div className="was-options-head">
                  <span>Options · {options(step).length} of {step.type === 'buttons' ? CAP.buttons : CAP.rows}</span>
                  <button type="button" className="mini-btn" onClick={() => addOption(selected)}>Add option</button>
                </div>
                {options(step).map((o, i) => (
                  <div key={i} className={`was-option${step.type === 'list' ? ' was-option-list' : ''}`}>
                    <input aria-label="Title" value={o.title} placeholder="Title"
                      maxLength={step.type === 'buttons' ? CAP.buttonTitle : CAP.rowTitle}
                      onChange={e => editOption(selected, i, { title: e.target.value })}
                      onBlur={() => { if (!o.id || /^option_\d+$/.test(o.id)) editOption(selected, i, { id: slugId(o.title) }) }} />
                    {step.type === 'list' && (
                      <input aria-label="Description" value={o.description || ''} placeholder="Description (optional)" maxLength={CAP.rowDesc}
                        onChange={e => editOption(selected, i, { description: e.target.value })} />
                    )}
                    {nextSelect(selected, o.id, `After “${o.title}”`)}
                    <button type="button" className="btn-icon" aria-label={`Remove ${o.title}`} onClick={() => removeOption(selected, i)}>
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                ))}
                <div className="was-option was-option-any">
                  <span>Anything else they tap</span>
                  {nextSelect(selected, '*', 'Anything else')}
                </div>
              </div>
            )}
            {['text', 'ask_text', 'ask_media', 'send_catalogue'].includes(step.type) && (
              <div className="input-group">
                <label>Then</label>
                {nextSelect(selected, '*', 'Then')}
              </div>
            )}
          </section>
        )}

        {step && <PhonePreview step={step} />}
      </div>

      {json != null && (
        <div className="drawer-overlay" onClick={() => setJson(null)}>
          <aside className="drawer drawer-wide" role="dialog" aria-label="Edit the menu as JSON" onClick={e => e.stopPropagation()}>
            <div className="drawer-header">
              <h3>Edit the menu as JSON</h3>
              <button type="button" className="btn-icon" aria-label="Close" onClick={() => setJson(null)}><Icon name="close" size={16} /></button>
            </div>
            <div className="drawer-body">
              <p className="wa-flow-hint">Everything the editor shows, as it is stored. WhatsApp’s limits are checked when you save.</p>
              <textarea className="wa-flow-json" value={json} onChange={e => setJson(e.target.value)} spellCheck={false} />
            </div>
            <div className="drawer-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setJson(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={saveJson}>Save the menu</button>
            </div>
          </aside>
        </div>
      )}
    </>
  )
}

/** The step as the customer's phone shows it. */
function PhonePreview({ step }) {
  const rows = step.type === 'list' ? (step.sections || []).flatMap(s => s.rows || []) : []
  return (
    <figure className="was-phone">
      <figcaption>Preview</figcaption>
      <div className="was-phone-screen">
        <div className="was-phone-msg">
          {step.type === 'send_catalogue' && <div className="was-phone-doc"><span>PDF</span> Crewfit catalogue.pdf</div>}
          <div className="was-phone-text">{step.type === 'summary' ? 'Thank you — here is what we have: …' : step.text || (step.type === 'send_catalogue' ? 'Here is our latest Crewfit catalogue 📘' : '')}</div>
          {step.type === 'buttons' && (step.buttons || []).map((b, i) => <div key={i} className="was-phone-btn">{b.title}</div>)}
          {step.type === 'list' && <div className="was-phone-btn">{step.button || 'Choose'}</div>}
        </div>
        {step.type === 'list' && (
          <div className="was-phone-sheet">
            <div className="was-phone-sheet-title">{step.button || 'Choose'}</div>
            {(step.sections || []).map((sec, i) => (
              <div key={i}>
                <div className="was-phone-section">{sec.title}</div>
                {(sec.rows || []).map((r, j) => (
                  <div key={j} className="was-phone-row">
                    <div><div>{r.title}</div>{r.description && <small>{r.description}</small>}</div>
                    <span className="was-phone-radio" />
                  </div>
                ))}
              </div>
            ))}
            {!rows.length && <div className="was-phone-row"><small>No rows yet</small></div>}
          </div>
        )}
      </div>
    </figure>
  )
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
   Templates
   ════════════════════════════════════════════════════════════════════════════════════════════ */

const VAR_SOURCES = [
  ['', 'Typed in by the rep'],
  ['first_name', 'Customer first name'],
  ['name', 'Customer full name'],
  ['company', 'Company or team'],
  ['product', 'Product'],
  ['quantity', 'Quantity'],
  ['quoted_amount', 'Quoted amount'],
  ['balance_due', 'Balance due'],
  ['needed_by', 'Needed by date'],
  ['agent_name', 'Rep’s name'],
  ['order_ref', 'Order number (CF-…)'],
  ['order_total', 'Order total'],
  ['advance_amount', 'Advance amount'],
  ['balance_amount', 'Balance amount'],
  ['payment_link', 'Payment link'],
  ['tracking_id', 'Tracking ID'],
  ['tracking_url', 'Tracking link'],
]

/**
 * Crewfit's Templates, laid out like Normless's: Reopen chats (what to send after 24 quiet hours or
 * to message someone first), Marketing (promotional templates and broadcasts) and All templates
 * (search, preview, write, edit, delete). Order messages fill their gaps from what is set here.
 */
function TemplatesTab() {
  const apiFetch = useApi()
  const toast = useToast()
  const [view, setView] = useState('reopen')
  const [syncing, setSyncing] = useState(false)
  const [libKey, setLibKey] = useState(0)
  const sync = async () => {
    setSyncing(true)
    const r = await apiFetch('/api/whatsapp/templates/sync', { method: 'POST' })
    setSyncing(false)
    if (!r || r.error) return toast.error(r?.error || 'Could not read the templates from Meta')
    toast.success(`${r.approved} approved template${r.approved === 1 ? '' : 's'} from Meta`)
    setLibKey(k => k + 1)
  }
  const saveMap = async (t, map, reload) => {
    const r = await apiFetch(`/api/whatsapp/admin/templates/${t.id}`, { method: 'PUT', body: JSON.stringify({ var_map: map }) })
    if (!r || r.error) return toast.error(r?.error || 'Could not save that')
    reload()
  }
  // Under each template in All templates: what fills its gaps when an order message sends it.
  const gapsFor = (t, reload) => (t.variables > 0 ? (
    <div className="nl-auto-gaps">
      <span className="wnc-label">When order messages send it, each gap is filled from</span>
      {Array.from({ length: t.variables }, (_, i) => (
        <label key={i} className="nl-auto-gap">
          <code>{`{{${i + 1}}}`}</code>
          <select value={t.var_map?.[i] || ''} onChange={e => { const m = Array.from({ length: t.variables }, (_, k) => t.var_map?.[k] || ''); m[i] = e.target.value; saveMap(t, m, reload) }}>
            {VAR_SOURCES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      ))}
    </div>
  ) : null)
  const TABS = [['reopen', 'Reopen chats', 'refresh'], ['marketing', 'Marketing', 'spark'], ['library', 'All templates', 'mail']]
  return (
    <>
      <Head title="Templates" actions={
        <button type="button" className="btn btn-secondary btn-sm" disabled={syncing} onClick={sync}><Icon name="refresh" size={13} /> {syncing ? 'Syncing…' : 'Sync from Meta'}</button>
      }>
        Crewfit’s approved WhatsApp messages: to reopen a chat, for marketing, and every other template.
      </Head>
      <div className="scan-tabs nl-auto-tabs" role="tablist" aria-label="Templates">
        {TABS.map(([k, label, icon]) => (
          <button key={k} type="button" role="tab" aria-selected={view === k} className={view === k ? 'active' : ''} onClick={() => setView(k)}>
            <Icon name={icon} size={13} /> {label}
          </button>
        ))}
      </div>
      {view === 'reopen' ? <WaReopen key={libKey} /> : view === 'marketing' ? <WaMarketing key={libKey} />
        : <NlTemplateLibrary embedded reloadKey={libKey} extraDetail={gapsFor} />}
    </>
  )
}

function OrderMessagesTab() {
  const apiFetch = useApi()
  const toast = useToast()
  const { API_URL } = useAuth()
  const [data, setData] = useState(null)
  const [pay, setPay] = useState(null)              // { qr, billingRequest, billingDefault }
  const [request, setRequest] = useState('')
  const [savingRequest, setSavingRequest] = useState(false)
  const [uploadingQr, setUploadingQr] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [results, setResults] = useState(null)

  const loadMessages = () => apiFetch('/api/whatsapp/admin/order-messages').then(r => (r && !r.error ? setData(r) : toast.error(r?.error || 'Could not load the order messages')))
  useEffect(() => {
    loadMessages()
    apiFetch('/api/whatsapp/admin/payments').then(r => { if (r && !r.error) { setPay(r); setRequest(r.billingRequest) } })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const uploadQr = async (file) => {
    if (!file) return
    setUploadingQr(true)
    const fd = new FormData()
    fd.append('qr', file)
    const r = await apiFetch('/api/whatsapp/admin/payments/qr', { method: 'POST', body: fd })
    setUploadingQr(false)
    if (!r || r.error) return toast.error(r?.error || 'Could not upload the QR')
    setPay(p => ({ ...p, qr: r.qr }))
  }

  const saveRequest = async () => {
    setSavingRequest(true)
    const r = await apiFetch('/api/whatsapp/admin/payments/billing-request', { method: 'PUT', body: JSON.stringify({ text: request }) })
    setSavingRequest(false)
    if (!r || r.error) return toast.error(r?.error || 'Could not save that')
    setPay(p => ({ ...p, billingRequest: r.billingRequest }))
  }

  const submitTemplates = async () => {
    if (!await toast.confirm({
      title: 'Send the Crewfit templates to Meta?',
      message: 'Ten utility templates — order confirmation, payment links, proforma, invoice, dispatch and the rest — go to Meta for review, and each order message is linked to its own. Meta usually decides within a day. Ones already on the account are only linked.',
      confirmLabel: 'Submit for approval',
    })) return
    setSubmitting(true)
    const r = await apiFetch('/api/whatsapp/admin/order-messages/templates', { method: 'POST' })
    setSubmitting(false)
    if (!r || r.error) return toast.error(r?.error || 'Could not submit the templates')
    setResults(r.results)
    loadMessages()
  }

  const save = async (m, patch) => {
    setData(d => ({ ...d, messages: d.messages.map(x => (x.key === m.key ? { ...x, ...patch } : x)) }))
    const r = await apiFetch(`/api/whatsapp/admin/order-messages/${m.key}`, { method: 'PUT', body: JSON.stringify(patch) })
    if (!r || r.error) {
      setData(d => ({ ...d, messages: d.messages.map(x => (x.key === m.key ? m : x)) }))
      return toast.error(r?.error || 'Could not save that')
    }
    if ('auto' in patch) toast.success(patch.auto ? `“${m.label}” will go out on its own` : `“${m.label}” is back to being sent by hand`)
  }

  if (!data) return <Loading />
  const linked = data.messages.filter(m => m.template_id).length
  return (
    <>
      <Head title="Order messages" actions={
        <button type="button" className="btn btn-primary btn-sm" disabled={submitting} onClick={submitTemplates}>
          {submitting ? 'Submitting to Meta…' : linked === data.messages.length ? 'Re-check templates with Meta' : 'Submit Crewfit templates to Meta'}
        </button>}>
        The messages a Crewfit order sends: the summary, payment links, proforma, invoice, photos and tracking.
        They go from the chat’s Orders tab, and four of them can go out on their own when the order reaches that step.
        Past WhatsApp’s 24-hour window only an approved template can be sent, so pick one for each message you want to keep working then.
      </Head>
      <section className="was-table-card">
        <div className="data-table-wrapper">
          <table className="data-table was-table">
            <thead>
              <tr><th>Message</th><th>Sends on its own</th><th>After 24 hours, send template</th></tr>
            </thead>
            <tbody>
              {data.messages.map(m => (
                <tr key={m.key}>
                  <td><b>{m.label}</b></td>
                  <td>
                    {m.trigger ? (
                      <label className="was-inline-label" style={{ fontWeight: 500 }}>
                        <Toggle on={m.auto} onChange={v => save(m, { auto: v })} label={`Send ${m.label} automatically`} />
                        {m.trigger}
                      </label>
                    ) : <span className="was-hint">Sent by hand</span>}
                  </td>
                  <td>
                    <select aria-label={`Template for ${m.label}`} value={m.template_id || ''} style={{ maxWidth: 260 }}
                      onChange={e => save(m, { template_id: e.target.value ? Number(e.target.value) : null })}>
                      <option value="">None — refuse outside the window</option>
                      {data.templates.map(t => <option key={t.id} value={t.id}>{t.name}{t.status !== 'APPROVED' ? ` — ${String(t.status).toLowerCase()} at Meta` : ''}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {results && (
        <section className="was-card">
          <h3>What Meta was sent</h3>
          <ul className="was-results">
            {results.map(r => (
              <li key={r.kind}>
                <span className="was-mono">{r.name}</span>
                <span className={r.result === 'failed' ? 'was-bad' : ''}>{r.result === 'failed' ? `failed — ${r.error}` : r.result}</span>
              </li>
            ))}
          </ul>
          <p className="was-hint" style={{ margin: 0 }}>Once Meta decides, press Sync on the Templates tab and the approved ones start working.</p>
        </section>
      )}

      <div className="was-split was-split-2">
        <section className="was-card" style={{ flex: '1 1 300px', maxWidth: 380 }}>
          <h3>Payment QR</h3>
          <p className="was-hint" style={{ margin: 0 }}>Sent from a chat’s Payment button or an order’s “Payment QR”, with a request for the payment screenshot.</p>
          <div className="was-qr">
            {pay?.qr ? <img src={`${API_URL}${pay.qr}`} alt="The payment QR customers are sent" /> : <span>No QR uploaded yet</span>}
          </div>
          <label className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start', cursor: 'pointer' }}>
            {uploadingQr ? 'Uploading…' : pay?.qr ? 'Replace QR' : 'Upload QR'}
            <input type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={e => { uploadQr(e.target.files?.[0]); e.target.value = '' }} />
          </label>
        </section>
        <section className="was-card" style={{ flex: '999 1 420px' }}>
          <div className="was-card-head">
            <h3>Billing details request</h3>
            <SaveButton dirty={!!pay && request !== pay.billingRequest} saving={savingRequest} onClick={saveRequest} />
          </div>
          <p className="was-hint" style={{ margin: 0 }}>
            Sent by “Ask customer” in a chat’s lead panel. The reply is read into the billing fields, anything missing is asked for
            one at a time, and Create order picks the details up.
          </p>
          <textarea rows={14} value={request} onChange={e => setRequest(e.target.value)} aria-label="Billing details request" />
          {pay && request !== pay.billingDefault && (
            <button type="button" className="mini-btn" style={{ alignSelf: 'flex-start' }} onClick={() => setRequest(pay.billingDefault)}>Put back the original wording</button>
          )}
        </section>
      </div>

      <p className="was-hint">
        A message sent on its own appears in the chat marked “sent automatically”. If it cannot go — no number, no total, no template —
        the reason is written to that chat’s Activity tab.
      </p>
    </>
  )
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
   Connect WhatsApp (Coexistence)
   ════════════════════════════════════════════════════════════════════════════════════════════ */

/** Meta's JavaScript SDK, loaded once, the first time somebody connects. */
let fbReady = null
function loadFacebookSdk(appId, version) {
  if (!fbReady) {
    fbReady = new Promise((resolve, reject) => {
      window.fbAsyncInit = () => {
        window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version })
        resolve(window.FB)
      }
      const s = document.createElement('script')
      s.src = 'https://connect.facebook.net/en_US/sdk.js'
      s.async = true; s.defer = true; s.crossOrigin = 'anonymous'
      s.onerror = () => { fbReady = null; reject(new Error('Could not load Meta’s login script — check the connection, or an ad blocker')) }
      document.body.appendChild(s)
    })
  }
  return fbReady
}

const fmtWhen = (v) => (v ? new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—')

function ConnectTab() {
  const apiFetch = useApi()
  const brand = useWaBrand()
  const toast = useToast()
  const { user } = useAuth()
  const [data, setData] = useState(null)
  const [coexist, setCoexist] = useState(true)
  const [step, setStep] = useState(null)       // what the connect is doing right now
  const isAdmin = user?.role === 'admin' || user?.role === 'owner'

  const load = () => apiFetch(`${brand.api}/connect`).then(r => (r && !r.error ? setData(r) : toast.error(r?.error || 'Could not read the connection')))
  // The signed-in user arrives a moment after the page: ask once they are known to be an admin.
  useEffect(() => {
    if (isAdmin) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin])
  // While the history comes in, keep the counts moving.
  useEffect(() => {
    if (!['requested', 'importing'].includes(data?.history?.status)) return
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.history?.status])

  if (!user) return <Loading />
  if (!isAdmin) return <p className="was-hint">Only an admin can connect WhatsApp.</p>
  if (!data) return <Loading />

  const conn = data.connection?.status === 'connected' ? data.connection : null
  const missing = [!data.appId && 'WA_APP_ID', !data.configId && 'WA_EMBEDDED_CONFIG_ID'].filter(Boolean)

  /**
   * Open Meta's popup. Two things come back separately and in either order: a message event with
   * the account and number the customer picked, and the login callback with a one-time code.
   * Both are needed, and the code dies in 30 seconds, so they are joined and sent at once.
   */
  const connect = async () => {
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
      return toast.error('Meta only opens this popup on an https:// address — use the live CRM')
    }
    setStep('Opening Meta…')
    let FB
    try { FB = await loadFacebookSdk(data.appId, data.graphVersion) }
    catch (err) { setStep(null); return toast.error(err.message) }

    let session = null
    let code = null
    let finished = false
    const finish = async () => {
      if (finished || !code) return
      // The session event normally arrives first; give it a moment if the code beat it.
      for (let i = 0; i < 20 && !session; i++) await new Promise(r => setTimeout(r, 250))
      finished = true
      window.removeEventListener('message', onMessage)
      if (!session?.waba_id) { setStep(null); return toast.error('Meta did not say which account was chosen — try again and finish every step in the popup') }
      setStep('Connecting the number…')
      const r = await apiFetch(`${brand.api}/connect`, { method: 'POST', body: JSON.stringify({ code, ...session }) })
      setStep(null)
      if (!r || r.error) return toast.error(r?.error || 'Could not finish connecting', { duration: 0 })
      setData(r)
      toast.success(r.connection?.coexistence ? 'Connected — the phone app keeps working, and history is on its way' : 'Connected')
    }
    const onMessage = (event) => {
      if (!String(event.origin).endsWith('facebook.com')) return
      let msg
      try { msg = JSON.parse(event.data) } catch { return }
      if (msg?.type !== 'WA_EMBEDDED_SIGNUP') return
      if (String(msg.event).startsWith('FINISH')) {
        session = { event: msg.event, waba_id: msg.data?.waba_id, phone_number_id: msg.data?.phone_number_id, business_id: msg.data?.business_id }
        finish()
      } else if (msg.event === 'CANCEL') {
        finished = true
        window.removeEventListener('message', onMessage)
        setStep(null)
        toast.error(msg.data?.error_message ? `Meta stopped: ${msg.data.error_message}` : `Stopped at “${msg.data?.current_step || 'the first step'}” — nothing was connected`)
      }
    }
    window.addEventListener('message', onMessage)
    setStep('Waiting for you to finish in Meta’s window…')
    FB.login((response) => {
      code = response?.authResponse?.code || null
      if (!code) {
        if (!finished) { finished = true; window.removeEventListener('message', onMessage); setStep(null) }
        return
      }
      finish()
    }, {
      config_id: data.configId,
      response_type: 'code',
      override_default_response_type: true,
      // Coexistence: connect the number already on the WhatsApp Business app instead of a new one.
      extras: coexist ? { setup: {}, featureType: 'whatsapp_business_app_onboarding' } : { setup: {} },
    })
  }

  const sync = async (type) => {
    const r = await apiFetch(`${brand.api}/connect/sync/${type}`, { method: 'POST' })
    if (!r || r.error) return toast.error(r?.error || 'Meta refused the sync request', { duration: 0 })
    setData(r)
    toast.success('Asked Meta again')
  }

  const disconnect = async () => {
    if (!await toast.confirm({
      title: 'Stop using this connection?',
      message: 'The CRM stops sending and receiving through this number. The WhatsApp Business app on the phone is not affected. To remove the CRM from the number entirely, do it in the phone app under Linked devices / Business platform.',
      confirmLabel: 'Disconnect', danger: true,
    })) return
    const r = await apiFetch(`${brand.api}/connect/disconnect`, { method: 'POST' })
    if (!r || r.error) return toast.error(r?.error || 'Could not disconnect')
    setData(r)
  }

  const h = data.history || {}
  const c = data.contacts || {}
  const within24 = conn && Date.now() - new Date(conn.connected_at).getTime() < 24 * 3600 * 1000
  const HISTORY_LOOK = {
    requested: ['Asked Meta — waiting for the first chats', 'pending'],
    importing: [`Importing — ${h.progress ?? 0}%`, 'pending'],
    done: ['Imported', 'success'],
    declined: ['The business chose not to share history', 'error'],
    failed: ['The request failed', 'error'],
  }

  return (
    <>
      <Head title={`Connect ${brand.name}'s WhatsApp`}>
        Link the number {brand.name} already uses on the WhatsApp Business app — pick {brand.name}'s number in Meta's window, not the other brand's. The phone keeps working exactly as before;
        every chat, in and out — including replies typed on the phone — also appears here, and the last 180 days of chats are imported once.
      </Head>

      {missing.length > 0 && (
        <section className="was-card was-warn-card">
          <h3>Set up on the server first</h3>
          <p className="was-hint" style={{ margin: 0 }}>Add {missing.join(' and ')} to the server’s .env and restart it. The values come from the Meta app (see the steps on this page’s help).</p>
        </section>
      )}

      <section className="was-card">
        <div className="was-card-head">
          <h3>{conn ? 'Connected number' : 'Not connected from the CRM'}</h3>
          {conn && <span className={`status-badge ${conn.coexistence ? 'success' : ''}`}>{conn.coexistence ? 'Phone app + CRM' : 'CRM only'}</span>}
        </div>
        {conn ? (
          <div className="was-facts">
            <div><span>Number</span><b>{conn.display_phone_number || conn.phone_number_id}</b></div>
            <div><span>Business name</span><b>{conn.verified_name || '—'}</b></div>
            <div><span>Platform</span><b>{conn.platform_type || '—'}{conn.coexistence ? ' · still on the phone app' : ''}</b></div>
            <div><span>WhatsApp account ID</span><b className="was-mono">{conn.waba_id}</b></div>
            <div><span>Phone number ID</span><b className="was-mono">{conn.phone_number_id}</b></div>
            <div><span>Connected</span><b>{fmtWhen(conn.connected_at)} by {String(conn.connected_by || '').split('@')[0]}</b></div>
          </div>
        ) : (
          <p className="was-hint" style={{ margin: 0 }}>
            {data.usingEnv ? 'The CRM is using the number set in the server’s .env. Connecting here replaces it.' : 'Nothing is connected yet.'}
            {data.connection?.status === 'disconnected' && ` Last disconnected ${fmtWhen(data.connection.disconnected_at || data.connection.last_account_event_at)}${data.connection.disconnect_reason ? ` (${data.connection.disconnect_reason})` : ''}.`}
          </p>
        )}
        <label className="page-check" style={{ margin: 0 }}>
          <input type="checkbox" checked={coexist} onChange={e => setCoexist(e.target.checked)} />
          The number is already on the WhatsApp Business app — keep it there (Coexistence)
        </label>
        <div className="was-inline">
          <button type="button" className="btn btn-primary" disabled={!!step || missing.length > 0} onClick={connect}>
            <Icon name="whatsapp" size={15} /> {step || (conn ? 'Connect again' : 'Connect WhatsApp')}
          </button>
          {conn && <button type="button" className="btn btn-secondary" onClick={disconnect}>Disconnect</button>}
        </div>
      </section>

      {conn?.coexistence && (
        <section className="was-card">
          <h3>Bringing the phone’s chats across</h3>
          <p className="was-hint" style={{ margin: 0 }}>
            Meta sends these once, and only if asked within 24 hours of connecting. They arrive in pieces over a few minutes.
          </p>
          <div className="was-sync">
            <div>
              <b>Chat history (180 days)</b>
              <span className={`status-badge ${HISTORY_LOOK[h.status]?.[1] || ''}`}>{HISTORY_LOOK[h.status]?.[0] || 'Not asked yet'}</span>
              {(h.status === 'importing' || h.status === 'done') && (
                <>
                  <div className="wa-paid-bar" style={{ marginTop: 8 }}><div style={{ width: `${Math.min(100, h.progress || 0)}%` }} /></div>
                  <small>{h.threads || 0} chats, {h.messages || 0} messages{h.status === 'done' ? '' : ' so far'}</small>
                </>
              )}
              {h.error && <small className="was-bad">{h.error}</small>}
              {within24 && ['failed', undefined].includes(h.status) && <button type="button" className="mini-btn" onClick={() => sync('history')}>Ask Meta for the history</button>}
            </div>
            <div>
              <b>Contacts</b>
              <span className={`status-badge ${c.status === 'done' ? 'success' : c.status === 'failed' ? 'error' : 'pending'}`}>
                {c.status === 'done' ? `${c.contacts || 0} name${c.contacts === 1 ? '' : 's'} updated` : c.status === 'failed' ? 'The request failed' : c.status ? 'Asked Meta' : 'Not asked yet'}
              </span>
              {c.error && <small className="was-bad">{c.error}</small>}
              {within24 && ['failed', undefined].includes(c.status) && <button type="button" className="mini-btn" onClick={() => sync('contacts')}>Ask Meta for the contacts</button>}
            </div>
          </div>
        </section>
      )}
    </>
  )
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
   Working hours
   ════════════════════════════════════════════════════════════════════════════════════════════ */

const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']]
const clock12 = (hhmm) => {
  const [h, m] = String(hhmm || '0:0').split(':').map(Number)
  return `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'am' : 'pm'}`
}
const dayRange = (days) => {
  const order = DAYS.map(([d]) => d).filter(d => days.includes(d))
  if (!order.length) return 'no days'
  const idx = order.map(d => DAYS.findIndex(([x]) => x === d))
  const run = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1)
  const name = (d) => DAYS.find(([x]) => x === d)[1]
  return run && order.length > 2 ? `${name(order[0])}–${name(order[order.length - 1])}` : order.map(name).join(', ')
}

function HoursTab() {
  const apiFetch = useApi()
  const toast = useToast()
  const [hours, setHours] = useState(null)
  const [open, setOpen] = useState(null)
  const [saving, setSaving] = useState(false)
  const guard = useDirtyGuard({ snapshot: hours, identity: hours ? 'hours' : null, confirm: toast.confirm })

  useEffect(() => {
    apiFetch('/api/whatsapp/admin/work-hours').then(r => {
      if (!r || r.error) return toast.error(r?.error || 'Could not load the working hours')
      setHours(r.hours); setOpen(r.open)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!hours) return <Loading />
  const set = (patch) => setHours(h => ({ ...h, ...patch }))
  const preview = String(hours.message || '')
    .replace(/\{days\}/g, dayRange(hours.days))
    .replace(/\{hours\}/g, `${clock12(hours.start)} – ${clock12(hours.end)}`)

  const save = async () => {
    setSaving(true)
    const r = await apiFetch('/api/whatsapp/admin/work-hours', { method: 'PUT', body: JSON.stringify(hours) })
    setSaving(false)
    if (!r || r.error) return toast.error(r?.error || 'Could not save the working hours')
    setHours(r.hours); setOpen(r.open)
    guard.reset(r.hours)
  }

  return (
    <>
      <Head title="Working hours" actions={<SaveButton dirty={guard.dirty} saving={saving} onClick={save} />}>
        When the team answers. Outside these hours, a customer who asks for a person — taps “Talk to sales”,
        finishes the menu, or just writes in — is told when somebody will be back. Once every 12 hours at most, not on every message.
      </Head>

      <section className="was-card">
        <div className="was-switch-row">
          <Toggle on={hours.enabled} onChange={v => set({ enabled: v })} label="Send the closed message outside working hours" />
          <div>
            <b>Send the closed message outside these hours</b>
            <span>{hours.enabled
              ? (open ? 'On — the team is in right now, so nothing is being sent' : 'On — the team is out right now, so customers are getting the message')
              : 'Off — customers get no reply until somebody answers'}</span>
          </div>
        </div>
      </section>

      <section className="was-card">
        <div className="was-switch-row">
          <Toggle on={hours.menuAfterHours !== false} onChange={v => set({ menuAfterHours: v })} label="Answer new chats with the menu outside working hours" />
          <div>
            <b>Answer new chats with the menu outside working hours</b>
            <span>{hours.menuAfterHours !== false
              ? 'On — even when the menu is switched off for the day, a chat that arrives after hours gets it, and it ends by saying when the team is back'
              : 'Off — after hours, new chats get only the closed message'}</span>
          </div>
        </div>
      </section>

      <div className="was-split was-split-2">
        <section className="was-card" style={{ flex: '999 1 420px' }}>
          <h3>Days and times</h3>
          <div className="chip-picker" role="group" aria-label="Working days">
            {DAYS.map(([d, label]) => {
              const on = hours.days.includes(d)
              return (
                <button key={d} type="button" aria-pressed={on} className={`chip${on ? ' chip-on' : ''}`}
                  onClick={() => set({ days: on ? hours.days.filter(x => x !== d) : [...hours.days, d] })}>{label}</button>
              )
            })}
          </div>
          <div className="form-row">
            <div className="input-group">
              <label htmlFor="wh-start">Opens at</label>
              <input id="wh-start" type="time" value={hours.start} onChange={e => set({ start: e.target.value })} />
            </div>
            <div className="input-group">
              <label htmlFor="wh-end">Closes at</label>
              <input id="wh-end" type="time" value={hours.end} onChange={e => set({ end: e.target.value })} />
            </div>
          </div>
          <p className="was-hint" style={{ margin: 0 }}>
            Open {dayRange(hours.days)}, {clock12(hours.start)} – {clock12(hours.end)}, India time.
          </p>
          <div className="input-group">
            <label htmlFor="wh-msg">Message outside these hours</label>
            <textarea id="wh-msg" rows={4} maxLength={1000} value={hours.message} onChange={e => set({ message: e.target.value })} />
            <span className="was-hint">{'{days}'} and {'{hours}'} are filled in from the times above.</span>
          </div>
        </section>
        <figure className="was-phone" style={{ maxWidth: 320 }}>
          <figcaption>What the customer reads</figcaption>
          <div className="was-phone-screen" style={{ minHeight: 0 }}>
            <div className="was-phone-msg" style={{ alignSelf: 'flex-end', background: '#005c4b', borderRadius: '12px 4px 12px 12px' }}>
              <div className="was-phone-text">Hi, I need 50 polo shirts</div>
            </div>
            <div className="was-phone-msg"><div className="was-phone-text">{preview}</div></div>
          </div>
        </figure>
      </div>
    </>
  )
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
   Catalogue
   ════════════════════════════════════════════════════════════════════════════════════════════ */

function CatalogueTab() {
  const apiFetch = useApi()
  const toast = useToast()
  const { API_URL } = useAuth()
  const [products, setProducts] = useState(null)
  const [pdf, setPdf] = useState(null)
  const [cat, setCat] = useState('')
  const [uploading, setUploading] = useState(null)

  useEffect(() => {
    apiFetch('/api/whatsapp/admin/catalogue').then(r => {
      if (!r || r.error) return toast.error(r?.error || 'Could not load the catalogue')
      setProducts(r.products)
      setPdf(r.catalogue)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const flip = async (p, on) => {
    setProducts(list => list.map(x => (x.id === p.id ? { ...x, wa_visible: on } : x)))
    const r = await apiFetch(`/api/whatsapp/admin/catalogue/${p.id}`, { method: 'PATCH', body: JSON.stringify({ wa_visible: on }) })
    if (!r || r.error) {
      setProducts(list => list.map(x => (x.id === p.id ? { ...x, wa_visible: !on } : x)))
      toast.error(r?.error || 'Could not change that')
    }
  }

  const upload = async (p, file) => {
    if (!file) return
    setUploading(p.id)
    const fd = new FormData()
    fd.append('photo', file)
    const r = await apiFetch(`/api/whatsapp/admin/catalogue/${p.id}/photo`, { method: 'POST', body: fd })
    setUploading(null)
    if (!r || r.error) return toast.error(r?.error || 'Could not upload that photo')
    setProducts(list => list.map(x => (x.id === p.id ? { ...x, image_url: r.image_url } : x)))
  }
  const removePhoto = async (p) => {
    const r = await apiFetch(`/api/whatsapp/admin/catalogue/${p.id}/photo`, { method: 'DELETE' })
    if (!r || r.error) return toast.error(r?.error || 'Could not remove that photo')
    setProducts(list => list.map(x => (x.id === p.id ? { ...x, image_url: null } : x)))
  }

  if (!products) return <Loading />
  const cats = [...new Set(products.map(p => p.category).filter(Boolean))]
  const withPhoto = products.filter(p => p.image_url).length
  const shown = products.filter(p => !cat || p.category === cat)
  const on = products.filter(p => p.wa_visible && p.active).length

  return (
    <>
      <Head title="Catalogue"
        actions={<Link to="/crewfit/catalog" className="btn btn-secondary btn-sm">Edit products in Catalog</Link>}>
        What a rep can send from a chat: each product with its photo and price tiers, or the whole catalogue as a PDF.
        {' '}{on} of {products.length} are switched on, {withPhoto} have a photo. Names, prices and tiers are edited on the Catalog page.
      </Head>
      <section className="was-card was-pdf-card">
        <span className="wa-pop-pdf-icon" aria-hidden="true">PDF</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <b>{pdf ? pdf.filename : 'No catalogue PDF yet'}</b>
          <span className="was-hint" style={{ display: 'block' }}>
            {pdf ? `Version ${pdf.version}. Reps send it from the Catalogue button in a chat, and the menu can send it as a step.` : 'Upload it on the Catalog page and it can be sent from any chat.'}
          </span>
        </div>
        <Link to="/crewfit/catalog" className="btn btn-secondary btn-sm">{pdf ? 'Replace PDF' : 'Upload PDF'}</Link>
      </section>
      {cats.length > 1 && (
        <div className="chip-picker" role="group" aria-label="Category">
          <button type="button" className={`chip${!cat ? ' chip-on' : ''}`} onClick={() => setCat('')}>All</button>
          {cats.map(c => <button key={c} type="button" className={`chip${cat === c ? ' chip-on' : ''}`} onClick={() => setCat(c)}>{c}</button>)}
        </div>
      )}
      <div className="was-products">
        {shown.map(p => {
          const tiers = (p.tiers || []).filter(([l]) => l)
          return (
            <article key={p.id} className={`was-product${p.wa_visible && p.active ? '' : ' was-product-off'}`}>
              <div className="was-product-photo">
                {p.image_url ? <img src={`${API_URL}${p.image_url}`} alt={p.name} loading="lazy" /> : <span><Icon name="shirt" size={22} /> No photo yet</span>}
                <div className="was-product-photo-actions">
                  <label className="mini-btn">
                    {uploading === p.id ? 'Uploading…' : p.image_url ? 'Change photo' : 'Add photo'}
                    <input type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={e => { upload(p, e.target.files?.[0]); e.target.value = '' }} />
                  </label>
                  {p.image_url && <button type="button" className="mini-btn" onClick={() => removePhoto(p)}>Remove</button>}
                </div>
              </div>
              <div className="was-product-top">
                <div>
                  <h3>{p.name}</h3>
                  <span>{[p.category, p.material, p.gsm ? `${p.gsm} GSM` : null].filter(Boolean).join(' · ')}</span>
                </div>
                {!p.active && <span className="status-badge error">inactive</span>}
              </div>
              {tiers.length ? (
                <ul className="was-tiers">
                  {tiers.slice(0, 4).map(([l, price]) => (
                    <li key={l}><span>{l}</span><b>{typeof price === 'number' ? `₹${price}` : 'on request'}</b></li>
                  ))}
                </ul>
              ) : p.from_price ? <p className="was-hint">From ₹{Number(p.from_price)}</p> : <p className="was-hint">No prices set</p>}
              <label className="was-product-foot">
                <Toggle on={p.wa_visible} onChange={v => flip(p, v)} label={`Send ${p.name} from WhatsApp`} disabled={!p.active} />
                <span>{p.wa_visible && p.active ? 'Reps can send it' : p.active ? 'Hidden from chats' : 'Inactive in the catalog'}</span>
              </label>
            </article>
          )
        })}
      </div>
    </>
  )
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
   Team members
   ════════════════════════════════════════════════════════════════════════════════════════════ */

const blankMember = () => ({ create: false, username: '', password: '', is_manager: false, is_sales_agent: true, wa_max_open: '', team_ids: [] })

function TeamTab() {
  const apiFetch = useApi()
  const toast = useToast()
  const [data, setData] = useState(null)
  const [form, setForm] = useState(null)       // add or edit a member
  const [teamName, setTeamName] = useState('')
  const [saving, setSaving] = useState(false)

  const guard = useDirtyGuard({ snapshot: form, identity: form ? (form.id ?? 'new') : null, onDiscard: () => setForm(null), confirm: toast.confirm })

  useEffect(() => {
    apiFetch('/api/whatsapp/admin/team').then(r => (r && !r.error ? setData(r) : toast.error(r?.error || 'Could not load the team')))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const apply = (r, ok) => {
    if (!r || r.error) { toast.error(r?.error || 'Could not save that'); return false }
    setData(d => ({ ...d, ...r }))
    if (ok) toast.success(ok)
    return true
  }

  const patch = async (m, body) => apply(await apiFetch(`/api/whatsapp/admin/team/members/${m.id}`, { method: 'PATCH', body: JSON.stringify(body) }))

  const saveForm = async () => {
    setSaving(true)
    let r
    if (form.id) {
      const body = { is_sales_agent: form.is_sales_agent, wa_max_open: form.wa_max_open, team_ids: form.team_ids }
      if (data.canGrant && !form.locked) body.is_manager = form.is_manager
      r = await apiFetch(`/api/whatsapp/admin/team/members/${form.id}`, { method: 'PATCH', body: JSON.stringify(body) })
    } else {
      r = await apiFetch('/api/whatsapp/admin/team/members', { method: 'POST', body: JSON.stringify(form) })
    }
    setSaving(false)
    if (apply(r, form.id ? 'Saved' : `${short(form.username)} can now use the inbox`)) { guard.reset(); setForm(null) }
  }

  const remove = async (m) => {
    if (!await toast.confirm({ title: `Remove ${short(m.username)} from WhatsApp?`, message: `Their ${m.open_chats} open chat${m.open_chats === 1 ? '' : 's'} go back to Unassigned. Their CRM login stays.`, danger: true })) return
    apply(await apiFetch(`/api/whatsapp/admin/team/members/${m.id}`, { method: 'DELETE' }), 'Removed')
  }

  const addTeam = async () => {
    if (!teamName.trim()) return
    if (apply(await apiFetch('/api/whatsapp/admin/teams', { method: 'POST', body: JSON.stringify({ name: teamName }) }))) setTeamName('')
  }
  const renameTeam = async (t) => {
    const name = window.prompt('Team name', t.name)
    if (name && name.trim() && name !== t.name) apply(await apiFetch(`/api/whatsapp/admin/teams/${t.id}`, { method: 'PATCH', body: JSON.stringify({ name }) }))
  }
  const deleteTeam = async (t) => {
    if (!await toast.confirm({ title: `Remove the ${t.name} team?`, message: 'Rules that send chats to it are removed too. Nobody loses access.', danger: true })) return
    apply(await apiFetch(`/api/whatsapp/admin/teams/${t.id}`, { method: 'DELETE' }))
  }

  if (!data) return <Loading />
  const teamName_ = Object.fromEntries(data.teams.map(t => [t.id, t.name]))
  const locked = (m) => m.role === 'owner' || m.role === 'admin'

  return (
    <>
      <Head title="Team members"
        actions={data.canGrant && <button type="button" className="btn btn-primary btn-sm" onClick={() => setForm(blankMember())}><Icon name="plus" size={14} /> Add member</button>}>
        Who answers chats, which teams they sit in, and whether new chats are handed to them.
        {!data.canGrant && ' Only an admin can add or remove people.'}
      </Head>

      <section className="was-table-card">
        <div className="data-table-wrapper">
          <table className="data-table was-table">
            <thead>
              <tr><th>Member</th><th>Role</th><th>Teams</th><th>Open chats</th><th>Gets new chats</th><th><span className="was-sr">Actions</span></th></tr>
            </thead>
            <tbody>
              {data.members.map(m => (
                <tr key={m.id}>
                  <td>
                    <div className="was-member">
                      <span className="wa-avatar" aria-hidden="true">{short(m.username).slice(0, 2).toUpperCase()}</span>
                      <div><b>{short(m.username)}</b><span>{m.username}</span></div>
                    </div>
                  </td>
                  <td>{locked(m) ? m.role[0].toUpperCase() + m.role.slice(1) : m.is_manager ? 'Manager' : 'Agent'}</td>
                  <td>
                    <div className="was-chips">
                      {m.team_ids.map(id => <span key={id} className="was-chip">{teamName_[id]}</span>)}
                      {!m.team_ids.length && <span className="was-hint">None</span>}
                    </div>
                  </td>
                  <td>{m.open_chats}{m.wa_max_open ? <span className="was-hint"> / {m.wa_max_open}</span> : null}</td>
                  <td><Toggle on={m.is_sales_agent} onChange={v => patch(m, { is_sales_agent: v })} label={`${short(m.username)} gets new chats`} /></td>
                  <td>
                    <div className="was-row-actions">
                      <button type="button" className="btn-icon" aria-label={`Edit ${short(m.username)}`}
                        onClick={() => setForm({ id: m.id, username: m.username, locked: locked(m), is_manager: m.is_manager, is_sales_agent: m.is_sales_agent, wa_max_open: m.wa_max_open ?? '', team_ids: m.team_ids })}>
                        <Icon name="edit" size={14} />
                      </button>
                      {data.canGrant && !locked(m) && (
                        <button type="button" className="btn-icon" aria-label={`Remove ${short(m.username)}`} onClick={() => remove(m)}>
                          <Icon name="trash" size={14} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="was-card">
        <h3>Teams</h3>
        <p className="was-hint">Assignment rules send chats to a team; the person is picked from inside it.</p>
        <div className="was-teams">
          {data.teams.map(t => (
            <div key={t.id} className="was-team">
              <div className="was-team-head">
                <b>{t.name}</b>
                <span className="was-row-actions">
                  <button type="button" className="btn-icon" aria-label={`Rename ${t.name}`} onClick={() => renameTeam(t)}><Icon name="edit" size={13} /></button>
                  <button type="button" className="btn-icon" aria-label={`Remove ${t.name}`} onClick={() => deleteTeam(t)}><Icon name="trash" size={13} /></button>
                </span>
              </div>
              <span>{t.members.length ? t.members.map(short).join(', ') : 'Nobody yet'}</span>
            </div>
          ))}
        </div>
        <div className="was-inline">
          <input aria-label="New team name" placeholder="New team, e.g. Design" value={teamName}
            onChange={e => setTeamName(e.target.value)} onKeyDown={e => e.key === 'Enter' && addTeam()} />
          <button type="button" className="btn btn-secondary btn-sm" disabled={!teamName.trim()} onClick={addTeam}>Add team</button>
        </div>
      </section>

      {form && (
        <div className="drawer-overlay" onClick={guard.requestClose}>
          <aside className="drawer" role="dialog" aria-label={form.id ? 'Edit member' : 'Add team member'} onClick={e => e.stopPropagation()}>
            <div className="drawer-header">
              <h3>{form.id ? short(form.username) : 'Add team member'}</h3>
              <button type="button" className="btn-icon" aria-label="Close" onClick={guard.requestClose}><Icon name="close" size={16} /></button>
            </div>
            <div className="drawer-body">
              {!form.id && (
                <>
                  <div className="chip-picker" role="radiogroup" aria-label="Who">
                    <button type="button" role="radio" aria-checked={!form.create} className={`chip${!form.create ? ' chip-on' : ''}`}
                      onClick={() => setForm(f => ({ ...f, create: false, username: '' }))}>Someone with a CRM login</button>
                    <button type="button" role="radio" aria-checked={form.create} className={`chip${form.create ? ' chip-on' : ''}`}
                      onClick={() => setForm(f => ({ ...f, create: true, username: '' }))}>A new login</button>
                  </div>
                  {form.create ? (
                    <div className="form-row">
                      <div className="input-group">
                        <label htmlFor="wm-email">Email</label>
                        <input id="wm-email" type="email" value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value.trim() }))} />
                      </div>
                      <div className="input-group">
                        <label htmlFor="wm-pass">Password</label>
                        <input id="wm-pass" type="password" autoComplete="new-password" value={form.password}
                          onChange={e => setForm(f => ({ ...f, password: e.target.value }))} />
                      </div>
                    </div>
                  ) : (
                    <div className="input-group">
                      <label htmlFor="wm-user">CRM login</label>
                      <select id="wm-user" value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))}>
                        <option value="">Choose…</option>
                        {data.others.map(u => <option key={u} value={u}>{u}</option>)}
                      </select>
                      {!data.others.length && <span className="was-hint">Everyone with a login already has the inbox.</span>}
                    </div>
                  )}
                </>
              )}
              {form.create && <p className="was-hint" style={{ margin: 0 }}>The new login can open the WhatsApp inbox and nothing else. Give it more on the Admin page.</p>}

              <div className="input-group">
                <label htmlFor="wm-role">Role</label>
                <select id="wm-role" value={form.is_manager ? 'manager' : 'agent'} disabled={form.locked || !data.canGrant}
                  onChange={e => setForm(f => ({ ...f, is_manager: e.target.value === 'manager' }))}>
                  <option value="agent">Agent: answers their own chats and unassigned ones</option>
                  <option value="manager">Manager: sees every chat, reassigns, changes settings</option>
                </select>
                {form.locked && <span className="was-hint">Admins and owners always manage the inbox.</span>}
              </div>
              <fieldset className="was-fieldset">
                <legend>Teams</legend>
                {!data.teams.length && <span className="was-hint">No teams yet. Add them below the member list.</span>}
                {data.teams.map(t => (
                  <label key={t.id} className="page-check">
                    <input type="checkbox" checked={form.team_ids.includes(t.id)}
                      onChange={e => setForm(f => ({ ...f, team_ids: e.target.checked ? [...f.team_ids, t.id] : f.team_ids.filter(x => x !== t.id) }))} />
                    {t.name}
                  </label>
                ))}
              </fieldset>
              <label className="page-check">
                <input type="checkbox" checked={form.is_sales_agent} onChange={e => setForm(f => ({ ...f, is_sales_agent: e.target.checked }))} />
                Gets new chats automatically
              </label>
              <div className="input-group">
                <label htmlFor="wm-cap">Most open chats at once</label>
                <input id="wm-cap" inputMode="numeric" placeholder="No limit" value={form.wa_max_open}
                  onChange={e => setForm(f => ({ ...f, wa_max_open: e.target.value.replace(/\D/g, '') }))} />
                <span className="was-hint">At the limit, new chats skip them.</span>
              </div>
            </div>
            <div className="drawer-footer">
              <button type="button" className="btn btn-secondary" onClick={guard.requestClose}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={saving || !form.username || (form.create && form.password.length < 8)} onClick={saveForm}>
                {saving ? 'Saving…' : form.id ? 'Save' : 'Add member'}
              </button>
            </div>
          </aside>
        </div>
      )}
    </>
  )
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
   Assignment
   ════════════════════════════════════════════════════════════════════════════════════════════ */

const MODES = [
  ['least_busy', 'Least busy', 'Goes to whoever has the fewest open chats right now.'],
  ['round_robin', 'Round robin', 'Takes turns, so everyone gets the same number of new chats.'],
  ['manual', 'Nobody, we assign', 'Chats wait in Unassigned until someone takes them.'],
]
const FIELDS = [['source', 'Came from'], ['menu_option', 'Menu option'], ['lead_status', 'Lead status']]

function AssignmentTab() {
  const apiFetch = useApi()
  const toast = useToast()
  const [data, setData] = useState(null)
  const [teams, setTeams] = useState([])
  const [statuses, setStatuses] = useState([])
  const [menuOptions, setMenuOptions] = useState([])
  const [saving, setSaving] = useState(false)

  const guard = useDirtyGuard({ snapshot: data, identity: data ? 'assignment' : null, confirm: toast.confirm })

  useEffect(() => {
    apiFetch('/api/whatsapp/admin/assignment').then(r => r && !r.error ? setData(r) : toast.error(r?.error || 'Could not load the rules'))
    apiFetch('/api/whatsapp/admin/team').then(r => r && !r.error && setTeams(r.teams))
    apiFetch('/api/whatsapp/statuses').then(r => r && !r.error && setStatuses(r.statuses))
    apiFetch('/api/whatsapp/flows').then(r => {
      const steps = r?.flows?.[0]?.definition?.steps || {}
      const opts = Object.values(steps).flatMap(s => (s.type === 'buttons' ? s.buttons || [] : s.type === 'list' ? (s.sections || []).flatMap(x => x.rows || []) : []))
      setMenuOptions([...new Map(opts.map(o => [o.id, o])).values()])
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!data) return <Loading />

  const setRule = (i, patch) => setData(d => ({ ...d, rules: d.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) }))
  const move = (i, by) => setData(d => {
    const rules = [...d.rules]
    const j = i + by
    if (j < 0 || j >= rules.length) return d
    ;[rules[i], rules[j]] = [rules[j], rules[i]]
    return { ...d, rules }
  })

  const save = async () => {
    setSaving(true)
    const r = await apiFetch('/api/whatsapp/admin/assignment', { method: 'PUT', body: JSON.stringify(data) })
    setSaving(false)
    if (!r || r.error) return toast.error(r?.error || 'Could not save the rules')
    setData(r)
    guard.reset(r)
    toast.success('Saved')
  }

  const valueField = (r, i) => {
    if (r.field === 'source') {
      return (
        <select aria-label="Value" value={r.value} onChange={e => setRule(i, { value: e.target.value })}>
          <option value="">Choose…</option><option value="ad">A Click-to-WhatsApp ad</option><option value="direct">Messaged us directly</option>
        </select>
      )
    }
    if (r.field === 'lead_status') {
      return (
        <select aria-label="Value" value={r.value} onChange={e => setRule(i, { value: e.target.value })}>
          <option value="">Choose…</option>{statuses.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
        </select>
      )
    }
    return (
      <select aria-label="Value" value={r.value} onChange={e => setRule(i, { value: e.target.value })}>
        <option value="">Choose…</option>
        {menuOptions.map(o => <option key={o.id} value={o.id}>{o.title}</option>)}
        {r.value && !menuOptions.some(o => o.id === r.value) && <option value={r.value}>{r.value}</option>}
      </select>
    )
  }

  return (
    <>
      <Head title="Assignment"
        actions={<SaveButton dirty={guard.dirty} saving={saving} onClick={save} />}>
        Who a new chat goes to. Only people ticked as getting new chats on the Team page are picked.
      </Head>

      <section className="was-card">
        <h3>Pick the person by</h3>
        <div className="was-modes" role="radiogroup" aria-label="How to pick">
          {MODES.map(([k, title, desc]) => (
            <button key={k} type="button" role="radio" aria-checked={data.mode === k}
              className={`was-mode${data.mode === k ? ' was-mode-on' : ''}`} onClick={() => setData(d => ({ ...d, mode: k }))}>
              <b>{title}</b><span>{desc}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="was-card">
        <div className="was-card-head">
          <h3>Routing rules</h3>
          <button type="button" className="mini-btn" disabled={!teams.length}
            onClick={() => setData(d => ({ ...d, rules: [...d.rules, { field: 'source', value: '', team_id: teams[0]?.id, is_active: true }] }))}>
            Add rule
          </button>
        </div>
        <p className="was-hint">Checked top to bottom; the first match wins. A matching chat moves to that team even mid-conversation, unless its person is already in the team.</p>
        {!teams.length && <p className="was-hint">Make a team on the Team members tab first.</p>}
        {data.rules.map((r, i) => (
          <div key={i} className="was-rule">
            <span className="was-rule-n">{i + 1}</span>
            <span className="was-word">If</span>
            <select aria-label="Condition" value={r.field} onChange={e => setRule(i, { field: e.target.value, value: '' })}>
              {FIELDS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <span className="was-word">is</span>
            {valueField(r, i)}
            <span className="was-word">send to</span>
            <select aria-label="Team" value={r.team_id || ''} onChange={e => setRule(i, { team_id: Number(e.target.value) })}>
              {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <span className="was-rule-end">
              <Toggle on={r.is_active} onChange={v => setRule(i, { is_active: v })} label="Rule on" />
              <button type="button" className="btn-icon was-up" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><Icon name="chevronLeft" size={14} /></button>
              <button type="button" className="btn-icon was-down" aria-label="Move down" disabled={i === data.rules.length - 1} onClick={() => move(i, 1)}><Icon name="chevronRight" size={14} /></button>
              <button type="button" className="btn-icon" aria-label="Remove rule" onClick={() => setData(d => ({ ...d, rules: d.rules.filter((_, j) => j !== i) }))}><Icon name="trash" size={14} /></button>
            </span>
          </div>
        ))}
        <div className="was-rule was-rule-else">
          <span className="was-word">Otherwise</span> pick from
          <select aria-label="Fallback team" value={data.fallback_team_id || ''} onChange={e => setData(d => ({ ...d, fallback_team_id: e.target.value ? Number(e.target.value) : null }))}>
            <option value="">Everyone who gets new chats</option>
            {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
      </section>
    </>
  )
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
   Lead statuses
   ════════════════════════════════════════════════════════════════════════════════════════════ */

const SWATCHES = ['#60a5fa', '#c3c9d4', '#a89dff', '#fbbf24', '#fb923c', '#34d399', '#f87171', '#f472b6', '#2dd4bf']

function StatusesTab() {
  const apiFetch = useApi()
  const toast = useToast()
  const [list, setList] = useState(null)
  const [saving, setSaving] = useState(false)
  const guard = useDirtyGuard({ snapshot: list, identity: list ? 'statuses' : null, confirm: toast.confirm })

  useEffect(() => {
    apiFetch('/api/whatsapp/admin/statuses').then(r => r && !r.error ? setList(r.statuses) : toast.error(r?.error || 'Could not load the statuses'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const def = useMemo(() => list?.find(s => s.is_default), [list])
  if (!list) return <Loading />

  const set = (i, patch) => setList(l => l.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  const move = (i, by) => setList(l => {
    const next = [...l]; const j = i + by
    if (j < 0 || j >= next.length) return l
    ;[next[i], next[j]] = [next[j], next[i]]
    return next
  })
  const remove = async (i) => {
    const s = list[i]
    if (s.is_default) return toast.error('Pick another status for new chats first')
    if (s.leads && !await toast.confirm({ title: `Remove “${s.name}”?`, message: `${s.leads} lead${s.leads === 1 ? ' is' : 's are'} in it. They move to “${def?.name}” when you save.`, danger: true })) return
    setList(l => l.filter((_, j) => j !== i))
  }

  const save = async () => {
    setSaving(true)
    const r = await apiFetch('/api/whatsapp/admin/statuses', { method: 'PUT', body: JSON.stringify({ statuses: list }) })
    setSaving(false)
    if (!r || r.error) return toast.error(r?.error || 'Could not save the statuses')
    setList(r.statuses)
    guard.reset(r.statuses)
    toast.success('Saved')
  }

  return (
    <>
      <Head title="Lead statuses"
        actions={<>
          <button type="button" className="btn btn-secondary btn-sm"
            onClick={() => setList(l => [...l, { key: '', name: 'New status', color: SWATCHES[l.length % SWATCHES.length], description: '', stage: 'open', is_default: false, leads: 0 }])}>
            <Icon name="plus" size={14} /> Add status
          </button>
          <SaveButton dirty={guard.dirty} saving={saving} onClick={save} />
        </>}>
        The stages a lead moves through, in order. They are the filters down the side of the inbox and
        the choices in the lead panel. Renaming one relabels every lead in it.
      </Head>

      <section className="was-card">
        {list.map((s, i) => (
          <div key={s.key || `new-${i}`} className="was-status">
            <div className="was-status-order">
              <button type="button" className="btn-icon was-up" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><Icon name="chevronLeft" size={14} /></button>
              <button type="button" className="btn-icon was-down" aria-label="Move down" disabled={i === list.length - 1} onClick={() => move(i, 1)}><Icon name="chevronRight" size={14} /></button>
            </div>
            <div className="was-status-body">
              <div className="was-status-line">
                <span className="wa-pill" style={{ background: `color-mix(in srgb, ${s.color} 16%, transparent)`, color: s.color }}>{s.name || 'Unnamed'}</span>
                <span className="was-hint">{s.leads ? `${s.leads} lead${s.leads === 1 ? '' : 's'}` : 'No leads'}</span>
                <label className="was-default">
                  <input type="radio" name="wa-default-status" checked={!!s.is_default}
                    onChange={() => setList(l => l.map((x, j) => ({ ...x, is_default: j === i })))} />
                  New chats start here
                </label>
              </div>
              <div className="was-status-fields">
                <div className="input-group">
                  <label htmlFor={`ws-name-${i}`}>Name</label>
                  <input id={`ws-name-${i}`} value={s.name} maxLength={30} onChange={e => set(i, { name: e.target.value })} />
                </div>
                <div className="input-group">
                  <label htmlFor={`ws-desc-${i}`}>What it means</label>
                  <input id={`ws-desc-${i}`} value={s.description || ''} onChange={e => set(i, { description: e.target.value })} />
                </div>
                <div className="input-group">
                  <label htmlFor={`ws-stage-${i}`}>Counts as</label>
                  <select id={`ws-stage-${i}`} value={s.stage} onChange={e => set(i, { stage: e.target.value })}>
                    <option value="open">Open</option><option value="won">Won</option><option value="lost">Lost</option>
                  </select>
                </div>
              </div>
              <div className="was-swatches" role="radiogroup" aria-label={`Colour for ${s.name}`}>
                {SWATCHES.map(c => (
                  <button key={c} type="button" role="radio" aria-checked={s.color === c} aria-label={c}
                    className={`was-swatch${s.color === c ? ' was-swatch-on' : ''}`} style={{ background: c }}
                    onClick={() => set(i, { color: c })} />
                ))}
              </div>
            </div>
            <button type="button" className="btn-icon" aria-label={`Remove ${s.name}`} onClick={() => remove(i)}><Icon name="trash" size={14} /></button>
          </div>
        ))}
      </section>
    </>
  )
}
