import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useApi } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import { openLabels } from './common'

const pinOf = (text) => (String(text || '').match(/\b[1-9]\d{5}\b/) || [])[0] || ''

/**
 * A Delhivery shipment typed in rather than taken from a Shopify order: a replacement, a marketing
 * parcel, a support re-send. Used from Shipping, a support ticket and a marketing order; `prefill`
 * carries what those already know, and `prefill.source_ref` ("support:12", "marketing:40") makes
 * the AWB land back on the ticket or order.
 */
export default function ManualShipDrawer({ prefill = {}, onClose, onDone }) {
  const apiFetch = useApi()
  const toast = useToast()
  const [boxes, setBoxes] = useState([])
  const [f, setF] = useState(() => ({
    name: prefill.name || '', phone: String(prefill.phone || '').replace(/\D/g, '').slice(-10),
    address: prefill.address || '', city: prefill.city || '', state: prefill.state || '',
    pincode: prefill.pincode || pinOf(prefill.address),
    products: prefill.products || '', quantity: prefill.quantity || 1, value: prefill.value || '',
    payment_mode: 'Prepaid', cod_amount: '', box: '', weight_g: '', l: '', b: '', h: '',
    shipping_mode: 'Surface', order_number: prefill.order_number || '',
  }))
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const set = (patch) => setF(x => ({ ...x, ...patch }))
  const [filling, setFilling] = useState(false)
  /** The address on the Shopify order, for a replacement of it. */
  const fillFromOrder = async () => {
    setFilling(true)
    const r = await apiFetch('/api/shipping/quote', { method: 'POST', body: JSON.stringify({ order_number: f.order_number.trim() }) })
    setFilling(false)
    if (!r || r.error || !r.facts) return toast.error(r?.error || 'Could not read that order')
    const x = r.facts
    set({ name: x.name || f.name, phone: x.phone || f.phone, address: x.add || f.address, city: x.city || f.city, state: x.state || f.state, pincode: x.pin || f.pincode,
      products: f.products || x.products_desc || '', quantity: f.quantity > 1 ? f.quantity : (x.quantity || 1), value: f.value || x.total_amount || '' })
    toast.success('Filled from the order')
  }

  useEffect(() => {
    apiFetch('/api/shipping/settings').then(r => {
      if (!r?.settings) return
      setBoxes(r.settings.boxes || [])
      setF(x => ({ ...x, box: x.box || r.settings.default_box || '', shipping_mode: r.settings.default_mode || x.shipping_mode }))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const missing = [
    !f.name.trim() && 'name', !/^[6-9]\d{9}$/.test(f.phone) && 'a valid mobile', f.address.trim().length < 8 && 'address',
    !f.city.trim() && 'city', !/^[1-9]\d{5}$/.test(f.pincode) && 'pincode', !(Number(f.value) > 0) && 'declared value',
    f.payment_mode === 'COD' && !(Number(f.cod_amount) > 0) && 'COD amount',
  ].filter(Boolean)

  const submit = async () => {
    setBusy(true)
    const r = await apiFetch('/api/shipping/manual', { method: 'POST', body: JSON.stringify({ ...f, source_ref: prefill.source_ref }) })
    setBusy(false)
    if (!r || r.error) return toast.error(r?.error || 'Delhivery refused the shipment')
    setResult(r)
    toast.success(`AWB ${r.awb} created`)
    onDone?.(r)
  }

  // Rendered on the page itself: it opens from inside other drawers (a ticket, a marketing order),
  // whose own layout would otherwise clip it.
  return createPortal(
    <div className="drawer-overlay" style={{ zIndex: 400 }} onClick={onClose}>
      <div className="drawer" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="New shipment">
        <div className="drawer-header">
          <div>
            <h2 style={{ margin: 0, fontSize: 18 }}>New Delhivery shipment</h2>
            <p className="packed-sub" style={{ margin: '4px 0 0', maxWidth: 'none' }}>{prefill.context || 'A replacement, a marketing parcel, or anything not on a Shopify order'}</p>
          </div>
          <button className="btn-icon" onClick={onClose} aria-label="Close"><Icon name="close" size={18} /></button>
        </div>

        {result ? (
          <>
            <div className="drawer-body">
              <section className="ship-card" style={{ borderColor: 'color-mix(in srgb, var(--success) 40%, transparent)' }}>
                <h3 style={{ color: 'var(--success)' }}>AWB created</h3>
                <div className="ship-ok"><b>{result.ref}</b><span className="ship-mono">{result.awb}</span></div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => openLabels(apiFetch, toast, { awbs: [result.awb] })}><Icon name="printer" size={14} /> Print label (4×6)</button>
                  <a className="btn btn-secondary btn-sm" href={result.tracking_url} target="_blank" rel="noreferrer"><Icon name="external" size={14} /> Tracking</a>
                </div>
                {prefill.source_ref && <p className="packed-sub" style={{ maxWidth: 'none', margin: 0 }}>The AWB has been saved on the {prefill.source_ref.startsWith('support') ? 'ticket' : 'marketing order'}.</p>}
              </section>
              {result.warnings?.map((w, i) => <div key={i} className="ship-alert warning" style={{ margin: 0 }}><span>{w}</span></div>)}
            </div>
            <div className="drawer-footer"><button className="btn btn-primary" onClick={onClose}>Done</button></div>
          </>
        ) : (
          <>
            <div className="drawer-body">
              <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <p className="ship-section-title">Deliver to</p>
                <div className="form-row">
                  <div className="input-group"><label htmlFor="ms-name">Name</label><input id="ms-name" value={f.name} onChange={e => set({ name: e.target.value })} /></div>
                  <div className="input-group"><label htmlFor="ms-phone">Mobile</label><input id="ms-phone" inputMode="tel" placeholder="10 digits" value={f.phone} onChange={e => set({ phone: e.target.value })} /></div>
                </div>
                {f.order_number.trim() && (
                  <button type="button" className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} onClick={fillFromOrder} disabled={filling}>
                    <Icon name="refresh" size={14} /> {filling ? 'Reading the order…' : `Fill from ${f.order_number.trim()}`}
                  </button>
                )}
                <div className="input-group"><label htmlFor="ms-add">Address</label>
                  <textarea id="ms-add" rows={2} value={f.address} onChange={e => set({ address: e.target.value, pincode: f.pincode || pinOf(e.target.value) })} /></div>
                <div className="form-row">
                  <div className="input-group"><label htmlFor="ms-city">City</label><input id="ms-city" value={f.city} onChange={e => set({ city: e.target.value })} /></div>
                  <div className="input-group"><label htmlFor="ms-state">State</label><input id="ms-state" value={f.state} onChange={e => set({ state: e.target.value })} /></div>
                  <div className="input-group"><label htmlFor="ms-pin">Pincode</label><input id="ms-pin" inputMode="numeric" maxLength={6} value={f.pincode} onChange={e => set({ pincode: e.target.value.replace(/\D/g, '') })} /></div>
                </div>
              </section>

              <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <p className="ship-section-title">What's in it</p>
                <div className="input-group"><label htmlFor="ms-prod">Products</label>
                  <input id="ms-prod" placeholder="e.g. Dr Doom Hoodie - Green / M" value={f.products} onChange={e => set({ products: e.target.value })} /></div>
                <div className="form-row">
                  <div className="input-group"><label htmlFor="ms-qty">Pieces</label><input id="ms-qty" type="number" min="1" value={f.quantity} onChange={e => set({ quantity: e.target.value })} /></div>
                  <div className="input-group"><label htmlFor="ms-val">Declared value (₹)</label><input id="ms-val" type="number" min="1" value={f.value} onChange={e => set({ value: e.target.value })} /></div>
                  <div className="input-group"><label htmlFor="ms-ord">Order <span className="label-hint">optional</span></label><input id="ms-ord" placeholder="#13584" value={f.order_number} onChange={e => set({ order_number: e.target.value })} /></div>
                </div>
              </section>

              <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <p className="ship-section-title">Payment</p>
                <div className="form-row">
                  <div className="input-group"><label htmlFor="ms-pay">Payment</label>
                    <select id="ms-pay" value={f.payment_mode} onChange={e => set({ payment_mode: e.target.value })}><option>Prepaid</option><option>COD</option></select></div>
                  {f.payment_mode === 'COD' && <div className="input-group"><label htmlFor="ms-cod">Collect (₹)</label><input id="ms-cod" type="number" min="1" value={f.cod_amount} onChange={e => set({ cod_amount: e.target.value })} /></div>}
                </div>
              </section>

              <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <p className="ship-section-title">Packaging</p>
                {boxes.length > 0 && (
                  <div className="ship-pills" role="radiogroup" aria-label="Packaging">
                    {boxes.map(b => (
                      <button key={b.key} type="button" role="radio" aria-checked={f.box === b.key} className={`ship-pill ${f.box === b.key ? 'active' : ''}`} onClick={() => set({ box: b.key, l: '', b: '', h: '' })}>
                        {b.name}<small>{b.l}×{b.b}×{b.h} cm</small>
                      </button>
                    ))}
                  </div>
                )}
                <div className="form-row">
                  <div className="input-group"><label htmlFor="ms-w">Weight (g) <span className="label-hint">blank: worked out</span></label><input id="ms-w" type="number" min="50" value={f.weight_g} onChange={e => set({ weight_g: e.target.value })} /></div>
                  <div className="input-group"><label htmlFor="ms-mode">Mode</label>
                    <select id="ms-mode" value={f.shipping_mode} onChange={e => set({ shipping_mode: e.target.value })}><option>Surface</option><option>Express</option></select></div>
                </div>
                <div className="form-row">
                  {[['l', 'Length'], ['b', 'Breadth'], ['h', 'Height']].map(([k, label]) => (
                    <div className="input-group" key={k}><label htmlFor={`ms-${k}`}>{label} cm <span className="label-hint">optional</span></label>
                      <input id={`ms-${k}`} type="number" min="1" placeholder={boxes.find(b => b.key === f.box)?.[k] ?? ''} value={f[k]} onChange={e => set({ [k]: e.target.value })} /></div>
                  ))}
                </div>
              </section>
            </div>
            <div className="drawer-footer" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              {missing.length > 0 && <p className="packed-sub" style={{ margin: 0, maxWidth: 'none' }}>Still needed: {missing.join(', ')}.</p>}
              <p className="packed-sub" style={{ margin: 0, maxWidth: 'none' }}>This creates a real Delhivery shipment, charged to the wallet.</p>
              <div style={{ display: 'flex', gap: 10 }}>
                <button className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }} disabled={busy || missing.length > 0} onClick={submit}>{busy ? 'Creating…' : 'Create shipment and get label'}</button>
                <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  , document.body)
}
