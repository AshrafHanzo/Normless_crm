import { useState, useEffect } from 'react'
import Icon from '../../components/Icon'

const when = (ts) => (ts ? new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit' }) : null)

/**
 * The vendor's own page: make the link, copy or send it on WhatsApp, regenerate it (the old one
 * stops working) or switch it off. Shown only to people who may share vendor links.
 */
export default function VendorLinkCard({ vendor, apiFetch, toast, onChanged }) {
  const portal = vendor.portal || {}
  const [busy, setBusy] = useState(false)
  // Can the link go from the Normless number right now — and if not, why?
  const [wa, setWa] = useState(null)
  useEffect(() => {
    let live = true
    apiFetch(`/api/vendors/${vendor.id}/whatsapp`).then(r => { if (live && r && !r.error) setWa(r.manual?.vendor_link || null) })
    return () => { live = false }
    // apiFetch is a new function every render (see useApi), so it can't be a dependency here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendor.id])

  const act = async (action, sendWhatsapp = false) => {
    if (action === 'regenerate' && !await toast.confirm({
      title: 'Make a new link?', message: `The link ${vendor.name} has now stops working. Send them the new one.`, confirmLabel: 'Make new link',
    })) return
    if (action === 'disable' && !await toast.confirm({
      title: 'Switch the link off?', message: `${vendor.name} won’t be able to open their page until it’s switched back on.`, confirmLabel: 'Switch off',
    })) return
    setBusy(true)
    const r = await apiFetch(`/api/vendors/${vendor.id}/link`, { method: 'POST', body: JSON.stringify({ action, send_whatsapp: sendWhatsapp }) })
    setBusy(false)
    if (!r || r.error) { toast.error(r?.error || 'Couldn’t update the link'); return }
    if (sendWhatsapp) {
      if (r.whatsapp?.sent) toast.success(`Sent to ${vendor.name} on WhatsApp from the Normless number`)
      else toast.error(r.whatsapp?.reason || 'It didn’t send', { title: 'Not sent' })
    } else {
      toast.success(action === 'disable' ? 'Link switched off' : action === 'regenerate' ? 'New link made' : 'Link is on')
    }
    onChanged()
  }

  const copy = async () => { await navigator.clipboard.writeText(portal.url); toast.success('Link copied') }

  return (
    <div className="glass-card vp-card vp-link-card">
      <h3>Vendor’s own page</h3>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '0 0 12px' }}>
        A private link {vendor.name} opens without logging in: their orders, what’s come in, payment plans, every payment with its UTR, the statement — and where they upload invoices. Internal notes and our team’s names never show.
      </p>
      {portal.enabled && portal.url ? (
        <>
          <div className="vp-link-row">
            <input readOnly value={portal.url} aria-label="Vendor link" className="vp-mono" onFocus={e => e.target.select()} />
            <button className="btn btn-secondary" onClick={copy}><Icon name="copy" size={14} /> Copy</button>
            <button className="btn btn-secondary" disabled={busy || !wa?.ready} onClick={() => act('create', true)}
              title={wa?.ready ? 'Sends now from the Normless WhatsApp number' : wa?.reason}>
              <Icon name="whatsapp" size={14} /> Send on WhatsApp
            </button>
            <a className="btn btn-secondary" href={portal.url} target="_blank" rel="noreferrer"><Icon name="external" size={14} /> Open</a>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 10, fontSize: 12.5, color: 'var(--text-muted)' }}>
            <span>{portal.last_seen_at ? `Last opened ${when(portal.last_seen_at)}` : 'Not opened yet'}</span>
            {wa && !wa.ready && <span style={{ color: 'var(--warning)' }}>WhatsApp: {wa.reason}</span>}
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <button className="mini-btn" disabled={busy} onClick={() => act('regenerate')}>Make a new link</button>
              <button className="mini-btn mini-btn-danger" disabled={busy} onClick={() => act('disable')}>Switch off</button>
            </span>
          </div>
        </>
      ) : (
        <button className="btn btn-primary" disabled={busy} onClick={() => act('create')}>
          <Icon name="external" size={14} /> {portal.url ? 'Switch the link back on' : 'Make their link'}
        </button>
      )}
    </div>
  )
}
