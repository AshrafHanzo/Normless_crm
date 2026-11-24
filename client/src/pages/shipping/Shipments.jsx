import { useState, useEffect, Fragment } from 'react'
import { useApi } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import Pagination from '../../components/Pagination'
import useServerTable from '../../hooks/useServerTable'
import MultiSearchSelect from '../../components/MultiSearchSelect'
import { BUCKETS, BUCKET_BADGE, BUCKET_LABEL, day, dayTime, money, statusText, daysSince, plural, openLabels } from './common'

const countOf = (counts, key) => (key === 'pending' ? counts.pending_awb : counts[key])
const ORDER_LISTS = ['pending', 'on_hold']
// Lists whose parcels still have a label worth printing.
const LABEL_LISTS = ['ready_to_ship', 'ready_for_pickup', 'waiting_pickup', 'manual', 'all', 'in_transit', 'not_ready', 'recreated', 'recreated_all']
const NO_FILTERS = { manifested_from: '', manifested_to: '', ordered_from: '', ordered_to: '', product: '', color: '', variant_size: '' }

/**
 * Every shipment by status, the way the Delhivery portal lists them, plus the orders that still
 * need a shipment (Pending AWB, and the ones on hold that can't ship yet). Filters, paging and the
 * CSV download all go through the server, so the download is exactly the filtered list.
 */
