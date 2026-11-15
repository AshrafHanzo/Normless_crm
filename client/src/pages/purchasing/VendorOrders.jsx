import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApi, useAuth } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import ComboInput from '../../components/ComboInput'
import AutoTextarea from '../../components/AutoTextarea'
import useDirtyGuard from '../../hooks/useDirtyGuard'
import useErrorInView from './useErrorInView'
import useServerTable from '../../hooks/useServerTable'
import SortTh from '../../components/SortTh'
import Pagination from '../../components/Pagination'
import VendorOrderAnalytics from './VendorOrderAnalytics'
import RecordPaymentDrawer from './RecordPaymentDrawer'
import PaymentPlan from './PaymentPlan'
import RecordDeliveryDrawer from './RecordDeliveryDrawer'
import VendorImportDrawer from './VendorImportDrawer'
import { BRAND_LABEL, PAY_CLASS, inr, day, openFile, waNote } from './format'
import { cleanMobile, mobileError, isValidMobile, mobileInputProps } from '../../utils/phone'

const pad = (n) => String(n).padStart(2, '0')
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }

const STATUSES = ['Pending', 'Consignment Ordered', 'Partly Received', 'Consignment Received']
const STATUS_CLASS = { Pending: 'pending', 'Consignment Ordered': 'refunded', 'Partly Received': 'partial', 'Consignment Received': 'fulfilled' }
const MANUAL_PAY_CLASS = { 'Not Paid': 'pending', Paid: 'fulfilled' }
const BRANDS = ['normless', 'crewfit']

const blankColor = () => ({ color: '', sizes: {} })
const blankApparel = () => ({ product_type: '', gsm: '', rate: '', colors: [blankColor()] })
const blankSimple = () => ({ kind: 'simple', product_type: '', qty: '', rate: '' })
// Crewfit orders garments by size; Normless buys all sorts, so it starts on a plain quantity.
const blankItem = (brand) => (brand === 'crewfit' ? blankApparel() : blankSimple())
const blankOrder = (brand) => ({
  brand, order_date: todayStr(), delivery_date: '', vendor: '', vendor_phone: '', title: '', quote_ref: '',
  total_override: '', items: [blankItem(brand)], notes: '', status: 'Pending', payment_status: 'Not Paid',
})

const isSimple = (i) => i.kind === 'simple'
const colorQty = (c) => Object.values(c.sizes || {}).reduce((s, q) => s + (parseInt(q, 10) || 0), 0)
const itemQty = (i) => (isSimple(i) ? (parseInt(i.qty, 10) || 0) : (i.colors || []).reduce((s, c) => s + colorQty(c), 0))
const orderQty = (items) => (items || []).reduce((s, i) => s + itemQty(i), 0)
const orderAmount = (items) => (items || []).reduce((s, i) => s + (Number(i.rate) > 0 ? Number(i.rate) * itemQty(i) : 0), 0)

/** "Poly Cotton Polos · Navy, Black" / "Mask · 300" — enough to recognise the order without opening it. */
function summarise(items) {
  return (items || []).map(i => {
    if (isSimple(i)) return [i.product_type, i.qty ? `${i.qty} pcs` : null].filter(Boolean).join(' · ')
    const colors = (i.colors || []).map(c => c.color).filter(Boolean).join(', ')
    return [i.product_type, colors].filter(Boolean).join(' · ')
  }).filter(Boolean)
}

/* ────────────────────────────── drawer ────────────────────────────── */

