import { useState, useEffect } from 'react'
import { useApi, useAuth } from '../App'
import { useToast } from '../components/Toast'
import Icon from '../components/Icon'
import SearchSelect from '../components/SearchSelect'
import Pagination from '../components/Pagination'
import useServerTable from '../hooks/useServerTable'
import SortTh from '../components/SortTh'

const money = (v) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(v) || 0)
const num = (v) => new Intl.NumberFormat('en-IN').format(Number(v) || 0)
const day = (v) => (v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—')

const STATUS_CLASS = {
  Draft: 'pending', Confirmed: 'info', 'In Production': 'warning',
  Dispatched: 'info', Delivered: 'success', Cancelled: 'danger',
}
const PAY_CLASS = { Unpaid: 'danger', Partial: 'warning', Paid: 'success' }

const blankItem = () => ({ product: '', variant: '', qty: 1, unit_price: '', shopify_price: null, shopify_product_id: '', shopify_variant_id: '', blank_type: '', color: '', size: '' })
const blankSale = () => ({
  customer_name: '', contact_number: '', email: '', address: '',
  items: [blankItem()], discount: 0, shipping: 0, status: 'Draft', notes: '',
})

/**
 * Sales made away from Shopify — the counter, an event, a phone order.
 *
 * The catalogue and the starting price are Shopify's, because it is the same garment; everything
 * after that is ours. The price is editable on purpose, since an offline sale is exactly where a
 * discount gets given, and the shop price stays visible beside it so the discount reads as one.
 */
export default function OfflineSales() {
  const apiFetch = useApi()
  const toast = useToast()
  const { user } = useAuth()
  const isAdmin = ['owner', 'admin'].includes(user?.role)

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [catalog, setCatalog] = useState(null)
  const [form, setForm] = useState(null)       // the sale being created or edited
  const [pay, setPay] = useState(null)         // { sale, mode, method, amount, reference }
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const t = useServerTable({ sort: 'created_at', dir: 'desc', limit: 25 })

  const load = async () => {
    const r = await apiFetch('/api/offline-sales?' + t.query({ search, ...(status && { status }) }))
    if (r && !r.error) { setData(r); t.setPagination(r.pagination) }
    else if (r?.error) toast.error(r.error)
    setLoading(false)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [t.key, status])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { const id = setTimeout(() => { t.resetPage(); load() }, 350); return () => clearTimeout(id) }, [search])

  const openForm = async (sale) => {
    setForm(sale ? { ...sale, items: sale.items.length ? sale.items : [blankItem()] } : blankSale())
    if (!catalog) {
      const r = await apiFetch('/api/offline-sales/catalog')
      if (r && !r.error) setCatalog(r.products)
    }
  }
  const setF = (patch) => setForm(f => ({ ...f, ...patch }))
  const setItem = (i, patch) => setForm(f => ({ ...f, items: f.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) }))

  // Mirrors the server's arithmetic so the total moves as you type; the server still recomputes it.
  const totals = (() => {
    if (!form) return null
    const items = form.items.filter(it => it.product && Number(it.qty) > 0)
    const subtotal = items.reduce((n, it) => n + (Number(it.unit_price) || 0) * (Number(it.qty) || 0), 0)
    const discount = Math.min(Number(form.discount) || 0, subtotal)
    const shipping = Number(form.shipping) || 0
    return { subtotal, discount, shipping, total: subtotal - discount + shipping, qty: items.reduce((n, it) => n + Number(it.qty), 0) }
  })()

  const save = async () => {
    if (!form.customer_name.trim()) { toast.error('Customer name is required'); return }
    const items = form.items.filter(it => it.product && Number(it.qty) > 0)
    if (!items.length) { toast.error('Add at least one product'); return }
    setBusy(true)
    const body = JSON.stringify({ ...form, items })
    const res = form.id
      ? await apiFetch(`/api/offline-sales/${form.id}`, { method: 'PUT', body })
      : await apiFetch('/api/offline-sales', { method: 'POST', body })
    setBusy(false)
    if (!res || res.error) { toast.error(res?.error || 'Failed to save'); return }

    const moved = (res.inventory?.deducted || []).map(d => `${d.color} ${d.size} −${d.qty}`).join(', ')
    toast.success(`${res.ref} saved · ${money(res.total)}` + (moved ? ` — blanks: ${moved}` : ''))
    if (res.inventory?.unmapped?.length) {
      toast.error(res.inventory.unmapped.map(u => `${u.product} — ${u.reason}`).join(' · '),
        { title: 'Not deducted from blank stock', duration: 0 })
    }
    setForm(null); load()
  }

  const savePayment = async () => {
    setBusy(true)
    const res = await apiFetch(`/api/offline-sales/${pay.sale.id}/payment`, {
      method: 'POST',
      body: JSON.stringify(pay.mode === 'link'
        ? { mode: 'link', amount: Number(pay.amount) || pay.sale.total }
        : { mode: 'record', method: pay.method, amount: Number(pay.amount) || pay.sale.total, reference: pay.reference }),
    })
    setBusy(false)
    if (!res || res.error) { toast.error(res?.error || 'Failed'); return }
    if (pay.mode === 'link') {
      await navigator.clipboard?.writeText(res.link).catch(() => {})
      toast.success('Payment link created and copied — send it to the customer')
    } else {
      toast.success(`${res.ref} marked ${res.payment_status.toLowerCase()}`)
    }
    setPay(null); load()
  }

  const syncPayment = async (sale) => {
    const res = await apiFetch(`/api/offline-sales/${sale.id}/payment/sync`, { method: 'POST', body: JSON.stringify({}) })
    if (!res || res.error) { toast.error(res?.error || 'Failed'); return }
    toast[res.settled ? 'success' : 'info'](res.settled ? `${res.ref} is paid` : `Link is still ${res.link_status}`)
    load()
  }

  const remove = async (sale) => {
    if (!await toast.confirm({
      title: `Delete ${sale.ref}?`,
      message: 'Any blanks it took out of stock are given back.',
      details: [{ label: 'Customer', value: sale.customer_name }, { label: 'Total', value: money(sale.total) }],
      confirmLabel: 'Delete', danger: true,
    })) return
    const res = await apiFetch(`/api/offline-sales/${sale.id}`, { method: 'DELETE' })
    if (!res || res.error) { toast.error(res?.error || 'Failed'); return }
    toast.success('Sale deleted'); load()
  }

  if (loading && !data) return <div className="loader"><div className="spinner" /><span>Loading offline sales…</span></div>

  const sales = data?.sales || []
  const s = data?.summary || {}
  const canEdit = data?.canEdit
  const product = (id) => (catalog || []).find(p => String(p.shopify_id) === String(id))

  return (
    <div className="page-enter">
      <div className="dash-toolbar">
        <div>
          <h1>Offline Sales</h1>
          <p style={{ color: 'var(--text-muted)' }}>
            Sold at the counter, at an event, or over the phone. Products and prices come from
            Shopify; the price can be changed, and stock comes off the same shelf.
          </p>
        </div>
        {canEdit && (
          <button className="btn btn-primary" onClick={() => openForm(null)}>
            <Icon name="plus" size={15} style={{ marginRight: 6, verticalAlign: '-2px' }} />
            New sale
          </button>
        )}
      </div>

      <div className="kpi-grid" style={{ marginBottom: 18 }}>
        {[
          { icon: 'card', label: 'Sold offline', value: money(s.sold) },
          { icon: 'wallet', label: 'Still to collect', value: money(s.outstanding) },
          { icon: 'box', label: 'Sales', value: num(s.sales) },
          { icon: 'shirt', label: 'Units', value: num(s.units) },
        ].map(k => (
          <div className="kpi-card" key={k.label}>
            <div className="kpi-head"><div className="kpi-icon"><Icon name={k.icon} size={20} /></div></div>
            <div className="kpi-value">{k.value}</div>
            <div className="kpi-label">{k.label}</div>
          </div>
        ))}
      </div>

      <div className="filters-row">
        <div className="search-bar"><span className="search-icon" />
          <input placeholder="Search customer, phone or sale number…" value={search} onChange={e => setSearch(e.target.value)} /></div>
        <select value={status} onChange={e => setStatus(e.target.value)} style={{ width: 'auto' }}>
          <option value="">All statuses</option>
          {(data?.statuses || []).map(x => <option key={x}>{x}</option>)}
        </select>
      </div>

      <div className="data-table-wrapper">
        {!sales.length ? (
          <div className="empty-state">
            <div className="empty-icon">🧾</div>
            <p>No offline sales yet.{canEdit ? ' Record one and it comes off the same stock as a shop order.' : ''}</p>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <SortTh label="Sale" col="sale_no" sort={t.sort} onSort={t.toggle} />
                <SortTh label="Customer" col="customer_name" sort={t.sort} onSort={t.toggle} />
                <SortTh label="Items" />
                <SortTh label="Total" col="total" sort={t.sort} onSort={t.toggle} align="right" />
                <SortTh label="Payment" col="payment_status" sort={t.sort} onSort={t.toggle} />
                <SortTh label="Status" col="status" sort={t.sort} onSort={t.toggle} />
                <SortTh label="Date" col="created_at" sort={t.sort} onSort={t.toggle} />
                <SortTh label="" />
              </tr>
            </thead>
            <tbody>
              {sales.map(x => (
                <tr key={x.id} onClick={() => canEdit && openForm(x)} style={{ cursor: canEdit ? 'pointer' : 'default' }}>
                  <td className="cell-primary"><span className="badge-primary">{x.ref}</span></td>
                  <td data-label="Customer">
                    <div style={{ fontWeight: 500 }}>{x.customer_name}</div>
                    {x.contact_number && <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{x.contact_number}</div>}
                  </td>
                  <td data-label="Items" style={{ fontSize: 12.5 }}>
                    {x.items.slice(0, 2).map((it, i) => (
                      <div key={i}>{it.product} <span style={{ color: 'var(--text-muted)' }}>{it.variant} × {it.qty}</span></div>
                    ))}
                    {x.items.length > 2 && <div style={{ color: 'var(--text-muted)' }}>+{x.items.length - 2} more</div>}
                  </td>
                  <td data-label="Total" style={{ textAlign: 'right', fontWeight: 700 }}>{money(x.total)}</td>
                  <td data-label="Payment">
                    <span className={`status-badge ${PAY_CLASS[x.payment_status] || 'pending'}`}>{x.payment_status}</span>
                    {x.payment_method && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{x.payment_method}</div>}
                  </td>
                  <td data-label="Status"><span className={`status-badge ${STATUS_CLASS[x.status] || 'pending'}`}>{x.status}</span></td>
                  <td data-label="Date" style={{ fontSize: 12 }}>{day(x.created_at)}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} onClick={e => e.stopPropagation()}>
                    {canEdit && x.payment_status !== 'Paid' && (
                      <button className="mini-btn mini-btn-active"
                        onClick={() => setPay({ sale: x, mode: 'record', method: 'Cash', amount: x.total, reference: '' })}>
                        Payment
                      </button>
                    )}
                    {canEdit && x.razorpay_short_url && x.payment_status !== 'Paid' && (
                      <button className="mini-btn" style={{ marginLeft: 6 }} onClick={() => syncPayment(x)}>Check link</button>
                    )}
                    {isAdmin && <button className="mini-btn mini-btn-danger" style={{ marginLeft: 6 }} onClick={() => remove(x)}>Delete</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {!!sales.length && <Pagination table={t} noun="sales" />}

      {/* ---- The sale ------------------------------------------------------------------ */}
      {form && (
        <div className="confirm-overlay" onClick={() => setForm(null)}>
          <div className="confirm-card" style={{ maxWidth: 780 }} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
            <h3 className="confirm-title">{form.id ? `Sale ${form.ref}` : 'New offline sale'}</h3>

            <div className="form-row">
              <div className="input-group"><label>Customer name</label>
                <input value={form.customer_name} autoFocus onChange={e => setF({ customer_name: e.target.value })} /></div>
              <div className="input-group"><label>Phone</label>
                <input value={form.contact_number || ''} onChange={e => setF({ contact_number: e.target.value })} /></div>
            </div>
            <div className="form-row">
              <div className="input-group"><label>Email <span style={{ color: 'var(--text-muted)' }}>optional</span></label>
                <input value={form.email || ''} onChange={e => setF({ email: e.target.value })} /></div>
              <div className="input-group"><label>Address <span style={{ color: 'var(--text-muted)' }}>optional</span></label>
                <input value={form.address || ''} onChange={e => setF({ address: e.target.value })} /></div>
            </div>

            <div className="form-section">Products</div>
            {form.items.map((it, i) => {
              const p = product(it.shopify_product_id)
              const changed = it.shopify_price != null && Number(it.unit_price) !== Number(it.shopify_price)
              return (
                <div className="form-row" key={i} style={{ alignItems: 'end' }}>
                  <div className="input-group">
                    <label>Product</label>
                    <SearchSelect value={it.shopify_product_id} placeholder="Type to search Shopify products…"
                      options={(catalog || []).map(x => ({ value: x.shopify_id, label: x.title, hint: x.blank_type || '' }))}
                      onChange={(v, opt) => setItem(i, {
                        shopify_product_id: v, product: opt?.label || '', shopify_variant_id: '', variant: '',
                        unit_price: '', shopify_price: null,
                        blank_type: (catalog || []).find(x => String(x.shopify_id) === String(v))?.blank_type || '',
                      })} />
                  </div>
                  <div className="input-group">
                    <label>Colour / size</label>
                    <SearchSelect value={it.shopify_variant_id} disabled={!p}
                      placeholder={p ? 'Type to search…' : 'Pick a product first'}
                      options={(p?.variants || []).map(v => ({ value: v.variant_id, label: v.variant, hint: v.price != null ? `₹${v.price}` : '' }))}
                      onChange={(v) => {
                        const variant = p?.variants.find(x => String(x.variant_id) === String(v))
                        setItem(i, {
                          shopify_variant_id: v, variant: variant?.variant || '',
                          color: variant?.color || '', size: variant?.size || '',
                          // Starts at the shop price, and stays editable — that is the point.
                          unit_price: variant?.price ?? '', shopify_price: variant?.price ?? null,
                        })
                      }} />
                  </div>
                  <div className="input-group" style={{ maxWidth: 80 }}>
                    <label>Qty</label>
                    <input type="number" min="1" value={it.qty} onChange={e => setItem(i, { qty: e.target.value })} />
                  </div>
                  <div className="input-group" style={{ maxWidth: 120 }}>
                    <label>Price each</label>
                    <input type="number" min="0" value={it.unit_price} onChange={e => setItem(i, { unit_price: e.target.value })} />
                    {changed && <span className="label-hint">Shopify: ₹{it.shopify_price}</span>}
                  </div>
                  {form.items.length > 1 && (
                    <button className="mini-btn" style={{ marginBottom: 14 }}
                      onClick={() => setF({ items: form.items.filter((_, j) => j !== i) })}>×</button>
                  )}
                </div>
              )
            })}
            <button className="mini-btn" onClick={() => setF({ items: [...form.items, blankItem()] })}>+ Another product</button>

            <div className="form-row" style={{ marginTop: 12 }}>
              <div className="input-group"><label>Discount (₹)</label>
                <input type="number" min="0" value={form.discount} onChange={e => setF({ discount: e.target.value })} /></div>
              <div className="input-group"><label>Shipping (₹)</label>
                <input type="number" min="0" value={form.shipping} onChange={e => setF({ shipping: e.target.value })} /></div>
              <div className="input-group"><label>Status</label>
                <select value={form.status} onChange={e => setF({ status: e.target.value })}>
                  {(data?.statuses || []).map(x => <option key={x}>{x}</option>)}
                </select></div>
            </div>

            <div className="form-section">Dispatch</div>
            <div className="form-row">
              <div className="input-group"><label>How it goes out</label>
                <select value={form.mot || ''} onChange={e => setF({ mot: e.target.value })}>
                  <option value="">—</option>
                  {(data?.mots || []).map(m => <option key={m}>{m}</option>)}
                </select></div>
              <div className="input-group"><label>Tracking ID / AWB</label>
                <input value={form.awb || ''} onChange={e => setF({ awb: e.target.value })}
                  placeholder="Not needed for Porter or self pickup" /></div>
            </div>
            <div className="input-group"><label>Note <span style={{ color: 'var(--text-muted)' }}>optional</span></label>
              <input value={form.notes || ''} onChange={e => setF({ notes: e.target.value })} /></div>

            {!!totals && (
              <dl className="confirm-details">
                <div className="confirm-detail"><dt>Subtotal</dt><dd>{money(totals.subtotal)}</dd></div>
                {totals.discount > 0 && <div className="confirm-detail"><dt>Discount</dt><dd>−{money(totals.discount)}</dd></div>}
                {totals.shipping > 0 && <div className="confirm-detail"><dt>Shipping</dt><dd>{money(totals.shipping)}</dd></div>}
                <div className="confirm-detail"><dt>Total</dt><dd><b>{money(totals.total)}</b></dd></div>
              </dl>
            )}
            <p className="confirm-message" style={{ fontSize: 12.5 }}>
              Blanks come off the shelf once the sale leaves Draft. A draft holds nothing.
            </p>

            <div className="confirm-actions">
              <button className="btn btn-secondary" onClick={() => setForm(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save the sale'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ---- Money ---------------------------------------------------------------------- */}
      {pay && (
        <div className="confirm-overlay" onClick={() => setPay(null)}>
          <div className="confirm-card" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
            <h3 className="confirm-title">Payment for {pay.sale.ref}</h3>
            <p className="confirm-message">{pay.sale.customer_name} · {money(pay.sale.total)}</p>

            <div className="scan-tabs" style={{ marginBottom: 14 }}>
              <button className={pay.mode === 'record' ? 'active' : ''} onClick={() => setPay(v => ({ ...v, mode: 'record' }))}>Money taken</button>
              <button className={pay.mode === 'link' ? 'active' : ''} onClick={() => setPay(v => ({ ...v, mode: 'link' }))}>Send a link</button>
            </div>

            {pay.mode === 'record' ? (
              <>
                <div className="input-group">
                  <label>How</label>
                  <select value={pay.method} onChange={e => setPay(v => ({ ...v, method: e.target.value }))}>
                    {(data?.paymentMethods || []).filter(m => m !== 'Payment link').map(m => <option key={m}>{m}</option>)}
                  </select>
                </div>
                <div className="input-group">
                  <label>Amount</label>
                  <input type="number" min="1" value={pay.amount} onChange={e => setPay(v => ({ ...v, amount: e.target.value }))} />
                  <span className="label-hint">Anything less than the total is recorded as a part payment</span>
                </div>
                <div className="input-group">
                  <label>Reference <span style={{ color: 'var(--text-muted)' }}>optional</span></label>
                  <input value={pay.reference} placeholder="UPI ref, receipt number"
                    onChange={e => setPay(v => ({ ...v, reference: e.target.value }))} />
                </div>
              </>
            ) : (
              <>
                <div className="input-group">
                  <label>Amount to ask for</label>
                  <input type="number" min="1" value={pay.amount} onChange={e => setPay(v => ({ ...v, amount: e.target.value }))} />
                </div>
                <p className="confirm-message" style={{ fontSize: 12.5 }}>
                  A Razorpay link is created and copied to your clipboard to send on WhatsApp. The sale
                  stays unpaid until the money lands — use “Check link” to ask Razorpay.
                </p>
                {data?.paymentsEnabled === false && (
                  <div className="calc-warning">Razorpay is not configured, so a link cannot be created.</div>
                )}
              </>
            )}

            <div className="confirm-actions">
              <button className="btn btn-secondary" onClick={() => setPay(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || (pay.mode === 'link' && data?.paymentsEnabled === false)} onClick={savePayment}>
                {busy ? 'Saving…' : pay.mode === 'link' ? 'Create the link' : 'Record it'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
