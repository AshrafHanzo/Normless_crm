import { useState, useEffect } from 'react'
import { useParams, useNavigate, Link, useSearchParams } from 'react-router-dom'
import { useApi } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import VendorDrawer from './VendorDrawer'
import RecordPaymentDrawer from './RecordPaymentDrawer'
import QuotationList from './QuotationList'
import VendorInvoiceList from './VendorInvoiceList'
import VendorLinkCard from './VendorLinkCard'
import VendorWaCard from './VendorWaCard'
import { BRAND_LABEL, PAY_CLASS, inr, day, openProof } from './format'

const STATUS_CLASS = { Pending: 'pending', 'Consignment Ordered': 'refunded', 'Partly Received': 'partial', 'Consignment Received': 'fulfilled' }
const TABS = [['orders', 'Orders'], ['quotations', 'Quotations'], ['payments', 'Payments'], ['invoices', 'Invoices'], ['statement', 'Statement']]

/** "Poly Cotton Polos · Navy, Black" / "Mask · 300 pcs" per product line. */
const summarise = (items) => (items || []).map(i => {
  if (i.kind === 'simple') return [i.product_type, i.qty ? `${i.qty} pcs` : null].filter(Boolean).join(' · ')
  const colors = (i.colors || []).map(c => c.color).filter(Boolean).join(', ')
  return [i.product_type, colors].filter(Boolean).join(' · ')
}).filter(Boolean)

