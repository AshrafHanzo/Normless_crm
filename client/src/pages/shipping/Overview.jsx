import { useState, useEffect } from 'react'
import { useApi } from '../../App'
import { daysSince, plural } from './common'

const Tile = ({ label, n, foot, onClick, tone }) => (
  <button type="button" className="ship-tile" onClick={onClick}>
    <span className="ship-tile-l">{label}</span>
    <span className="ship-tile-n" style={tone ? { color: `var(--${tone})` } : undefined}>{n ?? '—'}</span>
    {foot && <span className="ship-tile-f">{foot}</span>}
  </button>
)

/** The Delhivery home screen, in the CRM: what needs doing first, then where everything is. */
export default function Overview({ go, rev }) {
  const apiFetch = useApi()
  const [data, setData] = useState(null)
  const [days, setDays] = useState(7)

  useEffect(() => {
    apiFetch(`/api/shipping/overview?days=${days}`).then(r => { if (r && !r.error) setData(r) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, rev])

  if (!data) return <div className="loader"><div className="spinner" /></div>
  const c = data.counts || {}
  const p = data.performance || {}
  const oldest = daysSince(data.oldest_waiting)
  const pct = (v) => (v == null ? '—' : `${v}%`)

  return (
    <>
      {c.cancelled_open > 0 && (
        <div className="ship-alert danger">
          <strong>{plural(c.cancelled_open, 'shipment')} auto-cancelled by Delhivery</strong>
          <span>They weren't picked up in time and need new AWBs before the next pickup.</span>
          <button className="btn btn-primary btn-sm ship-alert-action" onClick={() => go('cancelled')}>Re-create</button>
        </div>
      )}
      {c.not_ready > 0 && (
        <div className="ship-alert warning">
          <strong>{plural(c.not_ready, 'parcel')} not ready when Delhivery came</strong>
          <span>Delhivery's pickup person marked these "not ready for pickup". Unpicked parcels get auto-cancelled.</span>
          <button className="btn btn-secondary btn-sm ship-alert-action" onClick={() => go('pickups')}>See them</button>
        </div>
      )}

      <div className="ship-groups">
        <section className="ship-group">
          <h3>Before shipping</h3>
          <Tile label="Pending AWB" n={c.pending_awb} onClick={() => go('shipments', 'pending')} />
          <Tile label="Waiting for pickup" n={c.waiting_pickup} foot={oldest ? `Oldest: ${plural(oldest, 'day')}` : null} onClick={() => go('pickups')} />
          <Tile label="Not ready at pickup" n={c.not_ready} tone={c.not_ready ? 'warning' : null} onClick={() => go('shipments', 'not_ready')} />
        </section>
        <section className="ship-group">
          <h3>On the way</h3>
          <Tile label="In transit" n={c.in_transit} onClick={() => go('shipments', 'in_transit')} />
          <Tile label="Out for delivery" n={c.out_for_delivery} onClick={() => go('shipments', 'out_for_delivery')} />
          <Tile label="Delivery failed" n={c.ndr} foot={c.ndr_open ? `${c.ndr_open} need action` : null} onClick={() => go('ndr')} />
        </section>
        <section className="ship-group">
          <h3>Finished</h3>
          <Tile label="Delivered" n={c.delivered} onClick={() => go('shipments', 'delivered')} />
          <Tile label="Returned (RTO)" n={(c.rto_transit || 0) + (c.rto_returned || 0)}
            foot={c.rto_transit ? `${c.rto_transit} on the way back` : null} onClick={() => go('shipments', 'rto_transit')} />
          <Tile label="Auto-cancelled, not dealt with" n={c.cancelled_open} tone={c.cancelled_open ? 'danger' : null} onClick={() => go('cancelled')} />
        </section>
      </div>

      <section className="ship-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h3>Delivery performance</h3>
          <div className="scan-tabs" style={{ marginLeft: 'auto' }}>
            {[7, 14, 30].map(d => (
              <button key={d} className={days === d ? 'active' : ''} onClick={() => setDays(d)}>{d}D</button>
            ))}
          </div>
        </div>
        <div className="ship-perf">
          <div><span>On-time first attempt</span><strong>{pct(p.on_time_first_attempt)}</strong></div>
          <div><span>Avg days to first attempt</span><strong>{p.avg_days_to_attempt ?? '—'}</strong></div>
          <div><span>Delivered on first attempt</span><strong>{pct(p.delivered_first_attempt)}</strong></div>
          <div><span>RTO rate</span><strong>{pct(p.rto_rate)}</strong></div>
        </div>
        <p className="packed-sub" style={{ maxWidth: 'none' }}>
          From our own tracking data, over {plural(p.picked || 0, 'parcel')} picked up in the last {days} days. Leaves out the last 3 days.
          The Delhivery wallet balance isn't in their API, so check it in the portal.
        </p>
      </section>
    </>
  )
}
