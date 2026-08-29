import { useState, useEffect } from 'react'
import { useApi, useAuth } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import SearchSelect from '../../components/SearchSelect'
import Pagination from '../../components/Pagination'
import useLocalPager from '../../hooks/useLocalPager'

const num = (v) => new Intl.NumberFormat('en-IN').format(Number(v) || 0)
const day = (v) => (v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—')

// The stage a request is at. A blank is held from 'In Production' — the point it is actually made.
const FLOW = ['Pending Approval', 'Approved', 'In Production', 'With Marketing', 'Returned']
const STATUS_CLASS = {
  'Pending Approval': 'pending', Approved: 'info', 'In Production': 'warning',
  'With Marketing': 'info', Returned: 'success', Cancelled: 'danger',
}

const blankItem = () => ({ product: '', variant: '', qty: 1, shopify_product_id: '', shopify_variant_id: '', blank_type: '', color: '', size: '' })
const blankForm = () => ({ purpose: '', requested_for: '', shoot_date: '', notes: '', items: [blankItem()] })

/**
 * Shoot samples — garments marketing borrows to photograph.
 *
 * What separates this from a seeding order is that the garment comes back. So the request is a
 * loan: approved, printed, lent out, returned — and at the end there is a finished piece on the
 * RTO shelf that a customer can still buy. The shelf is checked first, because a sample is exactly
 * the kind of thing a returned garment is good for.
 */
export default function SamplesTab() {
  const apiFetch = useApi()
  const toast = useToast()
  const { user } = useAuth()
  const isAdmin = ['owner', 'admin'].includes(user?.role)

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState(null)
  const [products, setProducts] = useState(null)
  const [takeFor, setTakeFor] = useState(null)   // { sample, lines }

  const load = async () => {
    const r = await apiFetch('/api/marketing/samples')
    if (r && !r.error) setData(r)
    else if (r?.error) toast.error(r.error)
    setLoading(false)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [])

  const openForm = async () => {
    setForm(blankForm())
    if (!products) {
      const r = await apiFetch('/api/inventory/products')
      if (r && !r.error) setProducts(r.products.filter(p => p.variants.length))
    }
  }
  const setF = (patch) => setForm(f => ({ ...f, ...patch }))
  const setItem = (i, patch) => setForm(f => ({ ...f, items: f.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) }))

  const save = async () => {
    if (!form.purpose.trim()) { toast.error('Say what the sample is for'); return }
    const items = form.items.filter(it => it.product && Number(it.qty) > 0)
    if (!items.length) { toast.error('Add at least one product'); return }
    setBusy(true)
    const res = await apiFetch('/api/marketing/samples', { method: 'POST', body: JSON.stringify({ ...form, items }) })
    setBusy(false)
    if (!res || res.error) { toast.error(res?.error || 'Failed to raise the request'); return }
    toast.success(`${res.ref} raised — waiting for approval`)
    setForm(null); load()
  }

  /** Move a request along. The server owns the stock rule; this only reports what it did. */
  const move = async (sample, status) => {
    if (status === 'Returned' && !await toast.confirm({
      title: `Mark ${sample.ref} as received back?`,
      message: 'The garments go onto the RTO shelf, where they can be sent to a customer order. Blank stock does not change — the blank was spent when they were printed.',
      details: sample.items.map(it => ({ label: it.product, value: `${it.variant || '—'} × ${it.qty}` })),
      confirmLabel: 'Received',
    })) return

    const res = await apiFetch(`/api/marketing/samples/${sample.id}/status`, {
      method: 'POST', body: JSON.stringify({ status }),
    })
    if (!res || res.error) { toast.error(res?.error || 'Failed'); return }

    const moved = (res.inventory?.deducted || []).map(d => `${d.blank_type} ${d.color} ${d.size} −${d.qty}`).join(' · ')
    const shelved = (res.shelved?.added || []).length
    toast.success(
      `${res.ref} · ${status}`
      + (moved ? ` — blanks: ${moved}` : res.inventory?.released ? ' — blanks put back' : '')
      + (shelved ? ` · ${shelved} piece${shelved === 1 ? '' : 's'} on the RTO shelf` : ''))
    if (res.inventory?.unmapped?.length) {
      toast.error(res.inventory.unmapped.map(u => `${u.product} — ${u.reason}`).join(' · '),
        { title: 'Not deducted from blank stock', duration: 0 })
    }
    load()
  }

  const takeFromShelf = async (sample, line) => {
    const entry = line.entry_id
    if (!entry) { toast.error('That piece is no longer on the shelf'); return }
    const res = await apiFetch(`/api/marketing/samples/${sample.id}/take-from-rto`, {
      method: 'POST', body: JSON.stringify({ rto_id: entry, qty: 1 }),
    })
    if (!res || res.error) { toast.error(res?.error || 'Failed'); return }
    toast.success(`${res.ref} filled from the RTO shelf — nothing printed, no blank used`)
    setTakeFor(null); load()
  }

  const remove = async (sample) => {
    if (!await toast.confirm({
      title: `Delete ${sample.ref}?`,
      message: 'Any blanks still held for it are given back.',
      confirmLabel: 'Delete', danger: true,
    })) return
    const res = await apiFetch(`/api/marketing/samples/${sample.id}`, { method: 'DELETE' })
    if (!res || res.error) { toast.error(res?.error || 'Failed'); return }
    toast.success('Request deleted'); load()
  }

  const samples = data?.samples || []
  const pager = useLocalPager(samples, 10)

  if (loading) return <div className="loader"><div className="spinner" /><span>Loading sample requests…</span></div>
  if (!data) return <div className="empty-state"><p>Sample requests could not be loaded.</p></div>

  const s = data.summary || {}
  const onShelf = data.onShelf || {}
  const nextStage = (status) => FLOW[FLOW.indexOf(status) + 1]
  const product = (id) => (products || []).find(p => String(p.shopify_id) === String(id))

  return (
    <>
      <div className="dash-toolbar">
        <div>
          <p style={{ color: 'var(--text-muted)' }}>
            Garments borrowed for a shoot. Approved first, then printed — and when they come back
            they go onto the RTO shelf, because a photographed garment can still be sold.
          </p>
        </div>
        <button className="btn btn-primary" onClick={openForm}>
          <Icon name="plus" size={15} style={{ marginRight: 6, verticalAlign: '-2px' }} />
          Request a sample
        </button>
      </div>

      <div className="kpi-grid" style={{ marginBottom: 18 }}>
        {[
          { icon: 'alert', label: 'Waiting for approval', value: num(s.awaiting) },
          { icon: 'shirt', label: 'In production', value: num(s.in_production) },
          { icon: 'box', label: 'Out with marketing', value: num(s.out) },
          { icon: 'trending', label: 'Returned', value: num(s.returned) },
        ].map(k => (
          <div className="kpi-card" key={k.label}>
            <div className="kpi-head"><div className="kpi-icon"><Icon name={k.icon} size={20} /></div></div>
            <div className="kpi-value">{k.value}</div>
            <div className="kpi-label">{k.label}</div>
          </div>
        ))}
      </div>

      {!samples.length ? (
        <div className="empty-state">
          <div className="empty-icon">📸</div>
          <p>No sample requests yet. Raise one and it goes to an admin for approval.</p>
        </div>
      ) : (
        <div className="data-table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Ref</th><th>Purpose</th><th>Items</th><th>Shoot</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {pager.slice.map(x => {
                const shelf = onShelf[x.id] || []
                const next = nextStage(x.status)
                return (
                  <tr key={x.id}>
                    <td className="cell-primary">
                      <span className="badge-primary">{x.ref}</span>
                      {x.from_rto && <span className="rto-pill">from the shelf</span>}
                    </td>
                    <td data-label="Purpose">
                      {x.purpose}
                      {x.requested_for && <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{x.requested_for}</div>}
                    </td>
                    <td data-label="Items">
                      {x.items.map((it, i) => (
                        <div key={i} style={{ fontSize: 12.5 }}>
                          {it.product} <span style={{ color: 'var(--text-muted)' }}>{it.variant} × {it.qty}</span>
                        </div>
                      ))}
                      {/* The whole reason to check: a piece already exists, so nothing needs printing. */}
                      {!!shelf.length && (
                        <button className="rto-tag" style={{ marginTop: 4, cursor: 'pointer', border: 'none' }}
                          onClick={() => setTakeFor({ sample: x, lines: shelf })}>
                          ↩ {shelf.length} on the RTO shelf — use one
                        </button>
                      )}
                    </td>
                    <td data-label="Shoot">{day(x.shoot_date)}</td>
                    <td data-label="Status">
                      <span className={`status-badge ${STATUS_CLASS[x.status] || 'pending'}`}>{x.status}</span>
                      {x.approved_by && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>by {x.approved_by}</div>}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {x.status === 'Pending Approval' && data.canApprove && (
                        <button className="mini-btn mini-btn-active" onClick={() => move(x, 'Approved')}>Approve</button>
                      )}
                      {x.status !== 'Pending Approval' && next && (
                        <button className="mini-btn mini-btn-active" onClick={() => move(x, next)}>
                          {next === 'Returned' ? 'Mark received' : `→ ${next}`}
                        </button>
                      )}
                      {!['Returned', 'Cancelled'].includes(x.status) && (
                        <button className="mini-btn" style={{ marginLeft: 6 }} onClick={() => move(x, 'Cancelled')}>Cancel</button>
                      )}
                      {isAdmin && (
                        <button className="mini-btn mini-btn-danger" style={{ marginLeft: 6 }} onClick={() => remove(x)}>Delete</button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <Pagination table={pager.table} noun="requests" />
        </div>
      )}

      {/* ---- Raise a request ---------------------------------------------------------- */}
      {form && (
        <div className="confirm-overlay" onClick={() => setForm(null)}>
          <div className="confirm-card" style={{ maxWidth: 640 }} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
            <h3 className="confirm-title">Request a sample</h3>
            <div className="input-group">
              <label>What is it for</label>
              <input value={form.purpose} autoFocus placeholder="Diwali campaign shoot"
                onChange={e => setF({ purpose: e.target.value })} />
            </div>
            <div className="form-row">
              <div className="input-group">
                <label>Who or where <span style={{ color: 'var(--text-muted)' }}>optional</span></label>
                <input value={form.requested_for} placeholder="Creator, studio or event"
                  onChange={e => setF({ requested_for: e.target.value })} />
              </div>
              <div className="input-group">
                <label>Shoot date <span style={{ color: 'var(--text-muted)' }}>optional</span></label>
                <input type="date" value={form.shoot_date} onChange={e => setF({ shoot_date: e.target.value })} />
              </div>
            </div>

            {form.items.map((it, i) => {
              const p = product(it.shopify_product_id)
              return (
                <div className="form-row" key={i} style={{ alignItems: 'end' }}>
                  <div className="input-group">
                    <label>Design</label>
                    <SearchSelect value={it.shopify_product_id} placeholder="Type to search products…"
                      options={(products || []).map(x => ({ value: x.shopify_id, label: x.title, hint: x.blank_type || '' }))}
                      onChange={(v, opt) => setItem(i, { shopify_product_id: v, product: opt?.label || '', shopify_variant_id: '', variant: '', blank_type: (products || []).find(x => String(x.shopify_id) === String(v))?.blank_type || '' })} />
                  </div>
                  <div className="input-group">
                    <label>Colour / size</label>
                    <SearchSelect value={it.shopify_variant_id} disabled={!p}
                      placeholder={p ? 'Type to search…' : 'Pick a design first'}
                      options={(p?.variants || []).map(v => ({ value: v.variant_id, label: v.variant }))}
                      onChange={(v) => {
                        const variant = p?.variants.find(x => String(x.variant_id) === String(v))
                        setItem(i, { shopify_variant_id: v, variant: variant?.variant || '', color: variant?.color || '', size: variant?.size || '' })
                      }} />
                  </div>
                  <div className="input-group" style={{ maxWidth: 90 }}>
                    <label>Qty</label>
                    <input type="number" min="1" value={it.qty} onChange={e => setItem(i, { qty: e.target.value })} />
                  </div>
                  {form.items.length > 1 && (
                    <button className="mini-btn" style={{ marginBottom: 14 }}
                      onClick={() => setF({ items: form.items.filter((_, j) => j !== i) })}>×</button>
                  )}
                </div>
              )
            })}
            <button className="mini-btn" onClick={() => setF({ items: [...form.items, blankItem()] })}>+ Another product</button>

            <div className="input-group" style={{ marginTop: 12 }}>
              <label>Note <span style={{ color: 'var(--text-muted)' }}>optional</span></label>
              <input value={form.notes} onChange={e => setF({ notes: e.target.value })} />
            </div>
            <p className="confirm-message" style={{ fontSize: 12.5 }}>
              It goes to an admin for approval. Nothing is printed and no blank moves until production starts.
            </p>
            <div className="confirm-actions">
              <button className="btn btn-secondary" onClick={() => setForm(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Raise the request'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ---- Take one off the RTO shelf ------------------------------------------------ */}
      {takeFor && (
        <div className="confirm-overlay" onClick={() => setTakeFor(null)}>
          <div className="confirm-card" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
            <h3 className="confirm-title">Use a returned piece for {takeFor.sample.ref}</h3>
            <p className="confirm-message">
              These are already printed and sitting on the shelf. Taking one means nothing is made
              for this request, so no blank is spent — and it goes back on the shelf when it returns.
            </p>
            <div className="rto-lines">
              {takeFor.lines.map((l, i) => (
                <div className="rto-line" key={i}>
                  <span style={{ flex: 1 }}>
                    <b>{l.product_title}</b>
                    <span style={{ color: 'var(--text-muted)' }}> · {l.variant} · {l.available} on the shelf</span>
                  </span>
                  <button className="mini-btn mini-btn-active" onClick={() => takeFromShelf(takeFor.sample, l)}>Use this one</button>
                </div>
              ))}
            </div>
            <div className="confirm-actions">
              <button className="btn btn-secondary" onClick={() => setTakeFor(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