function VendorOrderDrawer({ target, defaultBrand, meta, onClose, onSaved, onPay, onDeliver, onChanged, apiFetch, toast }) {
  // A new order, possibly raised from a quotation (`target.prefill`).
  const isNew = target === 'new' || !!target?.isNew
  const [form, setForm] = useState(() => (isNew ? { ...blankOrder(target?.prefill?.brand || defaultBrand), ...(target?.prefill || {}) } : {
    ...target,
    delivery_date: target.delivery_date || '',
    vendor_phone: target.vendor_phone || '',
    title: target.title || '',
    quote_ref: target.quote_ref || '',
    total_override: target.total_override ?? '',
    notes: target.notes || '',
    status: target.status || 'Pending',
    payment_status: target.payment_status || 'Not Paid',
    items: (target.items || []).length
      ? target.items.map(i => (isSimple(i) ? { ...i, qty: i.qty ?? '', rate: i.rate ?? '' } : { ...i, rate: i.rate ?? '' }))
      : [blankItem(target.brand)],
  }))
  const [payments, setPayments] = useState([])
  // The order as saved — the plan is worked out from its saved total, not the form's.
  const [saved, setSaved] = useState(null)
  const [defaultPlan, setDefaultPlan] = useState([])
  const [deliveries, setDeliveries] = useState([])
  const [quote, setQuote] = useState(target?.quote || null)
  const [progress, setProgress] = useState(null)
  // A daily-lots order (the Spark sheet has 14) would push everything below it away.
  const [allDeliveries, setAllDeliveries] = useState(false)
  const [notify, setNotify] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const errorRef = useErrorInView(error)
  const canEdit = !!meta?.can?.edit

  // An existing order shows the payments recorded against it.
  useEffect(() => {
    if (!target?.id) return
    let live = true
    apiFetch(`/api/vendor-orders/${target.id}`).then(r => {
      if (!live || !r || r.error) return
      setPayments(r.payments || []); setSaved(r.order); setDefaultPlan(r.vendor_default_plan || [])
      setDeliveries(r.deliveries || []); setProgress(r.progress || null); setQuote(r.quotation || null)
    })
    return () => { live = false }
    // apiFetch is a new function every render (see useApi), so it can't be a dependency here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.id])

  const sizes = meta?.sizes || ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL']

  const guard = useDirtyGuard({
    snapshot: form,
    identity: form.id ?? 'new',
    onDiscard: onClose,
    confirm: toast.confirm,
    title: form.id ? 'Discard your edits?' : 'Discard this vendor order?',
    message: 'This vendor order has unsaved details. Closing now will lose them.',
  })

  const set = (patch) => setForm(f => ({ ...f, ...patch }))
  const setItem = (idx, patch) => set({ items: form.items.map((it, i) => i === idx ? { ...it, ...patch } : it) })
  const setColor = (idx, cIdx, patch) => setItem(idx, {
    colors: form.items[idx].colors.map((c, i) => i === cIdx ? { ...c, ...patch } : c),
  })
  const setSize = (idx, cIdx, size, value) => {
    const next = { ...(form.items[idx].colors[cIdx].sizes || {}) }
    if (value === '' || parseInt(value, 10) <= 0) delete next[size]
    else next[size] = parseInt(value, 10)
    setColor(idx, cIdx, { sizes: next })
  }
  const setKind = (idx, simple) => {
    const cur = form.items[idx]
    if (simple === isSimple(cur)) return
    const base = simple ? blankSimple() : blankApparel()
    setItem(idx, { ...base, product_type: cur.product_type, rate: cur.rate, kind: simple ? 'simple' : undefined })
  }

  const addItem = () => set({ items: [...form.items, blankItem(form.brand)] })
  const removeItem = (idx) => set({ items: form.items.length > 1 ? form.items.filter((_, i) => i !== idx) : [blankItem(form.brand)] })
  const addColor = (idx) => setItem(idx, { colors: [...form.items[idx].colors, blankColor()] })
  const removeColor = (idx, cIdx) => {
    const colors = form.items[idx].colors.filter((_, i) => i !== cIdx)
    setItem(idx, { colors: colors.length ? colors : [blankColor()] })
  }

  // Picking a catalog product fills its GSM, but only when GSM is still blank — a hand-typed
  // value is the user overriding the catalog and must not be clobbered.
  const pickProduct = (idx, name) => {
    const match = (meta?.products || []).find(p => p.name === name)
    setItem(idx, { product_type: name, ...(match?.gsm && !form.items[idx].gsm && !isSimple(form.items[idx]) ? { gsm: String(match.gsm) } : {}) })
  }

  const save = async () => {
    if (form.vendor_phone && !isValidMobile(form.vendor_phone)) {
      toast.error('Vendor phone must be exactly 10 digits.', { title: 'Check the number' }); return
    }
    setSaving(true); setError('')
    const body = JSON.stringify({ ...form, notify_vendor: notify })
    const res = form.id
      ? await apiFetch(`/api/vendor-orders/${form.id}`, { method: 'PUT', body })
      : await apiFetch('/api/vendor-orders', { method: 'POST', body })
    setSaving(false)
    if (!res) return
    if (res.error) { setError(res.error); return }
    guard.reset()
    toast.success(`${res.order.ref} saved`)
    waNote(toast, res.whatsapp)
    onSaved(res.order)
  }

  const qty = orderQty(form.items)
  const amount = orderAmount(form.items)
  const total = Number(form.total_override) > 0 ? Number(form.total_override) : amount
  const paid = payments.reduce((s, p) => s + Number(p.amount), 0)
  // Vendors who supply this brand first; the rest still typeable.
  const vendorOptions = (meta?.vendors || [])
    .slice().sort((a, b) => Number(b.brands === form.brand || b.brands === 'both') - Number(a.brands === form.brand || a.brands === 'both'))
    .map(v => v.name)

  return (
    <div className="drawer-overlay" onClick={guard.requestClose}>
      <div className="drawer drawer-wide" onClick={e => e.stopPropagation()} role="dialog" aria-label={form.id ? `Vendor order ${form.ref}` : 'New vendor order'}>
        <div className="drawer-header">
          <div>
            <h2 style={{ fontSize: 17 }}>{form.id ? `Vendor Order ${form.ref || ''}` : 'New Vendor Order'}</h2>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
              Every dropdown accepts a typed value too — pick one or enter your own
            </div>
          </div>
          <button className="btn-icon" onClick={guard.requestClose} aria-label="Close"><Icon name="close" size={16} /></button>
        </div>

        <div className="drawer-body">
          {error && <div className="calc-warning" role="alert" ref={errorRef}>{error}</div>}
          <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div className="form-section">Order</div>
            {quote && (
              <div className="vo-quote">
                <Icon name="invoice" size={18} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{form.id ? 'Quotation' : 'From quotation'} {quote.quote_no || ''}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{[day(quote.quote_date), quote.amount != null && `${inr(quote.amount)} incl. GST`, quote.title].filter(Boolean).join(' · ')}</div>
                </div>
                {quote.has_file && <button type="button" className="mini-btn" onClick={() => openFile(apiFetch, toast, `/api/vendor-quotations/${quote.id}/file`)}>View</button>}
              </div>
            )}
            <div className="input-group" style={{ marginBottom: 0 }}>
              <label>For</label>
              <div className="chip-picker" role="radiogroup" aria-label="Brand">
                {BRANDS.map(b => (
                  <button type="button" key={b} role="radio" aria-checked={form.brand === b}
                    className={`chip ${form.brand === b ? 'chip-on' : ''}`} onClick={() => set({ brand: b })}>{BRAND_LABEL[b]}</button>
                ))}
              </div>
            </div>
            <div className="form-row">
              <div className="input-group">
                <label>Vendor *</label>
                <ComboInput
                  value={form.vendor} options={vendorOptions} placeholder="Pick or type a vendor"
                  onChange={v => {
                    const known = (meta?.vendors || []).find(x => x.name.toLowerCase() === v.trim().toLowerCase())
                    set({ vendor: v, ...(known?.phone && !form.vendor_phone ? { vendor_phone: known.phone } : {}) })
                  }} />
              </div>
              <div className="input-group">
                <label>WhatsApp number</label>
                <input {...mobileInputProps} value={form.vendor_phone}
                  onChange={e => set({ vendor_phone: cleanMobile(e.target.value) })} placeholder="For sending the order" />
                {mobileError(form.vendor_phone) && <div className="field-error">{mobileError(form.vendor_phone)}</div>}
              </div>
              <div className="input-group">
                <label>Their quotation no.<span className="unit-hint"> optional</span></label>
                <input value={form.quote_ref} onChange={e => set({ quote_ref: e.target.value })} placeholder="e.g. EDS0109136" />
              </div>
            </div>
            <div className="form-row">
              <div className="input-group">
                <label>Order date *</label>
                <input type="date" value={form.order_date} onChange={e => set({ order_date: e.target.value })} />
              </div>
              <div className="input-group">
                <label>Delivery date<span className="unit-hint"> optional</span></label>
                <input type="date" value={form.delivery_date} min={form.order_date}
                  onChange={e => set({ delivery_date: e.target.value })} />
              </div>
              <div className="input-group">
                <label>Status</label>
                <select value={form.status} onChange={e => set({ status: e.target.value })}>
                  {(meta?.statuses || STATUSES).map(s => <option key={s}>{s}</option>)}
                </select>
              </div>
            </div>
            <div className="input-group" style={{ marginBottom: 0 }}>
              <label>Title<span className="unit-hint"> optional — a name to find it by</span></label>
              <input value={form.title} onChange={e => set({ title: e.target.value })} placeholder="e.g. Masks + disk sets for the Dec drop" />
            </div>

            <div className="form-section">
              Products <span className="section-count">{form.items.length} {form.items.length === 1 ? 'product' : 'products'}</span>
              <button type="button" className="mini-btn" onClick={addItem}>+ Add product</button>
            </div>

            {form.items.map((item, idx) => (
              <div key={idx} className="line-item-card">
                <div className="line-item-header">
                  <span>Product {idx + 1}{itemQty(item) > 0 ? ` · ${itemQty(item)} pcs` : ''}</span>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <div className="chip-picker" role="radiogroup" aria-label={`Product ${idx + 1} kind`}>
                      <button type="button" role="radio" aria-checked={isSimple(item)} className={`mini-btn ${isSimple(item) ? 'mini-btn-active' : ''}`} onClick={() => setKind(idx, true)}>Quantity</button>
                      <button type="button" role="radio" aria-checked={!isSimple(item)} className={`mini-btn ${!isSimple(item) ? 'mini-btn-active' : ''}`} onClick={() => setKind(idx, false)}>Sizes</button>
                    </div>
                    {form.items.length > 1 && <button type="button" className="btn-icon" aria-label={`Remove product ${idx + 1}`} onClick={() => removeItem(idx)}>✕</button>}
                  </div>
                </div>
                {isSimple(item) ? (
                  <div className="form-row">
                    <div className="input-group">
                      <label>Product *</label>
                      <ComboInput value={item.product_type} options={(meta?.products || []).map(p => p.name)}
                        placeholder="e.g. Mask" onChange={v => pickProduct(idx, v)} />
                    </div>
                    <div className="input-group">
                      <label>Quantity *</label>
                      <input type="number" min="1" value={item.qty} onChange={e => setItem(idx, { qty: e.target.value })} />
                    </div>
                    <div className="input-group">
                      <label>Rate per piece (₹)<span className="unit-hint"> optional</span></label>
                      <input type="number" step="any" min="0" value={item.rate ?? ''} onChange={e => setItem(idx, { rate: e.target.value })} />
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="form-row">
                      <div className="input-group">
                        <label>Product type *</label>
                        <ComboInput value={item.product_type} options={(meta?.products || []).map(p => p.name)}
                          placeholder="Pick or type a style" onChange={v => pickProduct(idx, v)} />
                      </div>
                      <div className="input-group">
                        <label>GSM</label>
                        <ComboInput value={item.gsm} options={meta?.gsm || []} placeholder="e.g. 180"
                          onChange={v => setItem(idx, { gsm: v })} />
                      </div>
                      <div className="input-group">
                        <label>Rate per piece (₹)<span className="unit-hint"> optional</span></label>
                        <input type="number" step="any" min="0" value={item.rate ?? ''}
                          onChange={e => setItem(idx, { rate: e.target.value })} placeholder="Leave blank to omit prices" />
                      </div>
                    </div>
                    {item.colors.map((c, cIdx) => (
                      <div key={cIdx} className="vo-color">
                        <div className="vo-color-head">
                          <div className="input-group" style={{ marginBottom: 0, flex: 1 }}>
                            <label>Colour</label>
                            <ComboInput value={c.color} options={[]} placeholder="e.g. Navy"
                              onChange={v => setColor(idx, cIdx, { color: v })} />
                          </div>
                          <span className="vo-color-qty">{colorQty(c)} pcs</span>
                          {item.colors.length > 1 && (
                            <button type="button" className="btn-icon" aria-label="Remove colour" onClick={() => removeColor(idx, cIdx)}>✕</button>
                          )}
                        </div>
                        <div className="size-grid">
                          {sizes.map(s => (
                            <div key={s} className="size-cell">
                              <label>{s}</label>
                              <input type="number" min="0" value={c.sizes?.[s] ?? ''}
                                onChange={e => setSize(idx, cIdx, s, e.target.value)} />
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                    <button type="button" className="add-item-btn" onClick={() => addColor(idx)}>+ Add colour</button>
                  </>
                )}
              </div>
            ))}

            <button type="button" className="add-item-btn" onClick={addItem}>+ Add another product</button>

            <div className="form-section">Money</div>
            <div className="form-row">
              <div className="input-group">
                <label>Agreed total, incl. GST (₹)<span className="unit-hint"> optional</span></label>
                <input type="number" step="any" min="0" value={form.total_override}
                  onChange={e => set({ total_override: e.target.value })}
                  placeholder={amount > 0 ? `${Math.round(amount)} from the rates` : 'The quotation’s total'} />
              </div>
              {!total && (
                <div className="input-group">
                  <label>Payment</label>
                  <select value={form.payment_status} onChange={e => set({ payment_status: e.target.value })}>
                    {(meta?.manualPaymentStatuses || ['Not Paid', 'Paid']).map(s => <option key={s}>{s}</option>)}
                  </select>
                </div>
              )}
            </div>
            <p style={{ margin: '-8px 0 0', fontSize: 12.5, color: 'var(--text-muted)' }}>
              {total
                ? 'With a total, the payment status is worked out from the payments recorded against this order.'
                : 'Without a total, payment is just marked Paid or Not Paid. Enter rates or the agreed total to track part payments.'}
            </p>

            <div className="form-section">Notes</div>
            <div className="input-group">
              <AutoTextarea value={form.notes} onChange={e => set({ notes: e.target.value })}
                placeholder="Anything the vendor should know — packing, delivery date, labels…" />
            </div>
            <label className="pp-default">
              <input type="checkbox" checked={notify} onChange={e => setNotify(e.target.checked)} />
              <span><b>Tell the vendor on WhatsApp</b><em>{form.id ? 'If the quantity, value or delivery date changed, from the Normless number.' : 'The new order, from the Normless number.'} Only when vendor messages are switched on in WhatsApp → Automations.</em></span>
            </label>
          </fieldset>

          {form.id && progress && (
            <>
              <div className="form-section">
                Deliveries <span className="section-count">{deliveries.length}</span>
                {canEdit && <button type="button" className="mini-btn" onClick={() => onDeliver(form)}>+ Record delivery</button>}
              </div>
              {progress.totals.ordered > 0 && (
                <div className="dl-progress">
                  <div className="dl-prog-row dl-prog-head"><span>Line</span><span>Ordered</span><span>In</span><span>To come</span><span /></div>
                  {progress.lines.map(l => (
                    <div key={l.key} className="dl-prog-row">
                      <span>{[l.product, l.color, l.size].filter(Boolean).join(' · ')}{l.unmatched && <em style={{ color: 'var(--warning)', fontStyle: 'normal' }}> · not on the order now</em>}</span>
                      <span>{l.ordered}</span>
                      <span>{l.accepted}{l.rejected > 0 && <span style={{ color: 'var(--danger)', fontSize: 11.5 }}> ({l.rejected} rejected)</span>}</span>
                      <span style={{ fontWeight: 700, color: l.pending ? 'var(--warning)' : 'var(--success)' }}>{l.pending}</span>
                      <span className="dl-bar" aria-hidden="true"><i style={{ width: `${l.ordered ? Math.min(100, l.accepted / l.ordered * 100) : 0}%` }} /></span>
                    </div>
                  ))}
                </div>
              )}
              {deliveries.length > 0 ? (
                <div className="vo-payments">
                  {(allDeliveries ? deliveries : deliveries.slice(0, 5)).map(d => (
                    <div key={d.id} className="vo-payment" style={{ gridTemplateColumns: '1fr 2.4fr 0.8fr auto' }}>
                      <span>{day(d.received_on)}</span>
                      <span style={{ fontSize: 12.5 }}>
                        {d.lines.map(l => `${[l.color, l.size].filter(Boolean).join(' ') || l.product} × ${l.received}${l.rejected ? ` (${l.rejected} rejected)` : ''}`).join(', ')}
                        {(d.challan_no || d.note) && <div style={{ color: 'var(--text-muted)' }}>{[d.challan_no && `Challan ${d.challan_no}`, d.note].filter(Boolean).join(' · ')}</div>}
                      </span>
                      <b>{d.received_qty} pcs</b>
                      {canEdit ? (
                        <span style={{ display: 'flex', gap: 4 }}>
                          <button type="button" className="btn-icon" aria-label={`Edit delivery of ${day(d.received_on)}`} onClick={() => onDeliver(form, d.id)}><Icon name="edit" size={13} /></button>
                          <button type="button" className="btn-icon" aria-label={`Delete delivery of ${day(d.received_on)}`} style={{ color: 'var(--danger)' }} onClick={async () => {
                            if (!await toast.confirm({ title: 'Delete this delivery?', message: `${d.received_qty} pieces received on ${day(d.received_on)} go back to still to come.`, danger: true, confirmLabel: 'Delete' })) return
                            const r = await apiFetch(`/api/vendor-orders/${form.id}/deliveries/${d.id}`, { method: 'DELETE' })
                            if (r?.error) { toast.error(r.error); return }
                            const fresh = await apiFetch(`/api/vendor-orders/${form.id}`)
                            if (fresh && !fresh.error) { setDeliveries(fresh.deliveries); setProgress(fresh.progress); setSaved(fresh.order); set({ status: fresh.order.status }) }
                            onChanged?.()
                          }}><Icon name="trash" size={13} /></button>
                        </span>
                      ) : <span />}
                    </div>
                  ))}
                  {deliveries.length > 5 && (
                    <button type="button" className="mini-btn" style={{ margin: 10, alignSelf: 'center' }} onClick={() => setAllDeliveries(v => !v)}>
                      {allDeliveries ? 'Show the latest 5' : `Show all ${deliveries.length} deliveries`}
                    </button>
                  )}
                </div>
              ) : <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13 }}>Nothing received yet.</p>}
            </>
          )}

          {saved?.total > 0 && (
            <PaymentPlan order={saved} vendorName={saved.vendor} defaultPlan={defaultPlan} canEdit={!!meta?.can?.pay}
              apiFetch={apiFetch} toast={toast} onSaved={(o) => { setSaved(o); onChanged?.() }} />
          )}

          {form.id && total > 0 && (
            <>
              <div className="form-section">
                Payments <span className="section-count">{payments.length}</span>
                {meta?.can?.pay && <button type="button" className="mini-btn" onClick={() => onPay(form)}>+ Record payment</button>}
              </div>
              {payments.length ? (
                <div className="vo-payments">
                  {payments.map(p => (
                    <div key={p.id} className="vo-payment">
                      <span>{day(p.paid_on)}</span>
                      <span>{p.mode || '—'}</span>
                      <span className="vp-mono">{p.reference || (p.source === 'migrated' ? 'before payments were recorded' : <span style={{ color: 'var(--warning)' }}>No UTR</span>)}</span>
                      <b>{inr(p.amount)}</b>
                    </div>
                  ))}
                </div>
              ) : <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13 }}>Nothing paid yet.</p>}
            </>
          )}

          <div className="totals-bar">
            <div><span>Total quantity</span><strong>{qty} pcs</strong></div>
            {total > 0 && <div><span>Order total</span><strong>{inr(total)}</strong></div>}
            {form.id && total > 0 && <div><span>Balance</span><strong>{inr(total - paid)}</strong></div>}
          </div>
        </div>

        <div className="drawer-footer">
          <button className="btn btn-secondary" onClick={guard.requestClose}>{canEdit ? 'Cancel' : 'Close'}</button>
          {canEdit && (
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : (form.id ? 'Save changes' : 'Create vendor order')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/* ────────────────────────────── page ────────────────────────────── */

export default function VendorOrders() {
  const apiFetch = useApi()
  const { brand: menuBrand } = useAuth()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const brand = BRANDS.includes(params.get('brand')) ? params.get('brand') : ''
  const [orders, setOrders] = useState([])
  const [meta, setMeta] = useState(null)
  const [loading, setLoading] = useState(true)
  const [target, setTarget] = useState(null)
  const [paying, setPaying] = useState(null)
  const [delivering, setDelivering] = useState(null)
  const [importing, setImporting] = useState(false)
  const [vendor, setVendor] = useState('')
  const [status, setStatus] = useState('')
  const [payment, setPayment] = useState('')
  const [term, setTerm] = useState('')
  const [search, setSearch] = useState('')
  // Remembered per browser: someone who only raises orders can keep the figures folded away.
  const [showStats, setShowStats] = useState(() => { try { return localStorage.getItem('cf_vendor_stats') !== 'off' } catch { return true } })
  const toggleStats = () => setShowStats(v => { try { localStorage.setItem('cf_vendor_stats', v ? 'off' : 'on') } catch { /* private window */ } return !v })
  // Server-side sort + page: a header click reorders every matching order, not this page's 25.
  const t = useServerTable({ sort: 'order_date', dir: 'desc' })

  const load = async () => {
    const r = await apiFetch('/api/vendor-orders?' + t.query({ brand, vendor, status, payment, search }))
    if (r && !r.error) { setOrders(r.orders || []); if (r.pagination) t.setPagination(r.pagination) }
    setLoading(false)
  }

  // apiFetch is a new function every render (see useApi), so it can't be a dependency here.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { apiFetch('/api/vendor-orders/meta').then(m => m && !m.error && setMeta(m)) }, [])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [t.key, brand, vendor, status, payment, search])

  // Debounced so the list doesn't refetch on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => { setSearch(term); t.resetPage() }, 350)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term])

  const filter = (setter) => (e) => { setter(e.target.value); t.resetPage() }
  const setBrand = (b) => { setParams(b ? { brand: b } : {}, { replace: true }); t.resetPage() }

  // "Make order" on a quotation lands here with ?from_quote=ID: open a new order filled from it.
  const fromQuote = params.get('from_quote')
  useEffect(() => {
    if (!fromQuote) return
    let live = true
    apiFetch(`/api/vendor-quotations/${fromQuote}`).then(r => {
      if (!live) return
      setParams(brand ? { brand } : {}, { replace: true })
      if (!r || r.error) { toast.error(r?.error || 'That quotation couldn’t be loaded'); return }
      const q = r.quotation
      if (q.status !== 'Received') { toast.error(`Quotation ${q.quote_no || ''} is already ${q.status.toLowerCase()}`); return }
      setTarget({
        isNew: true,
        quote: q,
        prefill: { brand: q.brand, vendor: q.vendor, quote_ref: q.quote_no || '', title: q.title || '', total_override: q.amount ?? '', quotation_id: q.id },
      })
    })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromQuote])
  const can = meta?.can || {}

  // window.open can't carry the Authorization header, so hitting the route directly just 401s.
  // Fetch it as a blob through apiFetch (which adds the token) and open that instead.
  const [pdfBusy, setPdfBusy] = useState(null)
  const openPdf = async (o) => {
    setPdfBusy(o.id)
    const res = await apiFetch(`/api/vendor-orders/${o.id}/pdf`, { responseType: 'blob' })
    setPdfBusy(null)
    if (!res || res.error) { toast.error(res?.error || 'Failed to build the PDF'); return }
    const url = URL.createObjectURL(res.blob)
    const win = window.open(url, '_blank')
    if (!win) {
      // Popup blocked — fall back to a direct download rather than failing silently.
      const a = document.createElement('a')
      a.href = url; a.download = res.filename || `${o.ref}-${o.vendor}.pdf`
      document.body.appendChild(a); a.click(); a.remove()
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000)
  }

  const patchStatus = async (o, patch) => {
    const r = await apiFetch(`/api/vendor-orders/${o.id}/status`, { method: 'POST', body: JSON.stringify(patch) })
    if (r?.error) { toast.error(r.error); return }
    setOrders(list => list.map(x => (x.id === o.id ? r.order : x)))
  }

  // Sent from the Normless number with the approved "new order" template — never web WhatsApp.
  const [sending, setSending] = useState(null)
  const sendWhatsApp = async (o) => {
    if (!await toast.confirm({ title: `Send ${o.ref} to ${o.vendor}?`, message: 'It goes now on WhatsApp from the Normless number, with a button to the order on their vendor page.', confirmLabel: 'Send' })) return
    setSending(o.id)
    const r = await apiFetch(`/api/vendor-orders/${o.id}/whatsapp`, { method: 'POST' })
    setSending(null)
    if (!r || r.error) { toast.error(r?.error || 'It didn’t send', { title: 'Not sent' }); return }
    toast.success(`${o.ref} sent to ${o.vendor} on WhatsApp`)
    load()
  }

  const copyMessage = async (o) => {
    const r = await apiFetch(`/api/vendor-orders/${o.id}/message`)
    if (!r || r.error) { toast.error(r?.error || 'Could not build the message'); return }
    await navigator.clipboard.writeText(r.message)
    toast.success('Order details copied')
  }

  const remove = async (o) => {
    if (!await toast.confirm({ title: `Delete ${o.ref}?`, message: `The order to ${o.vendor} will be removed.`, danger: true, confirmLabel: 'Delete' })) return
    const r = await apiFetch(`/api/vendor-orders/${o.id}`, { method: 'DELETE' })
    if (r?.error) { toast.error(r.error); return }
    toast.success('Vendor order deleted')
    load()
  }

  const vendorNames = [...new Set((meta?.vendors || []).map(v => v.name))]

  return (
    <div className="page-enter">
      <div className="dash-toolbar">
        <div>
          <h1>Vendor Orders</h1>
          <p style={{ color: 'var(--text-muted)' }}>
            Production orders to vendors for Normless and Crewfit — send them as a message or PDF, and track what’s paid
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" aria-pressed={showStats} onClick={toggleStats}>
            <Icon name="trending" size={14} /> {showStats ? 'Hide analytics' : 'Analytics'}
          </button>
          {can.edit && can.pay && <button className="btn btn-secondary" onClick={() => setImporting(true)}><Icon name="download" size={14} /> Import sheet</button>}
          {can.edit && <button className="btn btn-primary" onClick={() => setTarget('new')}>+ New Vendor Order</button>}
        </div>
      </div>

      <div className="scan-tabs" style={{ marginBottom: 16 }} role="tablist">
        {[['', 'Both brands'], ['normless', 'Normless'], ['crewfit', 'Crewfit']].map(([k, l]) => (
          <button key={k} role="tab" aria-selected={brand === k} className={brand === k ? 'active' : ''} onClick={() => setBrand(k)}>{l}</button>
        ))}
      </div>

      {/* Follows the brand and vendor filters, and reloads whenever the list does. */}
      {showStats && <VendorOrderAnalytics apiFetch={apiFetch} vendor={vendor} brand={brand} refreshKey={orders} />}

      <div className="filters-row filters-row-search">
        <div className="search-bar"><span className="search-icon" />
          <input placeholder="Search vendor, product, colour, title, quotation or notes…" aria-label="Search vendor orders"
            value={term} onChange={e => setTerm(e.target.value)} />
        </div>
      </div>

      <div className="filters-row">
        <select value={vendor} onChange={filter(setVendor)} style={{ width: 'auto' }} aria-label="Vendor">
          <option value="">All vendors</option>
          {vendorNames.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
        <select value={status} onChange={filter(setStatus)} style={{ width: 'auto' }} aria-label="Status">
          <option value="">All statuses</option>
          {(meta?.statuses || STATUSES).map(s => <option key={s}>{s}</option>)}
        </select>
        <select value={payment} onChange={filter(setPayment)} style={{ width: 'auto' }} aria-label="Payment">
          <option value="">Any payment</option>
          <option value="due">Balance due</option>
          {(meta?.paymentStatuses || []).map(s => <option key={s}>{s}</option>)}
        </select>
      </div>

      <div className="data-table-wrapper">
        {loading ? <div className="loader"><div className="spinner" /></div> : !orders.length ? (
          <div className="empty-state"><div className="empty-icon"><Icon name="truck" size={28} /></div>
            <p>{search || vendor || status || payment || brand ? 'No vendor orders match these filters.' : 'No vendor orders yet.'}</p>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <SortTh label="Ref" col="ref_no" sort={t.sort} onSort={t.toggle} />
                <SortTh label="Date" col="order_date" sort={t.sort} onSort={t.toggle} />
                <SortTh label="Vendor" col="vendor" sort={t.sort} onSort={t.toggle} />
                <SortTh label="Products" col="products" sort={t.sort} onSort={t.toggle} />
                <SortTh label="Qty" col="total_qty" sort={t.sort} onSort={t.toggle} align="center" />
                <SortTh label="Total" col="total" sort={t.sort} onSort={t.toggle} align="right" />
                <SortTh label="Balance" col="balance" sort={t.sort} onSort={t.toggle} align="right" />
                <SortTh label="Status" col="status" sort={t.sort} onSort={t.toggle} />
                <SortTh label="Payment" col="payment_status" sort={t.sort} onSort={t.toggle} />
                <SortTh label="" />
              </tr>
            </thead>
            <tbody>
              {orders.map(o => (
                <tr key={o.id} onClick={() => setTarget(o)} style={{ cursor: 'pointer' }}>
                  <td data-label="Ref">
                    <div style={{ fontWeight: 600 }}>{o.ref}</div>
                    <span className="badge-secondary" style={{ marginTop: 4 }}>{BRAND_LABEL[o.brand]}</span>
                  </td>
                  <td data-label="Date" style={{ fontSize: 12.5 }}>
                    {day(o.order_date)}
                    {o.delivery_date && <div style={{ color: 'var(--text-muted)' }}>due {day(o.delivery_date)}</div>}
                  </td>
                  <td className="cell-primary">
                    <div style={{ fontWeight: 600 }}>{o.vendor}</div>
                    {(o.title || o.quote_ref) && <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{[o.title, o.quote_ref].filter(Boolean).join(' · ')}</div>}
                  </td>
                  <td data-label="Products" style={{ fontSize: 12 }}>
                    {summarise(o.items).map((s, i) => <div key={i}>{s}</div>)}
                  </td>
                  <td data-label="Qty" style={{ textAlign: 'center', fontWeight: 600 }}>
                    {o.total_qty}
                    {o.received_qty > 0 && o.pending_qty > 0 && o.status !== 'Consignment Received' && (
                      <div style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--warning)' }}>{o.pending_qty} to come</div>
                    )}
                  </td>
                  <td data-label="Total" style={{ textAlign: 'right' }}>{o.total ? inr(o.total) : '—'}</td>
                  <td data-label="Balance" style={{ textAlign: 'right', color: o.balance > 0 ? 'var(--warning)' : undefined, fontWeight: o.balance > 0 ? 600 : undefined }}>
                    {o.total ? inr(o.balance) : '—'}
                    {o.next_instalment && (
                      <div style={{ fontSize: 11.5, fontWeight: 500, color: o.next_instalment.status === 'Overdue' ? 'var(--danger)' : 'var(--text-muted)' }}>
                        Next {inr(o.next_instalment.remaining)} · {o.next_instalment.status === 'Overdue' ? 'overdue' : o.next_instalment.due_date ? day(o.next_instalment.due_date) : o.next_instalment.status.toLowerCase()}
                      </div>
                    )}
                  </td>
                  {/* Both statuses change straight from the row — they move far more often than
                      anything else on the order. */}
                  <td data-label="Status" onClick={e => e.stopPropagation()}>
                    <select className={`inline-select sb-${STATUS_CLASS[o.status] || 'pending'}`} disabled={!can.edit}
                      value={o.status} aria-label={`${o.ref} status`} onChange={e => patchStatus(o, { status: e.target.value })}>
                      {(meta?.statuses || STATUSES).map(s => <option key={s}>{s}</option>)}
                    </select>
                    {can.edit && o.status !== 'Consignment Received' && o.total_qty > 0 && (
                      <button className="mini-btn" style={{ display: 'block', marginTop: 6 }} aria-label={`Record delivery for ${o.ref}`} onClick={() => setDelivering({ orderId: o.id })}>Goods in</button>
                    )}
                  </td>
                  <td data-label="Payment" onClick={e => e.stopPropagation()}>
                    {o.payment_manual ? (
                      <select className={`inline-select sb-${MANUAL_PAY_CLASS[o.payment_status] || 'pending'}`} disabled={!can.edit}
                        value={o.payment_status || 'Not Paid'} aria-label={`${o.ref} payment`} onChange={e => patchStatus(o, { payment_status: e.target.value })}>
                        {(meta?.manualPaymentStatuses || ['Not Paid', 'Paid']).map(s => <option key={s}>{s}</option>)}
                      </select>
                    ) : (
                      <span className={`status-badge ${PAY_CLASS[o.payment_status] || ''}`}>{o.payment_status}</span>
                    )}
                    {can.pay && o.vendor_id && (o.total ? o.balance > 0 : o.payment_status !== 'Paid') && (
                      <button className="mini-btn" style={{ display: 'block', marginTop: 6 }} aria-label={`Record payment for ${o.ref}`} onClick={() => setPaying(o)}>Pay</button>
                    )}
                  </td>
                  <td className="cell-actions" data-label="Actions" onClick={e => e.stopPropagation()}>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button className="btn-icon" title="Open PDF" aria-label={`PDF of ${o.ref}`} disabled={pdfBusy === o.id} onClick={() => openPdf(o)}><Icon name="printer" size={14} /></button>
                      <button className="btn-icon" title="Copy order text" aria-label={`Copy ${o.ref}`} onClick={() => copyMessage(o)}><Icon name="copy" size={14} /></button>
                      {can.edit && <button className="btn-icon" title="Send to the vendor on WhatsApp (Normless number)" aria-label={`Send ${o.ref} on WhatsApp`} disabled={sending === o.id} onClick={() => sendWhatsApp(o)}><Icon name="whatsapp" size={14} /></button>}
                      {can.delete && (
                        <button className="btn-icon" title="Delete" aria-label={`Delete ${o.ref}`} style={{ color: 'var(--danger)' }} onClick={() => remove(o)}><Icon name="trash" size={14} /></button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!loading && <Pagination table={t} noun="vendor orders" />}
      </div>

      {target && (
        <VendorOrderDrawer
          key={target === 'new' || target.isNew ? 'new' : target.id}
          target={target} defaultBrand={brand || (menuBrand === 'crewfit' ? 'crewfit' : 'normless')}
          meta={meta} apiFetch={apiFetch} toast={toast}
          onClose={() => setTarget(null)}
          onSaved={() => { setTarget(null); load() }}
          onPay={(o) => { setTarget(null); setPaying(o) }}
          onDeliver={(o, deliveryId) => { setTarget(null); setDelivering({ orderId: o.id, deliveryId: deliveryId || null }) }}
          onChanged={load} />
      )}

      {importing && (
        <VendorImportDrawer apiFetch={apiFetch} toast={toast} onClose={() => setImporting(false)} onDone={load} />
      )}

      {delivering && (
        <RecordDeliveryDrawer orderId={delivering.orderId} deliveryId={delivering.deliveryId} apiFetch={apiFetch} toast={toast}
          onClose={() => setDelivering(null)}
          onSaved={() => { setDelivering(null); load() }} />
      )}

      {paying && (
        <RecordPaymentDrawer vendorId={paying.vendor_id} presetOrderId={paying.id} apiFetch={apiFetch} toast={toast}
          onClose={() => setPaying(null)}
          onSaved={() => { setPaying(null); load() }} />
      )}
    </div>
  )
}
