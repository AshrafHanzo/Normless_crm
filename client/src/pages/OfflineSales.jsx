import { useState, useEffect } from 'react'
import { useApi, useAuth } from '../App'
import { useToast } from '../components/Toast'
import Icon from '../components/Icon'
import SearchSelect from '../components/SearchSelect'
import Pagination from '../components/Pagination'
import useServerTable from '../hooks/useServerTable'
import useDirtyGuard from '../hooks/useDirtyGuard'
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

// Indian mobile → wa.me wants digits only, with the country code.
function toWaNumber(phone) {
  let d = (phone || '').replace(/\D/g, '')
  if (!d) return null
  if (d.length === 10) d = '91' + d
  else if (d.length === 11 && d.startsWith('0')) d = '91' + d.slice(1)
  return d
}

/**
 * Copy, with the old trick behind the modern API.
 *
 * `navigator.clipboard` only exists in a secure context, so on a plain-http LAN address — which is
 * exactly how a counter machine tends to reach this app — it is simply undefined. The hidden
 * textarea still works there, and the boolean lets the caller say plainly when neither did.
 */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch { /* not a secure context, or permission refused — fall through */ }
  try {
    const el = document.createElement('textarea')
    el.value = text
    el.setAttribute('readonly', '')
    el.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
    document.body.appendChild(el)
    el.select()
    const ok = document.execCommand('copy')
    el.remove()
    return ok
  } catch { return false }
}

