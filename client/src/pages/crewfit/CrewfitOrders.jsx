import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApi } from '../../App'

const fmt = (v) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v || 0)
const statusClass = (s) => { s = (s || '').toLowerCase(); if (s.includes('dispatch') && s.includes('ready')) return 'pending'; if (s.includes('dispatch')) return 'fulfilled'; if (s.includes('cancel')) return 'refunded'; return 'pending' }
const payClass = (s) => (s === 'Fully Paid' ? 'fulfilled' : s === 'Pending' ? 'refunded' : 'pending')
const PRINTING = ['Front', 'Back', 'Front & Back', 'Front Chest & Back', 'No Print']

function priceFor(product, qty) {
  if (!product || !qty) return null
  let price = null
  for (const [label, val] of (product.tiers || [])) {
    if (typeof val !== 'number') continue
    const n = (label.match(/\d+/g) || [0])[0]
    if (qty >= parseInt(n, 10)) price = val
  }
  return price
}

// derive money fields
function recompute(f) {
  const qty = parseInt(f.qty) || 0
  const pt = f.product_total !== undefined && f.product_total !== '' ? Number(f.product_total) : 0
  const ship = Number(f.shipping) || 0
  const gstPct = f._gstPct ?? 0
  const gst = Math.round(pt * gstPct / 100)
  const grand = pt + ship + gst
  const advance = Math.round(grand / 2)
  return { gst_amount: gst, grand_total: grand, advance, balance: grand - advance, total_cost: grand, qty }
}

function buildDescription(f) {
  const L = []
  if (f.product) L.push(`🧵 Product: ${f.product}${f.color ? ` (${f.color})` : ''}`)
  if (f.qty) L.push(`👕 Quantity: ${f.qty}`)
  if (f.printing) L.push(`🎨 Printing: ${f.printing}`)
  if (f.size_breakdown) L.push(`📏 Size Breakdown: ${f.size_breakdown}`)
  if (f.delivery_location) L.push(`📍 Delivery: ${f.delivery_location}`)
  const bill = []
  if (f.billing_name) bill.push(`🏢 Billing Name / Company: ${f.billing_name}`)
  if (f.contact_person) bill.push(`👤 Contact Person: ${f.contact_person}`)
  if (f.billing_mobile) bill.push(`📞 Mobile: ${f.billing_mobile}`)
  if (f.billing_email) bill.push(`📧 Email: ${f.billing_email}`)
  if (f.gst_number) bill.push(`🧾 GST: ${f.gst_number}`)
  if (f.billing_address) bill.push(`🏠 Address: ${f.billing_address}`)
  const money = []
  if (f.product_total) money.push(`💰 Product Total: ₹${f.product_total}`)
  if (f.shipping) money.push(`🚚 Shipping: ₹${f.shipping}`)
  if (f.gst_amount) money.push(`🧾 GST: ₹${f.gst_amount}`)
  if (f.grand_total) money.push(`💵 Grand Total: ₹${f.grand_total}`)
  if (f.advance) money.push(`💳 Advance (50%): ₹${f.advance}`)
  if (f.balance) money.push(`💵 Balance: ₹${f.balance}`)
  let out = L.join('\n')
  if (bill.length) out += '\n\n🧾 Billing Details:\n' + bill.join('\n')
  if (money.length) out += '\n\n' + money.join('\n')
  return out
}

const BLANK = { status: 'Enquiry', payment_status: 'Pending', layout_status: 'Pending', customer_type: 'New', printing: 'Front & Back', _gstPct: 0, shipping: '' }

