import { useState, useEffect, useRef } from 'react'
import { useApi, useAuth } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'

const when = (v) => (v ? new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit' }) : '')

/** Where one proof photo is, in the team's words. */
function statusOf(p) {
  const out = []
  if (p.wa_status === 'sent') out.push({ cls: 'fulfilled', text: `WhatsApp ${when(p.wa_sent_at)}` })
  else if (p.wa_status === 'waiting') out.push({ cls: 'pending', text: 'WhatsApp: goes when they reply', title: 'Outside the 24-hour window: they were sent the ticket-update template, and the photo goes the moment they write back.' })
  else if (p.wa_status === 'failed') out.push({ cls: 'cancelled', text: 'WhatsApp failed', title: p.wa_error || '' })
  if (p.email_status === 'sent') out.push({ cls: 'fulfilled', text: `Email ${when(p.email_sent_at)}` })
  else if (p.email_status === 'failed') out.push({ cls: 'cancelled', text: 'Email failed' })
  if (!out.length) out.push({ cls: 'cancelled', text: 'Not sent: no WhatsApp chat or email on this ticket' })
  return out
}

/**
 * Proof the operations team shares with the customer: photos of what was raised with Delhivery,
 * a courier's reply, a QC result. Uploading sends them straight away, with the note worded for
 * the customer by the AI: on WhatsApp (or when they next write, outside 24 hours) and by email
 * when the ticket came by email.
 */
export default function ProofForCustomer({ ticket }) {
  const apiFetch = useApi()
  const toast = useToast()
  const { API_URL } = useAuth()
  const [proofs, setProofs] = useState(null)
  const [files, setFiles] = useState([])
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const input = useRef(null)
  const base = `/api/support/tickets/${ticket.id}/proof`

  useEffect(() => {
    apiFetch(base).then(r => { if (r && !r.error) setProofs(r.proofs) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket.id])

  const report = (r) => {
    const s = r.sent || {}
    const parts = [s.whatsapp === 'sent' && 'sent on WhatsApp', s.whatsapp === 'waiting for the customer to reply' && 'on WhatsApp once they reply (the template told them)', s.email === 'sent' && 'emailed'].filter(Boolean)
    if (parts.length) toast.success(`Proof ${parts.join(', ')}`)
    else toast.warning(s.whatsapp || s.email || s.error || 'Saved, but there was no WhatsApp chat or email to send it to')
  }

  const send = async () => {
    if (!files.length || busy) return
    setBusy(true)
    const body = new FormData()
    files.forEach(f => body.append('images', f))
    if (note.trim()) body.append('note', note.trim())
    const r = await apiFetch(base, { method: 'POST', body })
    setBusy(false)
    if (!r || r.error) return toast.error(r?.error || 'Could not send the proof')
    setProofs(r.proofs); setFiles([]); setNote('')
    if (input.current) input.current.value = ''
    report(r)
  }

  const retry = async () => {
    setBusy(true)
    const r = await apiFetch(`${base}/resend`, { method: 'POST' })
    setBusy(false)
    if (!r || r.error) return toast.error(r?.error || 'Could not send it')
    setProofs(r.proofs); report(r)
  }

  const remove = async (p) => {
    const r = await apiFetch(`${base}/${p.id}`, { method: 'DELETE' })
    if (!r || r.error) return toast.error(r?.error || 'Could not remove it')
    setProofs(r.proofs)
  }

  const failed = (proofs || []).some(p => p.wa_status === 'failed' || p.email_status === 'failed')
  return (
    <section className="ship-card" style={{ margin: 0 }}>
      <div><h3 style={{ fontSize: 14, margin: 0 }}>Proof for the customer</h3>
        <p className="packed-sub" style={{ maxWidth: 'none', margin: '2px 0 0' }}>
          Photos of what we raised with Delhivery, the courier’s reply or a QC result. They go to the customer as soon as you send them,
          with your note worded for the customer: on WhatsApp{ticket.email_thread_id ? ' and by email' : ''}. Outside WhatsApp’s 24 hours
          they get an update message, and the photos follow when they reply.
        </p></div>

      {!!proofs?.length && (
        <div className="proof-grid">
          {proofs.map(p => (
            <div className="proof-item" key={p.id}>
              <a href={`${API_URL}${p.url}`} target="_blank" rel="noreferrer"><img src={`${API_URL}/api/thumb?src=${encodeURIComponent(p.url)}&w=240`} alt={p.name || 'Proof'} /></a>
              <div className="proof-meta">
                {statusOf(p).map(s => <span key={s.text} className={`status-badge ${s.cls}`} title={s.title}>{s.text}</span>)}
                {p.note && <span className="packed-sub" style={{ margin: 0 }}>“{p.note}”</span>}
                <span className="packed-sub" style={{ margin: 0 }}>{String(p.uploaded_by || '').split('@')[0]} · {when(p.created_at)}</span>
                {p.wa_status !== 'sent' && p.email_status !== 'sent' && <button type="button" className="mini-btn" onClick={() => remove(p)}>Remove</button>}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="proof-form">
        <input ref={input} type="file" accept="image/jpeg,image/png" multiple disabled={busy} aria-label="Proof photos"
          onChange={e => setFiles([...(e.target.files || [])].slice(0, 8))} />
        <input className="input" value={note} maxLength={1000} disabled={busy}
          placeholder="Note for the customer, e.g. we raised your parcel with Delhivery; this is their reply"
          onChange={e => setNote(e.target.value)} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || !files.length} onClick={send}>
            <Icon name="whatsapp" size={14} /> {busy ? 'Sending…' : files.length ? `Send ${files.length} photo${files.length > 1 ? 's' : ''} to customer` : 'Choose photos first'}</button>
          {failed && <button type="button" className="mini-btn" disabled={busy} onClick={retry}>Try sending again</button>}
          <span className="packed-sub" style={{ margin: 0 }}>JPG or PNG; a screenshot works.</span>
        </div>
      </div>
    </section>
  )
}
