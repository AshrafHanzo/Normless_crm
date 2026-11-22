import { useState, useEffect, Fragment } from 'react'
import { useApi } from '../../App'
import Icon from '../../components/Icon'
import { BUCKETS, BUCKET_BADGE, BUCKET_LABEL, day, dayTime, money, statusText, daysSince, plural } from './common'

const countOf = (counts, key) => (key === 'pending' ? counts.pending_awb : counts[key])

function Pager({ page, size, total, onPage }) {
  const last = Math.max(1, Math.ceil(total / size))
  if (total <= size) return <p className="packed-sub" style={{ margin: '12px 2px', maxWidth: 'none' }}>{plural(total, 'result')}</p>
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '14px 2px', flexWrap: 'wrap' }}>
      <span className="packed-sub" style={{ maxWidth: 'none' }}>Showing {(page - 1) * size + 1}–{Math.min(page * size, total)} of {total}</span>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
        <button className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
        <button className="btn btn-secondary btn-sm" disabled={page >= last} onClick={() => onPage(page + 1)}>Next</button>
      </div>
    </div>
  )
}

/**
 * Every shipment by status, the way the Delhivery portal lists them, plus "Pending AWB": the
 * orders that still need a shipment. Pending orders are picked and sent to the ship drawer; a
 * shipment opens its own drawer.
 */
