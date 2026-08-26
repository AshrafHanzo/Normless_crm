import { useState, useEffect, useMemo } from 'react'
import { useApi, useAuth } from '../App'
import { useToast } from '../components/Toast'
import Icon from '../components/Icon'
import ComboInput from '../components/ComboInput'
import AutoTextarea from '../components/AutoTextarea'
import useDirtyGuard from '../hooks/useDirtyGuard'
import useServerTable from '../hooks/useServerTable'
import SortTh from '../components/SortTh'
import Pagination from '../components/Pagination'
import { cleanMobile, mobileError, mobileInputProps } from '../utils/phone'

const pad = (n) => String(n).padStart(2, '0')
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
const day = (v) => (v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—')

const STATUS_CLASS = {
  Requested: 'pending', Packed: 'refunded', Dispatched: 'fulfilled',
  Delivered: 'fulfilled', Cancelled: 'cancelled',
}
const COLLAB_CLASS = { Barter: 'badge-secondary', Paid: 'badge-primary', 'Barter / Paid': 'badge-primary' }

const blankInfluencer = () => ({
  name: '', content_type: 'Gym content', platform: 'Instagram', profile_url: '', collab_type: 'Barter',
  location: '', payment_per_video: '', total_content: 0, email: '', contact_number: '', address: '',
  notes: '', active: true,
})
const blankItem = () => ({ product: '', variant: '', sku: '', qty: 1, image: null, shopify_product_id: null, shopify_variant_id: null })
const blankOrder = () => ({
  influencer_id: '', name: '', email: '', contact_number: '', address: '', collab_type: 'Barter',
  items: [blankItem()], order_date: todayStr(), notes: '',
})

const orderQty = (items) => (items || []).reduce((s, i) => s + (parseInt(i.qty, 10) || 0), 0)
/** "Black Panther Tank · Black / S" — enough to recognise the parcel without opening it. */
const summarise = (items) => (items || []).map(i => [i.product, i.variant].filter(Boolean).join(' · ')).filter(Boolean)

/* ─────────────────────────── influencer drawer ─────────────────────────── */

function InfluencerDrawer({ target, meta, onClose, onSaved, apiFetch, toast }) {
  const [form, setForm] = useState(() => {
    if (target === 'new') return blankInfluencer()
    // A column that is NULL in the database would land straight in a controlled input, which
    // React treats as switching the field to uncontrolled. Fall back to the blank form's value.
    const blank = blankInfluencer()
    const filled = Object.fromEntries(Object.entries(target).map(([k, v]) => [k, v ?? blank[k] ?? '']))
    return { ...blank, ...filled, total_content: target.total_content ?? 0 }
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const setF = (patch) => setForm(f => ({ ...f, ...patch }))

  const guard = useDirtyGuard({
    snapshot: form, identity: target === 'new' ? 'new' : target.id,
    onDiscard: onClose, confirm: toast.confirm,
    title: 'Discard this influencer?',
    message: 'The details you have filled in will be lost.',
  })

  const save = async (e) => {
    e.preventDefault()
    setSaving(true); setError('')
    const path = target === 'new' ? '/api/marketing/influencers' : `/api/marketing/influencers/${target.id}`
    const res = await apiFetch(path, { method: target === 'new' ? 'POST' : 'PUT', body: JSON.stringify(form) })
    setSaving(false)
    if (!res || res.error) { setError(res?.error || 'Failed to save'); return }
    guard.reset()
    toast.success(`${res.influencer.name} saved`, { title: 'Influencer' })
    onSaved(res.influencer)
  }

  return (
    <div className="drawer-overlay" onClick={guard.requestClose}>
      <form className="drawer" onClick={e => e.stopPropagation()} onSubmit={save}>
        <div className="drawer-header">
          <h2>{target === 'new' ? 'New influencer' : form.name}</h2>
          <button type="button" className="btn-icon" onClick={guard.requestClose}><Icon name="close" size={16} /></button>
        </div>
        <div className="drawer-body">
          {error && <div className="scan-error-msg" style={{ marginBottom: 14 }}>{error}</div>}

          <div className="form-row">
            <div className="input-group"><label>Name *</label>
              <input required value={form.name} onChange={e => setF({ name: e.target.value })} placeholder="e.g. Tanmay Makwana" /></div>
            <div className="input-group"><label>Content type</label>
              <ComboInput value={form.content_type} onChange={v => setF({ content_type: v })} options={meta?.contentTypes || []} placeholder="e.g. Gym content" /></div>
          </div>

          <div className="form-row">
            <div className="input-group"><label>Platform</label>
              <select value={form.platform} onChange={e => setF({ platform: e.target.value })}>
                {(meta?.platforms || ['Instagram']).map(p => <option key={p}>{p}</option>)}
              </select></div>
            <div className="input-group" style={{ flex: 2 }}><label>Profile link</label>
              <input value={form.profile_url} onChange={e => setF({ profile_url: e.target.value })} placeholder="https://www.instagram.com/username/" />
              {/* Share-sheet links carry an ?igsh= tracking param; the server strips it on save. */}
            </div>
          </div>

          <div className="form-row">
            <div className="input-group"><label>Collab</label>
              <select value={form.collab_type} onChange={e => setF({ collab_type: e.target.value })}>
                {(meta?.collabTypes || ['Barter']).map(c => <option key={c}>{c}</option>)}
              </select></div>
            <div className="input-group"><label>Location</label>
              <ComboInput value={form.location} onChange={v => setF({ location: v })} options={meta?.locations || []} placeholder="e.g. Tamil Nadu" /></div>
            <div className="input-group"><label>Payment per video</label>
              <input value={form.payment_per_video} onChange={e => setF({ payment_per_video: e.target.value })} placeholder="e.g. 5k, or N/A for barter" /></div>
            <div className="input-group"><label>Content made</label>
              <input type="number" min="0" value={form.total_content} onChange={e => setF({ total_content: e.target.value })} /></div>
          </div>

          <div className="form-section">Shipping details</div>
          <p className="img-upload-hint" style={{ marginTop: -6, marginBottom: 12 }}>
            Prefilled into every order raised for this influencer. The order keeps its own copy, so
            changing these later never rewrites where a past parcel went.
          </p>
          <div className="form-row">
            <div className="input-group"><label>Email</label>
              <input type="email" value={form.email} onChange={e => setF({ email: e.target.value })} placeholder="optional" /></div>
            <div className="input-group"><label>Contact number</label>
              <input {...mobileInputProps} value={form.contact_number} onChange={e => setF({ contact_number: cleanMobile(e.target.value) })} />
              {mobileError(form.contact_number) && <div className="field-error">{mobileError(form.contact_number)}</div>}</div>
          </div>
          <div className="input-group"><label>Address</label>
            <AutoTextarea value={form.address || ''} onChange={e => setF({ address: e.target.value })} placeholder="Full postal address with pincode" /></div>
          <div className="input-group"><label>Notes</label>
            <AutoTextarea value={form.notes || ''} onChange={e => setF({ notes: e.target.value })} placeholder="Anything the team should know" /></div>

          <label className="page-check" style={{ marginTop: 8 }}>
            <input type="checkbox" checked={!!form.active} onChange={e => setF({ active: e.target.checked })} />
            <span><b>Active</b><em>Uncheck to keep the record but hide them from the default list.</em></span>
          </label>
        </div>
        <div className="drawer-footer">
          <button type="button" className="btn btn-secondary" onClick={guard.requestClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save influencer'}</button>
        </div>
      </form>
    </div>
  )
}

/* ───────────────────────────── product picker ───────────────────────────── */

/**
 * Item rows on an influencer order. Products come from Shopify so the name, variant and SKU
 * match what the warehouse actually picks — but the field stays typeable, because the sheet has
 * always carried one-off items ("Collaboration Product - Acid wash Track Pant") that never
 * existed as a Shopify product.
 */
function ItemRows({ items, products, onChange }) {
  const setItem = (idx, patch) => onChange(items.map((it, i) => (i === idx ? { ...it, ...patch } : it)))
  const add = () => onChange([...items, blankItem()])
  const remove = (idx) => onChange(items.length === 1 ? [blankItem()] : items.filter((_, i) => i !== idx))

  const pickProduct = (idx, title) => {
    const product = products.find(p => p.title === title)
    if (!product) { setItem(idx, { product: title, variant: '', sku: '', image: null, shopify_product_id: null, shopify_variant_id: null }); return }
    // A single-variant product has nothing to choose, so resolve it in one step.
    const only = product.variants.length === 1 ? product.variants[0] : null
    setItem(idx, {
      product: product.title,
      shopify_product_id: product.id,
      image: only?.image || product.image || null,
      variant: only?.title || '',
      sku: only?.sku || '',
      shopify_variant_id: only?.id || null,
    })
  }

  const pickVariant = (idx, title) => {
    const item = items[idx]
    const product = products.find(p => p.id === item.shopify_product_id)
    const variant = product?.variants.find(v => v.title === title)
    setItem(idx, {
      variant: title,
      sku: variant?.sku || '',
      shopify_variant_id: variant?.id || null,
      image: variant?.image || item.image,
    })
  }

  return (
    <div className="mk-items">
      {items.map((it, idx) => {
        const product = products.find(p => p.id === it.shopify_product_id)
        const variants = product?.variants || []
        return (
          <div className="mk-item-row" key={idx}>
            <div className="mk-item-thumb">
              {it.image ? <img src={it.image} alt="" /> : <span>—</span>}
            </div>
            <div className="input-group" style={{ flex: 2, marginBottom: 0 }}>
              <label>Item *</label>
              <ComboInput value={it.product} onChange={v => pickProduct(idx, v)}
                options={products.map(p => p.title)} placeholder="Pick a product, or type a one-off item" />
            </div>
            <div className="input-group" style={{ flex: 1.2, marginBottom: 0 }}>
              <label>Variant</label>
              {variants.length > 1 ? (
                <select value={it.variant} onChange={e => pickVariant(idx, e.target.value)}>
                  <option value="">Choose…</option>
                  {variants.map(v => (
                    <option key={v.id} value={v.title}>
                      {v.title}{v.available !== null && v.available <= 0 ? ' (out of stock)' : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <input value={it.variant} onChange={e => setItem(idx, { variant: e.target.value })} placeholder="e.g. Black / S" />
              )}
            </div>
            <div className="input-group" style={{ width: 88, flex: 'none', marginBottom: 0 }}>
              <label>Qty *</label>
              <input type="number" min="1" value={it.qty} onChange={e => setItem(idx, { qty: e.target.value })} />
            </div>
            <button type="button" className="btn-icon" onClick={() => remove(idx)} title="Remove item" style={{ color: 'var(--danger)' }}>
              <Icon name="trash" size={15} />
            </button>
          </div>
        )
      })}
      <button type="button" className="mini-btn" onClick={add}><Icon name="plus" size={12} /> Add item</button>
    </div>
  )
}

/* ─────────────────────────────── order drawer ─────────────────────────────── */

function OrderDrawer({ target, meta, influencers, products, productsError, onClose, onSaved, apiFetch, toast, canDispatch }) {
  // "Send products" on an influencer row opens this prefilled but unsaved, so a missing id — not
  // the literal 'new' — is what actually distinguishes a draft from a stored order.
  const isNew = target === 'new' || !target?.id
  const [form, setForm] = useState(() => (target === 'new' ? blankOrder() : {
    ...blankOrder(), ...target,
    influencer_id: target.influencer_id || '',
    items: (target.items || []).length ? target.items : [blankItem()],
  }))
  // The production half is saved by its own endpoint, so it gets its own state and button.
  const [dispatch, setDispatch] = useState(() => ({
    status: target?.status || 'Requested',
    fulfilled_date: target?.fulfilled_date || '',
    shopify_order_number: target?.shopify_order_number || '',
    shipping_partner: target?.shipping_partner || '',
    awb: target?.awb || '',
    tracking_link: target?.tracking_link || '',
  }))
  const [saving, setSaving] = useState(false)
  const [dispatching, setDispatching] = useState(false)
  const [error, setError] = useState('')
  const setF = (patch) => setForm(f => ({ ...f, ...patch }))
  const setD = (patch) => setDispatch(d => ({ ...d, ...patch }))

  const guard = useDirtyGuard({
    snapshot: form, identity: isNew ? 'new' : target.id,
    onDiscard: onClose, confirm: toast.confirm,
    title: 'Discard this order?',
    message: 'The details you have filled in will be lost.',
  })

  // Picking a creator fills the address block from their record — that is the whole reason the
  // roster carries shipping details.
  const pickInfluencer = (id) => {
    const inf = influencers.find(i => String(i.id) === String(id))
    if (!inf) { setF({ influencer_id: '' }); return }
    setF({
      influencer_id: inf.id,
      name: inf.name,
      email: inf.email || '',
      contact_number: inf.contact_number || '',
      address: inf.address || '',
      collab_type: inf.collab_type || 'Barter',
    })
  }

  const save = async (e) => {
    e.preventDefault()
    setSaving(true); setError('')
    const path = isNew ? '/api/marketing/orders' : `/api/marketing/orders/${target.id}`
    const res = await apiFetch(path, { method: isNew ? 'POST' : 'PUT', body: JSON.stringify(form) })
    setSaving(false)
    if (!res || res.error) { setError(res?.error || 'Failed to save'); return }
    guard.reset()
    toast.success(`${res.order.ref} saved`, { title: 'Influencer order' })
    onSaved(res.order, isNew)
  }

  const saveDispatch = async () => {
    setDispatching(true); setError('')
    const res = await apiFetch(`/api/marketing/orders/${target.id}/dispatch`, { method: 'POST', body: JSON.stringify(dispatch) })
    setDispatching(false)
    if (!res || res.error) { setError(res?.error || 'Failed to update dispatch'); return }
    setDispatch(d => ({ ...d, status: res.order.status, fulfilled_date: res.order.fulfilled_date || '', tracking_link: res.order.tracking_link || '' }))

    // Say what it did to blank stock. A silent deduction is the kind of thing people only notice
    // when the count is already wrong, and an item that resolved to no blank is worth naming.
    const stock = res.inventory || {}
    const moved = (stock.deducted || []).map(d => `${d.blank_type} ${d.color} ${d.size} −${d.qty}`).join(' · ')
    toast.success(
      `${res.order.ref} · ${res.order.status}${moved ? ` — ${moved} from blanks` : stock.released ? ' — blanks put back' : ''}`,
      { title: 'Dispatch updated' })
    if (stock.unmapped?.length) {
      toast.error(`${stock.unmapped.map(u => u.product).join(', ')} — no blank is linked, so nothing was deducted for it`)
    }
    onSaved(res.order, false, true)
  }

  const noAwbNeeded = (meta?.noAwbPartners || ['Offline']).includes(dispatch.shipping_partner)

  return (
    <div className="drawer-overlay" onClick={guard.requestClose}>
      <div className="drawer drawer-wide" onClick={e => e.stopPropagation()}>
        <div className="drawer-header">
          <h2>{isNew ? 'New influencer order' : `${target.ref} · ${target.name}`}</h2>
          <button type="button" className="btn-icon" onClick={guard.requestClose}><Icon name="close" size={16} /></button>
        </div>

        <div className="drawer-body">
          {error && <div className="scan-error-msg" style={{ marginBottom: 14 }}>{error}</div>}

          <form id="mk-order-form" onSubmit={save}>
            <div className="form-section" style={{ marginTop: 0 }}>Marketing</div>
            <div className="form-row">
              <div className="input-group" style={{ flex: 2 }}><label>Influencer</label>
                <select value={form.influencer_id || ''} onChange={e => pickInfluencer(e.target.value)}>
                  <option value="">— Not on the roster —</option>
                  {influencers.map(i => <option key={i.id} value={i.id}>{i.name}{i.location ? ` · ${i.location}` : ''}</option>)}
                </select></div>
              <div className="input-group"><label>Collab</label>
                <select value={form.collab_type || 'Barter'} onChange={e => setF({ collab_type: e.target.value })}>
                  {(meta?.collabTypes || ['Barter']).map(c => <option key={c}>{c}</option>)}
                </select></div>
              <div className="input-group"><label>Date *</label>
                <input type="date" required value={form.order_date} onChange={e => setF({ order_date: e.target.value })} /></div>
            </div>

            <div className="form-row">
              <div className="input-group"><label>Name *</label>
                <input required value={form.name} onChange={e => setF({ name: e.target.value })} /></div>
              <div className="input-group"><label>Email</label>
                <input type="email" value={form.email || ''} onChange={e => setF({ email: e.target.value })} /></div>
              <div className="input-group"><label>Contact number</label>
                <input {...mobileInputProps} value={form.contact_number || ''} onChange={e => setF({ contact_number: cleanMobile(e.target.value) })} />
                {mobileError(form.contact_number) && <div className="field-error">{mobileError(form.contact_number)}</div>}</div>
            </div>

            <div className="input-group"><label>Address</label>
              <AutoTextarea value={form.address || ''} onChange={e => setF({ address: e.target.value })} placeholder="Full postal address with pincode" /></div>

            <div className="form-section">
              Items to be sent
              <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>{orderQty(form.items)} unit{orderQty(form.items) === 1 ? '' : 's'}</span>
            </div>
            {productsError && <div className="calc-warning" style={{ marginBottom: 10 }}>{productsError}</div>}
            <ItemRows items={form.items} products={products} onChange={items => setF({ items })} />

            <div className="input-group" style={{ marginTop: 14 }}><label>Notes</label>
              <AutoTextarea value={form.notes || ''} onChange={e => setF({ notes: e.target.value })} placeholder="Anything production should know" /></div>
          </form>

          {/* Production & dispatch — the right-hand half of the sheet. Only exists once the order
              has been created, and is read-only for anyone without the dispatch permission. */}
          {!isNew && (
            <>
              <div className="form-section">
                Production &amp; dispatch
                <span className={`status-badge ${STATUS_CLASS[dispatch.status] || 'pending'}`}>{dispatch.status}</span>
              </div>
              {!canDispatch && (
                <p className="img-upload-hint" style={{ marginTop: -6, marginBottom: 12 }}>
                  Read-only — the production team fills this in.
                </p>
              )}
              <div className="form-row">
                <div className="input-group"><label>Status</label>
                  <select value={dispatch.status} disabled={!canDispatch} onChange={e => setD({ status: e.target.value })}>
                    {(meta?.statuses || []).map(s => <option key={s}>{s}</option>)}
                  </select></div>
                <div className="input-group"><label>Fulfilled date</label>
                  <input type="date" disabled={!canDispatch} value={dispatch.fulfilled_date || ''} onChange={e => setD({ fulfilled_date: e.target.value })} /></div>
                <div className="input-group"><label>Shopify order no.</label>
                  <input disabled={!canDispatch} value={dispatch.shopify_order_number || ''} onChange={e => setD({ shopify_order_number: e.target.value })} placeholder="e.g. #7677 — leave blank if not on Shopify" /></div>
              </div>
              <div className="form-row">
                <div className="input-group"><label>Shipping partner</label>
                  <select value={dispatch.shipping_partner || ''} disabled={!canDispatch} onChange={e => setD({ shipping_partner: e.target.value })}>
                    <option value="">— Choose —</option>
                    {(meta?.shippingPartners || []).map(p => <option key={p}>{p}</option>)}
                  </select></div>
                <div className="input-group"><label>AWB {noAwbNeeded ? '' : '(marks it dispatched)'}</label>
                  <input disabled={!canDispatch} value={dispatch.awb || ''} onChange={e => setD({ awb: e.target.value })}
                    placeholder={noAwbNeeded ? 'Not needed — collected in person' : 'e.g. 44544810050326'} /></div>
                <div className="input-group" style={{ flex: 1.5 }}><label>Tracking link</label>
                  <input disabled={!canDispatch} value={dispatch.tracking_link || ''} onChange={e => setD({ tracking_link: e.target.value })}
                    placeholder="Filled in automatically for Delhivery" />
                  {dispatch.tracking_link && (
                    <a className="track-link" href={dispatch.tracking_link} target="_blank" rel="noreferrer">🔗 Open tracking</a>
                  )}</div>
              </div>
              {canDispatch && (
                <button type="button" className="btn btn-secondary" onClick={saveDispatch} disabled={dispatching}>
                  {dispatching ? 'Saving…' : 'Save dispatch details'}
                </button>
              )}
            </>
          )}
        </div>

        <div className="drawer-footer">
          <button type="button" className="btn btn-secondary" onClick={guard.requestClose}>Cancel</button>
          <button type="submit" form="mk-order-form" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : isNew ? 'Create order' : 'Save order'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ──────────────────────────────── page ──────────────────────────────── */

export default function Marketing() {
  const apiFetch = useApi()
  const { user } = useAuth()
  const toast = useToast()
  const [tab, setTab] = useState('orders')
  const [meta, setMeta] = useState(null)
  const [influencers, setInfluencers] = useState([])
  // The order form's picker needs every creator, not the page being browsed, so it keeps its own
  // unpaginated copy. 200 is the server's ceiling — well past the size of the roster.
  const [allInfluencers, setAllInfluencers] = useState([])
  const [orders, setOrders] = useState([])
  // ref → RTO shelf lines that could fill it, from the list response.
  const [rto, setRto] = useState({})
  const [summary, setSummary] = useState(null)
  const [products, setProducts] = useState([])
  const [productsError, setProductsError] = useState('')
  const [loading, setLoading] = useState(true)
  const [influencerTarget, setInfluencerTarget] = useState(null)
  const [orderTarget, setOrderTarget] = useState(null)
  const [term, setTerm] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [collab, setCollab] = useState('')

  const isAdmin = user?.role === 'owner' || user?.role === 'admin'
  const canDispatch = isAdmin || !!user?.can_dispatch_marketing
  const canApprove = isAdmin || !!user?.can_approve_marketing
  // Sorting and paging are done by the server, so a column header changes the query rather than
  // reordering the 25 rows already on screen.
  const infTable = useServerTable({ sort: 'name', dir: 'asc' })
  const ordTable = useServerTable({ sort: 'order_date', dir: 'desc' })

  const loadInfluencers = async (q = search, c = collab) => {
    const r = await apiFetch('/api/marketing/influencers?' + infTable.query({ search: q, collab_type: c }))
    if (r && !r.error) { setInfluencers(r.influencers || []); infTable.setPagination(r.pagination) }
  }
  const loadOrders = async (q = search, s = status) => {
    const r = await apiFetch('/api/marketing/orders?' + ordTable.query({ search: q, status: s }))
    if (r && !r.error) { setOrders(r.orders || []); setRto(r.rto || {}); setSummary(r.summary || null); ordTable.setPagination(r.pagination) }
  }
  const loadPicker = async () => {
    const r = await apiFetch('/api/marketing/influencers?limit=200&sort=name&dir=asc')
    if (r && !r.error) setAllInfluencers(r.influencers || [])
  }

  useEffect(() => {
    (async () => {
      const m = await apiFetch('/api/marketing/meta')
      if (m && !m.error) setMeta(m)
      await Promise.all([loadInfluencers(), loadOrders(), loadPicker()])
      setLoading(false)
    })()
    // The catalogue is a Shopify round trip, so it's fetched once and shared by every order form.
    apiFetch('/api/marketing/products').then(r => {
      if (!r) return
      setProducts(r.products || [])
      if (r.error) setProductsError(r.error)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (!loading) loadOrders() }, [ordTable.key])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (!loading) loadInfluencers() }, [infTable.key])

  // Debounced so the list doesn't refetch on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(term)
      // A new filter invalidates the current page number.
      if (tab === 'orders') { ordTable.resetPage(); loadOrders(term, status) }
      else { infTable.resetPage(); loadInfluencers(term, collab) }
    }, 350)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term])

  const applyStatus = (s) => { setStatus(s); ordTable.resetPage(); loadOrders(search, s) }
  const applyCollab = (c) => { setCollab(c); infTable.resetPage(); loadInfluencers(search, c) }

  const onInfluencerSaved = (saved) => {
    setInfluencers(list => (list.some(i => i.id === saved.id)
      ? list.map(i => (i.id === saved.id ? { ...i, ...saved } : i))
      : [...list, saved].sort((a, b) => a.name.localeCompare(b.name))))
    setInfluencerTarget(null)
    loadPicker()
  }
  const onOrderSaved = (saved, isNew, keepOpen) => {
    setOrders(list => (isNew ? [saved, ...list] : list.map(o => (o.id === saved.id ? saved : o))))
    if (!keepOpen) setOrderTarget(null)
    else setOrderTarget(saved)
    loadOrders()
  }

  /** Release an order for dispatch, or send it back for another look. */
  const setApproval = async (o, approve) => {
    if (!await toast.confirm({
      title: approve ? `Approve ${o.ref}?` : `Send ${o.ref} back?`,
      message: approve
        ? 'It moves to Dispatch Pending and production can ship it. Your name is recorded against the approval.'
        : 'It returns to Pending Approval and cannot be dispatched until it is approved again.',
      details: [
        { label: 'Influencer', value: o.name },
        { label: 'Items', value: `${o.total_qty} unit${o.total_qty === 1 ? '' : 's'}` },
        { label: 'Collab', value: o.collab_type },
      ],
      confirmLabel: approve ? 'Approve' : 'Send back', danger: !approve,
    })) return
    const res = await apiFetch(`/api/marketing/orders/${o.id}/${approve ? 'approve' : 'unapprove'}`, { method: 'POST' })
    if (!res || res.error) { toast.error(res?.error || 'Failed'); return }
    toast.success(approve ? `${o.ref} approved — ready for dispatch` : `${o.ref} sent back for approval`)
    loadOrders()
  }

  /** Open the influencer behind an order, straight from the list. */
  const openInfluencer = async (o) => {
    if (!o.influencer_id) { toast.info('This order was raised without a linked influencer'); return }
    const known = allInfluencers.find(i => String(i.id) === String(o.influencer_id))
      || influencers.find(i => String(i.id) === String(o.influencer_id))
    if (known) { setInfluencerTarget(known); return }
    // The roster list is paged and filtered, so the one we want may not be loaded — fetch it.
    const r = await apiFetch(`/api/marketing/influencers/${o.influencer_id}`)
    if (r && !r.error && r.influencer) setInfluencerTarget(r.influencer)
    else toast.error('That influencer could not be found — they may have been removed')
  }

  const del = async (kind, row) => {
    const label = kind === 'orders' ? row.ref : row.name
    if (!await toast.confirm({
      title: `Delete ${label}?`, message: 'This cannot be undone.',
      confirmLabel: 'Delete', cancelLabel: 'Keep', danger: true,
    })) return
    const r = await apiFetch(`/api/marketing/${kind}/${row.id}`, { method: 'DELETE' })
    if (!r || r.error) { toast.error(r?.error || 'Failed to delete'); return }
    if (kind === 'orders') setOrders(l => l.filter(o => o.id !== row.id))
    else setInfluencers(l => l.filter(i => i.id !== row.id))
    toast.success(`${label} deleted`)
  }

  const sortedOrders = orders
  const sortedInfluencers = influencers
  const orderSort = ordTable.sort, toggleOrder = ordTable.toggle
  const infSort = infTable.sort, toggleInf = infTable.toggle

  // Counted off the full roster, not the page in view.
  const activeCount = useMemo(() => allInfluencers.filter(i => i.active).length, [allInfluencers])

  return (
    <div className="page-enter">
      <div className="dash-toolbar">
        <div>
          <h1>Marketing</h1>
          <p style={{ color: 'var(--text-muted)' }}>Influencer collabs and the product seeding behind them</p>
        </div>
        <button className="btn btn-primary" onClick={() => (tab === 'orders' ? setOrderTarget('new') : setInfluencerTarget('new'))}>
          <Icon name="plus" size={15} /> {tab === 'orders' ? 'New order' : 'New influencer'}
        </button>
      </div>

      <div className="scan-tabs" style={{ marginBottom: 16 }}>
        <button className={tab === 'orders' ? 'active' : ''} onClick={() => setTab('orders')}>📦 Orders</button>
        <button className={tab === 'influencers' ? 'active' : ''} onClick={() => setTab('influencers')}>⭐ Influencers</button>
      </div>

      <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <div className="kpi-card">
          <div className="kpi-head"><div className="kpi-icon">⭐</div></div>
          <div className="kpi-value">{activeCount}</div><div className="kpi-label">Active influencers</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-head"><div className="kpi-icon">📦</div></div>
          <div className="kpi-value">{summary?.awaitingDispatch ?? 0}</div><div className="kpi-label">Awaiting dispatch</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-head"><div className="kpi-icon">🚚</div></div>
          <div className="kpi-value">{summary?.inTransit ?? 0}</div><div className="kpi-label">In transit</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-head"><div className="kpi-icon">👕</div></div>
          <div className="kpi-value">{summary?.unitsSent ?? 0}</div><div className="kpi-label">Units seeded</div>
        </div>
      </div>

      <div className="filters-row filters-row-search">
        <div className="search-bar"><span className="search-icon" />
          <input placeholder={tab === 'orders' ? 'Search name, item, AWB or order number…' : 'Search name, profile, location…'}
            value={term} onChange={e => setTerm(e.target.value)} /></div>
      </div>
      <div className="filters-row">
        {tab === 'orders' ? (
          <select value={status} onChange={e => applyStatus(e.target.value)} style={{ width: 'auto' }}>
            <option value="">All statuses</option>
            {(meta?.statuses || []).map(s => <option key={s}>{s}</option>)}
          </select>
        ) : (
          <select value={collab} onChange={e => applyCollab(e.target.value)} style={{ width: 'auto' }}>
            <option value="">All collab types</option>
            {(meta?.collabTypes || []).map(c => <option key={c}>{c}</option>)}
          </select>
        )}
      </div>

      <div className="data-table-wrapper">
        {loading ? <div className="loader"><div className="spinner" /></div> : tab === 'orders' ? (
          sortedOrders.length === 0 ? (
            <div className="empty-state"><div className="empty-icon">📦</div><p>No influencer orders yet.</p></div>
          ) : (
            <>
            <table className="data-table">
              <thead><tr>
                <SortTh label="Ref" col="ref_no" sort={orderSort} onSort={toggleOrder} />
                <SortTh label="Influencer" col="name" sort={orderSort} onSort={toggleOrder} />
                <SortTh label="Items" col="items" sort={orderSort} onSort={toggleOrder} />
                <SortTh label="Qty" col="total_qty" sort={orderSort} onSort={toggleOrder} align="center" />
                <SortTh label="Date" col="order_date" sort={orderSort} onSort={toggleOrder} />
                <SortTh label="Status" col="status" sort={orderSort} onSort={toggleOrder} />
                <SortTh label="Dispatch" col="awb" sort={orderSort} onSort={toggleOrder} />
                <SortTh label="" />
              </tr></thead>
              <tbody>
                {sortedOrders.map(o => (
                  <tr key={o.id} onClick={() => setOrderTarget(o)} style={{ cursor: 'pointer' }}>
                    <td className="cell-primary">
                      <span className="badge-primary">{o.ref}</span>
                      {/* Already printed and sitting on the shelf — send that one instead. */}
                      {!!rto[o.ref] && (
                        <span className="rto-tag" title={rto[o.ref].map(l => `${l.product_title} ${l.variant} — ${l.available} on the RTO shelf`).join('\n')}>
                          ↩ RTO
                        </span>
                      )}
                    </td>
                    <td>
                      {/* The order carries a snapshot of the creator's details, so reaching the
                          live profile from here saves a trip through the roster tab. */}
                      <button type="button" className="link-name" onClick={e => { e.stopPropagation(); openInfluencer(o) }}
                        title={o.influencer_id ? 'Open this influencer' : 'No influencer linked to this order'}>
                        {o.name}
                      </button>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 2 }}>
                        {o.collab_type && <span className={COLLAB_CLASS[o.collab_type] || 'badge-secondary'} style={{ fontSize: 10.5 }}>{o.collab_type}</span>}
                        {o.profile_url && (
                          <a className="track-link" href={o.profile_url} target="_blank" rel="noreferrer"
                            onClick={e => e.stopPropagation()} title="Open their social profile">↗ Profile</a>
                        )}
                      </div>
                    </td>
                    <td data-label="Items" style={{ fontSize: 12.5 }}>
                      {summarise(o.items).map((s, i) => <div key={i}>{s}</div>)}
                    </td>
                    <td data-label="Qty" style={{ textAlign: 'center', fontWeight: 700 }}>{o.total_qty}</td>
                    <td data-label="Date" style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{day(o.order_date)}</td>
                    <td data-label="Status">
                      <span className={`status-badge ${STATUS_CLASS[o.status] || 'pending'}`}>{o.status}</span>
                      {o.status === 'Pending Approval' && canApprove && (
                        <button className="mini-btn approve-btn" onClick={e => { e.stopPropagation(); setApproval(o, true) }}>✓ Approve</button>
                      )}
                      {o.status === 'Dispatch Pending' && canApprove && (
                        <button className="mini-btn" style={{ marginTop: 5 }} onClick={e => { e.stopPropagation(); setApproval(o, false) }}>↩ Send back</button>
                      )}
                      {o.approved_by && o.status !== 'Pending Approval' && (
                        <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3 }}>by {o.approved_by}</div>
                      )}
                    </td>
                    <td data-label="Dispatch" style={{ fontSize: 12 }}>
                      {o.shipping_partner ? <div>{o.shipping_partner}</div> : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                      {o.awb && (o.tracking_link
                        ? <a className="track-link" href={o.tracking_link} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>{o.awb}</a>
                        : <div style={{ color: 'var(--text-muted)' }}>{o.awb}</div>)}
                      {o.shopify_order_number && <div style={{ color: 'var(--text-muted)' }}>{o.shopify_order_number}</div>}
                    </td>
                    <td className="cell-actions" onClick={e => e.stopPropagation()}>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button className="btn-icon" title="Open" onClick={() => setOrderTarget(o)}><Icon name="edit" size={14} /></button>
                        {isAdmin && <button className="btn-icon" title="Delete" onClick={() => del('orders', o)} style={{ color: 'var(--danger)' }}><Icon name="trash" size={14} /></button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination table={ordTable} noun="orders" />
            </>
          )
        ) : (
          sortedInfluencers.length === 0 ? (
            <div className="empty-state"><div className="empty-icon">⭐</div><p>No influencers yet.</p></div>
          ) : (
            <>
            <table className="data-table">
              <thead><tr>
                <SortTh label="Name" col="name" sort={infSort} onSort={toggleInf} />
                <SortTh label="Type" col="content_type" sort={infSort} onSort={toggleInf} />
                <SortTh label="Profile" col="profile_url" sort={infSort} onSort={toggleInf} />
                <SortTh label="Collab" col="collab_type" sort={infSort} onSort={toggleInf} />
                <SortTh label="Location" col="location" sort={infSort} onSort={toggleInf} />
                <SortTh label="Content" col="total_content" sort={infSort} onSort={toggleInf} align="center" />
                <SortTh label="Per video" col="payment_per_video" sort={infSort} onSort={toggleInf} />
                <SortTh label="Orders" col="order_count" sort={infSort} onSort={toggleInf} align="center" />
                <SortTh label="" />
              </tr></thead>
              <tbody>
                {sortedInfluencers.map(i => (
                  <tr key={i.id} onClick={() => setInfluencerTarget(i)} style={{ cursor: 'pointer', opacity: i.active ? 1 : 0.55 }}>
                    <td className="cell-primary">
                      <div style={{ fontWeight: 600 }}>{i.name}</div>
                      {!i.active && <span className="badge-secondary" style={{ fontSize: 10 }}>Inactive</span>}
                    </td>
                    <td data-label="Type" style={{ fontSize: 12.5 }}>{i.content_type || '—'}</td>
                    <td data-label="Profile" style={{ fontSize: 12.5 }}>
                      {i.profile_url
                        ? <a className="track-link" href={i.profile_url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>{i.handle || 'Profile'}</a>
                        : '—'}
                    </td>
                    <td data-label="Collab"><span className={COLLAB_CLASS[i.collab_type] || 'badge-secondary'}>{i.collab_type}</span></td>
                    <td data-label="Location" style={{ fontSize: 12.5 }}>{i.location || '—'}</td>
                    <td data-label="Content" style={{ textAlign: 'center' }}>{i.total_content || 0}</td>
                    <td data-label="Per video" style={{ fontSize: 12.5 }}>{i.payment_per_video || 'N/A'}</td>
                    <td data-label="Orders" style={{ textAlign: 'center' }}>{i.order_count || 0}</td>
                    <td className="cell-actions" onClick={e => e.stopPropagation()}>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button className="btn-icon" title="Send products" onClick={() => setOrderTarget({ ...blankOrder(), influencer_id: i.id, name: i.name, email: i.email || '', contact_number: i.contact_number || '', address: i.address || '', collab_type: i.collab_type, __new: true })}>
                          <Icon name="truck" size={14} />
                        </button>
                        <button className="btn-icon" title="Edit" onClick={() => setInfluencerTarget(i)}><Icon name="edit" size={14} /></button>
                        {isAdmin && <button className="btn-icon" title="Delete" onClick={() => del('influencers', i)} style={{ color: 'var(--danger)' }}><Icon name="trash" size={14} /></button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination table={infTable} noun="influencers" />
            </>
          )
        )}
      </div>

      {influencerTarget && (
        <InfluencerDrawer target={influencerTarget} meta={meta} apiFetch={apiFetch} toast={toast}
          onClose={() => setInfluencerTarget(null)} onSaved={onInfluencerSaved} />
      )}
      {orderTarget && (
        <OrderDrawer
          key={orderTarget === 'new' ? 'new' : (orderTarget.id ?? 'prefilled')}
          target={orderTarget} meta={meta} influencers={allInfluencers} products={products}
          productsError={productsError} canDispatch={canDispatch} apiFetch={apiFetch} toast={toast}
          onClose={() => setOrderTarget(null)} onSaved={onOrderSaved} />
      )}
    </div>
  )
}
