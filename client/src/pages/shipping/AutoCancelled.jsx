import { useState, useEffect } from 'react'
import { useApi } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import DetailsForm from './DetailsForm'
import ShipmentFilterBar from './ShipmentFilterBar'
import { day, dayTime, money, plural, openLabels } from './common'

/**
 * Shipments Delhivery cancelled because they weren't picked up in time. The parcel is still on
 * our shelf, so each needs a new AWB and a new label: picked here and re-created in one go, or
 * marked as not shipping (the customer cancelled, say) so it stops being an alert.
 */
export default function AutoCancelled({ canManage, settings, changed, open, go, rev }) {
  const apiFetch = useApi()
  const toast = useToast()
  const [rows, setRows] = useState(null)
  const [picked, setPicked] = useState({})
  const [box, setBox] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [editing, setEditing] = useState(null)   // the row whose delivery details are being added
  const [saving, setSaving] = useState(false)
  const [params, setParams] = useState(null)     // the filter bar's query (search, payment, filters)
  const [total, setTotal] = useState(0)
  const filtered = !!params && Object.keys(params).some(k => k !== 'bucket')

  useEffect(() => {
    if (!params) return
    let live = true
    const q = new URLSearchParams({ ...params, bucket: 'cancelled_open', limit: '300' }).toString()
    apiFetch(`/api/shipping/shipments?${q}`).then(r => {
      if (!live) return
      const list = r && !r.error ? r.shipments : []
      setRows(list)
      setTotal(r?.total ?? list.length)
      setPicked(Object.fromEntries(list.map(s => [s.id, true])))
    })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev, params])

  const bar = <ShipmentFilterBar bucket="cancelled_open" csvName="auto-cancelled" onChange={setParams} />
  if (!rows) return <div className="ship-layout"><section className="ship-main">{bar}<div className="loader"><div className="spinner" /></div></section></div>
  const ids = rows.filter(s => picked[s.id]).map(s => s.id)
  const all = rows.length > 0 && ids.length === rows.length

  const recreate = async () => {
    if (!await toast.confirm({ title: `Re-create ${plural(ids.length, 'shipment')}?`, message: 'Each gets a new AWB from Delhivery, charged to the wallet. Print the new labels and swap them for the old ones.' })) return
    setBusy(true)
    const r = await apiFetch('/api/shipping/recreate', { method: 'POST', body: JSON.stringify({ ids, box: box || undefined }) })
    setBusy(false)
    if (!r || r.error) return toast.error(r?.error || 'Could not re-create')
    setResult(r)
    changed()
  }
  // Shopify only shows the app the last 60 days of orders, and a parcel made in the portal has no
  // street address or phone in the CRM: those need the details typed in before they can be re-made.
  const needsDetails = (s) => s.outside_shopify && !(s.details?.address || s.consignee_address)
  const saveDetails = async (v) => {
    setSaving(true)
    const r = await apiFetch(`/api/shipping/orders/${encodeURIComponent(editing.order_number)}/details`, { method: 'PUT', body: JSON.stringify(v) })
    setSaving(false)
    if (!r || r.error) return toast.error(r?.error || 'Could not save the details')
    toast.success(`Details saved for ${editing.order_number}`)
    setEditing(null)
    changed()
  }
  const notShipping = async () => {
    if (!await toast.confirm({ title: `Mark ${plural(ids.length, 'shipment')} as not shipping?`, message: 'They stop showing as alerts. Use this when the customer cancelled or the order is shipping some other way.' })) return
    const r = await apiFetch('/api/shipping/not-shipping', { method: 'POST', body: JSON.stringify({ ids }) })
    if (!r || r.error) return toast.error(r?.error || 'Could not update')
    toast.success(`${plural(r.updated, 'shipment')} marked as not shipping`)
    changed()
  }

  return (
    <div className="ship-layout">
      <section className="ship-main">
        <p style={{ color: 'var(--text-secondary)', marginTop: 0, maxWidth: 820, fontSize: 14 }}>
          Delhivery cancels a shipment when it isn't picked up in time. The parcel is still with us, so it needs a new AWB and a new label.
          The CRM checks every 30 minutes and alerts you as soon as one appears.
        </p>

        {result && (
          <section className="ship-card" style={{ borderColor: 'color-mix(in srgb, var(--success) 40%, transparent)' }}>
            <h3 style={{ color: 'var(--success)' }}>{plural(result.created.length, 'new AWB')}</h3>
            {result.created.map(c => <div key={c.awb} className="ship-ok"><b>{c.order_number}</b><span className="ship-mono">{c.awb}</span></div>)}
            {result.failed.map((f, i) => <div key={i} className="ship-err"><b>{f.order_number}</b><span>{f.error}</span></div>)}
            {result.created.length > 0 && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-primary btn-sm" onClick={() => openLabels(apiFetch, toast, { awbs: result.created.map(c => c.awb) })}>
                  <Icon name="printer" size={14} /> Print {result.created.length === 1 ? 'the new label' : `${result.created.length} new labels`}
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => go('recreated')}>Re-created tab</button>
              </div>
            )}
            {result.warnings?.map((w, i) => <p key={i} className="packed-sub" style={{ color: 'var(--warning)', maxWidth: 'none' }}>{w}</p>)}
            <p className="packed-sub" style={{ maxWidth: 'none' }}>Swap each old label for the new one before the next pickup.</p>
          </section>
        )}

        {bar}
        {filtered && rows.length > 0 && <p className="packed-sub" style={{ maxWidth: 'none', margin: '0 0 8px' }}>{plural(total, 'shipment')} match these filters{total > rows.length ? ` (first ${rows.length} shown)` : ''}.</p>}

        {!rows.length ? (
          <div className="data-table-wrapper"><div className="empty-state">
            {filtered
              ? <><div className="empty-icon">🔎</div><h3>Nothing matches these filters</h3><p>Clear the search or filters to see every auto-cancelled shipment.</p></>
              : <><div className="empty-icon">✅</div><h3>Nothing auto-cancelled</h3><p>Every cancelled shipment has been re-created or marked as not shipping.</p></>}
          </div></div>
        ) : (
          <>
            <div className="data-table-wrapper">
              <div style={{ overflowX: 'auto' }}>
                <table className="data-table">
                  <thead><tr>
                    <th style={{ width: 36 }}><input type="checkbox" checked={all} aria-label="Select all"
                      onChange={() => setPicked(all ? {} : Object.fromEntries(rows.map(s => [s.id, true])))} /></th>
                    <th>Order · old AWB</th><th>Customer</th><th>Items</th><th>Payment</th><th>Freight</th><th>Cancelled</th><th>Made in</th><th>Details</th>
                  </tr></thead>
                  <tbody>
                    {rows.map(s => (
                      <tr key={s.id}>
                        <td><input type="checkbox" checked={!!picked[s.id]} aria-label={`Select ${s.order_number}`}
                          onChange={() => setPicked(p => ({ ...p, [s.id]: !p[s.id] }))} /></td>
                        <td data-label="Order · old AWB" className="cell-primary"><button className="mini-btn" onClick={() => open(s.id)}>{s.order_number || s.delhivery_order || '—'}</button>
                          <div className="packed-sub ship-mono" style={{ textDecoration: 'line-through' }}>{s.awb}</div>
                          {s.tags && <div className="ship-tags">Tags: {s.tags.split(/\s*,\s*/).join(' | ')}</div>}
                          {s.ordered_at && <div className="packed-sub">ordered {day(s.ordered_at)}</div>}</td>
                        <td data-label="Customer">{s.consignee_name || '—'}<div className="packed-sub">{[s.consignee_city || s.destination, s.consignee_pincode].filter(Boolean).join(' · ')}</div></td>
                        <td data-label="Items" style={{ maxWidth: 260 }}>{(s.items || []).join(', ') || '—'}</td>
                        <td data-label="Payment">{s.payment_mode === 'COD' ? `COD ${money(s.cod_amount)}` : (s.payment_mode || '—')}</td>
                        <td data-label="Freight">{s.charge_estimate != null ? (
                          <>{money(s.charge_estimate)}<div className="packed-sub">{(s.pieces || 1) > 1 ? `${money(Number(s.charge_estimate) / s.pieces)} per item · ` : ''}{s.charge_zone ? `zone ${s.charge_zone}` : ''}</div></>
                        ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                        <td data-label="Cancelled">{dayTime(s.cancelled_at || s.status_at)}<div className="packed-sub">{s.instructions || s.status}</div></td>
                        <td data-label="Made in">{s.source === 'manual' ? 'Manual' : s.created_via === 'crm' ? 'CRM' : 'Portal'}</td>
                        <td data-label="Details">
                          {needsDetails(s)
                            ? <span className="status-badge on-hold" title="Shopify no longer shows this order, so the CRM needs the address and phone">Needs address</span>
                            : s.details ? <span className="packed-sub" style={{ margin: 0, color: 'var(--warning)' }}>Details added</span> : null}
                          {canManage && (s.outside_shopify || s.details) && (
                            <div><button className="mini-btn" onClick={() => setEditing(s)}>{s.details ? 'Edit details' : 'Add details'}</button></div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {editing && (
              <section className="ship-card" style={{ marginTop: 18 }}>
                <h3>Delivery details for {editing.order_number}</h3>
                <p className="packed-sub" style={{ maxWidth: 'none', marginTop: 0 }}>
                  Shopify no longer shows this order to the CRM (it only sees the last 60 days), and the old parcel was made in the Delhivery portal,
                  so its street address and phone aren't in the CRM. Copy them from the order in Shopify admin or from the old AWB in the portal.
                </p>
                <DetailsForm key={editing.id} busy={saving} submitLabel="Save details" onCancel={() => setEditing(null)} onSubmit={saveDetails}
                  initial={{
                    name: editing.details?.name || editing.consignee_name, phone: editing.details?.phone || editing.consignee_phone,
                    address: editing.details?.address || editing.consignee_address, city: editing.details?.city || editing.consignee_city,
                    state: editing.details?.state || editing.consignee_state, pincode: editing.details?.pincode || editing.consignee_pincode,
                    products_desc: editing.details?.products_desc || editing.products_desc,
                  }} />
              </section>
            )}

            {canManage && (
              <section className="ship-card" style={{ marginTop: 18, borderColor: 'color-mix(in srgb, var(--primary) 45%, transparent)' }}>
                <h3>Re-create {plural(ids.length, 'selected shipment')}</h3>
                <div className="form-row">
                  <div className="input-group">
                    <label htmlFor="rc-box">Box</label>
                    <select id="rc-box" value={box} onChange={e => setBox(e.target.value)}>
                      <option value="">Keep the same box (or the first box if unknown)</option>
                      {(settings?.boxes || []).map(b => <option key={b.key} value={b.key}>{b.name}</option>)}
                    </select>
                  </div>
                </div>
                <p className="packed-sub" style={{ maxWidth: 'none', marginTop: 0 }}>
                  Same address and COD amount, fresh from Shopify. New labels open when they're ready
                  {settings?.shopify_fulfil ? ', and the tracking number in Shopify is swapped for the new one' : ''}.
                  Book a pickup afterwards if today's has been missed.
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                  <button className="btn btn-primary" disabled={!ids.length || busy} onClick={recreate}>{busy ? 'Re-creating…' : `Re-create ${plural(ids.length, 'shipment')}`}</button>
                  <button className="btn btn-secondary" disabled={!ids.length || busy} onClick={notShipping}>Mark as not shipping</button>
                  <button className="btn btn-secondary" onClick={() => go('pickups')}>Pickups</button>
                </div>
              </section>
            )}
          </>
        )}
      </section>

      <aside style={{ flex: '1 1 280px', minWidth: 0 }}>
        <section className="ship-card">
          <h3>How you're alerted</h3>
          <div className="ship-setting"><span>CRM bell<small>Everyone with Shipping access, as soon as a sync finds one.</small></span></div>
          <div className="ship-setting"><span>Red count on Shipping<small>In the menu until each one is re-created or marked as not shipping.</small></span></div>
          <div className="ship-setting"><span>WhatsApp to the ops number<small>{settings?.alert_whatsapp && settings?.ops_phone ? `On, to ${settings.ops_phone}.` : 'Off. Switch it on in Settings.'}</small></span></div>
        </section>
        <section className="ship-card">
          <h3>Stopping it happening</h3>
          <p className="packed-sub" style={{ maxWidth: 'none', fontSize: 13 }}>
            Most auto-cancels start as "not ready for pickup": Delhivery came, but the parcel wasn't packed and labelled.
            Creating the AWB only after packing, which is how the CRM does it, stops that.
          </p>
        </section>
      </aside>
    </div>
  )
}
