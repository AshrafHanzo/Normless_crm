import { useState, useEffect } from 'react'
import Icon from '../../components/Icon'
import { inr, day, openFile, waNote } from './format'

const TONE = { Accepted: 'fulfilled', Rejected: 'refunded', 'Under review': 'pending' }

/**
 * A vendor's invoices: the ones they uploaded on their link (to accept, or reject with a reason
 * they will see) and any the team added from their paper.
 */
export default function VendorInvoiceList({ vendorId, orders, can, apiFetch, toast, onChanged }) {
  const [rows, setRows] = useState(null)
  const [version, setVersion] = useState(0)
  const [rejecting, setRejecting] = useState(null)   // { id, reason }
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ invoice_no: '', invoice_date: '', amount: '', order_id: '' })
  const [file, setFile] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    apiFetch(`/api/vendor-invoices?vendor_id=${vendorId}`).then(r => { if (live && r && !r.error) setRows(r.invoices) })
    return () => { live = false }
    // apiFetch is a new function every render (see useApi), so it can't be a dependency here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorId, version])
  const reload = () => { setVersion(v => v + 1); onChanged?.() }

  const review = async (id, status, reason) => {
    const r = await apiFetch(`/api/vendor-invoices/${id}/review`, { method: 'POST', body: JSON.stringify({ status, reason }) })
    if (r?.error) { toast.error(r.error); return }
    toast.success(status === 'Accepted' ? 'Invoice accepted' : status === 'Rejected' ? 'Invoice rejected — the vendor sees the reason' : 'Back under review')
    waNote(toast, r?.whatsapp)
    setRejecting(null)
    reload()
  }

  const add = async (e) => {
    e.preventDefault()
    if (!form.invoice_no.trim() || !file) { toast.error('Enter the invoice number and attach the file'); return }
    setBusy(true)
    const fd = new FormData()
    fd.append('vendor_id', vendorId)
    for (const [k, v] of Object.entries(form)) fd.append(k, v)
    fd.append('file', file)
    const r = await apiFetch('/api/vendor-invoices', { method: 'POST', body: fd })
    setBusy(false)
    if (!r || r.error) { toast.error(r?.error || 'The invoice couldn’t be saved'); return }
    toast.success('Invoice added')
    setAdding(false); setForm({ invoice_no: '', invoice_date: '', amount: '', order_id: '' }); setFile(null)
    reload()
  }

  const remove = async (i) => {
    if (!await toast.confirm({ title: `Delete invoice ${i.invoice_no}?`, message: 'The invoice and its file are removed for good.', danger: true, confirmLabel: 'Delete' })) return
    const r = await apiFetch(`/api/vendor-invoices/${i.id}`, { method: 'DELETE' })
    if (r?.error) { toast.error(r.error); return }
    reload()
  }

  return (
    <>
      {can.edit && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
          {!adding && <button className="btn btn-secondary" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Add invoice</button>}
        </div>
      )}
      {adding && (
        <form className="glass-card" onSubmit={add} style={{ marginBottom: 14 }}>
          <div className="form-row">
            <div className="input-group"><label htmlFor="vi-no">Invoice no. *</label><input id="vi-no" value={form.invoice_no} onChange={e => setForm(f => ({ ...f, invoice_no: e.target.value }))} /></div>
            <div className="input-group"><label htmlFor="vi-date">Invoice date</label><input id="vi-date" type="date" value={form.invoice_date} onChange={e => setForm(f => ({ ...f, invoice_date: e.target.value }))} /></div>
            <div className="input-group"><label htmlFor="vi-amt">Amount, incl. GST (₹)</label><input id="vi-amt" type="number" min="0" step="any" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} /></div>
          </div>
          <div className="form-row">
            <div className="input-group">
              <label htmlFor="vi-order">For order</label>
              <select id="vi-order" value={form.order_id} onChange={e => setForm(f => ({ ...f, order_id: e.target.value }))}>
                <option value="">Not for one order</option>
                {orders.map(o => <option key={o.id} value={o.id}>{o.ref}{o.title ? ` · ${o.title}` : ''}</option>)}
              </select>
            </div>
            <div className="input-group"><label htmlFor="vi-file">File * <span className="unit-hint">PDF or photo, up to 10 MB</span></label><input id="vi-file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={e => setFile(e.target.files?.[0] || null)} /></div>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-secondary" onClick={() => setAdding(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Add invoice'}</button>
          </div>
        </form>
      )}

      <div className="data-table-wrapper">
        {!rows ? <div className="loader"><div className="spinner" /></div> : !rows.length ? (
          <div className="empty-state"><div className="empty-icon"><Icon name="invoice" size={28} /></div><p>No invoices yet. The vendor can upload them from their link.</p></div>
        ) : (
          <table className="data-table">
            <thead><tr><th>Invoice</th><th>Date</th><th>For</th><th style={{ textAlign: 'right' }}>Amount</th><th>From</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {rows.map(i => (
                <tr key={i.id}>
                  <td className="cell-primary"><b>{i.invoice_no}</b>{i.note && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{i.note}</div>}</td>
                  <td data-label="Date" style={{ fontSize: 12.5 }}>{day(i.invoice_date)}<div style={{ color: 'var(--text-muted)' }}>uploaded {day(i.uploaded_on)}</div></td>
                  <td data-label="For">{i.order_ref || '—'}</td>
                  <td data-label="Amount" style={{ textAlign: 'right', fontWeight: 600 }}>{i.amount != null ? inr(i.amount) : '—'}</td>
                  <td data-label="From" style={{ fontSize: 12.5 }}>{i.source === 'vendor' ? 'The vendor' : 'Our team'}</td>
                  <td data-label="Status">
                    <span className={`status-badge ${TONE[i.status] || ''}`}>{i.status}</span>
                    {i.reason && <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 4 }}>{i.reason}</div>}
                  </td>
                  <td className="cell-actions" data-label="Actions">
                    {rejecting?.id === i.id ? (
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                        <input autoFocus value={rejecting.reason} onChange={e => setRejecting({ id: i.id, reason: e.target.value })}
                          placeholder="Why — the vendor sees this" aria-label="Reason for rejecting" style={{ width: 220 }} />
                        <button className="mini-btn mini-btn-danger" onClick={() => review(i.id, 'Rejected', rejecting.reason)}>Reject</button>
                        <button className="mini-btn" onClick={() => setRejecting(null)}>Cancel</button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
                        <button className="btn-icon" title="View" aria-label={`View invoice ${i.invoice_no}`} onClick={() => openFile(apiFetch, toast, `/api/vendor-invoices/${i.id}/file`)}><Icon name="eye" size={14} /></button>
                        {can.edit && i.status !== 'Accepted' && <button className="mini-btn mini-btn-active" onClick={() => review(i.id, 'Accepted')}>Accept</button>}
                        {can.edit && i.status !== 'Rejected' && <button className="mini-btn" onClick={() => setRejecting({ id: i.id, reason: '' })}>Reject</button>}
                        {can.delete && <button className="btn-icon" title="Delete" aria-label={`Delete invoice ${i.invoice_no}`} style={{ color: 'var(--danger)' }} onClick={() => remove(i)}><Icon name="trash" size={14} /></button>}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
