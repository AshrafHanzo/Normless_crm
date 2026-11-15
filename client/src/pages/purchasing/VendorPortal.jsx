import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { useAuth } from '../../App'
import { inr, day } from './format'

/**
 * A vendor's own page — public, opened from the link we send them. Phone first: vendors open it
 * from WhatsApp. Read-only, except that they can upload their invoices.
 */

const INST_TONE = { Paid: 'ok', Overdue: 'warn', Due: 'warn', 'Due soon': 'warn', Upcoming: 'idle', 'On delivery': 'idle', 'No date': 'idle' }
const INV_TONE = { Accepted: 'ok', Rejected: 'bad', 'Under review': 'warn' }
const lineLabel = (l) => [l.product, l.color, l.size].filter(Boolean).join(' · ')

function Card({ title, right, children }) {
  return (
    <section className="vpo-card">
      {(title || right) && <div className="vpo-card-head"><h2>{title}</h2>{right}</div>}
      {children}
    </section>
  )
}

function UploadInvoice({ token, orders, api, onDone }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ invoice_no: '', invoice_date: '', amount: '', order_id: '' })
  const [file, setFile] = useState(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)

  const submit = async (e) => {
    e.preventDefault()
    if (!form.invoice_no.trim()) { setMsg({ bad: true, text: 'Enter the invoice number.' }); return }
    if (!file) { setMsg({ bad: true, text: 'Attach the invoice (PDF or photo).' }); return }
    setBusy(true); setMsg(null)
    const fd = new FormData()
    for (const [k, v] of Object.entries(form)) fd.append(k, v)
    fd.append('file', file)
    try {
      const r = await fetch(`${api}/api/portal/vendor/${token}/invoices`, { method: 'POST', body: fd })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) { setMsg({ bad: true, text: data.error || 'The invoice couldn’t be uploaded.' }); return }
      setMsg({ text: 'Thank you — we’ll review it and the status will show below.' })
      setForm({ invoice_no: '', invoice_date: '', amount: '', order_id: '' }); setFile(null); setOpen(false)
      onDone()
    } catch {
      setMsg({ bad: true, text: 'No connection — try again.' })
    } finally { setBusy(false) }
  }

  return (
    <>
      {msg && <p className={`vpo-msg ${msg.bad ? 'bad' : ''}`} role={msg.bad ? 'alert' : 'status'}>{msg.text}</p>}
      {!open ? (
        <button type="button" className="vpo-btn vpo-btn-primary" onClick={() => { setOpen(true); setMsg(null) }}>Upload invoice</button>
      ) : (
        <form className="vpo-form" onSubmit={submit}>
          <label>Invoice number *<input value={form.invoice_no} onChange={e => setForm(f => ({ ...f, invoice_no: e.target.value }))} required /></label>
          <div className="vpo-two">
            <label>Invoice date<input type="date" value={form.invoice_date} onChange={e => setForm(f => ({ ...f, invoice_date: e.target.value }))} /></label>
            <label>Amount (₹, incl. GST)<input type="number" min="0" step="any" inputMode="decimal" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} /></label>
          </div>
          {orders.length > 0 && (
            <label>For order
              <select value={form.order_id} onChange={e => setForm(f => ({ ...f, order_id: e.target.value }))}>
                <option value="">Not for one order</option>
                {orders.map(o => <option key={o.id} value={o.id}>{o.ref}{o.title ? ` · ${o.title}` : ''}{o.quote_ref ? ` · ${o.quote_ref}` : ''}</option>)}
              </select>
            </label>
          )}
          <label>The invoice * <span className="vpo-muted">PDF or photo, up to 10 MB</span>
            <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={e => setFile(e.target.files?.[0] || null)} />
          </label>
          <div className="vpo-two">
            <button type="button" className="vpo-btn" onClick={() => setOpen(false)}>Cancel</button>
            <button type="submit" className="vpo-btn vpo-btn-primary" disabled={busy}>{busy ? 'Uploading…' : 'Send invoice'}</button>
          </div>
        </form>
      )}
    </>
  )
}

