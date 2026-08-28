import { useState, useEffect, useRef } from 'react'
import { useApi, useAuth } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import SearchSelect from '../../components/SearchSelect'
import Pagination from '../../components/Pagination'
import useLocalPager from '../../hooks/useLocalPager'

const num = (v) => new Intl.NumberFormat('en-IN').format(Number(v) || 0)
const day = (v) => (v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—')

const REASONS = ['Undelivered — RTO', 'Refused by customer', 'Address issue', 'Customer return', 'Other']

/**
 * The RTO shelf: printed garments that came back.
 *
 * These are not blanks and never become blanks — a returned "Natty Forever / Black / L" carries a
 * print and can only go out again to another order for that same design and variant. Which is
 * exactly why the shelf is matched against open orders: the whole value of keeping it is catching
 * the moment someone is about to print a second one.
 */
export default function RtoTab({ onCounts }) {
  const apiFetch = useApi()
  const toast = useToast()
  const { user } = useAuth()
  const canEdit = ['owner', 'admin'].includes(user?.role) || !!user?.can_edit_inventory
  const isAdmin = ['owner', 'admin'].includes(user?.role)

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(null)
  const [intake, setIntake] = useState(null)   // { mode, scan, order, items, reason, note, location }
  const [use, setUse] = useState(null)         // { row, order_number, qty }
  const [damage, setDamage] = useState(null)   // { row, qty, stage, reason, note }
  const [products, setProducts] = useState(null)
  const [history, setHistory] = useState(false)
  // The garment whose waiting orders are open in the picker, and the "already shipped" box.
  const [pick, setPick] = useState(null)
  const [notUsed, setNotUsed] = useState('')
  // Tapping a card narrows the shelf to what that number counts — a figure you cannot act on is
  // just decoration, and with a full shelf "3 orders could use one" is unusable without saying which.
  const [focus, setFocus] = useState(null)      // null | 'matched' | 'order:<number>'
  const [query, setQuery] = useState('')
  const scanRef = useRef(null)

  const load = async () => {
    const r = await apiFetch('/api/inventory/rto')
    if (r && !r.error) { setData(r); onCounts?.(r.summary || {}) }
    else if (r?.error) toast.error(r.error)
    setLoading(false)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [])

  // The scan box takes focus the moment the sheet opens — a scanner types into whatever is
  // focused, and a barcode fired at the page body is simply lost.
  useEffect(() => { if (intake?.mode === 'scan') scanRef.current?.focus() }, [intake?.mode])

  const openIntake = (mode) => setIntake({ mode, scan: '', order: null, items: [], reason: REASONS[0], note: '', location: '' })

  const lookup = async (raw) => {
    const code = String(raw || '').trim()
    if (!code) return
    setBusy('lookup')
    const r = await apiFetch(`/api/inventory/rto/order/${encodeURIComponent(code)}`)
    setBusy(null)
    if (!r || r.error) { toast.error(r?.error || 'Order not found'); return }
    // Everything in the parcel came back unless told otherwise — an RTO is normally the whole
    // box, so the work is unticking the odd line rather than ticking every one.
    setIntake(v => ({
      ...v, order: r.order,
      items: r.items.map(it => ({ ...it, take: !it.on_shelf, qty_take: it.qty })),
    }))
  }

  const loadProducts = async () => {
    if (products) return
    const r = await apiFetch('/api/inventory/products')
    if (r && !r.error) setProducts(r.products.filter(p => p.variants.length))
  }
  useEffect(() => { if (intake?.mode === 'manual') loadProducts() }, [intake?.mode]) // eslint-disable-line react-hooks/exhaustive-deps

  const saveIntake = async () => {
    const chosen = (intake.items || []).filter(i => i.take && i.qty_take > 0)
    if (!chosen.length) { toast.error('Nothing selected'); return }
    setBusy('save')
    const res = await apiFetch('/api/inventory/rto', {
      method: 'POST',
      body: JSON.stringify({
        items: chosen.map(i => ({
          shopify_product_id: i.shopify_product_id, variant_id: i.variant_id,
          product_title: i.product_title, variant: i.variant, qty: i.qty_take,
          blank_type: i.blank_type, color: i.color, size: i.size,
          source_ref: i.source_ref || null, source_order_number: intake.order?.order_number || null,
          reason: intake.reason, note: intake.note || null, location: intake.location || null,
        })),
      }),
    })
    setBusy(null)
    if (!res || res.error) { toast.error(res?.error || 'Failed to add'); return }
    toast.success(`${res.added} piece${res.added === 1 ? '' : 's'} on the shelf${res.skipped ? ` · ${res.skipped} already there` : ''}`)
    setIntake(null); load()
  }

  const saveUse = async () => {
    const qty = Number(use.qty)
    if (!use.order_number.trim()) { toast.error('Which order is it going to?'); return }
    if (!Number.isFinite(qty) || qty < 1) { toast.error('Quantity must be 1 or more'); return }
    setBusy('use')
    const res = await apiFetch(`/api/inventory/rto/${use.row.id}/use`, {
      method: 'POST', body: JSON.stringify({ order_number: use.order_number.trim(), qty }),
    })
    setBusy(null)
    if (!res || res.error) { toast.error(res?.error || 'Failed'); return }
    toast.success(res.credited
      ? `Sent to ${use.order_number.trim()} · ${res.credited.blank_type} ${res.credited.color} ${res.credited.size} +${res.credited.qty} back in blanks`
      : `Sent to ${use.order_number.trim()}`)
    setUse(null); load()
  }

  const saveDamage = async () => {
    const qty = Number(damage.qty)
    if (!Number.isFinite(qty) || qty < 1) { toast.error('Quantity must be 1 or more'); return }
    if (!damage.reason.trim()) { toast.error('Say what went wrong'); return }
    setBusy('damage')
    const res = await apiFetch('/api/inventory/damaged', {
      method: 'POST',
      body: JSON.stringify({ kind: 'finished', rto_id: damage.row.id, qty, stage: damage.stage, reason: damage.reason.trim(), note: damage.note || null }),
    })
    setBusy(null)
    if (!res || res.error) { toast.error(res?.error || 'Failed'); return }
    toast.success('Written off, and taken off the shelf')
    setDamage(null); load()
  }

  const reopenAlert = async (row) => {
    const res = await apiFetch(`/api/inventory/rto/alerts/${row.id}/reopen`, { method: 'POST', body: JSON.stringify({}) })
    if (!res || res.error) { toast.error(res?.error || 'Failed'); return }
    toast.success('Notice reopened'); load()
  }

  const removeEntry = async (row) => {
    const touched = row.qty_used || row.qty_written_off
    const details = [{ label: 'Variant', value: row.variant || '—' }, { label: 'Pieces', value: String(row.qty) }]
    if (row.qty_used) details.push({ label: 'Already sent out', value: `${row.qty_used} — the blank credited for it is taken back` })
    if (row.qty_written_off) details.push({ label: 'Written off', value: `${row.qty_written_off} — those entries go too` })
    if (!await toast.confirm({
      title: `Delete ${row.product_title}?`,
      message: touched
        ? 'This entry has already moved stock. Deleting it unwinds every one of those movements, each recorded as its own correction.'
        : 'Nothing has left this entry, so removing it just undoes the mistake.',
      details, confirmLabel: 'Delete', danger: true,
    })) return
    const res = await apiFetch(`/api/inventory/rto/${row.id}`, { method: 'DELETE' })
    if (!res || res.error) { toast.error(res?.error || 'Failed'); return }
    toast.success(res.reversed?.length ? `Entry deleted · ${res.reversed.join(' · ')}` : 'Entry deleted')
    load()
  }

  /** Answer one order's notice from the picker, without sending it a piece. */
  const skipOrder = async (group, order) => {
    const res = await apiFetch(`/api/inventory/rto/alerts/${order.alert_id}/skip`, { method: 'POST', body: JSON.stringify({}) })
    if (!res || res.error) { toast.error(res?.error || 'Failed'); return }
    toast.info(`${order.order_ref} marked as not used`)
    setPick(null); load()
  }

  /** A parcel that went out before anyone looked at the shelf. Keyed on the order number. */
  const markOrderNotUsed = async () => {
    const ref = notUsed.trim()
    if (!ref) return
    const res = await apiFetch('/api/inventory/rto/alerts/mark-not-used', {
      method: 'POST', body: JSON.stringify({ order_number: ref }),
    })
    if (!res || res.error) { toast.error(res?.error || 'Failed'); return }
    toast.success(`${ref} marked as not used — ${res.cleared} notice${res.cleared === 1 ? '' : 's'} cleared`)
    setNotUsed(''); load()
  }

  // Derived before the loading guards below: these include hooks, and a hook behind a
  // conditional return changes the hook order between renders.
  const d = data || {}
  const s = d.summary || {}
  const shelf = d.shelf || []
  // One row per garment, not per order: four orders wanting the same shirt is one shirt and one
  // decision. Which order gets it is chosen in the picker.
  const waiting = d.waiting || []
  // Every piece that went back out, whether or not a notice prompted it — a piece can be sent
  // straight from the shelf, and counting only answered notices under-reported the shelf's work.
  const sentLog = d.sent || []
  const skippedHistory = (d.history || []).filter(h => h.status !== 'used')

  /** The shelf entry a garment's pieces actually come from. */
  const entryFor = (g) => (d.entries || []).find(e => e.available > 0
    && (g.variant_id ? String(e.variant_id) === String(g.variant_id)
      : e.product_title === g.product_title && e.variant === g.variant))

  // One shelf entry per design+variant is what gets acted on; the raw rows carry the provenance.
  const entriesFor = (row) => (d.entries || []).filter(e =>
    e.available > 0 && (row.variant_id ? String(e.variant_id) === String(row.variant_id)
      : e.product_title === row.product_title && e.variant === row.variant))

  // Same identity rule as the server's matcher: the variant id when there is one, the text when
  // the design predates the variant cache.
  const keyOf = (x) => (x.variant_id ? `v${x.variant_id}` : `t${x.product_title}|${x.variant}`)
  const wantedKeys = focus === 'matched' ? new Set(waiting.map(keyOf)) : null
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const visible = shelf.filter(row => {
    if (wantedKeys && !wantedKeys.has(keyOf(row))) return false
    if (!words.length) return true
    const hay = `${row.product_title} ${row.variant || ''} ${row.blank_type || ''}`.toLowerCase()
    return words.every(w => hay.includes(w))
  })
  const filtered = !!wantedKeys || !!words.length

  // Every table on this tab pages locally: the lists are bounded and already loaded whole, and a
  // 97-row shelf under a 7-row notice list is what made the page hard to read.
  const waitPager = useLocalPager(waiting, 10)
  const shelfPager = useLocalPager(visible, 10)
  const sentPager = useLocalPager(sentLog, 10)
  const skipPager = useLocalPager(skippedHistory, 10)


  if (loading) return <div className="loader"><div className="spinner" /><span>Loading the RTO shelf…</span></div>
  if (!data) return <div className="empty-state"><p>RTO stock could not be loaded.</p></div>

  return (
    <>
      <div className="dash-toolbar">
        <div>
          <p style={{ color: 'var(--text-muted)' }}>
            Printed garments that came back. A piece here can go out again to any order for the same
            design and size — and doing so puts its blank back in stock.
          </p>
        </div>
        {canEdit && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn btn-secondary" onClick={() => openIntake('manual')}>Add by product</button>
            <button className="btn btn-primary" onClick={() => openIntake('scan')}>
              <Icon name="scan" size={15} style={{ marginRight: 6, verticalAlign: '-2px' }} />
              Scan a return
            </button>
          </div>
        )}
      </div>

      <div className="kpi-grid" style={{ marginBottom: 18 }}>
        {[
          { icon: 'box', label: 'Pieces on the shelf', value: num(s.pieces), key: 'all',
            sub: s.designs ? `across ${num(s.designs)} designs` : null },
          { icon: 'alert', label: 'Pieces an order wants', value: num(s.waiting_pieces), key: 'matched',
            sub: s.waiting_orders ? `${num(s.waiting_orders)} order${s.waiting_orders === 1 ? '' : 's'} waiting` : null },
          { icon: 'trending', label: 'Sent out again', value: num(s.used) },
        ].map(k => (
          <div className={`kpi-card ${k.key ? 'kpi-clickable' : ''} ${focus === k.key || (k.key === 'all' && !focus) ? 'kpi-active' : ''}`} key={k.label}
            onClick={() => k.key && setFocus(k.key === 'all' ? null : (focus === k.key ? null : k.key))}
            title={k.key === 'matched' ? 'Show only pieces an open order is waiting on'
              : k.key === 'all' ? 'Show everything on the shelf' : undefined}>
            <div className="kpi-head"><div className="kpi-icon"><Icon name={k.icon} size={20} /></div></div>
            <div className="kpi-value">{k.value}</div>
            <div className="kpi-label">{k.label}</div>
            {k.sub && <div className="kpi-note">{k.sub}</div>}
          </div>
        ))}
      </div>

      {/* Table 1 — the piece, not the order. Four orders wanting one shirt is one row; who gets
          it is decided in the picker, where they can be seen side by side. */}
      {!!waiting.length && (
        <div className="card rto-alert" style={{ marginBottom: 18 }}>
          <div className="dash-toolbar" style={{ marginBottom: 8 }}>
            <div>
              <h2 style={{ fontSize: 15, marginBottom: 4 }}>
                <Icon name="alert" size={16} style={{ marginRight: 6, verticalAlign: '-3px' }} />
                {waiting.length} piece{waiting.length > 1 ? 's' : ''} on the shelf an order is waiting for
              </h2>
              <p style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>
                Open one to see which orders want it, then send it, mark it not used, or write it off.
              </p>
            </div>
          </div>
          <div className="data-table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Design</th><th>Variant</th>
                  <th style={{ textAlign: 'right' }}>On shelf</th>
                  <th style={{ textAlign: 'right' }}>Orders waiting</th>
                  <th>Longest wait</th><th></th>
                </tr>
              </thead>
              <tbody>
                {waitPager.slice.map(g => (
                  <tr key={g.key} onClick={() => canEdit && setPick(g)} style={{ cursor: canEdit ? 'pointer' : 'default' }}>
                    <td className="cell-primary">{g.product_title}</td>
                    <td data-label="Variant">{g.variant || '—'}</td>
                    <td data-label="On shelf" style={{ textAlign: 'right', fontWeight: 700 }}>{g.available}</td>
                    <td data-label="Orders waiting" style={{ textAlign: 'right' }}>
                      {g.orders.length}
                      {g.orders.length > g.available && (
                        <div style={{ fontSize: 11, color: 'var(--warning)' }}>more orders than pieces</div>
                      )}
                    </td>
                    <td data-label="Longest wait">
                      {day(g.orders[0]?.order_date)}
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{g.orders[0]?.order_ref}</div>
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {canEdit && <button className="mini-btn mini-btn-active" onClick={(e) => { e.stopPropagation(); setPick(g) }}>Choose an order</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination table={waitPager.table} noun="pieces" />
        </div>
      )}

      {/* Orders whose garment has since gone elsewhere. Not listed — there is nothing to offer for
          them — but not hidden either, and they come back on their own if a piece is returned. */}
      {!!d.dormant_orders && (
        <p style={{ color: 'var(--text-muted)', fontSize: 12.5, marginBottom: 16 }}>
          {num(d.dormant_orders)} other order{d.dormant_orders === 1 ? '' : 's'} asked for a piece but
          cannot take one — the garment has gone, or the order is cancelled or on hold
          {d.parked_orders ? ` (${num(d.parked_orders)} of those)` : ''}. They come back on their own
          if that changes.
        </p>
      )}

      {canEdit && (
        <div className="card" style={{ marginBottom: 18 }}>
          <h2 style={{ fontSize: 14, marginBottom: 4 }}>Already shipped without checking?</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 12.5, marginBottom: 10 }}>
            Enter the order number and its notice is filed as not used, so the shelf stops offering it.
          </p>
          <div style={{ display: 'flex', gap: 8, maxWidth: 420 }}>
            <input value={notUsed} placeholder="#10862" style={{ flex: 1 }}
              onChange={e => setNotUsed(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') markOrderNotUsed() }} />
            <button className="btn btn-secondary" disabled={!notUsed.trim()} onClick={markOrderNotUsed}>Mark not used</button>
          </div>
        </div>
      )}

      {shelf.length > 1 && (
        <div className="filters-row" style={{ marginBottom: 12 }}>
          <div className="search-bar" style={{ flex: 1 }}>
            <input value={query} placeholder="Filter the shelf by design, colour or size…"
              onChange={e => setQuery(e.target.value)} />
          </div>
          {filtered && (
            <button className="mini-btn" onClick={() => { setFocus(null); setQuery('') }}>
              Showing {visible.length} of {shelf.length} designs · clear
            </button>
          )}
        </div>
      )}

      {!shelf.length ? (
        <div className="empty-state">
          <div className="empty-icon">📥</div>
          <p>Nothing on the RTO shelf.{canEdit ? ' Scan a returned parcel to put its garments here.' : ''}</p>
        </div>
      ) : !visible.length ? (
        <div className="empty-state">
          <div className="empty-icon">🔍</div>
          <p>Nothing on the shelf matches that.</p>
          <button className="btn btn-secondary" style={{ marginTop: 12 }} onClick={() => { setFocus(null); setQuery('') }}>Show everything</button>
        </div>
      ) : (
        <div className="data-table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Design</th><th>Variant</th><th>Blank behind it</th>
                <th style={{ textAlign: 'right' }}>Available</th><th>Oldest</th><th></th>
              </tr>
            </thead>
            <tbody>
              {shelfPager.slice.map((row, i) => {
                const sources = entriesFor(row)
                const first = sources[0]
                return (
                  <tr key={i}>
                    <td className="cell-primary">{row.product_title}</td>
                    <td data-label="Variant">{row.variant || '—'}</td>
                    <td data-label="Blank behind it" style={{ color: 'var(--text-muted)' }}>
                      {row.blank_type ? `${row.blank_type} ${row.color} ${row.size}` : 'Not linked to a blank'}
                    </td>
                    <td data-label="Available" style={{ textAlign: 'right', fontWeight: 700 }}>{row.available}</td>
                    <td data-label="Oldest">
                      {day(row.oldest)}
                      {first?.source_order_number && <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>from {first.source_order_number}</div>}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {canEdit && first && (
                        <>
                          <button className="mini-btn" onClick={() => setUse({ row: first, order_number: '', qty: 1 })}>Send to an order</button>
                          <button className="mini-btn" style={{ marginLeft: 6 }}
                            onClick={() => setDamage({ row: first, qty: 1, stage: 'courier', reason: '', note: '' })}>Damaged</button>
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <Pagination table={shelfPager.table} noun="designs" />
        </div>
      )}

      {/* Tables 2 and 3 — what was done about every notice raised. Split apart because they answer
          different questions: one is the shelf earning its keep, the other is it being walked past. */}
      {!!sentLog.length && (
        <>
          <div className="dash-toolbar" style={{ marginTop: 22, marginBottom: 12 }}>
            <div>
              <h2 style={{ fontSize: 17 }}>Sent from the shelf</h2>
              <p style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>
                {num(s.used)} garment{s.used === 1 ? '' : 's'} that did not have to be printed again
              </p>
            </div>
          </div>
          <div className="data-table-wrapper">
            <table className="data-table">
              <thead>
                <tr><th>Order</th><th>Garment</th><th>Blank credited</th><th>Sent</th><th>By</th></tr>
              </thead>
              <tbody>
                {sentPager.slice.map(e => (
                  <tr key={e.id}>
                    <td className="cell-primary">{e.order_number || '—'}</td>
                    <td data-label="Garment">{e.product_title}<div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{e.variant}</div></td>
                    <td data-label="Blank credited" style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>
                      {e.blank_type ? `${e.blank_type} ${e.color} ${e.size} +${e.qty}` : '—'}
                    </td>
                    <td data-label="Sent">{day(e.created_at)}</td>
                    <td data-label="By" style={{ color: 'var(--text-muted)', fontSize: 12 }}>{e.created_by || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination table={sentPager.table} noun="sent" />
          </div>
        </>
      )}

      {!!skippedHistory.length && (
        <>
          <div className="dash-toolbar" style={{ marginTop: 22, marginBottom: 12 }}>
            <div>
              <h2 style={{ fontSize: 17 }}>Not used</h2>
              <p style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>
                {num(s.missed)} order{s.missed === 1 ? '' : 's'} that got a fresh garment even though the shelf had one
              </p>
            </div>
          </div>
          <div className="data-table-wrapper">
            <table className="data-table">
              <thead>
                <tr><th>Order</th><th>Garment</th><th>Why</th><th>Answered</th><th></th></tr>
              </thead>
              <tbody>
                {skipPager.slice.map(h => (
                  <tr key={h.id}>
                    <td className="cell-primary">
                      {h.order_ref}
                      {h.source === 'seeding' && <span className="rto-pill">seeding</span>}
                    </td>
                    <td data-label="Garment">{h.product_title}<div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{h.variant}</div></td>
                    <td data-label="Why" style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>{h.resolution_note || '—'}</td>
                    <td data-label="Answered" style={{ fontSize: 12 }}>
                      <div>{day(h.resolved_at)}</div>
                      {h.resolved_by && <div style={{ color: 'var(--text-muted)' }}>{h.resolved_by}</div>}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {/* Only a hand-cleared notice can come back; one answered by actually sending
                          a piece is a fact, not a decision to revisit. */}
                      {canEdit && <button className="mini-btn" onClick={() => reopenAlert(h)}>Reopen</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination table={skipPager.table} noun="orders" />
          </div>
        </>
      )}

      <div className="dash-toolbar" style={{ marginTop: 22, marginBottom: 12 }}>
        <div>
          <h2 style={{ fontSize: 17 }}>Everything returned</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>
            Every piece that came back, including those already sent out again or written off
          </p>
        </div>
        <button className="mini-btn" onClick={() => setHistory(h => !h)}>
          {history ? 'Hide' : `Show${isAdmin ? ' & manage' : ''}`}
        </button>
      </div>

      {history && (
        <div className="data-table-wrapper">
          {!(data.entries || []).length ? (
            <div className="empty-state"><p>No returns recorded yet.</p></div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Design</th><th>Variant</th><th>From</th><th>Reason</th>
                  <th style={{ textAlign: 'right' }}>In</th>
                  <th style={{ textAlign: 'right' }}>Out</th>
                  <th style={{ textAlign: 'right' }}>Written off</th>
                  <th style={{ textAlign: 'right' }}>Left</th>
                  <th>Added</th><th></th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map(e => (
                  <tr key={e.id}>
                    <td className="cell-primary">{e.product_title}</td>
                    <td data-label="Variant">{e.variant || '—'}</td>
                    <td data-label="From">{e.source_order_number || <span style={{ color: 'var(--text-muted)' }}>by hand</span>}</td>
                    <td data-label="Reason" style={{ color: 'var(--text-muted)' }}>{e.reason || '—'}</td>
                    <td data-label="In" style={{ textAlign: 'right' }}>{e.qty}</td>
                    <td data-label="Out" style={{ textAlign: 'right' }}>{e.qty_used || '—'}</td>
                    <td data-label="Written off" style={{ textAlign: 'right' }}>{e.qty_written_off || '—'}</td>
                    <td data-label="Left" style={{ textAlign: 'right', fontWeight: 700 }}>{e.available}</td>
                    <td data-label="Added" style={{ fontSize: 12 }}>
                      <div>{day(e.created_at)}</div>
                      {e.created_by && <div style={{ color: 'var(--text-muted)' }}>{e.created_by}</div>}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {/* Untouched entries are anyone's to tidy up; once stock has moved it takes
                          an admin, because deleting means reversing what already happened. */}
                      {canEdit && (!e.qty_used && !e.qty_written_off
                        ? <button className="mini-btn" onClick={() => removeEntry(e)}>Remove</button>
                        : isAdmin && <button className="mini-btn mini-btn-danger" onClick={() => removeEntry(e)}>Delete</button>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ---- Intake ------------------------------------------------------------------ */}
      {intake && (
        <div className="confirm-overlay" onClick={() => setIntake(null)}>
          <div className="confirm-card" style={{ maxWidth: 680 }} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
            <h3 className="confirm-title">Put returned garments on the shelf</h3>
            <div className="scan-tabs" style={{ marginBottom: 14 }}>
              <button className={intake.mode === 'scan' ? 'active' : ''} onClick={() => setIntake(v => ({ ...v, mode: 'scan' }))}>Scan an order</button>
              <button className={intake.mode === 'manual' ? 'active' : ''} onClick={() => setIntake(v => ({ ...v, mode: 'manual' }))}>Pick a product</button>
            </div>

            {intake.mode === 'scan' && (
              <>
                <div className="input-group">
                  <label>Scan or type the order number on the returned parcel</label>
                  <input ref={scanRef} value={intake.scan} placeholder="#10805"
                    onChange={e => setIntake(v => ({ ...v, scan: e.target.value }))}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); lookup(intake.scan) } }} />
                  <span className="label-hint">{busy === 'lookup' ? 'Looking it up…' : 'Enter to look it up'}</span>
                </div>

                {intake.order && (
                  <>
                    <dl className="confirm-details">
                      <div className="confirm-detail"><dt>Order</dt><dd>{intake.order.order_number}</dd></div>
                      <div className="confirm-detail"><dt>Placed</dt><dd>{day(intake.order.created_at)}</dd></div>
                      <div className="confirm-detail"><dt>Customer</dt><dd>{[intake.order.first_name, intake.order.last_name].filter(Boolean).join(' ') || '—'}</dd></div>
                    </dl>
                    <div className="rto-lines">
                      {intake.items.map((it, i) => (
                        <label className={`rto-line ${it.on_shelf ? 'rto-line-done' : ''}`} key={i}>
                          <input type="checkbox" checked={it.take} disabled={it.on_shelf}
                            onChange={e => setIntake(v => ({ ...v, items: v.items.map((x, j) => j === i ? { ...x, take: e.target.checked } : x) }))} />
                          <span style={{ flex: 1 }}>
                            <b>{it.product_title}</b>
                            <span style={{ color: 'var(--text-muted)' }}> · {it.variant || '—'}</span>
                            {it.on_shelf && <span className="rto-pill">already on the shelf</span>}
                            {!it.blank_type && <span className="rto-pill rto-pill-warn">no blank linked</span>}
                          </span>
                          <input type="number" min="1" max={it.qty} value={it.qty_take} style={{ width: 70 }}
                            disabled={it.on_shelf || !it.take}
                            onChange={e => setIntake(v => ({ ...v, items: v.items.map((x, j) => j === i ? { ...x, qty_take: Number(e.target.value) } : x) }))} />
                          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>of {it.qty}</span>
                        </label>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}

            {intake.mode === 'manual' && (
              <ManualPicker products={products}
                onAdd={(item) => setIntake(v => ({ ...v, items: [...v.items, item] }))} />
            )}

            {intake.mode === 'manual' && !!intake.items.length && (
              <div className="rto-lines">
                {intake.items.map((it, i) => (
                  <div className="rto-line" key={i}>
                    <span style={{ flex: 1 }}><b>{it.product_title}</b> <span style={{ color: 'var(--text-muted)' }}>· {it.variant}</span></span>
                    <b>{it.qty_take}</b>
                    <button className="mini-btn" onClick={() => setIntake(v => ({ ...v, items: v.items.filter((_, j) => j !== i) }))}>×</button>
                  </div>
                ))}
              </div>
            )}

            <div className="form-row" style={{ marginTop: 12 }}>
              <div className="input-group">
                <label>Why did it come back</label>
                <select value={intake.reason} onChange={e => setIntake(v => ({ ...v, reason: e.target.value }))}>
                  {REASONS.map(r => <option key={r}>{r}</option>)}
                </select>
              </div>
              <div className="input-group">
                <label>Where is it kept <span style={{ color: 'var(--text-muted)' }}>optional</span></label>
                <input value={intake.location} placeholder="Rack B, shelf 2"
                  onChange={e => setIntake(v => ({ ...v, location: e.target.value }))} />
              </div>
            </div>
            <div className="input-group">
              <label>Note <span style={{ color: 'var(--text-muted)' }}>optional</span></label>
              <input value={intake.note} onChange={e => setIntake(v => ({ ...v, note: e.target.value }))} />
            </div>

            <p className="confirm-message" style={{ fontSize: 12.5 }}>
              Blank stock does not change here — the blank was spent when the garment was printed and
              still is. It comes back only when this piece is sent out to another order.
            </p>

            <div className="confirm-actions">
              <button className="btn btn-secondary" onClick={() => setIntake(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={busy === 'save' || !intake.items.some(i => i.take && i.qty_take > 0)} onClick={saveIntake}>
                {busy === 'save' ? 'Saving…' : 'Add to the shelf'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- Which order gets this piece ---------------------------------------------- */}
      {pick && (
        <div className="confirm-overlay" onClick={() => setPick(null)}>
          <div className="confirm-card" style={{ maxWidth: 620 }} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
            <h3 className="confirm-title">{pick.product_title}</h3>
            <p className="confirm-message">
              {pick.variant} · <b>{pick.available}</b> on the shelf ·{' '}
              {pick.orders.length} order{pick.orders.length > 1 ? 's' : ''} waiting
            </p>

            <div className="rto-lines">
              {pick.orders.map(o => (
                <div className="rto-line" key={o.alert_id}>
                  <span style={{ flex: 1 }}>
                    <b>{o.order_ref}</b>
                    <span style={{ color: 'var(--text-muted)' }}> · {day(o.order_date)}</span>
                    {o.source === 'seeding' && <span className="rto-pill">seeding{o.customer ? ` · ${o.customer}` : ''}</span>}
                  </span>
                  {canEdit && (
                    <>
                      <button className="mini-btn mini-btn-active" disabled={pick.available < 1}
                        onClick={() => {
                          const entry = entryFor(pick)
                          if (!entry) { toast.error('That piece is no longer on the shelf'); return }
                          setPick(null)
                          setUse({ row: entry, order_number: o.order_ref, qty: 1 })
                        }}>Send to this</button>
                      <button className="mini-btn" title="This order got a freshly printed garment"
                        onClick={() => skipOrder(pick, o)}>Didn't use it</button>
                    </>
                  )}
                </div>
              ))}
            </div>

            <p className="confirm-message" style={{ fontSize: 12.5 }}>
              Sending it puts its blank back in stock. The orders you do not pick stay on the list, and
              drop off on their own once no piece is left for them.
            </p>

            <div className="confirm-actions">
              {canEdit && (
                <button className="btn btn-danger" onClick={() => {
                  const entry = entryFor(pick)
                  if (!entry) { toast.error('That piece is no longer on the shelf'); return }
                  setPick(null)
                  setDamage({ row: entry, qty: 1, stage: 'courier', reason: '', note: '' })
                }}>
                  <Icon name="alert" size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                  Write this piece off as damaged
                </button>
              )}
              <button className="btn btn-secondary" onClick={() => setPick(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ---- Send to an order --------------------------------------------------------- */}
      {use && (
        <div className="confirm-overlay" onClick={() => setUse(null)}>
          <div className="confirm-card" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
            <h3 className="confirm-title">Send this piece to an order</h3>
            <p className="confirm-message">{use.row.product_title} · {use.row.variant}</p>
            {/* Only orders that want this exact garment. It used to offer the first six matched
                orders whatever they were, so sending a Spider Suit suggested a Hamilton order. */}
            {(() => {
              const wants = waiting.find(g => (g.variant_id && use.row.variant_id
                ? String(g.variant_id) === String(use.row.variant_id)
                : g.product_title === use.row.product_title && g.variant === use.row.variant))
              return wants?.orders.length ? (
                <div className="rto-suggest">
                  {wants.orders.slice(0, 8).map(o => (
                    <button key={o.alert_id} className="mini-btn"
                      onClick={() => setUse(v => ({ ...v, order_number: o.order_ref }))}>{o.order_ref}</button>
                  ))}
                </div>
              ) : null
            })()}
            <div className="input-group">
              <label>Order number</label>
              <input value={use.order_number} autoFocus placeholder="#10812"
                onChange={e => setUse(v => ({ ...v, order_number: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') saveUse() }} />
            </div>
            <div className="input-group">
              <label>How many</label>
              <input type="number" min="1" max={use.row.available} value={use.qty}
                onChange={e => setUse(v => ({ ...v, qty: e.target.value }))} />
              <span className="label-hint">{use.row.available} available on this entry</span>
            </div>
            {use.row.blank_type ? (
              <p className="confirm-message" style={{ fontSize: 12.5 }}>
                <b>{use.row.blank_type} {use.row.color} {use.row.size}</b> gets <b>+{use.qty || 1}</b> back in blank
                stock — that order deducted a blank when it was placed, but nothing new was printed for it.
              </p>
            ) : (
              <p className="confirm-message" style={{ fontSize: 12.5 }}>
                This piece is not linked to a blank, so no blank stock is credited.
              </p>
            )}
            <div className="confirm-actions">
              <button className="btn btn-secondary" onClick={() => setUse(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={busy === 'use'} onClick={saveUse}>
                {busy === 'use' ? 'Saving…' : 'Mark as sent'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- Write one off from the shelf --------------------------------------------- */}
      {damage && (
        <div className="confirm-overlay" onClick={() => setDamage(null)}>
          <div className="confirm-card" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
            <h3 className="confirm-title">Write this piece off</h3>
            <p className="confirm-message">{damage.row.product_title} · {damage.row.variant}</p>
            <div className="input-group">
              <label>How many</label>
              <input type="number" min="1" max={damage.row.available} value={damage.qty} autoFocus
                onChange={e => setDamage(v => ({ ...v, qty: e.target.value }))} />
            </div>
            <div className="input-group">
              <label>What went wrong</label>
              <input value={damage.reason} placeholder="Came back stained"
                onChange={e => setDamage(v => ({ ...v, reason: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') saveDamage() }} />
            </div>
            <p className="confirm-message" style={{ fontSize: 12.5 }}>
              It leaves the shelf and appears under Damaged. Blank stock is untouched — that blank was
              spent on the print and is not coming back.
            </p>
            <div className="confirm-actions">
              <button className="btn btn-secondary" onClick={() => setDamage(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={busy === 'damage'} onClick={saveDamage}>
                {busy === 'damage' ? 'Saving…' : 'Write off'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/** Product + variant + quantity, for a piece that arrives without an order to scan. */
function ManualPicker({ products, onAdd }) {
  const [productId, setProductId] = useState('')
  const [variantId, setVariantId] = useState('')
  const [qty, setQty] = useState(1)
  if (!products) return <div className="loader"><div className="spinner" /></div>

  const product = products.find(p => String(p.shopify_id) === String(productId))
  const variant = product?.variants.find(v => String(v.variant_id) === String(variantId))
  const productOptions = products.map(p => ({ value: p.shopify_id, label: p.title, hint: p.blank_type || p.product_type || '' }))
  const variantOptions = (product?.variants || []).map(v => ({ value: v.variant_id, label: v.variant }))

  const add = () => {
    if (!product || !variant) return
    onAdd({
      shopify_product_id: product.shopify_id, variant_id: variant.variant_id,
      product_title: product.title, variant: variant.variant,
      color: variant.color, size: variant.size, blank_type: product.blank_type,
      qty: Number(qty) || 1, qty_take: Number(qty) || 1, take: true, source_ref: null,
    })
    setVariantId(''); setQty(1)
  }

  return (
    <div className="form-row" style={{ alignItems: 'end' }}>
      <div className="input-group">
        <label>Design</label>
        <SearchSelect value={productId} options={productOptions} placeholder="Type to search products…"
          onChange={(v) => { setProductId(v); setVariantId('') }} />
      </div>
      <div className="input-group">
        <label>Colour / size</label>
        <SearchSelect value={variantId} options={variantOptions} disabled={!product}
          placeholder={product ? 'Type to search…' : 'Pick a design first'}
          onChange={(v) => setVariantId(v)} />
      </div>
      <div className="input-group" style={{ maxWidth: 110 }}>
        <label>How many</label>
        <input type="number" min="1" value={qty} onChange={e => setQty(e.target.value)} />
      </div>
      <button className="btn btn-secondary" disabled={!variant} onClick={add} style={{ marginBottom: 14 }}>Add</button>
    </div>
  )
}
