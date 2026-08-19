import { useState, useEffect } from 'react'
import { useApi, useAuth } from '../App'
import { useToast } from '../components/Toast'
import Icon from '../components/Icon'

const num = (v) => new Intl.NumberFormat('en-IN').format(Number(v) || 0)
const todayStr = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** How a cell reads at a glance: out, below its reorder level, or fine. */
function cellTone(item) {
  if (!item) return 'empty'
  if (item.qty < 0) return 'negative'
  if (item.qty === 0) return 'out'
  if (item.reorder_level > 0 && item.qty <= item.reorder_level) return 'low'
  return 'ok'
}

export default function Inventory() {
  const apiFetch = useApi()
  const toast = useToast()
  const { user } = useAuth()
  const canEdit = ['owner', 'admin'].includes(user?.role) || !!user?.can_edit_inventory

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(null)
  const [edit, setEdit] = useState(null)   // { blank_type, color, size, item } being counted
  const [qty, setQty] = useState('')
  const [mode, setMode] = useState('set')
  const [ledger, setLedger] = useState(null)
  const [since, setSince] = useState(todayStr())
  // Bulk mode holds a draft of the whole grid: `${blank}|${color}|${size}` → typed string. Only
  // cells that actually differ are sent, so an untouched grid saves nothing.
  const [bulk, setBulk] = useState(null)     // null = off, else { mode, draft }

  const load = async () => {
    const r = await apiFetch('/api/inventory')
    if (r && !r.error) setData(r)
    else if (r?.error) toast.error(r.error)
    setLoading(false)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [])

  if (loading) return <div className="loader"><div className="spinner" /><span>Loading inventory…</span></div>
  if (!data) return <div className="empty-state"><p>Inventory could not be loaded.</p></div>

  const items = data.items || []
  const byKey = new Map(items.map(i => [`${i.blank_type}|${i.color}|${i.size}`, i]))
  // The grid is drawn from the catalogue plus anything already counted, so it stays the shape of
  // what is actually sold — no full cross-product of colours that don't exist, and a cell to
  // count into even before a blank has any stock.
  const cells = [...(data.catalog || []), ...items.map(i => ({ blank_type: i.blank_type, color: i.color, size: i.size }))]
  const types = [...new Set(cells.map(c => c.blank_type))].sort()
  const sizesFor = (t) => (data.sizes || []).filter(s => cells.some(c => c.blank_type === t && c.size === s))
  const colorsFor = (t) => [...new Set(cells.filter(c => c.blank_type === t).map(c => c.color))].sort()

  const openCell = (blank_type, color, size) => {
    if (!canEdit) return
    const item = byKey.get(`${blank_type}|${color}|${size}`)
    setEdit({ blank_type, color, size, item })
    setQty(item ? String(item.qty) : '0')
    setMode('set')
  }

  const saveCount = async () => {
    const n = Number(qty)
    if (!Number.isFinite(n)) { toast.error('Enter a number'); return }
    setBusy('save')
    const res = await apiFetch('/api/inventory/stock', {
      method: 'POST',
      body: JSON.stringify({ ...edit, item: undefined, qty: n, mode, note: mode === 'set' ? 'Stock count' : 'Stock received' }),
    })
    setBusy(null)
    if (!res || res.error) { toast.error(res?.error || 'Failed to update stock'); return }
    toast.success(`${edit.blank_type} ${edit.color} ${edit.size} → ${res.item.qty}`)
    setEdit(null); load()
  }

  const run = async (label, path, body) => {
    setBusy(label)
    const res = await apiFetch(path, { method: 'POST', body: JSON.stringify(body || {}) })
    setBusy(null)
    if (!res || res.error) { toast.error(res?.error || 'Failed'); return null }
    return res
  }

  const syncCatalog = async () => {
    const r = await run('catalog', '/api/inventory/sync-catalog')
    if (r) { toast.success(`${r.products} products re-read from Shopify`); await load() }
  }

  const processOrders = async () => {
    if (!await toast.confirm({
      title: 'Deduct stock from orders?',
      message: 'Every order placed since the date below is applied to stock. Safe to run more than once — an order already counted is corrected, never deducted twice.',
      details: [{ label: 'From', value: since }],
      confirmLabel: 'Process orders',
    })) return
    const r = await run('process', '/api/inventory/process', { since })
    if (r) { toast.success(`${num(r.orders)} orders processed, ${num(r.changed)} movements`); load() }
  }

  const startBulk = (mode) => {
    const draft = {}
    for (const c of cells) {
      const k = `${c.blank_type}|${c.color}|${c.size}`
      if (draft[k] === undefined) draft[k] = mode === 'set' ? String(byKey.get(k)?.qty ?? 0) : ''
    }
    setBulk({ mode, draft })
  }
  const setDraft = (k, v) => setBulk(b => ({ ...b, draft: { ...b.draft, [k]: v } }))

  /** Cells whose typed value would actually move stock. */
  const bulkChanges = () => {
    if (!bulk) return []
    return Object.entries(bulk.draft).flatMap(([k, raw]) => {
      const v = String(raw).trim()
      if (v === '') return []
      const n = Number(v)
      if (!Number.isFinite(n)) return []
      const [blank_type, color, size] = k.split('|')
      if (bulk.mode === 'set' && n === (byKey.get(k)?.qty ?? 0)) return []
      if (bulk.mode === 'add' && n === 0) return []
      return [{ blank_type, color, size, qty: n }]
    })
  }

  const saveBulk = async () => {
    const entries = bulkChanges()
    if (!entries.length) { toast.info('Nothing changed'); return }
    if (!await toast.confirm({
      title: bulk.mode === 'set' ? `Set the count on ${entries.length} blank${entries.length > 1 ? 's' : ''}?` : `Add stock to ${entries.length} blank${entries.length > 1 ? 's' : ''}?`,
      message: bulk.mode === 'set'
        ? 'Each of these is set to the number you typed, whatever it reads now. The difference is recorded as a correction, so the ledger still explains it.'
        : 'The number you typed is added to what each blank already holds.',
      details: entries.slice(0, 6).map(e => ({ label: `${e.blank_type} ${e.color} ${e.size}`, value: bulk.mode === 'set' ? String(e.qty) : `+${e.qty}` }))
        .concat(entries.length > 6 ? [{ label: '…and more', value: `${entries.length - 6} others` }] : []),
      confirmLabel: 'Save counts',
    })) return
    setBusy('bulk')
    const res = await apiFetch('/api/inventory/stock/bulk', { method: 'POST', body: JSON.stringify({ mode: bulk.mode, entries }) })
    setBusy(null)
    if (!res || res.error) { toast.error(res?.error || 'Failed to save'); return }
    toast.success(`${res.changed} blank${res.changed === 1 ? '' : 's'} updated`)
    setBulk(null); load()
  }

  const openLedger = async (item) => {
    const r = await apiFetch(`/api/inventory/movements?item_id=${item.id}`)
    if (r && !r.error) setLedger({ item, movements: r.movements })
  }

  const s = data.summary || {}

  return (
    <div className="page-enter">
      <div className="dash-toolbar">
        <div>
          <h1>Inventory</h1>
          <p style={{ color: 'var(--text-muted)' }}>
            Plain blanks by colour and size. Every design printed on the same blank draws from one pool.
          </p>
        </div>
        {canEdit && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <input type="date" value={since} onChange={e => setSince(e.target.value)} style={{ width: 'auto' }} />
            <button className="btn" onClick={processOrders} disabled={!!busy}>
              {busy === 'process' ? 'Processing…' : 'Deduct from orders'}
            </button>
            <button className="btn btn-secondary" onClick={syncCatalog} disabled={!!busy}>
              {busy === 'catalog' ? 'Reading…' : 'Refresh catalog'}
            </button>
            {!bulk
              ? <button className="btn btn-primary" onClick={() => startBulk('set')} disabled={!!busy}>Bulk edit</button>
              : <button className="btn btn-secondary" onClick={() => setBulk(null)} disabled={busy === 'bulk'}>Exit bulk edit</button>}
          </div>
        )}
      </div>

      <div className="kpi-grid" style={{ marginBottom: 18 }}>
        {[
          { icon: 'box', label: 'Blanks in stock', value: num(s.units) },
          { icon: 'shirt', label: 'Tracked SKUs', value: num(s.skus) },
          { icon: 'alert', label: 'At or below reorder level', value: num(s.low) },
          { icon: 'trending', label: 'Negative counts', value: num(s.negative) },
        ].map(k => (
          <div className="kpi-card" key={k.label}>
            <div className="kpi-head"><div className="kpi-icon"><Icon name={k.icon} size={20} /></div></div>
            <div className="kpi-value">{k.value}</div>
            <div className="kpi-label">{k.label}</div>
          </div>
        ))}
      </div>

      {/* A negative count means more was sold than the recorded stock — almost always an opening
          count that has not been entered yet, and worth saying so rather than showing a bare
          minus figure. */}
      {s.negative > 0 && (
        <div className="calc-warning" style={{ marginBottom: 18 }}>
          {s.negative} blank{s.negative > 1 ? 's have' : ' has'} gone negative — more has been sold than the
          stock recorded for it. Enter the counted quantity for those cells to set the true figure.
        </div>
      )}

      {!types.length && (
        <div className="empty-state">
          <div className="empty-icon">📦</div>
          <p>No blanks known yet. {canEdit ? 'Hit "Refresh catalog" to read the product range from Shopify, then enter your counted stock.' : 'Ask an admin to refresh the catalog.'}</p>
        </div>
      )}

      {types.map(type => {
        const sizes = sizesFor(type), colors = colorsFor(type)
        if (!colors.length) return null
        return (
          <div className="card" style={{ marginBottom: 18 }} key={type}>
            <h2 style={{ fontSize: 16, marginBottom: 10 }}>{type}</h2>
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table inventory-grid">
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left' }}>Colour</th>
                    {sizes.map(sz => <th key={sz} style={{ textAlign: 'center' }}>{sz}</th>)}
                    <th style={{ textAlign: 'right' }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {colors.map(color => {
                    const row = sizes.map(sz => byKey.get(`${type}|${color}|${sz}`))
                    return (
                      <tr key={color}>
                        <td className="cell-primary">{color}</td>
                        {sizes.map((sz, i) => {
                          const item = row[i]
                          const k = `${type}|${color}|${sz}`
                          if (bulk) {
                            const raw = bulk.draft[k] ?? ''
                            const n = Number(String(raw).trim())
                            const dirty = String(raw).trim() !== '' && Number.isFinite(n)
                              && (bulk.mode === 'set' ? n !== (item?.qty ?? 0) : n !== 0)
                            return (
                              <td key={sz} style={{ textAlign: 'center' }}>
                                <input className={`inv-input ${dirty ? 'inv-input-dirty' : ''}`} type="number" value={raw}
                                  placeholder={bulk.mode === 'add' ? '+0' : '0'}
                                  onChange={e => setDraft(k, e.target.value)}
                                  title={item ? `${item.qty} in stock now` : 'Not counted yet'} />
                              </td>
                            )
                          }
                          return (
                            <td key={sz} style={{ textAlign: 'center' }}>
                              <button type="button" className={`inv-cell inv-${cellTone(item)}`}
                                onClick={() => (canEdit ? openCell(type, color, sz) : item && openLedger(item))}
                                title={item ? `${item.qty} in stock · ${item.sold_30d} sold in 30 days` : 'Not counted yet'}>
                                {item ? item.qty : '–'}
                              </button>
                            </td>
                          )
                        })}
                        <td style={{ textAlign: 'right', fontWeight: 700 }}>
                          {num(row.reduce((a, i) => a + (i?.qty || 0), 0))}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}

      {!!(data.review || []).length && (
        <div className="card" style={{ marginBottom: 18 }}>
          <h2 style={{ fontSize: 15, marginBottom: 6 }}>Needs a decision</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 12.5, marginBottom: 10 }}>
            Refunded after dispatch, so the blank was already printed and stock was left deducted.
          </p>
          {data.review.map(r => (
            <div className="review-row" key={r.id}>
              <span><b>#{r.order_number}</b> · {r.blank_type} {r.color} {r.size} · {r.note}</span>
              {canEdit && (
                <button className="mini-btn" onClick={async () => {
                  const res = await apiFetch(`/api/inventory/review/${r.id}/clear`, { method: 'POST' })
                  if (res?.success) { toast.success('Flag cleared'); load() }
                }}>Acknowledge</button>
              )}
            </div>
          ))}
        </div>
      )}

      {!!(data.unmapped || []).length && (
        <div className="card">
          <h2 style={{ fontSize: 15, marginBottom: 6 }}>Sold but not linked to a blank</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 12.5, marginBottom: 10 }}>
            These sold without drawing stock. Usually a product with no type set in Shopify — fix it there and hit Refresh catalog.
          </p>
          {data.unmapped.map((u, i) => (
            <div className="review-row" key={i}>
              <span><b>{u.product_title}</b> · {u.variant || '—'} · {u.qty} sold</span>
              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{u.reason}</span>
            </div>
          ))}
        </div>
      )}

      {bulk && (
        <div className="bulk-bar">
          <div className="bulk-modes">
            <button className={`mini-btn ${bulk.mode === 'set' ? 'mini-btn-active' : ''}`} onClick={() => startBulk('set')}>Counted stock</button>
            <button className={`mini-btn ${bulk.mode === 'add' ? 'mini-btn-active' : ''}`} onClick={() => startBulk('add')}>Received more</button>
            <span className="bulk-hint">
              {bulk.mode === 'set'
                ? 'Type what you counted. Each cell is set to that number, whatever it reads now.'
                : 'Type how many arrived. Leave a cell blank to leave it alone.'}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <b>{bulkChanges().length} changed</b>
            <button className="btn btn-secondary" onClick={() => setBulk(null)} disabled={busy === 'bulk'}>Cancel</button>
            <button className="btn btn-primary" onClick={saveBulk} disabled={busy === 'bulk'}>
              {busy === 'bulk' ? 'Saving…' : 'Save counts'}
            </button>
          </div>
        </div>
      )}

      {edit && (
        <div className="confirm-overlay" onClick={() => setEdit(null)}>
          <div className="confirm-card" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
            <h3 className="confirm-title">{edit.blank_type}</h3>
            <p className="confirm-message">{edit.color} · Size {edit.size}</p>
            <dl className="confirm-details">
              <div className="confirm-detail"><dt>In stock now</dt><dd>{edit.item ? edit.item.qty : 'Not counted'}</dd></div>
              {!!edit.item && <div className="confirm-detail"><dt>Sold in 30 days</dt><dd>{edit.item.sold_30d}</dd></div>}
            </dl>
            <div className="inv-modes">
              <button className={`mini-btn ${mode === 'set' ? 'mini-btn-active' : ''}`} onClick={() => setMode('set')}>Counted stock</button>
              <button className={`mini-btn ${mode === 'add' ? 'mini-btn-active' : ''}`} onClick={() => setMode('add')}>Received more</button>
            </div>
            <div className="input-group" style={{ marginTop: 10 }}>
              <label>{mode === 'set' ? 'Set the count to' : 'Add this many'}</label>
              <input type="number" value={qty} autoFocus onChange={e => setQty(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') saveCount() }} />
            </div>
            <div className="confirm-actions">
              <button className="btn btn-secondary" onClick={() => setEdit(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={busy === 'save'} onClick={saveCount}>
                {busy === 'save' ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {ledger && (
        <div className="confirm-overlay" onClick={() => setLedger(null)}>
          <div className="confirm-card" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
            <h3 className="confirm-title">{ledger.item.blank_type} · {ledger.item.color} {ledger.item.size}</h3>
            <div className="inv-ledger">
              {ledger.movements.length === 0 ? <p className="confirm-message">No movements yet.</p>
                : ledger.movements.map(m => (
                  <div className="review-row" key={m.id}>
                    <span>{m.reason === 'order' ? `#${m.order_number} · ${m.note || ''}` : (m.note || m.reason)}</span>
                    <b style={{ color: m.delta < 0 ? 'var(--danger)' : 'var(--success)' }}>{m.delta > 0 ? '+' : ''}{m.delta}</b>
                  </div>
                ))}
            </div>
            <div className="confirm-actions"><button className="btn btn-secondary" onClick={() => setLedger(null)}>Close</button></div>
          </div>
        </div>
      )}
    </div>
  )
}
