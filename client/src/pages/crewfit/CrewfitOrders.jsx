import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApi } from '../../App'

const fmt = (v) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v || 0)
const statusClass = (s) => { s = (s || '').toLowerCase(); if (s.includes('dispatch') && s.includes('ready')) return 'pending'; if (s.includes('dispatch')) return 'fulfilled'; if (s.includes('cancel')) return 'refunded'; return 'pending' }
const payClass = (s) => (s === 'Fully Paid' ? 'fulfilled' : s === 'Pending' ? 'refunded' : 'pending')

// price/pc for a qty from a product's MOQ tiers
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

const BLANK = { status: 'Enquiry', payment_status: 'Pending', layout_status: 'Pending', customer_type: 'New' }

export default function CrewfitOrders() {
  const apiFetch = useApi()
  const [params, setParams] = useSearchParams()
  const [meta, setMeta] = useState(null)
  const [products, setProducts] = useState([])
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState({ search: '', status: '', payment_status: '', so: '', vendor: '' })
  const [form, setForm] = useState(null)   // full create/edit form
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
    if (focus) { const f = list.find(o => String(o.id) === focus); if (f) setForm({ ...f }); params.delete('focus'); setParams(params, { replace: true }) }
  }

  // quick inline update from the table (no full form)
  const quickUpdate = async (id, patch) => {
    setOrders(os => os.map(o => o.id === id ? { ...o, ...patch } : o))
    await apiFetch(`/api/crewfit/orders/${id}`, { method: 'PUT', body: JSON.stringify(patch) })
  }

  const InlineSelect = ({ o, field, options, cls }) => {
    const opts = options || []
    return (
      <select className={`inline-select ${cls ? 'sb-' + cls(o[field]) : ''}`} value={o[field] || ''} onClick={e => e.stopPropagation()} onChange={e => quickUpdate(o.id, { [field]: e.target.value })}>
        {(o[field] && !opts.includes(o[field])) && <option value={o[field]}>{o[field]}</option>}
        {opts.map(v => <option key={v} value={v}>{v}</option>)}
      </select>
    )
  }

  // ----- form helpers -----
  const setF = (patch) => setForm(f => ({ ...f, ...patch }))
  const selectedProduct = products.find(p => p.name === form?.product)
  const colorOptions = selectedProduct?.colors || null

  const onProduct = (name) => {
    const p = products.find(x => x.name === name)
    const patch = { product: name }
    const pp = priceFor(p, parseInt(form.qty))
    if (pp && form.qty) patch.total_cost = pp * parseInt(form.qty)
    setF(patch)
  }
  const onQty = (q) => {
    const patch = { qty: q }
    const pp = priceFor(selectedProduct, parseInt(q))
    if (pp) patch.total_cost = pp * parseInt(q)
    setF(patch)
  }

  const save = async () => {
    if (!form.customer_name) { alert('Customer name is required'); return }
    setSaving(true)
    const isNew = !form.id
    const res = await apiFetch(`/api/crewfit/orders${isNew ? '' : '/' + form.id}`, {
      method: isNew ? 'POST' : 'PUT', body: JSON.stringify(form),
    })
    setSaving(false)
    if (res && !res.error) { setForm(null); load() }
    else alert(res?.error || 'Save failed')
  }

  const unitPrice = priceFor(selectedProduct, parseInt(form?.qty))

  return (
    <div className="page-enter">
      <div className="dash-toolbar">
        <div><h1>Crewfit · Bulk Orders</h1><p style={{ color: 'var(--text-muted)' }}>{orders.length} orders · manage everything here</p></div>
        <button className="btn btn-primary" onClick={() => setForm({ ...BLANK })}>+ New Order</button>
      </div>

      <div className="filters-row">
        <div className="search-bar"><span className="search-icon">🔍</span>
          <input placeholder="Search customer, phone, order #…" value={filters.search} onChange={e => setFilters(f => ({ ...f, search: e.target.value }))} />
        </div>
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
              <thead><tr><th>#</th><th>Customer</th><th>Product</th><th style={{ textAlign: 'center' }}>Qty</th><th style={{ textAlign: 'right' }}>Total</th><th>Deadline</th><th>Status</th><th>Payment</th><th>Layout</th></tr></thead>
              <tbody>
                {orders.map(o => (
                  <tr key={o.id} onClick={() => setForm({ ...o })}>
                    <td style={{ color: 'var(--text-muted)' }}>{o.sl_no}</td>
                    <td><div style={{ fontWeight: 600 }}>{o.customer_name}</div><div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{o.contact_number}</div></td>
                    <td style={{ fontSize: 12.5, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.product || '—'}</td>
                    <td style={{ textAlign: 'center' }}>{o.qty || '—'}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{o.total_cost ? fmt(o.total_cost) : '—'}</td>
                    <td style={{ fontSize: 12.5 }}>{o.deadline_at || <span style={{ color: 'var(--text-muted)' }}>{o.deadline_text || '—'}</span>}</td>
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

      {/* Create / Edit form */}
      {form && (
        <>
          <div className="drawer-overlay" onClick={() => setForm(null)} />
          <div className="drawer">
            <div className="drawer-header">
              <div><h2>{form.id ? `Edit Order #${form.sl_no}` : 'New Bulk Order'}</h2><div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Fill the details — price auto-fills from the catalog</div></div>
              <button className="btn-icon" onClick={() => setForm(null)}>✕</button>
            </div>
            <div className="drawer-body">
              <div className="form-row">
                <div className="input-group"><label>Customer Name *</label><input value={form.customer_name || ''} onChange={e => setF({ customer_name: e.target.value })} /></div>
                <div className="input-group"><label>Contact Number</label><input value={form.contact_number || ''} onChange={e => setF({ contact_number: e.target.value })} /></div>
                <div className="input-group"><label>Customer Type</label><select value={form.customer_type || ''} onChange={e => setF({ customer_type: e.target.value })}><option value="">—</option>{(meta?.customerTypes || ['New', 'Returning']).map(v => <option key={v}>{v}</option>)}</select></div>
                <div className="input-group"><label>Sales Officer</label><select value={form.so || ''} onChange={e => setF({ so: e.target.value })}><option value="">—</option>{(meta?.sos || []).map(v => <option key={v}>{v}</option>)}</select></div>
              </div>

              <div className="form-row">
                <div className="input-group"><label>Product</label>
                  <select value={form.product || ''} onChange={e => onProduct(e.target.value)}>
                    <option value="">— Select from catalog —</option>
                    {products.map(p => <option key={p.id} value={p.name}>{p.name} (from ₹{p.from_price})</option>)}
                    {form.product && !products.some(p => p.name === form.product) && <option value={form.product}>{form.product}</option>}
                  </select>
                </div>
                <div className="input-group"><label>Color</label>
                  {colorOptions
                    ? <select value={form.color || ''} onChange={e => setF({ color: e.target.value })}><option value="">—</option>{colorOptions.map(c => <option key={c}>{c}</option>)}</select>
                    : <input value={form.color || ''} onChange={e => setF({ color: e.target.value })} placeholder="Color" />}
                </div>
                <div className="input-group"><label>Qty</label><input type="number" value={form.qty || ''} onChange={e => onQty(e.target.value)} /></div>
                <div className="input-group"><label>Size breakdown</label><input value={form.size_breakdown || ''} onChange={e => setF({ size_breakdown: e.target.value })} placeholder="e.g. S-2, M-5, L-3" /></div>
              </div>

              <div className="form-row">
                <div className="input-group"><label>Total Cost {unitPrice ? <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(₹{unitPrice}/pc)</span> : ''}</label><input type="number" value={form.total_cost || ''} onChange={e => setF({ total_cost: e.target.value })} /></div>
                <div className="input-group"><label>Payment Status</label><select value={form.payment_status || ''} onChange={e => setF({ payment_status: e.target.value })}>{(meta?.payments || ['Pending', '50% Paid', 'Fully Paid']).map(v => <option key={v}>{v}</option>)}</select></div>
                <div className="input-group"><label>Layout Status</label><select value={form.layout_status || ''} onChange={e => setF({ layout_status: e.target.value })}>{(meta?.layouts || ['Pending', 'Done']).map(v => <option key={v}>{v}</option>)}</select></div>
                <div className="input-group"><label>Status</label><select value={form.status || ''} onChange={e => setF({ status: e.target.value })}>{(meta?.statuses || []).map(v => <option key={v}>{v}</option>)}</select></div>
              </div>

              <div className="form-row">
                <div className="input-group"><label>Order Date</label><input type="date" value={(form.order_date || '').slice(0, 10)} onChange={e => setF({ order_date: e.target.value })} /></div>
                <div className="input-group"><label>Deadline</label><input type="date" value={(form.deadline_at || '').slice(0, 10)} onChange={e => setF({ deadline_at: e.target.value })} /></div>
                <div className="input-group"><label>Vendor</label><select value={form.vendor || ''} onChange={e => setF({ vendor: e.target.value })}><option value="">—</option>{(meta?.vendors || []).map(v => <option key={v}>{v}</option>)}</select></div>
                <div className="input-group"><label>Dispatch (MOT)</label><select value={form.mot || ''} onChange={e => setF({ mot: e.target.value })}><option value="">—</option>{(meta?.mots || []).map(v => <option key={v}>{v}</option>)}</select></div>
              </div>

              <div className="input-group"><label>Mock folder (Drive link)</label><input value={form.mock_folder || ''} onChange={e => setF({ mock_folder: e.target.value })} placeholder="https://drive.google.com/…" /></div>
              <div className="input-group"><label>Tracking link</label><input value={form.tracking_link || ''} onChange={e => setF({ tracking_link: e.target.value })} /></div>
              <div className="input-group"><label>Order details</label><textarea rows={5} value={form.description || ''} onChange={e => setF({ description: e.target.value })} placeholder="Product, sizes, delivery + billing details…" /></div>
              <div className="input-group"><label>Notes</label><textarea rows={2} value={form.notes || ''} onChange={e => setF({ notes: e.target.value })} /></div>

              <div style={{ display: 'flex', gap: 10 }}>
                <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : (form.id ? 'Save changes' : 'Create order')}</button>
                <button className="btn btn-secondary" onClick={() => setForm(null)}>Cancel</button>
                {form.mock_folder && <a href={form.mock_folder} target="_blank" rel="noreferrer" className="btn btn-secondary" style={{ marginLeft: 'auto' }}>🎨 Mock folder</a>}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
