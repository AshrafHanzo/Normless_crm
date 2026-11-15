import { useState, useEffect, useMemo } from 'react'
import Icon from '../../components/Icon'
import useDirtyGuard from '../../hooks/useDirtyGuard'
import useErrorInView from './useErrorInView'
import { BRAND_LABEL, MODES, inr, day, todayYmd } from './format'

const num = (v) => Math.round((Number(v) || 0) * 100) / 100

/**
 * Split an amount across orders, oldest first, never past what is still due on each. The order the
 * payment was opened from goes first. Orders with no total only take money when they are that
 * order (there is no balance to fill otherwise). Returns { [orderId]: amount }.
 */
function autoSplit(amount, orders, presetId) {
  let left = num(amount)
  const out = {}
  const ordered = [...orders].sort((a, b) => (a.id === presetId ? -1 : b.id === presetId ? 1 : 0))
  for (const o of ordered) {
    if (left <= 0) break
    if (o.due == null) {
      if (o.id === presetId) { out[o.id] = left; left = 0 }
      continue
    }
    const take = Math.min(left, Math.max(o.due, 0))
    if (take > 0) { out[o.id] = num(take); left = num(left - take) }
  }
  return out
}

/**
 * Record a payment to a vendor, or edit one (`paymentId`). Opened from a vendor (`vendorId`), from
 * an order (`vendorId` + `presetOrderId`), or bare — then the vendor is picked first.
 */
