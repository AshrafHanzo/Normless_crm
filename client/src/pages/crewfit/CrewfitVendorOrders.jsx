import { useState, useEffect } from 'react'
import { useApi, useAuth } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import ComboInput from '../../components/ComboInput'
import AutoTextarea from '../../components/AutoTextarea'
import useDirtyGuard from '../../hooks/useDirtyGuard'
import useServerTable from '../../hooks/useServerTable'
import SortTh from '../../components/SortTh'
import Pagination from '../../components/Pagination'
import { cleanMobile, mobileError, isValidMobile, mobileInputProps } from '../../utils/phone'

const fmt = (v) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(v) || 0)
const day = (v) => (v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—')
const pad = (n) => String(n).padStart(2, '0')
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }

const STATUSES = ['Pending', 'Consignment Ordered', 'Consignment Received']
const PAYMENT_STATUSES = ['Not Paid', 'Paid']
const STATUS_CLASS = { Pending: 'pending', 'Consignment Ordered': 'refunded', 'Consignment Received': 'fulfilled' }
const PAY_CLASS = { 'Not Paid': 'pending', Paid: 'fulfilled' }

const blankColor = () => ({ color: '', sizes: {} })
const blankItem = () => ({ product_type: '', gsm: '', rate: '', colors: [blankColor()] })
// New orders start Pending / Not Paid; both are moved on by hand as the order progresses.
const blankOrder = () => ({
  order_date: todayStr(), delivery_date: '', vendor: '', vendor_phone: '',
  items: [blankItem()], notes: '', status: 'Pending', payment_status: 'Not Paid',
})

const colorQty = (c) => Object.values(c.sizes || {}).reduce((s, q) => s + (parseInt(q, 10) || 0), 0)
const itemQty = (i) => (i.colors || []).reduce((s, c) => s + colorQty(c), 0)
const orderQty = (items) => (items || []).reduce((s, i) => s + itemQty(i), 0)
const orderAmount = (items) => (items || []).reduce((s, i) => s + (Number(i.rate) > 0 ? Number(i.rate) * itemQty(i) : 0), 0)

/** "Poly Cotton Polos · Navy, Black" — enough to recognise the order without opening it. */
function summarise(items) {
  return (items || []).map(i => {
    const colors = (i.colors || []).map(c => c.color).filter(Boolean).join(', ')
    return [i.product_type, colors].filter(Boolean).join(' · ')
  }).filter(Boolean)
}

/* ────────────────────────────── drawer ────────────────────────────── */

