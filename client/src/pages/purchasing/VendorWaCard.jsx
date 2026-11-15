import { useState, useEffect } from 'react'
import Icon from '../../components/Icon'

const TONE = { queued: 'pending', sent: 'fulfilled', failed: 'refunded', skipped: '', cancelled: '' }
const STATUS = { queued: 'Waiting', sent: 'Sent', failed: 'Failed', skipped: 'Not sent', cancelled: 'Stopped' }
const when = (ts) => (ts ? new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit' }) : '')

/** WhatsApp messages to this vendor: what's waiting (send now / don't send) and what went lately. */
export default function VendorWaCard({ vendorId, version, canEdit, apiFetch, toast }) {
  const [rows, setRows] = useState(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let live = true
    apiFetch(`/api/vendors/${vendorId}/whatsapp`).then(r => { if (live && r && !r.error) setRows(r.messages) })
    return () => { live = false }
    // apiFetch is a new function every render (see useApi), so it can't be a dependency here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorId, version, tick])

  // While something is waiting, look again each minute so it moves to Sent on its own.
  const waiting = (rows || []).some(r => r.status === 'queued')
  useEffect(() => {
    if (!waiting) return
    const t = setInterval(() => setTick(n => n + 1), 60000)
    return () => clearInterval(t)
  }, [waiting])

  const act = async (r, action) => {
    const res = await apiFetch(`/api/vendors/${vendorId}/whatsapp/${r.id}`, { method: 'POST', body: JSON.stringify({ action }) })
    if (res?.error) { toast.error(res.error); return }
    toast.success(action === 'send' ? 'Sending now' : 'Won’t be sent')
    setTick(n => n + 1)
  }

  if (!rows || !rows.length) return null
  return (
    <div className="glass-card vp-card vp-link-card">
      <h3><Icon name="whatsapp" size={15} /> WhatsApp to the vendor</h3>
      <div className="vo-payments">
        {rows.map(r => (
          <div key={r.id} className="vo-payment" style={{ gridTemplateColumns: '1.4fr 1fr 1.6fr auto' }}>
            <span style={{ fontWeight: 600 }}>{r.label}</span>
            <span><span className={`status-badge ${TONE[r.status] || ''}`}>{STATUS[r.status] || r.status}</span></span>
            <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
              {r.status === 'queued' ? `Goes ${when(r.send_after)}` : when(r.done_at)}
              {r.error && r.status !== 'sent' && <div>{r.error}</div>}
            </span>
            <span style={{ display: 'flex', gap: 6 }}>
              {r.status === 'queued' && canEdit && (
                <>
                  <button className="mini-btn mini-btn-active" onClick={() => act(r, 'send')}>Send now</button>
                  <button className="mini-btn" onClick={() => act(r, 'cancel')}>Don’t send</button>
                </>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
