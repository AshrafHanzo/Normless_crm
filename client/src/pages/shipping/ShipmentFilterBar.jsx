import { useState, useEffect } from 'react'
import { useApi } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import MultiSearchSelect from '../../components/MultiSearchSelect'

const NO_FILTERS = { manifested_from: '', manifested_to: '', ordered_from: '', ordered_to: '', product: '', color: '', variant_size: '', tags: '' }

/**
 * Search, COD/prepaid, the Filters panel (dates, products, order tags, colour, size) and Download
 * CSV for one shipments list (`bucket`), the same as the Shipments tab offers. The choices in the
 * panel come from the list itself. `onChange(params)` gets the server query for the list.
 */
export default function ShipmentFilterBar({ bucket, onChange, csvName }) {
  const apiFetch = useApi()
  const toast = useToast()
  const [search, setSearch] = useState('')
  const [term, setTerm] = useState('')
  const [payment, setPayment] = useState('')
  const [filters, setFilters] = useState(NO_FILTERS)
  const [show, setShow] = useState(false)
  const [facets, setFacets] = useState({ products: [], colors: [], sizes: [], tags: [] })
  const [busy, setBusy] = useState(false)

  const products = filters.product ? filters.product.split('|') : []
  const tags = filters.tags ? filters.tags.split('|') : []
  const active = Object.values(filters).filter(Boolean).length
  const setF = (patch) => setFilters(f => ({ ...f, ...patch }))
  const params = () => Object.fromEntries(Object.entries({ q: term, ...filters, bucket, payment }).filter(([, v]) => v))

  useEffect(() => { const x = setTimeout(() => setTerm(search.trim()), 350); return () => clearTimeout(x) }, [search])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { onChange(params()) }, [term, payment, filters, bucket])

  // Choices from this list (its search, dates and payment), not the whole catalogue.
  const { product: _p, color: _c, variant_size: _s, tags: _t, ...listFilters } = filters // eslint-disable-line no-unused-vars
  const listKey = JSON.stringify([bucket, term, payment, listFilters])
  useEffect(() => {
    if (!show) return
    const q = Object.entries({ q: term, ...listFilters, bucket, payment, list: 'shipments' }).filter(([, v]) => v)
    const x = setTimeout(() => {
      apiFetch(`/api/shipping/filters?${new URLSearchParams(q).toString()}`).then(r => { if (r && !r.error) setFacets({ tags: [], ...r }) })
    }, 250)
    return () => clearTimeout(x)
  }, [listKey, show]) // eslint-disable-line react-hooks/exhaustive-deps

  const download = async () => {
    setBusy(true)
    const r = await apiFetch(`/api/shipping/shipments.csv?${new URLSearchParams(params()).toString()}`, { responseType: 'blob' })
    setBusy(false)
    if (!r || r.error) return toast.error(r?.error || 'Download failed')
    const href = URL.createObjectURL(r.blob)
    const a = document.createElement('a')
    a.href = href; a.download = r.filename || `${csvName || bucket}.csv`
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(href)
  }

  return (
    <>
      <div className="filters-row ship-filters">
        <div className="search-bar" style={{ flex: '1 1 260px' }}><span className="search-icon" />
          <input placeholder="AWBs or orders (paste many), name, phone or city" value={search} onChange={e => setSearch(e.target.value)} /></div>
        <select value={payment} style={{ width: 'auto' }} onChange={e => setPayment(e.target.value)} aria-label="Payment">
          <option value="">COD and prepaid</option><option value="COD">COD</option><option value="Prepaid">Prepaid</option>
        </select>
        <button type="button" className={`btn btn-secondary ${active ? 'ship-filter-on' : ''}`} onClick={() => setShow(v => !v)} aria-expanded={show}>
          <Icon name="filter" size={15} /> Filters{active ? ` (${active})` : ''}
        </button>
        <button type="button" className="btn btn-secondary" onClick={download} disabled={busy}>
          <Icon name="download" size={15} /> {busy ? 'Preparing…' : 'Download CSV'}
        </button>
      </div>

      {show && (
        <div className="ship-filter-panel">
          <div className="input-group"><span className="ship-field-label">Manifested</span>
            <div className="ship-range">
              <input type="date" aria-label="Manifested from" value={filters.manifested_from} onChange={e => setF({ manifested_from: e.target.value })} />
              <span>to</span>
              <input type="date" aria-label="Manifested to" value={filters.manifested_to} onChange={e => setF({ manifested_to: e.target.value })} />
            </div></div>
          <div className="input-group"><span className="ship-field-label">Order received</span>
            <div className="ship-range">
              <input type="date" aria-label="Ordered from" value={filters.ordered_from} onChange={e => setF({ ordered_from: e.target.value })} />
              <span>to</span>
              <input type="date" aria-label="Ordered to" value={filters.ordered_to} onChange={e => setF({ ordered_to: e.target.value })} />
            </div></div>
          <div className="input-group ship-filter-wide"><label htmlFor="cf-product">Products</label>
            <MultiSearchSelect id="cf-product" value={products} placeholder="Any product: type to find, tick several"
              options={[...new Set([...facets.products, ...products])].map(p => ({ value: p, label: p }))}
              onChange={(list) => setF({ product: list.join('|') })} /></div>
          <div className="input-group ship-filter-wide"><label htmlFor="cf-tags">Order tags</label>
            <MultiSearchSelect id="cf-tags" value={tags} placeholder={facets.tags.length ? 'Any tag: type to find, tick several' : 'No tags on these orders'}
              options={[...new Set([...facets.tags.map(x => x.tag), ...tags])].map(tag => {
                const n = facets.tags.find(x => x.tag === tag)?.count
                return { value: tag, label: n ? `${tag} (${n})` : tag }
              })}
              onChange={(list) => setF({ tags: list.join('|') })} /></div>
          <div className="input-group"><label htmlFor="cf-color">Colour</label>
            <select id="cf-color" value={filters.color} onChange={e => setF({ color: e.target.value })}>
              <option value="">Any colour</option>{facets.colors.map(c => <option key={c}>{c}</option>)}
            </select></div>
          <div className="input-group"><label htmlFor="cf-size">Size</label>
            <select id="cf-size" value={filters.variant_size} onChange={e => setF({ variant_size: e.target.value })}>
              <option value="">Any size</option>{facets.sizes.map(z => <option key={z}>{z}</option>)}
            </select></div>
          {active > 0 && <button type="button" className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-end' }} onClick={() => setFilters(NO_FILTERS)}>Clear filters</button>}
        </div>
      )}
    </>
  )
}
