import { useState, useEffect, useMemo } from 'react'
import { useApi } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import useDirtyGuard from '../../hooks/useDirtyGuard'

const fmt = (v) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v || 0)
const blankItem = () => ({ product_id: '', qty: '', price_per_piece: '', printing_placement: '', printing_type: '' })

/**
 * Build a quotation from a WhatsApp chat.
 *
 * The same calculator and the same saved quote as the Quotes page (/api/crewfit/quotes): prices
 * come off the catalog tiers, shipping off the zone table, GST at 5%, and a typed price or shipping
 * charge wins. What the chat already knows — the product they asked about, how many, their
 * billing details — is filled in, so a rep only checks it and presses send.
 */
export default function WaQuoteDrawer({ thread, onClose, onSaved }) {
  const apiFetch = useApi()
  const toast = useToast()
  const [meta, setMeta] = useState(null)
  const [items, setItems] = useState([blankItem()])
  const [zoneId, setZoneId] = useState('')
  const [shipping, setShipping] = useState('')
  const [notes, setNotes] = useState('')
  const [buyer, setBuyer] = useState(() => ({
    customer_name: thread.billing_name || thread.lead_company || thread.lead_name || thread.profile_name || '',
    company_name: thread.billing_name || thread.lead_company || '',
    contact_person: thread.contact_person || thread.lead_name || thread.profile_name || '',
    email: thread.billing_email || '',
    gstin: /^na$/i.test(thread.gst_number || '') ? '' : (thread.gst_number || ''),
    delivery_address: thread.delivery_address || thread.billing_address || '',
  }))
  const [calc, setCalc] = useState(null)
  const [saving, setSaving] = useState(null)   // 'draft' | 'send'

  const guard = useDirtyGuard({ snapshot: { items, zoneId, shipping, notes, buyer }, identity: 'quote', onDiscard: onClose, confirm: toast.confirm })

  // The catalog, and a first line from what the customer asked for.
  useEffect(() => {
    apiFetch('/api/crewfit/quotes/meta').then(m => {
      if (!m || !m.products) return toast.error('Could not load the catalog')
      setMeta(m)
      const want = String(thread.product_interest || '').toLowerCase()
      const match = want && m.products.find(p => p.name.toLowerCase() === want)
        || (want && m.products.find(p => want.includes(p.name.toLowerCase()) || p.name.toLowerCase().includes(want)))
      // Only a plain number is a quantity; "50-200" or "Under 50" is a range the rep turns into one.
      const qty = /^\s*\d+\s*(pcs|pieces|nos)?\s*$/i.test(String(thread.quantity || '')) ? parseInt(thread.quantity, 10) : ''
      if (match || qty) {
        const first = { ...blankItem(), product_id: match ? String(match.id) : '', qty: String(qty || ''),
          printing_type: /embroid/i.test(thread.branding || '') ? 'Embroidery' : /print/i.test(thread.branding || '') ? 'Printing' : '' }
        setItems([first])
        guard.reset({ items: [first], zoneId: '', shipping: '', notes: '', buyer })
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Live pricing, a moment after the last keystroke.
  const payload = useMemo(() => ({ items, zoneId, shippingCharge: shipping }), [items, zoneId, shipping])
  useEffect(() => {
    if (!items.some(it => it.product_id && Number(it.qty) > 0)) return
    const t = setTimeout(async () => {
      const r = await apiFetch('/api/crewfit/quotes/calculate', { method: 'POST', body: JSON.stringify(payload) })
      if (r && !r.error) setCalc(r)
    }, 350)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload])
  const hasLines = items.some(it => it.product_id && Number(it.qty) > 0)
  const shown = hasLines ? calc : null

  const setItem = (i, patch) => setItems(list => list.map((it, j) => (j === i ? { ...it, ...patch } : it)))
  const setB = (patch) => setBuyer(b => ({ ...b, ...patch }))

  const save = async (andSend) => {
    if (!buyer.customer_name.trim()) return toast.error('The quote needs a customer name')
    setSaving(andSend ? 'send' : 'draft')
    const phone = String(thread.phone || '').slice(-10)
    const r = await apiFetch('/api/crewfit/quotes', {
      method: 'POST',
      body: JSON.stringify({ ...buyer, contact_number: phone, items, zoneId, shippingCharge: shipping, notes, wa_lead_id: thread.lead_id }),
    })
    setSaving(null)
    if (!r || r.error) return toast.error(r?.error || 'Could not save the quote')
    guard.reset()
    onSaved(r, andSend)
  }

  const priceFor = (i) => {
    const it = items[i]
    return shown?.lineItems?.find(li => String(li.product_id) === String(it.product_id) && li.qty === (parseInt(it.qty, 10) || 0))
  }

  return (
    <div className="drawer-overlay" onClick={guard.requestClose}>
      <aside className="drawer drawer-wide" role="dialog" aria-label="New quote" onClick={e => e.stopPropagation()}>
        <div className="drawer-header">
          <div>
            <h2>New quote</h2>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>For {thread.display_name} — priced off the catalog tiers, sent as a PDF in the chat</div>
          </div>
          <button type="button" className="btn-icon" aria-label="Close" onClick={guard.requestClose}><Icon name="close" size={16} /></button>
        </div>
        <div className="drawer-body">
          {!meta ? <div className="loader"><div className="spinner" /></div> : (
            <>
              <div className="form-section" style={{ margin: 0 }}>Products</div>
              {items.map((it, i) => {
                const p = priceFor(i)
                return (
                  <div key={i} className="form-item-row">
                    <div className="form-row wq-item">
                      <div className="input-group">
                        <label htmlFor={`wq-p-${i}`}>Product</label>
                        <select id={`wq-p-${i}`} value={it.product_id} onChange={e => setItem(i, { product_id: e.target.value })}>
                          <option value="">Select product…</option>
                          {meta.products.map(pr => <option key={pr.id} value={pr.id}>{pr.name}</option>)}
                        </select>
                      </div>
                      <div className="input-group">
                        <label htmlFor={`wq-q-${i}`}>Qty</label>
                        <input id={`wq-q-${i}`} type="number" min="1" value={it.qty} onChange={e => setItem(i, { qty: e.target.value })}
                          placeholder={i === 0 && thread.quantity ? `Asked: ${thread.quantity}` : ''} />
                      </div>
                      <div className="input-group">
                        <label htmlFor={`wq-r-${i}`}>₹ / piece</label>
                        <input id={`wq-r-${i}`} type="number" min="0" step="0.01" value={it.price_per_piece}
                          placeholder={p?.price_per_piece != null && !it.price_per_piece ? `${p.price_per_piece}` : 'From tiers'}
                          onChange={e => setItem(i, { price_per_piece: e.target.value })} />
                      </div>
                      <div className="input-group">
                        <label htmlFor={`wq-pl-${i}`}>Placement</label>
                        <input id={`wq-pl-${i}`} value={it.printing_placement} placeholder="Front chest, back"
                          onChange={e => setItem(i, { printing_placement: e.target.value })} />
                      </div>
                      <div className="input-group">
                        <label htmlFor={`wq-t-${i}`}>Print type</label>
                        <input id={`wq-t-${i}`} value={it.printing_type} placeholder="DTF, embroidery"
                          onChange={e => setItem(i, { printing_type: e.target.value })} />
                      </div>
                    </div>
                    <button type="button" className="btn-icon" aria-label={`Remove product ${i + 1}`} disabled={items.length === 1}
                      onClick={() => setItems(list => list.filter((_, j) => j !== i))}><Icon name="trash" size={14} /></button>
                  </div>
                )
              })}
              <button type="button" className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }}
                onClick={() => setItems(list => [...list, blankItem()])}><Icon name="plus" size={14} /> Add product</button>

              <div className="form-row">
                <div className="input-group">
                  <label htmlFor="wq-zone">Shipping to</label>
                  <select id="wq-zone" value={zoneId} onChange={e => setZoneId(e.target.value)}>
                    <option value="">Select destination…</option>
                    {meta.zones.map(z => <option key={z} value={z}>{z}</option>)}
                  </select>
                </div>
                <div className="input-group">
                  <label htmlFor="wq-ship">Shipping charge{shown && zoneId && !shown.shippingIsManual ? ` · ${fmt(shown.suggestedShipping)} from the zone table` : ''}</label>
                  <input id="wq-ship" type="number" min="0" step="0.01" value={shipping} placeholder={zoneId ? 'Leave blank to use the zone rate' : 'Type a charge, or pick a zone'}
                    onChange={e => setShipping(e.target.value)} />
                </div>
              </div>

              <div className="wq-totals" aria-live="polite">
                {!shown ? <span className="was-hint">Pick a product and quantity to see the price.</span> : (
                  <>
                    {shown.lineItems.map((li, i) => (
                      <div key={i} className="wq-line">
                        <span>{li.product_name} × {li.qty}{li.needs_quote ? '' : ` @ ${fmt(li.price_per_piece)}`}{li.is_estimated && <em className="calc-estimated-tag">est.</em>}</span>
                        <span>{li.needs_quote ? <em style={{ color: 'var(--warning)' }}>enter a price</em> : fmt(li.line_total)}</span>
                      </div>
                    ))}
                    <div className="wq-line"><span>Shipping{shown.zoneLabel ? ` (${shown.zoneLabel})` : ''}</span><span>{fmt(shown.shippingCharge)}</span></div>
                    <div className="wq-line"><span>GST ({shown.gstPct}%)</span><span>{fmt(shown.gstAmount)}</span></div>
                    <div className="wq-line wq-grand"><span>Grand total</span><span>{fmt(shown.grandTotal)}</span></div>
                    {shown.needsManualQuote && <div className="wq-warn">Enter a price for each highlighted item, and pick a shipping zone or type a charge.</div>}
                  </>
                )}
              </div>

              <div className="form-section" style={{ margin: 0 }}>On the quotation</div>
              <div className="form-row">
                <div className="input-group"><label htmlFor="wq-name">Customer name *</label>
                  <input id="wq-name" value={buyer.customer_name} onChange={e => setB({ customer_name: e.target.value })} /></div>
                <div className="input-group"><label htmlFor="wq-co">Company</label>
                  <input id="wq-co" value={buyer.company_name} onChange={e => setB({ company_name: e.target.value })} /></div>
                <div className="input-group"><label htmlFor="wq-cp">Contact person</label>
                  <input id="wq-cp" value={buyer.contact_person} onChange={e => setB({ contact_person: e.target.value })} /></div>
              </div>
              <div className="form-row">
                <div className="input-group"><label htmlFor="wq-em">Email</label>
                  <input id="wq-em" value={buyer.email} onChange={e => setB({ email: e.target.value })} /></div>
                <div className="input-group"><label htmlFor="wq-gst">GSTIN</label>
                  <input id="wq-gst" value={buyer.gstin} onChange={e => setB({ gstin: e.target.value.toUpperCase() })} /></div>
              </div>
              <div className="input-group"><label htmlFor="wq-del">Delivery address</label>
                <input id="wq-del" value={buyer.delivery_address} onChange={e => setB({ delivery_address: e.target.value })} /></div>
              <div className="input-group"><label htmlFor="wq-notes">Notes</label>
                <input id="wq-notes" value={notes} placeholder="Shown on the quotation, under the items" onChange={e => setNotes(e.target.value)} /></div>

            </>
          )}
        </div>
        <div className="drawer-footer">
          <button type="button" className="btn btn-secondary" disabled={!!saving || !shown || shown.needsManualQuote} onClick={() => save(false)}>
            {saving === 'draft' ? 'Saving…' : 'Save draft'}
          </button>
          <button type="button" className="btn btn-primary" disabled={!!saving || !shown || shown.needsManualQuote || !thread.window_open}
            title={thread.window_open ? '' : 'The chat is past the 24-hour window — save a draft and send it once they write'}
            onClick={() => save(true)}>
            {saving === 'send' ? 'Saving…' : 'Save & send PDF'}
          </button>
        </div>
      </aside>
    </div>
  )
}
