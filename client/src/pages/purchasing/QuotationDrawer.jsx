import { useState, useEffect } from 'react'
import Icon from '../../components/Icon'
import useDirtyGuard from '../../hooks/useDirtyGuard'
import useErrorInView from './useErrorInView'
import { BRAND_LABEL, todayYmd, openFile } from './format'

const BRANDS = ['normless', 'crewfit']

/** Add a vendor's quotation (with its PDF or photo), or edit one. */
export default function QuotationDrawer({ quotation, vendorId: fixedVendor, defaultBrand, apiFetch, toast, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({
    vendor_id: quotation?.vendor_id || fixedVendor || '',
    brand: quotation?.brand || defaultBrand || 'normless',
    quote_no: quotation?.quote_no || '',
    quote_date: quotation?.quote_date || todayYmd(),
    valid_until: quotation?.valid_until || '',
    title: quotation?.title || '',
    amount: quotation?.amount ?? '',
    notes: quotation?.notes || '',
  }))
  const [file, setFile] = useState(null)
  const [vendors, setVendors] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const errorRef = useErrorInView(error)

  useEffect(() => {
    if (fixedVendor) return
    let live = true
    apiFetch('/api/vendor-orders/meta').then(r => { if (live && r && !r.error) setVendors((r.vendors || []).filter(v => v.id)) })
    return () => { live = false }
    // apiFetch is a new function every render (see useApi), so it can't be a dependency here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const guard = useDirtyGuard({
    snapshot: { ...form, file: file?.name || null },
    identity: quotation?.id ?? 'new',
    onDiscard: onClose,
    confirm: toast.confirm,
    title: quotation ? 'Discard your edits?' : 'Discard this quotation?',
    message: 'The quotation hasn’t been saved. Closing now will lose it.',
  })

  const set = (patch) => setForm(f => ({ ...f, ...patch }))
  const field = (k) => ({ value: form[k], onChange: e => set({ [k]: e.target.value }) })

  const save = async () => {
    if (!form.vendor_id) { setError('Pick the vendor who sent the quotation'); return }
    if (!form.quote_no.trim() && !form.title.trim()) { setError('Give the quotation number or a title'); return }
    setSaving(true); setError('')
    const fd = new FormData()
    for (const [k, v] of Object.entries(form)) fd.append(k, v ?? '')
    if (file) fd.append('file', file)
    const res = quotation
      ? await apiFetch(`/api/vendor-quotations/${quotation.id}`, { method: 'PUT', body: fd })
      : await apiFetch('/api/vendor-quotations', { method: 'POST', body: fd })
    setSaving(false)
    if (!res) return
    if (res.error) { setError(res.error); return }
    guard.reset()
    toast.success(quotation ? 'Quotation saved' : 'Quotation added')
    onSaved(res.id)
  }

  return (
    <div className="drawer-overlay" onClick={guard.requestClose}>
      <div className="drawer" onClick={e => e.stopPropagation()} role="dialog" aria-label={quotation ? 'Edit quotation' : 'Add quotation'}>
        <div className="drawer-header">
          <div>
            <h2 style={{ fontSize: 17 }}>{quotation ? `Quotation ${quotation.quote_no || ''}` : 'Add quotation'}</h2>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>As the vendor sent it — amounts include GST</div>
          </div>
          <button className="btn-icon" onClick={guard.requestClose} aria-label="Close"><Icon name="close" size={16} /></button>
        </div>

        <div className="drawer-body">
          {error && <div className="calc-warning" role="alert" ref={errorRef}>{error}</div>}

          {!fixedVendor && (
            <div className="input-group">
              <label htmlFor="q-vendor">Vendor *</label>
              <select id="q-vendor" value={form.vendor_id} disabled={!!quotation?.order_id} onChange={e => set({ vendor_id: e.target.value })}>
                <option value="">{vendors ? 'Pick a vendor' : 'Loading…'}</option>
                {(vendors || []).map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                {quotation && !vendors?.some(v => String(v.id) === String(form.vendor_id)) && <option value={form.vendor_id}>{quotation.vendor}</option>}
              </select>
            </div>
          )}
          <div className="input-group" style={{ marginBottom: 0 }}>
            <label>For</label>
            <div className="chip-picker" role="radiogroup" aria-label="Brand">
              {BRANDS.map(b => (
                <button type="button" key={b} role="radio" aria-checked={form.brand === b}
                  className={`chip ${form.brand === b ? 'chip-on' : ''}`} onClick={() => set({ brand: b })}>{BRAND_LABEL[b]}</button>
              ))}
            </div>
          </div>
          <div className="form-row">
            <div className="input-group"><label htmlFor="q-no">Quotation no.</label><input id="q-no" {...field('quote_no')} placeholder="e.g. EDS0109136" /></div>
            <div className="input-group"><label htmlFor="q-amount">Amount, incl. GST (₹)</label><input id="q-amount" type="number" min="0" step="any" {...field('amount')} /></div>
          </div>
          <div className="form-row">
            <div className="input-group"><label htmlFor="q-date">Quotation date</label><input id="q-date" type="date" {...field('quote_date')} /></div>
            <div className="input-group"><label htmlFor="q-valid">Valid until<span className="unit-hint"> optional</span></label><input id="q-valid" type="date" min={form.quote_date || undefined} {...field('valid_until')} /></div>
          </div>
          <div className="input-group">
            <label htmlFor="q-title">What it’s for</label>
            <input id="q-title" {...field('title')} placeholder="e.g. Masks + disk sets for the Dec drop" />
          </div>
          <div className="input-group">
            <label htmlFor="q-file">The quotation file<span className="unit-hint"> PDF or photo, up to 15 MB</span></label>
            {quotation?.has_file && !file && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                <span style={{ color: 'var(--text-muted)' }}>On file: {quotation.file_name}</span>
                <button type="button" className="mini-btn" onClick={() => openFile(apiFetch, toast, `/api/vendor-quotations/${quotation.id}/file`)}>View</button>
              </div>
            )}
            <input id="q-file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={e => setFile(e.target.files?.[0] || null)} />
          </div>
          <div className="input-group">
            <label htmlFor="q-notes">Notes<span className="unit-hint"> optional</span></label>
            <input id="q-notes" {...field('notes')} placeholder="e.g. 5 equal instalments, 3 weeks to deliver" />
          </div>
        </div>

        <div className="drawer-footer">
          <button className="btn btn-secondary" onClick={guard.requestClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : quotation ? 'Save quotation' : 'Add quotation'}</button>
        </div>
      </div>
    </div>
  )
}
