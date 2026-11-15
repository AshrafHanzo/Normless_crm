import { useState, useEffect } from 'react'
import Icon from '../../components/Icon'
import useDirtyGuard from '../../hooks/useDirtyGuard'
import useErrorInView from './useErrorInView'
import { todayYmd, waNote } from './format'

const n = (v) => { const x = parseInt(v, 10); return x > 0 ? x : 0 }
const lineName = (l) => [l.color, l.size].filter(Boolean).join(' · ') || l.product

/**
 * Record a delivery (goods in) against a vendor order, or edit one (`deliveryId`). A quick row per
 * product for quantity lines — the way the sheet was kept — and the colour × size grid for
 * apparel, each showing what is still to come.
 */
export default function RecordDeliveryDrawer({ orderId, deliveryId, apiFetch, toast, onClose, onSaved }) {
  const [data, setData] = useState(null)          // { order, progress, deliveries }
  const [form, setForm] = useState({ received_on: todayYmd(), challan_no: '', note: '' })
  const [qty, setQty] = useState({})              // key → { received, rejected }
  const [showRejected, setShowRejected] = useState(false)
  const [notify, setNotify] = useState(true)
  const [waOn, setWaOn] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const errorRef = useErrorInView(error)

  useEffect(() => {
    let live = true
    apiFetch(`/api/vendor-orders/${orderId}`).then(r => {
      if (!live || !r) return
      if (r.error) { setError(r.error); return }
      setData(r)
      if (!deliveryId && r.order.vendor_id) apiFetch(`/api/vendors/${r.order.vendor_id}/whatsapp`).then(w => { if (live && w && !w.error) setWaOn(!!w.events?.vendor_delivery) })
      const mine = deliveryId && r.deliveries.find(d => d.id === deliveryId)
      if (mine) {
        setForm({ received_on: mine.received_on, challan_no: mine.challan_no || '', note: mine.note || '' })
        const next = {}
        for (const l of mine.lines) next[key(l)] = { received: String(l.received || ''), rejected: String(l.rejected || '') }
        setQty(next)
        setShowRejected(mine.lines.some(l => l.rejected > 0))
      }
    })
    return () => { live = false }
    // apiFetch is a new function every render (see useApi), so it can't be a dependency here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, deliveryId])

  const guard = useDirtyGuard({
    snapshot: { form, qty },
    identity: `${orderId}-${deliveryId || 'new'}-${data ? 'loaded' : ''}`,
    onDiscard: onClose,
    confirm: toast.confirm,
    title: 'Discard this delivery?',
    message: 'The delivery hasn’t been saved. Closing now will lose it.',
  })

  const lines = (data?.progress.lines || []).filter(l => !l.unmatched)
  // Editing: what is still to come, counting this delivery as not yet in.
  const mine = deliveryId && data?.deliveries.find(d => d.id === deliveryId)
  const pendingOf = (l) => {
    const own = (mine?.lines || []).find(x => key(x) === l.key)
    return l.pending + (own ? n(own.received) - n(own.rejected) : 0)
  }
  const set = (k, field, v) => setQty(q => ({ ...q, [k]: { ...(q[k] || {}), [field]: v.replace(/\D/g, '') } }))
  const fillPending = () => setQty(Object.fromEntries(lines.filter(l => pendingOf(l) > 0).map(l => [l.key, { received: String(pendingOf(l)), rejected: '' }])))

  const totalIn = Object.values(qty).reduce((s, v) => s + n(v.received), 0)
  const totalRejected = Object.values(qty).reduce((s, v) => s + n(v.rejected), 0)

  const save = async () => {
    const payload = lines
      .map(l => ({ product: l.product, color: l.color, size: l.size, received: n(qty[l.key]?.received), rejected: showRejected ? n(qty[l.key]?.rejected) : 0 }))
      .filter(l => l.received || l.rejected)
    if (!payload.length) { setError('Enter how many pieces came in'); return }
    setSaving(true); setError('')
    const body = JSON.stringify({ ...form, lines: payload, notify_vendor: notify })
    const res = deliveryId
      ? await apiFetch(`/api/vendor-orders/${orderId}/deliveries/${deliveryId}`, { method: 'PUT', body })
      : await apiFetch(`/api/vendor-orders/${orderId}/deliveries`, { method: 'POST', body })
    setSaving(false)
    if (!res) return
    if (res.error) { setError(res.error); return }
    guard.reset()
    toast.success(`${totalIn} piece${totalIn === 1 ? '' : 's'} recorded in`)
    waNote(toast, res.whatsapp)
    onSaved()
  }

  // Quantity lines first, then apparel grouped by product and colour.
  const simple = lines.filter(l => !l.color && !l.size)
  const apparel = lines.filter(l => l.color || l.size)
  const groups = []
  for (const l of apparel) {
    const g = `${l.product}|${l.color || ''}`
    let grp = groups.find(x => x.id === g)
    if (!grp) { grp = { id: g, product: l.product, color: l.color, lines: [] }; groups.push(grp) }
    grp.lines.push(l)
  }

  const cell = (l, field) => (
    <input type="number" min="0" inputMode="numeric" value={qty[l.key]?.[field] ?? ''} placeholder="0"
      aria-label={`${l.product} ${lineName(l)} ${field}`} onChange={e => set(l.key, field, e.target.value)} />
  )

  return (
    <div className="drawer-overlay" onClick={guard.requestClose}>
      <div className="drawer" onClick={e => e.stopPropagation()} role="dialog" aria-label={deliveryId ? 'Edit delivery' : 'Record delivery'}>
        <div className="drawer-header">
          <div>
            <h2 style={{ fontSize: 17 }}>{deliveryId ? 'Edit delivery' : 'Record delivery'}</h2>
            {data && <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{data.order.vendor} · {data.order.ref}{data.order.quote_ref ? ` · ${data.order.quote_ref}` : ''}</div>}
          </div>
          <button className="btn-icon" onClick={guard.requestClose} aria-label="Close"><Icon name="close" size={16} /></button>
        </div>

        <div className="drawer-body">
          {error && <div className="calc-warning" role="alert" ref={errorRef}>{error}</div>}
          {!data ? <div className="loader"><div className="spinner" /></div> : (
            <>
              <div className="form-row">
                <div className="input-group">
                  <label htmlFor="dl-date">Received on *</label>
                  <input id="dl-date" type="date" value={form.received_on} max={todayYmd()} onChange={e => setForm(f => ({ ...f, received_on: e.target.value }))} />
                </div>
                <div className="input-group">
                  <label htmlFor="dl-challan">Challan no.<span className="unit-hint"> optional</span></label>
                  <input id="dl-challan" value={form.challan_no} onChange={e => setForm(f => ({ ...f, challan_no: e.target.value }))} />
                </div>
              </div>

              <div className="form-section">
                What came in
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" className="mini-btn" onClick={fillPending}>Everything still to come</button>
                  <button type="button" className={`mini-btn ${showRejected ? 'mini-btn-active' : ''}`} aria-pressed={showRejected} onClick={() => setShowRejected(v => !v)}>Some failed QC</button>
                </div>
              </div>

              {simple.length > 0 && (
                <div className="dl-simple">
                  <div className="dl-row dl-head"><span>Product</span><span>To come</span><span>Received</span>{showRejected && <span>Rejected</span>}</div>
                  {simple.map(l => (
                    <div key={l.key} className="dl-row">
                      <b>{l.product}</b>
                      <span className="dl-pending">{pendingOf(l)}</span>
                      {cell(l, 'received')}
                      {showRejected && cell(l, 'rejected')}
                    </div>
                  ))}
                </div>
              )}

              {groups.map(g => (
                <div key={g.id} className="line-item-card">
                  <div className="line-item-header"><span>{g.product}{g.color ? ` · ${g.color}` : ''}</span></div>
                  <div className="size-grid">
                    {g.lines.map(l => (
                      <div key={l.key} className="size-cell">
                        <label>{l.size || '—'} <span className="dl-pending">· {pendingOf(l)}</span></label>
                        {cell(l, 'received')}
                        {showRejected && cell(l, 'rejected')}
                      </div>
                    ))}
                  </div>
                  {showRejected && <div className="dl-hint">Top: received · bottom: rejected at QC</div>}
                </div>
              ))}

              {!lines.length && <p style={{ color: 'var(--text-muted)' }}>This order has no lines with quantities.</p>}
              {showRejected && <p className="dl-hint">Rejected pieces stay owed: they count as still to come until replaced.</p>}

              <div className="input-group">
                <label htmlFor="dl-note">Note<span className="unit-hint"> optional</span></label>
                <input id="dl-note" value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} placeholder="e.g. 3 masks warped, sent back" />
              </div>

          {waOn && (
            <label className="pp-default">
              <input type="checkbox" checked={notify} onChange={e => setNotify(e.target.checked)} />
              <span><b>Tell the vendor on WhatsApp</b><em>What came in and what is still to come, from the Normless number. Several lots on one day go as one message.</em></span>
            </label>
          )}

              <div className="totals-bar">
                <div><span>Received</span><strong>{totalIn} pcs</strong></div>
                {showRejected && <div><span>Rejected</span><strong>{totalRejected} pcs</strong></div>}
                <div><span>Still to come after this</span><strong>{Math.max(lines.reduce((s, l) => s + pendingOf(l), 0) - (totalIn - (showRejected ? totalRejected : 0)), 0)} pcs</strong></div>
              </div>
            </>
          )}
        </div>

        <div className="drawer-footer">
          <button className="btn btn-secondary" onClick={guard.requestClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={saving || !data}>{saving ? 'Saving…' : 'Save delivery'}</button>
        </div>
      </div>
    </div>
  )
}

function key(l) { return [l.product, l.color, l.size].map(v => String(v || '').trim().toLowerCase()).join('|') }
