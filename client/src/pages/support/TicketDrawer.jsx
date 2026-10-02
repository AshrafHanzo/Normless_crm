import { useState, useEffect } from 'react'
import { useApi, useAuth } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import AutoTextarea from '../../components/AutoTextarea'
import OrderComments from '../../components/OrderComments'
import useDirtyGuard from '../../hooks/useDirtyGuard'
import { refOf, blankTicket, asForm } from './ticket'

const today = () => new Date().toLocaleDateString('en-CA')
const day = (v) => (v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—')

/**
 * One customer request, from "my size is wrong" to the day it was settled.
 *
 * The order comes first because everything else hangs off it: pulling it in fills the customer's
 * name, phone and email from what we already hold, and shows what was in the parcel and which
 * waybill it went out on — the two things a return is arranged against. It is only a lookup, not a
 * requirement: a customer can write in about an order too old to be in the CRM, and the ticket
 * still has to be raisable.
 */
export default function TicketDrawer({ ticket, options, onClose, onSaved, onDelete, canEdit }) {
  const apiFetch = useApi()
  const toast = useToast()
  const { user } = useAuth()
  const isNew = !ticket?.id

  const [form, setForm] = useState(() => asForm(ticket?.id ? ticket : { ...blankTicket(), ...ticket }))
  const [busy, setBusy] = useState(false)
  const [lookup, setLookup] = useState(null)     // { order, dispatch, history }
  const [looking, setLooking] = useState(false)
  const setF = (patch) => setForm(f => ({ ...f, ...patch }))

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

  // An existing ticket shows its order without being asked — the parcel and its waybill are the
  // context for every decision on the page.
  useEffect(() => {
    if (ticket?.id && ticket.order_number) pull(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket?.id])

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
    toast.success(`${refOf(res.ticket)} saved`)
    guard.reset(asForm(res.ticket))
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
              </div>
            )}
          </div>
          <button type="button" className="btn-icon" onClick={guard.requestClose}><Icon name="close" size={16} /></button>
        </div>

        <div className="drawer-body">
          <form id="support-ticket-form" onSubmit={save}>
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
              <div className="input-group">
                <label>Assigned to</label>
                <input value={form.assigned_to} disabled={ro} placeholder={user?.username?.split('@')[0] || 'Who is on it'}
                  onChange={e => setF({ assigned_to: e.target.value })} />
              </div>
            </div>
            <div className="form-row">
              <div className="input-group">
                <label>Forward AWB <span className="label-hint">parcel going out</span></label>
                <input value={form.forward_awb} disabled={ro} onChange={e => setF({ forward_awb: e.target.value })} />
              </div>
              <div className="input-group">
                <label>Return AWB <span className="label-hint">parcel coming back</span></label>
                <input value={form.return_awb} disabled={ro} onChange={e => setF({ return_awb: e.target.value })} />
              </div>
            </div>
            <div className="input-group">
              <label>Operations note <span className="label-hint">optional</span></label>
              <AutoTextarea value={form.ops_note} disabled={ro} minRows={2}
                placeholder="Replacement dispatched with the XL, return picked up by Delhivery"
                onChange={e => setF({ ops_note: e.target.value })} />
            </div>

            <div className="form-section">Where it stands</div>
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
