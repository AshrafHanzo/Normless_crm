import { useState, useEffect, useRef } from 'react'
import { useApi } from '../../App'
import Icon from '../../components/Icon'

const fmt = (v) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v || 0)
const blankItem = () => ({ product_id: '', qty: '' })

function toWaNumber(phone) {
  let digits = (phone || '').replace(/\D/g, '')
  if (!digits) return null
  if (digits.length === 10) digits = '91' + digits
  else if (digits.length === 11 && digits.startsWith('0')) digits = '91' + digits.slice(1)
  return digits
}

const statusClass = (s) => (s === 'Paid' ? 'fulfilled' : s === 'Sent' ? 'pending' : 'refunded')

export default function CrewfitQuickCalc() {
  const apiFetch = useApi()
  const [meta, setMeta] = useState(null)
  const [items, setItems] = useState([blankItem()])
  const [zoneId, setZoneId] = useState('')
  const [customerName, setCustomerName] = useState('')
  const [contactNumber, setContactNumber] = useState('')
  const [notes, setNotes] = useState('')
  const [calc, setCalc] = useState(null)
  const [calculating, setCalculating] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [lastQuote, setLastQuote] = useState(null)
  const [quotes, setQuotes] = useState([])
  const [loadingQuotes, setLoadingQuotes] = useState(true)
  const debounceRef = useRef(null)

  useEffect(() => {
    apiFetch('/api/crewfit/quotes/meta').then(m => setMeta(m && m.products ? m : null))
    loadQuotes()
  }, [])

  const loadQuotes = async () => {
    setLoadingQuotes(true)
    const r = await apiFetch('/api/crewfit/quotes')
    setQuotes(r?.quotes || [])
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
        body: JSON.stringify({ items: valid.map(it => ({ product_id: it.product_id, qty: it.qty })), zoneId }),
      })
      setCalc(r && !r.error ? r : null)
      setCalculating(false)
    }, 300)
    return () => clearTimeout(debounceRef.current)
  }, [items, zoneId])

  const setItem = (i, patch) => setItems(list => list.map((it, idx) => idx === i ? { ...it, ...patch } : it))
  const addItem = () => setItems(list => [...list, blankItem()])
  const removeItem = (i) => setItems(list => list.length > 1 ? list.filter((_, idx) => idx !== i) : list)

  const productName = (id) => meta?.products.find(p => String(p.id) === String(id))?.name || ''

  const generateLink = async () => {
    setError('')
    if (!customerName.trim() || !contactNumber.trim()) { setError('Customer name and phone are required'); return }
    if (!calc || calc.needsManualQuote) { setError('Fix the items/zone above first — everything needs to price automatically before a payment link can be generated'); return }
    setCreating(true)
    const valid = items.filter(it => it.product_id && Number(it.qty) > 0)
    const r = await apiFetch('/api/crewfit/quotes', {
      method: 'POST',
      body: JSON.stringify({
        customer_name: customerName.trim(), contact_number: contactNumber.trim(), notes: notes.trim(),
        items: valid.map(it => ({ product_id: it.product_id, qty: it.qty })), zoneId,
      }),
    })
    setCreating(false)
    if (r?.error) { setError(r.error); return }
    setLastQuote(r)
    loadQuotes()
  }

  const copyLink = (url) => { navigator.clipboard?.writeText(url) }
  const sendWhatsApp = (quote) => {
    const num = toWaNumber(quote.contact_number)
    const items = (quote.line_items || []).map(li => `• ${li.product_name} × ${li.qty}`).join('\n')
    const msg = encodeURIComponent(
      `Hi ${quote.customer_name}! 🎉\n\nHere's your Crewfit order summary:\n\n${items}\n\nShipping (${quote.zone_label}): ${fmt(quote.shipping_charge)}\nTotal: ${fmt(quote.grand_total)}\n\nPay securely here to confirm your order:\n🔗 ${quote.razorpay_short_url}`
    )
    window.open(num ? `https://wa.me/${num}?text=${msg}` : `https://wa.me/?text=${msg}`, '_blank')
  }

  const resetForm = () => {
    setItems([blankItem()]); setZoneId(''); setCustomerName(''); setContactNumber(''); setNotes(''); setCalc(null); setLastQuote(null); setError('')
  }

  return (
    <div className="page-enter">
      <div className="dash-toolbar">
        <div><h1>Crewfit · Quick Calc</h1><p style={{ color: 'var(--text-muted)' }}>Price a bulk order, then send a payment link — the order is created automatically once it's paid</p></div>
      </div>

      <div className="dash-row charts" style={{ alignItems: 'flex-start' }}>
        <div className="panel">
          <div className="panel-head"><div className="panel-title">Line items</div></div>
          <div className="panel-body">
            {!meta ? <div className="loader"><div className="spinner" /></div> : (
              <>
                {items.map((it, i) => (
                  <div key={i} className="calc-item-row">
                    <select value={it.product_id} onChange={e => setItem(i, { product_id: e.target.value })}>
                      <option value="">Select product…</option>
                      {meta.products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                    <input type="number" min="1" placeholder="Qty" value={it.qty} onChange={e => setItem(i, { qty: e.target.value })} style={{ width: 90 }} />
                    <button type="button" className="btn-icon" onClick={() => removeItem(i)} disabled={items.length === 1} title="Remove"><Icon name="close" size={14} /></button>
                  </div>
                ))}
                <button type="button" className="btn btn-secondary btn-sm" onClick={addItem} style={{ marginTop: 8 }}><Icon name="plus" size={14} /> Add product</button>

                <div className="input-group" style={{ marginTop: 18 }}>
                  <label>Shipping zone</label>
                  <select value={zoneId} onChange={e => setZoneId(e.target.value)}>
                    <option value="">Select destination…</option>
                    {meta.zones.map(z => <option key={z} value={z}>{z}</option>)}
                  </select>
                </div>

                <div className="form-row">
                  <div className="input-group" style={{ marginBottom: 0 }}><label>Customer name</label><input value={customerName} onChange={e => setCustomerName(e.target.value)} placeholder="e.g. Rahul Sports Club" /></div>
                  <div className="input-group" style={{ marginBottom: 0 }}><label>Phone</label><input value={contactNumber} onChange={e => setContactNumber(e.target.value)} placeholder="10-digit mobile" /></div>
                </div>
                <div className="input-group"><label>Notes (optional)</label><input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Internal note for this quote" /></div>
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
                      <span>{li.product_name} × {li.qty}</span>
                      <span>{li.needs_quote ? <em style={{ color: 'var(--warning)' }}>needs manual quote</em> : fmt(li.line_total)}</span>
                    </div>
                  ))}
                  <div className="calc-line"><span>Shipping{calc.zoneLabel ? ` (${calc.zoneLabel})` : ''}</span><span>{zoneId ? fmt(calc.shippingCharge) : <em style={{ color: 'var(--text-muted)' }}>pick a zone</em>}</span></div>
                  <div className="calc-line calc-total"><span>Grand total</span><span>{fmt(calc.grandTotal)}</span></div>
                </div>
                {calc.needsManualQuote && <div className="calc-warning">Some items or the destination need manual pricing — an automatic payment link can't be generated until every line resolves to a price.</div>}

                {error && <div className="login-error" style={{ marginTop: 12 }}>{error}</div>}

                {!lastQuote ? (
                  <button className="btn btn-primary" style={{ marginTop: 16, width: '100%' }} disabled={creating || calc.needsManualQuote} onClick={generateLink}>
                    {creating ? 'Generating…' : 'Generate payment link'}
                  </button>
                ) : (
                  <div className="quote-result">
                    <div className="quote-result-head"><Icon name="check" size={16} /> Payment link ready</div>
                    <div className="quote-result-link">{lastQuote.razorpay_short_url || '— Razorpay keys not configured on the server —'}</div>
                    {lastQuote.razorpay_short_url && (
                      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                        <button className="btn btn-secondary btn-sm" onClick={() => copyLink(lastQuote.razorpay_short_url)}>Copy link</button>
                        <button className="btn btn-primary btn-sm" onClick={() => sendWhatsApp(lastQuote)}>Send via WhatsApp</button>
                      </div>
                    )}
                    <button className="btn btn-secondary btn-sm" style={{ marginTop: 10 }} onClick={resetForm}>New calculation</button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <div className="glass-card" style={{ marginTop: 24 }}>
        <h3 style={{ marginBottom: 16 }}>Recent quotes</h3>
        {loadingQuotes ? <div className="loader"><div className="spinner" /></div> : (
          <table className="data-table">
            <thead><tr><th>Customer</th><th>Items</th><th style={{ textAlign: 'right' }}>Total</th><th>Status</th><th>Order</th></tr></thead>
            <tbody>
              {quotes.map(q => (
                <tr key={q.id}>
                  <td><div style={{ fontWeight: 600 }}>{q.customer_name}</div><div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{q.contact_number}</div></td>
                  <td style={{ fontSize: 12.5, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{(q.line_items || []).map(li => `${li.product_name} ×${li.qty}`).join(', ')}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(q.grand_total)}</td>
                  <td><span className={`status-badge ${statusClass(q.status)}`}>{q.status}</span></td>
                  <td>{q.converted_order_id ? <span className="badge-primary">#{q.converted_order_id}</span> : '—'}</td>
                </tr>
              ))}
              {!quotes.length && <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '24px 0' }}>No quotes yet</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
