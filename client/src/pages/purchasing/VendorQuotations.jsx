import { useState, useEffect } from 'react'
import { useApi } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import QuotationList from './QuotationList'

/** Every vendor's quotations, to compare and to turn the chosen one into an order. */
export default function VendorQuotations() {
  const apiFetch = useApi()
  const toast = useToast()
  const [meta, setMeta] = useState(null)
  const [vendorId, setVendorId] = useState('')
  const [brand, setBrand] = useState('')
  const [status, setStatus] = useState('Open')
  const [term, setTerm] = useState('')
  const [search, setSearch] = useState('')
  const [adding, setAdding] = useState(false)

  // apiFetch is a new function every render (see useApi), so it can't be a dependency here.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { apiFetch('/api/vendor-orders/meta').then(m => m && !m.error && setMeta(m)) }, [])
  useEffect(() => { const id = setTimeout(() => setSearch(term.trim()), 300); return () => clearTimeout(id) }, [term])

  const can = meta?.can || {}
  return (
    <div className="page-enter">
      <div className="dash-toolbar">
        <div>
          <h1>Quotations</h1>
          <p style={{ color: 'var(--text-muted)' }}>Quotes from vendors for Normless and Crewfit — compare them, then make the chosen one an order</p>
        </div>
        {can.edit && <button className="btn btn-primary" onClick={() => setAdding(true)}><Icon name="plus" size={15} /> Add quotation</button>}
      </div>

      <div className="filters-row filters-row-search">
        <div className="search-bar"><span className="search-icon" />
          <input placeholder="Search vendor, quotation no., what it’s for…" aria-label="Search quotations" value={term} onChange={e => setTerm(e.target.value)} />
        </div>
      </div>
      <div className="filters-row">
        <select value={vendorId} onChange={e => setVendorId(e.target.value)} style={{ width: 'auto' }} aria-label="Vendor">
          <option value="">All vendors</option>
          {(meta?.vendors || []).filter(v => v.id).map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        <select value={brand} onChange={e => setBrand(e.target.value)} style={{ width: 'auto' }} aria-label="Brand">
          <option value="">Both brands</option>
          <option value="normless">Normless</option>
          <option value="crewfit">Crewfit</option>
        </select>
        <select value={status} onChange={e => setStatus(e.target.value)} style={{ width: 'auto' }} aria-label="Status">
          <option value="Open">Open (not decided)</option>
          <option value="Expired">Expired</option>
          <option value="Accepted">Accepted</option>
          <option value="Rejected">Rejected</option>
          <option value="">All</option>
        </select>
      </div>

      <QuotationList apiFetch={apiFetch} toast={toast} can={can}
        filters={{ vendor_id: vendorId, brand, status, search }}
        adding={adding} onAddClose={() => setAdding(false)} />
    </div>
  )
}
