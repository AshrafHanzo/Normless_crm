import { useState, useEffect, useRef } from 'react'
import { useApi, useAuth } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import SearchSelect from '../../components/SearchSelect'
import Pagination from '../../components/Pagination'
import useLocalPager from '../../hooks/useLocalPager'

const num = (v) => new Intl.NumberFormat('en-IN').format(Number(v) || 0)
const day = (v) => (v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—')
// A match happens minutes after an order lands, so the day alone does not say much about it.
const stamp = (v) => (v ? new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—')
// How long ago, in the units someone would say out loud.
const since = (v) => {
  if (!v) return null
  const d = Math.floor((Date.now() - new Date(v)) / 86400000)
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`
}

const REASONS = ['Undelivered — RTO', 'Refused by customer', 'Address issue', 'Customer return', 'Other']

/**
 * The RTO shelf: printed garments that came back.
 *
 * These are not blanks and never become blanks — a returned "Natty Forever / Black / L" carries a
 * print and can only go out again to another order for that same design and variant. Which is
 * exactly why the shelf is matched against open orders: the whole value of keeping it is catching
 * the moment someone is about to print a second one.
 */
export default function RtoTab({ onChanged }) {
  const apiFetch = useApi()
  const toast = useToast()
  const { user } = useAuth()
  const canEdit = ['owner', 'admin'].includes(user?.role) || !!user?.can_edit_inventory
  const canImport = ['owner', 'admin'].includes(user?.role) || !!user?.can_import_rto
  const isAdmin = ['owner', 'admin'].includes(user?.role)

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(null)
  const [intake, setIntake] = useState(null)   // { mode, scan, order, items, reason, note, location }
  const [use, setUse] = useState(null)         // { row, order_number, qty }
  const [damage, setDamage] = useState(null)   // { row, qty, stage, reason, note }
  const [products, setProducts] = useState(null)
  const [history, setHistory] = useState(false)
  const [story, setStory] = useState(null)      // the answered notice whose timeline is open
  const [csv, setCsv] = useState(null)          // { file, plan } — an import waiting to be confirmed
  const [help, setHelp] = useState(false)       // the export/import guide
  const fileRef = useRef(null)
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
    if (r && !r.error) { setData(r); onChanged?.() }
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

  /**
   * The shelf as a file, and a file back onto the shelf.
   *
   * Import is two steps on purpose. The file is read and turned into a plan — what would be added,
   * what would change and how, what cannot be accepted and why — and nothing moves until the
   * person has read that plan and said so. A bulk edit that happens silently is a bulk mistake
   * that happens silently.
   */
  const download = async (url, fallback) => {
    const r = await apiFetch(url, { responseType: 'blob' })
    if (!r || r.error) { toast.error(r?.error || 'Download failed'); return }
    const href = URL.createObjectURL(r.blob)
    const a = document.createElement('a')
    a.href = href; a.download = r.filename || fallback
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(href)
  }
  const exportCsv = () => download('/api/inventory/rto/export.csv', 'rto-shelf.csv')
  // Every product and variant the import will accept, in the import's own column layout — so a
  // new row is a copied line with a number typed into "received", never a name typed from memory.
  const exportCatalogue = () => download('/api/inventory/rto/catalogue.csv', 'rto-catalogue.csv')

  const previewCsv = async (file) => {
    if (!file) return
    const body = new FormData(); body.append('file', file)
    setBusy('csv')
    const r = await apiFetch('/api/inventory/rto/import', { method: 'POST', body })
    setBusy(null)
    if (!r || r.error) { toast.error(r?.error || 'Could not read the file'); return }
    setCsv({ file, plan: r })
  }

  const applyCsv = async () => {
    const body = new FormData(); body.append('file', csv.file)
    setBusy('csv')
    const r = await apiFetch('/api/inventory/rto/import?apply=1', { method: 'POST', body })
    setBusy(null)
    if (!r || r.error) { toast.error(r?.error || 'Import failed'); return }
    const s = r.summary
    toast.success(
      [s.add && `${s.add} added`, s.update && `${s.update} updated`, s.delete && `${s.delete} deleted`, s.reject && `${s.reject} skipped`].filter(Boolean).join(' · ') || 'Nothing to change',
      { title: 'Shelf imported' })
    setCsv(null); load()
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
            <button className="btn btn-secondary" onClick={exportCsv} title="Every entry on the shelf, as a spreadsheet">
              <Icon name="download" size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />
              Export CSV
            </button>
            {/* Anyone who can edit may export; importing is its own right, granted in Admin. */}
            {canImport && (
              <>
                <input ref={fileRef} type="file" accept=".csv,text/csv" hidden
                  onChange={e => { previewCsv(e.target.files?.[0]); e.target.value = '' }} />
                <button className="btn btn-secondary" disabled={busy === 'csv'} onClick={() => fileRef.current?.click()}
                  title="Add or correct entries from a spreadsheet — you see what will change first">
                  {busy === 'csv' ? 'Reading…' : 'Import CSV'}
                </button>
                <button className="mini-btn" style={{ alignSelf: 'center' }} onClick={exportCatalogue}
                  title="Every product and variant the import accepts — copy a line, type a count">
                  Product list for Excel
                </button>
              </>
            )}
            <button className="btn-icon" style={{ alignSelf: 'center' }} onClick={() => setHelp(true)} title="How export and import work">
              <Icon name="info" size={15} />
            </button>
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
                  <th>Back since</th>
                  <th style={{ textAlign: 'right' }}>Orders waiting</th>
                  <th>Longest wait</th><th>Matched</th><th></th>
                </tr>
              </thead>
              <tbody>
                {waitPager.slice.map(g => (
                  <tr key={g.key} onClick={() => canEdit && setPick(g)} style={{ cursor: canEdit ? 'pointer' : 'default' }}>
                    <td className="cell-primary">{g.product_title}</td>
                    <td data-label="Variant">{g.variant || '—'}</td>
                    <td data-label="On shelf" style={{ textAlign: 'right', fontWeight: 700 }}>{g.available}</td>
                    <td data-label="Back since" style={{ fontSize: 12 }}>
                      {day(g.shelf_since)}
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{since(g.shelf_since)}</div>
                    </td>
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
                    {/* When the shelf and this order were first put together — the moment the
                        notice appeared, not the moment either of them happened. */}
                    <td data-label="Matched" style={{ fontSize: 12 }}>
                      {stamp(g.orders[0]?.matched_at)}
                      {g.orders.length > 1 && (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>first of {g.orders.length}</div>
                      )}
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
          cannot take one right now — the garment has gone from the shelf, or the order is cancelled
          or on hold{d.parked_orders ? ` (${num(d.parked_orders)} of those)` : ''}. They come back on
          their own if that changes.
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
                <th style={{ textAlign: 'right' }}>Available</th><th>Back since</th><th></th>
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
                    <td data-label="Back since">
                      {day(row.oldest)}
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {since(row.oldest)}{first?.source_order_number ? ` · from ${first.source_order_number}` : ''}
                      </div>
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
                <tr><th>Order</th><th>Garment</th><th>Blank credited</th><th>Came back</th><th>Sent</th><th>By</th></tr>
              </thead>
              <tbody>
                {sentPager.slice.map(e => (
                  <tr key={e.id}>
                    <td className="cell-primary">{e.order_number || '—'}</td>
                    <td data-label="Garment">{e.product_title}<div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{e.variant}</div></td>
                    <td data-label="Blank credited" style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>
                      {e.blank_type ? `${e.blank_type} ${e.color} ${e.size} +${e.qty}` : '—'}
                    </td>
                    <td data-label="Came back" style={{ fontSize: 12 }}>
                      {day(e.received_at)}
                      {e.source_order_number && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>from {e.source_order_number}</div>}
                    </td>
                    <td data-label="Sent" style={{ fontSize: 12 }}>
                      {day(e.created_at)}
                      {/* How long the piece sat on the shelf before it found an order. */}
                      {e.received_at && (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          after {Math.max(0, Math.round((new Date(e.created_at) - new Date(e.received_at)) / 86400000))} days
                        </div>
                      )}
                    </td>
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
                {/* Read left to right, this is the whole decision: the piece came back, an order
                    turned up, the two were matched, someone answered — and why. */}
                <tr>
                  <th>Order</th><th>Garment</th>
                  <th>Piece came back</th><th>Order placed</th><th>Matched</th>
                  <th>Answered</th><th>Why</th><th></th>
                </tr>
              </thead>
              <tbody>
                {skipPager.slice.map(h => (
                  <tr key={h.id} onClick={() => setStory(h)} style={{ cursor: 'pointer' }}>
                    <td className="cell-primary">
                      {h.order_ref}
                      {h.source === 'seeding' && <span className="rto-pill">seeding</span>}
                    </td>
                    <td data-label="Garment">{h.product_title}<div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{h.variant}</div></td>
                    <td data-label="Piece came back" style={{ fontSize: 12 }}>
                      <div>{day(h.shelf_received_at)}</div>
                      {/* How long it had been sitting here when the decision was made — the whole
                          reason for showing this date beside the others. */}
                      {h.shelf_received_at && h.resolved_at && (() => {
                        const d = Math.max(0, Math.round((new Date(h.resolved_at) - new Date(h.shelf_received_at)) / 86400000))
                        return (
                          <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                            {d === 0 ? 'answered the same day' : `${d} day${d === 1 ? '' : 's'} on the shelf by then`}
                          </div>
                        )
                      })()}
                    </td>
                    <td data-label="Order placed" style={{ fontSize: 12 }}>{day(h.order_date)}</td>
                    <td data-label="Matched" style={{ fontSize: 12 }}>{stamp(h.created_at)}</td>
                    <td data-label="Answered" style={{ fontSize: 12 }}>
                      <div>{stamp(h.resolved_at)}</div>
                      {h.resolved_by && <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>{h.resolved_by}</div>}
                    </td>
                    <td data-label="Why" style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>{h.resolution_note || '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      {/* Only a hand-cleared notice can come back; one answered by actually sending
                          a piece is a fact, not a decision to revisit. */}
                      {canEdit && <button className="mini-btn" onClick={(e) => { e.stopPropagation(); reopenAlert(h) }}>Reopen</button>}
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
                  <th>Received</th><th></th>
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
                    <td data-label="Received" style={{ fontSize: 12 }}>
                      <div>{day(e.created_at)}</div>
                      <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                        {since(e.created_at)}{e.created_by ? ` · ${e.created_by}` : ''}
                      </div>
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
                  <span style={{ flex: 1, textAlign: 'left' }}>
                    <b>{o.order_ref}</b>
                    <span style={{ color: 'var(--text-muted)' }}> · ordered {day(o.order_date)}</span>
                    {o.source === 'seeding' && <span className="rto-pill">seeding{o.customer ? ` · ${o.customer}` : ''}</span>}
                    {/* The order has gone out. If a fresh one was printed for it, the answer is
                        "didn't use it"; if this piece went in the box, "send to this". */}
                    {o.shipped && <span className="rto-pill rto-pill-warn" title="Fulfilled in Shopify — say what went in the box">shipped</span>}
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>matched {stamp(o.matched_at)}</div>
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

      {/* ---- The guide ----------------------------------------------------------------------
          Everything the spreadsheet round-trip can do, in the words a person at the shelf would
          use. Kept in the app rather than a document elsewhere, because the moment anyone needs
          it is the moment they have the file open. */}
      {help && (
        <div className="confirm-overlay" onClick={() => setHelp(false)}>
          <div className="confirm-card rto-guide" style={{ maxWidth: 640 }} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
            <h3 className="confirm-title">The shelf in Excel</h3>
            <p className="confirm-message">Export it, change it in a spreadsheet, import it back. You see every change before it happens.</p>

            <div className="rto-guide-body">
              <div className="form-section" style={{ marginTop: 4 }}>What the columns mean</div>
              <dl className="rto-guide-terms">
                <dt>received</dt><dd>How many of this garment came back in this entry. The only count you set.</dd>
                <dt>sent_out</dt><dd>How many of those have since gone out again to a customer order. Read-only.</dd>
                <dt>written_off</dt><dd>How many were damaged and scrapped from this entry — ruined in packing, found faulty, unsellable. Read-only.</dd>
                <dt>on_shelf</dt><dd><b>received − sent_out − written_off.</b> What is physically here now. Read-only — it moves when the other three do.</dd>
                <dt>from_order</dt><dd>The order it came back from, for the record.</dd>
                <dt>reason</dt><dd>Why it came back — Undelivered, refused, wrong size…</dd>
                <dt>id</dt><dd>The entry's number. Leave it alone: it is how the app knows which row you mean.</dd>
                <dt>delete</dt><dd>Empty on export. Type <b>yes</b> to remove that entry on import.</dd>
              </dl>

              <div className="form-section">Change an entry</div>
              <ol>
                <li><b>Export CSV</b> and open it.</li>
                <li>Edit <b>received</b>, <b>from_order</b>, <b>reason</b>, <b>note</b> or <b>location</b>. Keep the <b>id</b>.</li>
                <li>Save as CSV, then <b>Import CSV</b>. Check the plan, then <b>Apply</b>.</li>
              </ol>

              <div className="form-section">Increase or decrease a count</div>
              <p>
                Change <b>received</b> on the row and import. Going from 1 to 3 puts two more on the shelf;
                going from 3 to 2 takes one off. It cannot go below what has already gone out or been
                written off — those pieces have left. Every correction is written to the entry's history.
              </p>

              <div className="form-section">Add a new entry</div>
              <ol>
                <li>Download the <b>Product list for Excel</b> — every product and size, ready to fill in.</li>
                <li>Find the garment's row and type a number into <b>received</b>. Add <b>from_order</b> and <b>reason</b> if you know them.</li>
                <li>Delete the rows you did not fill in, or leave them — blanks are skipped. Import.</li>
              </ol>
              <p>A row with no <b>id</b> is always added as new. Never type a product name from memory — copy the row.</p>

              <div className="form-section">Delete an entry</div>
              <p>
                Type <b>yes</b> in the <b>delete</b> column of that row and import. Removing a row from the
                spreadsheet does <b>nothing</b> — the app cannot tell a deleted row from a filtered one.
                An entry that has already sent pieces out can only be deleted by an admin, and the
                blank credits it earned are reversed.
              </p>

              <div className="form-section">What never happens</div>
              <ul>
                <li>Nothing changes until you read the plan and click <b>Apply</b>.</li>
                <li>Rows missing from the file are left exactly as they are.</li>
                <li>A row the app cannot understand is skipped with a reason; the rest still go through.</li>
                <li><b>sent_out</b>, <b>written_off</b>, <b>on_shelf</b>, <b>added_by</b> and <b>added_at</b> are ignored on import.</li>
              </ul>
            </div>

            <div className="confirm-actions">
              <button className="btn btn-primary" onClick={() => setHelp(false)}>Got it</button>
            </div>
          </div>
        </div>
      )}

      {/* ---- What a CSV would do, before it does it -----------------------------------------
          The plan the server drew up from the file, laid out so the person can read every change
          before anything moves. Rejected rows are listed with their line number and reason, and
          are simply skipped — the good rows still go through. */}
      {csv && (() => {
        const { summary: sm, add, update, reject, delete: del = [] } = csv.plan
        const nothing = !sm.add && !sm.update && !(sm.delete || 0)
        const total = sm.add + sm.update + (sm.delete || 0)
        const CAP = 8
        const label = { qty: 'received', source_order_number: 'from order', reason: 'reason', note: 'note', location: 'location', garment: 'garment' }
        const one = (v) => (v == null || v === '' ? '—' : String(v))
        const fmt = (v) => (v && typeof v === 'object' ? `${one(v.from)} → ${one(v.to)}` : one(v))
        return (
          <div className="confirm-overlay" onClick={() => setCsv(null)}>
            <div className="confirm-card" style={{ maxWidth: 640 }} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
              <h3 className="confirm-title">Import {csv.file.name}</h3>
              <p className="confirm-message">
                {sm.rows} row{sm.rows === 1 ? '' : 's'} read. Nothing has changed yet — this is what applying it would do.
              </p>

              <div className="totals-bar" style={{ margin: '14px 0' }}>
                <div><span>Add</span><strong>{sm.add}</strong></div>
                <div><span>Change</span><strong>{sm.update}</strong></div>
                <div><span>Delete</span><strong style={{ color: sm.delete ? 'var(--danger)' : 'var(--text-muted)' }}>{sm.delete || 0}</strong></div>
                <div><span>Unchanged</span><strong style={{ color: 'var(--text-muted)' }}>{sm.unchanged}</strong></div>
                <div><span>Skip</span><strong style={{ color: sm.reject ? 'var(--warning)' : 'var(--text-muted)' }}>{sm.reject}</strong></div>
              </div>

              <div className="rto-lines" style={{ maxHeight: 340, textAlign: 'left' }}>
                {add.slice(0, CAP).map(a => (
                  <div className="rto-line" key={`a${a.line}`} style={{ cursor: 'default' }}>
                    <span className="rto-pill" style={{ marginLeft: 0 }}>add</span>
                    <span style={{ flex: 1 }}><b>{a.product}</b> <span style={{ color: 'var(--text-muted)' }}>{a.variant} × {a.qty}</span></span>
                    <span style={{ color: 'var(--text-muted)', fontSize: 11.5 }}>line {a.line}</span>
                  </div>
                ))}
                {add.length > CAP && <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: '2px 4px' }}>+{add.length - CAP} more to add</div>}

                {update.slice(0, CAP).map(u => (
                  <div className="rto-line" key={`u${u.line}`} style={{ cursor: 'default', alignItems: 'flex-start' }}>
                    <span className="rto-pill rto-pill-warn" style={{ marginLeft: 0 }}>change</span>
                    <span style={{ flex: 1 }}>
                      <b>{u.product}</b> <span style={{ color: 'var(--text-muted)' }}>{u.variant} · #{u.id}</span>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
                        {Object.entries(u.changes).map(([k, v]) => `${label[k] || k}: ${fmt(v)}`).join(' · ')}
                      </div>
                    </span>
                    <span style={{ color: 'var(--text-muted)', fontSize: 11.5 }}>line {u.line}</span>
                  </div>
                ))}
                {update.length > CAP && <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: '2px 4px' }}>+{update.length - CAP} more to change</div>}

                {del.slice(0, CAP).map(d => (
                  <div className="rto-line" key={`d${d.line}`} style={{ cursor: 'default', alignItems: 'flex-start', borderColor: 'color-mix(in srgb, var(--danger) 55%, var(--border))' }}>
                    <span className="rto-pill" style={{ marginLeft: 0, background: 'color-mix(in srgb, var(--danger) 18%, transparent)', color: 'var(--danger)' }}>delete</span>
                    <span style={{ flex: 1 }}>
                      <b>{d.product}</b> <span style={{ color: 'var(--text-muted)' }}>{d.variant} · #{d.id} · {d.qty} received</span>
                      {d.warning && <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 3 }}>{d.warning}</div>}
                    </span>
                    <span style={{ color: 'var(--text-muted)', fontSize: 11.5 }}>line {d.line}</span>
                  </div>
                ))}
                {del.length > CAP && <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: '2px 4px' }}>+{del.length - CAP} more to delete</div>}

                {reject.slice(0, CAP).map(r => (
                  <div className="rto-line" key={`r${r.line}`} style={{ cursor: 'default', alignItems: 'flex-start', borderColor: 'color-mix(in srgb, var(--danger) 40%, var(--border))' }}>
                    <span className="rto-pill" style={{ marginLeft: 0, background: 'color-mix(in srgb, var(--danger) 18%, transparent)', color: 'var(--danger)' }}>skip</span>
                    <span style={{ flex: 1 }}>
                      <span style={{ color: 'var(--text-muted)' }}>line {r.line}{r.product ? ` · ${r.product}${r.variant ? ` ${r.variant}` : ''}` : r.id ? ` · #${r.id}` : ''}</span>
                      <div style={{ fontSize: 12, marginTop: 3 }}>{r.reason}</div>
                    </span>
                  </div>
                ))}
                {reject.length > CAP && <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: '2px 4px' }}>+{reject.length - CAP} more skipped</div>}

                {nothing && !reject.length && (
                  <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: 12, textAlign: 'center' }}>
                    Every row matches what is already on the shelf. Nothing to do.
                  </div>
                )}
              </div>

              <p className="confirm-message" style={{ fontSize: 12.5 }}>
                Rows missing from the file are left alone. A row with an id changes that entry; a row
                without one is added; a row with <b>yes</b> in the <b>delete</b> column is removed. To
                add, copy a line from the product list and type a number into <b>received</b>.
              </p>

              <div className="confirm-actions">
                <button className="btn btn-secondary" onClick={() => setCsv(null)}>Cancel</button>
                <button className={`btn ${sm.delete ? 'btn-danger' : 'btn-primary'}`} disabled={busy === 'csv' || nothing} onClick={applyCsv}>
                  {busy === 'csv' ? 'Applying…' : nothing ? 'Nothing to apply'
                    : `Apply ${total} change${total === 1 ? '' : 's'}${sm.delete ? ` (${sm.delete} delete${sm.delete === 1 ? '' : 's'})` : ''}`}
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* ---- What happened to one notice, in order ------------------------------------------
          The table has room for the dates but not for what they mean. Here the four moments are
          laid out in the order they happened — and since a piece can come back before or after the
          order that wants it, they are sorted by date rather than assumed. */}
      {story && (
        <div className="confirm-overlay" onClick={() => setStory(null)}>
          <div className="confirm-card" style={{ maxWidth: 580 }} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
            <h3 className="confirm-title">{story.order_ref} · {story.product_title}</h3>
            <p className="confirm-message">
              {story.variant || '—'}
              {story.blank_type ? ` · ${story.blank_type} ${story.color || ''} ${story.size || ''}`.trimEnd() : ''}
              {story.source === 'seeding' ? ' · seeding order' : ''}
            </p>

            <div className="timeline" style={{ textAlign: 'left', margin: '14px 0 4px' }}>
              {[
                story.shelf_received_at && {
                  at: story.shelf_received_at, icon: '📦', title: 'The piece came back',
                  meta: [story.shelf_from_order && `from order ${story.shelf_from_order}`, story.shelf_reason,
                    story.shelf_logged_by && `logged by ${story.shelf_logged_by}`].filter(Boolean).join(' · '),
                },
                story.order_date && {
                  at: story.order_date, icon: '🛒', title: `Order ${story.order_ref} was placed`,
                  meta: story.customer || '',
                },
                story.created_at && {
                  at: story.created_at, icon: '🔗', title: 'Matched — the shelf had this garment',
                  meta: 'the notice appeared here from this moment',
                },
                story.resolved_at && {
                  at: story.resolved_at,
                  icon: story.status === 'used' ? '✅' : '✋',
                  title: story.status === 'used' ? 'Sent from the shelf' : 'Marked not used',
                  meta: [story.resolved_by && `by ${story.resolved_by}`, story.resolution_note].filter(Boolean).join(' · '),
                },
              ].filter(Boolean).sort((a, b) => new Date(a.at) - new Date(b.at)).map((e, i) => (
                <div className="timeline-item" key={i}>
                  <div className="timeline-type">{e.icon}</div>
                  <div className="timeline-content">
                    {e.title}
                    <div className="timeline-meta">{stamp(e.at)}{e.meta ? ` — ${e.meta}` : ''}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* The one number the dates are really being read for. */}
            {story.shelf_received_at && story.resolved_at && (() => {
              const d = Math.max(0, Math.round((new Date(story.resolved_at) - new Date(story.shelf_received_at)) / 86400000))
              return (
                <p className="confirm-message" style={{ fontSize: 12.5 }}>
                  {d === 0
                    ? <>The garment came back and this was decided <b>the same day</b>.</>
                    : <>The garment sat on the shelf for <b>{d} day{d === 1 ? '' : 's'}</b> before this was decided.</>}
                </p>
              )
            })()}

            <div className="confirm-actions">
              <button className="btn btn-secondary" onClick={() => setStory(null)}>Close</button>
              {canEdit && story.status !== 'used' && (
                <button className="btn btn-primary" onClick={() => { const h = story; setStory(null); reopenAlert(h) }}>
                  Put it back on the list
                </button>
              )}
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
