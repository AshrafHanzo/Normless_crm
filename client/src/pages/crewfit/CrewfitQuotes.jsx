import { useState, useEffect, useRef } from 'react'
import useServerTable from '../../hooks/useServerTable'
import SortTh from '../../components/SortTh'
import Pagination from '../../components/Pagination'
import { useNavigate } from 'react-router-dom'
import { useApi } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import CrewfitOrderDrawer from './CrewfitOrderDrawer'
import { cleanMobile, mobileError, isValidMobile, mobileInputProps } from '../../utils/phone'

const fmt = (v) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v || 0)
const blankItem = () => ({ product_id: '', qty: '', price_per_piece: '', printing_placement: '', printing_type: '' })

function toWaNumber(phone) {
  let digits = (phone || '').replace(/\D/g, '')
  if (!digits) return null
  if (digits.length === 10) digits = '91' + digits
  else if (digits.length === 11 && digits.startsWith('0')) digits = '91' + digits.slice(1)
  return digits
}

const buildQuoteMessage = (quote) => {
  const items = (quote.line_items || []).map(li => `• ${li.product_name} × ${li.qty} pcs — ${fmt(li.price_per_piece)}/pc = ${fmt(li.line_total)}`).join('\n')
  return `Hi ${quote.customer_name}! 👕\n\nHere's your Crewfit order quote:\n\n${items}\n\nShipping (${quote.zone_label}): ${fmt(quote.shipping_charge)}\nGST (5%): ${fmt(quote.gst_amount)}\nGrand Total: ${fmt(quote.grand_total)}\n\nPlease reply "OK" to confirm and we'll get your order started! 🙌`
}

// Local calendar parts, not toISOString() — before 05:30 IST the UTC date is still yesterday.
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

// Builds a new-order prefill (same shape CrewfitOrderDrawer's blankOrder()/openEdit() expect)
// from a saved quote — the SO reviews/edits it in the normal order form; nothing is created
// until they hit Save there.
const prefillOrderFromQuote = (quote) => ({
  customer_name: quote.customer_name,
  contact_number: quote.contact_number,
  whatsapp_number: quote.contact_number,
  order_date: todayStr(),
  status: 'Awaiting Payment',
  payment_status: 'Pending',
  layout_status: 'Pending',
  customer_type: 'New',
  ship_region: quote.zone_label || 'Tamil Nadu',
  shipping: quote.shipping_charge,
  notes: quote.notes ? `${quote.notes} (from quote #${quote.id})` : `From quote #${quote.id}`,
  line_items: (quote.line_items || []).map(li => ({
    product: li.product_name, color: '', printing: 'Front & Back',
    qty: li.qty, unit_price: li.price_per_piece, product_total: li.line_total, size_breakdown: '',
  })),
})

const statusClass = (s) => (s === 'Paid' || s === 'Converted' ? 'fulfilled' : s === 'Sent' ? 'pending' : 'refunded')