export default function RecordPaymentDrawer({ vendorId: givenVendor, paymentId, presetOrderId, apiFetch, toast, onClose, onSaved }) {
  const [vendorId, setVendorId] = useState(givenVendor || null)
  const [vendors, setVendors] = useState(null)
  const [ctx, setCtx] = useState(null)              // { vendor, orders, money }
  const [form, setForm] = useState({ amount: '', paid_on: todayYmd(), mode: 'NEFT', reference: '', paid_from: '', note: '' })
  const [split, setSplit] = useState({})
  const [manualSplit, setManualSplit] = useState(false)
  const [proof, setProof] = useState(null)
  const [existingProof, setExistingProof] = useState(null)
  const [loaded, setLoaded] = useState(!paymentId)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const errorRef = useErrorInView(error)

  // Editing: load the payment first, which also says whose it is.
  useEffect(() => {
    if (!paymentId) return
    let live = true
    apiFetch(`/api/vendor-payments/${paymentId}`).then(r => {
      if (!live || !r || r.error) { if (r?.error) setError(r.error); return }
      const p = r.payment
      setVendorId(p.vendor_id)
      setForm({ amount: String(p.amount), paid_on: p.paid_on, mode: p.mode || 'NEFT', reference: p.reference || '', paid_from: p.paid_from || '', note: p.note || '' })
      setSplit(Object.fromEntries(p.allocations.map(a => [a.order_id, a.amount])))
      setManualSplit(true)
      setExistingProof(p.has_proof ? p.proof_name || 'Attached' : null)
      setLoaded(true)
    })
    return () => { live = false }
    // apiFetch is a new function every render (see useApi), so it can't be a dependency here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paymentId])

  // No vendor given: offer the vendor list.
  useEffect(() => {
    if (givenVendor || paymentId) return
    let live = true
    apiFetch('/api/vendor-orders/meta').then(r => { if (live && r && !r.error) setVendors((r.vendors || []).filter(v => v.id)) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The vendor's bank details, balance and the orders the payment can go against.
  useEffect(() => {
    if (!vendorId) return
    let live = true
    apiFetch(`/api/vendor-payments/form?vendor_id=${vendorId}${paymentId ? `&payment_id=${paymentId}` : ''}`).then(r => {
      if (!live || !r) return
      if (r.error) setError(r.error)
      else setCtx(r)
    })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorId, paymentId])

  const orders = useMemo(() => ctx?.orders || [], [ctx])
  // Until the split is touched by hand it follows the amount.
  const shown = manualSplit ? split : autoSplit(form.amount, orders, presetOrderId)
  const allocated = num(Object.values(shown).reduce((s, v) => s + num(v), 0))
  const onAccount = num(num(form.amount) - allocated)

  const guard = useDirtyGuard({
    snapshot: { form, split: shown, vendorId, proof: proof?.name || null },
    identity: `${paymentId || 'new'}-${loaded}-${ctx ? 'ctx' : ''}`,
    onDiscard: onClose,
    confirm: toast.confirm,
    title: 'Discard this payment?',
    message: 'The payment hasn’t been saved. Closing now will lose it.',
  })

  const set = (patch) => setForm(f => ({ ...f, ...patch }))
  const setShare = (orderId, value) => {
    setManualSplit(true)
    setSplit({ ...shown, [orderId]: value })
  }
  const toggleOrder = (o) => {
    const on = shown[o.id] != null && shown[o.id] !== ''
    const next = { ...shown }
    if (on) delete next[o.id]
    else next[o.id] = o.due != null ? num(Math.min(Math.max(onAccount, 0), o.due)) || '' : (onAccount > 0 ? onAccount : '')
    setManualSplit(true)
    setSplit(next)
  }

  const copyBank = async () => {
    const v = ctx?.vendor || {}
    const text = [v.bank_account_name && `Name: ${v.bank_account_name}`, v.bank_name && `Bank: ${v.bank_name}`,
      v.bank_account_no && `A/c: ${v.bank_account_no}`, v.bank_ifsc && `IFSC: ${v.bank_ifsc}`, v.upi_id && `UPI: ${v.upi_id}`].filter(Boolean).join('\n')
    await navigator.clipboard.writeText(text)
    toast.success('Bank details copied')
  }

  const save = async () => {
    if (!vendorId) { setError('Pick the vendor first'); return }
    if (!(num(form.amount) > 0)) { setError('Enter the amount paid'); return }
    if (form.mode !== 'Cash' && !form.reference.trim()) { setError('Enter the UTR / bank reference — it’s how the vendor matches the payment'); return }
    if (onAccount < 0) { setError('More is split across orders than was paid'); return }
    setSaving(true); setError('')
    const body = JSON.stringify({
      ...form, vendor_id: vendorId, amount: num(form.amount),
      allocations: Object.entries(shown).filter(([, v]) => num(v) > 0).map(([order_id, amount]) => ({ order_id: Number(order_id), amount: num(amount) })),
    })
    const res = paymentId
      ? await apiFetch(`/api/vendor-payments/${paymentId}`, { method: 'PUT', body })
      : await apiFetch('/api/vendor-payments', { method: 'POST', body })
    if (!res || res.error) { setSaving(false); if (res?.error) setError(res.error); return }
    if (proof) {
      const fd = new FormData()
      fd.append('file', proof)
      const up = await apiFetch(`/api/vendor-payments/${res.id}/proof`, { method: 'POST', body: fd })
      if (up?.error) toast.error(`Payment saved, but the proof wasn’t: ${up.error}`)
    }
    setSaving(false)
    guard.reset()
    toast.success(paymentId ? 'Payment saved' : `${inr(form.amount)} recorded`)
    onSaved(res.id)
  }

  const v = ctx?.vendor
  const hasBank = v && (v.bank_account_no || v.upi_id)

  return (
    <div className="drawer-overlay" onClick={guard.requestClose}>
      <div className="drawer" onClick={e => e.stopPropagation()} role="dialog" aria-label={paymentId ? 'Edit payment' : 'Record payment'}>
        <div className="drawer-header">
          <div>
            <h2 style={{ fontSize: 17 }}>{paymentId ? 'Edit payment' : 'Record payment'}</h2>
            {v && <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{v.name}</div>}
          </div>
          <button className="btn-icon" onClick={guard.requestClose} aria-label="Close"><Icon name="close" size={16} /></button>
        </div>

        <div className="drawer-body">
          {error && <div className="calc-warning" role="alert" ref={errorRef}>{error}</div>}

          {!givenVendor && !paymentId && (
            <div className="input-group">
              <label htmlFor="pay-vendor">Vendor *</label>
              <select id="pay-vendor" value={vendorId || ''} onChange={e => { setVendorId(Number(e.target.value) || null); setCtx(null); setSplit({}); setManualSplit(false) }}>
                <option value="">{vendors ? 'Pick a vendor' : 'Loading…'}</option>
                {(vendors || []).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </div>
          )}

          {v && (
            <div className="pay-bank">
              <div className="pay-bank-row">
                <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>Pay to</span>
                {hasBank && <button type="button" className="mini-btn" onClick={copyBank}><Icon name="copy" size={11} /> Copy</button>}
              </div>
              {hasBank ? (
                <>
                  <b>{[v.bank_account_name, v.bank_name].filter(Boolean).join(' · ') || v.name}</b>
                  <span className="vp-mono" style={{ color: 'var(--text-secondary)' }}>
                    {[v.bank_account_no && `A/c ${v.bank_account_no}`, v.bank_ifsc && `IFSC ${v.bank_ifsc}`, v.upi_id && `UPI ${v.upi_id}`].filter(Boolean).join(' · ')}
                  </span>
                </>
              ) : <span style={{ color: 'var(--warning)' }}>No bank details on file for {v.name} — add them on the vendor’s page.</span>}
              <div className="pay-bank-row" style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 4 }}>
                <span style={{ color: 'var(--text-muted)' }}>Balance with this vendor</span>
                <b>{inr(ctx.money.balance)}</b>
              </div>
              {ctx.money.on_account > 0 && (
                <div className="pay-bank-row"><span style={{ color: 'var(--text-muted)' }}>Already on account</span><span>{inr(ctx.money.on_account)}</span></div>
              )}
            </div>
          )}

          <div className="form-row">
            <div className="input-group">
              <label htmlFor="pay-amount">Amount paid (₹) *</label>
              <input id="pay-amount" type="number" min="0" step="any" inputMode="decimal" value={form.amount}
                onChange={e => set({ amount: e.target.value })} style={{ fontSize: 17, fontWeight: 700 }} />
            </div>
            <div className="input-group">
              <label htmlFor="pay-date">Paid on *</label>
              <input id="pay-date" type="date" value={form.paid_on} max={todayYmd()} onChange={e => set({ paid_on: e.target.value })} />
            </div>
          </div>

          <div className="input-group">
            <label id="pay-mode-label">Mode *</label>
            <div className="chip-picker" role="radiogroup" aria-labelledby="pay-mode-label">
              {MODES.map(m => (
                <button type="button" key={m} role="radio" aria-checked={form.mode === m}
                  className={`chip ${form.mode === m ? 'chip-on' : ''}`} onClick={() => set({ mode: m })}>{m}</button>
              ))}
            </div>
          </div>

          <div className="form-row">
            <div className="input-group">
              <label htmlFor="pay-ref">{form.mode === 'Cheque' ? 'Cheque no.' : 'UTR / bank reference'}{form.mode === 'Cash' ? <span className="unit-hint"> optional for cash</span> : ' *'}</label>
              <input id="pay-ref" className="vp-mono" value={form.reference} maxLength={60}
                onChange={e => set({ reference: e.target.value.trim() })}
                placeholder={form.mode === 'UPI' ? '12-digit UPI reference' : 'From the bank app or advice'} />
            </div>
            <div className="input-group">
              <label htmlFor="pay-from">Paid from<span className="unit-hint"> optional</span></label>
              <input id="pay-from" value={form.paid_from} onChange={e => set({ paid_from: e.target.value })} placeholder="e.g. HDFC current ••4421" />
            </div>
          </div>

          <div className="input-group">
            <label htmlFor="pay-proof">Proof<span className="unit-hint"> optional — screenshot or bank advice</span></label>
            {existingProof && !proof && <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>On file: {existingProof}. Choosing a new file replaces it.</div>}
            <input id="pay-proof" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={e => setProof(e.target.files?.[0] || null)} />
          </div>

          <div className="form-section">
            Put against
            {manualSplit && !paymentId && <button type="button" className="mini-btn" onClick={() => { setManualSplit(false); setSplit({}) }}>Split automatically</button>}
          </div>
          {!vendorId ? <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13 }}>Pick the vendor to see their orders.</p>
            : !ctx ? <div className="loader"><div className="spinner" /></div>
              : !orders.length ? <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13 }}>No orders with anything left to pay. The whole amount stays on account.</p>
                : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {orders.map(o => {
                      const on = shown[o.id] != null && shown[o.id] !== ''
                      return (
                        <div key={o.id} className={`pay-alloc ${on ? 'on' : ''}`}>
                          <input type="checkbox" checked={on} onChange={() => toggleOrder(o)} aria-label={`Put against ${o.ref}`} style={{ width: 18, height: 18 }} />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 600 }}>{o.ref} <span className="badge-secondary" style={{ marginLeft: 4 }}>{BRAND_LABEL[o.brand]}</span></div>
                            <div className="pay-alloc-meta">
                              {[day(o.order_date), o.title || o.summary, o.quote_ref].filter(Boolean).join(' · ')}
                            </div>
                            <div className="pay-alloc-meta">{o.due != null ? `${inr(o.due)} still due of ${inr(o.total)}` : 'No total on this order'}</div>
                          </div>
                          <input type="number" min="0" step="any" value={on ? shown[o.id] : ''} disabled={!on}
                            aria-label={`Amount for ${o.ref}`} onChange={e => setShare(o.id, e.target.value)} />
                        </div>
                      )
                    })}
                  </div>
                )}

          <div className="input-group">
            <label htmlFor="pay-note">Note<span className="unit-hint"> optional</span></label>
            <input id="pay-note" value={form.note} onChange={e => set({ note: e.target.value })} placeholder="e.g. Instalment 3 of 5" />
          </div>

          <div className="totals-bar">
            <div><span>Paid</span><strong>{inr(form.amount)}</strong></div>
            <div><span>Against orders</span><strong>{inr(allocated)}</strong></div>
            <div><span>On account</span><strong style={onAccount < 0 ? { color: 'var(--danger)' } : undefined}>{inr(onAccount)}</strong></div>
          </div>
        </div>

        <div className="drawer-footer">
          <button className="btn btn-secondary" onClick={guard.requestClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={saving || !loaded}>
            {saving ? 'Saving…' : paymentId ? 'Save payment' : `Save payment${num(form.amount) > 0 ? ` · ${inr(form.amount)}` : ''}`}
          </button>
        </div>
      </div>
    </div>
  )
}
