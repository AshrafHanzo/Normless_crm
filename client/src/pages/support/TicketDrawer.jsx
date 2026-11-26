import { useState, useEffect } from 'react'
import { useApi, useAuth } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import AutoTextarea from '../../components/AutoTextarea'
import OrderComments from '../../components/OrderComments'
import ImageUploadGrid from '../../components/ImageUploadGrid'
import useDirtyGuard from '../../hooks/useDirtyGuard'
import { refOf, blankTicket, asForm, trackingFor } from './ticket'
import ManualShipDrawer from '../shipping/ManualShipDrawer'
import DetailsForm from '../shipping/DetailsForm'
import { BUCKET_BADGE } from '../shipping/common'

const today = () => new Date().toLocaleDateString('en-CA')
const day = (v) => (v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—')

/**
 * A waybill, with the parcel it belongs to one click away.
 *
 * Support lives on sending people a tracking link, so the link is made from the number rather than
 * looked up somewhere else and pasted back — and it can be copied in one go, because the next
 * thing that happens to it is being pasted into WhatsApp.
 */
function AwbField({ label, hint, value, disabled, link, onChange, status, onUseNew }) {
  const toast = useToast()
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      toast.success('Tracking link copied')
    } catch {
      // Clipboard access can be refused outright; selecting the text by hand still works.
      toast.error('Could not copy — the link is open in a new tab instead')
      window.open(link, '_blank', 'noreferrer')
    }
  }
  return (
    <div className="input-group">
      <label>{label} <span className="label-hint">{hint}</span></label>
      <input value={value} disabled={disabled} onChange={onChange} />
      {link && (
        <div className="awb-track">
          <a href={link} target="_blank" rel="noreferrer">Track this parcel ↗</a>
          <button type="button" className="mini-btn" onClick={copy}>Copy link</button>
        </div>
      )}
      {status && (
        <div className="awb-status">
          <span className={`status-badge ${BUCKET_BADGE[status.bucket] || 'pending'}`}>{status.label}</span>
          {status.detail && status.detail !== status.label && <span className="packed-sub" style={{ margin: 0 }}>{status.detail}</span>}
          {status.replaced_by && (
            <span className="packed-sub" style={{ margin: 0 }}>Replaced by <b className="ship-mono">{status.replaced_by}</b>
              {onUseNew && !disabled && <button type="button" className="mini-btn" style={{ marginLeft: 6 }} onClick={() => onUseNew(status.replaced_by)}>Use it</button>}</span>
          )}
          {status.needs_new_label && <span style={{ color: 'var(--danger)', fontSize: 12.5 }}>Cancelled by Delhivery: needs a new label</span>}
        </div>
      )}
    </div>
  )
}

/**
 * One customer request, from "my size is wrong" to the day it was settled.
 *
 * The order comes first because everything else hangs off it: pulling it in fills the customer's
 * name, phone and email from what we already hold, and shows what was in the parcel and which
 * waybill it went out on — the two things a return is arranged against. It is only a lookup, not a
 * requirement: a customer can write in about an order too old to be in the CRM, and the ticket
 * still has to be raisable.
 */
