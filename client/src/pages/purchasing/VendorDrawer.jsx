import { useState, useEffect, useRef } from 'react'
import Icon from '../../components/Icon'
import AutoTextarea from '../../components/AutoTextarea'
import useDirtyGuard from '../../hooks/useDirtyGuard'
import { cleanMobile, mobileError, isValidMobile, mobileInputProps } from '../../utils/phone'
import { BRAND_LABEL } from './format'

const FIELDS = ['name', 'contact_person', 'phone', 'email', 'address', 'city', 'state', 'gstin', 'pan',
  'payment_terms', 'notes', 'bank_account_name', 'bank_name', 'bank_account_no', 'bank_ifsc', 'upi_id']

const splitCats = (s) => String(s || '').split(',').map(c => c.trim()).filter(Boolean)

const fromVendor = (v) => ({
  ...Object.fromEntries(FIELDS.map(f => [f, v?.[f] ?? ''])),
  brands: v?.brands || 'both',
  whatsapp_updates: v ? v.whatsapp_updates !== false : true,
  categories: splitCats(v?.categories),
})

/** Add or edit a vendor. `vendor` is null for a new one. Bank fields only appear with `canBank`. */
export default function VendorDrawer({ vendor, meta, canBank, apiFetch, toast, onClose, onSaved }) {
  const [form, setForm] = useState(() => fromVendor(vendor))
  const [newCat, setNewCat] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const errorRef = useRef(null)

  // The save button is pinned at the bottom and the message is at the top of a long form, so
  // bring it into view rather than leave it scrolled away.
  useEffect(() => { if (error) errorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }, [error])

  const guard = useDirtyGuard({
    snapshot: form,
    identity: vendor?.id ?? 'new',
    onDiscard: onClose,
    confirm: toast.confirm,
    title: vendor ? 'Discard your edits?' : 'Discard this vendor?',
    message: 'This vendor has unsaved details. Closing now will lose them.',
  })

  const set = (patch) => setForm(f => ({ ...f, ...patch }))
  const field = (key) => ({ value: form[key], onChange: e => set({ [key]: e.target.value }) })
  const hasCat = (c) => form.categories.some(x => x.toLowerCase() === c.toLowerCase())
  const toggleCat = (c) => set({ categories: hasCat(c) ? form.categories.filter(x => x.toLowerCase() !== c.toLowerCase()) : [...form.categories, c] })
  const addCat = () => {
    const c = newCat.trim()
    if (c && !hasCat(c)) set({ categories: [...form.categories, c] })
    setNewCat('')
  }
  const catOptions = [...(meta?.categories || []), ...form.categories.filter(c => !(meta?.categories || []).some(m => m.toLowerCase() === c.toLowerCase()))]

  const save = async () => {
    if (!form.name.trim()) { setError('Vendor name is required'); return }
    if (form.phone && !isValidMobile(form.phone)) { setError('Phone must be a 10-digit mobile number'); return }
    setSaving(true); setError('')
    const body = JSON.stringify({ ...form, categories: form.categories })
    const res = vendor
      ? await apiFetch(`/api/vendors/${vendor.id}`, { method: 'PUT', body })
      : await apiFetch('/api/vendors', { method: 'POST', body })
    setSaving(false)
    if (!res) return
    if (res.error) { setError(res.error); return }
    guard.reset()
    toast.success(vendor ? 'Vendor saved' : `${form.name.trim()} added`)
    onSaved(res.id ?? vendor?.id)
  }

  return (
    <div className="drawer-overlay" onClick={guard.requestClose}>
      <div className="drawer" onClick={e => e.stopPropagation()} role="dialog" aria-label={vendor ? `Edit ${vendor.name}` : 'Add vendor'}>
        <div className="drawer-header">
          <div>
            <h2 style={{ fontSize: 17 }}>{vendor ? `Edit ${vendor.name}` : 'Add vendor'}</h2>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>One list for Normless and Crewfit</div>
          </div>
          <button className="btn-icon" onClick={guard.requestClose} aria-label="Close"><Icon name="close" size={16} /></button>
        </div>

        <div className="drawer-body">
          {error && <div className="calc-warning" ref={errorRef} role="alert">{error}</div>}

          <div className="form-section">Vendor</div>
          <div className="form-row">
            <div className="input-group">
              <label htmlFor="v-name">Vendor name *</label>
              <input id="v-name" {...field('name')} placeholder="e.g. Spark 3D Print" autoFocus={!vendor} />
            </div>
            <div className="input-group">
              <label htmlFor="v-brands">Supplies</label>
              <select id="v-brands" value={form.brands} onChange={e => set({ brands: e.target.value })}>
                {Object.entries(BRAND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
          </div>
          <div className="input-group">
            <label>What they supply</label>
            <div className="chip-picker">
              {catOptions.map(c => (
                <button type="button" key={c} className={`chip ${hasCat(c) ? 'chip-on' : ''}`} aria-pressed={hasCat(c)} onClick={() => toggleCat(c)}>{c}</button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <input value={newCat} onChange={e => setNewCat(e.target.value)} placeholder="Another category"
                aria-label="Another category" onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCat() } }} />
              <button type="button" className="btn btn-secondary" onClick={addCat} disabled={!newCat.trim()}>Add</button>
            </div>
          </div>

          <div className="form-section">Contact</div>
          <div className="form-row">
            <div className="input-group">
              <label htmlFor="v-contact">Contact person</label>
              <input id="v-contact" {...field('contact_person')} />
            </div>
            <div className="input-group">
              <label htmlFor="v-phone">WhatsApp number</label>
              <input id="v-phone" {...mobileInputProps} value={form.phone} onChange={e => set({ phone: cleanMobile(e.target.value) })} />
              {mobileError(form.phone) && <div className="field-error">{mobileError(form.phone)}</div>}
            </div>
            <div className="input-group">
              <label htmlFor="v-email">Email</label>
              <input id="v-email" type="email" {...field('email')} />
            </div>
          </div>
          <label className="page-check" style={{ margin: '0 0 6px' }}>
            <input type="checkbox" checked={form.whatsapp_updates} onChange={e => set({ whatsapp_updates: e.target.checked })} />
            <Icon name="whatsapp" size={15} />
            <span><b>WhatsApp updates</b><em>Send this vendor order, delivery and payment updates from the Normless number, once vendor messages are switched on.</em></span>
          </label>

          <div className="form-section">Address &amp; tax</div>
          <div className="input-group">
            <label htmlFor="v-address">Address</label>
            <AutoTextarea id="v-address" minRows={2} {...field('address')} />
          </div>
          <div className="form-row">
            <div className="input-group"><label htmlFor="v-city">City</label><input id="v-city" {...field('city')} /></div>
            <div className="input-group"><label htmlFor="v-state">State</label><input id="v-state" {...field('state')} /></div>
          </div>
          <div className="form-row">
            <div className="input-group">
              <label htmlFor="v-gstin">GSTIN</label>
              <input id="v-gstin" {...field('gstin')} maxLength={15} placeholder="15 characters" style={{ textTransform: 'uppercase' }} />
            </div>
            <div className="input-group">
              <label htmlFor="v-pan">PAN</label>
              <input id="v-pan" {...field('pan')} maxLength={10} style={{ textTransform: 'uppercase' }} />
            </div>
          </div>

          <div className="form-section">Bank details</div>
          {canBank ? (
            <>
              <div className="form-row">
                <div className="input-group"><label htmlFor="v-acname">Account holder name</label><input id="v-acname" {...field('bank_account_name')} /></div>
                <div className="input-group"><label htmlFor="v-bank">Bank</label><input id="v-bank" {...field('bank_name')} /></div>
              </div>
              <div className="form-row">
                <div className="input-group">
                  <label htmlFor="v-acno">Account number</label>
                  <input id="v-acno" {...field('bank_account_no')} />
                </div>
                <div className="input-group">
                  <label htmlFor="v-ifsc">IFSC</label>
                  <input id="v-ifsc" {...field('bank_ifsc')} style={{ textTransform: 'uppercase' }} />
                </div>
                <div className="input-group"><label htmlFor="v-upi">UPI ID</label><input id="v-upi" {...field('upi_id')} placeholder="name@bank" /></div>
              </div>
            </>
          ) : (
            <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: 0 }}>
              {vendor?.bank_on_file ? `On file${vendor.bank_last4 ? ` (account ending ${vendor.bank_last4})` : ''}.` : 'Not on file.'}{' '}
              Only people who record vendor payments can see or change bank details.
            </p>
          )}

          <div className="form-section">Terms &amp; notes</div>
          <div className="input-group">
            <label htmlFor="v-terms">Payment terms</label>
            <input id="v-terms" {...field('payment_terms')} placeholder="e.g. 30% advance, balance on delivery" />
          </div>
          <div className="input-group">
            <label htmlFor="v-notes">Internal notes<span className="unit-hint"> never shown to the vendor</span></label>
            <AutoTextarea id="v-notes" minRows={2} {...field('notes')} />
          </div>
        </div>

        <div className="drawer-footer">
          <button className="btn btn-secondary" onClick={guard.requestClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : vendor ? 'Save vendor' : 'Add vendor'}</button>
        </div>
      </div>
    </div>
  )
}
