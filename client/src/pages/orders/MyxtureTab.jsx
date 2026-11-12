import { useState, useEffect, useMemo } from 'react'
import { useApi } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import DateRangeFilter from '../../components/DateRangeFilter'

/**
 * Myxture print-on-demand. Jersey orders go to their portal as a downloaded sheet; every download
 * is a recorded batch, so a line that has gone once never shows up as ready again. When the
 * parcel comes in, the batch is opened and checked line by line.
 */

const SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL']
const sizeRank = (s) => { const i = SIZE_ORDER.indexOf(s); return i === -1 ? 99 : i }
const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'
const fmtDateTime = (d) => d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—'
const keyOf = (l) => `${l.order_shopify_id}|${l.line_key}`
const STATUS_CLASS = { Sent: 'pending', 'Partly received': 'partial', Received: 'fulfilled', Voided: 'refunded' }

function useDownload() {
  const apiFetch = useApi()
  const toast = useToast()
  return async (batch, ext) => {
    const r = await apiFetch(`/api/myxture/batches/${batch.id}/file.${ext}`, { responseType: 'blob' })
    if (!r || r.error) { toast.error(r?.error || 'Download failed'); return false }
    const href = URL.createObjectURL(r.blob)
    const a = document.createElement('a')
    a.href = href; a.download = r.filename || `${batch.ref}.${ext}`
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(href)
    return true
  }
}

export default function MyxtureTab() {
  const apiFetch = useApi()
  const [view, setView] = useState('ready')
  const [stats, setStats] = useState(null)
  const [openBatch, setOpenBatch] = useState(null)

  const loadStats = async () => {
    const r = await apiFetch('/api/myxture/stats')
    if (r && !r.error) setStats(r)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadStats() }, [])

  const kpis = [
    { icon: '📤', value: stats?.ready_orders ?? 0, sub: `${stats?.ready_units ?? 0} pcs`, label: 'Ready to send', warn: (stats?.ready_orders ?? 0) > 0, view: 'ready' },
    { icon: '🗓️', value: stats?.week_orders ?? 0, sub: `${stats?.week_units ?? 0} pcs`, label: `Sent this week · ${stats?.month_orders ?? 0} orders this month`, view: 'batches' },
    { icon: '🚚', value: stats?.awaiting_units ?? 0, sub: 'pcs', label: stats?.overdue_units ? `Awaiting delivery · ${stats.overdue_units} over ${stats.overdue_days} days` : 'Awaiting delivery', warn: (stats?.overdue_units ?? 0) > 0, view: 'batches' },
    { icon: '✅', value: stats?.received_units ?? 0, sub: `of ${stats?.total_units ?? 0} sent`, label: stats?.short_lines ? `Received · ${stats.short_lines} line${stats.short_lines === 1 ? '' : 's'} short` : 'Received at warehouse', warn: (stats?.short_lines ?? 0) > 0, view: 'batches' },
    { icon: '⚠️', value: stats?.attention ?? 0, label: 'Changed after sending', warn: (stats?.attention ?? 0) > 0, view: 'attention' },
  ]

  const TABS = [
    { key: 'ready', label: 'Ready to send', count: stats?.ready_lines },
    { key: 'batches', label: 'Batches' },
    { key: 'attention', label: 'Needs attention', badge: stats?.attention },
    { key: 'products', label: 'Products' },
  ]

  return (
    <div>
      <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
        {kpis.map(k => (
          <div key={k.label} className={`kpi-card kpi-clickable ${view === k.view ? 'kpi-active' : ''}`} onClick={() => setView(k.view)}>
            <div className="kpi-head"><div className="kpi-icon">{k.icon}</div></div>
            <div className="kpi-value" style={k.warn ? { color: 'var(--warning)' } : undefined}>
              {k.value}{k.sub && <span className="kpi-sub">{k.sub}</span>}
            </div>
            <div className="kpi-label">{k.label}</div>
          </div>
        ))}
      </div>

      <div className="scan-tabs" style={{ marginBottom: 16 }}>
        {TABS.map(t => (
          <button key={t.key} className={view === t.key ? 'active' : ''} onClick={() => setView(t.key)}>
            {t.label}
            {t.count > 0 && <span className="tab-count">{t.count}</span>}
            {t.badge > 0 && <span className="tab-badge">{t.badge}</span>}
          </button>
        ))}
      </div>

      {view === 'ready' && <ReadyView onSent={(b) => { loadStats(); setOpenBatch(b) }} goProducts={() => setView('products')} />}
      {view === 'batches' && <BatchesView onOpen={setOpenBatch} refreshKey={stats} />}
      {view === 'attention' && <AttentionView onChange={loadStats} onOpenBatch={setOpenBatch} />}
      {view === 'products' && <ProductsView onChange={loadStats} />}

      {openBatch && <BatchDrawer id={openBatch.id} onClose={() => setOpenBatch(null)} onChange={loadStats} />}
    </div>
  )
}