export default function TicketDrawer({ ticket, options, onClose, onSaved, onDelete, canEdit, children }) {
  const apiFetch = useApi()
  const toast = useToast()
  const { API_URL, user } = useAuth()
  const canShip = ['owner', 'admin'].includes(user?.role) || !!user?.can_manage_shipping
  const [shipping, setShipping] = useState(null)   // { forward, return } statuses from the CRM's tracking
  const [shipOpen, setShipOpen] = useState(false)
  const [changing, setChanging] = useState(false)     // the customer's change-of-details form
  const [changeBusy, setChangeBusy] = useState(false)
  const [orderShip, setOrderShip] = useState(undefined) // the order's own parcel: undefined = not looked up
  const isNew = !ticket?.id
  // "Message to customer": the team's plain words, passed on professionally by WhatsApp / email.
  const [msg, setMsg] = useState('')
  const [msgBusy, setMsgBusy] = useState(false)
  const [lastMsg, setLastMsg] = useState(() => (ticket?.customer_message ? { text: ticket.customer_message, at: ticket.customer_message_at, by: ticket.customer_message_by } : null))
  const sendMsg = async () => {
    const text = msg.trim()
    if (text.length < 3 || msgBusy) return
    setMsgBusy(true)
    const r = await apiFetch(`/api/support/tickets/${ticket.id}/customer-message`, { method: 'POST', body: JSON.stringify({ text }) })
    setMsgBusy(false)
    if (!r || r.error) return toast.error(r?.error || 'Could not send the message')
    const wa = r.sent?.whatsapp, em = r.sent?.email
    const how = [
      wa && (wa.replied || wa.status === 'sent' || wa.id) ? 'WhatsApp' : null,
      em && (em.replied || em.emailed) ? 'email' : null,
    ].filter(Boolean)
    const problem = [wa?.error, wa?.skipped, wa?.asked && 'the agent asked the team instead', em?.error, em?.skipped].filter(Boolean)[0]
    if (how.length) toast.success(`Sent to the customer by ${how.join(' and ')}`)
    else toast.info(problem ? `Saved, but not sent: ${problem}` : 'Saved. The customer gets it on WhatsApp or email when one is linked to this ticket')
    setLastMsg({ text, at: new Date().toISOString(), by: user?.username })
    setMsg('')
  }

  const [form, setForm] = useState(() => asForm(ticket?.id ? ticket : { ...blankTicket(), ...ticket }))
  const [busy, setBusy] = useState(false)
  const [lookup, setLookup] = useState(null)     // { order, dispatch, history }
  const [looking, setLooking] = useState(false)
  // Proof photographs. A ticket being raised has nowhere to put them yet, so its picks are held
  // here with a local preview and sent the moment it has an id.
  const [images, setImages] = useState(ticket?.images || [])
  const [pending, setPending] = useState([])
  const [uploading, setUploading] = useState(false)
  const [viewing, setViewing] = useState(null)   // index into the thumbnails
  const setF = (patch) => setForm(f => ({ ...f, ...patch }))
  const canHold = canShip || canEdit
  const [holdBusy, setHoldBusy] = useState(false)
  // Hold or release the order itself (Shipping's hold): it can't get an AWB or be packed meanwhile.
  const holdOrder = async (on) => {
    const num = lookup?.order?.order_number
    if (!num) return
    let reason = ''
    if (on) {
      reason = await toast.prompt({
        title: `Hold ${num}?`,
        message: 'It leaves Pending AWB, can\'t get an AWB, and the packing bench refuses it until someone releases it.',
        input: { label: 'Why', placeholder: 'e.g. customer travelling, address being sorted out' },
        confirmLabel: 'Hold the order',
      })
      if (reason == null) return
    } else if (!await toast.confirm({ title: `Release ${num}?`, message: 'It goes back to Pending AWB and can be packed and shipped.', confirmLabel: 'Release' })) return
    setHoldBusy(true)
    const r = await apiFetch(`/api/shipping/${on ? 'hold' : 'release'}`, {
      method: 'POST', body: JSON.stringify({ order_numbers: [num], ...(on ? { reason: `${refOf(ticket)}: ${reason}` } : {}) }),
    })
    setHoldBusy(false)
    if (!r || r.error) return toast.error(r?.error || 'That didn\'t work')
    if (on && !r.held?.length) return toast.error(`${num} ${r.errors?.[0]?.error || 'could not be held'}`)
    if (!on && r.still_held_in_shopify?.length) toast.warning(`${num} is still on hold in Shopify`)
    else toast.success(on ? `${num} is on hold` : `${num} released`)
    pull(true)
  }

  const guard = useDirtyGuard({
    snapshot: { ...form },
    identity: ticket?.id || 'new',
    onDiscard: onClose,
    confirm: toast.confirm,
    title: 'Discard this ticket?',
    message: 'What you have filled in will be lost.',
  })

  /** Pull the order in: the customer's details, what was in the parcel, and the waybill. */
  const pull = async (quiet = false) => {
    const num = String(form.order_number || '').trim()
    if (!num) { if (!quiet) toast.error('Type an order number first'); return }
    setLooking(true)
    const r = await apiFetch(`/api/support/order/${encodeURIComponent(num.replace('#', ''))}`)
    setLooking(false)
    if (!r || r.error) { setLookup(null); if (!quiet) toast.warning(r?.error || 'Could not find that order'); return }
    setLookup(r)
    const o = r.order || {}
    // Never overwrite what somebody has already typed — the customer who wrote in is not always
    // the name on the order, and theirs is the one that matters.
    setF({
      order_number: o.order_number || num,
      customer_name: form.customer_name || o.customer_name || '',
      customer_phone: form.customer_phone || o.customer_phone || '',
      customer_email: form.customer_email || o.customer_email || '',
      forward_awb: form.forward_awb || r.dispatch?.awb || '',
    })
  }

  // Where the parcels on this ticket are, from the CRM's Delhivery tracking.
  useEffect(() => {
    const awbs = [form.forward_awb, form.return_awb].map(x => String(x || '').trim()).filter(x => /^\d{8,}$/.test(x))
    if (!awbs.length) { setShipping(null); return }
    const timer = setTimeout(async () => {
      const r = await apiFetch(`/api/shipping/track-status?awbs=${encodeURIComponent(awbs.join(','))}`)
      if (r && !r.error) setShipping({ forward: r.by_awb[String(form.forward_awb).trim()], return: r.by_awb[String(form.return_awb).trim()] })
    }, 400)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.forward_awb, form.return_awb])

  // The order's parcel decides what a customer can still change: everything before an AWB,
  // contact details before pickup, nothing once Delhivery has it.
  useEffect(() => {
    const num = String(form.order_number || '').trim()
    if (!num) { setOrderShip(undefined); return }
    const timer = setTimeout(async () => {
      const r = await apiFetch(`/api/shipping/track-status?orders=${encodeURIComponent(num.startsWith('#') ? num : `#${num}`)}`)
      if (r && !r.error) setOrderShip(Object.values(r.by_order || {})[0] || null)
    }, 400)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.order_number])
  const pickedUp = orderShip && !['waiting_pickup', 'cancelled'].includes(orderShip.bucket)
  const submitChange = async (v) => {
    setChangeBusy(true)
    const r = await apiFetch('/api/shipping/customer-change', { method: 'POST', body: JSON.stringify({ order_number: form.order_number, ...v }) })
    setChangeBusy(false)
    if (!r || r.error) return toast.error(r?.error || 'Could not change the details')
    toast.success(r.message || 'Changed'); setChanging(false)
    setF({ ops_note: [form.ops_note, `Delivery details changed${r.awb ? ` with Delhivery (AWB ${r.awb})` : ' before the AWB'} on ${today()}.`].filter(Boolean).join('\n') })
  }

  // An existing ticket shows its order without being asked — the parcel and its waybill are the
  // context for every decision on the page. So does one raised from a WhatsApp chat about an order.
  useEffect(() => {
    if (ticket?.order_number) pull(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket?.id])

  const MAX_IMAGES = 8
  // Proof photographs come off a phone at several megabytes. The grid shows a resized copy and the
  // viewer a 1280px one, so looking at a ticket does not leave the browser holding the originals
  // decoded at full size. "Open full size" still reaches for the real file.
  const sized = (url, w) => `${API_URL}/api/thumb?src=${encodeURIComponent(url)}&w=${w}`
  const thumbs = [
    ...images.map(url => ({ src: sized(url, 320), preview: sized(url, 1280), full: `${API_URL}${url}`, pending: false, ref: url })),
    ...pending.map(p => ({ src: p.previewUrl, preview: p.previewUrl, full: p.previewUrl, pending: true, ref: p })),
  ]

  /** Send a batch to a ticket that exists; hold it otherwise. */
  const sendImages = async (id, files) => {
    const body = new FormData()
    files.forEach(f => body.append('images', f))
    const res = await apiFetch(`/api/support/tickets/${id}/images`, { method: 'POST', body })
    if (!res || res.error) { toast.error(res?.error || 'Could not attach those images'); return null }
    return res.images
  }

  const pickImages = async (fileList) => {
    const files = [...(fileList || [])]
    if (!files.length) return
    const room = MAX_IMAGES - thumbs.length
    if (room <= 0) { toast.error(`Up to ${MAX_IMAGES} images on a ticket`); return }
    const batch = files.slice(0, room)
    if (batch.length < files.length) toast.warning(`Only ${room} more image${room === 1 ? '' : 's'} fit on this ticket`)

    if (isNew) {
      setPending(list => [...list, ...batch.map(f => ({ file: f, previewUrl: URL.createObjectURL(f) }))])
      return
    }
    setUploading(true)
    const saved = await sendImages(ticket.id, batch)
    setUploading(false)
    if (saved) { setImages(saved); toast.success(`${batch.length} image${batch.length === 1 ? '' : 's'} attached`) }
  }

  const removeImage = async (thumb) => {
    if (thumb.pending) {
      URL.revokeObjectURL(thumb.ref.previewUrl)
      setPending(list => list.filter(p => p !== thumb.ref))
      setViewing(null)
      return
    }
    const res = await apiFetch(`/api/support/tickets/${ticket.id}/images`, {
      method: 'DELETE', body: JSON.stringify({ url: thumb.ref }),
    })
    if (!res || res.error) { toast.error(res?.error || 'Could not remove that image'); return }
    setImages(res.images)
    setViewing(null)
  }

  // Blob previews are a browser resource, not React state; they have to be handed back.
  useEffect(() => () => pending.forEach(p => URL.revokeObjectURL(p.previewUrl)), [pending])

  const save = async (e) => {
    e?.preventDefault?.()
    if (!form.order_number.trim() && !form.customer_name.trim() && !form.customer_phone.trim()) {
      toast.error('Say which order, or at least who the customer is'); return
    }
    if (!form.nature) { toast.error('What is the customer asking for?'); return }
    setBusy(true)
    const body = { ...form, resolved_on: form.resolved_on || null }
    const res = isNew
      ? await apiFetch('/api/support/tickets', { method: 'POST', body: JSON.stringify(body) })
      : await apiFetch(`/api/support/tickets/${ticket.id}`, { method: 'PATCH', body: JSON.stringify(body) })
    setBusy(false)
    if (!res || res.error) { toast.error(res?.error || 'Could not save the ticket'); return }
    // Everything held while there was nowhere to put it now has somewhere to go.
    if (isNew && pending.length) {
      setUploading(true)
      const saved = await sendImages(res.ticket.id, pending.map(p => p.file))
      setUploading(false)
      if (saved) { res.ticket.images = saved; setImages(saved) }
      pending.forEach(p => URL.revokeObjectURL(p.previewUrl))
      setPending([])
    }
    toast.success(isNew ? `${refOf(res.ticket)} raised` : `${refOf(res.ticket)} saved`)
    // The server tells the customer the ticket number on WhatsApp; say when that did not happen.
    if (isNew && res.held) {
      if (res.held.held?.length) toast.success(`${res.held.held[0]} is on hold until someone releases it`)
      else toast.warning(`The order wasn't held: ${res.held.errors?.[0]?.error || 'unknown'}`)
    }
    if (isNew && res.notified?.status === 'sent') toast.success('The customer was sent the ticket number on WhatsApp')
    else if (isNew && ['failed', 'skipped'].includes(res.notified?.status)) toast.error(`The customer wasn’t messaged: ${res.notified.error}`)
    guard.reset(asForm(res.ticket))
    // A new ticket is finished with: it goes back to the list, where it can now be seen. An edit
    // stays open, because the next thing anyone does with it is usually the next field.
    onSaved(res.ticket, isNew)
  }

  const opt = (list, placeholder) => [
    <option key="" value="">{placeholder}</option>,
    ...(list || []).map(v => <option key={v} value={v}>{v}</option>),
  ]
  const ro = !canEdit

  return (
    <div className="drawer-overlay" onClick={guard.requestClose}>
      <div className="drawer drawer-wide" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="drawer-header">
          <div>
            <h2>{isNew ? 'New support ticket' : `${refOf(ticket)}${ticket.order_number ? ` · ${ticket.order_number}` : ''}`}</h2>
            {!isNew && (
              <div className="packed-sub">
                Raised {day(ticket.raised_on)} · {ticket.aging} day{ticket.aging === 1 ? '' : 's'}
                {ticket.status === 'Closed' ? ` · closed ${day(ticket.resolved_on)}` : ' open'}
                {ticket.created_by ? ` · by ${String(ticket.created_by).split('@')[0]}` : ''}
                {ticket.wa_conversation_id && <> · <a href={`/whatsapp?c=${ticket.wa_conversation_id}`}>Open the WhatsApp chat</a></>}
              </div>
            )}
          </div>
          <button type="button" className="btn-icon" onClick={guard.requestClose}><Icon name="close" size={16} /></button>
        </div>

        <div className="drawer-body">
          <form id="support-ticket-form" className="support-form" onSubmit={save}>
            <div className="form-section" style={{ marginTop: 0 }}>The order</div>
            <div className="form-row">
              <div className="input-group">
                <label>Order number</label>
                <div className="manual-lookup-form">
                  <input className="input" value={form.order_number} disabled={ro} placeholder="#11484"
                    onChange={e => setF({ order_number: e.target.value })}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); pull() } }} />
                  <button type="button" className="mini-btn" disabled={looking} onClick={() => pull()}>
                    {looking ? 'Looking…' : 'Pull details'}
                  </button>
                </div>
              </div>
              <div className="input-group">
                <label>Raised on</label>
                <input type="date" value={form.raised_on} disabled={ro} onChange={e => setF({ raised_on: e.target.value })} />
              </div>
            </div>

            {lookup?.order && (
              <div className="support-order-card">
                <div className="support-order-head">
                  <b>{lookup.order.order_number}</b>
                  {lookup.order.fulfillment_status && <span className="status-badge pending">{lookup.order.fulfillment_status}</span>}
                  {lookup.dispatch?.awb && <span className="packed-awb">AWB {lookup.dispatch.awb}</span>}
                </div>
                <div className="packed-sub">
                  {(lookup.order.items || []).map(i => `${i.title}${i.variant ? ` (${i.variant})` : ''} ×${i.quantity}`).join(', ') || 'No items recorded'}
                </div>
                {lookup.order.hold ? (
                  <div className="support-hold">
                    <span className="status-badge on-hold">{lookup.order.hold.by_team ? 'On hold' : 'On hold in Shopify'}</span>
                    <span className="packed-sub" style={{ margin: 0 }}>{lookup.order.hold.reason || ''}{lookup.order.hold.held_by ? ` · ${String(lookup.order.hold.held_by).split('@')[0]}` : ''}</span>
                    {canHold && lookup.order.hold.by_team && <button type="button" className="mini-btn" disabled={holdBusy} onClick={() => holdOrder(false)}>Release</button>}
                  </div>
                ) : canHold && !isNew && !['CANCELLED', 'FULFILLED'].includes(String(lookup.order.fulfillment_status || '').toUpperCase()) && (
                  <div className="support-hold">
                    <button type="button" className="mini-btn" disabled={holdBusy} onClick={() => holdOrder(true)}><Icon name="clock" size={13} /> Hold this order</button>
                    <span className="packed-sub" style={{ margin: 0 }}>Stops it getting an AWB or being packed until released.</span>
                  </div>
                )}
                {lookup.history?.filter(h => h.id !== ticket?.id).length > 0 && (
                  <div className="support-order-prior">
                    {lookup.history.filter(h => h.id !== ticket?.id).length} earlier ticket(s) on this order:{' '}
                    {lookup.history.filter(h => h.id !== ticket?.id)
                      .map(h => [refOf(h), h.nature, `(${h.status})`].filter(Boolean).join(' ')).join(' · ')}
                  </div>
                )}
              </div>
            )}

            <div className="form-row">
              <div className="input-group">
                <label>Customer</label>
                <input value={form.customer_name} disabled={ro} placeholder="Name"
                  onChange={e => setF({ customer_name: e.target.value })} />
              </div>
              <div className="input-group">
                <label>Phone</label>
                <input value={form.customer_phone} disabled={ro} onChange={e => setF({ customer_phone: e.target.value })} />
              </div>
              <div className="input-group">
                <label>Email</label>
                <input value={form.customer_email} disabled={ro} onChange={e => setF({ customer_email: e.target.value })} />
              </div>
            </div>

            <div className="form-section">The request</div>
            <div className="form-row">
              <div className="input-group">
                <label>Came in on</label>
                <select value={form.source} disabled={ro} onChange={e => setF({ source: e.target.value })}>
                  {opt(options.sources, 'Where from?')}
                </select>
              </div>
              <div className="input-group">
                <label>What they want *</label>
                <select value={form.nature} disabled={ro} onChange={e => setF({ nature: e.target.value })}>
                  {opt(options.natures, 'Pick one')}
                </select>
              </div>
              <div className="input-group">
                <label>Why</label>
                <select value={form.reason} disabled={ro} onChange={e => setF({ reason: e.target.value })}>
                  {opt(options.reasons, 'Pick one')}
                </select>
              </div>
            </div>
            <div className="input-group">
              <label>In their words <span className="label-hint">what was asked for</span></label>
              <AutoTextarea value={form.request} disabled={ro} minRows={2}
                placeholder="Needs L instead of M — wrong size delivered"
                onChange={e => setF({ request: e.target.value })} />
            </div>

            {/* The proof. Most of these requests are an argument about a physical thing, and the
                photograph the customer sent is the thing itself — it belongs on the ticket, not in
                somebody's phone. */}
            {(canEdit || thumbs.length > 0) && (
              <ImageUploadGrid
                icon="📷" label="Proof photos" max={MAX_IMAGES} thumbs={thumbs} busy={uploading}
                onUpload={canEdit ? pickImages : undefined}
                onView={(i) => setViewing(i)}
              />
            )}

            {/* Whatever the page that opened this adds — the WhatsApp inbox puts the chat's photos here. */}
            {children}

            <div className="form-section">What we did</div>
            <div className="form-row">
              <div className="input-group">
                <label>Action taken</label>
                <select value={form.action} disabled={ro} onChange={e => setF({ action: e.target.value })}>
                  {opt(options.actions, 'Nothing yet')}
                </select>
              </div>
              <div className="input-group">
                {/* Replacements and reships are often charged for. Whether that money arrived is
                    the thing that decides if the parcel may leave. */}
                <label>Replacement paid <span className="label-hint">if charged</span></label>
                <select value={form.payment_status} disabled={ro} onChange={e => setF({ payment_status: e.target.value })}>
                  {opt(options.payments, 'Not applicable')}
                </select>
              </div>
            </div>
            <div className="form-row">
              <AwbField label="Forward AWB" hint="parcel going out" value={form.forward_awb} disabled={ro}
                link={trackingFor(form.forward_awb, lookup?.dispatch)} status={shipping?.forward}
                onUseNew={(awb) => setF({ forward_awb: awb })}
                onChange={e => setF({ forward_awb: e.target.value })} />
              <AwbField label="Return AWB" hint="parcel coming back" value={form.return_awb} disabled={ro}
                link={trackingFor(form.return_awb, null)} status={shipping?.return}
                onChange={e => setF({ return_awb: e.target.value })} />
            </div>
            {canEdit && !isNew && (
              <section className="ship-card" style={{ margin: 0 }}>
                <div><h3 style={{ fontSize: 14, margin: 0 }}>Message to customer</h3>
                  <p className="packed-sub" style={{ maxWidth: 'none', margin: '2px 0 0' }}>
                    Write the update in plain words. It reaches the customer professionally worded, with the ticket number:
                    on WhatsApp{ticket?.email_thread_id ? ' and by email' : ''}.
                  </p></div>
                <textarea className="input" rows={3} value={msg} maxLength={1000} disabled={msgBusy}
                  placeholder="e.g. replacement hoodie packed, goes out with tomorrow's pickup"
                  onChange={e => setMsg(e.target.value)} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <button type="button" className="btn btn-primary btn-sm" disabled={msgBusy || msg.trim().length < 3} onClick={sendMsg}>
                    {msgBusy ? 'Sending…' : 'Send to customer'}</button>
                  {lastMsg && <span className="packed-sub" style={{ margin: 0 }}>Last sent {new Date(lastMsg.at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit' })}{lastMsg.by ? ` by ${String(lastMsg.by).split('@')[0]}` : ''}: “{lastMsg.text}”</span>}
                </div>
              </section>
            )}
            {(canShip || canEdit) && !isNew && form.order_number && (
              <section className="ship-card" style={{ margin: 0 }}>
                <div className="ship-card-head">
                  <div><h3 style={{ fontSize: 14 }}>Customer wants to change the delivery</h3>
                    <p className="packed-sub" style={{ maxWidth: 'none', margin: '2px 0 0' }}>
                      {orderShip === undefined ? 'Checking the parcel…'
                        : !orderShip ? 'No AWB yet: any detail can change, and the new details are used when it ships.'
                          : orderShip.bucket === 'waiting_pickup' ? `AWB ${orderShip.awb} is waiting for pickup: name, phone, address and products can still change with Delhivery. A new pincode needs a new AWB.`
                            : orderShip.bucket === 'cancelled' ? `AWB ${orderShip.awb} was cancelled: the new details are used when it is re-created.`
                              : `Already picked up by Delhivery (AWB ${orderShip.awb}, ${orderShip.label}). It can't be changed from here now.`}
                    </p></div>
                  {!changing && <button type="button" className="btn btn-secondary btn-sm" disabled={ro || orderShip === undefined || pickedUp} onClick={() => setChanging(true)}><Icon name="edit" size={14} /> Change details</button>}
                </div>
                {changing && (
                  <DetailsForm initial={{ name: form.customer_name, phone: form.customer_phone }} busy={changeBusy}
                    lock={orderShip?.bucket === 'waiting_pickup' ? ['pincode', 'city', 'state'] : []}
                    submitLabel={orderShip?.bucket === 'waiting_pickup' ? 'Send to Delhivery' : 'Save for the shipment'}
                    note="Leave a field blank to keep what the order has. Sizes: write the new product and size, e.g. Dr Doom Hoodie - Green / L."
                    onSubmit={submitChange} onCancel={() => setChanging(false)} />
                )}
              </section>
            )}
            {canShip && !isNew && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: -4 }}>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShipOpen(true)}><Icon name="truck" size={14} /> Create Delhivery shipment</button>
                <span className="packed-sub" style={{ margin: 0 }}>A replacement or re-send; its AWB lands in Forward AWB.</span>
              </div>
            )}
            {shipOpen && (
              <ManualShipDrawer
                prefill={{
                  name: form.customer_name, phone: form.customer_phone, order_number: form.order_number,
                  city: lookup?.dispatch?.ship_city || '', state: lookup?.dispatch?.ship_state || '',
                  products: (lookup?.order?.items || []).map(i => `${i.title}${i.variant ? ` - ${i.variant}` : ''}${i.quantity > 1 ? ` x${i.quantity}` : ''}`).join(', '),
                  quantity: (lookup?.order?.items || []).reduce((n, i) => n + (Number(i.quantity) || 1), 0) || 1,
                  value: lookup?.order?.total_price || '', source_ref: `support:${ticket.id}`,
                  context: `For ticket ${refOf(ticket)}${form.order_number ? ` · ${form.order_number}` : ''}`,
                }}
                onClose={() => setShipOpen(false)}
                onDone={(r) => setF({ forward_awb: r.awb })} />
            )}
            <div className="input-group">
              <label>Operations note <span className="label-hint">optional</span></label>
              <AutoTextarea value={form.ops_note} disabled={ro} minRows={2}
                placeholder="Replacement dispatched with the XL, return picked up by Delhivery"
                onChange={e => setF({ ops_note: e.target.value })} />
            </div>

            <div className="form-section">Where it stands</div>
            <label className="support-priority">
              <input type="checkbox" checked={form.priority === 'Top'} disabled={ro}
                onChange={e => setF({ priority: e.target.checked ? 'Top' : '' })} />
              <span><b>Top priority</b> <span className="packed-sub" style={{ margin: 0, maxWidth: "none" }}>an angry customer, or a delay on our side: listed first and done first</span></span>
            </label>
            <div className="form-row">
              <div className="input-group">
                <label>Ticket</label>
                <select value={form.status} disabled={ro}
                  onChange={e => setF({
                    status: e.target.value,
                    // Closing stamps today unless a date is already set; reopening clears it, so
                    // the clock starts again rather than staying frozen.
                    resolved_on: e.target.value === 'Closed' ? (form.resolved_on || today()) : '',
                    progress: e.target.value === 'Closed' && form.progress === 'Pending' ? 'Completed' : form.progress,
                  })}>
                  {(options.statuses || []).map(v => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
              <div className="input-group">
                <label>Work</label>
                {/* Finishing the work finishes the ticket: it closes here rather than waiting for
                    somebody to remember the other dropdown. */}
                <select value={form.progress} disabled={ro}
                  onChange={e => setF({
                    progress: e.target.value,
                    ...(e.target.value === 'Completed'
                      ? { status: 'Closed', resolved_on: form.resolved_on || today() }
                      : {}),
                  })}>
                  {(options.progress || []).map(v => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
              <div className="input-group">
                <label>Resolved on</label>
                <input type="date" value={form.resolved_on || ''} disabled={ro}
                  onChange={e => setF({ resolved_on: e.target.value })} />
              </div>
            </div>
          </form>

          {/* The conversation about this ticket, with the same @mentions and replies as everywhere
              else. Only on a saved one — a comment needs something to hang off. */}
          {!isNew && (
            <>
              <div className="form-section">Comments</div>
              <OrderComments entity="support_ticket" orderId={ticket.id} />
            </>
          )}
        </div>

        {viewing !== null && thumbs[viewing] && (
          <div className="image-modal-overlay" onClick={() => setViewing(null)}>
            <div className="image-modal-content" onClick={e => e.stopPropagation()}>
              <button className="image-modal-close" onClick={() => setViewing(null)}>✕</button>
              <div className="image-modal-toolbar">
                {!thumbs[viewing].pending && (
                  <a className="image-modal-action" href={thumbs[viewing].full} target="_blank" rel="noreferrer">⬇ Open full size</a>
                )}
                {canEdit && (
                  <button className="image-modal-action image-modal-action-danger"
                    onClick={() => removeImage(thumbs[viewing])}>🗑 Remove</button>
                )}
              </div>
              {thumbs[viewing].pending && (
                <div className="image-modal-pending-tag">Not sent yet — it goes up when the ticket is raised</div>
              )}
              <img src={thumbs[viewing].preview} alt="Proof" className="full-image" />
              {thumbs.length > 1 && (
                <>
                  <button className="modal-carousel-nav-btn modal-carousel-prev"
                    onClick={() => setViewing(v => (v - 1 + thumbs.length) % thumbs.length)}>‹</button>
                  <button className="modal-carousel-nav-btn modal-carousel-next"
                    onClick={() => setViewing(v => (v + 1) % thumbs.length)}>›</button>
                  <div className="modal-carousel-counter">{viewing + 1} / {thumbs.length}</div>
                </>
              )}
            </div>
          </div>
        )}

        <div className="drawer-footer">
          {!isNew && onDelete && (
            <button type="button" className="btn btn-secondary" style={{ flex: '0 0 auto', color: 'var(--danger)' }}
              onClick={() => onDelete(ticket)} title="Owner only — everyone else closes it">
              <Icon name="trash" size={14} />
            </button>
          )}
          <button type="button" className="btn btn-secondary" onClick={guard.requestClose}>Close</button>
          {canEdit && (
            <button type="submit" form="support-ticket-form" className="btn btn-primary" disabled={busy}>
              {busy ? 'Saving…' : isNew ? 'Raise the ticket' : 'Save'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
