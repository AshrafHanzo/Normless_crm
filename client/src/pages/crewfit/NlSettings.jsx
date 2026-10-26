import { useState, useEffect } from 'react'
import { useApi } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import { SaveButton, Head, Toggle, Loading } from './waSettingsUi'
import { useWaBrand } from './waBrand'
import { STATUS_LOOK, formFrom } from './nlTemplates'

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
  const [botReady, setBotReady] = useState(true)

  useEffect(() => {
    apiFetch(`${brand.api}/nl/settings`).then(r => {
      if (!r || r.error) return toast.error(r?.error || 'Could not read the settings')
      setSaved(r.settings); setDraft(r.settings); setCanEdit(!!r.canEdit); setBotReady(!!r.botReady)
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
  return { saved, draft, set, dirty, save, saving, canEdit, botReady }
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
          <span className="was-hint">On: the AI bot answers every chat and hands sensitive ones to a person. Without an API key, or switched off, the Welcome menu answers instead.</span>
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
        <span className="was-hint">Whoever on the Normless team has the fewest open chats — they’re introduced to the customer by name. Set the team in Settings › Team.</span>
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

function TryIt({ ready }) {
  const apiFetch = useApi()
  const toast = useToast()
  const brand = useWaBrand()
  const [turns, setTurns] = useState([])      // { role: 'customer' | 'bot', text, sent?, handOver? }
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const ask = async () => {
    const text = draft.trim()
    if (!text) return
    const next = [...turns, { role: 'customer', text }]
    setTurns(next); setDraft(''); setBusy(true)
    const r = await apiFetch(`${brand.api}/nl/bot/try`, { method: 'POST', body: JSON.stringify({ turns: next.filter(t => t.text).map(t => ({ role: t.role, text: t.text })) }) })
    setBusy(false)
    if (!r || r.error) { toast.error(r?.error || 'The bot could not answer'); return }
    setTurns(t => [...t, { role: 'bot', text: r.reply || '', sent: r.sent || [], handOver: r.handOver }])
  }
  return (
    <aside className="was-card nl-try" aria-label="Try the bot">
      <div className="was-card-head">
        <h3>Try it</h3>
        {!!turns.length && <button type="button" className="mini-btn" onClick={() => setTurns([])}>Start over</button>}
      </div>
      <p className="was-hint" style={{ margin: 0 }}>Ask like a customer. Nothing is sent on WhatsApp.</p>
      <div className="nl-try-feed nl-try-chat">
        {!ready && <div className="nl-try-note"><Icon name="alert" size={16} /><span>The bot needs an Anthropic API key on the server before it can answer.</span></div>}
        {ready && !turns.length && <div className="nl-try-note"><Icon name="spark" size={16} /><span>Try “Is the AMG tee oversized?”, “Where is my order?” or “I want a refund”.</span></div>}
        {turns.map((t, i) => (
          <div key={i} className={`nl-try-msg ${t.role}`}>
            {t.sent?.map((x, k) => (
              <figure key={k} className="nl-try-media">
                <img src={x.image} alt="" loading="lazy" />
                <figcaption>{x.text}</figcaption>
              </figure>
            ))}
            {t.text && <div className="nl-try-text">{t.text}</div>}
            {t.handOver && <div className="nl-try-handover">Would hand over: {t.handOver.reason}</div>}
          </div>
        ))}
        {busy && <div className="nl-try-msg bot"><div className="nl-try-text"><span className="wa-spin" aria-hidden="true" /> Thinking…</div></div>}
      </div>
      <form className="was-inline" onSubmit={e => { e.preventDefault(); ask() }}>
        <input className="input" aria-label="Test message" placeholder="Type a question…" value={draft} disabled={!ready || busy}
          onChange={e => setDraft(e.target.value)} style={{ flex: 1 }} />
        <button type="submit" className="btn btn-primary btn-sm" disabled={!ready || busy || !draft.trim()}>Ask</button>
      </form>
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
      {!s.botReady && (
        <section className="was-card was-warn-card">
          <h3>The bot can’t answer yet</h3>
          <p className="was-hint" style={{ margin: 0 }}>It needs an Anthropic API key in the server’s settings (ANTHROPIC_API_KEY). Until then the Welcome menu answers customers, and passes what it can’t answer to the team.</p>
        </section>
      )}
      <div className="nl-grid">
        <div className="nl-col">
          <BotCard s={s} />
          <KnowledgeCard s={s} kn={kn} />
          <HandoffCard s={s} />
          <NeverCard />
        </div>
        <TryIt ready={s.botReady} />
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

const MENU_HELP = {
  track: 'Their orders by phone (or by order number + email/pincode), status, waybill and tracking link',
  size: 'Type a product name → its size chart from Shopify; no chart → a person',
  products: 'Categories → products with photo, price, sizes in stock and link',
  exchange: 'The exchange rules (₹198, unworn, tags on) and a button to the Exchange Center',
  refund: 'The refund policy; damaged or wrong item → collects photos and video → a person',
  person: 'Straight to the team, introduced by name',
}

export function NlMenuTab() {
  const s = useNlSettings()
  if (!s.draft) return <Loading />
  const m = s.draft.menu
  const set = (patch) => s.set('menu', x => ({ ...x, ...patch }))
  const setItem = (key, patch) => set({ items: m.items.map(i => (i.key === key ? { ...i, ...patch } : i)) })
  const shown = m.items.filter(i => i.enabled && i.key !== 'person')
  return (
    <>
      <Head title="Welcome menu" actions={s.canEdit && <SaveButton dirty={s.dirty('menu')} saving={s.saving} onClick={() => s.save('menu')} />}>
        The menu customers tap through. It answers from Shopify and the CRM — tracking, sizes, products, exchanges and refunds — and passes anything
        else to the team. It runs whenever the AI bot isn’t answering{s.botReady ? '' : ' (there’s no AI key yet, so right now it answers every new chat)'}.
      </Head>
      <div className="nl-grid">
        <div className="nl-col">
          <section className="was-card">
            <div className="nl-switch-row">
              <Toggle on={m.enabled !== false} label="Menu answers new chats" disabled={!s.canEdit} onChange={v => set({ enabled: v })} />
              <div><b>Menu answers new chats</b><span className="was-hint">Off: chats wait for a person unless the AI bot is on.</span></div>
            </div>
            <div className="input-group">
              <label htmlFor="nl-greet">Greeting <span className="label-hint">{'{name}'} is the customer’s first name</span></label>
              <textarea id="nl-greet" rows={2} value={m.greeting} disabled={!s.canEdit} onChange={e => set({ greeting: e.target.value })} />
            </div>
            <div className="nl-row-head"><b>Options</b><span className="was-hint">Rename or hide them — 24 characters each, WhatsApp’s limit</span></div>
            <ul className="nl-rules">
              {m.items.filter(it => it.key !== 'person').map(it => (
                <li key={it.key}>
                  <Toggle on={it.enabled} label={`Show ${it.label}`} disabled={!s.canEdit} onChange={v => setItem(it.key, { enabled: v })} />
                  <span style={{ flex: 1 }}>
                    <input className="nl-name" maxLength={24} aria-label={`Label for ${it.key}`} value={it.label} disabled={!s.canEdit}
                      onChange={e => setItem(it.key, { label: e.target.value })} />
                    <span className="was-hint" style={{ display: 'block', marginTop: 4 }}>{MENU_HELP[it.key]}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="was-hint" style={{ margin: 0 }}>“Talk to our team” isn’t in the menu: it’s offered only when the menu can’t find an answer, and typing “talk to a person” always works.</p>
            <div className="input-group">
              <label htmlFor="nl-exch">Returns & Exchange Center link</label>
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
              <span>See options</span>
            </div>
            <div className="nl-phone-list">
              {shown.map(i => <div key={i.key}>{i.label}</div>)}
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
  const toast = useToast()
  const brand = useWaBrand()
  const [members, setMembers] = useState(null)
  const [names, setNames] = useState({})
  const load = () => apiFetch(`${brand.api}/nl/team`).then(r => {
    setMembers(r?.members || [])
    setNames(Object.fromEntries((r?.members || []).map(m => [m.username, m.wa_display_name || ''])))
  })
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const saveName = async (m) => {
    if ((names[m.username] || '') === (m.wa_display_name || '')) return
    const r = await apiFetch(`${brand.api}/nl/team/${encodeURIComponent(m.username)}`, { method: 'PUT', body: JSON.stringify({ display_name: names[m.username] }) })
    if (!r || r.error) return toast.error(r?.error || 'Could not save that')
    toast.success(`Customers will see “${r.display_name}”`)
    load()
  }
  return (
    <>
      <Head title="Team">
        Who answers Normless’s chats. The bot hands chats to people marked “Gets chats”, whoever has the fewest open, and
        introduces them by the name below. Give someone the Normless WhatsApp inbox in Admin › their user to add them.
      </Head>
      {!members ? <Loading /> : (
        <section className="was-card">
          {!members.some(m => m.in_queue) && (
            <p className="was-bad" style={{ margin: 0 }}>Nobody gets handed-over chats yet — they wait in “Needs a person”. Tick “WhatsApp inbox” under Normless for your support team in Admin.</p>
          )}
          <table className="nl-table">
            <thead><tr><th>Person</th><th>Name customers see</th><th>Gets chats</th><th>Open chats</th></tr></thead>
            <tbody>
              {members.map(m => (
                <tr key={m.username}>
                  <td>{m.username}<div className="was-hint">{m.is_manager ? 'Every chat, can reassign' : 'Own chats'}</div></td>
                  <td>
                    <input className="nl-name" aria-label={`Name customers see for ${m.username}`} placeholder={m.default_name}
                      value={names[m.username] ?? ''} onChange={e => setNames(n => ({ ...n, [m.username]: e.target.value }))}
                      onBlur={() => saveName(m)} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />
                  </td>
                  <td className={m.in_queue ? 'ok' : ''}>{m.in_queue ? 'Yes' : 'No — owner/admin view only'}</td>
                  <td>{m.open_chats}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="was-hint" style={{ margin: 0 }}>Leave the name empty to use the first part of their login ({members[0]?.default_name ? `e.g. “${members[0].default_name}”` : 'their first name'}).</p>
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

const fill = (text, values) => String(text || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (m, n) => values?.[Number(n) - 1] || m)

/** A template as the customer will see it on WhatsApp. */
export function TemplatePreview({ header, headerExample, body, examples, footer, buttons, image = null }) {
  return (
    <div className="nl-tpl-phone" aria-label="Preview">
      <div className="nl-tpl-bubble">
        {image && (typeof image === 'string'
          ? <img className="nl-tpl-image" src={image} alt="" />
          : <div className="nl-tpl-image nl-tpl-image-blank" aria-label="Product photo"><Icon name="shirt" size={28} /><span>Product photo</span></div>)}
        {header && <b className="nl-tpl-header">{fill(header, [headerExample])}</b>}
        <div className="nl-tpl-body">{fill(body, examples) || <span className="was-hint">The message appears here</span>}</div>
        {footer && <small className="nl-tpl-footer">{footer}</small>}
        <span className="nl-tpl-time">12:04</span>
      </div>
      {(buttons || []).filter(b => b.text).map((b, i) => (
        <div key={i} className="nl-tpl-button">
          <Icon name={b.type === 'URL' ? 'eye' : b.type === 'PHONE_NUMBER' ? 'phone' : 'refresh'} size={13} /> {b.text}
        </div>
      ))}
    </div>
  )
}


export function TemplateEditor({ template, onClose, onSaved }) {
  const apiFetch = useApi()
  const toast = useToast()
  const brand = useWaBrand()
  const editing = !!template?.id
  const [f, setF] = useState(() => formFrom(template))
  const [saving, setSaving] = useState(false)
  const set = (patch) => setF(x => ({ ...x, ...patch }))
  const gaps = [...new Set((f.body.match(/\{\{\s*(\d+)\s*\}\}/g) || []).map(m => Number(m.replace(/\D/g, ''))))].sort((a, b) => a - b)
  const setButton = (i, patch) => set({ buttons: f.buttons.map((b, k) => (k === i ? { ...b, ...patch } : b)) })
  const save = async () => {
    setSaving(true)
    const r = await apiFetch(editing ? `${brand.api}/tpl/templates/${template.id}` : `${brand.api}/tpl/templates`,
      { method: editing ? 'PUT' : 'POST', body: JSON.stringify(f) })
    setSaving(false)
    if (!r || r.error) return toast.error(r?.error || 'Meta refused that', { duration: 0 })
    toast.success(editing ? 'Sent to Meta for review again' : 'Sent to Meta for review — usually approved within minutes to hours')
    onSaved(r.template)
  }
  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer drawer-wide" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={editing ? `Edit ${template.name}` : 'New template'}>
        <div className="drawer-header">
          <div>
            <h2>{editing ? `Edit ${template.name}` : 'New template'}</h2>
            <div className="packed-sub">{editing ? 'Meta reviews it again. An approved template can be edited once a day.' : 'Meta reviews every template before it can be sent.'}</div>
          </div>
          <button type="button" className="btn-icon" aria-label="Close" onClick={onClose}><Icon name="close" size={16} /></button>
        </div>
        <div className="drawer-body nl-tpl-editor">
          <div className="nl-tpl-form">
            <div className="form-row">
              <div className="input-group">
                <label htmlFor="tpl-name">Name <span className="label-hint">lower case, numbers, _</span></label>
                <input id="tpl-name" value={f.name} disabled={editing} placeholder="order_shipped"
                  onChange={e => set({ name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} />
              </div>
              <div className="input-group">
                <label htmlFor="tpl-cat">Category</label>
                <select id="tpl-cat" value={f.category} disabled={editing} onChange={e => set({ category: e.target.value })}>
                  <option value="UTILITY">Utility — orders, updates</option>
                  <option value="MARKETING">Marketing — offers, carts</option>
                </select>
              </div>
              <div className="input-group">
                <label htmlFor="tpl-lang">Language</label>
                <select id="tpl-lang" value={f.language} disabled={editing} onChange={e => set({ language: e.target.value })}>
                  <option value="en">English</option><option value="en_US">English (US)</option><option value="hi">Hindi</option><option value="ta">Tamil</option>
                </select>
              </div>
            </div>
            <div className="input-group">
              <label htmlFor="tpl-head-kind">Header</label>
              <select id="tpl-head-kind" value={f.header_format} onChange={e => set({ header_format: e.target.value })}>
                <option value="">None</option><option value="TEXT">Text</option><option value="IMAGE">Product photo</option>
              </select>
              {f.header_format === 'IMAGE' && <span className="was-hint">Each message shows the photo of the product it’s about. A photo from the shop is sent to Meta as the sample.</span>}
              {f.header_format === 'TEXT' && <input id="tpl-head" aria-label="Header text" value={f.header} maxLength={60} placeholder="Your order {{1}} is on its way (60 characters, one gap at most)" onChange={e => set({ header: e.target.value })} />}
              {f.header_format === 'TEXT' && /\{\{1\}\}/.test(f.header) && <input aria-label="Header example" value={f.header_example} placeholder="Example for {{1}}" onChange={e => set({ header_example: e.target.value })} />}
            </div>
            <div className="input-group">
              <label htmlFor="tpl-body">Message <span className="label-hint">use {'{{1}}'}, {'{{2}}'} … for what changes each time</span></label>
              <textarea id="tpl-body" rows={6} maxLength={1024} value={f.body} placeholder={'Hi {{1}}, your order {{2}} has shipped with {{3}}.'} onChange={e => set({ body: e.target.value })} />
            </div>
            {!!gaps.length && (
              <div className="nl-tpl-examples">
                <span className="was-hint">Examples Meta’s reviewers read</span>
                {gaps.map(n => (
                  <input key={n} aria-label={`Example for {{${n}}}`} placeholder={`{{${n}}} e.g. ${['Meera', '#12151', 'Delhivery', '₹699'][n - 1] || 'value'}`}
                    value={f.examples[n - 1] || ''} onChange={e => { const ex = [...f.examples]; ex[n - 1] = e.target.value; set({ examples: ex }) }} />
                ))}
              </div>
            )}
            <div className="input-group">
              <label htmlFor="tpl-foot">Footer <span className="label-hint">optional, 60 characters</span></label>
              <input id="tpl-foot" value={f.footer} maxLength={60} placeholder="Normless" onChange={e => set({ footer: e.target.value })} />
            </div>
            <div className="nl-row-head"><b>Buttons</b><span className="was-hint">optional</span></div>
            {f.buttons.map((b, i) => (
              <div key={i} className="nl-tpl-btn-row">
                <select aria-label="Button type" value={b.type} onChange={e => setButton(i, { type: e.target.value })}>
                  <option value="QUICK_REPLY">Quick reply</option><option value="URL">Link</option><option value="PHONE_NUMBER">Call</option><option value="COPY_CODE">Copy coupon code</option>
                </select>
                {b.type === 'COPY_CODE'
                  ? <input aria-label="Example code" maxLength={15} placeholder="Example code, e.g. NORMLESS10" value={b.example} onChange={e => setButton(i, { example: e.target.value.toUpperCase() })} />
                  : <input aria-label="Button text" maxLength={25} placeholder="Button text" value={b.text} onChange={e => setButton(i, { text: e.target.value })} />}
                {b.type === 'URL' && <input aria-label="Link" placeholder="https://normless.store/… (end with {{1}} to vary it)" value={b.url} onChange={e => setButton(i, { url: e.target.value })} />}
                {b.type === 'URL' && /\{\{1\}\}$/.test(b.url) && <input aria-label="Example link" placeholder="Full example link" value={b.example} onChange={e => setButton(i, { example: e.target.value })} />}
                {b.type === 'PHONE_NUMBER' && <input aria-label="Phone number" placeholder="+91 86674 58532" value={b.phone_number} onChange={e => setButton(i, { phone_number: e.target.value })} />}
                <button type="button" className="btn-icon" aria-label="Remove button" onClick={() => set({ buttons: f.buttons.filter((_, k) => k !== i) })}><Icon name="trash" size={13} /></button>
              </div>
            ))}
            {f.buttons.length < 10 && <button type="button" className="mini-btn" onClick={() => set({ buttons: [...f.buttons, { type: 'QUICK_REPLY', text: '', url: '', phone_number: '', example: '' }] })}>+ Add a button</button>}
          </div>
          <div className="nl-tpl-preview-col">
            <div className="was-hint">Preview, with your examples filled in</div>
            <TemplatePreview header={f.header_format === 'TEXT' ? f.header : ''} headerExample={f.header_example} body={f.body} examples={f.examples} footer={f.footer}
              buttons={f.buttons.map(b => (b.type === 'COPY_CODE' ? { ...b, text: 'Copy offer code' } : b))} image={f.header_format === 'IMAGE' || null} />
          </div>
        </div>
        <div className="drawer-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={saving || !f.name || !f.body.trim()} onClick={save}>
            {saving ? 'Sending to Meta…' : editing ? 'Save and resubmit' : 'Submit for review'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Every template on the account: search, preview, write, edit and delete. */
export function NlTemplateLibrary({ embedded = false, reloadKey = 0, extraDetail = null }) {
  const apiFetch = useApi()
  const toast = useToast()
  const brand = useWaBrand()
  const [data, setData] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('ALL')
  const [picked, setPicked] = useState(null)
  const [editing, setEditing] = useState(null)        // a template, or {} for a new one
  const load = () => apiFetch(`${brand.api}/tpl/templates`).then(r => setData(r && !r.error ? r : { templates: [], error: r?.error }))
  useEffect(() => { load() }, [reloadKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const sync = async () => {
    setSyncing(true)
    const r = await apiFetch(`${brand.api}/templates/sync`, { method: 'POST' })
    setSyncing(false)
    if (!r || r.error) return toast.error(r?.error || 'Could not read the templates from Meta')
    await load(); toast.success(`${r.synced} templates synced, ${r.approved} approved`)
  }
  const remove = async (t) => {
    if (!await toast.confirm({ title: `Delete ${t.name}?`, message: 'It is deleted at Meta too, in every language. Automatic messages that use it stop until another template is chosen. The name can’t be reused for 30 days.', confirmLabel: 'Delete', danger: true })) return
    const r = await apiFetch(`${brand.api}/tpl/templates/${t.id}`, { method: 'DELETE' })
    if (!r || r.error) return toast.error(r?.error || 'Could not delete that')
    setPicked(null); load(); toast.success(`${t.name} deleted`)
  }
  // Only ours (Updatrr's and Meta's samples are hidden), found by name — "out for delivery" finds
  // nlcrm_out_for_delivery.
  const mine = (data?.templates || []).filter(t => t.ours)
  const hidden = (data?.templates || []).length - mine.length
  const words = query.toLowerCase().replace(/[_\s]+/g, ' ').trim()
  const list = mine.filter(t => (status === 'ALL' || t.status === status || (status === 'PENDING' && t.status === 'IN_APPEAL'))
    && (!words || t.name.toLowerCase().replace(/_/g, ' ').includes(words)))
  const counts = mine.reduce((n, t) => ({ ...n, [t.status]: (n[t.status] || 0) + 1 }), {})
  const current = picked && (data?.templates || []).find(t => t.id === picked)
  const pf = current && formFrom(current)
  return (
    <>
      {!embedded && <Head title="Templates" actions={<>
        <button type="button" className="btn btn-secondary btn-sm" disabled={syncing} onClick={sync}><Icon name="refresh" size={13} /> {syncing ? 'Syncing…' : 'Sync from Meta'}</button>
        {data?.canEdit && <button type="button" className="btn btn-primary btn-sm" disabled={!data?.connected} onClick={() => setEditing({})}><Icon name="plus" size={13} /> New template</button>}
      </>}>
        Messages Meta approved for Normless — the only kind WhatsApp lets you send once a customer has been quiet for 24 hours.
      </Head>}
      {!data ? <Loading /> : (
        <div className="nl-tpl-layout">
          <section className="was-card nl-tpl-list">
            {embedded && data?.canEdit && (
              <button type="button" className="btn btn-primary btn-sm" disabled={!data?.connected} onClick={() => setEditing({})}><Icon name="plus" size={13} /> New template</button>
            )}
            <input className="input" aria-label="Search templates" placeholder="Search by name, e.g. out for delivery" value={query} onChange={e => setQuery(e.target.value)} />
            <div className="nl-days" role="group" aria-label="Status">
              {[['ALL', 'All'], ['APPROVED', 'Approved'], ['PENDING', 'In review'], ['REJECTED', 'Rejected']].map(([k, label]) => (
                <button key={k} type="button" aria-pressed={status === k} className={`chip${status === k ? ' chip-on' : ''}`} onClick={() => setStatus(k)}>
                  {label} {k === 'ALL' ? mine.length : (counts[k] || 0) + (k === 'PENDING' ? (counts.IN_APPEAL || 0) : 0)}
                </button>
              ))}
            </div>
            {!list.length && <p className="was-hint">{mine.length ? 'No template matches.' : 'None yet — sync from Meta, or write a new one.'}</p>}
            {hidden > 0 && <p className="was-hint">{hidden} of Updatrr’s and Meta’s sample templates are hidden.</p>}
            <ul className="nl-tpl-items">
              {list.map(t => (
                <li key={t.id}>
                  <button type="button" className={`nl-tpl-item${picked === t.id ? ' on' : ''}`} onClick={() => setPicked(t.id)}>
                    <span className="nl-tpl-item-head"><b>{t.name}</b><span className={`status-badge ${STATUS_LOOK[t.status] || ''}`}>{t.status === 'IN_APPEAL' ? 'In review' : String(t.status || '').toLowerCase()}</span></span>
                    <span className="nl-tpl-item-meta">{String(t.category || '').toLowerCase()} · {t.language}</span>
                    <span className="nl-tpl-item-body">{t.body_text}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section className="was-card nl-tpl-detail">
            {!current ? <p className="was-hint">Pick a template to preview it.</p> : (
              <>
                <div className="was-card-head">
                  <h3>{current.name}</h3>
                  {data.canEdit && (
                    <span className="was-inline">
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(current)}><Icon name="edit" size={13} /> Edit</button>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => remove(current)}><Icon name="trash" size={13} /> Delete</button>
                    </span>
                  )}
                </div>
                <div className="was-facts">
                  <div><span>Status</span><b>{current.status}</b></div>
                  <div><span>Category</span><b>{current.category}</b></div>
                  <div><span>Language</span><b>{current.language}</b></div>
                  <div><span>Gaps</span><b>{current.variables || 0}</b></div>
                </div>
                {current.rejected_reason && current.rejected_reason !== 'NONE' && <p className="was-bad">Meta rejected it: {current.rejected_reason}</p>}
                <TemplatePreview header={pf.header} headerExample={pf.header_example} body={pf.body} examples={pf.examples} footer={pf.footer} buttons={pf.buttons}
                  image={current.components?.some(c => c.type === 'HEADER' && c.format === 'IMAGE') || null} />
                {extraDetail && extraDetail(current, load)}
              </>
            )}
          </section>
        </div>
      )}
      {editing && (
        <TemplateEditor template={editing.id ? editing : null} onClose={() => setEditing(null)}
          onSaved={(t) => { setEditing(null); load(); setPicked(t.id) }} />
      )}
    </>
  )
}