/** The running ledger: orders raise what is owed, payments bring it down. */
function Statement({ vendorId, version, apiFetch }) {
  const [data, setData] = useState(null)
  useEffect(() => {
    let live = true
    apiFetch(`/api/vendors/${vendorId}/statement`).then(r => { if (live && r && !r.error) setData(r) })
    return () => { live = false }
    // apiFetch is a new function every render (see useApi), so it can't be a dependency here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorId, version])
  if (!data) return <div className="loader"><div className="spinner" /></div>
  if (!data.entries.length) return <div className="empty-state"><p>Nothing to show yet.</p></div>
  return (
    <table className="data-table">
      <thead>
        <tr><th>Date</th><th>Entry</th><th>Reference</th><th style={{ textAlign: 'right' }}>Billed</th><th style={{ textAlign: 'right' }}>Paid</th><th style={{ textAlign: 'right' }}>Balance</th></tr>
      </thead>
      <tbody>
        {data.entries.map(e => (
          <tr key={`${e.kind}-${e.id}`}>
            <td data-label="Date" style={{ fontSize: 12.5 }}>{day(e.date)}</td>
            <td className="cell-primary">
              {e.kind === 'order' ? <><b>{e.ref}</b> <span className="badge-secondary">{BRAND_LABEL[e.brand]}</span><div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{e.text}</div></> : e.text}
            </td>
            <td data-label="Reference">
              {e.kind === 'payment'
                ? (e.ref ? <span className="vp-mono">{e.ref}</span> : e.missing_reference ? <span className="status-badge pending">Add UTR</span> : '—')
                : (e.billed == null ? <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>No total</span> : '')}
            </td>
            <td data-label="Billed" style={{ textAlign: 'right' }}>{e.billed != null ? inr(e.billed) : ''}</td>
            <td data-label="Paid" style={{ textAlign: 'right', color: 'var(--success)' }}>{e.paid != null ? inr(e.paid) : ''}</td>
            <td data-label="Balance" className="vp-ledger-bal" style={{ textAlign: 'right', fontWeight: 600 }}>{inr(e.balance)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr><td colSpan={5} style={{ fontWeight: 700 }}>{data.balance >= 0 ? 'Balance owed to the vendor' : 'Paid ahead (credit with the vendor)'}</td><td style={{ textAlign: 'right', fontWeight: 700 }}>{inr(Math.abs(data.balance))}</td></tr>
      </tfoot>
    </table>
  )
}

/** "20% on order · 30% after 14 days · 50% on delivery" — set from an order's payment plan. */
function usualPlan(raw) {
  let rows = []
  try { rows = JSON.parse(raw || '[]') } catch { return null }
  if (!rows.length) return null
  return rows.map(r => {
    const share = r.percent ? `${Number(r.percent)}%` : inr(r.amount)
    const when = r.due_kind === 'delivery' ? 'on delivery' : r.days == null ? 'date to be fixed' : Number(r.days) === 0 ? 'on order' : `after ${r.days} days`
    return `${share} ${when}`
  }).join(' · ')
}

function Detail({ label, children }) {
  return (
    <div className="vp-detail">
      <span>{label}</span>
      <div>{children || <span style={{ color: 'var(--text-muted)' }}>—</span>}</div>
    </div>
  )
}

export default function VendorProfile() {
  const { id } = useParams()
  const apiFetch = useApi()
  const toast = useToast()
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [meta, setMeta] = useState(null)
  const [missing, setMissing] = useState(false)
  const [editing, setEditing] = useState(false)
  const [paying, setPaying] = useState(null)     // true = new, or a payment id to edit
  // A notification can open a tab directly (?tab=invoices).
  const [params] = useSearchParams()
  const [tab, setTab] = useState(() => (TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'orders'))
  const [addingQuote, setAddingQuote] = useState(false)

  // Bumped to reload after a save, archive or restore.
  const [version, setVersion] = useState(0)
  const load = () => setVersion(n => n + 1)

  useEffect(() => {
    let live = true
    apiFetch(`/api/vendors/${id}`).then(r => {
      if (!live || !r) return
      if (r.error) setMissing(true)
      else setData(r)
    })
    return () => { live = false }
  // apiFetch is a new function every render (see useApi), so it can't be a dependency here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, version])
  // apiFetch is a new function every render (see useApi), so it can't be a dependency here.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { apiFetch('/api/vendors/meta').then(r => r && !r.error && setMeta(r)) }, [])

  if (missing) {
    return (
      <div className="page-enter">
        <Link to="/vendors" className="vp-back">← Vendors</Link>
        <div className="empty-state"><p>That vendor doesn’t exist any more.</p></div>
      </div>
    )
  }
  if (!data) return <div className="loader"><div className="spinner" /></div>

  const { vendor: v, orders, payments, stats } = data
  const can = meta?.can || {}
  const cats = String(v.categories || '').split(',').map(c => c.trim()).filter(Boolean)

  const copyBank = async () => {
    const text = [
      v.bank_account_name && `Name: ${v.bank_account_name}`,
      v.bank_name && `Bank: ${v.bank_name}`,
      v.bank_account_no && `A/c: ${v.bank_account_no}`,
      v.bank_ifsc && `IFSC: ${v.bank_ifsc}`,
      v.upi_id && `UPI: ${v.upi_id}`,
    ].filter(Boolean).join('\n')
    await navigator.clipboard.writeText(text)
    toast.success('Bank details copied')
  }

  const setActive = async (active) => {
    if (!active && !await toast.confirm({
      title: `Archive ${v.name}?`,
      message: 'They drop out of the vendor pick-lists. Their orders and history stay, and you can bring them back any time.',
      confirmLabel: 'Archive',
    })) return
    const r = await apiFetch(`/api/vendors/${v.id}/active`, { method: 'POST', body: JSON.stringify({ active }) })
    if (r?.error) { toast.error(r.error); return }
    toast.success(active ? `${v.name} is active again` : `${v.name} archived`)
    load()
  }

  const remove = async () => {
    if (!await toast.confirm({ title: `Delete ${v.name}?`, message: 'This vendor has no orders. Deleting removes them from the list for good.', danger: true, confirmLabel: 'Delete' })) return
    const r = await apiFetch(`/api/vendors/${v.id}`, { method: 'DELETE' })
    if (r?.error) { toast.error(r.error); return }
    toast.success('Vendor deleted')
    navigate('/vendors')
  }

  const kpis = [
    { label: 'Ordered (incl. GST)', value: inr(stats.billed), sub: stats.unpriced_orders ? `${stats.unpriced_orders} order${stats.unpriced_orders > 1 ? 's' : ''} without a total` : null },
    { label: 'Paid', value: inr(stats.paid), sub: stats.on_account > 0 ? `${inr(stats.on_account)} on account` : null, color: 'var(--success)' },
    { label: 'Balance', value: inr(stats.balance), color: stats.balance > 0 ? 'var(--warning)' : undefined },
    { label: 'Orders', value: stats.orders, sub: [stats.open_orders ? `${stats.open_orders} open` : null, `${stats.pieces.toLocaleString('en-IN')} pcs`].filter(Boolean).join(' · ') },
    { label: 'Pieces still to come', value: stats.pending_pcs.toLocaleString('en-IN'), sub: stats.received ? `${stats.received.toLocaleString('en-IN')} received` : null, color: stats.pending_pcs > 0 ? 'var(--warning)' : undefined },
  ]
  const missingUtr = payments.filter(p => p.missing_reference).length

  return (
    <div className="page-enter">
      <Link to="/vendors" className="vp-back">← Vendors</Link>

      <div className="dash-toolbar" style={{ marginTop: 8 }}>
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {v.name}
            {!v.active && <span className="section-badge">Archived</span>}
          </h1>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            <span className="badge-primary">{BRAND_LABEL[v.brands] || v.brands}</span>
            {cats.map(c => <span key={c} className="badge-secondary">{c}</span>)}
          </div>
        </div>
        {(can.edit || can.bank) && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {can.edit && can.delete && !stats.orders && !payments.length && (
              <button className="btn btn-secondary" style={{ color: 'var(--danger)' }} onClick={remove}><Icon name="trash" size={14} /> Delete</button>
            )}
            {can.edit && <button className="btn btn-secondary" onClick={() => setActive(!v.active)}>{v.active ? 'Archive' : 'Make active'}</button>}
            {can.edit && <button className="btn btn-secondary" onClick={() => setEditing(true)}><Icon name="edit" size={14} /> Edit</button>}
            {can.bank && <button className="btn btn-primary" onClick={() => setPaying(true)}><Icon name="wallet" size={14} /> Record payment</button>}
          </div>
        )}
      </div>

      <div className="vp-grid">
        <div className="glass-card vp-card">
          <h3>Contact</h3>
          <div className="vp-details">
            <Detail label="Contact person">{v.contact_person}</Detail>
            <Detail label="WhatsApp">
              {v.phone && <>{v.phone}{!v.whatsapp_updates && <span style={{ color: 'var(--text-muted)', fontSize: 12 }}> · updates off</span>}</>}
            </Detail>
            <Detail label="Email">{v.email && <a href={`mailto:${v.email}`}>{v.email}</a>}</Detail>
            <Detail label="Address">{[v.address, v.city, v.state].filter(Boolean).join(', ')}</Detail>
            <Detail label="GSTIN">{v.gstin}</Detail>
            <Detail label="PAN">{v.pan}</Detail>
          </div>
        </div>

        <div className="glass-card vp-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <h3>Bank details</h3>
            {can.bank && v.bank_on_file && <button className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: 13 }} onClick={copyBank}><Icon name="copy" size={13} /> Copy</button>}
          </div>
          {can.bank ? (
            <div className="vp-details">
              <Detail label="Account holder">{v.bank_account_name}</Detail>
              <Detail label="Bank">{v.bank_name}</Detail>
              <Detail label="Account number"><span className="vp-mono">{v.bank_account_no}</span></Detail>
              <Detail label="IFSC"><span className="vp-mono">{v.bank_ifsc}</span></Detail>
              <Detail label="UPI">{v.upi_id}</Detail>
            </div>
          ) : (
            <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: 0 }}>
              {v.bank_on_file ? `On file${v.bank_last4 ? ` — account ending ${v.bank_last4}` : ''}.` : 'Not on file.'}{' '}
              Only people who record vendor payments can see bank details.
            </p>
          )}
          <h3 style={{ marginTop: 18 }}>Terms &amp; notes</h3>
          <div className="vp-details">
            <Detail label="Payment terms">{v.payment_terms}</Detail>
            <Detail label="Usual payment plan">{usualPlan(v.default_plan)}</Detail>
            <Detail label="Internal notes"><span style={{ whiteSpace: 'pre-wrap' }}>{v.notes}</span></Detail>
          </div>
        </div>

        {can.share && <VendorLinkCard vendor={v} apiFetch={apiFetch} toast={toast} onChanged={load} />}
        <VendorWaCard vendorId={v.id} version={version} canEdit={!!can.edit} apiFetch={apiFetch} toast={toast} />
      </div>

      <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        {kpis.map(k => (
          <div className="kpi-card" key={k.label}>
            <div className="kpi-value" style={k.color ? { color: k.color } : undefined}>{k.value}</div>
            <div className="kpi-label">{k.label}</div>
            {k.sub && <div className="kpi-sub">{k.sub}</div>}
          </div>
        ))}
      </div>

      <div className="scan-tabs" style={{ marginBottom: 14 }} role="tablist">
        {TABS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
            {l}{k === 'orders' ? ` (${orders.length})` : k === 'payments' ? ` (${payments.length})` : k === 'quotations' ? ` (${stats.quotations || 0})` : k === 'invoices' ? ` (${stats.invoices || 0})` : ''}
            {k === 'invoices' && stats.invoices_review > 0 && <span className="tab-badge" title={`${stats.invoices_review} to review`}>{stats.invoices_review}</span>}
            {k === 'payments' && missingUtr > 0 && <span className="tab-badge" title={`${missingUtr} without a UTR`}>{missingUtr}</span>}
          </button>
        ))}
      </div>

      {tab === 'quotations' && (
        <>
          {can.edit && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
              <button className="btn btn-secondary" onClick={() => setAddingQuote(true)}><Icon name="plus" size={14} /> Add quotation</button>
            </div>
          )}
          <QuotationList apiFetch={apiFetch} toast={toast} can={can} vendorId={v.id}
            adding={addingQuote} onAddClose={() => setAddingQuote(false)} onChanged={load} />
        </>
      )}

      {tab === 'invoices' && (
        <VendorInvoiceList vendorId={v.id} orders={orders} can={can} apiFetch={apiFetch} toast={toast} onChanged={load} />
      )}

      {tab !== 'quotations' && tab !== 'invoices' && <div className="data-table-wrapper">
        {tab === 'orders' && (!orders.length ? (
          <div className="empty-state"><p>No orders with {v.name} yet.</p></div>
        ) : (
          <table className="data-table">
            <thead>
              <tr><th>Ref</th><th>Date</th><th>Products</th><th style={{ textAlign: 'center' }}>Qty</th><th style={{ textAlign: 'right' }}>Total</th><th style={{ textAlign: 'right' }}>Paid</th><th style={{ textAlign: 'right' }}>Balance</th><th>Status</th><th>Payment</th></tr>
            </thead>
            <tbody>
              {orders.map(o => (
                <tr key={o.id}>
                  <td className="cell-primary">
                    <b>{o.ref}</b> <span className="badge-secondary">{BRAND_LABEL[o.brand]}</span>
                    {(o.title || o.quote_ref) && <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{[o.title, o.quote_ref].filter(Boolean).join(' · ')}</div>}
                  </td>
                  <td data-label="Date" style={{ fontSize: 12.5 }}>{day(o.order_date)}</td>
                  <td data-label="Products" style={{ fontSize: 12 }}>{summarise(o.items).map((s, i) => <div key={i}>{s}</div>)}</td>
                  <td data-label="Qty" style={{ textAlign: 'center', fontWeight: 600 }}>
                    {o.total_qty}
                    {o.pending_qty > 0 && Number(o.received_qty) > 0 && <div style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--warning)' }}>{o.pending_qty} to come</div>}
                  </td>
                  <td data-label="Total" style={{ textAlign: 'right' }}>{o.total ? inr(o.total) : '—'}</td>
                  <td data-label="Paid" style={{ textAlign: 'right' }}>{o.paid_amount ? inr(o.paid_amount) : '—'}</td>
                  <td data-label="Balance" style={{ textAlign: 'right', fontWeight: 600, color: o.balance > 0 ? 'var(--warning)' : undefined }}>{o.total ? inr(o.balance) : '—'}</td>
                  <td data-label="Status"><span className={`status-badge ${STATUS_CLASS[o.status] || ''}`}>{o.status}</span></td>
                  <td data-label="Payment"><span className={`status-badge ${PAY_CLASS[o.payment_status] || ''}`}>{o.payment_status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}

        {tab === 'payments' && (!payments.length ? (
          <div className="empty-state"><p>No payments to {v.name} recorded yet.</p></div>
        ) : (
          <table className="data-table">
            <thead>
              <tr><th>Paid on</th><th>Mode</th><th>UTR / reference</th><th>For</th><th style={{ textAlign: 'right' }}>Amount</th><th></th></tr>
            </thead>
            <tbody>
              {payments.map(p => (
                <tr key={p.id} onClick={() => can.bank && setPaying(p.id)} style={{ cursor: can.bank ? 'pointer' : undefined }}>
                  <td className="cell-primary" style={{ fontSize: 12.5 }}>{day(p.paid_on)}{p.note && <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{p.note}</div>}</td>
                  <td data-label="Mode">{p.mode || '—'}</td>
                  <td data-label="UTR / reference">
                    {p.reference ? <span className="vp-mono">{p.reference}</span>
                      : p.missing_reference ? <span className="status-badge pending">Add UTR</span>
                        : <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{p.source === 'migrated' ? 'Before payments were recorded' : '—'}</span>}
                  </td>
                  <td data-label="For" style={{ fontSize: 12.5 }}>
                    {p.allocations.map(a => <div key={a.order_id}>{a.ref} · {inr(a.amount)}</div>)}
                    {p.amount - p.allocations.reduce((s2, a) => s2 + a.amount, 0) > 0.005 && <div style={{ color: 'var(--text-muted)' }}>On account</div>}
                  </td>
                  <td data-label="Amount" style={{ textAlign: 'right', fontWeight: 600 }}>{inr(p.amount)}</td>
                  <td className="cell-actions" onClick={e => e.stopPropagation()}>
                    {p.has_proof && <button className="btn-icon" title="Open proof" aria-label="Open proof" onClick={() => openProof(apiFetch, toast, p.id)}><Icon name="eye" size={14} /></button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}

        {tab === 'statement' && <Statement vendorId={v.id} version={version} apiFetch={apiFetch} />}
      </div>}

      {editing && (
        <VendorDrawer vendor={v} meta={meta} canBank={!!can.bank} apiFetch={apiFetch} toast={toast}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); load() }} />
      )}
      {paying && (
        <RecordPaymentDrawer vendorId={v.id} paymentId={paying === true ? null : paying} apiFetch={apiFetch} toast={toast}
          onClose={() => setPaying(null)}
          onSaved={() => { setPaying(null); load() }} />
      )}
    </div>
  )
}
