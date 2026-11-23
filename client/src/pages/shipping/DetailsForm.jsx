import { useState } from 'react'

/**
 * Delivery details for one parcel: who, where, and what is in it. Shared by the ship drawer (an
 * order waiting for its AWB) and a support ticket (a customer asking for a change).
 * `onSubmit(values)` returns a promise; `lock` lists fields that can't change any more.
 */
export default function DetailsForm({ initial = {}, onSubmit, onCancel, submitLabel = 'Save', busy, lock = [], note }) {
  const [f, setF] = useState(() => ({
    name: initial.name || '', phone: String(initial.phone || '').replace(/\D/g, '').slice(-10),
    address: initial.address || '', city: initial.city || '', state: initial.state || '',
    pincode: initial.pincode || '', products_desc: initial.products_desc || '',
  }))
  const set = (patch) => setF(x => ({ ...x, ...patch }))
  const off = (k) => lock.includes(k)
  return (
    <form className="ship-details-form" onSubmit={e => { e.preventDefault(); onSubmit(f) }}>
      <div className="form-row">
        <div className="input-group"><label htmlFor="df-name">Name</label><input id="df-name" value={f.name} disabled={off('name')} onChange={e => set({ name: e.target.value })} /></div>
        <div className="input-group"><label htmlFor="df-phone">Mobile</label><input id="df-phone" inputMode="tel" value={f.phone} disabled={off('phone')} onChange={e => set({ phone: e.target.value })} /></div>
      </div>
      <div className="input-group"><label htmlFor="df-add">Address</label>
        <textarea id="df-add" rows={2} value={f.address} disabled={off('address')} onChange={e => set({ address: e.target.value })} /></div>
      <div className="form-row">
        <div className="input-group"><label htmlFor="df-city">City</label><input id="df-city" value={f.city} disabled={off('city')} onChange={e => set({ city: e.target.value })} /></div>
        <div className="input-group"><label htmlFor="df-state">State</label><input id="df-state" value={f.state} disabled={off('state')} onChange={e => set({ state: e.target.value })} /></div>
        <div className="input-group"><label htmlFor="df-pin">Pincode</label><input id="df-pin" inputMode="numeric" maxLength={6} value={f.pincode} disabled={off('pincode')} onChange={e => set({ pincode: e.target.value.replace(/\D/g, '') })} /></div>
      </div>
      <div className="input-group"><label htmlFor="df-prod">Products and sizes <span className="label-hint">as printed on the label</span></label>
        <input id="df-prod" value={f.products_desc} disabled={off('products_desc')} placeholder="e.g. Dr Doom Hoodie - Green / L x1" onChange={e => set({ products_desc: e.target.value })} /></div>
      {note && <p className="packed-sub" style={{ margin: 0, maxWidth: 'none' }}>{note}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? 'Saving…' : submitLabel}</button>
        {onCancel && <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel} disabled={busy}>Cancel</button>}
      </div>
    </form>
  )
}
