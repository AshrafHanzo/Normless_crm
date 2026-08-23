import { useState, useEffect } from 'react'
import { useApi, useAuth } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import SearchSelect from '../../components/SearchSelect'

const num = (v) => new Intl.NumberFormat('en-IN').format(Number(v) || 0)
const day = (v) => (v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—')

const STAGES = ['printing', 'stitching', 'packing', 'courier', 'other']

/**
 * Write-offs.
 *
 * A ruined blank and a ruined printed piece are not the same loss and do not come off the same
 * shelf, so which one it was is recorded rather than assumed: a blank leaves blank stock, while a
 * printed piece has already spent its blank and only leaves the RTO shelf if that is where it was.
 */
export default function DamagedTab({ onCounts }) {
  const apiFetch = useApi()
  const toast = useToast()
  const { user } = useAuth()
  const canEdit = ['owner', 'admin'].includes(user?.role) || !!user?.can_edit_inventory

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState(null)
  const [blanks, setBlanks] = useState(null)   // catalogue for the blank picker
  const [products, setProducts] = useState(null)
  const [focus, setFocus] = useState(null)    // null | 'blank' | 'finished' | 'last30'
  const [query, setQuery] = useState('')

  const load = async () => {
    const r = await apiFetch('/api/inventory/damaged')
    if (r && !r.error) { setData(r); onCounts?.(r.summary || {}) }
    else if (r?.error) toast.error(r.error)
    setLoading(false)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [])

  const open = async () => {
    setForm({ kind: 'blank', blank_type: '', color: '', size: '', shopify_product_id: '', variant_id: '', qty: 1, stage: 'printing', reason: '', note: '' })
    if (!blanks) {
      const r = await apiFetch('/api/inventory')
      if (r && !r.error) setBlanks([...(r.catalog || []), ...(r.items || []).map(i => ({ blank_type: i.blank_type, color: i.color, size: i.size }))])
    }
    if (!products) {
      const r = await apiFetch('/api/inventory/products')
      if (r && !r.error) setProducts(r.products.filter(p => p.variants.length))
    }
  }

  const set = (patch) => setForm(f => ({ ...f, ...patch }))

  const save = async () => {
    const qty = Number(form.qty)
    if (!Number.isFinite(qty) || qty < 1) { toast.error('Quantity must be 1 or more'); return }
    if (!form.reason.trim()) { toast.error('Say what went wrong'); return }
    if (form.kind === 'blank' && (!form.blank_type || !form.color || !form.size)) { toast.error('Pick the blank, colour and size'); return }
    if (form.kind === 'finished' && !form.variant_id) { toast.error('Pick the design and size'); return }

    const product = (products || []).find(p => String(p.shopify_id) === String(form.shopify_product_id))
    const variant = product?.variants.find(v => String(v.variant_id) === String(form.variant_id))

    setBusy(true)
    const res = await apiFetch('/api/inventory/damaged', {
      method: 'POST',
      body: JSON.stringify(form.kind === 'blank'
        ? { kind: 'blank', blank_type: form.blank_type, color: form.color, size: form.size, qty, stage: form.stage, reason: form.reason.trim(), note: form.note || null }
        : {
          kind: 'finished', shopify_product_id: product?.shopify_id, variant_id: variant?.variant_id,
          product_title: product?.title, variant: variant?.variant,
          blank_type: product?.blank_type, color: variant?.color, size: variant?.size,
          qty, stage: form.stage, reason: form.reason.trim(), note: form.note || null,
        }),
    })
    setBusy(false)
    if (!res || res.error) { toast.error(res?.error || 'Failed to record'); return }
    toast.success(form.kind === 'blank'
      ? `${qty} ${form.blank_type} ${form.color} ${form.size} written off — blank stock reduced`
      : `${qty} piece${qty > 1 ? 's' : ''} written off`)
    setForm(null); load()
  }

  const remove = async (row) => {
    if (!await toast.confirm({
      title: 'Undo this write-off?',
      message: row.movement_id
        ? 'The blank it took out of stock is put back, recorded as its own correction so the ledger keeps both halves.'
        : 'The entry is removed. If it came off the RTO shelf, the piece goes back on it.',
      details: [
        { label: 'Item', value: row.kind === 'blank' ? `${row.blank_type} ${row.color} ${row.size}` : `${row.product_title} ${row.variant || ''}` },
        { label: 'Quantity', value: String(row.qty) },
      ],
      confirmLabel: 'Undo', danger: true,
    })) return
    const res = await apiFetch(`/api/inventory/damaged/${row.id}`, { method: 'DELETE' })
    if (!res || res.error) { toast.error(res?.error || 'Failed'); return }
    toast.success('Write-off undone'); load()
  }

  if (loading) return <div className="loader"><div className="spinner" /><span>Loading write-offs…</span></div>
  if (!data) return <div className="empty-state"><p>Damaged stock could not be loaded.</p></div>

  const s = data.summary || {}
  const colorsFor = (t) => [...new Set((blanks || []).filter(b => b.blank_type === t).map(b => b.color))].sort()
  const sizesFor = (t, c) => [...new Set((blanks || []).filter(b => b.blank_type === t && b.color === c).map(b => b.size))]
  const types = [...new Set((blanks || []).map(b => b.blank_type))].sort()
  const product = (products || []).find(p => String(p.shopify_id) === String(form?.shopify_product_id))

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const monthAgo = Date.now() - 30 * 864e5
  const visible = (data.rows || []).filter(r => {
    if (focus === 'blank' && r.kind !== 'blank') return false
    if (focus === 'finished' && r.kind !== 'finished') return false
    if (focus === 'last30' && new Date(r.created_at).getTime() < monthAgo) return false
    if (!words.length) return true
    const hay = `${r.product_title || ''} ${r.variant || ''} ${r.blank_type || ''} ${r.color || ''} ${r.size || ''} ${r.reason || ''} ${r.stage || ''}`.toLowerCase()
    return words.every(w => hay.includes(w))
  })
  const filtered = !!focus || !!words.length

  return (
    <>
      <div className="dash-toolbar">
        <div>
          <p style={{ color: 'var(--text-muted)' }}>
            Garments ruined in production or in transit. A blank written off leaves blank stock; a
            printed piece does not, because its blank was already spent.
          </p>
        </div>
        {canEdit && <button className="btn btn-primary" onClick={open}>Record damage</button>}
      </div>

      <div className="kpi-grid" style={{ marginBottom: 18 }}>
        {[
          { icon: 'alert', label: 'Written off, all time', value: num(s.total), key: 'all' },
          { icon: 'box', label: 'Blanks ruined', value: num(s.blanks), key: 'blank' },
          { icon: 'shirt', label: 'Printed pieces ruined', value: num(s.finished), key: 'finished' },
          { icon: 'trending', label: 'Last 30 days', value: num(s.last30), key: 'last30' },
        ].map(k => (
          <div className={`kpi-card kpi-clickable ${focus === k.key || (k.key === 'all' && !focus) ? 'kpi-active' : ''}`} key={k.label}
            onClick={() => setFocus(k.key === 'all' ? null : (focus === k.key ? null : k.key))}
            title="Show only these write-offs">
            <div className="kpi-head"><div className="kpi-icon"><Icon name={k.icon} size={20} /></div></div>
            <div className="kpi-value">{k.value}</div>
            <div className="kpi-label">{k.label}</div>
          </div>
        ))}
      </div>

      {/* Where the losses happen is the reason to keep this data at all. */}
      {!!(data.byStage || []).length && s.total > 0 && (
        <div className="card" style={{ marginBottom: 18 }}>
          <h2 style={{ fontSize: 15, marginBottom: 10 }}>Where it goes wrong</h2>
          <div className="gap-list">
            {data.byStage.map(b => (
              <span className="gap-chip" key={b.stage}>{b.stage} · {num(b.qty)}</span>
            ))}
          </div>
        </div>
      )}

      {(data.rows || []).length > 1 && (
        <div className="filters-row" style={{ marginBottom: 12 }}>
          <div className="search-bar" style={{ flex: 1 }}>
            <input value={query} placeholder="Filter by product, blank, reason or stage…"
              onChange={e => setQuery(e.target.value)} />
          </div>
          {filtered && (
            <button className="mini-btn" onClick={() => { setFocus(null); setQuery('') }}>
              Showing {visible.length} of {data.rows.length} · clear
            </button>
          )}
        </div>
      )}

      <div className="data-table-wrapper">
        {!(data.rows || []).length ? (
          <div className="empty-state">
            <div className="empty-icon">🧵</div>
            <p>Nothing written off yet.</p>
          </div>
        ) : !visible.length ? (
          <div className="empty-state">
            <div className="empty-icon">🔍</div>
            <p>No write-offs match that.</p>
            <button className="btn btn-secondary" style={{ marginTop: 12 }} onClick={() => { setFocus(null); setQuery('') }}>Show everything</button>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Item</th><th>What it was</th><th>Stage</th><th>Reason</th>
                <th style={{ textAlign: 'right' }}>Qty</th><th>Recorded</th><th></th>
              </tr>
            </thead>
            <tbody>
              {visible.map(r => (
                <tr key={r.id}>
                  <td className="cell-primary">
                    {r.kind === 'blank'
                      ? `${r.blank_type} ${r.color} ${r.size}`
                      : <>{r.product_title}<div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{r.variant}</div></>}
                  </td>
                  <td data-label="What it was">
                    <span className={`rto-pill ${r.kind === 'blank' ? '' : 'rto-pill-warn'}`}>
                      {r.kind === 'blank' ? 'blank' : r.rto_id ? 'from the RTO shelf' : 'printed piece'}
                    </span>
                  </td>
                  <td data-label="Stage" style={{ color: 'var(--text-muted)' }}>{r.stage || '—'}</td>
                  <td data-label="Reason">{r.reason}{r.note && <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{r.note}</div>}</td>
                  <td data-label="Qty" style={{ textAlign: 'right', fontWeight: 700 }}>{r.qty}</td>
                  <td data-label="Recorded" style={{ fontSize: 12 }}>
                    <div>{day(r.created_at)}</div>
                    {r.created_by && <div style={{ color: 'var(--text-muted)' }}>{r.created_by}</div>}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {canEdit && <button className="mini-btn" onClick={() => remove(r)}>Undo</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {form && (
        <div className="confirm-overlay" onClick={() => setForm(null)}>
          <div className="confirm-card" style={{ maxWidth: 620 }} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
            <h3 className="confirm-title">Record damage</h3>
            <div className="scan-tabs" style={{ marginBottom: 14 }}>
              <button className={form.kind === 'blank' ? 'active' : ''} onClick={() => set({ kind: 'blank' })}>A blank was ruined</button>
              <button className={form.kind === 'finished' ? 'active' : ''} onClick={() => set({ kind: 'finished' })}>A printed piece was ruined</button>
            </div>

            {form.kind === 'blank' ? (
              <div className="form-row">
                <div className="input-group">
                  <label>Blank</label>
                  <select value={form.blank_type} onChange={e => set({ blank_type: e.target.value, color: '', size: '' })}>
                    <option value="">Choose…</option>
                    {types.map(t => <option key={t}>{t}</option>)}
                  </select>
                </div>
                <div className="input-group">
                  <label>Colour</label>
                  <select value={form.color} disabled={!form.blank_type} onChange={e => set({ color: e.target.value, size: '' })}>
                    <option value="">Choose…</option>
                    {colorsFor(form.blank_type).map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
                <div className="input-group">
                  <label>Size</label>
                  <select value={form.size} disabled={!form.color} onChange={e => set({ size: e.target.value })}>
                    <option value="">Choose…</option>
                    {sizesFor(form.blank_type, form.color).map(z => <option key={z}>{z}</option>)}
                  </select>
                </div>
              </div>
            ) : (
              <div className="form-row">
                <div className="input-group">
                  <label>Design</label>
                  <SearchSelect value={form.shopify_product_id} placeholder="Type to search products…"
                    options={(products || []).map(p => ({ value: p.shopify_id, label: p.title, hint: p.blank_type || p.product_type || '' }))}
                    onChange={(v) => set({ shopify_product_id: v, variant_id: '' })} />
                </div>
                <div className="input-group">
                  <label>Colour / size</label>
                  <SearchSelect value={form.variant_id} disabled={!product}
                    placeholder={product ? 'Type to search…' : 'Pick a design first'}
                    options={(product?.variants || []).map(v => ({ value: v.variant_id, label: v.variant }))}
                    onChange={(v) => set({ variant_id: v })} />
                </div>
              </div>
            )}

            <div className="form-row">
              <div className="input-group">
                <label>How many</label>
                <input type="number" min="1" value={form.qty} onChange={e => set({ qty: e.target.value })} />
              </div>
              <div className="input-group">
                <label>At which stage</label>
                <select value={form.stage} onChange={e => set({ stage: e.target.value })}>
                  {STAGES.map(st => <option key={st}>{st}</option>)}
                </select>
              </div>
            </div>
            <div className="input-group">
              <label>What went wrong</label>
              <input value={form.reason} autoFocus placeholder="Print misaligned"
                onChange={e => set({ reason: e.target.value })}
                onKeyDown={e => { if (e.key === 'Enter') save() }} />
            </div>
            <div className="input-group">
              <label>Note <span style={{ color: 'var(--text-muted)' }}>optional</span></label>
              <input value={form.note} onChange={e => set({ note: e.target.value })} />
            </div>

            <p className="confirm-message" style={{ fontSize: 12.5 }}>
              {form.kind === 'blank'
                ? 'This comes straight out of blank stock, recorded in the ledger as a write-off.'
                : 'Blank stock is untouched — that blank was already spent on the print. To write off a piece from the RTO shelf, use the Damaged button on its row there so it also leaves the shelf.'}
            </p>

            <div className="confirm-actions">
              <button className="btn btn-secondary" onClick={() => setForm(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Record'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