export default function Shipments({ counts, bucket, setBucket, canManage, ship, open, go, rev }) {
  const apiFetch = useApi()
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [term, setTerm] = useState('')
  const [payment, setPayment] = useState('')
  const [packed, setPacked] = useState('')
  const [picked, setPicked] = useState({})     // order_number → order, for Pending AWB
  const isPending = bucket === 'pending'

  useEffect(() => { const t = setTimeout(() => setTerm(search.trim()), 350); return () => clearTimeout(t) }, [search])
  useEffect(() => { setPage(1); setPicked({}) }, [bucket, term, payment, packed])

  useEffect(() => {
    let live = true
    setLoading(true)
    const q = new URLSearchParams({ page: String(page), size: '50' })
    if (term) q.set('q', term)
    let url
    if (isPending) {
      if (packed) q.set('packed', packed)
      url = `/api/shipping/pending?${q}`
    } else {
      if (bucket !== 'all') q.set('bucket', bucket)
      if (payment) q.set('payment', payment)
      url = `/api/shipping/shipments?${q}`
    }
    apiFetch(url).then(r => {
      if (!live) return
      setLoading(false)
      if (!r || r.error) { setRows([]); setTotal(0); return }
      setRows(isPending ? r.orders : r.shipments)
      setTotal(r.total)
    })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bucket, term, payment, packed, page, rev])

  const pickedList = Object.values(picked)
  const allPicked = isPending && rows.length > 0 && rows.every(r => picked[r.order_number])
  const toggle = (o) => setPicked(p => { const n = { ...p }; if (n[o.order_number]) delete n[o.order_number]; else n[o.order_number] = o; return n })
  const toggleAll = () => setPicked(p => {
    if (allPicked) { const n = { ...p }; rows.forEach(r => delete n[r.order_number]); return n }
    return { ...p, ...Object.fromEntries(rows.map(r => [r.order_number, r])) }
  })

  return (
    <div className="ship-layout">
      <nav className="ship-status-nav" aria-label="Shipment status">
        {BUCKETS.map(b => {
          const n = countOf(counts, b.key)
          return (
            <Fragment key={b.key}>
            {b.heading && <p className="ship-nav-heading">{b.heading}</p>}
            <button type="button" aria-current={bucket === b.key ? 'page' : undefined}
              className={[bucket === b.key && 'active', b.sub && 'sub', b.tone].filter(Boolean).join(' ')}
              onClick={() => (b.key === 'cancelled_open' ? go('cancelled') : setBucket(b.key))}>
              {b.label}
              {n != null && <span className={`ship-count ${b.key === 'cancelled_open' && n > 0 ? 'hot' : ''}`}>{n.toLocaleString('en-IN')}</span>}
            </button>
            </Fragment>
          )
        })}
      </nav>

      <section className="ship-main">
        {counts.cancelled_open > 0 && (
          <div className="ship-alert danger">
            <strong>{plural(counts.cancelled_open, 'shipment')} auto-cancelled by Delhivery</strong>
            <button className="btn btn-primary btn-sm ship-alert-action" onClick={() => go('cancelled')}>Re-create</button>
          </div>
        )}

        <div className="filters-row" style={{ marginBottom: 14 }}>
          <div className="search-bar" style={{ flex: '1 1 260px' }}><span className="search-icon" />
            <input placeholder={isPending ? 'Order numbers (paste many), name or phone' : 'AWBs or orders (paste many), name or city'}
              value={search} onChange={e => setSearch(e.target.value)} /></div>
          {isPending ? (
            <select value={packed} style={{ width: 'auto' }} onChange={e => setPacked(e.target.value)} aria-label="Packed">
              <option value="">Packed or not</option><option value="yes">Packed</option><option value="no">Not packed yet</option>
            </select>
          ) : bucket.startsWith('return') ? null : (
            <select value={payment} style={{ width: 'auto' }} onChange={e => setPayment(e.target.value)} aria-label="Payment">
              <option value="">COD and prepaid</option><option value="COD">COD</option><option value="Prepaid">Prepaid</option>
            </select>
          )}
        </div>

        {isPending && pickedList.length > 0 && (
          <div className="ship-bulkbar">
            <strong>{pickedList.length} selected</strong>
            <span className="packed-sub" style={{ margin: 0 }}>{pickedList.filter(o => !o.packed_at).length ? `${pickedList.filter(o => !o.packed_at).length} not packed yet` : 'All packed'}</span>
            <div className="ship-bulk-actions">
              <button className="btn btn-secondary btn-sm" onClick={() => setPicked({})}>Clear</button>
              {canManage && (
                <button className="btn btn-primary btn-sm" onClick={() => ship(pickedList)}>
                  <Icon name="truck" size={14} /> Get AWB and labels for {pickedList.length}
                </button>
              )}
            </div>
          </div>
        )}

        <div className="data-table-wrapper">
          {loading ? <div className="loader"><div className="spinner" /></div> : !rows.length ? (
            <div className="empty-state">
              <div className="empty-icon">📦</div>
              <h3>{term ? 'Nothing matches that' : `Nothing in ${BUCKET_LABEL[bucket] || 'this list'}`}</h3>
              {isPending && !term && <p>Every recent order has a shipment.</p>}
            </div>
          ) : isPending ? (
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
                        {o.cancelled_awb && <div className="packed-sub" style={{ color: 'var(--danger)' }}>Auto-cancelled before</div>}</td>
                      <td data-label="Customer">{o.customer_name || '—'}<div className="packed-sub">{[o.city, o.pincode].filter(Boolean).join(' · ')}</div></td>
                      <td data-label="Items" style={{ maxWidth: 280 }}>{o.items.slice(0, 2).join(', ')}{o.items.length > 2 ? ` +${o.items.length - 2}` : ''}</td>
                      <td data-label="Payment">{money(o.total_price)} <span className={`status-badge ${o.cod ? 'pending' : 'paid'}`}>{o.cod ? 'COD' : 'Prepaid'}</span></td>
                      <td data-label="Packed">{o.packed_at ? <span style={{ color: 'var(--success)' }}>{dayTime(o.packed_at)}</span> : <span style={{ color: 'var(--text-muted)' }}>Not yet</span>}</td>
                      <td>{canManage && <button className="btn btn-secondary btn-sm" onClick={() => ship([o])}>Get AWB</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead><tr><th>Order · AWB</th><th>Customer</th><th>Payment</th><th>Status</th><th>Since</th><th>Made in</th></tr></thead>
                <tbody>
                  {rows.map(s => {
                    const waited = s.bucket === 'waiting_pickup' ? daysSince(s.manifested_at || s.created_at) : null
                    return (
                      <tr key={s.id} onClick={() => open(s.id)} style={{ cursor: 'pointer' }}>
                        <td data-label="Order · AWB" className="cell-primary">{s.order_number || '—'}<div className="packed-sub ship-mono">{s.awb}</div></td>
                        <td data-label="Customer">{s.consignee_name || '—'}<div className="packed-sub">{[s.consignee_city || s.destination, s.consignee_pincode].filter(Boolean).join(' · ')}</div></td>
                        <td data-label="Payment">{s.payment_mode === 'COD' ? `COD ${money(s.cod_amount)}` : (s.payment_mode || '—')}</td>
                        <td data-label="Status">
                          <span className={`status-badge ${BUCKET_BADGE[s.bucket] || 'pending'}`}>{BUCKET_LABEL[s.bucket] || s.bucket}</span>
                          <div className="packed-sub" style={['FMEOD-152', 'X-PNP'].includes(s.status_code) ? { color: 'var(--warning)' } : undefined}>{statusText(s)}</div>
                        </td>
                        <td data-label="Since" style={waited >= 2 ? { color: 'var(--warning)', fontWeight: 600 } : undefined}>
                          {day(s.status_at || s.created_at)}{waited != null && <div className="packed-sub">waiting {plural(waited, 'day')}</div>}
                        </td>
                        <td data-label="Made in">{s.created_via === 'crm' ? 'CRM' : 'Portal'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <Pager page={page} size={50} total={total} onPage={setPage} />
      </section>
    </div>
  )
}
