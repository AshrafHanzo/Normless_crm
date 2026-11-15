import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import useServerTable from '../../hooks/useServerTable'
import SortTh from '../../components/SortTh'
import Pagination from '../../components/Pagination'
import RecordPaymentDrawer from './RecordPaymentDrawer'
import { MODES, inr, day, openProof } from './format'

export default function VendorPayments() {
  const apiFetch = useApi()
  const toast = useToast()
  const t = useServerTable({ sort: 'paid_on', dir: 'desc' })
  const [meta, setMeta] = useState(null)
  const [rows, setRows] = useState([])
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [vendorId, setVendorId] = useState('')
  const [brand, setBrand] = useState('')
  const [mode, setMode] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [missing, setMissing] = useState(false)
  const [term, setTerm] = useState('')
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState(null)     // 'new' | payment id
  const seq = useRef(0)

  // apiFetch is a new function every render (see useApi), so it can't be a dependency here.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { apiFetch('/api/vendor-orders/meta').then(m => m && !m.error && setMeta(m)) }, [])

  useEffect(() => {
    const id = setTimeout(() => { setSearch(term.trim()); t.resetPage() }, 300)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term])

  const load = async () => {
    const mine = ++seq.current
    const r = await apiFetch('/api/vendor-payments?' + t.query({ vendor_id: vendorId, brand, mode, from, to, missing_ref: missing ? '1' : '', search }))
    if (mine !== seq.current) return
    setLoading(false)
    if (!r || r.error) { if (r?.error) toast.error(r.error); return }
    setRows(r.payments); setSummary(r.summary); t.setPagination(r.pagination)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [t.key, vendorId, brand, mode, from, to, missing, search])

  const filter = (setter) => (e) => { setter(e.target.value); t.resetPage() }
  const can = meta?.can || {}
  const vendors = (meta?.vendors || []).filter(v => v.id)

  const remove = async (p) => {
    if (!await toast.confirm({
      title: `Delete this ${inr(p.amount)} payment?`,
      message: `To ${p.vendor} on ${day(p.paid_on)}${p.reference ? `, ref ${p.reference}` : ''}. The orders it paid will show that amount as due again. This can’t be undone.`,
      danger: true, confirmLabel: 'Delete payment',
    })) return
    const r = await apiFetch(`/api/vendor-payments/${p.id}`, { method: 'DELETE' })
    if (r?.error) { toast.error(r.error); return }
    toast.success('Payment deleted')
    load()
  }

  return (
    <div className="page-enter">
      <div className="dash-toolbar">
        <div>
          <h1>Vendor Payments</h1>
          <p style={{ color: 'var(--text-muted)' }}>Every payment to a vendor, with its bank reference, for Normless and Crewfit</p>
        </div>
        {can.pay && <button className="btn btn-primary" onClick={() => setEditing('new')}><Icon name="plus" size={15} /> Record payment</button>}
      </div>

      <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        <div className="kpi-card"><div className="kpi-value">{summary ? inr(summary.total) : '—'}</div><div className="kpi-label">Paid{from || to || vendorId || brand || mode ? ' (filtered)' : ''}</div></div>
        <div className="kpi-card"><div className="kpi-value">{summary?.count ?? '—'}</div><div className="kpi-label">Payments</div></div>
        <button type="button" className="kpi-card kpi-clickable" style={{ textAlign: 'left' }} aria-pressed={missing}
          onClick={() => { setMissing(m => !m); t.resetPage() }}>
          <div className="kpi-value" style={summary?.missing_ref ? { color: 'var(--warning)' } : undefined}>{summary?.missing_ref ?? '—'}</div>
          <div className="kpi-label">{missing ? 'Showing only: missing UTR' : 'Missing a UTR — show them'}</div>
        </button>
      </div>

      <div className="filters-row filters-row-search">
        <div className="search-bar"><span className="search-icon" />
          <input placeholder="Search vendor, UTR or note…" aria-label="Search payments" value={term} onChange={e => setTerm(e.target.value)} />
        </div>
      </div>
      <div className="filters-row">
        <select value={vendorId} onChange={filter(setVendorId)} style={{ width: 'auto' }} aria-label="Vendor">
          <option value="">All vendors</option>
          {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        <select value={brand} onChange={filter(setBrand)} style={{ width: 'auto' }} aria-label="Brand">
          <option value="">Both brands</option>
          <option value="normless">Normless orders</option>
          <option value="crewfit">Crewfit orders</option>
        </select>
        <select value={mode} onChange={filter(setMode)} style={{ width: 'auto' }} aria-label="Mode">
          <option value="">Any mode</option>
          {MODES.map(m => <option key={m}>{m}</option>)}
        </select>
        <label className="vp-date"><span>From</span><input type="date" value={from} onChange={filter(setFrom)} /></label>
        <label className="vp-date"><span>To</span><input type="date" value={to} onChange={filter(setTo)} /></label>
      </div>

      <div className="data-table-wrapper">
        {loading ? <div className="loader"><div className="spinner" /></div> : !rows.length ? (
          <div className="empty-state"><div className="empty-icon"><Icon name="wallet" size={28} /></div>
            <p>{missing ? 'Every payment has its UTR.' : 'No payments match.'}</p>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <SortTh label="Paid on" col="paid_on" sort={t.sort} onSort={t.toggle} />
                <SortTh label="Vendor" col="vendor" sort={t.sort} onSort={t.toggle} />
                <SortTh label="For" />
                <SortTh label="Mode" col="mode" sort={t.sort} onSort={t.toggle} />
                <SortTh label="UTR / reference" col="reference" sort={t.sort} onSort={t.toggle} />
                <SortTh label="Amount" col="amount" sort={t.sort} onSort={t.toggle} align="right" />
                <SortTh label="" />
              </tr>
            </thead>
            <tbody>
              {rows.map(p => (
                <tr key={p.id} onClick={() => can.pay && setEditing(p.id)} style={{ cursor: can.pay ? 'pointer' : undefined }}>
                  <td data-label="Paid on" style={{ fontSize: 12.5 }}>{day(p.paid_on)}</td>
                  <td className="cell-primary">
                    <Link to={`/vendors/${p.vendor_id}`} onClick={e => e.stopPropagation()} style={{ fontWeight: 600, color: 'inherit' }}>{p.vendor}</Link>
                    {p.note && <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{p.note}</div>}
                  </td>
                  <td data-label="For" style={{ fontSize: 12.5 }}>
                    {p.allocations.map(a => <div key={a.order_id}>{a.ref} · {inr(a.amount)}</div>)}
                    {p.amount - p.allocated > 0.005 && <div style={{ color: 'var(--text-muted)' }}>On account · {inr(p.amount - p.allocated)}</div>}
                  </td>
                  <td data-label="Mode">{p.mode || '—'}</td>
                  <td data-label="UTR / reference">
                    {p.reference ? <span className="vp-mono">{p.reference}</span>
                      : p.missing_reference ? <span className="status-badge pending">Add UTR</span>
                        : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{p.source === 'migrated' ? 'Before payments were recorded' : '—'}</span>}
                  </td>
                  <td data-label="Amount" style={{ textAlign: 'right', fontWeight: 600 }}>{inr(p.amount)}</td>
                  <td className="cell-actions" data-label="Actions" onClick={e => e.stopPropagation()}>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      {p.has_proof && <button className="btn-icon" title="Open proof" aria-label="Open proof" onClick={() => openProof(apiFetch, toast, p.id)}><Icon name="eye" size={14} /></button>}
                      {can.delete && <button className="btn-icon" title="Delete" aria-label="Delete payment" style={{ color: 'var(--danger)' }} onClick={() => remove(p)}><Icon name="trash" size={14} /></button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!loading && rows.length > 0 && <Pagination table={t} noun="payments" />}
      </div>

      {editing && (
        <RecordPaymentDrawer paymentId={editing === 'new' ? null : editing} apiFetch={apiFetch} toast={toast}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }} />
      )}
    </div>
  )
}
