import { useState, useEffect, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import Icon from '../../components/Icon'
import useServerTable from '../../hooks/useServerTable'
import SortTh from '../../components/SortTh'
import Pagination from '../../components/Pagination'
import QuotationDrawer from './QuotationDrawer'
import { BRAND_LABEL, QUOTE_CLASS, inr, day, openFile } from './format'

/**
 * Quotations, for every vendor or one (`vendorId`). From here a quote is viewed, made into a new
 * vendor order, put on an order already raised, rejected, or reopened.
 */
export default function QuotationList({ apiFetch, toast, can, vendorId = null, filters = {}, adding = false, onAddClose, onChanged }) {
  const navigate = useNavigate()
  const t = useServerTable({ sort: 'quote_date', dir: 'desc' })
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)
  const [linking, setLinking] = useState(null)      // { quote, orders, pick }
  const seq = useRef(0)
  const filterKey = JSON.stringify(filters)

  const load = async () => {
    const mine = ++seq.current
    const r = await apiFetch('/api/vendor-quotations?' + t.query({ ...filters, vendor_id: vendorId || filters.vendor_id || '' }))
    if (mine !== seq.current) return
    setLoading(false)
    if (!r || r.error) { if (r?.error) toast.error(r.error); return }
    setRows(r.quotations); t.setPagination(r.pagination)
  }
  // apiFetch is a new function every render (see useApi), so it can't be a dependency here.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [t.key, filterKey, vendorId])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { t.resetPage() }, [filterKey])

  const changed = () => { load(); onChanged?.() }

  const act = async (url, body, done) => {
    const r = await apiFetch(url, { method: 'POST', body: JSON.stringify(body || {}) })
    if (r?.error) { toast.error(r.error); return false }
    if (done) toast.success(done)
    changed()
    return true
  }

  const startLink = async (q) => {
    const r = await apiFetch(`/api/vendor-orders?vendor_id=${q.vendor_id}&limit=200&sort=order_date&dir=desc`)
    if (!r || r.error) { toast.error(r?.error || 'Couldn’t load the orders'); return }
    const orders = (r.orders || []).filter(o => !o.quotation_id)
    if (!orders.length) { toast.error(`${q.vendor} has no order without a quotation to put this on`); return }
    setLinking({ quote: q, orders, pick: String(orders[0].id) })
  }

  const remove = async (q) => {
    if (!await toast.confirm({ title: `Delete quotation ${q.quote_no || q.title}?`, message: 'The quotation and its file are removed for good.', danger: true, confirmLabel: 'Delete' })) return
    const r = await apiFetch(`/api/vendor-quotations/${q.id}`, { method: 'DELETE' })
    if (r?.error) { toast.error(r.error); return }
    toast.success('Quotation deleted')
    changed()
  }

  return (
    <>
      <div className="data-table-wrapper">
        {loading ? <div className="loader"><div className="spinner" /></div> : !rows.length ? (
          <div className="empty-state"><div className="empty-icon"><Icon name="invoice" size={28} /></div>
            <p>No quotations{vendorId ? ' from this vendor' : ''} yet.</p>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <SortTh label="Date" col="quote_date" sort={t.sort} onSort={t.toggle} />
                {!vendorId && <SortTh label="Vendor" col="vendor" sort={t.sort} onSort={t.toggle} />}
                <SortTh label="Quotation" />
                <SortTh label="Amount" col="amount" sort={t.sort} onSort={t.toggle} align="right" />
                <SortTh label="Valid until" col="valid_until" sort={t.sort} onSort={t.toggle} />
                <SortTh label="Status" col="status" sort={t.sort} onSort={t.toggle} />
                <SortTh label="" />
              </tr>
            </thead>
            <tbody>
              {rows.map(q => (
                <tr key={q.id} onClick={() => can.edit && setEditing(q)} style={{ cursor: can.edit ? 'pointer' : undefined }}>
                  <td data-label="Date" style={{ fontSize: 12.5 }}>{day(q.quote_date)}</td>
                  {!vendorId && (
                    <td className="cell-primary"><Link to={`/vendors/${q.vendor_id}`} onClick={e => e.stopPropagation()} style={{ fontWeight: 600, color: 'inherit' }}>{q.vendor}</Link></td>
                  )}
                  <td className={vendorId ? 'cell-primary' : undefined} data-label="Quotation">
                    <b>{q.quote_no || '—'}</b> <span className="badge-secondary">{BRAND_LABEL[q.brand]}</span>
                    {(q.title || q.notes) && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{[q.title, q.notes].filter(Boolean).join(' · ')}</div>}
                  </td>
                  <td data-label="Amount" style={{ textAlign: 'right', fontWeight: 600 }}>{q.amount != null ? inr(q.amount) : '—'}</td>
                  <td data-label="Valid until" style={{ fontSize: 12.5 }}>{day(q.valid_until)}</td>
                  <td data-label="Status">
                    <span className={`status-badge ${QUOTE_CLASS[q.shown_status] || ''}`}>{q.shown_status}</span>
                    {q.order_ref && <div style={{ fontSize: 12, marginTop: 4 }}>on {q.order_ref}</div>}
                  </td>
                  <td className="cell-actions" data-label="Actions" onClick={e => e.stopPropagation()}>
                    {linking?.quote.id === q.id ? (
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                        <select value={linking.pick} onChange={e => setLinking(l => ({ ...l, pick: e.target.value }))} aria-label="Order to put it on" style={{ width: 'auto' }}>
                          {linking.orders.map(o => <option key={o.id} value={o.id}>{o.ref} · {day(o.order_date)}{o.title ? ` · ${o.title}` : ''}</option>)}
                        </select>
                        <button className="mini-btn mini-btn-active" onClick={async () => { if (await act(`/api/vendor-quotations/${q.id}/link`, { order_id: Number(linking.pick) }, 'Quotation put on the order')) setLinking(null) }}>Put on order</button>
                        <button className="mini-btn" onClick={() => setLinking(null)}>Cancel</button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap', alignItems: 'center' }}>
                        {q.has_file && <button className="btn-icon" title="View the quotation" aria-label={`View quotation ${q.quote_no || ''}`} onClick={() => openFile(apiFetch, toast, `/api/vendor-quotations/${q.id}/file`)}><Icon name="eye" size={14} /></button>}
                        {can.edit && q.status === 'Received' && (
                          <>
                            <button className="mini-btn mini-btn-active" onClick={() => navigate(`/vendor-orders?from_quote=${q.id}`)}>Make order</button>
                            <button className="mini-btn" onClick={() => startLink(q)}>Put on an order</button>
                            <button className="mini-btn" onClick={() => act(`/api/vendor-quotations/${q.id}/status`, { status: 'Rejected' }, 'Quotation rejected')}>Reject</button>
                          </>
                        )}
                        {can.edit && q.status === 'Rejected' && <button className="mini-btn" onClick={() => act(`/api/vendor-quotations/${q.id}/status`, { status: 'Received' }, 'Quotation reopened')}>Reopen</button>}
                        {can.edit && q.status === 'Accepted' && <button className="mini-btn" onClick={() => act(`/api/vendor-quotations/${q.id}/unlink`, {}, 'Taken off the order')}>Take off order</button>}
                        {can.delete && !q.order_id && <button className="btn-icon" title="Delete" aria-label="Delete quotation" style={{ color: 'var(--danger)' }} onClick={() => remove(q)}><Icon name="trash" size={14} /></button>}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!loading && rows.length > 0 && <Pagination table={t} noun="quotations" />}
      </div>

      {(editing || adding) && (
        <QuotationDrawer quotation={editing || null} vendorId={vendorId} defaultBrand={filters.brand} apiFetch={apiFetch} toast={toast}
          onClose={() => { setEditing(null); onAddClose?.() }}
          onSaved={() => { setEditing(null); onAddClose?.(); changed() }} />
      )}
    </>
  )
}
