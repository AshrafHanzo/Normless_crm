import { useState, useEffect } from 'react'
import { useApi } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import { BUCKET_BADGE, BUCKET_LABEL, dayTime, money, statusText, trackingUrl } from './common'

/** One shipment: where it is, every scan, and what can still be done to it. */
export default function ShipmentDrawer({ id, canManage, settings, onClose, onChanged, onRecreate }) {
  const apiFetch = useApi()
  const toast = useToast()
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState('')
  const [editing, setEditing] = useState(null)   // the form; editBase is what it started from
  const [editBase, setEditBase] = useState(null)
  const [allScans, setAllScans] = useState(false)

  const load = async () => {
    const r = await apiFetch(`/api/shipping/shipments/${id}`)
    if (r && !r.error) setData(r); else toast.error(r?.error || 'Could not load the shipment')
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [id])

  if (!data) return (
    <div className="drawer-overlay" onClick={onClose}><div className="drawer" onClick={e => e.stopPropagation()}><div className="loader"><div className="spinner" /></div></div></div>
  )
  const s = data.shipment
  const scans = [...(s.scans || [])].reverse()
  const shown = allScans ? scans : scans.slice(0, 6)
  const link = data.tracking_url || trackingUrl(s.awb)

  const act = async (key, fn) => { setBusy(key); try { await fn() } finally { setBusy('') } }
  const copy = () => navigator.clipboard.writeText(link).then(() => toast.success('Tracking link copied'), () => window.open(link, '_blank', 'noreferrer'))
  const label = () => act('label', async () => {
    const r = await apiFetch('/api/shipping/labels', { method: 'POST', body: JSON.stringify({ ids: [s.id] }) })
    const url = r?.labels?.find(l => l.url)?.url
    if (url) window.open(url, '_blank', 'noreferrer'); else toast.error(r?.error || 'Delhivery returned no label')
  })
  const cancel = () => act('cancel', async () => {
    const before = s.bucket === 'waiting_pickup'
    if (!await toast.confirm({ title: before ? 'Cancel this shipment?' : 'Send this parcel back to us?', danger: true,
      message: before ? `AWB ${s.awb} is cancelled with Delhivery. The order goes back to Pending AWB only if you re-create it.` : `Delhivery turns AWB ${s.awb} into a return (RTO). This can't be undone.` })) return
    const r = await apiFetch(`/api/shipping/shipments/${s.id}/cancel`, { method: 'POST' })
    if (!r || r.error) return toast.error(r?.error || 'Delhivery refused')
    toast.success(before ? 'Shipment cancelled' : 'Return requested'); onChanged(); load()
  })
  const reattempt = () => act('re', async () => {
    const r = await apiFetch('/api/shipping/reattempt', { method: 'POST', body: JSON.stringify({ ids: [s.id] }) })
    if (!r || r.error) return toast.error(r?.error || 'Delhivery refused')
    toast.success('Re-attempt requested'); onChanged(); load()
  })
  const startEdit = () => {
    const base = {
      name: s.consignee_name || '', phone: s.consignee_phone || '', add: '',
      payment_mode: s.payment_mode === 'COD' ? 'COD' : 'Prepaid', cod_amount: s.payment_mode === 'COD' ? String(Number(s.cod_amount) || '') : '',
      box: '', weight_g: s.weight_g ? String(s.weight_g) : '', l: s.length_cm ? String(Number(s.length_cm)) : '',
      b: s.width_cm ? String(Number(s.width_cm)) : '', h: s.height_cm ? String(Number(s.height_cm)) : '', products_desc: s.products_desc || '',
    }
    setEditBase(base); setEditing(base)
  }
  const saveEdit = () => act('edit', async () => {
    // Only what changed goes to Delhivery.
    const changed = Object.fromEntries(Object.entries(editing).filter(([k, v]) => String(v ?? '') !== String(editBase[k] ?? '') && String(v ?? '').trim() !== ''))
    if (editing.payment_mode !== editBase.payment_mode) changed.payment_mode = editing.payment_mode
    if (!Object.keys(changed).length) { setEditing(null); return }
    const r = await apiFetch(`/api/shipping/shipments/${s.id}/edit`, { method: 'POST', body: JSON.stringify(changed) })
    if (!r || r.error) return toast.error(r?.error || 'Delhivery refused')
    toast.success('Updated with Delhivery'); setEditing(null); onChanged(); load()
  })
  const notShipping = () => act('ns', async () => {
    const r = await apiFetch('/api/shipping/not-shipping', { method: 'POST', body: JSON.stringify({ ids: [s.id] }) })
    if (!r || r.error) return toast.error(r?.error || 'Could not update'); toast.success('Marked as not shipping'); onChanged(); load()
  })

  const cancellable = ['waiting_pickup', 'in_transit', 'ndr'].includes(s.bucket)
  const openCancel = s.bucket === 'cancelled' && s.cancel_kind === 'auto' && !s.cancel_handled

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer drawer-wide" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`Shipment ${s.awb}`}>
        <div className="drawer-header">
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 18, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              {s.order_number || 'No order'} · {s.consignee_name || '—'}
              <span className={`status-badge ${BUCKET_BADGE[s.bucket] || 'pending'}`}>{BUCKET_LABEL[s.bucket] || s.bucket}</span>
            </h2>
            <p className="packed-sub" style={{ margin: '4px 0 0', maxWidth: 'none' }}>
              AWB <span className="ship-mono">{s.awb}</span>{s.expected_delivery && ` · expected by ${dayTime(s.expected_delivery)}`}
            </p>
          </div>
          <button className="btn-icon" onClick={onClose} aria-label="Close"><Icon name="close" size={18} /></button>
        </div>
        <div className="drawer-body">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button className="btn btn-secondary btn-sm" onClick={copy}><Icon name="copy" size={14} /> Copy tracking link</button>
            <a className="btn btn-secondary btn-sm" href={link} target="_blank" rel="noreferrer"><Icon name="external" size={14} /> Delhivery tracking</a>
            {s.bucket !== 'cancelled' && s.direction !== 'return' && <button className="btn btn-secondary btn-sm" onClick={label} disabled={busy === 'label'}><Icon name="printer" size={14} /> {busy === 'label' ? 'Fetching…' : 'Reprint label'}</button>}
            {canManage && s.bucket === 'ndr' && <button className="btn btn-primary btn-sm" onClick={reattempt} disabled={!!busy}>Re-attempt delivery</button>}
            {canManage && ['waiting_pickup', 'in_transit', 'ndr', 'out_for_delivery'].includes(s.bucket) && !editing && (
              <button className="btn btn-secondary btn-sm" onClick={startEdit}><Icon name="edit" size={14} /> Edit shipment</button>
            )}
            {canManage && cancellable && <button className="btn btn-danger btn-sm" onClick={cancel} disabled={!!busy}>{s.bucket === 'waiting_pickup' ? 'Cancel shipment' : 'Return to us'}</button>}
            {canManage && openCancel && <button className="btn btn-primary btn-sm" onClick={onRecreate}>Re-create</button>}
            {canManage && openCancel && <button className="btn btn-secondary btn-sm" onClick={notShipping} disabled={!!busy}>Not shipping</button>}
          </div>

          {s.recreated_as && <div className="ship-alert info" style={{ margin: 0 }}><span>Re-created as AWB <b className="ship-mono">{s.recreated_as}</b>.</span></div>}
          {s.recreated_from && <div className="ship-alert info" style={{ margin: 0 }}><span>Replaces auto-cancelled AWB <b className="ship-mono">{s.recreated_from}</b>. Swap the old label for this one.</span></div>}
          {s.shopify_error && <div className="ship-alert warning" style={{ margin: 0 }}><strong>Shopify not updated.</strong><span>{s.shopify_error}</span></div>}

          {editing && (
            <section className="ship-card" style={{ margin: 0 }}>
              <h3>Edit with Delhivery</h3>
              <div className="form-row">
                <div className="input-group"><label htmlFor="ed-name">Name</label><input id="ed-name" value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} /></div>
                <div className="input-group"><label htmlFor="ed-phone">Phone {!editBase?.phone && <span className="label-hint">blank: keep</span>}</label><input id="ed-phone" inputMode="tel" value={editing.phone} onChange={e => setEditing({ ...editing, phone: e.target.value })} /></div>
              </div>
              <div className="input-group"><label htmlFor="ed-add">Address <span className="label-hint">blank: keep</span></label><input id="ed-add" value={editing.add} onChange={e => setEditing({ ...editing, add: e.target.value })} /></div>
              {s.bucket === 'waiting_pickup' ? (
                <>
                  <div className="form-row">
                    <div className="input-group"><label htmlFor="ed-pay">Payment</label>
                      <select id="ed-pay" value={editing.payment_mode} onChange={e => setEditing({ ...editing, payment_mode: e.target.value })}><option>COD</option><option>Prepaid</option></select></div>
                    {editing.payment_mode === 'COD' && <div className="input-group"><label htmlFor="ed-cod">Collect (₹)</label><input id="ed-cod" type="number" min="1" value={editing.cod_amount} onChange={e => setEditing({ ...editing, cod_amount: e.target.value })} /></div>}
                  </div>
                  <div className="form-row">
                    <div className="input-group"><label htmlFor="ed-box">Packaging</label>
                      <select id="ed-box" value={editing.box} onChange={e => { const b = (settings?.boxes || []).find(x => x.key === e.target.value); setEditing({ ...editing, box: e.target.value, ...(b ? { l: String(b.l), b: String(b.b), h: String(b.h) } : {}) }) }}>
                        <option value="">{s.box ? `Keep (${(settings?.boxes || []).find(x => x.key === s.box)?.name || s.box})` : 'Keep'}</option>
                        {(settings?.boxes || []).map(b => <option key={b.key} value={b.key}>{b.name}</option>)}
                      </select></div>
                    <div className="input-group"><label htmlFor="ed-w">Weight (g)</label><input id="ed-w" type="number" min="50" value={editing.weight_g} onChange={e => setEditing({ ...editing, weight_g: e.target.value })} /></div>
                  </div>
                  <div className="form-row">
                    {[['l', 'Length'], ['b', 'Breadth'], ['h', 'Height']].map(([k, label]) => (
                      <div className="input-group" key={k}><label htmlFor={`ed-${k}`}>{label} cm</label><input id={`ed-${k}`} type="number" min="1" value={editing[k]} onChange={e => setEditing({ ...editing, [k]: e.target.value })} /></div>
                    ))}
                  </div>
                  <div className="input-group"><label htmlFor="ed-prod">Products</label><input id="ed-prod" value={editing.products_desc} onChange={e => setEditing({ ...editing, products_desc: e.target.value })} /></div>
                </>
              ) : <p className="packed-sub" style={{ maxWidth: 'none', margin: 0 }}>Picked up already: only the name, phone and address can change now.</p>}
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-primary btn-sm" onClick={saveEdit} disabled={busy === 'edit'}>{busy === 'edit' ? 'Saving…' : 'Send to Delhivery'}</button>
                <button className="btn btn-secondary btn-sm" onClick={() => setEditing(null)}>Cancel</button>
              </div>
            </section>
          )}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'flex-start' }}>
            <section className="ship-card" style={{ flex: '2 1 380px', minWidth: 0, margin: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <p className="ship-section-title">Tracking</p>
                <span className="packed-sub" style={{ marginLeft: 'auto', marginTop: 0 }}>{s.last_tracked_at ? `checked ${dayTime(s.last_tracked_at)}` : 'not tracked yet'}</span>
              </div>
              {!scans.length ? <p className="packed-sub">{statusText(s)}</p> : (
                <div className="ship-timeline">
                  {shown.map((e, i) => (
                    <div key={i} className={`ship-ev ${i === 0 ? 'latest' : ''}`}>
                      <div>
                        <div style={{ fontWeight: 600 }}>{e.code === 'FMEOD-152' ? 'Not ready for pickup' : (e.text || e.scan)}</div>
                        <div className="ship-ev-place">{e.place}</div>
                        <div className="ship-ev-time">{e.at ? new Date(/[zZ+]/.test(e.at) ? e.at : `${e.at}+05:30`).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit' }) : ''} · {e.code}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {scans.length > 6 && <button className="mini-btn" style={{ alignSelf: 'flex-start' }} onClick={() => setAllScans(v => !v)}>{allScans ? 'Show fewer' : `Show all ${scans.length} scans`}</button>}
            </section>
            <section className="ship-card" style={{ flex: '1 1 260px', minWidth: 0, margin: 0 }}>
              <p className="ship-section-title">Shipment</p>
              <dl className="ship-kv">
                <dt>Payment</dt><dd>{s.payment_mode === 'COD' ? `COD ${money(s.cod_amount)}` : (s.payment_mode || '—')}</dd>
                {s.box && <><dt>Box</dt><dd>{s.box}{s.weight_g ? ` · ${s.weight_g / 1000} kg` : ''}</dd></>}
                {s.shipping_mode && <><dt>Mode</dt><dd>{s.shipping_mode}</dd></>}
                <dt>Deliver to</dt><dd>{[s.consignee_name, s.consignee_phone, s.consignee_address, s.consignee_city || s.destination, s.consignee_pincode].filter(Boolean).join(', ') || '—'}</dd>
                {s.source === 'manual' && <><dt>Manual</dt><dd>{s.delhivery_order}{s.source_ref ? ` · for ${s.source_ref.replace(':', ' #')}` : ''}</dd></>}
                {s.products_desc && <><dt>Products</dt><dd>{s.products_desc}</dd></>}
                {s.customer_notified_at && <><dt>Customer told</dt><dd>New AWB sent on WhatsApp · {dayTime(s.customer_notified_at)}</dd></>}
                <dt>Created</dt><dd>{dayTime(s.manifested_at || s.created_at)} · {s.created_via === 'crm' ? `CRM${s.created_by ? ` (${s.created_by.split('@')[0]})` : ''}` : 'Delhivery portal'}</dd>
                <dt>Picked up</dt><dd>{s.picked_up_at ? dayTime(s.picked_up_at) : 'Not yet'}</dd>
                {s.charge_estimate != null && <><dt>Freight</dt><dd>{money(s.charge_estimate)} estimate{(s.pieces || 1) > 1 ? ` · ${money(Number(s.charge_estimate) / s.pieces)} per item` : ''}{s.charge_cod > 0 ? ` · incl. COD fee ${money(s.charge_cod)}` : ''}{s.charge_zone ? ` · zone ${s.charge_zone}` : ''}</dd></>}
                {s.charged_weight_g && <><dt>Weighed at</dt><dd>{s.charged_weight_g} g by Delhivery{s.weight_g && s.charged_weight_g > s.weight_g + 50 ? <span style={{ color: 'var(--warning)' }}> · more than the {s.weight_g} g declared, so the wallet is charged the difference</span> : ''}</dd></>}
                {s.delivered_at && <><dt>Delivered</dt><dd>{dayTime(s.delivered_at)}</dd></>}
                {s.ndr_attempts > 0 && <><dt>Delivery attempts</dt><dd>{s.ndr_attempts}</dd></>}
                {s.ndr_action && <><dt>Our action</dt><dd>{s.ndr_action} · {dayTime(s.ndr_action_at)}</dd></>}
                {s.direction === 'return' && <><dt>Type</dt><dd>Return or exchange pickup from the customer</dd></>}
                <dt>Shopify</dt><dd>{s.direction === 'return' ? '—' : s.created_via === 'crm' ? (s.shopify_fulfilled ? 'Fulfilled with this AWB' : 'Not updated') : 'Handled by the portal'}</dd>
              </dl>
              {data.ticket ? <a href="/support">Support ticket #{data.ticket.ref_no} ({data.ticket.status})</a>
                : <span className="packed-sub" style={{ maxWidth: 'none' }}>No support ticket for this order.</span>}
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