export default function Shipments({ counts, bucket, setBucket, canManage, ship, open, go, rev, changed, searchSeed, hideNav }) {
  const apiFetch = useApi()
  const toast = useToast()
  const t = useServerTable({ limit: 50 })
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState(searchSeed || '')
  const [term, setTerm] = useState('')
  const [payment, setPayment] = useState('')
  const [packed, setPacked] = useState('')
  const [filters, setFilters] = useState(NO_FILTERS)
  const [showFilters, setShowFilters] = useState(false)
  const [facets, setFacets] = useState({ products: [], colors: [], sizes: [] })
  const [picked, setPicked] = useState({})     // key → row
  const [busy, setBusy] = useState('')
  const isOrders = ORDER_LISTS.includes(bucket)
  const isHold = bucket === 'on_hold'
  const keyOf = (r) => (isOrders ? r.order_number : r.id)
  const activeFilters = Object.entries(filters).filter(([k, v]) => v && !(isOrders && k.startsWith('manifested'))).length
  // Several products travel as one "|"-separated value; a shipment with any of them matches.
  const products = filters.product ? filters.product.split('|') : []

  useEffect(() => { apiFetch('/api/shipping/filters').then(r => { if (r && !r.error) setFacets(r) }) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const x = setTimeout(() => setTerm(search.trim()), 350); return () => clearTimeout(x) }, [search])
  useEffect(() => { t.resetPage(); setPicked({}) }, [bucket, term, payment, packed, filters]) // eslint-disable-line react-hooks/exhaustive-deps

  const params = () => {
    const f = { q: term, ...filters }
    if (isOrders) {
      delete f.manifested_from; delete f.manifested_to
      return { ...f, packed, hold: isHold ? 'only' : '' }
    }
    return { ...f, bucket: bucket === 'all' ? '' : bucket, payment }
  }

  useEffect(() => {
    let live = true
    setLoading(true)
    const url = isOrders ? `/api/shipping/pending?${t.query(params())}` : `/api/shipping/shipments?${t.query(params())}`
    apiFetch(url).then(r => {
      if (!live) return
      setLoading(false)
      if (!r || r.error) { setRows([]); t.setPagination({ total: 0, page: 1, limit: t.limit, totalPages: 1 }); return }
      setRows(isOrders ? r.orders : r.shipments)
      t.setPagination(r.pagination)
    })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bucket, term, payment, packed, filters, t.key, rev])

  const download = async () => {
    setBusy('csv')
    const q = new URLSearchParams(Object.entries(params()).filter(([, v]) => v)).toString()
    const r = await apiFetch(`/api/shipping/${isOrders ? 'pending' : 'shipments'}.csv?${q}`, { responseType: 'blob' })
    setBusy('')
    if (!r || r.error) return toast.error(r?.error || 'Download failed')
    const href = URL.createObjectURL(r.blob)
    const a = document.createElement('a')
    a.href = href; a.download = r.filename || `${bucket}.csv`
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(href)
  }

  // The team holds orders a customer or the AI agent asked to stop (from a support ticket).
  const hold = async (list) => {
    const reason = await toast.prompt({
      title: list.length === 1 ? `Put ${list[0].order_number} on hold?` : `Put ${list.length} orders on hold?`,
      message: 'They leave Pending AWB, can\'t get an AWB, and the packing bench refuses them until someone releases them.',
      input: { label: 'Why', placeholder: 'e.g. CS-0123: customer is changing the address' },
      confirmLabel: 'Put on hold',
    })
    if (reason == null) return
    setBusy('hold')
    const r = await apiFetch('/api/shipping/hold', { method: 'POST', body: JSON.stringify({ order_numbers: list.map(o => o.order_number), reason }) })
    setBusy('')
    if (!r || r.error) return toast.error(r?.error || 'Could not hold them')
    if (r.held.length) toast.success(`${plural(r.held.length, 'order')} on hold`)
    if (r.errors.length) toast.error(r.errors.map(e => `${e.order_number} ${e.error}`).join("; "), { title: `${plural(r.errors.length, 'order')} not held` })
    setPicked({}); changed?.()
  }
  const release = async (list) => {
    const mine = list.filter(o => o.held_at)
    if (!mine.length) return toast.error('These are on hold in Shopify; they come back by themselves once Shopify releases them.')
    if (!await toast.confirm({
      title: mine.length === 1 ? `Release ${mine[0].order_number}?` : `Release ${mine.length} orders?`,
      message: 'They go back to Pending AWB and can be packed and shipped.',
      details: mine.length === 1 ? [{ label: 'Held because', value: mine[0].hold_reason }, { label: 'Held by', value: mine[0].held_by }] : undefined,
      confirmLabel: 'Release',
    })) return
    setBusy('hold')
    const r = await apiFetch('/api/shipping/release', { method: 'POST', body: JSON.stringify({ order_numbers: mine.map(o => o.order_number) }) })
    setBusy('')
    if (!r || r.error) return toast.error(r?.error || 'Could not release them')
    if (r.released.length) toast.success(`${plural(r.released.length, 'order')} back in Pending AWB`)
    if (r.still_held_in_shopify.length) toast.warning(`${r.still_held_in_shopify.join(', ')} still on hold in Shopify`)
    setPicked({}); changed?.()
  }

  const printLabels = async (ids) => {
    setBusy('labels')
    await openLabels(apiFetch, toast, { ids })
    setBusy('')
  }

  const pickedList = Object.values(picked)
  const allPicked = rows.length > 0 && rows.every(r => picked[keyOf(r)])
  const toggle = (r) => setPicked(p => { const n = { ...p }; if (n[keyOf(r)]) delete n[keyOf(r)]; else n[keyOf(r)] = r; return n })
  const toggleAll = () => setPicked(p => {
    if (allPicked) { const n = { ...p }; rows.forEach(r => delete n[keyOf(r)]); return n }
    return { ...p, ...Object.fromEntries(rows.map(r => [keyOf(r), r])) }
  })
  const setF = (patch) => setFilters(f => ({ ...f, ...patch }))
  const canLabel = !isOrders && LABEL_LISTS.includes(bucket)

  return (
    <div className="ship-layout">
      {!hideNav && <nav className="ship-status-nav" aria-label="Shipment status">
        {BUCKETS.map(b => {
          const n = countOf(counts, b.key)
          return (
            <Fragment key={b.key}>
              {b.heading && <p className="ship-nav-heading">{b.heading}</p>}
              <button type="button" aria-current={bucket === b.key ? 'page' : undefined}
                className={[bucket === b.key && 'active', b.sub && 'sub', b.tone].filter(Boolean).join(' ')}
                onClick={() => (b.key === 'cancelled_open' ? go('cancelled') : b.key === 'recreated' ? go('recreated') : setBucket(b.key))}>
                {b.label}
                {n != null && <span className={`ship-count ${b.key === 'cancelled_open' && n > 0 ? 'hot' : ''}`}>{n.toLocaleString('en-IN')}</span>}
              </button>
            </Fragment>
          )
        })}
      </nav>}

      <section className="ship-main">
        {counts.cancelled_open > 0 && (
          <div className="ship-alert danger">
            <strong>{plural(counts.cancelled_open, 'shipment')} auto-cancelled by Delhivery</strong>
            <button className="btn btn-primary btn-sm ship-alert-action" onClick={() => go('cancelled')}>Re-create</button>
          </div>
        )}
        {isHold && (
          <div className="ship-alert info">
            <span>Orders the team put on hold (from a support ticket), and orders on hold in Shopify, usually a return or exchange waiting for a decision. None of these can get an AWB or be packed. Release the team's holds here; Shopify's come back by themselves once Shopify releases them.</span>
          </div>
        )}

        <div className="filters-row ship-filters">
          <div className="search-bar" style={{ flex: '1 1 260px' }}><span className="search-icon" />
            <input placeholder={isOrders ? 'Order numbers (paste many), name or phone' : 'AWBs or orders (paste many), name, phone or city'}
              value={search} onChange={e => setSearch(e.target.value)} /></div>
          {isOrders ? (
            <select value={packed} style={{ width: 'auto' }} onChange={e => setPacked(e.target.value)} aria-label="Packed">
              <option value="">Packed or not</option><option value="yes">Packed</option><option value="no">Not packed yet</option>
            </select>
          ) : bucket.startsWith('return') ? null : (
            <select value={payment} style={{ width: 'auto' }} onChange={e => setPayment(e.target.value)} aria-label="Payment">
              <option value="">COD and prepaid</option><option value="COD">COD</option><option value="Prepaid">Prepaid</option>
            </select>
          )}
          <button type="button" className={`btn btn-secondary ${activeFilters ? 'ship-filter-on' : ''}`} onClick={() => setShowFilters(v => !v)} aria-expanded={showFilters}>
            <Icon name="filter" size={15} /> Filters{activeFilters ? ` (${activeFilters})` : ''}
          </button>
          <button type="button" className="btn btn-secondary" onClick={download} disabled={busy === 'csv'}>
            <Icon name="download" size={15} /> {busy === 'csv' ? 'Preparing…' : 'Download CSV'}
          </button>
        </div>

        {showFilters && (
          <div className="ship-filter-panel">
            {!isOrders && (
              <div className="input-group"><span className="ship-field-label">Manifested</span>
                <div className="ship-range">
                  <input type="date" aria-label="Manifested from" value={filters.manifested_from} onChange={e => setF({ manifested_from: e.target.value })} />
                  <span>to</span>
                  <input type="date" aria-label="Manifested to" value={filters.manifested_to} onChange={e => setF({ manifested_to: e.target.value })} />
                </div></div>
            )}
            <div className="input-group"><span className="ship-field-label">Order received</span>
              <div className="ship-range">
                <input type="date" aria-label="Ordered from" value={filters.ordered_from} onChange={e => setF({ ordered_from: e.target.value })} />
                <span>to</span>
                <input type="date" aria-label="Ordered to" value={filters.ordered_to} onChange={e => setF({ ordered_to: e.target.value })} />
              </div></div>
            <div className="input-group ship-filter-wide"><label htmlFor="sf-product">Products</label>
              <MultiSearchSelect id="sf-product" value={products} placeholder="Any product: type to find, tick several"
                options={facets.products.map(p => ({ value: p, label: p }))}
                onChange={(list) => setF({ product: list.join('|') })} /></div>
            <div className="input-group"><label htmlFor="sf-color">Colour</label>
              <select id="sf-color" value={filters.color} onChange={e => setF({ color: e.target.value })}>
                <option value="">Any colour</option>{facets.colors.map(c => <option key={c}>{c}</option>)}
              </select></div>
            <div className="input-group"><label htmlFor="sf-size">Size</label>
              <select id="sf-size" value={filters.variant_size} onChange={e => setF({ variant_size: e.target.value })}>
                <option value="">Any size</option>{facets.sizes.map(z => <option key={z}>{z}</option>)}
              </select></div>
            {activeFilters > 0 && <button type="button" className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-end' }} onClick={() => setFilters(NO_FILTERS)}>Clear filters</button>}
          </div>
        )}

        {pickedList.length > 0 && (
          <div className="ship-bulkbar">
            <strong>{pickedList.length} selected</strong>
            {isOrders && <span className="packed-sub" style={{ margin: 0 }}>{pickedList.filter(o => !o.packed_at).length ? `${pickedList.filter(o => !o.packed_at).length} not packed yet` : 'All packed'}</span>}
            <div className="ship-bulk-actions">
              <button className="btn btn-secondary btn-sm" onClick={() => { setPicked({}) }}>Clear</button>
              {isOrders && !isHold && canManage && (
                <button className="btn btn-primary btn-sm" onClick={() => ship(pickedList)}>
                  <Icon name="truck" size={14} /> Get AWB and labels for {pickedList.length}
                </button>
              )}
              {isOrders && !isHold && canManage && (
                <button className="btn btn-secondary btn-sm" disabled={busy === 'hold'} onClick={() => hold(pickedList)}>
                  <Icon name="clock" size={14} /> Hold {pickedList.length}
                </button>
              )}
              {isHold && canManage && (
                <button className="btn btn-primary btn-sm" disabled={busy === 'hold'} onClick={() => release(pickedList)}>
                  Release {pickedList.filter(o => o.held_at).length || ''}
                </button>
              )}
              {canLabel && (
                <button className="btn btn-primary btn-sm" disabled={busy === 'labels'} onClick={() => printLabels(pickedList.map(s => s.id))}>
                  <Icon name="printer" size={14} /> {busy === 'labels' ? 'Fetching…' : `Labels for ${pickedList.length}`}
                </button>
              )}
            </div>
          </div>
        )}

        <div className="data-table-wrapper">
          {loading ? <div className="loader"><div className="spinner" /></div> : !rows.length ? (
            <div className="empty-state">
              <div className="empty-icon">📦</div>
              <h3>{term || activeFilters ? 'Nothing matches that' : `Nothing in ${BUCKET_LABEL[bucket] || 'this list'}`}</h3>
              {bucket === 'pending' && !term && !activeFilters && <p>Every order has a shipment.</p>}
            </div>
          ) : isOrders ? (
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead><tr>
                  <th style={{ width: 36 }}><input type="checkbox" checked={allPicked} onChange={toggleAll} aria-label="Select all on this page" /></th>
                  <th>Order</th><th>Customer</th><th>Items</th><th>Payment</th><th>Packed</th><th aria-label="Action" />
                </tr></thead>
                <tbody>
                  {rows.map(o => (
                    <tr key={o.order_number}>
                      <td><input type="checkbox" checked={!!picked[o.order_number]} onChange={() => toggle(o)} aria-label={`Select ${o.order_number}`} /></td>
                      <td data-label="Order" className="cell-primary">{o.order_number}<div className="packed-sub">{dayTime(o.created_at)}</div>
                        {o.cancelled_awb && <div className="packed-sub" style={{ color: 'var(--danger)' }}>Auto-cancelled before</div>}
                        {o.on_hold && <span className="status-badge on-hold" style={{ marginTop: 4 }}>{o.held_at ? 'On hold' : 'On hold in Shopify'}</span>}
                        {o.held_at && <div className="ship-hold-note">{o.hold_reason}{o.held_by ? ` · ${o.held_by}, ${day(o.held_at)}` : ''}</div>}
                        {o.edited_at && <div className="packed-sub" style={{ color: 'var(--warning)' }}>Details edited</div>}</td>
                      <td data-label="Customer">{o.customer_name || '—'}<div className="packed-sub">{[o.city, o.pincode].filter(Boolean).join(' · ')}</div></td>
                      <td data-label="Items" style={{ maxWidth: 280 }}>{o.items.slice(0, 2).join(', ')}{o.items.length > 2 ? ` +${o.items.length - 2}` : ''}</td>
                      <td data-label="Payment">{money(o.total_price)} <span className={`status-badge ${o.cod ? 'pending' : 'paid'}`}>{o.cod ? 'COD' : 'Prepaid'}</span></td>
                      <td data-label="Packed">{o.packed_at ? <span style={{ color: 'var(--success)' }}>{dayTime(o.packed_at)}</span> : <span style={{ color: 'var(--text-muted)' }}>Not yet</span>}</td>
                      <td>{canManage && (
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                          <button className="btn btn-secondary btn-sm" onClick={() => ship([o], { editFirst: true })}><Icon name="edit" size={14} /> Edit</button>
                          {!o.on_hold && <button className="btn btn-secondary btn-sm" disabled={busy === 'hold'} onClick={() => hold([o])}>Hold</button>}
                          {o.held_at && <button className="btn btn-primary btn-sm" disabled={busy === 'hold'} onClick={() => release([o])}>Release</button>}
                          {!o.on_hold && <button className="btn btn-primary btn-sm" onClick={() => ship([o])}>Get AWB</button>}
                        </div>
                      )}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead><tr>
                  <th style={{ width: 36 }}><input type="checkbox" checked={allPicked} onChange={toggleAll} aria-label="Select all on this page" /></th>
                  <th>Order · AWB</th><th>Customer</th><th>Items</th><th>Payment</th><th>Freight</th><th>Status</th><th>Since</th><th>Made in</th>{canLabel && <th aria-label="Label" />}
                </tr></thead>
                <tbody>
                  {rows.map(s => {
                    const waited = s.bucket === 'waiting_pickup' ? daysSince(s.manifested_at || s.created_at) : null
                    return (
                      <tr key={s.id} onClick={() => open(s.id)} style={{ cursor: 'pointer' }}>
                        <td onClick={e => e.stopPropagation()}><input type="checkbox" checked={!!picked[s.id]} onChange={() => toggle(s)} aria-label={`Select ${s.awb}`} /></td>
                        <td data-label="Order · AWB" className="cell-primary">{s.order_number || s.delhivery_order || '—'}<div className="packed-sub ship-mono">{s.awb}</div>
                          {s.ordered_at && <div className="packed-sub">ordered {day(s.ordered_at)}</div>}</td>
                        <td data-label="Customer">{s.consignee_name || '—'}<div className="packed-sub">{[s.consignee_city || s.destination, s.consignee_pincode].filter(Boolean).join(' · ')}</div></td>
                        <td data-label="Items" style={{ maxWidth: 240 }}>{(s.items || []).slice(0, 2).join(', ') || '—'}{(s.items || []).length > 2 ? ` +${s.items.length - 2}` : ''}</td>
                        <td data-label="Payment">{s.payment_mode === 'COD' ? `COD ${money(s.cod_amount)}` : (s.payment_mode || '—')}</td>
                        <td data-label="Freight">{s.charge_estimate != null ? (
                          <>{money(s.charge_estimate)}<div className="packed-sub">{(s.pieces || 1) > 1 ? `${money(Number(s.charge_estimate) / s.pieces)} per item · ` : ''}{s.charge_zone ? `zone ${s.charge_zone}` : ''}</div></>
                        ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                        <td data-label="Status">
                          <span className={`status-badge ${BUCKET_BADGE[s.bucket] || 'pending'}`}>{BUCKET_LABEL[s.bucket] || s.bucket}</span>
                          <div className="packed-sub" style={['FMEOD-152', 'X-PNP'].includes(s.status_code) ? { color: 'var(--warning)' } : undefined}>{statusText(s)}</div>
                          {s.recreated_as && <div className="packed-sub">Re-created as <span className="ship-mono">{s.recreated_as}</span></div>}
                        </td>
                        <td data-label="Since" style={waited >= 2 ? { color: 'var(--warning)', fontWeight: 600 } : undefined}>
                          {day(s.status_at || s.created_at)}{waited != null && <div className="packed-sub">waiting {plural(waited, 'day')}</div>}
                        </td>
                        <td data-label="Made in">{s.source === 'manual' ? 'Manual' : s.created_via === 'crm' ? 'CRM' : 'Portal'}</td>
                        {canLabel && (
                          <td onClick={e => e.stopPropagation()}>
                            {['waiting_pickup', 'in_transit'].includes(s.bucket) && (
                              <button className="btn-icon" title="Label" aria-label={`Label for ${s.awb}`} disabled={busy === 'labels'} onClick={() => printLabels([s.id])}><Icon name="printer" size={16} /></button>
                            )}
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <Pagination table={t} noun={isOrders ? 'orders' : 'shipments'} />
      </section>
    </div>
  )
}