export default function CrewfitQuotes() {
  const apiFetch = useApi()
  const toast = useToast()
  const navigate = useNavigate()
  const [meta, setMeta] = useState(null)
  const [items, setItems] = useState([blankItem()])
  const [zoneId, setZoneId] = useState('')
  // Blank means "use the zone table". A typed figure overrides it for this quote only.
  const [shippingOverride, setShippingOverride] = useState('')
  const [customerName, setCustomerName] = useState('')
  const [contactNumber, setContactNumber] = useState('')
  const [notes, setNotes] = useState('')
  const [calc, setCalc] = useState(null)
  const [calculating, setCalculating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [activeQuote, setActiveQuote] = useState(null)
  const [quotes, setQuotes] = useState([])
  const [loadingQuotes, setLoadingQuotes] = useState(true)
  // Server-side sort + page — the list used to be a hard-capped "recent 200".
  const qt = useServerTable({ sort: 'created_at', dir: 'desc' })
  const [copiedId, setCopiedId] = useState(null)
  const [target, setTarget] = useState(null) // for CrewfitOrderDrawer: null | prefilled order object
  const confirmingQuoteId = useRef(null)
  const debounceRef = useRef(null)

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadQuotes() }, [qt.key])

  useEffect(() => {
    apiFetch('/api/crewfit/quotes/meta').then(m => setMeta(m && m.products ? m : null))
  }, [])

  const loadQuotes = async () => {
    setLoadingQuotes(true)
    const r = await apiFetch('/api/crewfit/quotes?' + qt.query())
    setQuotes(r?.quotes || [])
    if (r?.pagination) qt.setPagination(r.pagination)
    setLoadingQuotes(false)
  }

  useEffect(() => {
    clearTimeout(debounceRef.current)
    const valid = items.filter(it => it.product_id && Number(it.qty) > 0)
    if (!valid.length) { setCalc(null); return }
    debounceRef.current = setTimeout(async () => {
      setCalculating(true)
      const r = await apiFetch('/api/crewfit/quotes/calculate', {
        method: 'POST',
        body: JSON.stringify({
          items: valid.map(it => ({
            product_id: it.product_id, qty: it.qty, price_per_piece: it.price_per_piece || undefined,
            printing_placement: it.printing_placement, printing_type: it.printing_type,
          })),
          zoneId, shippingCharge: shippingOverride,
        }),
      })
      setCalc(r && !r.error ? r : null)
      setCalculating(false)
    }, 300)
    return () => clearTimeout(debounceRef.current)
  }, [items, zoneId, shippingOverride])

  const setItem = (i, patch) => setItems(list => list.map((it, idx) => idx === i ? { ...it, ...patch } : it))
  // Everything the printed quotation carries beyond a name and a number. All optional — a quote is
  // often raised before any of this exists, and a blank field is left off the PDF entirely.
  const [buyer, setBuyer] = useState({ company_name: '', contact_person: '', email: '', gstin: '', delivery_address: '', delivery_date: '' })
  const setB = (patch) => setBuyer(b => ({ ...b, ...patch }))
  const [showBuyer, setShowBuyer] = useState(false)

  const addItem = () => setItems(list => [...list, blankItem()])
  const removeItem = (i) => setItems(list => list.length > 1 ? list.filter((_, idx) => idx !== i) : list)

  const saveQuote = async () => {
    setError('')
    if (!customerName.trim() || !contactNumber.trim()) { setError('Customer name and phone are required'); return }
    if (!isValidMobile(contactNumber)) { setError('Phone must be exactly 10 digits'); return }
    if (!calc || calc.needsManualQuote) { setError('Fix the items/zone above first — every line needs a price per piece before a quote can be saved'); return }
    setSaving(true)
    const valid = items.filter(it => it.product_id && Number(it.qty) > 0)
    const r = await apiFetch('/api/crewfit/quotes', {
      method: 'POST',
      body: JSON.stringify({
        customer_name: customerName.trim(), contact_number: contactNumber.trim(), notes: notes.trim(),
        ...buyer,
        items: valid.map(it => ({
          product_id: it.product_id, qty: it.qty, price_per_piece: it.price_per_piece || undefined,
          printing_placement: it.printing_placement, printing_type: it.printing_type,
        })), zoneId, shippingCharge: shippingOverride,
      }),
    })
    setSaving(false)
    if (r?.error) { setError(r.error); return }
    toast.success(`Quote for ${r.customer_name} saved — ${fmt(r.grand_total)}`)
    setActiveQuote(r)
    loadQuotes()
  }

  const sendWhatsApp = async (quote) => {
    const num = toWaNumber(quote.contact_number)
    const msg = encodeURIComponent(buildQuoteMessage(quote))
    window.open(num ? `https://wa.me/${num}?text=${msg}` : `https://wa.me/?text=${msg}`, '_blank')
    if (quote.status === 'Draft') {
      const r = await apiFetch(`/api/crewfit/quotes/${quote.id}`, { method: 'PUT', body: JSON.stringify({ status: 'Sent' }) })
      if (r && !r.error) { if (activeQuote?.id === quote.id) setActiveQuote(r); loadQuotes() }
    }
  }

  const copyQuote = (quote, key) => {
    navigator.clipboard?.writeText(buildQuoteMessage(quote))
    setCopiedId(key)
    setTimeout(() => setCopiedId(c => c === key ? null : c), 1500)
  }

  const downloadQuotePdf = async (quote) => {
    const res = await apiFetch(`/api/crewfit/quotes/${quote.id}/pdf`, { responseType: 'blob' })
    if (!res || res.error) { toast.error(res?.error || 'Failed to generate PDF'); return }
    const url = URL.createObjectURL(res.blob)
    const a = document.createElement('a')
    a.href = url; a.download = res.filename || `Quote-${quote.id}.pdf`
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
  }

  // "Customer said ok" — opens the normal order form pre-filled from the quote. Nothing is
  // created until the SO reviews it and hits Save inside that form.
  const startConfirm = (quote) => {
    confirmingQuoteId.current = quote.id
    setTarget(prefillOrderFromQuote(quote))
  }

  const handleOrderSaved = async (order) => {
    setTarget(null)
    const qid = confirmingQuoteId.current
    confirmingQuoteId.current = null
    if (qid && order?.id) {
      await apiFetch(`/api/crewfit/quotes/${qid}/link-order`, { method: 'POST', body: JSON.stringify({ orderId: order.id }) })
      if (activeQuote?.id === qid) setActiveQuote(null)
      loadQuotes()
      if (await toast.confirm({ title: 'Order created', message: `Order CF-${order.sl_no ?? ''} has been created from this quote.`, confirmLabel: 'Open in Bulk Orders', cancelLabel: 'Stay here' })) navigate(`/crewfit/orders?focus=${order.id}`)
    } else {
      loadQuotes()
    }
  }

  const resetForm = () => {
    setItems([blankItem()]); setZoneId(''); setCustomerName(''); setContactNumber(''); setNotes(''); setCalc(null); setActiveQuote(null); setError('')
  }

  const deleteQuote = async (quote) => {
    if (!await toast.confirm({
      title: `Delete the quote for ${quote.customer_name}?`,
      message: `This can't be undone.${quote.converted_order_id ? '\nThe order it was converted to is not affected.' : ''}`,
      confirmLabel: 'Delete quote', danger: true,
    })) return
    const r = await apiFetch(`/api/crewfit/quotes/${quote.id}`, { method: 'DELETE' })
    if (r?.error) { toast.error(r.error); return }
    toast.success('Quote deleted')
    if (activeQuote?.id === quote.id) setActiveQuote(null)
    loadQuotes()
  }

  return (
    <div className="page-enter">
      <div className="dash-toolbar">
        <div><h1>Crewfit · Quotes</h1><p style={{ color: 'var(--text-muted)' }}>Price a bulk order and send it on WhatsApp — the order is only created once the customer confirms</p></div>
      </div>

      <div className="dash-row charts" style={{ alignItems: 'flex-start' }}>
        <div className="panel">
          <div className="panel-head"><div className="panel-title">Line items</div></div>
          <div className="panel-body">
            {!meta ? <div className="loader"><div className="spinner" /></div> : (
              <>
                {items.map((it, i) => {
                  const suggestion = calc?.lineItems.find(li => String(li.product_id) === String(it.product_id) && String(li.qty) === String(Number(it.qty) || 0))
                  return (
                    <div key={i} className="calc-item-row">
                      <select value={it.product_id} onChange={e => setItem(i, { product_id: e.target.value })}>
                        <option value="">Select product…</option>
                        {meta.products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                      <input type="number" min="1" placeholder="Qty" value={it.qty} onChange={e => setItem(i, { qty: e.target.value })} style={{ width: 80 }} />
                      <input type="number" min="0" step="0.01"
                        placeholder={suggestion?.price_per_piece != null ? `${suggestion.price_per_piece}/pc` : '₹/pc'}
                        title={suggestion?.is_estimated ? 'Suggested price — outside the standard qty tiers, edit if needed' : undefined}
                        className={suggestion?.is_estimated && !it.price_per_piece ? 'calc-price-estimated' : ''}
                        value={it.price_per_piece} onChange={e => setItem(i, { price_per_piece: e.target.value })} style={{ width: 90 }} />
                      <button type="button" className="btn-icon" onClick={() => removeItem(i)} disabled={items.length === 1} title="Remove"><Icon name="close" size={14} /></button>
                      {/* Optional, and free text: placements and print methods vary per job, and a
                          picklist would only get worked around in the notes. */}
                      <input className="calc-print" value={it.printing_placement}
                        onChange={e => setItem(i, { printing_placement: e.target.value })}
                        placeholder="Placement (optional) — e.g. Front chest, Back" />
                      <input className="calc-print" value={it.printing_type}
                        onChange={e => setItem(i, { printing_type: e.target.value })}
                        placeholder="Print type (optional) — e.g. DTF, Screen print" />
                    </div>
                  )
                })}
                <button type="button" className="btn btn-secondary btn-sm" onClick={addItem} style={{ marginTop: 8 }}><Icon name="plus" size={14} /> Add product</button>

                <div className="form-row" style={{ marginTop: 18 }}>
                  <div className="input-group" style={{ marginBottom: 0 }}>
                    <label>Shipping zone</label>
                    <select value={zoneId} onChange={e => setZoneId(e.target.value)}>
                      <option value="">Select destination…</option>
                      {meta.zones.map(z => <option key={z} value={z}>{z}</option>)}
                    </select>
                  </div>
                  <div className="input-group" style={{ marginBottom: 0 }}>
                    <label>
                      Shipping charge
                      {calc && zoneId && !calc.shippingIsManual && <span className="label-hint"> · {fmt(calc.suggestedShipping)} from the zone table</span>}
                      {calc?.shippingIsManual && <span className="label-hint"> · overriding {fmt(calc.suggestedShipping)}</span>}
                    </label>
                    <input type="number" min="0" step="0.01" value={shippingOverride}
                      onChange={e => setShippingOverride(e.target.value)}
                      placeholder={zoneId ? `${calc?.suggestedShipping ?? 0} — leave blank to use this` : 'Type a charge, or pick a zone'} />
                  </div>
                </div>

                <div className="form-row">
                  <div className="input-group" style={{ marginBottom: 0 }}><label>Customer name</label><input value={customerName} onChange={e => setCustomerName(e.target.value)} placeholder="e.g. Rahul Sports Club" /></div>
                  <div className="input-group" style={{ marginBottom: 0 }}><label>Phone</label>
                    <input {...mobileInputProps} value={contactNumber} onChange={e => setContactNumber(cleanMobile(e.target.value))} />
                    {mobileError(contactNumber) && <div className="field-error">{mobileError(contactNumber)}</div>}</div>
                </div>
                <div className="input-group"><label>Notes (optional)</label><input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Shown on the quotation, under the items" /></div>

                {/* Folded away by default: most quotes are priced and sent before the buyer's
                    paperwork exists, and an eight-field form would be in the way every time. */}
                <button type="button" className="mini-btn" onClick={() => setShowBuyer(v => !v)}>
                  {showBuyer ? '− Hide' : '+ Add'} details for the printed quotation
                </button>
                {showBuyer && (
                  <div style={{ marginTop: 12 }}>
                    <div className="form-row">
                      <div className="input-group"><label>Company name</label>
                        <input value={buyer.company_name} onChange={e => setB({ company_name: e.target.value })} placeholder="Heaven Structures Private Limited" /></div>
                      <div className="input-group"><label>Contact person</label>
                        <input value={buyer.contact_person} onChange={e => setB({ contact_person: e.target.value })} placeholder="Nanthini Poulraj (HR Manager)" /></div>
                    </div>
                    <div className="form-row">
                      <div className="input-group"><label>Email</label>
                        <input value={buyer.email} onChange={e => setB({ email: e.target.value })} placeholder="hr@company.com" /></div>
                      <div className="input-group"><label>Buyer GSTIN</label>
                        <input value={buyer.gstin} onChange={e => setB({ gstin: e.target.value.toUpperCase() })} placeholder="33AAECH1552M1ZM" /></div>
                    </div>
                    <div className="input-group"><label>Delivery address</label>
                      <input value={buyer.delivery_address} onChange={e => setB({ delivery_address: e.target.value })} placeholder="Full address the goods ship to" /></div>
                    <div className="input-group"><label>Delivery date</label>
                      <input type="date" value={buyer.delivery_date} onChange={e => setB({ delivery_date: e.target.value })} />
                      <span className="label-hint">Printed on the quotation and in the payment terms. Left off if blank.</span></div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head"><div className="panel-title">Live calculation</div>{calculating && <span className="panel-sub">calculating…</span>}</div>
          <div className="panel-body">
            {!calc ? <div className="empty-state" style={{ padding: '30px 0' }}>Add a product and quantity to see pricing</div> : (
              <>
                <div className="calc-breakdown">
                  {calc.lineItems.map((li, i) => (
                    <div className="calc-line" key={i}>
                      <span>{li.product_name} × {li.qty} {li.needs_quote ? '' : `@ ${fmt(li.price_per_piece)}/pc`}{li.is_estimated && <em title="Suggested price — outside the standard qty tiers" className="calc-estimated-tag">est.</em>}</span>
                      <span>{li.needs_quote ? <em style={{ color: 'var(--warning)' }}>enter a price</em> : fmt(li.line_total)}</span>
                    </div>
                  ))}
                  <div className="calc-line">
                    <span>Shipping{calc.zoneLabel ? ` (${calc.zoneLabel})` : ''}{calc.shippingIsManual ? ' · edited' : ''}</span>
                    <span>{(zoneId || calc.shippingIsManual) ? fmt(calc.shippingCharge) : <em style={{ color: 'var(--text-muted)' }}>pick a zone or type a charge</em>}</span>
                  </div>
                  <div className="calc-line"><span>GST ({calc.gstPct}%)</span><span>{fmt(calc.gstAmount)}</span></div>
                  <div className="calc-line calc-total"><span>Grand total</span><span>{fmt(calc.grandTotal)}</span></div>
                </div>
                {calc.needsManualQuote && <div className="calc-warning">Enter a price per piece for each highlighted item{(!zoneId && !calc.shippingIsManual) ? ', and either pick a shipping zone or type a shipping charge' : ''} before saving.</div>}

                {error && <div className="login-error" style={{ marginTop: 12 }}>{error}</div>}

                {!activeQuote ? (
                  <button className="btn btn-primary" style={{ marginTop: 16, width: '100%' }} disabled={saving || calc.needsManualQuote} onClick={saveQuote}>
                    {saving ? 'Saving…' : 'Save quote'}
                  </button>
                ) : (
                  <div className="quote-result">
                    <div className="quote-result-head"><Icon name="check" size={16} /> Quote saved</div>
                    <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '0 0 10px' }}>Send it on WhatsApp — once the customer confirms, find it in the table below and hit Confirm to create the order.</p>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button className="btn btn-primary btn-sm" onClick={() => sendWhatsApp(activeQuote)}>Send via WhatsApp</button>
                      <button className="btn btn-secondary btn-sm" onClick={() => copyQuote(activeQuote, 'active')}>{copiedId === 'active' ? 'Copied!' : 'Copy text'}</button>
                      <button className="btn btn-secondary btn-sm" onClick={() => downloadQuotePdf(activeQuote)}>Download PDF</button>
                    </div>
                    <button className="btn btn-secondary btn-sm" style={{ marginTop: 10 }} onClick={resetForm}>New quote</button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <div className="glass-card" style={{ marginTop: 24 }}>
        <h3 style={{ marginBottom: 16 }}>Quotes</h3>
        {loadingQuotes ? <div className="loader"><div className="spinner" /></div> : (
          <table className="data-table">
            <thead><tr>
              <SortTh label="Customer" col="customer_name" sort={qt.sort} onSort={qt.toggle} />
              <SortTh label="Items" />
              <SortTh label="Total" col="grand_total" sort={qt.sort} onSort={qt.toggle} align="right" />
              <SortTh label="Status" col="status" sort={qt.sort} onSort={qt.toggle} />
              <SortTh label="Order" />
              <SortTh label="" />
            </tr></thead>
            <tbody>
              {quotes.map(q => (
                <tr key={q.id}>
                  <td className="cell-primary"><div style={{ fontWeight: 600 }}>{q.customer_name}</div><div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{q.contact_number}</div></td>
                  <td data-label="Items" style={{ fontSize: 12.5, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{(q.line_items || []).map(li => `${li.product_name} ×${li.qty}`).join(', ')}</td>
                  <td data-label="Total" style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(q.grand_total)}</td>
                  <td data-label="Status"><span className={`status-badge ${statusClass(q.status)}`}>{q.status}</span></td>
                  <td data-label="Order">{q.converted_order_id ? <span className="badge-primary" style={{ cursor: 'pointer' }} onClick={() => navigate(`/crewfit/orders?focus=${q.converted_order_id}`)}>#{q.converted_order_id}</span> : '—'}</td>
                  <td className="cell-actions">
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      {!q.converted_order_id && (<>
                        <button className="btn-icon" title="Copy quote text" onClick={() => copyQuote(q, q.id)}>{copiedId === q.id ? <Icon name="check" size={14} /> : <Icon name="copy" size={14} />}</button>
                        <button className="btn-icon" title="Send via WhatsApp" onClick={() => sendWhatsApp(q)}><Icon name="phone" size={14} /></button>
                        <button className="btn-icon" title="Download PDF" onClick={() => downloadQuotePdf(q)}><Icon name="download" size={14} /></button>
                        <button className="btn btn-secondary btn-sm" onClick={() => startConfirm(q)}>Confirm</button>
                      </>)}
                      <button className="btn-icon" title="Delete quote" onClick={() => deleteQuote(q)} style={{ color: 'var(--danger)' }}><Icon name="trash" size={14} /></button>
                    </div>
                  </td>
                </tr>
              ))}
              {!quotes.length && <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '24px 0' }}>No quotes yet</td></tr>}
            </tbody>
          </table>
        )}
        {!loadingQuotes && <Pagination table={qt} noun="quotes" />}
      </div>

      <CrewfitOrderDrawer target={target} onClose={() => { setTarget(null); confirmingQuoteId.current = null }} onSaved={handleOrderSaved} />
    </div>
  )
}
