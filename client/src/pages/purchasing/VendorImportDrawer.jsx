import { useState } from 'react'
import { Link } from 'react-router-dom'
import Icon from '../../components/Icon'
import useDirtyGuard from '../../hooks/useDirtyGuard'
import useErrorInView from './useErrorInView'
import { BRAND_LABEL, inr, day } from './format'

const BRANDS = ['normless', 'crewfit']

/** Turn what the server read into what the form edits. */
const toForm = (s) => ({
  ...s,
  include: !s.duplicate,
  vendor_id: s.vendor_match ? String(s.vendor_match.id) : 'new',
  new_vendor_name: s.vendor_match ? '' : s.vendor_guess,
  brand: 'normless',
  title: '',
  make_plan: true,
  products: s.products.map(p => ({ ...p, ordered: String(p.received || '') })),
})

function Sheet({ s, vendors, onChange }) {
  const set = (patch) => onChange({ ...s, ...patch })
  const setDate = (key, i, date) => set({ [key]: s[key].map((x, n) => (n === i ? { ...x, date, ambiguous: false } : x)) })
  const flaggedDel = s.deliveries.filter(d => d.ambiguous).length
  const flaggedPay = s.payments.filter(p => p.ambiguous).length
  const instN = s.total && s.instalment ? Math.round(s.total / s.instalment) : null

  return (
    <div className={`line-item-card vi-sheet ${s.include ? '' : 'vi-off'}`}>
      <div className="line-item-header">
        <span>{s.tab}</span>
        <label className="pp-default" style={{ margin: 0 }}>
          <input type="checkbox" checked={s.include} onChange={e => set({ include: e.target.checked })} />
          <span><b>Import this sheet</b></span>
        </label>
      </div>
      {s.duplicate && <div className="calc-warning">Already in the CRM as {s.duplicate} — leave this one out.</div>}
      {s.warnings.map(w => <div key={w} className="calc-warning">{w}</div>)}

      <div className="vi-checks">
        {s.checks.map(c => (
          <span key={c.what} className={`status-badge ${c.ok ? 'fulfilled' : 'refunded'}`} title={c.ok ? 'Matches the sheet' : `The sheet says ${c.sheet}, the rows add up to ${c.counted}`}>
            {c.ok ? '✓' : '✗'} {c.what} {c.what.includes('received') ? c.counted : inr(c.counted)}
          </span>
        ))}
      </div>

      <div className="form-row">
        <div className="input-group">
          <label>Vendor *</label>
          <select value={s.vendor_id} onChange={e => set({ vendor_id: e.target.value })}>
            <option value="new">New vendor…</option>
            {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
          {s.vendor_id === 'new' && <input value={s.new_vendor_name} onChange={e => set({ new_vendor_name: e.target.value })} placeholder="Vendor name" aria-label="New vendor name" style={{ marginTop: 6 }} />}
        </div>
        <div className="input-group">
          <label>For</label>
          <div className="chip-picker">
            {BRANDS.map(b => <button type="button" key={b} className={`chip ${s.brand === b ? 'chip-on' : ''}`} aria-pressed={s.brand === b} onClick={() => set({ brand: b })}>{BRAND_LABEL[b]}</button>)}
          </div>
        </div>
        <div className="input-group">
          <label>Order date *</label>
          <input type="date" value={s.order_date || ''} onChange={e => set({ order_date: e.target.value })} />
        </div>
      </div>
      <div className="form-row">
        <div className="input-group"><label>Quotation</label><input value={s.quote_no || ''} onChange={e => set({ quote_no: e.target.value })} /></div>
        <div className="input-group"><label>Title<span className="unit-hint"> optional</span></label><input value={s.title} onChange={e => set({ title: e.target.value })} placeholder="e.g. Masks + disk sets" /></div>
        <div className="input-group"><label>Total billed (incl. GST)</label><input type="number" value={s.total ?? ''} onChange={e => set({ total: e.target.value })} /></div>
      </div>

      <div className="form-section">Quantity ordered <span className="unit-hint" style={{ textTransform: 'none', letterSpacing: 0 }}>— the sheet doesn’t say; what’s still to come is worked out from this</span></div>
      <div className="dl-simple">
        <div className="dl-row dl-head" style={{ gridTemplateColumns: 'minmax(0,1.4fr) 100px minmax(0,1fr)' }}><span>Product</span><span>Received</span><span>Ordered *</span></div>
        {s.products.map((p, i) => (
          <div key={p.name} className="dl-row" style={{ gridTemplateColumns: 'minmax(0,1.4fr) 100px minmax(0,1fr)' }}>
            <b>{p.name}</b><span className="dl-pending">{p.received}</span>
            <input type="number" min="0" value={p.ordered} aria-label={`${p.name} ordered`}
              onChange={e => set({ products: s.products.map((x, n) => (n === i ? { ...x, ordered: e.target.value } : x)) })} />
          </div>
        ))}
      </div>

      <details className="vi-details" open={flaggedDel > 0}>
        <summary>{s.deliveries.length} deliveries{flaggedDel ? ` — ${flaggedDel} date${flaggedDel > 1 ? 's' : ''} to check` : ''}</summary>
        <div className="vi-dates">
          {s.deliveries.map((d, i) => (
            <div key={i} className={`vi-date ${d.ambiguous ? 'flag' : ''}`}>
              <span className="vp-mono">{d.raw}</span>
              <input type="date" value={d.date} onChange={e => setDate('deliveries', i, e.target.value)} aria-label={`Delivery written as ${d.raw}`} />
              <span>{Object.entries(d.qty).map(([k, v]) => `${k} × ${v}`).join(', ')}</span>
            </div>
          ))}
        </div>
      </details>
      <details className="vi-details" open={flaggedPay > 0}>
        <summary>{s.payments.length} payments{flaggedPay ? ` — ${flaggedPay} date${flaggedPay > 1 ? 's' : ''} to check` : ''}</summary>
        <div className="vi-dates">
          {s.payments.map((p, i) => (
            <div key={i} className={`vi-date ${p.ambiguous ? 'flag' : ''}`}>
              <span className="vp-mono">{p.raw}</span>
              <input type="date" value={p.date} onChange={e => setDate('payments', i, e.target.value)} aria-label={`Payment written as ${p.raw}`} />
              <span>{inr(p.amount)}{p.ambiguous && p.other ? ` · could be ${day(p.other)}` : ''}</span>
            </div>
          ))}
        </div>
        <p className="dl-hint">The sheet has no mode or UTR — these come in marked “Add UTR”.</p>
      </details>

      {instN && Math.abs(instN * s.instalment - s.total) <= 1 && (
        <label className="pp-default">
          <input type="checkbox" checked={s.make_plan} onChange={e => set({ make_plan: e.target.checked })} />
          <span><b>Payment plan: {instN} × {inr(s.instalment)}</b><em>The paid ones are dated by their payments; the rest wait for a date.</em></span>
        </label>
      )}
    </div>
  )
}

/** Import the old vendor tracker sheets (.xlsx with a tab per quotation, or one .csv). */
export default function VendorImportDrawer({ apiFetch, toast, onClose, onDone }) {
  const [file, setFile] = useState(null)
  const [reading, setReading] = useState(false)
  const [data, setData] = useState(null)     // { vendors, sheets }
  const [saving, setSaving] = useState(false)
  const [results, setResults] = useState(null)
  const [error, setError] = useState('')
  const errorRef = useErrorInView(error)

  const guard = useDirtyGuard({
    snapshot: data?.sheets || null, identity: data ? 'read' : 'empty', onDiscard: onClose, confirm: toast.confirm,
    title: 'Close without importing?', message: 'What was read from the sheet hasn’t been imported.',
  })

  const read = async () => {
    if (!file) return
    setReading(true); setError(''); setResults(null)
    const fd = new FormData()
    fd.append('file', file)
    const r = await apiFetch('/api/vendor-import/preview', { method: 'POST', body: fd })
    setReading(false)
    if (!r || r.error) { setError(r?.error || 'That file couldn’t be read'); return }
    setData({ vendors: r.vendors, sheets: r.sheets.map(toForm) })
    guard.reset()
  }

  const commit = async () => {
    setSaving(true); setError('')
    const sheets = data.sheets.filter(s => s.include).map(s => ({
      ...s, vendor_id: s.vendor_id === 'new' ? null : Number(s.vendor_id),
      products: s.products.map(p => ({ name: p.name, ordered: p.ordered })),
    }))
    const r = await apiFetch('/api/vendor-import/commit', { method: 'POST', body: JSON.stringify({ sheets }) })
    setSaving(false)
    if (!r || r.error) { setError(r?.error || 'The import didn’t go through'); return }
    setResults(r.results)
    setData(null); guard.reset()
    const made = r.results.filter(x => x.ref).length
    if (made) toast.success(`${made} order${made > 1 ? 's' : ''} imported`)
    onDone()
  }

  const included = data?.sheets.filter(s => s.include).length || 0

  return (
    <div className="drawer-overlay" onClick={guard.requestClose}>
      <div className="drawer drawer-wide" onClick={e => e.stopPropagation()} role="dialog" aria-label="Import tracker sheets">
        <div className="drawer-header">
          <div>
            <h2 style={{ fontSize: 17 }}>Import tracker sheets</h2>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>The old vendor sheets: quotation, deliveries by date and payments — one order per tab</div>
          </div>
          <button className="btn-icon" onClick={guard.requestClose} aria-label="Close"><Icon name="close" size={16} /></button>
        </div>

        <div className="drawer-body">
          {error && <div className="calc-warning" role="alert" ref={errorRef}>{error}</div>}

          {results && (
            <div className="vo-payments">
              {results.map((x, i) => (
                <div key={i} className="vo-payment" style={{ gridTemplateColumns: '1fr 2fr' }}>
                  <b>{x.quote_no || 'Sheet'}</b>
                  <span>{x.ref ? <>Imported as <Link to={`/vendors/${x.vendor_id}`}>{x.ref}</Link> for {x.vendor}{x.planned ? ` · plan of ${x.planned}` : ''}</>
                    : x.skipped ? `Skipped — ${x.skipped}` : <span style={{ color: 'var(--danger)' }}>Failed — {x.error}</span>}</span>
                </div>
              ))}
            </div>
          )}

          {!data && (
            <div className="input-group">
              <label htmlFor="vi-file">Tracker file</label>
              <input id="vi-file" type="file" accept=".xlsx,.csv" onChange={e => setFile(e.target.files?.[0] || null)} />
              <p className="dl-hint">From Google Sheets: File → Download → Microsoft Excel (.xlsx) for every tab at once, or Comma-separated values (.csv) for one tab.</p>
              <div><button className="btn btn-primary" disabled={!file || reading} onClick={read}>{reading ? 'Reading…' : 'Read the file'}</button></div>
            </div>
          )}

          {data?.sheets.map((s, i) => (
            <Sheet key={`${s.tab}-${i}`} s={s} vendors={data.vendors}
              onChange={(next) => setData(d => ({ ...d, sheets: d.sheets.map((x, n) => (n === i ? next : x)) }))} />
          ))}
        </div>

        <div className="drawer-footer">
          <button className="btn btn-secondary" onClick={guard.requestClose}>{results ? 'Close' : 'Cancel'}</button>
          {data && <button className="btn btn-primary" disabled={saving || !included} onClick={commit}>{saving ? 'Importing…' : `Import ${included} sheet${included === 1 ? '' : 's'}`}</button>}
        </div>
      </div>
    </div>
  )
}
