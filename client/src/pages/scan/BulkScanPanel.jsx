import { useState, useEffect, useRef } from 'react'
import { useApi } from '../../App'
import { useToast } from '../../components/Toast'

const time = (v) => (v ? new Date(v).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '')
const who = (v) => (v ? String(v).split('@')[0] : 'someone')

/**
 * Scanning a stack of parcels straight into the dispatch log.
 *
 * The single scanner shows an order and waits for a decision, which is right when you are packing
 * it. This is for the other half of the job: a trolley of sealed parcels that need recording, where
 * stopping to read each screen is the whole cost. It sits above the log it writes to, so a parcel
 * can be seen landing in the day's list rather than taken on trust.
 *
 * Nothing is ever recorded twice. A label scanned again is reported as a duplicate — naming who
 * packed it and when — and the server refuses it anyway: the parcel is a row keyed by its order
 * number, so a second scan cannot create a second dispatch.
 */
export default function BulkScanPanel({ onRecorded, onClose }) {
  const apiFetch = useApi()
  const toast = useToast()
  const [lines, setLines] = useState([])      // newest first
  const [busy, setBusy] = useState(false)
  const [value, setValue] = useState('')
  const inputRef = useRef(null)
  // Read inside the key handler, which is bound once — without this it would only ever see the
  // list as it was on the first render and report every second scan as new.
  const seen = useRef(new Set())

  // The gun types into whatever has focus, so the hidden input has to keep it — but never take it
  // from the search box or any other field on the page, which is sitting right alongside.
  useEffect(() => {
    const hold = () => {
      const on = document.activeElement
      if (on && on !== inputRef.current && /^(INPUT|TEXTAREA|SELECT)$/.test(on.tagName)) return
      if (inputRef.current && on !== inputRef.current) inputRef.current.focus({ preventScroll: true })
    }
    hold()
    document.addEventListener('click', hold)
    const t = setInterval(hold, 500)
    return () => { document.removeEventListener('click', hold); clearInterval(t) }
  }, [])

  const add = (line) => setLines(list => [{ key: `${line.order_number}-${Date.now()}`, at: new Date().toISOString(), ...line }, ...list])

  const record = async (raw) => {
    const scanned = String(raw || '').trim()
    if (!scanned) return
    // Same normalisation the single scanner uses: labels carry other text around the number.
    const digits = scanned.match(/\d{4,}/)
    const orderNumber = digits ? `#${digits[0]}` : scanned.replace(/^#/, '')

    // Caught here as well as on the server so the bench is told instantly, without a round trip,
    // when the same label goes under the gun twice in a row.
    if (seen.current.has(orderNumber)) {
      add({ order_number: orderNumber, state: 'duplicate', note: 'Already scanned in this run' })
      toast.warning(`${orderNumber} was already scanned`, { title: 'Duplicate' })
      return
    }

    setBusy(true)
    const res = await apiFetch('/api/scanner/packed', { method: 'POST', body: JSON.stringify({ order_number: orderNumber }) })
    setBusy(false)

    if (!res || res.error) {
      add({ order_number: orderNumber, state: 'problem', note: res?.error || 'Could not record this parcel' })
      toast.error(res?.error || 'Could not record this parcel')
      return
    }

    const p = res.packed
    seen.current.add(p.order_number)
    if (res.already) {
      add({ order_number: p.order_number, state: 'duplicate', note: `Already packed by ${who(p.packed_by)} at ${time(p.packed_at)}` })
      toast.warning(`${p.order_number} was already packed — not recorded again`, { title: 'Duplicate' })
      return
    }
    add({
      order_number: p.order_number, state: 'packed',
      note: [p.customer_name, p.total_qty ? `${p.total_qty} ${p.total_qty === 1 ? 'unit' : 'units'}` : null, p.awb]
        .filter(Boolean).join(' · ') || 'Recorded',
    })
    onRecorded?.()   // it is in the log below now; show it there
  }

  const onKeyDown = (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const v = e.target.value
    setValue('')
    if (v.trim()) record(v)
  }

  const counts = {
    packed: lines.filter(r => r.state === 'packed').length,
    duplicate: lines.filter(r => r.state === 'duplicate').length,
    problem: lines.filter(r => r.state === 'problem').length,
  }

  return (
    <div className="bulk-scan">
      <div className={`scan-listen ${busy ? 'loading' : ''}`}>
        <span className="scan-listen-dot" />
        <span className="scan-listen-text">{busy ? 'Recording…' : 'Listening — scan the next parcel'}</span>
        <span className="scan-listen-hint">Every scan is saved to the log below. Keep going.</span>
        <button type="button" className="mini-btn" onClick={onClose}>Done</button>
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
        {!!lines.length && (
          <button type="button" className="mini-btn" onClick={() => { setLines([]); seen.current = new Set() }}>
            Clear this run
          </button>
        )}
      </div>

      {lines.length ? (
        <ul className="bulk-feed">
          {lines.map(r => (
            <li key={r.key} className={`bulk-feed-line bulk-feed-${r.state}`}>
              <span className="bulk-feed-mark">{r.state === 'packed' ? '✓' : r.state === 'duplicate' ? '!' : '✕'}</span>
              <b>{r.order_number}</b>
              <span className="bulk-feed-note">{r.note}</span>
              <span className="bulk-feed-time">{time(r.at)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="bulk-feed-empty">
          Point the gun at the first label. Each parcel is recorded as it is scanned, and a label
          scanned twice is reported here rather than recorded again.
        </p>
      )}
    </div>
  )
}
