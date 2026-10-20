import { useState, useEffect } from 'react'
import { useApi } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import { SaveButton, Head, Toggle, Loading } from './waSettingsUi'
import { useWaBrand } from './waBrand'

/**
 * Normless's WhatsApp settings, laid out as the design has them.
 *
 * Everything here is saved on Normless's own line. What the bot knows about the shop is not typed
 * in at all — products, size charts and policies come from Shopify, and these screens only say
 * what was found there. The bot itself is the next phase of the build: its switch and rules are
 * saved now, and it reads them the day it starts answering.
 */

const fmtWhen = (v) => (v ? new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** Normless's settings, one section at a time: what is saved, what is being edited, and saving it. */
function useNlSettings() {
  const apiFetch = useApi()
  const toast = useToast()
  const brand = useWaBrand()
  const [saved, setSaved] = useState(null)
  const [draft, setDraft] = useState(null)
  const [canEdit, setCanEdit] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    apiFetch(`${brand.api}/nl/settings`).then(r => {
      if (!r || r.error) return toast.error(r?.error || 'Could not read the settings')
      setSaved(r.settings); setDraft(r.settings); setCanEdit(!!r.canEdit)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const set = (section, value) => setDraft(d => ({ ...d, [section]: typeof value === 'function' ? value(d[section]) : value }))
  const dirty = (...sections) => !!draft && sections.some(k => !same(draft[k], saved[k]))
  const save = async (...sections) => {
    setSaving(true)
    let last = null
    for (const k of sections.filter(k => !same(draft[k], saved[k]))) {
      const r = await apiFetch(`${brand.api}/nl/settings/${k}`, { method: 'PUT', body: JSON.stringify({ value: draft[k] }) })
      if (!r || r.error) { setSaving(false); return toast.error(r?.error || 'Could not save that') }
      last = r.settings
    }
    setSaving(false)
    if (last) {
      // Sections not saved keep what is being typed in them.
      setSaved(last)
      setDraft(d => ({ ...last, ...Object.fromEntries(Object.keys(last).filter(k => !sections.includes(k)).map(k => [k, d[k]])) }))
      toast.success('Saved')
    }
  }
  return { saved, draft, set, dirty, save, saving, canEdit }
}

/** What Shopify has: policies and products with their size charts. */
function useKnowledge() {
  const apiFetch = useApi()
  const toast = useToast()
  const brand = useWaBrand()
  const [k, setK] = useState(null)
  const [syncing, setSyncing] = useState(false)
  useEffect(() => {
    apiFetch(`${brand.api}/nl/knowledge`).then(r => (r && !r.error ? setK(r) : setK({ error: r?.error || 'Could not read Shopify' })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const sync = async () => {
    setSyncing(true)
    const r = await apiFetch(`${brand.api}/nl/knowledge/sync`, { method: 'POST' })
    setSyncing(false)
    if (!r || r.error) return toast.error(r?.error || 'Could not read Shopify')
    setK(r)
    toast.success('Read from Shopify again')
  }
  return { k, sync, syncing }
}

/* ── Pieces ─────────────────────────────────────────────────────────────────────────────── */

function BotCard({ s }) {
  const bot = s.draft.bot
  const set = (patch) => s.set('bot', b => ({ ...b, ...patch }))
  return (
    <section className="was-card">
      <div className="nl-switch-row">
        <Toggle on={bot.enabled} label="Bot answers new chats" disabled={!s.canEdit} onChange={v => set({ enabled: v })} />
        <div>
          <b>Bot answers new chats</b>
          <span className="was-hint">Off: every chat goes straight to the team. The bot is being built next — this switch takes effect the day it can answer.</span>
        </div>
      </div>
      <div className="form-row">
        <div className="input-group">
          <label htmlFor="nl-tone">Tone</label>
          <select id="nl-tone" value={bot.tone} disabled={!s.canEdit} onChange={e => set({ tone: e.target.value })}>
            <option value="friendly">Friendly and short</option>
            <option value="formal">Polite and formal</option>
            <option value="playful">Playful, streetwear voice</option>
          </select>
        </div>
        <div className="input-group">
          <label htmlFor="nl-lang">Language</label>
          <select id="nl-lang" value={bot.language} disabled={!s.canEdit} onChange={e => set({ language: e.target.value })}>
            <option value="en">English</option>
            <option value="customer">Reply in the customer’s language</option>
          </select>
        </div>
      </div>
    </section>
  )
}

function FaqEditor({ s }) {
  const faqs = s.draft.faqs
  const [adding, setAdding] = useState(null)
  const update = (i, patch) => s.set('faqs', list => list.map((f, j) => (j === i ? { ...f, ...patch } : f)))
  return (
    <>
      <div className="nl-row-head">
        <span><b>Extra answers</b> <span className="was-hint">· things that aren’t in a policy</span></span>
        {s.canEdit && !adding && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAdding({ q: '', a: '' })}><Icon name="plus" size={13} /> Add answer</button>}
      </div>
      {adding && (
        <div className="nl-faq nl-faq-edit">
          <input aria-label="Question" placeholder="The question, as a customer would ask it" value={adding.q} autoFocus
            onChange={e => setAdding(a => ({ ...a, q: e.target.value }))} />
          <textarea aria-label="Answer" rows={2} placeholder="The answer the bot may give" value={adding.a}
            onChange={e => setAdding(a => ({ ...a, a: e.target.value }))} />
          <div className="was-inline">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAdding(null)}>Cancel</button>
            <button type="button" className="btn btn-primary btn-sm" disabled={!adding.q.trim() || !adding.a.trim()}
              onClick={() => { s.set('faqs', list => [...list, { q: adding.q.trim(), a: adding.a.trim() }]); setAdding(null) }}>Add</button>
          </div>
        </div>
      )}
      {faqs.map((f, i) => (
        <div key={i} className="nl-faq">
          {s.canEdit ? (
            <>
              <input aria-label="Question" value={f.q} onChange={e => update(i, { q: e.target.value })} />
              <textarea aria-label="Answer" rows={2} value={f.a} onChange={e => update(i, { a: e.target.value })} />
              <button type="button" className="btn-icon nl-faq-remove" aria-label={`Remove “${f.q}”`} title="Remove"
                onClick={() => s.set('faqs', list => list.filter((_, j) => j !== i))}><Icon name="trash" size={13} /></button>
            </>
          ) : (<><b>{f.q}</b><span className="was-hint">{f.a}</span></>)}
        </div>
      ))}
      {!faqs.length && !adding && <p className="was-hint">None yet.</p>}
    </>
  )
}

function KnowledgeCard({ s, kn, full = false }) {
  const { k, sync, syncing } = kn
  const policy = (re) => k?.policies?.find(p => re.test(p.title))
  const sources = k && !k.error ? [
    { name: 'Refund, return & exchange policy', ok: !!policy(/refund/i), detail: policy(/refund/i) ? `Shopify policy · ${policy(/refund/i).chars.toLocaleString('en-IN')} characters` : k.policies_error || 'Not found in Shopify' },
    { name: 'Shipping policy', ok: !!policy(/shipping/i), detail: policy(/shipping/i) ? `Shopify policy · ${policy(/shipping/i).chars.toLocaleString('en-IN')} characters` : k.policies_error || 'Not found in Shopify' },
    { name: 'Products, sizes and stock', ok: !!k.products, detail: k.products ? `${k.products.count} active products · ${k.products.with_chart} with a size chart` : k.products_error },
    { name: 'Orders and tracking', ok: true, detail: 'CRM orders + dispatch log · live' },
  ] : []
  return (
    <section className="was-card">
      <div className="was-card-head">
        <h3>What the bot knows</h3>
        <button type="button" className="btn btn-secondary btn-sm" disabled={syncing || !s.canEdit} onClick={sync}>
          <Icon name="refresh" size={13} /> {syncing ? 'Reading Shopify…' : 'Sync now'}
        </button>
      </div>
      <p className="was-hint" style={{ margin: 0 }}>Read from Shopify — edit the policies and products there, not here.{k?.checked_at ? ` Checked ${fmtWhen(k.checked_at)}.` : ''}</p>
      {!k ? <Loading /> : k.error ? <p className="was-bad">{k.error}</p> : (
        <ul className="nl-sources">
          {sources.map(x => (
            <li key={x.name}><span className={`nl-dot${x.ok ? ' on' : ''}`} aria-hidden="true" /><span><b>{x.name}</b> <span className="was-hint">· {x.detail}</span></span></li>
          ))}
        </ul>
      )}
      {full && k?.policies?.length > 0 && (
        <div className="nl-policies">
          {k.policies.map(p => (
            <div key={p.title}>
              <b>{p.title}</b>
              <span className="was-hint">{p.chars.toLocaleString('en-IN')} characters · updated {fmtWhen(p.updated_at)}</span>
              {p.url && <a href={p.url} target="_blank" rel="noreferrer">Read it ↗</a>}
            </div>
          ))}
        </div>
      )}
      <FaqEditor s={s} />
    </section>
  )
}

const RULES = [
  ['refund', 'The customer asks for a refund', 'Always a person — refunds depend on QC and the reason.'],
  ['damaged', 'Damaged or wrong product', 'After the bot has collected photos and the unboxing video.'],
  ['asks_person', 'The customer asks for a person', 'Or taps “Talk to a person”.'],
  ['unsure', 'The bot isn’t sure', 'Two answers in a row it couldn’t ground in a policy or product.'],
  ['no_order', 'No order found', 'Not on this phone number, and the order number they typed doesn’t match.'],
  ['upset', 'The customer is upset', 'Angry words, or the same question three times.'],
]

function HandoffCard({ s }) {
  const h = s.draft.handoff
  const set = (patch) => s.set('handoff', x => ({ ...x, ...patch }))
  return (
    <section className="was-card">
      <h3>Hand over to a person when…</h3>
      <ul className="nl-rules">
        {RULES.map(([key, title, note]) => (
          <li key={key}>
            <Toggle on={h[key]} label={title} disabled={!s.canEdit} onChange={v => set({ [key]: v })} />
            <span><b>{title}</b><span className="was-hint">{note}</span></span>
          </li>
        ))}
        <li>
          <Toggle on={h.big_order} label="Big orders get a person" disabled={!s.canEdit} onChange={v => set({ big_order: v })} />
          <span>
            <b>An order above ₹
              <input className="nl-amount" type="number" min="0" step="500" aria-label="Order value" value={h.big_order_amount}
                disabled={!s.canEdit} onChange={e => set({ big_order_amount: Number(e.target.value) })} />
            </b>
            <span className="was-hint">Big orders get a person from the first message.</span>
          </span>
        </li>
      </ul>
      <div className="nl-row-head nl-row-top">
        <b>Send handovers to</b>
        <span className="was-hint">The Normless team — unassigned, anyone on the team picks it up</span>
      </div>
    </section>
  )
}

function NeverCard() {
  return (
    <section className="was-card nl-never">
      <h3>The bot can never</h3>
      <p className="was-hint" style={{ margin: 0 }}>These aren’t settings. The bot has no tool that can do them, so it hands over instead.</p>
      <div className="nl-chips">
        {['Approve a refund or replacement', 'Give a discount or coupon', 'Change an address or order', 'Promise a delivery date', 'Quote a price Shopify didn’t give it'].map(t => <span key={t}>{t}</span>)}
      </div>
    </section>
  )
}

function TryIt() {
  return (
    <aside className="was-card nl-try" aria-label="Try the bot">
      <h3>Try it</h3>
      <p className="was-hint" style={{ margin: 0 }}>Ask like a customer. Nothing is sent on WhatsApp.</p>
      <div className="nl-try-feed">
        <div className="nl-try-note">
          <Icon name="spark" size={16} />
          <span>The bot is the next part of the build. Once it is in, this is where you test it — with these settings and Shopify’s products and policies — before switching it on.</span>
        </div>
      </div>
      <div className="was-inline">
        <input className="input" aria-label="Test message" placeholder="Type a question…" disabled style={{ flex: 1 }} />
        <button type="button" className="btn btn-primary btn-sm" disabled>Ask</button>
      </div>
    </aside>
  )
}

/* ── Tabs ───────────────────────────────────────────────────────────────────────────────── */

export function NlBotTab() {
  const s = useNlSettings()
  const kn = useKnowledge()
  if (!s.draft) return <Loading />
  const sections = ['bot', 'faqs', 'handoff']
  return (
    <>
      <Head title="Normless bot" actions={s.canEdit && <SaveButton dirty={s.dirty(...sections)} saving={s.saving} label="Save" onClick={() => s.save(...sections)} />}>
        Answers customers on the Normless number. People step in only when a rule below says so.
      </Head>
      <div className="nl-grid">
        <div className="nl-col">
          <BotCard s={s} />
          <KnowledgeCard s={s} kn={kn} />
          <HandoffCard s={s} />
          <NeverCard />
        </div>
        <TryIt />
      </div>
    </>
  )
}

export function NlKnowledgeTab() {
  const s = useNlSettings()
  const kn = useKnowledge()
  if (!s.draft) return <Loading />
  return (
    <>
      <Head title="Knowledge & policies" actions={s.canEdit && <SaveButton dirty={s.dirty('faqs')} saving={s.saving} onClick={() => s.save('faqs')} />}>
        The refund, exchange and shipping policies come from Shopify; extra answers fill the gaps.
      </Head>
      <KnowledgeCard s={s} kn={kn} full />
    </>
  )
}

export function NlProductsTab() {
  const s = useNlSettings()
  const { k, sync, syncing } = useKnowledge()
  const p = k?.products
  return (
    <>
      <Head title="Products & size charts" actions={s.canEdit && (
        <button type="button" className="btn btn-secondary btn-sm" disabled={syncing} onClick={sync}><Icon name="refresh" size={13} /> {syncing ? 'Reading Shopify…' : 'Sync now'}</button>
      )}>
        The bot sends a product’s page, price, sizes in stock and its own size chart — the chart is the product photo named “size chart” in Shopify.
      </Head>
      {!k ? <Loading /> : !p ? <p className="was-bad">{k.products_error || k.error || 'Could not read the products'}</p> : (
        <>
          <section className="was-card">
            <div className="was-facts">
              <div><span>Active products</span><b>{p.count}</b></div>
              <div><span>With a size chart</span><b>{p.with_chart}</b></div>
              <div><span>In stock</span><b>{p.in_stock}</b></div>
              <div><span>Checked</span><b>{fmtWhen(k.checked_at)}</b></div>
            </div>
          </section>
          <section className="was-card">
            <h3>By product type</h3>
            <table className="nl-table">
              <thead><tr><th>Type</th><th>Products</th><th>Size chart</th></tr></thead>
              <tbody>
                {p.by_type.map(t => (
                  <tr key={t.type}>
                    <td>{t.type}</td><td>{t.products}</td>
                    <td className={t.with_chart === t.products ? 'ok' : 'warn'}>{t.with_chart === t.products ? 'All have one' : `${t.products - t.with_chart} missing`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="was-card">
            <h3>Without a size chart</h3>
            <p className="was-hint" style={{ margin: 0 }}>For these the bot says a person will share the measurements and hands over — it never sends another product’s chart. Add a photo named “size chart” in Shopify to fix one.</p>
            {!p.missing_chart.length ? <p className="was-hint">Every product has one.</p> : (
              <ul className="nl-missing">
                {p.missing_chart.map(m => (
                  <li key={m.handle || m.title}>
                    <span><b>{m.title}</b> <span className="was-hint">· {m.type}</span></span>
                    {m.handle && <a href={`https://normless.store/products/${m.handle}`} target="_blank" rel="noreferrer">View ↗</a>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </>
  )
}

export function NlHandoffTab() {
  const s = useNlSettings()
  if (!s.draft) return <Loading />
  return (
    <>
      <Head title="Handoff rules" actions={s.canEdit && <SaveButton dirty={s.dirty('handoff')} saving={s.saving} onClick={() => s.save('handoff')} />}>
        When the bot stops and a person takes the chat.
      </Head>
      <HandoffCard s={s} />
      <NeverCard />
    </>
  )
}

export function NlMenuTab() {
  const s = useNlSettings()
  if (!s.draft) return <Loading />
  const m = s.draft.menu
  const set = (patch) => s.set('menu', x => ({ ...x, ...patch }))
  const setOption = (i, v) => set({ options: m.options.map((o, j) => (j === i ? v : o)) })
  return (
    <>
      <Head title="Welcome menu" actions={s.canEdit && <SaveButton dirty={s.dirty('menu')} saving={s.saving} onClick={() => s.save('menu')} />}>
        The first thing a new chat sees: a greeting and up to ten choices, tapped on WhatsApp.
      </Head>
      <div className="nl-grid">
        <div className="nl-col">
          <section className="was-card">
            <div className="input-group">
              <label htmlFor="nl-greet">Greeting <span className="label-hint">{'{name}'} is the customer’s first name</span></label>
              <textarea id="nl-greet" rows={2} value={m.greeting} disabled={!s.canEdit} onChange={e => set({ greeting: e.target.value })} />
            </div>
            <div className="nl-row-head"><b>Choices</b><span className="was-hint">24 characters each — WhatsApp’s limit</span></div>
            {m.options.map((o, i) => (
              <div key={i} className="nl-option">
                <input aria-label={`Choice ${i + 1}`} maxLength={24} value={o} disabled={!s.canEdit} onChange={e => setOption(i, e.target.value)} />
                {s.canEdit && m.options.length > 1 && (
                  <button type="button" className="btn-icon" aria-label={`Remove ${o}`} onClick={() => set({ options: m.options.filter((_, j) => j !== i) })}><Icon name="trash" size={13} /></button>
                )}
              </div>
            ))}
            {s.canEdit && m.options.length < 10 && (
              <button type="button" className="mini-btn" onClick={() => set({ options: [...m.options, ''] })}>+ Add a choice</button>
            )}
            <div className="input-group">
              <label htmlFor="nl-exch">Returns & Exchange Center</label>
              <input id="nl-exch" value={m.exchange_url} disabled={!s.canEdit} onChange={e => set({ exchange_url: e.target.value })} />
            </div>
          </section>
        </div>
        <aside className="nl-phone" aria-label="Preview">
          <div className="nl-phone-top"><span>NL</span><b>Normless</b></div>
          <div className="nl-phone-feed">
            <div className="nl-phone-out">hi</div>
            <div className="nl-phone-in">
              <div>{m.greeting.replace('{name}', 'Meera')}</div>
              {m.options.filter(Boolean).map((o, i) => <span key={i}>{o}</span>)}
            </div>
          </div>
        </aside>
      </div>
    </>
  )
}

export function NlRepliesTab() {
  const apiFetch = useApi()
  const toast = useToast()
  const brand = useWaBrand()
  const [list, setList] = useState(null)
  const [draft, setDraft] = useState({ title: '', body: '' })
  const load = () => apiFetch(`${brand.api}/quick-replies`).then(r => setList(r?.quickReplies || []))
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const add = async () => {
    const r = await apiFetch(`${brand.api}/quick-replies`, { method: 'POST', body: JSON.stringify(draft) })
    if (!r || r.error) return toast.error(r?.error || 'Could not save that reply')
    setDraft({ title: '', body: '' }); load(); toast.success('Saved')
  }
  const remove = async (q) => {
    if (!await toast.confirm({ title: `Remove “${q.title}”?`, message: 'Nobody will be able to pick it from the reply box.', confirmLabel: 'Remove', danger: true })) return
    const r = await apiFetch(`${brand.api}/quick-replies/${q.id}`, { method: 'DELETE' })
    if (!r || r.error) return toast.error(r?.error || 'Could not remove that')
    load()
  }
  return (
    <>
      <Head title="Saved replies">The sentences the team types every day, one click away in the reply box (or type / there).</Head>
      <section className="was-card">
        <div className="form-row">
          <div className="input-group"><label htmlFor="nl-r-t">Name</label><input id="nl-r-t" placeholder="e.g. Exchange steps" value={draft.title} onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} /></div>
        </div>
        <div className="input-group"><label htmlFor="nl-r-b">Reply</label><textarea id="nl-r-b" rows={3} value={draft.body} onChange={e => setDraft(d => ({ ...d, body: e.target.value }))} /></div>
        <div className="was-inline"><button type="button" className="btn btn-primary btn-sm" disabled={!draft.title.trim() || !draft.body.trim()} onClick={add}>Save reply</button></div>
      </section>
      {!list ? <Loading /> : (
        <section className="was-card">
          {!list.length && <p className="was-hint">Nothing saved yet.</p>}
          {list.map(q => (
            <div key={q.id} className="nl-faq">
              <b>{q.title}</b><span className="was-hint">{q.body}</span>
              <button type="button" className="btn-icon nl-faq-remove" aria-label={`Remove ${q.title}`} onClick={() => remove(q)}><Icon name="trash" size={13} /></button>
            </div>
          ))}
        </section>
      )}
    </>
  )
}

export function NlTeamTab() {
  const apiFetch = useApi()
  const brand = useWaBrand()
  const [members, setMembers] = useState(null)
  useEffect(() => { apiFetch(`${brand.api}/nl/team`).then(r => setMembers(r?.members || [])) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <Head title="Team">Who answers Normless’s chats. Give someone access in Admin › their user › Normless › WhatsApp inbox.</Head>
      {!members ? <Loading /> : (
        <section className="was-card">
          <table className="nl-table">
            <thead><tr><th>Person</th><th>Access</th><th>Open chats</th><th>Last signed in</th></tr></thead>
            <tbody>
              {members.map(m => (
                <tr key={m.username}>
                  <td>{m.username.split('@')[0]}</td>
                  <td>{m.is_manager ? 'Every chat, can reassign' : 'Own chats'}</td>
                  <td>{m.open_chats}</td>
                  <td>{fmtWhen(m.last_login)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  )
}

const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']]

export function NlHoursTab() {
  const s = useNlSettings()
  if (!s.draft) return <Loading />
  const h = s.draft.hours
  const set = (patch) => s.set('hours', x => ({ ...x, ...patch }))
  return (
    <>
      <Head title="Hours & away" actions={s.canEdit && <SaveButton dirty={s.dirty('hours')} saving={s.saving} onClick={() => s.save('hours')} />}>
        When the team answers. Outside these hours the bot still replies; anything it hands over waits for the morning, and the customer is told when.
      </Head>
      <section className="was-card">
        <div className="nl-row-head"><b>Days</b></div>
        <div className="nl-days" role="group" aria-label="Working days">
          {DAYS.map(([d, label]) => (
            <button key={d} type="button" aria-pressed={h.days.includes(d)} disabled={!s.canEdit}
              className={`chip${h.days.includes(d) ? ' chip-on' : ''}`}
              onClick={() => set({ days: h.days.includes(d) ? h.days.filter(x => x !== d) : [...h.days, d] })}>{label}</button>
          ))}
        </div>
        <div className="form-row">
          <div className="input-group"><label htmlFor="nl-h-s">From</label><input id="nl-h-s" type="time" value={h.start} disabled={!s.canEdit} onChange={e => set({ start: e.target.value })} /></div>
          <div className="input-group"><label htmlFor="nl-h-e">To</label><input id="nl-h-e" type="time" value={h.end} disabled={!s.canEdit} onChange={e => set({ end: e.target.value })} /></div>
        </div>
        <div className="input-group">
          <label htmlFor="nl-h-a">Away message</label>
          <textarea id="nl-h-a" rows={3} value={h.away} disabled={!s.canEdit} onChange={e => set({ away: e.target.value })} />
        </div>
      </section>
    </>
  )
}

export function NlTemplatesTab() {
  const apiFetch = useApi()
  const toast = useToast()
  const brand = useWaBrand()
  const [list, setList] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const load = () => apiFetch(`${brand.api}/templates`).then(r => setList(r?.templates || []))
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const sync = async () => {
    setSyncing(true)
    const r = await apiFetch(`${brand.api}/templates/sync`, { method: 'POST' })
    setSyncing(false)
    if (!r || r.error) return toast.error(r?.error || 'Could not read the templates from Meta')
    load(); toast.success(`${r.approved} approved template${r.approved === 1 ? '' : 's'}`)
  }
  return (
    <>
      <Head title="Templates" actions={<button type="button" className="btn btn-secondary btn-sm" disabled={syncing} onClick={sync}><Icon name="refresh" size={13} /> {syncing ? 'Syncing…' : 'Sync from Meta'}</button>}>
        What can be sent after a customer has been quiet for 24 hours. Meta approves them for Normless’s own WhatsApp account, once the number is connected.
      </Head>
      {!list ? <Loading /> : (
        <section className="was-card">
          {!list.length && <p className="was-hint">No approved templates on Normless’s account yet. Connect the number, then sync.</p>}
          {list.map(t => (
            <div key={t.id} className="nl-faq"><b>{t.name}</b><span className="was-hint">{t.body_text}</span></div>
          ))}
        </section>
      )}
    </>
  )
}