const linkMessage = (sale, link) => [
  `Hi ${sale.customer_name || 'there'}! 👋`, '',
  `Here is the payment link for your order ${sale.ref}:`,
  link, '',
  `Amount: ${money(sale.total)}`, '',
  'Thank you!',
].join('\n')

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
  const [pay, setPay] = useState(null)         // { sale, mode, method, amount, reference, link }
  const [copied, setCopied] = useState(false)   // inside the payment dialog
  const [copiedRow, setCopiedRow] = useState(null)
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

  // A half-filled sale is several minutes of typing; a stray click on the overlay should not
  // take it away. Only genuine edits prompt — see useDirtyGuard.
  const guard = useDirtyGuard({
    // Only the fields this form actually saves. Payment lives on the same record but is changed
    // by its own calls, so leaving it out is what stops a link raised from inside the drawer
    // from reading as an unsaved edit.
    snapshot: form && {
      customer_name: form.customer_name, contact_number: form.contact_number, email: form.email,
      address: form.address, items: form.items, discount: form.discount, shipping: form.shipping,
      status: form.status, notes: form.notes, mot: form.mot, awb: form.awb,
    },
    identity: form ? (form.id ?? 'new') : null,
    onDiscard: () => setForm(null),
    confirm: toast.confirm,
    title: 'Discard this sale?',
    message: 'What you have filled in will be lost.',
  })

  // Mirrors the server's arithmetic so the total moves as you type; the server still recomputes it.
  const totals = (() => {
    if (!form) return null
    const items = form.items.filter(it => it.product && Number(it.qty) > 0)
    const subtotal = items.reduce((n, it) => n + (Number(it.unit_price) || 0) * (Number(it.qty) || 0), 0)
    const discount = Math.min(Number(form.discount) || 0, subtotal)
    const shipping = Number(form.shipping) || 0
    return { subtotal, discount, shipping, total: subtotal - discount + shipping, qty: items.reduce((n, it) => n + Number(it.qty), 0) }
  })()

  const save = async (e) => {
    e?.preventDefault?.()
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
    guard.reset()
    setForm(null); load()
  }

  /**
   * Fold a payment response back into the drawer, when the drawer is showing that same sale.
   *
   * The list reloads either way; this is what stops the open form from still saying "no link"
   * a moment after one was raised from inside it. Only the payment fields are taken — anything
   * being typed in the form is left alone.
   */
  const patchOpenForm = (row) => setForm(f => (f && f.id === row.id ? {
    ...f,
    payment_status: row.payment_status, payment_method: row.payment_method,
    payment_ref: row.payment_ref, paid_amount: row.paid_amount,
    razorpay_short_url: row.razorpay_short_url,
  } : f))

  const openPayment = (sale, mode) => {
    setCopied(false)
    setPay({
      sale, mode: mode || (sale.razorpay_short_url ? 'link' : 'record'),
      method: 'Cash', amount: sale.total, reference: '',
      // From the row, an existing link opens straight onto the link itself — the usual reason for
      // coming back to a sale that has one is to send it again. Asking for a mode overrides that.
      link: mode ? null : (sale.razorpay_short_url || null),
    })
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
      // The dialog stays open on the link, because a link nobody can reach the customer with
      // is not worth creating.
      const ok = await copyText(res.link)
      setCopied(ok)
      toast.success(ok ? 'Payment link created and copied' : 'Payment link created — copy it below',
        { title: 'Ready to send' })
      setPay(v => ({ ...v, link: res.link, sale: { ...v.sale, razorpay_short_url: res.link } }))
      patchOpenForm(res)
      load()
      return
    }
    toast.success(`${res.ref} marked ${res.payment_status.toLowerCase()}`)
    patchOpenForm(res)
    setPay(null); load()
  }

  const copyLink = async () => {
    const ok = await copyText(pay.link)
    setCopied(ok)
    if (!ok) { toast.error('Could not copy — select the link and copy it by hand'); return }
    setTimeout(() => setCopied(false), 2000)
  }

  const sendLink = () => {
    const n = toWaNumber(pay.sale.contact_number)
    const msg = encodeURIComponent(linkMessage(pay.sale, pay.link))
    window.open(n ? `https://wa.me/${n}?text=${msg}` : `https://wa.me/?text=${msg}`, '_blank')
  }

  const copyRowLink = async (sale) => {
    const ok = await copyText(sale.razorpay_short_url)
    if (!ok) { toast.error('Could not copy — open the sale and copy it from there'); return }
    setCopiedRow(sale.id)
    setTimeout(() => setCopiedRow(null), 2000)
  }

  const sendRowLink = (sale) => {
    const n = toWaNumber(sale.contact_number)
    const msg = encodeURIComponent(linkMessage(sale, sale.razorpay_short_url))
    window.open(n ? `https://wa.me/${n}?text=${msg}` : `https://wa.me/?text=${msg}`, '_blank')
  }

  const syncPayment = async (sale) => {
    const res = await apiFetch(`/api/offline-sales/${sale.id}/payment/sync`, { method: 'POST', body: JSON.stringify({}) })
    if (!res || res.error) { toast.error(res?.error || 'Failed'); return }
    toast[res.settled ? 'success' : 'info'](res.settled ? `${res.ref} is paid` : `Link is still ${res.link_status}`)
    patchOpenForm(res)
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
                    {/* The link, in full, on the row — a link you have to go looking for is a
                        link that does not get sent. */}
                    {x.razorpay_short_url && (
                      <div className="os-row-link" onClick={e => e.stopPropagation()}>
                        {/* The scheme is noise in a table cell this narrow, and without it the
                            link fits on one line. Copy still takes the whole thing. */}
                        <a className="pay-link" href={x.razorpay_short_url} target="_blank" rel="noreferrer">
                          {x.razorpay_short_url.replace(/^https?:\/\//, '')}
                        </a>
                        <button className="btn-icon" title="Copy the payment link" onClick={() => copyRowLink(x)}>
                          <Icon name={copiedRow === x.id ? 'check' : 'copy'} size={13} />
                        </button>
                        <button className="btn-icon" title="Send it on WhatsApp" onClick={() => sendRowLink(x)}>
                          <Icon name="phone" size={13} />
                        </button>
                      </div>
                    )}
                  </td>
                  <td data-label="Status"><span className={`status-badge ${STATUS_CLASS[x.status] || 'pending'}`}>{x.status}</span></td>
                  <td data-label="Date" style={{ fontSize: 12 }}>{day(x.created_at)}</td>
                  <td className="cell-actions" style={{ textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                      {canEdit && x.payment_status !== 'Paid' && (
                        <button className="mini-btn mini-btn-active" onClick={() => openPayment(x)}>
                          {x.razorpay_short_url ? 'Send link' : 'Payment'}
                        </button>
                      )}
                      {canEdit && x.razorpay_short_url && x.payment_status !== 'Paid' && (
                        <button className="mini-btn" onClick={() => syncPayment(x)}>Check link</button>
                      )}
                      {isAdmin && <button className="mini-btn mini-btn-danger" onClick={() => remove(x)}>Delete</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {!!sales.length && <Pagination table={t} noun="sales" />}

      {/* ---- The sale ------------------------------------------------------------------
          A drawer rather than a modal: this form runs to four sections and a variable number of
          product lines, which is more than a centred card can hold without the save button
          drifting off the bottom of the screen. */}
      {form && (
        <div className="drawer-overlay" onClick={guard.requestClose}>
          <div className="drawer drawer-wide" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="drawer-header">
              <h2>{form.id ? `Sale ${form.ref}` : 'New offline sale'}</h2>
              <button type="button" className="btn-icon" onClick={guard.requestClose}><Icon name="close" size={16} /></button>
            </div>

            <div className="drawer-body">
              <form id="os-sale-form" onSubmit={save}>
                <div className="form-section" style={{ marginTop: 0 }}>Customer</div>
                <div className="form-row">
                  <div className="input-group"><label>Name *</label>
                    <input value={form.customer_name} autoFocus onChange={e => setF({ customer_name: e.target.value })} /></div>
                  <div className="input-group"><label>Phone</label>
                    <input value={form.contact_number || ''} onChange={e => setF({ contact_number: e.target.value })} /></div>
                  <div className="input-group"><label>Email <span className="label-hint">optional</span></label>
                    <input value={form.email || ''} onChange={e => setF({ email: e.target.value })} /></div>
                </div>
                <div className="input-group"><label>Address <span className="label-hint">optional</span></label>
                  <input value={form.address || ''} onChange={e => setF({ address: e.target.value })} /></div>

                <div className="form-section">Products
                  <span className="unit-hint">Prices start at Shopify’s and can be changed</span>
                </div>
                {form.items.map((it, i) => {
                  const p = product(it.shopify_product_id)
                  const changed = it.shopify_price != null && Number(it.unit_price) !== Number(it.shopify_price)
                  return (
                    <div className="form-item-row item-cols-4" key={i}>
                      <div className="form-row">
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
                        <div className="input-group">
                          <label>Qty</label>
                          <input type="number" min="1" value={it.qty} onChange={e => setItem(i, { qty: e.target.value })} />
                        </div>
                        <div className="input-group">
                          <label>Price each</label>
                          <input type="number" min="0" value={it.unit_price} onChange={e => setItem(i, { unit_price: e.target.value })} />
                          {changed && <span className="label-hint">Shopify: ₹{it.shopify_price}</span>}
                        </div>
                      </div>
                      {form.items.length > 1 && (
                        <button type="button" className="btn-icon" title="Remove this line"
                          onClick={() => setF({ items: form.items.filter((_, j) => j !== i) })}>
                          <Icon name="trash" size={14} />
                        </button>
                      )}
                    </div>
                  )
                })}
                <button type="button" className="mini-btn form-item-add"
                  onClick={() => setF({ items: [...form.items, blankItem()] })}>+ Another product</button>

                <div className="form-section">Money</div>
                <div className="form-row">
                  <div className="input-group"><label>Discount (₹)</label>
                    <input type="number" min="0" value={form.discount} onChange={e => setF({ discount: e.target.value })} /></div>
                  <div className="input-group"><label>Shipping (₹)</label>
                    <input type="number" min="0" value={form.shipping} onChange={e => setF({ shipping: e.target.value })} /></div>
                  <div className="input-group"><label>Status</label>
                    <select value={form.status} onChange={e => setF({ status: e.target.value })}>
                      {(data?.statuses || []).map(x => <option key={x}>{x}</option>)}
                    </select></div>
                </div>
                {!!totals && (
                  <div className="totals-bar">
                    <div><span>Pieces</span><strong>{num(totals.qty)}</strong></div>
                    <div><span>Subtotal</span><strong>{money(totals.subtotal)}</strong></div>
                    {totals.discount > 0 && <div><span>Discount</span><strong style={{ color: 'var(--warning)' }}>−{money(totals.discount)}</strong></div>}
                    {totals.shipping > 0 && <div><span>Shipping</span><strong>{money(totals.shipping)}</strong></div>}
                    <div><span>Total</span><strong style={{ color: 'var(--success)' }}>{money(totals.total)}</strong></div>
                  </div>
                )}
                <p className="img-upload-hint" style={{ marginTop: 10 }}>
                  Blanks come off the shelf once the sale leaves Draft. A draft holds nothing.
                </p>

                {/* Payment lives on the sale, the same way it does on a Crewfit order: the link is
                    printed here in full so it can be read, copied and sent without hunting for it. */}
                {form.id && (() => {
                  const link = form.razorpay_short_url
                  const paid = form.payment_status === 'Paid'
                  const part = form.payment_status === 'Partial'
                  const state = paid ? 'issued' : 'ready'
                  return (
                    <>
                      <div className="form-section">Payment
                        <span className="unit-hint">Razorpay · a link stays unpaid until the money lands</span>
                      </div>
                      <div className={`invoice-card invoice-card-${state}`}>
                        <div className="invoice-card-head">
                          <span className="invoice-card-icon">{paid ? '✅' : link ? '🔗' : '💵'}</span>
                          {/* The big number is always the one that matters next: what is still
                              owed while it is owed, and what was taken once it has been. */}
                          <div className="invoice-card-heading">
                            <div className="invoice-card-title">{paid ? 'Paid in full' : part ? 'Still to collect' : 'Amount due'}</div>
                            <div className="invoice-card-amount">{money(paid ? form.paid_amount : form.total - (Number(form.paid_amount) || 0))}</div>
                            <div className="invoice-card-sub">
                              {part ? `${money(form.paid_amount)} of ${money(form.total)} taken · ${form.payment_method || 'recorded'}`
                                : paid ? `${form.payment_method || 'recorded'}${form.payment_ref ? ` · ${form.payment_ref}` : ''}`
                                  : 'Nothing collected yet'}
                            </div>
                          </div>
                          <span className={`invoice-status-pill invoice-status-${state}`}>{form.payment_status}</span>
                        </div>

                        {link && (
                          <div className="invoice-card-meta" style={{ display: 'block' }}>
                            <a className="pay-link" href={link} target="_blank" rel="noreferrer">{link}</a>
                            <div style={{ marginTop: 4 }}>
                              {paid ? 'Settled through this link' : 'Copy it or send it on WhatsApp — then check whether it has been paid'}
                            </div>
                          </div>
                        )}

                        <div className="pay-card-actions">
                          {link && (
                            <>
                              <button type="button" className="btn btn-secondary btn-sm" onClick={() => sendRowLink(form)}>💬 WhatsApp</button>
                              <button type="button" className="mini-btn" onClick={() => copyRowLink(form)}>
                                {copiedRow === form.id ? '✓ Copied' : '📋 Copy'}
                              </button>
                              {!paid && <button type="button" className="mini-btn" onClick={() => syncPayment(form)}>Check link</button>}
                            </>
                          )}
                          {!paid && (
                            <>
                              <button type="button" className="mini-btn mini-btn-active"
                                onClick={() => openPayment(form, 'record')}>💵 Record money taken</button>
                              <button type="button" className="mini-btn"
                                disabled={guard.dirty || data?.paymentsEnabled === false}
                                title={guard.dirty ? 'Save the sale first — a link is raised for the saved total' : ''}
                                onClick={() => openPayment(form, 'link')}>
                                {link ? '🔗 New link' : '🔗 Create a payment link'}
                              </button>
                            </>
                          )}
                        </div>
                        {guard.dirty && !paid && (
                          <span className="label-hint">Save the sale first — a link is raised for the saved total.</span>
                        )}
                      </div>
                    </>
                  )
                })()}

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
                <div className="input-group"><label>Note <span className="label-hint">optional</span></label>
                  <input value={form.notes || ''} onChange={e => setF({ notes: e.target.value })} /></div>
              </form>
            </div>

            <div className="drawer-footer">
              <button type="button" className="btn btn-secondary" onClick={guard.requestClose}>Cancel</button>
              <button type="submit" form="os-sale-form" className="btn btn-primary" disabled={busy}>
                {busy ? 'Saving…' : 'Save the sale'}
              </button>
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

            {pay.link ? (
              /* The link exists; the only thing left that matters is getting it to the customer. */
              <>
                <div className="input-group">
                  <label>Payment link</label>
                  <input readOnly value={pay.link} onFocus={e => e.target.select()} />
                </div>
                <div className="os-link-actions">
                  <button className="btn btn-secondary" onClick={copyLink}>
                    <Icon name={copied ? 'check' : 'copy'} size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                    {copied ? 'Copied' : 'Copy link'}
                  </button>
                  <button className="btn btn-secondary" onClick={sendLink}>
                    <Icon name="phone" size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                    {toWaNumber(pay.sale.contact_number) ? 'Send on WhatsApp' : 'Pick a WhatsApp chat'}
                  </button>
                  <button className="btn btn-secondary os-link-open" onClick={() => window.open(pay.link, '_blank', 'noopener')}>Open</button>
                </div>
                <p className="confirm-message" style={{ fontSize: 12.5, marginTop: 12 }}>
                  The sale stays unpaid until the money lands — use “Check link” on the row to ask
                  Razorpay, or create a fresh link for a different amount.
                </p>
                <button className="mini-btn" onClick={() => { setCopied(false); setPay(v => ({ ...v, link: null })) }}>
                  Take the money another way
                </button>
              </>
            ) : (
              <>
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
                      A Razorpay link is created and shown here to copy or send on WhatsApp.
                    </p>
                    {data?.paymentsEnabled === false && (
                      <div className="calc-warning">Razorpay is not configured, so a link cannot be created.</div>
                    )}
                  </>
                )}
              </>
            )}

            <div className="confirm-actions">
              {pay.link ? (
                <button className="btn btn-primary" onClick={() => setPay(null)}>Done</button>
              ) : (
                <>
                  <button className="btn btn-secondary" onClick={() => setPay(null)}>Cancel</button>
                  <button className="btn btn-primary" disabled={busy || (pay.mode === 'link' && data?.paymentsEnabled === false)} onClick={savePayment}>
                    {busy ? 'Saving…' : pay.mode === 'link' ? 'Create the link' : 'Record it'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
