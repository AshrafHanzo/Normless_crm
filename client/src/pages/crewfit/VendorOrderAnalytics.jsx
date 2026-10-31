import { useEffect, useState } from 'react'
import DateRangeFilter from '../../components/DateRangeFilter'

/**
 * What Crewfit ordered from its vendors over time, and how much of it is paid. Pieces are counted
 * on every order; money only where the order has rates, and the orders without a rate are called
 * out so a missing rate never reads as nothing owed.
 */
const fmt = (v) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(v) || 0)
const num = (v) => new Intl.NumberFormat('en-IN').format(Number(v) || 0)
const day = (v) => (v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—')
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function periodLabel(p, group) {
  const [y, m, d] = p.split('-').map(Number)
  if (group === 'month') return `${MONTHS[m - 1]} ${String(y).slice(2)}`
  return `${group === 'week' ? 'Wk ' : ''}${d} ${MONTHS[m - 1]}`
}

/** Pieces ordered per period, paid stacked under not-paid. */
function PiecesChart({ series, group }) {
  const [hi, setHi] = useState(null)
  const max = Math.max(...series.map(s => s.pieces), 1)
  return (
    <div className="voa-chart" onMouseLeave={() => setHi(null)}>
      <div className="voa-bars" style={{ gridTemplateColumns: `repeat(${series.length}, minmax(0, 1fr))` }}>
        {series.map((s, i) => (
          <div key={s.period} className={`voa-col${hi === i ? ' on' : ''}`} onMouseEnter={() => setHi(i)}
            aria-label={`${periodLabel(s.period, group)}: ${s.pieces} pieces, ${s.paid_pieces} paid`}>
            <div className="voa-stack" style={{ height: `${(s.pieces / max) * 100}%` }}>
              <span className="voa-pending" style={{ flex: s.pending_pieces }} />
              <span className="voa-paid" style={{ flex: s.paid_pieces }} />
            </div>
            <span className="voa-x">{periodLabel(s.period, group)}</span>
            {hi === i && (
              <div className={`voa-tip${i > series.length / 2 ? ' left' : ''}`}>
                <b>{periodLabel(s.period, group)}</b>
                <span>{num(s.pieces)} pcs · {s.orders} order{s.orders === 1 ? '' : 's'}</span>
                <span className="voa-k-paid">Paid {num(s.paid_pieces)} pcs{s.paid_value ? ` · ${fmt(s.paid_value)}` : ''}</span>
                <span className="voa-k-pending">Not paid {num(s.pending_pieces)} pcs{s.pending_value ? ` · ${fmt(s.pending_value)}` : ''}</span>
                {s.unpriced > 0 && <span className="voa-muted">{s.unpriced} without a rate</span>}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="voa-legend"><span><i className="voa-paid" /> Paid</span><span><i className="voa-pending" /> Not paid</span><span className="voa-muted">pieces ordered, by order date</span></div>
    </div>
  )
}

export default function VendorOrderAnalytics({ apiFetch, vendor, refreshKey }) {
  const [range, setRange] = useState({ from: '', to: '' })
  const [group, setGroup] = useState('month')
  const [data, setData] = useState(null)

  useEffect(() => {
    const q = new URLSearchParams({ group, ...(range.from && { from: range.from }), ...(range.to && { to: range.to }), ...(vendor && { vendor }) })
    apiFetch(`/api/crewfit/vendor-orders/analytics?${q}`).then(r => { if (r && !r.error) setData(r) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group, range.from, range.to, vendor, refreshKey])

  if (!data) return <div className="voa"><div className="loader"><div className="spinner" /></div></div>
  const t = data.totals
  const topProduct = data.products[0]?.pieces || 1

  return (
    <div className="voa">
      <div className="voa-head">
        <div>
          <h3>Ordered from vendors{vendor ? ` · ${vendor}` : ''}</h3>
          <span className="voa-muted">{range.from || range.to ? `${day(range.from) || '…'} – ${day(range.to) || 'today'}` : 'All time'}</span>
        </div>
        <div className="voa-controls">
          <div className="voa-seg" role="group" aria-label="Group by">
            {['day', 'week', 'month'].map(g => (
              <button key={g} type="button" className={group === g ? 'active' : ''} onClick={() => setGroup(g)}>{g[0].toUpperCase() + g.slice(1)}</button>
            ))}
          </div>
          <DateRangeFilter startDate={range.from} endDate={range.to}
            onApply={(from, to) => setRange({ from, to })} onClear={() => setRange({ from: '', to: '' })} />
        </div>
      </div>

      <div className="voa-kpis">
        <div className="voa-kpi"><span>Ordered</span><b>{num(t.pieces)} <small>pcs</small></b><em>{t.orders} order{t.orders === 1 ? '' : 's'}{t.value ? ` · ${fmt(t.value)}` : ''}</em></div>
        <div className="voa-kpi voa-k-paid"><span>Paid</span><b>{t.paid_value ? fmt(t.paid_value) : `${num(t.paid_pieces)} pcs`}</b><em>{t.paid_orders} order{t.paid_orders === 1 ? '' : 's'} · {num(t.paid_pieces)} pcs</em></div>
        <div className="voa-kpi voa-k-pending"><span>Pending payment</span><b>{t.pending_value ? fmt(t.pending_value) : `${num(t.pending_pieces)} pcs`}</b><em>{t.pending_orders} order{t.pending_orders === 1 ? '' : 's'} · {num(t.pending_pieces)} pcs</em></div>
        <div className="voa-kpi"><span>Consignments received</span><b>{t.received} <small>of {t.orders}</small></b><em>{t.orders - t.received} still to arrive</em></div>
      </div>
      {t.unpriced > 0 && (
        <p className="voa-warn">{t.unpriced} of {t.orders} orders have no rate, so they count in pieces but not in the amounts — add the rate on the order to include it.</p>
      )}

      {data.series.length ? <PiecesChart series={data.series} group={data.group} /> : <p className="voa-muted">No vendor orders in this period.</p>}

      {data.vendors.length > 0 && (
        <div className="voa-split">
          <div className="data-table-wrapper">
            <table className="data-table">
              <thead><tr><th>Vendor</th><th style={{ textAlign: 'center' }}>Orders</th><th style={{ textAlign: 'center' }}>Pieces</th><th style={{ textAlign: 'right' }}>Paid</th><th style={{ textAlign: 'right' }}>Pending</th><th>Last order</th></tr></thead>
              <tbody>
                {data.vendors.map(v => (
                  <tr key={v.vendor}>
                    <td className="cell-primary" style={{ fontWeight: 600 }}>{v.vendor}</td>
                    <td data-label="Orders" style={{ textAlign: 'center' }}>{v.orders}</td>
                    <td data-label="Pieces" style={{ textAlign: 'center', fontWeight: 600 }}>{num(v.pieces)}</td>
                    <td data-label="Paid" style={{ textAlign: 'right' }}>
                      {v.paid_value ? fmt(v.paid_value) : '—'}<div className="voa-muted">{num(v.paid_pieces)} pcs</div>
                    </td>
                    <td data-label="Pending" style={{ textAlign: 'right', color: v.pending_orders ? 'var(--warning)' : undefined }}>
                      {v.pending_value ? fmt(v.pending_value) : v.pending_orders ? '—' : 'Nothing'}
                      {v.pending_orders > 0 && <div className="voa-muted">{v.pending_orders} order{v.pending_orders === 1 ? '' : 's'} · {num(v.pending_pieces)} pcs</div>}
                    </td>
                    <td data-label="Last order" style={{ fontSize: 12.5 }}>{day(v.last_order)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="voa-products">
            <h4>Pieces by product</h4>
            <ul>
              {data.products.slice(0, 10).map(p => (
                <li key={p.name}>
                  <div className="voa-prow"><span>{p.name}</span><b>{num(p.pieces)}</b></div>
                  <div className="voa-meter"><span style={{ width: `${(p.pieces / topProduct) * 100}%` }} /></div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}