function VendorOrderDrawer({ target, meta, onClose, onSaved, apiFetch, toast }) {
  const [form, setForm] = useState(() => (target === 'new' ? blankOrder() : {
    ...target,
    delivery_date: target.delivery_date || '',
    vendor_phone: target.vendor_phone || '',
    notes: target.notes || '',
    status: target.status || 'Pending',
    payment_status: target.payment_status || 'Not Paid',
    items: (target.items || []).length ? target.items.map(i => ({ ...i, rate: i.rate ?? '' })) : [blankItem()],
  }))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

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
    const current = form.items[idx].colors[cIdx].sizes || {}
    const next = { ...current }
    if (value === '' || parseInt(value, 10) <= 0) delete next[size]
    else next[size] = parseInt(value, 10)
    setColor(idx, cIdx, { sizes: next })
  }

  const addItem = () => set({ items: [...form.items, blankItem()] })
  const removeItem = (idx) => set({ items: form.items.length > 1 ? form.items.filter((_, i) => i !== idx) : [blankItem()] })
  const addColor = (idx) => setItem(idx, { colors: [...form.items[idx].colors, blankColor()] })
  const removeColor = (idx, cIdx) => {
    const colors = form.items[idx].colors.filter((_, i) => i !== cIdx)
    setItem(idx, { colors: colors.length ? colors : [blankColor()] })
  }

  // Picking a catalog product fills its GSM, but only when GSM is still blank — a hand-typed
  // value is the user overriding the catalog and must not be clobbered.
  const pickProduct = (idx, name) => {
    const match = (meta?.products || []).find(p => p.name === name)
    setItem(idx, { product_type: name, ...(match?.gsm && !form.items[idx].gsm ? { gsm: String(match.gsm) } : {}) })
  }

  const save = async () => {
    if (form.vendor_phone && !isValidMobile(form.vendor_phone)) {
      toast.error('Vendor phone must be exactly 10 digits.', { title: 'Check the number' }); return
    }
    setSaving(true); setError('')
    const body = { ...form, items: form.items }
    const res = form.id
      ? await apiFetch(`/api/crewfit/vendor-orders/${form.id}`, { method: 'PUT', body: JSON.stringify(body) })
      : await apiFetch('/api/crewfit/vendor-orders', { method: 'POST', body: JSON.stringify(body) })
    setSaving(false)
    if (!res) return
    if (res.error) { setError(res.error); return }
    guard.reset()
    toast.success(`${res.order.ref} saved`)
    onSaved(res.order)
  }

  const qty = orderQty(form.items)
  const amount = orderAmount(form.items)
  const vendorOptions = (meta?.vendors || []).map(v => v.name)

  return (
    <div className="drawer-overlay" onClick={guard.requestClose}>
      <div className="drawer drawer-wide" onClick={e => e.stopPropagation()}>
        <div className="drawer-header">
          <div>
            <h2 style={{ fontSize: 17 }}>{form.id ? `Vendor Order ${form.ref || ''}` : 'New Vendor Order'}</h2>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
              Every dropdown accepts a typed value too — pick one or enter your own
            </div>
          </div>
          <button className="btn-icon" onClick={guard.requestClose}><Icon name="close" size={16} /></button>
        </div>

        <div className="drawer-body">
          {error && <div className="calc-warning">{error}</div>}
          <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div className="form-section">Vendor</div>
            <div className="form-row">
              <div className="input-group">
                <label>Order date *</label>
                <input type="date" value={form.order_date} onChange={e => set({ order_date: e.target.value })} />
              </div>
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
            </div>
            <div className="form-row">
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
              <div className="input-group">
                <label>Payment</label>
                <select value={form.payment_status} onChange={e => set({ payment_status: e.target.value })}>
                  {(meta?.paymentStatuses || PAYMENT_STATUSES).map(s => <option key={s}>{s}</option>)}
                </select>
              </div>
            </div>

            <div className="form-section">
              Products <span className="section-count">{form.items.length} {form.items.length === 1 ? 'product' : 'products'}</span>
              <button type="button" className="mini-btn" onClick={addItem}>+ Add product</button>
            </div>

            {form.items.map((item, idx) => (
              <div key={idx} className="line-item-card">
                <div className="line-item-header">
                  <span>Product {idx + 1}{itemQty(item) > 0 ? ` · ${itemQty(item)} pcs` : ''}</span>
                  {form.items.length > 1 && <button type="button" className="btn-icon" onClick={() => removeItem(idx)}>✕</button>}
                </div>
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
                        <button type="button" className="btn-icon" onClick={() => removeColor(idx, cIdx)}>✕</button>
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
              </div>
            ))}

            <button type="button" className="add-item-btn" onClick={addItem}>+ Add another product</button>

            <div className="form-section">Notes</div>
            <div className="input-group">
              <AutoTextarea value={form.notes} onChange={e => set({ notes: e.target.value })}
                placeholder="Anything the vendor should know — packing, delivery date, labels…" />
            </div>
          </fieldset>

          <div className="totals-bar">
            <div><span>Total quantity</span><strong>{qty} pcs</strong></div>
            {amount > 0 && <div><span>Order value</span><strong>{fmt(amount)}</strong></div>}
          </div>

          <div style={{ display: 'flex', gap: 10, position: 'sticky', bottom: 0, background: 'var(--bg-secondary)', padding: '12px 0' }}>
            <button className="btn btn-primary" onClick={() => save()} disabled={saving}>
              {saving ? 'Saving…' : (form.id ? 'Save changes' : 'Create vendor order')}
            </button>
            <button className="btn btn-secondary" onClick={guard.requestClose} style={{ marginLeft: 'auto' }}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ────────────────────────────── page ────────────────────────────── */

export default function CrewfitVendorOrders() {
  const apiFetch = useApi()
  const { user } = useAuth()
  const toast = useToast()
  const [orders, setOrders] = useState([])
  const [meta, setMeta] = useState(null)
  const [loading, setLoading] = useState(true)
  const [target, setTarget] = useState(null)
  const [vendor, setVendor] = useState('')
  const [status, setStatus] = useState('')
  const [term, setTerm] = useState('')
  const [search, setSearch] = useState('')
  const isAdmin = user?.role === 'owner' || user?.role === 'admin'
  // Server-side sort + page: a header click reorders every matching order, not this page's 25.
  const t = useServerTable({ sort: 'order_date', dir: 'desc' })

  const load = async (v = vendor, s = status, q = search) => {
    const r = await apiFetch('/api/crewfit/vendor-orders?' + t.query({ vendor: v, status: s, search: q }))
    if (r && !r.error) { setOrders(r.orders || []); if (r.pagination) t.setPagination(r.pagination) }
    setLoading(false)
  }

  // Both loads only setState after an await, so nothing updates synchronously here.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); apiFetch('/api/crewfit/vendor-orders/meta').then(m => m && !m.error && setMeta(m)) }, [])

  const applyFilter = (v, s) => { setVendor(v); setStatus(s); setLoading(true); t.resetPage(); load(v, s, search) }

  // Debounced so the list doesn't refetch on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => { setSearch(term); setLoading(true); t.resetPage(); load(vendor, status, term) }, 350)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term])

  // Sorting is done by the server across every matching order, so a header click can't be
  // satisfied from the page already in memory.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [t.key])
  const sorted = orders
  const sort = t.sort, toggle = t.toggle

  // window.open can't carry the Authorization header, so hitting the route directly just 401s.
  // Fetch it as a blob through apiFetch (which adds the token) and open that instead — the same
  // route the shipping label uses.
  const [pdfBusy, setPdfBusy] = useState(null)
  const openPdf = async (o) => {
    setPdfBusy(o.id)
    const res = await apiFetch(`/api/crewfit/vendor-orders/${o.id}/pdf`, { responseType: 'blob' })
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
    const r = await apiFetch(`/api/crewfit/vendor-orders/${o.id}/status`, { method: 'POST', body: JSON.stringify(patch) })
    if (r?.error) { toast.error(r.error); return }
    setOrders(list => list.map(x => (x.id === o.id ? r.order : x)))
  }

  const sendWhatsApp = async (o) => {
    const r = await apiFetch(`/api/crewfit/vendor-orders/${o.id}/message`)
    if (!r || r.error) { toast.error(r?.error || 'Could not build the message'); return }
    const digits = (r.phone || '').replace(/\D/g, '')
    const to = digits.length === 10 ? `91${digits}` : digits
    window.open(`https://wa.me/${to}?text=${encodeURIComponent(r.message)}`, '_blank')
    // Sending is what actually places the order, so a Pending one moves on by itself.
    if (o.status === 'Pending') await patchStatus(o, { status: 'Consignment Ordered' })
  }

  const copyMessage = async (o) => {
    const r = await apiFetch(`/api/crewfit/vendor-orders/${o.id}/message`)
    if (!r || r.error) { toast.error(r?.error || 'Could not build the message'); return }
    await navigator.clipboard.writeText(r.message)
    toast.success('Order details copied')
  }

  const remove = async (o) => {
    if (!await toast.confirm({ title: `Delete ${o.ref}?`, message: `The order to ${o.vendor} will be removed.`, danger: true, confirmLabel: 'Delete' })) return
    const r = await apiFetch(`/api/crewfit/vendor-orders/${o.id}`, { method: 'DELETE' })
    if (r?.error) { toast.error(r.error); return }
    toast.success('Vendor order deleted')
    load()
  }

  return (
    <div className="page-enter">
      <div className="dash-toolbar">
        <div>
          <h1>Crewfit · Vendor Orders</h1>
          <p style={{ color: 'var(--text-muted)' }}>
            Raise production orders and send them to vendors as a message or PDF
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-primary" onClick={() => setTarget('new')}>+ New Vendor Order</button>
        </div>
      </div>

      {/* Search bar, then filter selects, then the table — the same three-row layout as Bulk
          Orders and Payments, so the controls sit where they do on every other list. */}
      <div className="filters-row filters-row-search">
        <div className="search-bar"><span className="search-icon" />
          <input placeholder="Search vendor, product, colour or notes…" value={term} onChange={e => setTerm(e.target.value)} />
        </div>
      </div>

      <div className="filters-row">
        <select value={vendor} onChange={e => applyFilter(e.target.value, status)} style={{ width: 'auto' }}>
          <option value="">All vendors</option>
          {(meta?.vendors || []).map(v => <option key={v.name} value={v.name}>{v.name}</option>)}
        </select>
        <select value={status} onChange={e => applyFilter(vendor, e.target.value)} style={{ width: 'auto' }}>
          <option value="">All statuses</option>
          {(meta?.statuses || STATUSES).map(s => <option key={s}>{s}</option>)}
        </select>
      </div>

      <div className="data-table-wrapper">
        {loading ? <div className="loader"><div className="spinner" /></div> : !orders.length ? (
          <div className="empty-state"><div className="empty-icon">🧵</div>
            <p>{search || vendor || status ? 'No vendor orders match these filters.' : 'No vendor orders yet.'}</p>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <SortTh label="Ref" col="ref_no" sort={sort} onSort={toggle} />
                <SortTh label="Date" col="order_date" sort={sort} onSort={toggle} />
                <SortTh label="Delivery" col="delivery_date" sort={sort} onSort={toggle} />
                <SortTh label="Vendor" col="vendor" sort={sort} onSort={toggle} />
                <SortTh label="Products" col="products" sort={sort} onSort={toggle} />
                <SortTh label="Qty" col="total_qty" sort={sort} onSort={toggle} align="center" />
                <SortTh label="Value" col="total_amount" sort={sort} onSort={toggle} align="right" />
                <SortTh label="Status" col="status" sort={sort} onSort={toggle} />
                <SortTh label="Payment" col="payment_status" sort={sort} onSort={toggle} />
                <SortTh label="" />
              </tr>
            </thead>
            <tbody>
              {sorted.map(o => (
                <tr key={o.id} onClick={() => setTarget(o)}>
                  <td data-label="Ref" style={{ fontWeight: 600 }}>{o.ref}</td>
                  <td data-label="Date" style={{ fontSize: 12.5 }}>{day(o.order_date)}</td>
                  <td data-label="Delivery" style={{ fontSize: 12.5, color: o.delivery_date ? undefined : 'var(--text-muted)' }}>
                    {o.delivery_date ? day(o.delivery_date) : '—'}
                  </td>
                  <td className="cell-primary">
                    <div style={{ fontWeight: 600 }}>{o.vendor}</div>
                    {o.vendor_phone && <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{o.vendor_phone}</div>}
                  </td>
                  <td data-label="Products" style={{ fontSize: 12 }}>
                    {summarise(o.items).map((s, i) => <div key={i}>{s}</div>)}
                  </td>
                  <td data-label="Qty" style={{ textAlign: 'center', fontWeight: 600 }}>{o.total_qty}</td>
                  <td data-label="Value" style={{ textAlign: 'right' }}>{o.total_amount ? fmt(o.total_amount) : '—'}</td>
                  {/* Both statuses change straight from the row — they move far more often than
                      anything else on the order. */}
                  <td data-label="Status" onClick={e => e.stopPropagation()}>
                    <select className={`inline-select sb-${STATUS_CLASS[o.status] || 'pending'}`}
                      value={o.status} onChange={e => patchStatus(o, { status: e.target.value })}>
                      {(meta?.statuses || STATUSES).map(s => <option key={s}>{s}</option>)}
                    </select>
                  </td>
                  <td data-label="Payment" onClick={e => e.stopPropagation()}>
                    <select className={`inline-select sb-${PAY_CLASS[o.payment_status] || 'pending'}`}
                      value={o.payment_status || 'Not Paid'} onChange={e => patchStatus(o, { payment_status: e.target.value })}>
                      {(meta?.paymentStatuses || PAYMENT_STATUSES).map(s => <option key={s}>{s}</option>)}
                    </select>
                  </td>
                  <td className="cell-actions" data-label="Actions" onClick={e => e.stopPropagation()}>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                      <button className="btn-icon" title="Open PDF" disabled={pdfBusy === o.id} onClick={() => openPdf(o)}><Icon name="printer" size={14} /></button>
                      <button className="btn-icon" title="Copy order text" onClick={() => copyMessage(o)}><Icon name="copy" size={14} /></button>
                      <button className="btn-icon" title="Send on WhatsApp" onClick={() => sendWhatsApp(o)}><Icon name="phone" size={14} /></button>
                      {isAdmin && (
                        <button className="btn-icon" title="Delete" style={{ color: 'var(--danger)' }} onClick={() => remove(o)}><Icon name="trash" size={14} /></button>
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
          key={target === 'new' ? 'new' : target.id}
          target={target} meta={meta} apiFetch={apiFetch} toast={toast}
          onClose={() => setTarget(null)}
          onSaved={() => { setTarget(null); load() }} />
      )}
    </div>
  )
}
