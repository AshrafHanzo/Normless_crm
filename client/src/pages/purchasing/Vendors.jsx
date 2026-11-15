import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApi } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import useServerTable from '../../hooks/useServerTable'
import SortTh from '../../components/SortTh'
import Pagination from '../../components/Pagination'
import VendorDrawer from './VendorDrawer'
import { BRAND_LABEL, inr, day } from './format'


export default function Vendors() {
  const apiFetch = useApi()
  const toast = useToast()
  const navigate = useNavigate()
  const t = useServerTable({ sort: 'name', dir: 'asc' })
  const [meta, setMeta] = useState(null)
  const [vendors, setVendors] = useState([])
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [term, setTerm] = useState('')
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [brand, setBrand] = useState('')
  const [status, setStatus] = useState('active')
  const [adding, setAdding] = useState(false)
  const seq = useRef(0)

  // apiFetch is a new function every render (see useApi), so it can't be a dependency here.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { apiFetch('/api/vendors/meta').then(r => r && !r.error && setMeta(r)) }, [])

  // Typing waits a moment before searching, so each keystroke isn't a request.
  useEffect(() => {
    const id = setTimeout(() => { setSearch(term.trim()); t.resetPage() }, 300)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term])

  const load = async () => {
    const mine = ++seq.current
    setLoading(true)
    const r = await apiFetch(`/api/vendors?${t.query({ search, category, brand, status })}`)
    if (mine !== seq.current) return
    setLoading(false)
    if (!r || r.error) { if (r?.error) toast.error(r.error); return }
    setVendors(r.vendors); setSummary(r.summary); t.setPagination(r.pagination)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [t.key, search, category, brand, status])

  const filter = (setter) => (e) => { setter(e.target.value); t.resetPage() }
  const canEdit = !!meta?.can?.edit
  const filtered = search || category || brand || status !== 'active'

  const kpis = [
    { label: 'Active vendors', value: summary?.active ?? '—', icon: <Icon name="truck" size={18} /> },
    { label: 'With open orders', value: summary?.with_open_orders ?? '—', icon: <Icon name="box" size={18} /> },
    { label: 'No WhatsApp number', value: summary?.missing_phone ?? '—', icon: <Icon name="phone" size={18} />, warn: summary?.missing_phone > 0 },
    { label: 'Archived', value: summary?.archived ?? '—', icon: <Icon name="database" size={18} /> },
  ]

  return (
    <div className="page-enter">
      <div className="dash-toolbar">
        <div>
          <h1>Vendors</h1>
          <p style={{ color: 'var(--text-muted)' }}>One vendor list for Normless and Crewfit</p>
        </div>
        {canEdit && (
          <button className="btn btn-primary" onClick={() => setAdding(true)}><Icon name="plus" size={15} /> Add vendor</button>
        )}
      </div>

      <div className="kpi-grid">
        {kpis.map(k => (
          <div className="kpi-card" key={k.label}>
            <div className="kpi-head"><div className="kpi-icon">{k.icon}</div></div>
            <div className="kpi-value" style={k.warn ? { color: 'var(--warning)' } : undefined}>{k.value}</div>
            <div className="kpi-label">{k.label}</div>
          </div>
        ))}
      </div>

      <div className="filters-row filters-row-search">
        <div className="search-bar"><span className="search-icon" />
          <input placeholder="Search name, contact, phone, GSTIN or city…" aria-label="Search vendors"
            value={term} onChange={e => setTerm(e.target.value)} />
        </div>
      </div>
      <div className="filters-row">
        <select value={category} onChange={filter(setCategory)} style={{ width: 'auto' }} aria-label="Category">
          <option value="">Every category</option>
          {(meta?.categories || []).map(c => <option key={c}>{c}</option>)}
        </select>
        <select value={brand} onChange={filter(setBrand)} style={{ width: 'auto' }} aria-label="Brand">
          <option value="">Both brands</option>
          <option value="normless">Supplies Normless</option>
          <option value="crewfit">Supplies Crewfit</option>
        </select>
        <select value={status} onChange={filter(setStatus)} style={{ width: 'auto' }} aria-label="Status">
          <option value="active">Active</option>
          <option value="archived">Archived</option>
          <option value="all">Active and archived</option>
        </select>
      </div>

      <div className="data-table-wrapper">
        {loading && !vendors.length ? <div className="loader"><div className="spinner" /></div> : !vendors.length ? (
          <div className="empty-state"><div className="empty-icon"><Icon name="truck" size={28} /></div>
            <p>{filtered ? 'No vendors match these filters.' : 'No vendors yet.'}</p>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <SortTh label="Vendor" col="name" sort={t.sort} onSort={t.toggle} />
                <SortTh label="Supplies" col="categories" sort={t.sort} onSort={t.toggle} />
                <SortTh label="For" col="brands" sort={t.sort} onSort={t.toggle} />
                <SortTh label="Orders" col="orders" sort={t.sort} onSort={t.toggle} align="center" />
                <SortTh label="Ordered value" col="ordered_value" sort={t.sort} onSort={t.toggle} align="right" />
                <SortTh label="Last order" col="last_order" sort={t.sort} onSort={t.toggle} />
              </tr>
            </thead>
            <tbody>
              {vendors.map(v => (
                <tr key={v.id} onClick={() => navigate(`/vendors/${v.id}`)} style={{ cursor: 'pointer', opacity: v.active ? 1 : 0.6 }}>
                  <td className="cell-primary">
                    <div style={{ fontWeight: 600 }}>{v.name}{!v.active && <span className="section-badge" style={{ marginLeft: 8 }}>Archived</span>}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {[v.contact_person, v.phone, v.city].filter(Boolean).join(' · ') || 'No contact details yet'}
                    </div>
                  </td>
                  <td data-label="Supplies" style={{ fontSize: 12.5 }}>{v.categories || <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                  <td data-label="For"><span className="badge-secondary">{BRAND_LABEL[v.brands] || v.brands}</span></td>
                  <td data-label="Orders" style={{ textAlign: 'center' }}>
                    {v.orders ? <><b>{v.open_orders}</b><span style={{ color: 'var(--text-muted)' }}> open / {v.orders}</span></> : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                  </td>
                  <td data-label="Ordered value" style={{ textAlign: 'right' }}>{Number(v.ordered_value) ? inr(v.ordered_value) : '—'}</td>
                  <td data-label="Last order" style={{ fontSize: 12.5 }}>{day(v.last_order)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!loading && vendors.length > 0 && <Pagination table={t} noun="vendors" />}
      </div>

      {adding && (
        <VendorDrawer vendor={null} meta={meta} canBank={!!meta?.can?.bank} apiFetch={apiFetch} toast={toast}
          onClose={() => setAdding(false)}
          onSaved={(id) => { setAdding(false); navigate(`/vendors/${id}`) }} />
      )}
    </div>
  )
}
