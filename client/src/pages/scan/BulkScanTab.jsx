import { useState, useEffect, useRef } from 'react'
import { useApi } from '../../App'
import { useToast } from '../../components/Toast'

const time = (v) => (v ? new Date(v).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '')

/**
 * Scanning a stack of parcels, one after another.
 *
 * The single scanner shows an order and waits for a decision, which is right when you are packing
 * it. This is for the other half of the job: a trolley of sealed parcels that need recording, where
 * stopping to read each screen is the whole cost. Each scan records the parcel and adds a line —
 * the gun never has to wait.
 *
 * Nothing is ever recorded twice. A label scanned again is reported as a duplicate, with who
 * packed it and when, and the server refuses it anyway: the parcel is a row keyed by its order
 * number, so a second scan cannot create a second dispatch.
 */
export default function BulkScanTab() {
  const apiFetch = useApi()
  const toast = useToast()
  const [rows, setRows] = useState([])      // newest first
  const [busy, setBusy] = useState(false)
  const [value, setValue] = useState('')
  const inputRef = useRef(null)
  // Read inside the key handler, which is bound once — without this it would only ever see the
  // list as it was on the first render and report every second scan as new.
  const seen = useRef(new Set())

  // The gun types into whatever has focus, so the hidden input has to keep it.
  useEffect(() => {
    const hold = () => {
      if (inputRef.current && document.activeElement !== inputRef.current) {
        inputRef.current.focus({ preventScroll: true })
      }
    }
    hold()
    document.addEventListener('click', hold)
    const t = setInterval(hold, 500)
    return () => { document.removeEventListener('click', hold); clearInterval(t) }
  }, [])

  const record = async (raw) => {
    const scanned = String(raw || '').trim()
    if (!scanned) return
    // Same normalisation the single scanner uses: labels carry other text around the number.
    const digits = scanned.match(/\d{4,}/)
    const orderNumber = digits ? `#${digits[0]}` : scanned.replace(/^#/, '')

    // Caught here as well as on the server so the bench is told instantly, without a round trip,
    // when the same label goes under the gun twice in a row.
    if (seen.current.has(orderNumber)) {
      setRows(list => [{ key: `${orderNumber}-${Date.now()}`, order_number: orderNumber, state: 'duplicate',
        note: 'Already scanned in this run', at: new Date().toISOString() }, ...list])
      toast.warning(`${orderNumber} was already scanned`)
      return
    }

    setBusy(true)
    const res = await apiFetch('/api/scanner/packed', { method: 'POST', body: JSON.stringify({ order_number: orderNumber }) })
    setBusy(false)

    if (!res || res.error) {
      setRows(list => [{ key: `${orderNumber}-${Date.now()}`, order_number: orderNumber, state: 'problem',
        note: res?.error || 'Could not record this parcel', at: new Date().toISOString() }, ...list])
      toast.error(res?.error || 'Could not record this parcel')
      return
    }

    const p = res.packed
    seen.current.add(p.order_number)
    if (res.already) {
      setRows(list => [{ key: `${p.order_number}-${Date.now()}`, ...p, state: 'duplicate',
        note: `Already packed by ${p.packed_by ? String(p.packed_by).split('@')[0] : 'someone'} · ${time(p.packed_at)}`,
        at: new Date().toISOString() }, ...list])
      toast.warning(`${p.order_number} was already packed — not recorded again`, { title: 'Duplicate' })
      return
    }
    setRows(list => [{ key: `${p.order_number}-${Date.now()}`, ...p, state: 'packed', at: new Date().toISOString() }, ...list])
  }

  const onKeyDown = (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const v = e.target.value
    setValue('')
    if (v.trim()) record(v)
  }

  const counts = {
    packed: rows.filter(r => r.state === 'packed').length,
    duplicate: rows.filter(r => r.state === 'duplicate').length,
    problem: rows.filter(r => r.state === 'problem').length,
  }

  const clear = () => { setRows([]); seen.current = new Set() }

  return (
    <div className="bulk-scan">
      <div className={`scan-listen ${busy ? 'loading' : ''}`}>
        <span className="scan-listen-dot" />
        <span className="scan-listen-text">{busy ? 'Recording…' : 'Listening — scan the next parcel'}</span>
        <span className="scan-listen-hint">Every scan is recorded as packed. Keep going.</span>
        {!!rows.length && <button type="button" className="mini-btn" onClick={clear}>Clear list</button>}
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          style={{ position: 'absolute', opacity: 0, top: '-9999px', left: '-9999px' }}
          autoComplete="off"
        />
      </div>

      <div className="bulk-tally">
        <span className="bulk-stat bulk-stat-ok"><b>{counts.packed}</b> packed</span>
        <span className={`bulk-stat${counts.duplicate ? ' bulk-stat-warn' : ''}`}><b>{counts.duplicate}</b> duplicate</span>
        <span className={`bulk-stat${counts.problem ? ' bulk-stat-bad' : ''}`}><b>{counts.problem}</b> problem</span>
      </div>

      {rows.length ? (
        <div className="data-table-wrapper">
          <table className="data-table">
            <thead><tr>
              <th>Order</th><th>AWB</th><th>Customer</th><th>Units</th><th>Result</th><th>Scanned</th>
            </tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.key} className={`bulk-row bulk-row-${r.state}`}>
                  <td data-label="Order" className="cell-primary">{r.order_number}</td>
                  <td data-label="AWB">{r.awb ? <span className="packed-awb">{r.awb}</span> : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                    {r.courier && <div className="packed-sub">{r.courier}</div>}</td>
                  <td data-label="Customer">{r.customer_name || '—'}
                    {r.ship_city && <div className="packed-sub">{[r.ship_city, r.ship_state].filter(Boolean).join(', ')}</div>}</td>
                  <td data-label="Units" style={{ textAlign: 'center' }}>{r.total_qty ?? '—'}</td>
                  <td data-label="Result">
                    <span className={`status-badge ${r.state === 'packed' ? 'fulfilled' : r.state === 'duplicate' ? 'pending' : 'refunded'}`}>
                      {r.state === 'packed' ? 'Packed' : r.state === 'duplicate' ? 'Duplicate' : 'Not recorded'}
                    </span>
                    {r.note && <div className="packed-sub">{r.note}</div>}
                  </td>
                  <td data-label="Scanned" style={{ fontSize: 12 }}>{time(r.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state">
          <div className="empty-icon">📦</div>
          <h3>Nothing scanned yet</h3>
          <p>Point the gun at the first label. Each parcel is recorded as it is scanned, and a label
            scanned twice is reported rather than recorded again.</p>
        </div>
      )}
    </div>
  )
}
