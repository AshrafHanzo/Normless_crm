import { useState, useEffect } from 'react'
import { useApi } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import { BUCKET_BADGE, BUCKET_LABEL, dayTime, money, statusText, trackingUrl } from './common'

/** One shipment: where it is, every scan, and what can still be done to it. */
export default function ShipmentDrawer({ id, canManage, onClose, onChanged, onRecreate }) {
  const apiFetch = useApi()
  const toast = useToast()
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState('')
  const [editing, setEditing] = useState(null)   // { phone, add, name }
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
  const saveEdit = () => act('edit', async () => {
    const r = await apiFetch(`/api/shipping/shipments/${s.id}/edit`, { method: 'POST', body: JSON.stringify(editing) })
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
            {!['cancelled'].includes(s.bucket) && <button className="btn btn-secondary btn-sm" onClick={label} disabled={busy === 'label'}><Icon name="printer" size={14} /> {busy === 'label' ? 'Fetching…' : 'Reprint label'}</button>}
            {canManage && s.bucket === 'ndr' && <button className="btn btn-primary btn-sm" onClick={reattempt} disabled={!!busy}>Re-attempt delivery</button>}
            {canManage && ['waiting_pickup', 'in_transit', 'ndr'].includes(s.bucket) && !editing && (
              <button className="btn btn-secondary btn-sm" onClick={() => setEditing({ name: s.consignee_name || '', phone: '', add: '' })}>Change phone or address</button>
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
              <h3>Change with Delhivery</h3>
              <div className="form-row">
                <div className="input-group"><label htmlFor="ed-name">Name</label><input id="ed-name" value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} /></div>
                <div className="input-group"><label htmlFor="ed-phone">Phone <span className="label-hint">leave blank to keep</span></label><input id="ed-phone" inputMode="tel" value={editing.phone} onChange={e => setEditing({ ...editing, phone: e.target.value })} /></div>
              </div>
              <div className="input-group"><label htmlFor="ed-add">Address <span className="label-hint">leave blank to keep</span></label><input id="ed-add" value={editing.add} onChange={e => setEditing({ ...editing, add: e.target.value })} /></div>
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
                <dt>Deliver to</dt><dd>{[s.consignee_name, s.consignee_city || s.destination, s.consignee_pincode].filter(Boolean).join(', ') || '—'}</dd>
                <dt>Created</dt><dd>{dayTime(s.manifested_at || s.created_at)} · {s.created_via === 'crm' ? `CRM${s.created_by ? ` (${s.created_by.split('@')[0]})` : ''}` : 'Delhivery portal'}</dd>
                <dt>Picked up</dt><dd>{s.picked_up_at ? dayTime(s.picked_up_at) : 'Not yet'}</dd>
                {s.delivered_at && <><dt>Delivered</dt><dd>{dayTime(s.delivered_at)}</dd></>}
                {s.ndr_attempts > 0 && <><dt>Delivery attempts</dt><dd>{s.ndr_attempts}</dd></>}
                {s.ndr_action && <><dt>Our action</dt><dd>{s.ndr_action} · {dayTime(s.ndr_action_at)}</dd></>}
                <dt>Shopify</dt><dd>{s.created_via === 'crm' ? (s.shopify_fulfilled ? 'Fulfilled with this AWB' : 'Not updated') : 'Handled by the portal'}</dd>
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