export default function VendorPortal() {
  const { token } = useParams()
  const { API_URL } = useAuth()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [showAllPays, setShowAllPays] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API_URL}/api/portal/vendor/${encodeURIComponent(token)}`)
      const d = await r.json().catch(() => ({}))
      if (!r.ok) { setError(d.error || 'This link isn’t active.'); return }
      setData(d); setError(null)
    } catch {
      setError('No connection — check your internet and try again.')
    }
  }, [API_URL, token])

  // Kept out of search engines, and titled for the browser tab.
  useEffect(() => {
    const meta = document.createElement('meta')
    meta.name = 'robots'; meta.content = 'noindex, nofollow'
    document.head.appendChild(meta)
    return () => meta.remove()
  }, [])
  useEffect(() => { if (data) document.title = `${data.vendor.name} · ${data.company}` }, [data])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [load])

  const openInvoice = async (id) => {
    const r = await fetch(`${API_URL}/api/portal/vendor/${token}/invoices/${id}/file`)
    if (!r.ok) return
    const href = URL.createObjectURL(await r.blob())
    window.open(href, '_blank')
    setTimeout(() => URL.revokeObjectURL(href), 60000)
  }

  if (error) {
    return <div className="vpo"><div className="vpo-wrap"><Card title="Link not active"><p className="vpo-muted">{error}</p></Card></div></div>
  }
  if (!data) return <div className="vpo"><div className="vpo-wrap"><p className="vpo-muted" style={{ textAlign: 'center', marginTop: 80 }}>Loading…</p></div></div>

  const { vendor: v, money: m, orders, payments, invoices, statement } = data
  const openOrders = orders.filter(o => o.status !== 'Consignment Received' || (o.balance || 0) > 0)
  const pays = showAllPays ? payments : payments.slice(0, 6)

  return (
    <div className="vpo">
      <div className="vpo-wrap">
        <header className="vpo-header">
          <div className="vpo-muted">{data.company} · Vendor page</div>
          <h1>{v.name}</h1>
          <div className="vpo-muted">As of {day(data.as_of.slice(0, 10))} · amounts include GST</div>
        </header>

        <section className="vpo-balance">
          <span>{m.balance >= 0 ? 'Balance payable to you' : 'Paid ahead'}</span>
          <strong>{inr(Math.abs(m.balance))}</strong>
          <div className="vpo-balance-row"><span>Billed {inr(m.billed)}</span><span>Paid {inr(m.paid)}</span></div>
          <div className="vpo-bar"><i style={{ width: `${m.billed ? Math.min(100, m.paid / m.billed * 100) : 0}%` }} /></div>
        </section>

        <Card title="Your invoices">
          <p className="vpo-muted" style={{ marginTop: 0 }}>Upload your tax invoice here. We’ll review it and the status will show below.</p>
          <UploadInvoice token={token} orders={orders} api={API_URL} onDone={load} />
          {invoices.length > 0 && (
            <div className="vpo-list">
              {invoices.map(i => (
                <div key={i.id} className="vpo-row">
                  <div>
                    <b>{i.invoice_no}</b>
                    <div className="vpo-muted">{[day(i.invoice_date || i.uploaded_on), i.order_ref, i.amount != null && inr(i.amount)].filter(Boolean).join(' · ')}</div>
                    {i.status === 'Rejected' && i.reason && <div className="vpo-bad-text">{i.reason}</div>}
                  </div>
                  <div className="vpo-row-end">
                    <span className={`vpo-chip ${INV_TONE[i.status] || ''}`}>{i.status}</span>
                    <button type="button" className="vpo-link" onClick={() => openInvoice(i.id)}>View</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {openOrders.map(o => (
          <Card key={o.id} title={`Order ${o.ref}`} right={<span className={`vpo-chip ${o.status === 'Consignment Received' ? 'ok' : o.status === 'Partly Received' ? 'warn' : 'idle'}`}>{o.status}</span>}>
            <div className="vpo-muted">{[`Ordered ${day(o.order_date)}`, o.quote_ref && `your quotation ${o.quote_ref}`, o.title].filter(Boolean).join(' · ')}</div>
            {o.delivery_date && <div className="vpo-muted">Delivery by {day(o.delivery_date)}</div>}

            <div className="vpo-lines">
              {o.progress.lines.filter(l => !l.unmatched).map(l => (
                <div key={l.key} className="vpo-line">
                  <div className="vpo-line-top">
                    <span>{lineLabel(l)}</span>
                    <span className="vpo-num">{l.accepted} of {l.ordered}{l.pending > 0 ? <b> · {l.pending} to come</b> : ' · all in'}</span>
                  </div>
                  <div className="vpo-bar thin"><i style={{ width: `${l.ordered ? Math.min(100, l.accepted / l.ordered * 100) : 0}%` }} /></div>
                  {l.rejected > 0 && <div className="vpo-bad-text">{l.rejected} didn’t pass our QC — still owed</div>}
                </div>
              ))}
            </div>

            {o.total != null && (
              <div className="vpo-money"><span>Order value <b>{inr(o.total)}</b></span><span>Paid <b>{inr(o.paid)}</b></span><span>Balance <b>{inr(o.balance)}</b></span></div>
            )}

            {o.instalments.length > 0 && (
              <>
                <h3>Payment plan</h3>
                <div className="vpo-list">
                  {o.instalments.map(i => (
                    <div key={i.number} className="vpo-row">
                      <span>{i.label || `${i.number} of ${i.of}`} · {inr(i.amount)}</span>
                      <span className={`vpo-chip ${INST_TONE[i.status] || ''}`}>
                        {i.status === 'Paid' ? 'Paid' : i.due_kind === 'delivery' ? 'On delivery' : i.due_date ? `${i.status === 'Upcoming' || i.status === 'Due soon' ? 'Due' : i.status} ${day(i.due_date)}` : 'Date to be fixed'}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {o.deliveries.length > 0 && (
              <details className="vpo-details">
                <summary>{o.deliveries.length} deliver{o.deliveries.length === 1 ? 'y' : 'ies'} we recorded</summary>
                <div className="vpo-list">
                  {o.deliveries.map((d, n) => (
                    <div key={n} className="vpo-row">
                      <span>{day(d.received_on)}</span>
                      <span className="vpo-muted" style={{ textAlign: 'right' }}>{d.lines.map(l => `${[l.color, l.size].filter(Boolean).join(' ') || l.product} × ${l.received}`).join(', ')}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </Card>
        ))}

        <Card title="Payments made">
          {!payments.length ? <p className="vpo-muted">No payments recorded yet.</p> : (
            <div className="vpo-list">
              {pays.map((p, n) => (
                <div key={n} className="vpo-row">
                  <div>
                    <b>{day(p.paid_on)}</b>
                    <div className="vpo-muted">
                      {p.reference ? <>{p.mode} · UTR <span className="vpo-mono">{p.reference}</span></> : p.recorded_earlier ? 'Recorded earlier' : p.mode === 'Cash' ? 'Cash' : 'Reference to be added'}
                    </div>
                    {p.for.length > 0 && <div className="vpo-muted">For {p.for.map(f => f.ref).join(', ')}</div>}
                  </div>
                  <b className="vpo-num">{inr(p.amount)}</b>
                </div>
              ))}
            </div>
          )}
          {payments.length > 6 && <button type="button" className="vpo-link" onClick={() => setShowAllPays(s => !s)}>{showAllPays ? 'Show fewer' : `Show all ${payments.length} payments`}</button>}
        </Card>

        <Card title="Statement" right={<button type="button" className="vpo-link" onClick={() => window.print()}>Print / save PDF</button>}>
          <div className="vpo-table-wrap">
            <table className="vpo-table">
              <thead><tr><th>Date</th><th>Entry</th><th>Billed</th><th>Paid</th><th>Balance</th></tr></thead>
              <tbody>
                {statement.entries.map(e => (
                  <tr key={`${e.kind}-${e.id}`}>
                    <td>{day(e.date)}</td>
                    <td>{e.kind === 'order' ? `${e.ref} · ${e.text}` : `${e.text}${e.ref ? ` · ${e.ref}` : ''}`}</td>
                    <td className="vpo-num">{e.billed != null ? inr(e.billed) : ''}</td>
                    <td className="vpo-num">{e.paid != null ? inr(e.paid) : ''}</td>
                    <td className="vpo-num"><b>{inr(e.balance)}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Your details with us">
          <p className="vpo-muted" style={{ marginTop: 0 }}>Payments go to the account below. If anything is wrong, tell us before the next payment.</p>
          <div className="vpo-list">
            {v.bank ? (
              <>
                <div className="vpo-row"><span className="vpo-muted">Account</span><span>{[v.bank.bank_name, v.bank.account].filter(Boolean).join(' ') || '—'}</span></div>
                {v.bank.ifsc && <div className="vpo-row"><span className="vpo-muted">IFSC</span><span className="vpo-mono">{v.bank.ifsc}</span></div>}
                {v.bank.upi && <div className="vpo-row"><span className="vpo-muted">UPI</span><span>{v.bank.upi}</span></div>}
              </>
            ) : <div className="vpo-row"><span className="vpo-muted">Bank account</span><span>Not on file — please send it to us</span></div>}
            {v.gstin && <div className="vpo-row"><span className="vpo-muted">GSTIN</span><span className="vpo-mono">{v.gstin}</span></div>}
            {v.phone && <div className="vpo-row"><span className="vpo-muted">WhatsApp</span><span>{v.phone}</span></div>}
          </div>
        </Card>

        <p className="vpo-muted vpo-foot">This private link was shared with you by {data.company}. Please don’t forward it.</p>
      </div>
    </div>
  )
}