export default function CrewfitOrders() {
  const apiFetch = useApi()
  const [params, setParams] = useSearchParams()
  const [meta, setMeta] = useState(null)
  const [products, setProducts] = useState([])
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState({ search: '', status: '', payment_status: '', so: '', vendor: '' })
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    apiFetch('/api/crewfit/meta').then(m => setMeta(m && m.statuses ? m : null))
    apiFetch('/api/crewfit/products').then(r => setProducts(r?.products || []))
  }, [])
  useEffect(() => { load() }, [filters])

  const load = async () => {
    setLoading(true)
    const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString()
    const res = await apiFetch('/api/crewfit/orders' + (qs ? '?' + qs : ''))
    const list = res?.orders || []
    setOrders(list); setLoading(false)
    const focus = params.get('focus')
    if (focus) { const f = list.find(o => String(o.id) === focus); if (f) openEdit(f); params.delete('focus'); setParams(params, { replace: true }) }
  }

  const quickUpdate = async (id, patch) => { setOrders(os => os.map(o => o.id === id ? { ...o, ...patch } : o)); await apiFetch(`/api/crewfit/orders/${id}`, { method: 'PUT', body: JSON.stringify(patch) }) }
  const InlineSelect = ({ o, field, options, cls }) => {
    const opts = options || []
    return (<select className={`inline-select ${cls ? 'sb-' + cls(o[field]) : ''}`} value={o[field] || ''} onClick={e => e.stopPropagation()} onChange={e => quickUpdate(o.id, { [field]: e.target.value })}>
      {(o[field] && !opts.includes(o[field])) && <option value={o[field]}>{o[field]}</option>}{opts.map(v => <option key={v} value={v}>{v}</option>)}</select>)
  }

  const openEdit = (o) => setForm({ ...o, _gstPct: o.gst_amount && o.product_total ? Math.round(o.gst_amount / o.product_total * 100) : 0 })

  // set fields + recompute money
  const setF = (patch, recalc = false) => setForm(f => { const nf = { ...f, ...patch }; return recalc ? { ...nf, ...recompute(nf) } : nf })
  const selectedProduct = products.find(p => p.name === form?.product)
  const colorOptions = selectedProduct?.colors || null
  const unitPrice = priceFor(selectedProduct, parseInt(form?.qty))

  const onProduct = (name) => { const p = products.find(x => x.name === name); const pp = priceFor(p, parseInt(form.qty)); setF({ product: name, ...(pp && form.qty ? { product_total: pp * parseInt(form.qty) } : {}) }, true) }
  const onQty = (q) => { const pp = priceFor(selectedProduct, parseInt(q)); setF({ qty: q, ...(pp ? { product_total: pp * parseInt(q) } : {}) }, true) }

  const save = async () => {
    if (!form.customer_name) { alert('Customer name is required'); return }
    setSaving(true)
    const payload = { ...form, ...recompute(form), description: buildDescription({ ...form, ...recompute(form) }) }
    delete payload._gstPct
    const isNew = !form.id
    const res = await apiFetch(`/api/crewfit/orders${isNew ? '' : '/' + form.id}`, { method: isNew ? 'POST' : 'PUT', body: JSON.stringify(payload) })
    setSaving(false)
    if (res && !res.error) { setForm(null); load() } else alert(res?.error || 'Save failed — deploy the Crewfit API first')
  }

  const preview = form ? buildDescription({ ...form, ...recompute(form) }) : ''

  return (
    <div className="page-enter">
      <div className="dash-toolbar">
        <div><h1>Crewfit · Bulk Orders</h1><p style={{ color: 'var(--text-muted)' }}>{orders.length} orders · manage everything here</p></div>
        <button className="btn btn-primary" onClick={() => setForm({ ...BLANK })}>+ New Order</button>
      </div>

      <div className="filters-row">
        <div className="search-bar"><span className="search-icon">🔍</span><input placeholder="Search customer, phone, order #…" value={filters.search} onChange={e => setFilters(f => ({ ...f, search: e.target.value }))} /></div>
        <select value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value }))} style={{ width: 'auto' }}><option value="">All statuses</option>{(meta?.statuses || []).map(s => <option key={s}>{s}</option>)}</select>
        <select value={filters.payment_status} onChange={e => setFilters(f => ({ ...f, payment_status: e.target.value }))} style={{ width: 'auto' }}><option value="">All payments</option>{(meta?.payments || []).map(s => <option key={s}>{s}</option>)}</select>
        <select value={filters.so} onChange={e => setFilters(f => ({ ...f, so: e.target.value }))} style={{ width: 'auto' }}><option value="">All SO</option>{(meta?.sos || []).map(s => <option key={s}>{s}</option>)}</select>
        <select value={filters.vendor} onChange={e => setFilters(f => ({ ...f, vendor: e.target.value }))} style={{ width: 'auto' }}><option value="">All vendors</option>{(meta?.vendors || []).map(s => <option key={s}>{s}</option>)}</select>
      </div>

      <div className="data-table-wrapper">
        {loading ? <div className="loader"><div className="spinner" /></div> : orders.length === 0 ? (
          <div className="empty-state"><div className="empty-icon">📦</div><p>No orders yet — click “+ New Order”.</p></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead><tr><th>#</th><th>Date</th><th>Customer</th><th>Product</th><th style={{ textAlign: 'center' }}>Qty</th><th style={{ textAlign: 'right' }}>Total</th><th>Deadline</th><th>Status</th><th>Payment</th><th>Layout</th></tr></thead>
              <tbody>
                {orders.map(o => (
                  <tr key={o.id} onClick={() => openEdit(o)}>
                    <td style={{ color: 'var(--text-muted)' }}>{o.sl_no}</td>
                    <td style={{ fontSize: 12.5 }}>{(o.order_date || '').slice(0, 10) || '—'}</td>
                    <td><div style={{ fontWeight: 600 }}>{o.customer_name}</div><div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{o.contact_number}</div></td>
                    <td style={{ fontSize: 12.5, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.product || '—'}</td>
                    <td style={{ textAlign: 'center' }}>{o.qty || '—'}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{o.total_cost ? fmt(o.total_cost) : '—'}</td>
                    <td style={{ fontSize: 12.5 }}>{(o.deadline_at || '').slice(0, 10) || <span style={{ color: 'var(--text-muted)' }}>{o.deadline_text || '—'}</span>}</td>
                    <td>{meta && <InlineSelect o={o} field="status" options={meta.statuses} cls={statusClass} />}</td>
                    <td>{meta && <InlineSelect o={o} field="payment_status" options={meta.payments} cls={payClass} />}</td>
                    <td>{meta && <InlineSelect o={o} field="layout_status" options={meta.layouts} cls={(v) => v === 'Done' ? 'fulfilled' : 'refunded'} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {form && (
        <>
          <div className="drawer-overlay" onClick={() => setForm(null)} />
          <div className="drawer drawer-wide">
            <div className="drawer-header">
              <div><h2>{form.id ? `Edit Order #${form.sl_no}` : 'New Bulk Order'}</h2><div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Pick a product — price & totals auto-fill</div></div>
              <button className="btn-icon" onClick={() => setForm(null)}>✕</button>
            </div>
            <div className="drawer-body">
              <div className="form-section">Customer</div>
              <div className="form-row">
                <div className="input-group"><label>Customer Name *</label><input value={form.customer_name || ''} onChange={e => setF({ customer_name: e.target.value })} /></div>
                <div className="input-group"><label>Contact Number</label><input value={form.contact_number || ''} onChange={e => setF({ contact_number: e.target.value })} /></div>
                <div className="input-group"><label>Customer Type</label><select value={form.customer_type || ''} onChange={e => setF({ customer_type: e.target.value })}><option value="">—</option>{(meta?.customerTypes || ['New', 'Returning']).map(v => <option key={v}>{v}</option>)}</select></div>
                <div className="input-group"><label>Sales Officer</label><select value={form.so || ''} onChange={e => setF({ so: e.target.value })}><option value="">—</option>{(meta?.sos || []).map(v => <option key={v}>{v}</option>)}</select></div>
              </div>

              <div className="form-section">Product &amp; Spec</div>
              <div className="form-row">
                <div className="input-group"><label>Product</label>
                  <select value={form.product || ''} onChange={e => onProduct(e.target.value)}>
                    <option value="">— Select from catalog —</option>
                    {products.map(p => <option key={p.id} value={p.name}>{p.name} (from ₹{p.from_price})</option>)}
                    {form.product && !products.some(p => p.name === form.product) && <option value={form.product}>{form.product}</option>}
                  </select>
                </div>
                <div className="input-group"><label>Color</label>
                  {colorOptions ? <select value={form.color || ''} onChange={e => setF({ color: e.target.value })}><option value="">—</option>{colorOptions.map(c => <option key={c}>{c}</option>)}</select>
                    : <input value={form.color || ''} onChange={e => setF({ color: e.target.value })} placeholder="Color" />}
                </div>
                <div className="input-group"><label>Qty</label><input type="number" value={form.qty || ''} onChange={e => onQty(e.target.value)} /></div>
                <div className="input-group"><label>Printing</label><select value={form.printing || ''} onChange={e => setF({ printing: e.target.value })}><option value="">—</option>{PRINTING.map(v => <option key={v}>{v}</option>)}</select></div>
              </div>
              <div className="input-group"><label>Size breakdown</label><input value={form.size_breakdown || ''} onChange={e => setF({ size_breakdown: e.target.value })} placeholder="e.g. S-2, M-5, L-3, XL-1" /></div>

              <div className="form-section">Pricing {unitPrice ? <span className="unit-hint">catalog: ₹{unitPrice}/pc for this qty</span> : ''}</div>
              <div className="form-row">
                <div className="input-group"><label>Product Total (₹)</label><input type="number" value={form.product_total ?? ''} onChange={e => setF({ product_total: e.target.value }, true)} /></div>
                <div className="input-group"><label>Shipping (₹)</label><input type="number" value={form.shipping ?? ''} onChange={e => setF({ shipping: e.target.value }, true)} /></div>
                <div className="input-group"><label>GST</label><select value={form._gstPct ?? 0} onChange={e => setF({ _gstPct: Number(e.target.value) }, true)}><option value={0}>No GST</option><option value={5}>5%</option><option value={12}>12%</option><option value={18}>18%</option></select></div>
                <div className="input-group"><label>GST amount</label><input readOnly value={form.gst_amount ?? 0} /></div>
              </div>
              <div className="totals-bar">
                <div><span>Grand Total</span><strong>{fmt(form.grand_total)}</strong></div>
                <div><span>Advance (50%)</span><strong style={{ color: 'var(--warning)' }}>{fmt(form.advance)}</strong></div>
                <div><span>Balance</span><strong style={{ color: 'var(--info)' }}>{fmt(form.balance)}</strong></div>
              </div>

              <div className="form-section">Delivery &amp; Billing</div>
              <div className="input-group"><label>Delivery Address</label><input value={form.delivery_location || ''} onChange={e => setF({ delivery_location: e.target.value })} /></div>
              <div className="form-row">
                <div className="input-group"><label>Billing Name / Company</label><input value={form.billing_name || ''} onChange={e => setF({ billing_name: e.target.value })} /></div>
                <div className="input-group"><label>Contact Person</label><input value={form.contact_person || ''} onChange={e => setF({ contact_person: e.target.value })} /></div>
                <div className="input-group"><label>Billing Mobile</label><input value={form.billing_mobile || ''} onChange={e => setF({ billing_mobile: e.target.value })} /></div>
                <div className="input-group"><label>Email</label><input value={form.billing_email || ''} onChange={e => setF({ billing_email: e.target.value })} /></div>
                <div className="input-group"><label>GST Number</label><input value={form.gst_number || ''} onChange={e => setF({ gst_number: e.target.value })} /></div>
              </div>
              <div className="input-group"><label>Complete Billing Address</label><input value={form.billing_address || ''} onChange={e => setF({ billing_address: e.target.value })} /></div>

              <div className="form-section">Pipeline</div>
              <div className="form-row">
                <div className="input-group"><label>Status</label><select value={form.status || ''} onChange={e => setF({ status: e.target.value })}>{(meta?.statuses || []).map(v => <option key={v}>{v}</option>)}</select></div>
                <div className="input-group"><label>Payment</label><select value={form.payment_status || ''} onChange={e => setF({ payment_status: e.target.value })}>{(meta?.payments || []).map(v => <option key={v}>{v}</option>)}</select></div>
                <div className="input-group"><label>Layout</label><select value={form.layout_status || ''} onChange={e => setF({ layout_status: e.target.value })}>{(meta?.layouts || []).map(v => <option key={v}>{v}</option>)}</select></div>
                <div className="input-group"><label>Vendor</label><select value={form.vendor || ''} onChange={e => setF({ vendor: e.target.value })}><option value="">—</option>{(meta?.vendors || []).map(v => <option key={v}>{v}</option>)}</select></div>
              </div>
              <div className="form-row">
                <div className="input-group"><label>Order Date</label><input type="date" value={(form.order_date || '').slice(0, 10)} onChange={e => setF({ order_date: e.target.value })} /></div>
                <div className="input-group"><label>Deadline</label><input type="date" value={(form.deadline_at || '').slice(0, 10)} onChange={e => setF({ deadline_at: e.target.value })} /></div>
                <div className="input-group"><label>Dispatch Date</label><input type="date" value={(form.dispatch_date || '').slice(0, 10)} onChange={e => setF({ dispatch_date: e.target.value })} /></div>
                <div className="input-group"><label>Dispatch (MOT)</label><select value={form.mot || ''} onChange={e => setF({ mot: e.target.value })}><option value="">—</option>{(meta?.mots || []).map(v => <option key={v}>{v}</option>)}</select></div>
              </div>
              <div className="form-row">
                <div className="input-group"><label>Mock folder (Drive link)</label><input value={form.mock_folder || ''} onChange={e => setF({ mock_folder: e.target.value })} /></div>
                <div className="input-group"><label>Tracking link</label><input value={form.tracking_link || ''} onChange={e => setF({ tracking_link: e.target.value })} /></div>
              </div>

              <div className="form-section">Order summary <button className="mini-btn" onClick={() => navigator.clipboard?.writeText(preview)}>📋 Copy</button></div>
              <div className="order-block">{preview || 'Fill product, qty and billing to generate the order block…'}</div>

              <div className="input-group" style={{ marginTop: 14 }}><label>Internal notes</label><textarea rows={2} value={form.notes || ''} onChange={e => setF({ notes: e.target.value })} /></div>

              <div style={{ display: 'flex', gap: 10, position: 'sticky', bottom: 0, background: 'var(--bg-secondary)', padding: '12px 0' }}>
                <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : (form.id ? 'Save changes' : 'Create order')}</button>
                <button className="btn btn-secondary" onClick={() => setForm(null)}>Cancel</button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
