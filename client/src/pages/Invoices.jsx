import { useState, useEffect } from 'react'
import { useApi, useAuth } from '../App'
import { useToast } from '../components/Toast'
import DateRangeFilter from '../components/DateRangeFilter'
import Icon from '../components/Icon'
import useDirtyGuard from '../hooks/useDirtyGuard'

const money = (v) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(v) || 0)
const num = (v) => new Intl.NumberFormat('en-IN').format(Number(v) || 0)
const day = (v) => (v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—')
const dt = (v) => (v ? new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—')

const pad = (n) => String(n).padStart(2, '0')
const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const todayStr = () => key(new Date())

// GST is filed monthly, so both tabs open on last month — the period you almost always want.
function lastMonth() {
  const now = new Date()
  return [key(new Date(now.getFullYear(), now.getMonth() - 1, 1)), key(new Date(now.getFullYear(), now.getMonth(), 0))]
}

/** Download through the authorised endpoint; the files are not reachable as static assets. */
function useDownloader(apiFetch, toast) {
  return async (url, fallbackName) => {
    const r = await apiFetch(url, { responseType: 'blob' })
    if (!r) return false
    if (r.error) { toast.error(r.error); return false }
    const href = URL.createObjectURL(r.blob)
    const a = document.createElement('a')
    a.href = href
    a.download = r.filename || fallbackName
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(href)
    return true
  }
}

/* ────────────────────────────── shared history table ────────────────────────────── */

function ReportHistory({ kind, reports, loading, onDownload, onDelete, isAdmin, downloading }) {
  return (
    <>
      <div className="dash-toolbar" style={{ marginBottom: 12 }}>
        <div>
          <h2 style={{ fontSize: 17 }}>Downloaded GST {kind}</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>Every report generated, re-downloadable as filed</p>
        </div>
      </div>

      <div className="data-table-wrapper">
        {loading ? <div className="loader"><div className="spinner" /></div> : !reports.length ? (
          <div className="empty-state"><div className="empty-icon">🧾</div><p>No GST {kind} reports generated yet.</p></div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Period</th>
                {kind === 'sales' && <th>Invoice range</th>}
                <th style={{ textAlign: 'right' }}>{kind === 'sales' ? 'Orders' : 'Bills'}</th>
                <th style={{ textAlign: 'right' }}>Taxable</th>
                <th style={{ textAlign: 'right' }}>GST</th>
                <th style={{ textAlign: 'right' }}>Gross</th>
                <th>Generated</th><th></th>
              </tr>
            </thead>
            <tbody>
              {reports.map(r => (
                <tr key={r.id}>
                  <td className="cell-primary">
                    <div style={{ fontWeight: 600 }}>{r.period_label}</div>
                    {/* Whole months get a label like "Jul 26-27", so the dates add something.
                        A custom range labels itself, and repeating it would just be noise. */}
                    {!/\d{2} \w{3} \d{4}/.test(r.period_label) && (
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{day(r.from_date)} — {day(r.to_date)}</div>
                    )}
                  </td>
                  {kind === 'sales' && (
                    <td data-label="Invoice range" style={{ fontSize: 12 }}>
                      {r.invoice_from ? <><div>{r.invoice_from}</div><div style={{ color: 'var(--text-muted)' }}>→ {r.invoice_to}</div></> : '—'}
                    </td>
                  )}
                  <td data-label="Count" style={{ textAlign: 'right' }}>{num(r.row_count)}</td>
                  <td data-label="Taxable" style={{ textAlign: 'right' }}>{money(r.taxable_value)}</td>
                  <td data-label="GST" style={{ textAlign: 'right' }}>{money(r.gst_total)}</td>
                  <td data-label="Gross" style={{ textAlign: 'right', fontWeight: 700 }}>{money(r.gross_total)}</td>
                  <td data-label="Generated" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    <div>{dt(r.created_at)}</div>
                    {r.generated_by && <div>by {r.generated_by}</div>}
                  </td>
                  <td className="cell-actions" data-label="Actions">
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button className="btn-icon" title="Download again" disabled={downloading === r.id} onClick={() => onDownload(r)}>
                        <Icon name="download" size={14} />
                      </button>
                      {isAdmin && (
                        <button className="btn-icon" title="Remove from history" style={{ color: 'var(--danger)' }} onClick={() => onDelete(r)}>
                          <Icon name="trash" size={14} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}

/* ────────────────────────────── sales ────────────────────────────── */

function SalesTab({ apiFetch, toast, isAdmin, download }) {
  const [[from, to], setRange] = useState(lastMonth)
  const [preview, setPreview] = useState(null)
  const [checking, setChecking] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [warning, setWarning] = useState('')
  const [reports, setReports] = useState([])
  const [loadingReports, setLoadingReports] = useState(true)
  const [downloading, setDownloading] = useState(null)

  const loadReports = async () => {
    const r = await apiFetch('/api/invoices/reports?kind=sales')
    if (r && !r.error) setReports(r)
    setLoadingReports(false)
  }

  // Both setState calls in loadReports run after an await, so nothing updates synchronously here
  // — the rule flags any call that eventually setStates and can't see through the async hop.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { loadReports() }, [])

  // A preview belongs to the dates it was run for; keeping it on screen after the range changes
  // would invite generating one period while reading another period's totals.
  const applyRange = (s, e) => { setRange([s, e]); setPreview(null); setWarning('') }

  const runPreview = async () => {
    setChecking(true); setWarning('')
    const r = await apiFetch(`/api/invoices/preview?from=${from}&to=${to}`)
    setChecking(false)
    if (!r) return
    if (r.error) { setPreview(null); setWarning(r.error); return }
    setPreview(r)
    if (!r.row_count) toast.error('No fulfilled orders in this period')
  }

  const generate = async () => {
    setGenerating(true); setWarning('')
    const res = await apiFetch('/api/invoices/generate', { method: 'POST', body: JSON.stringify({ from, to }) })
    if (!res) { setGenerating(false); return }
    if (res.error) { setWarning(res.error); setGenerating(false); return }
    await download(`/api/invoices/reports/${res.id}/download`, res.filename)
    toast.success(`${res.filename} — ${num(res.row_count)} orders, ${res.invoice_from} → ${res.invoice_to}`)
    setPreview(null)
    await loadReports()
    setGenerating(false)
  }

  const removeReport = async (r) => {
    if (!confirm(`Remove "${r.filename}" from the history?\n\nThe invoice numbers it issued stay assigned, so regenerating the period reproduces the same file.`)) return
    const res = await apiFetch(`/api/invoices/reports/${r.id}`, { method: 'DELETE' })
    if (res?.error) { toast.error(res.error); return }
    toast.success('Report removed')
    loadReports()
  }

  const stats = preview ? [
    { label: 'Fulfilled orders', value: num(preview.row_count), icon: 'box' },
    { label: 'Total quantity', value: num(preview.total_qty), icon: 'shirt' },
    { label: 'Taxable value', value: money(preview.taxable_value), icon: 'wallet' },
    { label: 'GST @ 5%', value: money(preview.gst_total), icon: 'trending' },
    { label: 'Gross total', value: money(preview.gross_total), icon: 'card' },
  ] : []

  return (
    <>
      {/* Controls live on the right of the toolbar, as on every other page: the date picker's
          panel is anchored right:0, so a left-hand trigger would open it off-screen. */}
      <div className="dash-toolbar">
        <div>
          <p style={{ color: 'var(--text-muted)' }}>
            Built from fulfilled Shopify orders — GST is divided out of the order value
            {(checking || generating) && <span style={{ marginLeft: 8 }}>· reading orders from Shopify, a full month takes a few seconds…</span>}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <DateRangeFilter startDate={from} endDate={to}
            onApply={(s, e) => { if (s && e) applyRange(s, e) }}
            onClear={() => applyRange(...lastMonth())} />
          <button className="btn" onClick={runPreview} disabled={checking || generating}>{checking ? 'Checking…' : 'Preview'}</button>
          <button className="btn btn-primary" onClick={generate} disabled={generating || checking}>
            <Icon name="download" size={15} style={{ marginRight: 6, verticalAlign: '-2px' }} />
            {generating ? 'Generating…' : 'Generate & Download'}
          </button>
        </div>
      </div>

      {warning && <div className="calc-warning" style={{ marginBottom: 18 }}>{warning}</div>}

      {preview && !!preview.row_count && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="kpi-grid">
            {stats.map(s => (
              <div className="kpi-card" key={s.label}>
                <div className="kpi-head"><div className="kpi-icon"><Icon name={s.icon} size={20} /></div></div>
                <div className="kpi-value">{s.value}</div>
                <div className="kpi-label">{s.label}</div>
              </div>
            ))}
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>Preview only — invoice numbers are issued when you generate the file.</p>
        </div>
      )}

      <ReportHistory kind="sales" reports={reports} loading={loadingReports} isAdmin={isAdmin}
        downloading={downloading}
        onDownload={async (r) => { setDownloading(r.id); await download(`/api/invoices/reports/${r.id}/download`, r.filename); setDownloading(null) }}
        onDelete={removeReport} />
    </>
  )
}

/* ────────────────────────────── purchase entry form ────────────────────────────── */

const GST_RATES = [0.05, 0.12, 0.18, 0.28]

const blankBill = () => ({
  purchase_date: todayStr(), particulars: '', company_name: '', invoice_no: '',
  location: '', gstin: '', gst_pct: 0.18, qty: '', rate: '',
  taxable: '', gst_amount: '', gross: '', supplier_id: '', intra_state: true,
})

const n = (v) => { const x = Number(v); return Number.isFinite(x) && v !== '' ? x : null }
const round2 = (v) => Math.round(v * 100) / 100

/** Is this bill intra-state? Read from the GSTIN's state code; 33 is Tamil Nadu. */
const intraFrom = (gstin, fallback) => {
  const code = String(gstin || '').trim().slice(0, 2)
  return /^\d{2}$/.test(code) ? code === '33' : fallback
}

function PurchaseDrawer({ bill, suppliers, onClose, onSaved, apiFetch, toast }) {
  const [form, setForm] = useState(bill)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const guard = useDirtyGuard({
    snapshot: form,
    identity: form.id ?? 'new',
    onDiscard: onClose,
    confirm: toast.confirm,
    title: form.id ? 'Discard your edits?' : 'Discard this bill?',
    message: 'This bill has unsaved details. Closing now will lose them.',
  })

  const set = (patch) => setForm(f => ({ ...f, ...patch }))

  // Amounts cascade from whichever figure the user is actually reading off the bill. Editing a
  // later field never rewrites an earlier one, so a stated GST that isn't exactly taxable × rate
  // — Delhivery rounds to whole rupees — survives instead of being "corrected".
  const setQtyRate = (patch) => {
    const next = { ...form, ...patch }
    const qty = n(next.qty), rate = n(next.rate), pct = n(next.gst_pct) || 0
    if (qty != null && rate != null) {
      const taxable = round2(qty * rate)
      const gst = round2(taxable * pct)
      set({ ...patch, taxable, gst_amount: gst, gross: round2(taxable + gst) })
    } else set(patch)
  }
  const setTaxable = (v) => {
    const taxable = n(v), pct = n(form.gst_pct) || 0
    if (taxable == null) { set({ taxable: v }); return }
    const gst = round2(taxable * pct)
    set({ taxable: v, gst_amount: gst, gross: round2(taxable + gst) })
  }
  const setGst = (v) => {
    const gst = n(v), taxable = n(form.taxable)
    set(gst != null && taxable != null ? { gst_amount: v, gross: round2(taxable + gst) } : { gst_amount: v })
  }
  // Entering the gross is the common case for round-figure bills, so it works backwards.
  const setGross = (v) => {
    const gross = n(v), pct = n(form.gst_pct) || 0
    if (gross == null) { set({ gross: v }); return }
    const taxable = round2(gross / (1 + pct))
    set({ gross: v, taxable, gst_amount: round2(gross - taxable) })
  }
  const setPct = (v) => {
    const pct = n(v) || 0, taxable = n(form.taxable)
    if (taxable == null) { set({ gst_pct: v }); return }
    const gst = round2(taxable * pct)
    set({ gst_pct: v, gst_amount: gst, gross: round2(taxable + gst) })
  }

  const pickSupplier = (id) => {
    const s = suppliers.find(x => String(x.id) === String(id))
    if (!s) { set({ supplier_id: '' }); return }
    set({
      supplier_id: s.id, company_name: s.name, gstin: s.gstin || '', location: s.location || '',
      particulars: form.particulars || s.default_particulars || '',
      gst_pct: s.default_gst_pct != null ? Number(s.default_gst_pct) : form.gst_pct,
      rate: form.rate || (s.default_rate != null ? Number(s.default_rate) : ''),
      intra_state: s.intra_state,
    })
  }

  const intra = intraFrom(form.gstin, form.intra_state !== false)
  const gstVal = n(form.gst_amount) || 0
  const split = intra
    ? { cgst: round2(gstVal / 2), sgst: round2(gstVal / 2), igst: 0 }
    : { cgst: 0, sgst: 0, igst: round2(gstVal) }

  const computedGst = round2((n(form.taxable) || 0) * (n(form.gst_pct) || 0))
  const gstDiffers = n(form.gst_amount) != null && Math.abs(computedGst - gstVal) > 0.01

  const save = async () => {
    setSaving(true); setError('')
    const body = {
      ...form,
      qty: form.qty === '' ? null : Number(form.qty),
      rate: form.rate === '' ? null : Number(form.rate),
      taxable: form.taxable === '' ? null : Number(form.taxable),
      gst_amount: form.gst_amount === '' ? null : Number(form.gst_amount),
      gross: form.gross === '' ? null : Number(form.gross),
      gst_pct: Number(form.gst_pct) || 0,
      supplier_id: form.supplier_id || null,
      intra_state: intra,
    }
    const res = form.id
      ? await apiFetch(`/api/invoices/purchase/${form.id}`, { method: 'PUT', body: JSON.stringify(body) })
      : await apiFetch('/api/invoices/purchase', { method: 'POST', body: JSON.stringify(body) })
    setSaving(false)
    if (!res) return
    if (res.error) { setError(res.error); return }
    toast.success(form.id ? 'Bill updated' : 'Bill recorded')
    guard.reset()
    onSaved()
  }

  return (
    <div className="drawer-overlay" onClick={guard.requestClose}>
      <div className="drawer drawer-wide" onClick={e => e.stopPropagation()}>
        <div className="drawer-header">
          <h2 style={{ fontSize: 17 }}>{form.id ? 'Edit bill' : 'Record purchase bill'}</h2>
          <button className="btn-icon" onClick={guard.requestClose}><Icon name="close" size={16} /></button>
        </div>

        <div className="drawer-body">
          {error && <div className="calc-warning">{error}</div>}

          <div className="form-section">Supplier</div>
          <div className="input-group">
            <label>Pick a saved supplier</label>
            <select value={form.supplier_id || ''} onChange={e => pickSupplier(e.target.value)}>
              <option value="">— New / one-off supplier —</option>
              {suppliers.map(s => (
                <option key={s.id} value={s.id}>{s.name}{s.bill_count > 0 ? ` (${s.bill_count})` : ''}</option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <div className="input-group">
              <label>Company name *</label>
              <input value={form.company_name} onChange={e => set({ company_name: e.target.value })} placeholder="Supplier's registered name" />
            </div>
            <div className="input-group">
              <label>GST number</label>
              <input value={form.gstin} onChange={e => set({ gstin: e.target.value.toUpperCase() })} placeholder="33AAICI1044H1ZX" maxLength={15} />
              <div className={`gst-hint${!form.gstin ? ' warn' : ''}`}>
                {form.gstin
                  ? `State code ${form.gstin.slice(0, 2)} → ${intra ? 'within Tamil Nadu (CGST + SGST)' : 'outside Tamil Nadu (IGST)'}`
                  : 'Unregistered supplier — set the supply type below'}
              </div>
            </div>
          </div>
          <div className="input-group">
            <label>Location</label>
            <input value={form.location} onChange={e => set({ location: e.target.value })} placeholder="Madhavaram, Chennai - 600060" />
          </div>
          {!form.gstin && (
            <div className="input-group">
              <label>Supply type</label>
              <select value={form.intra_state !== false ? 'intra' : 'inter'} onChange={e => set({ intra_state: e.target.value === 'intra' })}>
                <option value="intra">Within Tamil Nadu — CGST + SGST</option>
                <option value="inter">Outside Tamil Nadu — IGST</option>
              </select>
            </div>
          )}

          <div className="form-section">Bill</div>
          <div className="form-row">
            <div className="input-group">
              <label>Bill date *</label>
              <input type="date" value={form.purchase_date} onChange={e => set({ purchase_date: e.target.value })} />
            </div>
            <div className="input-group">
              <label>Invoice no. *</label>
              <input value={form.invoice_no} onChange={e => set({ invoice_no: e.target.value })} placeholder="INK2026-27/A153" />
            </div>
          </div>
          <div className="input-group">
            <label>Particulars</label>
            <input value={form.particulars} onChange={e => set({ particulars: e.target.value })} placeholder="Printed PET Sheet" />
          </div>

          <div className="form-section">Amounts</div>
          <div className="form-row">
            <div className="input-group">
              <label>GST %</label>
              <select value={String(form.gst_pct)} onChange={e => setPct(e.target.value)}>
                {GST_RATES.map(r => <option key={r} value={r}>{Math.round(r * 100)}%</option>)}
              </select>
            </div>
            <div className="input-group">
              <label>Quantity</label>
              <input type="number" step="any" value={form.qty} onChange={e => setQtyRate({ qty: e.target.value })} />
            </div>
            <div className="input-group">
              <label>Rate</label>
              <input type="number" step="any" value={form.rate} onChange={e => setQtyRate({ rate: e.target.value })} />
            </div>
          </div>
          <div className="form-row gst-derived">
            <div className="input-group">
              <label>Taxable value</label>
              <input type="number" step="any" value={form.taxable} onChange={e => setTaxable(e.target.value)} />
            </div>
            <div className="input-group">
              <label>GST amount</label>
              <input type="number" step="any" value={form.gst_amount} onChange={e => setGst(e.target.value)} />
              {gstDiffers && <div className="gst-hint warn">Bill states {money(gstVal)}; {Math.round((n(form.gst_pct) || 0) * 100)}% would be {money(computedGst)}. Kept as entered.</div>}
            </div>
            <div className="input-group">
              <label>Gross total</label>
              <input type="number" step="any" value={form.gross} onChange={e => setGross(e.target.value)} />
            </div>
          </div>
          <p className="gst-hint">
            Enter whichever figures the bill shows — quantity and rate, or just the gross. The rest fill in,
            and anything you type by hand is kept exactly as the supplier billed it.
          </p>

          <div className="card" style={{ padding: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span style={{ color: 'var(--text-muted)' }}>CGST</span><strong>{money(split.cgst)}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginTop: 6 }}>
              <span style={{ color: 'var(--text-muted)' }}>SGST</span><strong>{money(split.sgst)}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginTop: 6 }}>
              <span style={{ color: 'var(--text-muted)' }}>IGST</span><strong>{money(split.igst)}</strong>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 4 }}>
            <button className="btn" onClick={guard.requestClose}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save bill'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ────────────────────────────── purchase ────────────────────────────── */

function PurchaseTab({ apiFetch, toast, isAdmin, download }) {
  const [[from, to], setRange] = useState(lastMonth)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [suppliers, setSuppliers] = useState([])
  const [editing, setEditing] = useState(null)
  const [exporting, setExporting] = useState(false)
  const [warning, setWarning] = useState('')
  const [reports, setReports] = useState([])
  const [loadingReports, setLoadingReports] = useState(true)
  const [downloading, setDownloading] = useState(null)

  const loadBills = async (f = from, t = to) => {
    const r = await apiFetch(`/api/invoices/purchase?from=${f}&to=${t}`)
    if (r && !r.error) setData(r)
    setLoading(false)
  }
  const loadSuppliers = async () => {
    const r = await apiFetch('/api/invoices/purchase/suppliers')
    if (r && !r.error) setSuppliers(r)
  }
  const loadReports = async () => {
    const r = await apiFetch('/api/invoices/reports?kind=purchase')
    if (r && !r.error) setReports(r)
    setLoadingReports(false)
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { loadBills(); loadSuppliers(); loadReports() }, [])

  const applyRange = (s, e) => { setRange([s, e]); setWarning(''); setLoading(true); loadBills(s, e) }

  const exportPeriod = async () => {
    setExporting(true); setWarning('')
    const res = await apiFetch('/api/invoices/purchase-export', { method: 'POST', body: JSON.stringify({ from, to }) })
    if (!res) { setExporting(false); return }
    if (res.error) { setWarning(res.error); setExporting(false); return }
    await download(`/api/invoices/reports/${res.id}/download`, res.filename)
    toast.success(`${res.filename} — ${num(res.row_count)} bills`)
    await loadReports()
    setExporting(false)
  }

  const removeBill = async (b) => {
    if (!confirm(`Delete bill ${b.invoice_no} from ${b.company_name}?`)) return
    const res = await apiFetch(`/api/invoices/purchase/${b.id}`, { method: 'DELETE' })
    if (res?.error) { toast.error(res.error); return }
    toast.success('Bill deleted')
    loadBills()
  }

  // Duplicating carries the supplier and amounts over but never the invoice number — that is the
  // one field that must differ, and a copied one would be rejected as a duplicate anyway.
  const duplicate = (b) => setEditing({
    ...b, id: undefined, invoice_no: '', purchase_date: todayStr(), source: 'manual',
    qty: b.qty ?? '', rate: b.rate ?? '', taxable: b.taxable ?? '', gst_amount: b.gst_amount ?? '',
    gross: b.gross ?? '', gst_pct: Number(b.gst_pct), gstin: b.gstin || '',
    intra_state: Number(b.cgst) > 0 || !b.gstin,
  })

  const edit = (b) => setEditing({
    ...b, qty: b.qty ?? '', rate: b.rate ?? '', taxable: b.taxable ?? '', gst_amount: b.gst_amount ?? '',
    gross: b.gross ?? '', gst_pct: Number(b.gst_pct), gstin: b.gstin || '',
    intra_state: Number(b.cgst) > 0 || !b.gstin,
  })

  const s = data?.summary
  const bills = data?.rows || []
  const stats = s ? [
    { label: 'Bills', value: num(s.row_count), icon: 'invoice' },
    { label: 'Taxable value', value: money(s.taxable_value), icon: 'wallet' },
    { label: 'Input GST', value: money(s.gst_total), icon: 'trending' },
    { label: 'CGST + SGST', value: money(s.cgst_total + s.sgst_total), icon: 'shield' },
    { label: 'IGST', value: money(s.igst_total), icon: 'truck' },
    { label: 'Gross total', value: money(s.gross_total), icon: 'card' },
  ] : []

  return (
    <>
      <div className="dash-toolbar">
        <div>
          <p style={{ color: 'var(--text-muted)' }}>
            Supplier bills entered by hand — GST is added on top of the billed value
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <DateRangeFilter startDate={from} endDate={to}
            onApply={(a, b) => { if (a && b) applyRange(a, b) }}
            onClear={() => applyRange(...lastMonth())} />
          <button className="btn" onClick={() => setEditing(blankBill())}>+ Record bill</button>
          <button className="btn btn-primary" onClick={exportPeriod} disabled={exporting || !bills.length}>
            <Icon name="download" size={15} style={{ marginRight: 6, verticalAlign: '-2px' }} />
            {exporting ? 'Exporting…' : 'Export & Download'}
          </button>
        </div>
      </div>

      {warning && <div className="calc-warning" style={{ marginBottom: 18 }}>{warning}</div>}

      {!!bills.length && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="kpi-grid">
            {stats.map(x => (
              <div className="kpi-card" key={x.label}>
                <div className="kpi-head"><div className="kpi-icon"><Icon name={x.icon} size={20} /></div></div>
                <div className="kpi-value">{x.value}</div>
                <div className="kpi-label">{x.label}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="data-table-wrapper" style={{ marginBottom: 26 }}>
        {loading ? <div className="loader"><div className="spinner" /></div> : !bills.length ? (
          <div className="empty-state"><div className="empty-icon">📥</div><p>No bills recorded for {day(from)} — {day(to)}.</p></div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th><th>Supplier</th><th>Invoice no.</th><th>Particulars</th>
                <th style={{ textAlign: 'right' }}>Taxable</th>
                <th style={{ textAlign: 'right' }}>GST</th>
                <th style={{ textAlign: 'right' }}>Gross</th>
                <th>Split</th><th></th>
              </tr>
            </thead>
            <tbody>
              {bills.map(b => (
                <tr key={b.id}>
                  <td data-label="Date" style={{ whiteSpace: 'nowrap' }}>{day(b.purchase_date)}</td>
                  <td className="cell-primary">
                    <div style={{ fontWeight: 600 }}>{b.company_name}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{b.gstin || 'unregistered'}</div>
                  </td>
                  <td data-label="Invoice no." style={{ fontSize: 12.5 }}>{b.invoice_no}</td>
                  <td data-label="Particulars" style={{ fontSize: 12.5 }}>{b.particulars || '—'}</td>
                  <td data-label="Taxable" style={{ textAlign: 'right' }}>{money(b.taxable)}</td>
                  <td data-label="GST" style={{ textAlign: 'right' }}>
                    {money(b.gst_amount)}
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{Math.round(Number(b.gst_pct) * 100)}%</div>
                  </td>
                  <td data-label="Gross" style={{ textAlign: 'right', fontWeight: 700 }}>{money(b.gross)}</td>
                  <td data-label="Split">
                    <span className={Number(b.igst) > 0 ? 'badge-secondary' : 'badge-primary'}>
                      {Number(b.igst) > 0 ? 'IGST' : 'CGST+SGST'}
                    </span>
                  </td>
                  <td className="cell-actions" data-label="Actions">
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button className="btn-icon" title="Edit" onClick={() => edit(b)}><Icon name="edit" size={14} /></button>
                      <button className="btn-icon" title="Duplicate for a new bill" onClick={() => duplicate(b)}><Icon name="copy" size={14} /></button>
                      {isAdmin && <button className="btn-icon" title="Delete" style={{ color: 'var(--danger)' }} onClick={() => removeBill(b)}><Icon name="trash" size={14} /></button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <ReportHistory kind="purchase" reports={reports} loading={loadingReports} isAdmin={isAdmin}
        downloading={downloading}
        onDownload={async (r) => { setDownloading(r.id); await download(`/api/invoices/reports/${r.id}/download`, r.filename); setDownloading(null) }}
        onDelete={async (r) => {
          if (!confirm(`Remove "${r.filename}" from the history?`)) return
          const res = await apiFetch(`/api/invoices/reports/${r.id}`, { method: 'DELETE' })
          if (res?.error) { toast.error(res.error); return }
          toast.success('Report removed')
          loadReports()
        }} />

      {editing && (
        <PurchaseDrawer bill={editing} suppliers={suppliers} apiFetch={apiFetch} toast={toast}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); loadBills(); loadSuppliers() }} />
      )}
    </>
  )
}

/* ────────────────────────────── page ────────────────────────────── */

export default function Invoices() {
  const apiFetch = useApi()
  const { user } = useAuth()
  const toast = useToast()
  const [tab, setTab] = useState('sales')
  const download = useDownloader(apiFetch, toast)
  const isAdmin = user?.role === 'owner' || user?.role === 'admin'

  return (
    <div className="page-enter">
      <div className="dash-toolbar" style={{ marginBottom: 6 }}>
        <div>
          <h1>Normless · Invoices</h1>
        </div>
      </div>

      <div className="gst-tabs">
        <button className={tab === 'sales' ? 'active' : ''} onClick={() => setTab('sales')}>Sales</button>
        <button className={tab === 'purchase' ? 'active' : ''} onClick={() => setTab('purchase')}>Purchase</button>
      </div>

      {/* Keyed so switching tabs starts each side from a clean load rather than showing the
          other register's stale totals for a frame. */}
      {tab === 'sales'
        ? <SalesTab key="sales" apiFetch={apiFetch} toast={toast} isAdmin={isAdmin} download={download} />
        : <PurchaseTab key="purchase" apiFetch={apiFetch} toast={toast} isAdmin={isAdmin} download={download} />}
    </div>
  )
}