/* ------------------------------------------ ready ------------------------------------------ */

function ReadyView({ onSent, goProducts }) {
  const apiFetch = useApi()
  const toast = useToast()
  const download = useDownload()
  const [lines, setLines] = useState([])
  const [mapped, setMapped] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [design, setDesign] = useState('')
  const [size, setSize] = useState('')
  const [search, setSearch] = useState('')
  const [picked, setPicked] = useState(new Set())

  const load = async () => {
    setLoading(true)
    const q = new URLSearchParams({ ...(from && to && { from, to }) }).toString()
    const r = await apiFetch(`/api/myxture/ready${q ? `?${q}` : ''}`)
    if (r && !r.error) { setLines(r.lines); setMapped(r.mapped) }
    else toast.error(r?.error || 'Could not load the orders')
    setLoading(false)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [from, to])

  const designs = useMemo(() => [...new Set(lines.map(l => l.design_file))].sort(), [lines])
  const sizes = useMemo(() => [...new Set(lines.map(l => l.size).filter(Boolean))].sort((a, b) => sizeRank(a) - sizeRank(b)), [lines])

  const shown = useMemo(() => {
    const s = search.trim().replace(/^#/, '').toLowerCase()
    return lines.filter(l => (!design || l.design_file === design) && (!size || l.size === size)
      && (!s || String(l.order_number).toLowerCase().includes(s)))
  }, [lines, design, size, search])

  // Only what is on screen is ever sent: a line picked and then filtered away stays behind.
  const chosen = shown.filter(l => picked.has(keyOf(l)))
  const units = chosen.reduce((n, l) => n + l.qty, 0)
  const orders = new Set(chosen.map(l => l.order_shopify_id)).size
  const allPicked = shown.length > 0 && chosen.length === shown.length

  const toggle = (k) => setPicked(p => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n })
  const toggleAll = () => setPicked(allPicked ? new Set() : new Set(shown.map(keyOf)))

  const send = async (ext) => {
    if (!chosen.length) return
    if (!await toast.confirm({
      title: `Send ${orders} order${orders === 1 ? '' : 's'} to Myxture?`,
      message: `${chosen.length} lines, ${units} pieces go into a new batch and are marked as sent, so nobody can send them again. The ${ext === 'xlsx' ? 'Excel' : 'CSV'} file downloads now — upload it to the Myxture portal. If you end up not uploading it, void the batch to put the lines back.`,
      confirmLabel: 'Create batch and download', cancelLabel: 'Cancel',
    })) return
    setBusy(ext)
    const r = await apiFetch('/api/myxture/batches', { method: 'POST', body: JSON.stringify({ lines: chosen.map(l => ({ order_shopify_id: l.order_shopify_id, line_key: l.line_key })) }) })
    if (!r || r.error) { setBusy(''); toast.error(r?.error || 'Could not create the batch'); load(); return }
    const batch = { id: r.batch.id, ref: r.ref }
    await download(batch, ext)
    setBusy('')
    toast.success(`${r.ref} created — ${r.lines} lines, ${r.units} pcs${r.skipped ? ` (${r.skipped} already sent by someone else, left out)` : ''}`)
    setPicked(new Set())
    load()
    onSent(batch)
  }

  if (mapped === 0) {
    return (
      <div className="data-table-wrapper">
        <div className="empty-state">
          <div className="empty-icon">🧵</div>
          <h3>No Myxture products yet</h3>
          <p>Say which Shopify products Myxture makes, and their orders will show up here.</p>
          <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={goProducts}>Add a product</button>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="filters-row">
        <div className="search-bar">
          <span className="search-icon">🔍</span>
          <input type="search" placeholder="Search order number…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <select value={design} onChange={e => setDesign(e.target.value)}>
          <option value="">All designs</option>
          {designs.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <select value={size} onChange={e => setSize(e.target.value)}>
          <option value="">All sizes</option>
          {sizes.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <DateRangeFilter startDate={from} endDate={to}
          onApply={(s, e) => { setFrom(s); setTo(e) }} onClear={() => { setFrom(''); setTo('') }} />
      </div>

      <div className="data-table-wrapper">
        {loading ? <div className="loader"><div className="spinner"></div></div>
          : shown.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">✅</div>
              <h3>Nothing waiting</h3>
              <p>{lines.length ? 'No line matches these filters.' : 'Every Myxture order has been sent.'}</p>
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 36 }}><input type="checkbox" checked={allPicked} onChange={toggleAll} aria-label="Select all" /></th>
                  <th>Order</th><th>Date</th><th>Payment</th><th>Product</th><th>Size</th><th>Qty</th><th>Design file</th>
                </tr>
              </thead>
              <tbody>
                {shown.map(l => {
                  const k = keyOf(l)
                  return (
                    <tr key={k} onClick={() => toggle(k)} style={{ cursor: 'pointer' }}>
                      <td onClick={e => e.stopPropagation()}><input type="checkbox" checked={picked.has(k)} onChange={() => toggle(k)} /></td>
                      <td data-label="Order" style={{ fontWeight: 600, color: 'var(--primary-light)' }}>{l.order_number}</td>
                      <td data-label="Date" style={{ color: 'var(--text-secondary)' }}>{fmtDate(l.order_date)}</td>
                      <td data-label="Payment"><span className={`status-badge ${l.payment === 'Prepaid' ? 'fulfilled' : 'pending'}`}>{l.payment}</span></td>
                      <td data-label="Product" className="cell-primary">
                        <div style={{ fontWeight: 500 }}>{l.title}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{l.product_type}{l.fabric ? ` · ${l.fabric}` : ''}</div>
                      </td>
                      <td data-label="Size" style={{ fontWeight: 600 }}>{l.size || '—'}</td>
                      <td data-label="Qty">
                        {l.qty}
                        {l.already_sent > 0 && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{l.already_sent} sent before</div>}
                      </td>
                      <td data-label="Design file">{l.design_file}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
      </div>

      {chosen.length > 0 && (
        <div className="bulk-bar">
          <div>
            <strong>{orders} order{orders === 1 ? '' : 's'} · {chosen.length} lines · {units} pcs</strong>
            <div className="bulk-hint">Downloading creates a batch and marks these as sent to Myxture.</div>
          </div>
          <div className="bulk-modes">
            <button className="btn btn-secondary btn-sm" onClick={() => setPicked(new Set())}>Clear</button>
            <button className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => send('csv')}>
              {busy === 'csv' ? 'Creating…' : 'Download CSV'}
            </button>
            <button className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => send('xlsx')}>
              <Icon name="download" size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
              {busy === 'xlsx' ? 'Creating…' : 'Download Excel'}
            </button>
          </div>
        </div>
      )}
    </>
  )
}

/* ----------------------------------------- batches ----------------------------------------- */

function BatchesView({ onOpen, refreshKey }) {
  const apiFetch = useApi()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [now] = useState(() => Date.now())

  const load = async () => {
    const r = await apiFetch('/api/myxture/batches?limit=200')
    if (r && !r.error) setRows(r.batches)
    setLoading(false)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [refreshKey])

  return (
    <div className="data-table-wrapper">
      {loading ? <div className="loader"><div className="spinner"></div></div>
        : rows.length === 0 ? (
          <div className="empty-state"><div className="empty-icon">📦</div><h3>No batches yet</h3><p>Batches appear here once orders are sent to Myxture.</p></div>
        ) : (
          <table className="data-table">
            <thead>
              <tr><th>Batch</th><th>Sent</th><th>By</th><th>Orders</th><th>Pieces</th><th>Received</th><th>Status</th></tr>
            </thead>
            <tbody>
              {rows.map(b => {
                const age = (now - new Date(b.created_at).getTime()) / 86400000
                const late = (b.status === 'Sent' || b.status === 'Partly received') && age > 3
                return (
                  <tr key={b.id} onClick={() => onOpen(b)} style={{ cursor: 'pointer', opacity: b.voided_at ? 0.55 : 1 }}>
                    <td data-label="Batch" style={{ fontWeight: 600, color: 'var(--primary-light)' }}>
                      {b.ref}{b.source === 'import' && <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 6 }}>imported</span>}
                    </td>
                    <td data-label="Sent">{fmtDateTime(b.created_at)}</td>
                    <td data-label="By" style={{ color: 'var(--text-secondary)' }}>{b.created_by || '—'}</td>
                    <td data-label="Orders">{b.orders}</td>
                    <td data-label="Pieces">{b.units}</td>
                    <td data-label="Received">
                      {b.received_units}/{b.units}
                      {b.short_lines > 0 && <div style={{ fontSize: 11, color: 'var(--warning)' }}>{b.short_lines} short</div>}
                    </td>
                    <td data-label="Status">
                      <span className={`status-badge ${STATUS_CLASS[b.status] || ''}`}>{b.status}</span>
                      {late && <div style={{ fontSize: 11, color: 'var(--warning)', marginTop: 3 }}>{Math.floor(age)} days</div>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
    </div>
  )
}

function BatchDrawer({ id, onClose, onChange }) {
  const apiFetch = useApi()
  const toast = useToast()
  const download = useDownload()
  const [b, setB] = useState(null)
  const [edits, setEdits] = useState({})
  const [busy, setBusy] = useState(false)

  const load = async () => {
    const r = await apiFetch(`/api/myxture/batches/${id}`)
    if (r && !r.error) { setB(r); setEdits({}) } else toast.error(r?.error || 'Could not load the batch')
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [id])

  const setEdit = (lineId, patch) => setEdits(e => ({ ...e, [lineId]: { ...(e[lineId] || {}), ...patch } }))
  const valOf = (l, k) => edits[l.id]?.[k] !== undefined ? edits[l.id][k] : l[k]
  const dirty = Object.keys(edits).length > 0
  const voided = !!b?.voided_at

  const save = async (entries) => {
    setBusy(true)
    const r = await apiFetch(`/api/myxture/batches/${id}/receive`, { method: 'POST', body: JSON.stringify({ lines: entries }) })
    setBusy(false)
    if (!r || r.error) { toast.error(r?.error || 'Could not save'); return }
    setB(r); setEdits({}); onChange()
    toast.success('Saved')
  }

  const saveEdits = () => save(Object.entries(edits).map(([lineId, e]) => {
    const l = b.lines.find(x => String(x.id) === lineId)
    // A note on its own doesn't count as receiving the line.
    const qty = e.received_qty !== undefined ? e.received_qty : (l.received_at ? l.received_qty : null)
    return { id: Number(lineId), received_qty: qty === '' ? null : qty, qc_note: e.qc_note !== undefined ? e.qc_note : l.qc_note }
  }))

  // Everything not yet ticked, in full — the common case of a parcel that arrived complete.
  const receiveAll = () => save(b.lines.filter(l => !l.received_at).map(l => ({ id: l.id, received_qty: l.qty, qc_note: l.qc_note })))

  const undo = (l) => save([{ id: l.id, received_qty: null, qc_note: l.qc_note }])

  const voidIt = async () => {
    if (!await toast.confirm({
      title: `Void ${b.ref}?`,
      message: 'Only if this file was never uploaded to the Myxture portal. Its lines go back to Ready to send.',
      confirmLabel: 'Void batch', cancelLabel: 'Keep it', danger: true,
    })) return
    const r = await apiFetch(`/api/myxture/batches/${id}/void`, { method: 'POST' })
    if (!r || r.error) { toast.error(r?.error || 'Could not void it'); return }
    toast.success(`${b.ref} voided`); onChange(); load()
  }

  const totals = b ? {
    sent: b.lines.reduce((n, l) => n + l.qty, 0),
    got: b.lines.reduce((n, l) => n + (l.received_qty || 0), 0),
    open: b.lines.filter(l => !l.received_at).length,
  } : null

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer drawer-wide" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="drawer-header">
          <div>
            <h2 style={{ fontSize: 18 }}>{b?.ref || 'Batch'} {b && <span className={`status-badge ${STATUS_CLASS[b.status] || ''}`} style={{ marginLeft: 8 }}>{b.status}</span>}</h2>
            {b && <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 4 }}>
              Sent {fmtDateTime(b.created_at)}{b.created_by ? ` by ${b.created_by}` : ''} · {totals.got}/{totals.sent} pcs received
              {voided && ` · voided ${fmtDateTime(b.voided_at)}${b.voided_by ? ` by ${b.voided_by}` : ''}`}
            </div>}
          </div>
          <button type="button" className="btn-icon" onClick={onClose}><Icon name="close" size={16} /></button>
        </div>

        <div className="drawer-body">
          {!b ? <div className="loader"><div className="spinner"></div></div> : (
            <>
              {b.note && <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{b.note}</div>}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-secondary btn-sm" onClick={() => download(b, 'xlsx')}><Icon name="download" size={14} /> Excel</button>
                <button className="btn btn-secondary btn-sm" onClick={() => download(b, 'csv')}><Icon name="download" size={14} /> CSV</button>
                {!voided && totals.open > 0 && (
                  <button className="btn btn-primary btn-sm" disabled={busy || dirty} onClick={receiveAll}
                    title={dirty ? 'Save your changes first' : ''}>
                    Mark all {totals.open} remaining as received
                  </button>
                )}
              </div>

              <div className="data-table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr><th>Order</th><th>Product</th><th>Size</th><th>Sent</th><th>Received</th><th>QC note</th><th></th></tr>
                  </thead>
                  <tbody>
                    {b.lines.map(l => {
                      const rq = valOf(l, 'received_qty')
                      const short = l.received_at && l.received_qty < l.qty
                      const gone = l.cancelled_at || /^(REFUNDED|VOIDED)$/i.test(l.financial_status || '')
                      return (
                        <tr key={l.id}>
                          <td data-label="Order" style={{ fontWeight: 600 }}>
                            {l.order_number}
                            {gone && <div style={{ fontSize: 11, color: 'var(--danger)' }}>cancelled</div>}
                          </td>
                          <td data-label="Product" className="cell-primary">
                            <div style={{ fontWeight: 500 }}>{l.design_file}</div>
                            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{l.title}{l.variant ? ` (${l.variant})` : ''}</div>
                          </td>
                          <td data-label="Size" style={{ fontWeight: 600 }}>{l.size}</td>
                          <td data-label="Sent">{l.qty}</td>
                          <td data-label="Received">
                            <input className="inv-input" type="number" min="0" style={{ width: 70 }} disabled={voided}
                              value={rq ?? ''} placeholder="—"
                              onChange={e => setEdit(l.id, { received_qty: e.target.value === '' ? '' : Math.max(0, parseInt(e.target.value, 10) || 0) })} />
                            {short && !edits[l.id] && <div style={{ fontSize: 11, color: 'var(--warning)' }}>{l.qty - l.received_qty} short</div>}
                            {l.received_at && !edits[l.id] && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmtDate(l.received_at)}{l.received_by ? ` · ${l.received_by}` : ''}</div>}
                          </td>
                          <td data-label="QC note">
                            <input className="inv-input" style={{ width: '100%', minWidth: 140 }} disabled={voided}
                              value={valOf(l, 'qc_note') || ''} placeholder="Print, stitching, size…"
                              onChange={e => setEdit(l.id, { qc_note: e.target.value })} />
                          </td>
                          <td>
                            {l.received_at && !voided && !edits[l.id] && (
                              <button className="mini-btn" disabled={busy} onClick={() => undo(l)} title="Not received after all">Undo</button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        <div className="drawer-footer">
          {b && !voided && b.status === 'Sent' && (
            <button type="button" className="btn btn-secondary" style={{ flex: '0 0 auto', color: 'var(--danger)' }} onClick={voidIt}>Void batch</button>
          )}
          <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>
          {dirty && <button type="button" className="btn btn-primary" disabled={busy} onClick={saveEdits}>{busy ? 'Saving…' : 'Save QC'}</button>}
        </div>
      </div>
    </div>
  )
}

/* ---------------------------------------- attention ---------------------------------------- */

function AttentionView({ onChange, onOpenBatch }) {
  const apiFetch = useApi()
  const toast = useToast()
  const [rows, setRows] = useState(null)

  const load = async () => {
    const r = await apiFetch('/api/myxture/attention')
    setRows(r && !r.error ? r.lines : [])
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [])

  const clear = async (l) => {
    const r = await apiFetch(`/api/myxture/attention/${l.id}/clear`, { method: 'POST' })
    if (!r || r.error) { toast.error(r?.error || 'Could not clear it'); return }
    load(); onChange()
  }

  return (
    <>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 12 }}>
        Orders that were cancelled or cut down after they went to Myxture. Cancel them on the portal (or keep the piece for stock), then mark them done.
      </p>
      <div className="data-table-wrapper">
        {rows === null ? <div className="loader"><div className="spinner"></div></div>
          : rows.length === 0 ? (
            <div className="empty-state"><div className="empty-icon">👌</div><h3>Nothing changed</h3><p>No sent order has been cancelled or edited since.</p></div>
          ) : (
            <table className="data-table">
              <thead><tr><th>Order</th><th>Product</th><th>Size</th><th>Qty sent</th><th>Batch</th><th>What changed</th><th></th></tr></thead>
              <tbody>
                {rows.map(l => (
                  <tr key={l.id}>
                    <td data-label="Order" style={{ fontWeight: 600 }}>{l.order_number}</td>
                    <td data-label="Product">{l.design_file}</td>
                    <td data-label="Size">{l.size}</td>
                    <td data-label="Qty sent">{l.qty}</td>
                    <td data-label="Batch"><button className="mini-btn" onClick={() => onOpenBatch({ id: l.batch_id })}>{l.ref}</button></td>
                    <td data-label="What changed" style={{ color: 'var(--danger)', fontWeight: 500 }}>{l.reason}</td>
                    <td><button className="btn btn-secondary btn-sm" onClick={() => clear(l)}>Done</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </>
  )
}

/* ----------------------------------------- products ----------------------------------------- */

const blankProduct = () => ({ shopify_product_id: '', title: '', product_type: 'Oversized Jersey V-Neck', fabric: 'Heavy SpunPoly', design_file: '', active: true, isNew: true })

function ProductsView({ onChange }) {
  const apiFetch = useApi()
  const [rows, setRows] = useState(null)
  const [edit, setEdit] = useState(null)

  const load = async () => {
    const r = await apiFetch('/api/myxture/products')
    setRows(r && !r.error ? r.products : [])
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [])

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: 0 }}>
          The Shopify products Myxture makes, and what goes in their sheet for each. Only these products appear in Ready to send, and they are left out of the print pick list.
        </p>
        <button className="btn btn-primary" onClick={() => setEdit(blankProduct())}><Icon name="plus" size={15} /> Add product</button>
      </div>
      <div className="data-table-wrapper">
        {rows === null ? <div className="loader"><div className="spinner"></div></div>
          : rows.length === 0 ? (
            <div className="empty-state"><div className="empty-icon">🧵</div><h3>No products yet</h3><p>Add the first product Myxture makes.</p></div>
          ) : (
            <table className="data-table">
              <thead><tr><th>Shopify product</th><th>Product type</th><th>Variant 1</th><th>Design file</th><th>Status</th></tr></thead>
              <tbody>
                {rows.map(p => (
                  <tr key={p.shopify_product_id} onClick={() => setEdit({ ...p })} style={{ cursor: 'pointer', opacity: p.active ? 1 : 0.55 }}>
                    <td data-label="Shopify product" className="cell-primary">
                      <div style={{ fontWeight: 500 }}>{p.title || p.shop_title || p.shopify_product_id}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{p.shopify_product_id}</div>
                    </td>
                    <td data-label="Product type">{p.product_type}</td>
                    <td data-label="Variant 1">{p.fabric || '—'}</td>
                    <td data-label="Design file">{p.design_file}</td>
                    <td data-label="Status"><span className={`status-badge ${p.active ? 'fulfilled' : 'refunded'}`}>{p.active ? 'Active' : 'Paused'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
      {edit && <ProductDrawer value={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); onChange() }} />}
    </>
  )
}

function ProductDrawer({ value, onClose, onSaved }) {
  const apiFetch = useApi()
  const toast = useToast()
  const [f, setF] = useState(value)
  const [q, setQ] = useState('')
  const [options, setOptions] = useState([])
  const [busy, setBusy] = useState(false)
  const set = (patch) => setF(x => ({ ...x, ...patch }))

  useEffect(() => {
    if (!f.isNew) return
    const t = setTimeout(async () => {
      const r = await apiFetch(`/api/myxture/shop-products?q=${encodeURIComponent(q)}`)
      if (r && !r.error) setOptions(r.products)
    }, 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, f.isNew])

  const save = async (e) => {
    e.preventDefault()
    if (!f.shopify_product_id) { toast.error('Pick the Shopify product'); return }
    setBusy(true)
    const r = await apiFetch(`/api/myxture/products/${f.shopify_product_id}`, {
      method: 'PUT',
      body: JSON.stringify({ title: f.title, product_type: f.product_type, fabric: f.fabric, design_file: f.design_file, active: f.active }),
    })
    setBusy(false)
    if (!r || r.error) { toast.error(r?.error || 'Could not save'); return }
    toast.success('Saved'); onSaved()
  }

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="drawer-header">
          <h2 style={{ fontSize: 18 }}>{f.isNew ? 'Add Myxture product' : (f.title || 'Myxture product')}</h2>
          <button type="button" className="btn-icon" onClick={onClose}><Icon name="close" size={16} /></button>
        </div>
        <form id="myxture-product-form" className="drawer-body" onSubmit={save}>
          {f.isNew ? (
            <div className="input-group">
              <label>Shopify product</label>
              <input className="input" placeholder="Search products…" value={q} onChange={e => setQ(e.target.value)} />
              <select size={6} value={f.shopify_product_id} style={{ marginTop: 8, width: '100%' }}
                onChange={e => { const p = options.find(o => String(o.shopify_id) === e.target.value); set({ shopify_product_id: e.target.value, title: p?.title || '' }) }}>
                {options.map(o => <option key={o.shopify_id} value={o.shopify_id}>{o.title}</option>)}
              </select>
            </div>
          ) : (
            <div className="input-group">
              <label>Shopify product</label>
              <input className="input" value={`${f.title || f.shop_title || ''} (${f.shopify_product_id})`} disabled />
            </div>
          )}
          <div className="form-row">
            <div className="input-group">
              <label>Product type</label>
              <input className="input" value={f.product_type} onChange={e => set({ product_type: e.target.value })} required />
            </div>
            <div className="input-group">
              <label>Variant 1 (fabric)</label>
              <input className="input" value={f.fabric || ''} onChange={e => set({ fabric: e.target.value })} />
            </div>
          </div>
          <div className="input-group">
            <label>Design file</label>
            <input className="input" value={f.design_file} placeholder="GTA-6-{color}" onChange={e => set({ design_file: e.target.value })} required />
            <small style={{ color: 'var(--text-muted)', fontSize: 12 }}>
              Exactly as it is named on the Myxture portal. Write {'{color}'} where the variant's colour goes, for a product sold in more than one colour — GTA-6-{'{color}'} becomes GTA-6-Beige or GTA-6-Black.
            </small>
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5 }}>
            <input type="checkbox" checked={f.active !== false} onChange={e => set({ active: e.target.checked })} />
            Active — new orders for it go to Myxture
          </label>
        </form>
        <div className="drawer-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" form="myxture-product-form" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  )
}
