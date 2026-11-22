import { useState, useEffect } from 'react'
import { useApi } from '../../App'
import { useToast } from '../../components/Toast'
import { day, dayTime, daysSince, statusText, plural, NOT_READY_CODES } from './common'

const istToday = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10)

/**
 * Pickups. Delhivery has no API that lists pickups or says what each took, so this shows the
 * pickups booked from the CRM (with what they took, from tracking) and, more usefully, every
 * parcel still waiting, oldest first, with what Delhivery's pickup person said about it.
 */
export default function Pickups({ canManage, changed, open, rev }) {
  const apiFetch = useApi()
  const toast = useToast()
  const [data, setData] = useState(null)
  const [form, setForm] = useState(null)
  const [busy, setBusy] = useState(false)
  const [onlyNotReady, setOnlyNotReady] = useState(false)

  useEffect(() => {
    apiFetch('/api/shipping/pickups').then(r => { if (r && !r.error) setData(r) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev])

  if (!data) return <div className="loader"><div className="spinner" /></div>
  const notReady = data.waiting.filter(w => NOT_READY_CODES.includes(w.status_code))
  const old = data.waiting.filter(w => daysSince(w.since) >= data.risk_days)
  const list = onlyNotReady ? notReady : data.waiting
  const today = data.pickups.find(p => String(p.pickup_date).slice(0, 10) === istToday())

  const book = async () => {
    setBusy(true)
    const r = await apiFetch('/api/shipping/pickups', { method: 'POST', body: JSON.stringify(form) })
    setBusy(false)
    if (!r || r.error) return toast.error(r?.error || 'Delhivery refused the pickup')
    toast.success(`Pickup ${r.pickup_id || ''} booked`)
    setForm(null); changed()
  }

  return (
    <>
      <section className="ship-card" style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="packed-sub" style={{ margin: 0 }}>{today ? 'Today\'s pickup' : 'No pickup booked from the CRM today'}</span>
          <strong style={{ fontSize: 17 }}>
            {today ? `${day(today.pickup_date)} · ${String(today.pickup_time || '').slice(0, 5)} · ${plural(today.expected_count, 'parcel')}` : `${plural(data.waiting.length, 'parcel')} waiting at ${data.pickup_location}`}
          </strong>
          <span className="packed-sub" style={{ margin: 0 }}>
            {today ? `Pickup ${today.pickup_id || '(no id)'} · ${data.pickup_location}` : 'If Delhivery runs an automatic daily pickup for your account, you don\'t need to book one.'}
          </span>
        </div>
        {canManage && !form && (
          <button className="btn btn-primary" style={{ marginLeft: 'auto' }}
            onClick={() => setForm({ date: istToday(), time: String(data.pickup_time || '18:00:00').slice(0, 5), count: data.waiting.length || 1 })}>Book a pickup</button>
        )}
        {form && (
          <div style={{ flex: '1 1 100%', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="form-row">
              <div className="input-group"><label htmlFor="pk-date">Date</label><input id="pk-date" type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} /></div>
              <div className="input-group"><label htmlFor="pk-time">Time</label><input id="pk-time" type="time" value={form.time} onChange={e => setForm({ ...form, time: e.target.value })} /></div>
              <div className="input-group"><label htmlFor="pk-n">Parcels</label><input id="pk-n" type="number" min="1" value={form.count} onChange={e => setForm({ ...form, count: e.target.value })} /></div>
            </div>
            <p className="packed-sub" style={{ margin: 0, maxWidth: 'none' }}>Delhivery allows one open pickup per warehouse per day, within the next 7 days.</p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-primary" onClick={book} disabled={busy}>{busy ? 'Booking…' : 'Book with Delhivery'}</button>
              <button className="btn btn-secondary" onClick={() => setForm(null)}>Cancel</button>
            </div>
          </div>
        )}
      </section>

      {notReady.length > 0 && (
        <div className="ship-alert warning">
          <strong>{plural(notReady.length, 'parcel')} not ready when Delhivery came</strong>
          <span>Delhivery's pickup person marked these "not ready for pickup". Make sure each is packed with its label on, or Delhivery may auto-cancel it.</span>
          <button className="btn btn-secondary btn-sm ship-alert-action" onClick={() => setOnlyNotReady(v => !v)}>{onlyNotReady ? 'Show all waiting' : 'Show only these'}</button>
        </div>
      )}
      {old.length > 0 && (
        <div className="ship-alert danger">
          <strong>{plural(old.length, 'parcel')} waiting over {plural(data.risk_days, 'day')}</strong>
          <span>These are the ones at risk of auto-cancel.</span>
        </div>
      )}

      <h3 style={{ margin: '8px 0 10px', fontSize: 15 }}>Waiting for pickup · {list.length}</h3>
      <div className="data-table-wrapper" style={{ marginBottom: 22 }}>
        {!list.length ? <div className="empty-state"><h3>Nothing waiting</h3></div> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead><tr><th>Order · AWB</th><th>Customer</th><th>Delhivery says</th><th>Waiting</th><th>Made in</th></tr></thead>
              <tbody>
                {list.map(w => {
                  const d = daysSince(w.since)
                  return (
                    <tr key={w.id} onClick={() => open(w.id)} style={{ cursor: 'pointer' }}>
                      <td data-label="Order · AWB" className="cell-primary">{w.order_number}<div className="packed-sub ship-mono">{w.awb}</div></td>
                      <td data-label="Customer">{w.consignee_name || '—'}<div className="packed-sub">{w.consignee_city || ''}</div></td>
                      <td data-label="Delhivery says" style={NOT_READY_CODES.includes(w.status_code) ? { color: 'var(--warning)' } : undefined}>{statusText(w)}<div className="packed-sub">{dayTime(w.status_at)}</div></td>
                      <td data-label="Waiting" style={d >= data.risk_days ? { color: 'var(--danger)', fontWeight: 700 } : undefined}>{plural(d, 'day')}</td>
                      <td data-label="Made in">{w.created_via === 'crm' ? 'CRM' : 'Portal'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <h3 style={{ margin: '8px 0 10px', fontSize: 15 }}>Pickups booked from the CRM</h3>
      <div className="data-table-wrapper">
        {!data.pickups.length ? <div className="empty-state"><p>None yet. Pickups booked in the Delhivery portal don't show here: Delhivery has no API that lists them.</p></div> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead><tr><th>Pickup ID</th><th>Date and time</th><th>Parcels then</th><th>Picked since</th><th>Left behind</th><th>Booked by</th></tr></thead>
              <tbody>
                {data.pickups.map(p => (
                  <tr key={p.id}>
                    <td data-label="Pickup ID" className="cell-primary ship-mono">{p.pickup_id || '—'}</td>
                    <td data-label="Date and time">{day(p.pickup_date)} · {String(p.pickup_time || '').slice(0, 5)}</td>
                    <td data-label="Parcels then">{p.awb_count} <span className="packed-sub">(asked {p.expected_count})</span></td>
                    <td data-label="Picked since">{p.picked}</td>
                    <td data-label="Left behind" style={p.waiting ? { color: 'var(--warning)', fontWeight: 600 } : undefined}>
                      {p.waiting}{p.cancelled ? <span className="packed-sub" style={{ color: 'var(--danger)' }}> · {p.cancelled} cancelled</span> : null}
                    </td>
                    <td data-label="Booked by">{(p.created_by || '—').split('@')[0]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
