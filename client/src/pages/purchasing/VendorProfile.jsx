import { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useApi } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import VendorDrawer from './VendorDrawer'
import { BRAND_LABEL, inr, day } from './format'

const STATUS_CLASS = { Pending: 'pending', 'Consignment Ordered': 'refunded', 'Consignment Received': 'fulfilled' }
const PAY_CLASS = { 'Not Paid': 'pending', Paid: 'fulfilled' }

/** "Poly Cotton Polos · Navy, Black" per product line. */
const summarise = (items) => (items || []).map(i => {
  const colors = (i.colors || []).map(c => c.color).filter(Boolean).join(', ')
  return [i.product_type, colors].filter(Boolean).join(' · ')
}).filter(Boolean)

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

  const { vendor: v, orders, stats } = data
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
    { label: 'Orders', value: stats.orders, sub: stats.open_orders ? `${stats.open_orders} open` : null },
    { label: 'Ordered value', value: inr(stats.ordered_value), sub: stats.unpriced_orders ? `${stats.unpriced_orders} without rates` : 'incl. GST where quoted' },
    { label: 'Pieces ordered', value: stats.pieces.toLocaleString('en-IN') },
  ]

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
        {can.edit && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {can.delete && !stats.orders && (
              <button className="btn btn-secondary" style={{ color: 'var(--danger)' }} onClick={remove}><Icon name="trash" size={14} /> Delete</button>
            )}
            <button className="btn btn-secondary" onClick={() => setActive(!v.active)}>{v.active ? 'Archive' : 'Make active'}</button>
            <button className="btn btn-primary" onClick={() => setEditing(true)}><Icon name="edit" size={14} /> Edit</button>
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
            <Detail label="Internal notes"><span style={{ whiteSpace: 'pre-wrap' }}>{v.notes}</span></Detail>
          </div>
        </div>
      </div>

      <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        {kpis.map(k => (
          <div className="kpi-card" key={k.label}>
            <div className="kpi-value">{k.value}</div>
            <div className="kpi-label">{k.label}</div>
            {k.sub && <div className="kpi-sub">{k.sub}</div>}
          </div>
        ))}
      </div>

      <h3 style={{ margin: '4px 0 12px' }}>Orders</h3>
      <div className="data-table-wrapper">
        {!orders.length ? (
          <div className="empty-state"><p>No orders with {v.name} yet.</p></div>
        ) : (
          <table className="data-table">
            <thead>
              <tr><th>Ref</th><th>Brand</th><th>Date</th><th>Delivery</th><th>Products</th><th style={{ textAlign: 'center' }}>Qty</th><th style={{ textAlign: 'right' }}>Value</th><th>Status</th><th>Payment</th></tr>
            </thead>
            <tbody>
              {orders.map(o => (
                <tr key={`${o.brand}-${o.id}`}>
                  <td className="cell-primary" style={{ fontWeight: 600 }}>{o.ref}</td>
                  <td data-label="Brand"><span className="badge-secondary">{BRAND_LABEL[o.brand]}</span></td>
                  <td data-label="Date" style={{ fontSize: 12.5 }}>{day(o.order_date)}</td>
                  <td data-label="Delivery" style={{ fontSize: 12.5 }}>{day(o.delivery_date)}</td>
                  <td data-label="Products" style={{ fontSize: 12 }}>{summarise(o.items).map((s, i) => <div key={i}>{s}</div>)}</td>
                  <td data-label="Qty" style={{ textAlign: 'center', fontWeight: 600 }}>{o.total_qty}</td>
                  <td data-label="Value" style={{ textAlign: 'right' }}>{Number(o.total_amount) ? inr(o.total_amount) : '—'}</td>
                  <td data-label="Status"><span className={`status-badge ${STATUS_CLASS[o.status] || ''}`}>{o.status}</span></td>
                  <td data-label="Payment"><span className={`status-badge ${PAY_CLASS[o.payment_status] || ''}`}>{o.payment_status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <VendorDrawer vendor={v} meta={meta} canBank={!!can.bank} apiFetch={apiFetch} toast={toast}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); load() }} />
      )}
    </div>
  )
}
