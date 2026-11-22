import { useState, useEffect } from 'react'
import { useApi } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import { money, plural } from './common'

/**
 * Create Delhivery shipments for one order or many.
 *
 * One order: the drawer checks it first (address, phone, pincode, COD, charge) so a bad address
 * is caught here rather than as a failed manifest. Many orders: one box and mode for all, and the
 * server checks each; the result lists what failed and why, next to the labels for what worked.
 */
export default function ShipDrawer({ orders, settings, onClose, onDone }) {
  const apiFetch = useApi()
  const toast = useToast()
  const single = orders.length === 1 ? orders[0] : null
  const boxes = settings?.boxes || []
  const [box, setBox] = useState(boxes[0]?.key || '')
  const [weight, setWeight] = useState(boxes[0]?.grams || 500)
  const [mode, setMode] = useState(settings?.default_mode || 'Surface')
  const [payment, setPayment] = useState('')          // '' = as Shopify says
  const [cod, setCod] = useState('')
  const [quote, setQuote] = useState(null)
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)

  const pickBox = (b) => { setBox(b.key); setWeight(b.grams) }

  useEffect(() => {
    if (!single) return
    let live = true
    setChecking(true)
    const t = setTimeout(async () => {
      const r = await apiFetch('/api/shipping/quote', { method: 'POST', body: JSON.stringify({ order_number: single.order_number, box, weight_g: Number(weight), shipping_mode: mode, payment_mode: payment || undefined, cod_amount: cod === '' ? undefined : Number(cod) }) })
      if (!live) return
      setChecking(false)
      setQuote(r && !r.error ? r : { error: r?.error || 'Could not check this order' })
      if (r && !r.error && cod === '' && r.payment_mode === 'COD') setCod(String(r.cod_amount))
    }, 300)
    return () => { live = false; clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [single?.order_number, box, weight, mode, payment])

  const submit = async () => {
    setBusy(true)
    const items = orders.map(o => ({
      order_number: o.order_number, box, weight_g: Number(weight) || undefined, shipping_mode: mode,
      ...(single && payment ? { payment_mode: payment } : {}),
      ...(single && (payment || quote?.payment_mode) === 'COD' && cod !== '' ? { cod_amount: Number(cod) } : {}),
    }))
    const r = await apiFetch('/api/shipping/create', { method: 'POST', body: JSON.stringify({ items }) })
    setBusy(false)
    if (!r || r.error) return toast.error(r?.error || 'Could not create shipments')
    setResult(r)
    onDone?.()
    if (r.created.length && !r.failed.length) toast.success(`${plural(r.created.length, 'AWB')} created`)
  }

  const blocked = single && (checking || !quote || quote.error || quote.problems?.length)
  const effPayment = payment || quote?.payment_mode

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Create Delhivery shipment">
        <div className="drawer-header">
          <div>
            <h2 style={{ margin: 0, fontSize: 18 }}>{single ? `Ship ${single.order_number} with Delhivery` : `Ship ${orders.length} orders with Delhivery`}</h2>
            <p className="packed-sub" style={{ margin: '4px 0 0', maxWidth: 'none' }}>
              {single ? [single.customer_name, single.packed_at ? 'packed' : 'not packed yet'].filter(Boolean).join(' · ') : orders.map(o => o.order_number).slice(0, 6).join(', ') + (orders.length > 6 ? ` +${orders.length - 6}` : '')}
            </p>
          </div>
          <button className="btn-icon" onClick={onClose} aria-label="Close"><Icon name="close" size={18} /></button>
        </div>

        {result ? (
          <>
            <div className="drawer-body">
              {result.created.length > 0 && (
                <section className="ship-card" style={{ borderColor: 'color-mix(in srgb, var(--success) 40%, transparent)' }}>
                  <h3 style={{ color: 'var(--success)' }}>{plural(result.created.length, 'AWB')} created</h3>
                  {result.created.map(c => (
                    <div key={c.awb} className="ship-ok"><b>{c.order_number}</b><span className="ship-mono">{c.awb}</span></div>
                  ))}
                  {result.labels.length > 0 ? (
                    <div className="ship-label-list">
                      <p className="ship-section-title">Labels (4×6)</p>
                      {result.labels.map(l => (
                        <a key={l.waybill} className="btn btn-secondary btn-sm" href={l.url} target="_blank" rel="noreferrer">
                          <Icon name="printer" size={14} /> Open label {l.waybill.includes(',') ? `for ${l.waybill.split(',').length}` : l.waybill}
                        </a>
                      ))}
                    </div>
                  ) : <p className="packed-sub">Labels weren't ready. Use Reprint label on each shipment.</p>}
                </section>
              )}
              {result.failed.length > 0 && (
                <section className="ship-card">
                  <h3 style={{ color: 'var(--danger)' }}>{plural(result.failed.length, 'order')} didn't go through</h3>
                  {result.failed.map((f, i) => <div key={i} className="ship-err"><b>{f.order_number}</b><span>{f.error}</span></div>)}
                </section>
              )}
              {result.warnings?.map((w, i) => <div key={i} className="ship-alert warning" style={{ margin: 0 }}><span>{w}</span></div>)}
            </div>
            <div className="drawer-footer"><button className="btn btn-primary" onClick={onClose}>Done</button></div>
          </>
        ) : (
          <>
            <div className="drawer-body">
              {single && (
                <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <p className="ship-section-title">Deliver to</p>
                  {checking && !quote ? <div className="packed-sub">Checking with Shopify and Delhivery…</div> : quote?.error ? (
                    <div className="ship-err"><span>{quote.error}</span></div>
                  ) : quote && (
                    <>
                      <div style={{ fontSize: 14, lineHeight: 1.55 }}>
                        {quote.facts.name || '—'} · {quote.facts.phone || 'no phone'}<br />
                        {quote.facts.add}<br />{[quote.facts.city, quote.facts.state, quote.facts.pin].filter(Boolean).join(', ')}
                      </div>
                      <div className="ship-chips">
                        {quote.pincode?.serviceable ? <span className="ship-chip good">Serviceable</span> : quote.pincode ? <span className="ship-chip bad">Not serviceable</span> : null}
                        {quote.pincode?.serviceable && <span className={`ship-chip ${quote.pincode.cod ? 'good' : 'bad'}`}>{quote.pincode.cod ? 'COD available' : 'No COD here'}</span>}
                        {quote.pincode?.oda && <span className="ship-chip warn">Remote area (extra charge)</span>}
                      </div>
                      {quote.problems?.map((p, i) => <div key={i} className="ship-err"><span>{p}</span></div>)}
                      {quote.problems?.length > 0 && <p className="packed-sub" style={{ maxWidth: 'none' }}>Fix the address or phone in Shopify, then open this again.</p>}
                    </>
                  )}
                </section>
              )}

              <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <p className="ship-section-title">Package{!single && ' (same for every order)'}</p>
                <div className="ship-pills" role="radiogroup" aria-label="Box">
                  {boxes.map(b => (
                    <button key={b.key} type="button" role="radio" aria-checked={box === b.key}
                      className={`ship-pill ${box === b.key ? 'active' : ''}`} onClick={() => pickBox(b)}>
                      {b.name}<small>{b.l}×{b.b}×{b.h} cm · {b.grams / 1000} kg</small>
                    </button>
                  ))}
                </div>
                <div className="form-row">
                  <div className="input-group"><label htmlFor="ship-w">Weight (grams)</label>
                    <input id="ship-w" type="number" min="50" step="50" value={weight} onChange={e => setWeight(e.target.value)} /></div>
                  <div className="input-group"><label htmlFor="ship-mode">Shipping mode</label>
                    <select id="ship-mode" value={mode} onChange={e => setMode(e.target.value)}><option>Surface</option><option>Express</option></select></div>
                </div>
              </section>

              {single && quote && !quote.error && (
                <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <p className="ship-section-title">Payment</p>
                  <div className="form-row">
                    <div className="input-group"><label htmlFor="ship-pay">Payment</label>
                      <select id="ship-pay" value={payment || quote.payment_mode} onChange={e => setPayment(e.target.value)}><option>COD</option><option>Prepaid</option></select></div>
                    {effPayment === 'COD' && (
                      <div className="input-group"><label htmlFor="ship-cod">Collect from customer (₹)</label>
                        <input id="ship-cod" type="number" min="0" value={cod} onChange={e => setCod(e.target.value)} /></div>
                    )}
                  </div>
                  <p className="packed-sub" style={{ maxWidth: 'none' }}>Taken from Shopify. Partial COD collects only what's still owed.</p>
                </section>
              )}

              {single && quote?.charge && (
                <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <p className="ship-section-title">Delhivery charge (estimate)</p>
                  <dl className="ship-kv">
                    <dt>Total, with GST</dt><dd><b>{money(quote.charge.total)}</b></dd>
                    {quote.charge.cod > 0 && <><dt>of which COD fee</dt><dd>{money(quote.charge.cod)}</dd></>}
                    <dt>Zone · charged weight</dt><dd>{quote.charge.zone} · {quote.charge.charged_weight} g</dd>
                  </dl>
                </section>
              )}
              {single && !settings?.origin_pincode && <p className="packed-sub" style={{ maxWidth: 'none' }}>Add the warehouse pincode in Settings to see the charge before shipping.</p>}
            </div>
            <div className="drawer-footer" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <p className="packed-sub" style={{ margin: 0, maxWidth: 'none' }}>
                This creates real Delhivery {orders.length > 1 ? 'shipments' : 'shipment'}, charged to the wallet.
                {settings?.shopify_fulfil ? ' Shopify is marked fulfilled with the AWB, which sends the customer the shipped WhatsApp.' : ''}
              </p>
              <div style={{ display: 'flex', gap: 10 }}>
                <button className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }} disabled={busy || blocked} onClick={submit}>
                  {busy ? 'Creating…' : single ? 'Create shipment and get label' : `Create ${orders.length} shipments`}
                </button>
                <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
