import { useState, useEffect } from 'react'
import useServerTable from '../../hooks/useServerTable'
import SortTh from '../../components/SortTh'
import Pagination from '../../components/Pagination'
import { useApi, useAuth } from '../../App'
import { useToast } from '../../components/Toast'
import DateRangeFilter from '../../components/DateRangeFilter'
import Icon from '../../components/Icon'

const money = (v) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(v) || 0)
const num = (v) => new Intl.NumberFormat('en-IN').format(Number(v) || 0)
const day = (v) => (v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—')
const dt = (v) => (v ? new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—')

const pad = (n) => String(n).padStart(2, '0')
const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

// GST is filed monthly, so the page opens on last month — the period you almost always want.
function lastMonth() {
  const now = new Date()
  return [key(new Date(now.getFullYear(), now.getMonth() - 1, 1)), key(new Date(now.getFullYear(), now.getMonth(), 0))]
}

export default function CrewfitInvoices() {
  const apiFetch = useApi()
  const toast = useToast()
  const { user } = useAuth()
  const isAdmin = user?.role === 'owner' || user?.role === 'admin'

  const [[from, to], setRange] = useState(lastMonth)
  const [preview, setPreview] = useState(null)
  const [checking, setChecking] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [warning, setWarning] = useState('')
  const [gaps, setGaps] = useState([])
  const [reports, setReports] = useState([])
  const [loadingReports, setLoadingReports] = useState(true)
  const [downloading, setDownloading] = useState(null)
  const table = useServerTable({ sort: 'created_at', dir: 'desc', limit: 10 })

  /** Download through the authorised endpoint; the files are not reachable as static assets. */
  const download = async (url, fallbackName) => {
    const r = await apiFetch(url, { responseType: 'blob' })
    if (!r) return false
    if (r.error) { toast.error(r.error); return false }
    const href = URL.createObjectURL(r.blob)
    const a = document.createElement('a')
    a.href = href; a.download = r.filename || fallbackName
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(href)
    return true
  }

  const loadReports = async () => {
    const r = await apiFetch('/api/crewfit/invoices/reports?' + table.query())
    if (r && !r.error) { setReports(r.reports || []); table.setPagination(r.pagination) }
    setLoadingReports(false)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadReports() }, [table.key])

  // A preview belongs to the dates it was run for; keeping it on screen after the range changes
  // would invite generating one period while reading another period's totals.
  const applyRange = (s, e) => { setRange([s, e]); setPreview(null); setWarning(''); setGaps([]) }

  const runPreview = async () => {
    setChecking(true); setWarning('')
    const r = await apiFetch(`/api/crewfit/invoices/preview?from=${from}&to=${to}`)
    setChecking(false)
    if (!r) return
    if (r.error) { setPreview(null); setWarning(r.error); return }
    setPreview(r); setGaps(r.gaps || [])
    if (!r.row_count) toast.error('No tax invoices were issued in this period')
  }

  const generate = async (ignoreGaps = false) => {
    setGenerating(true); setWarning('')
    const res = await apiFetch('/api/crewfit/invoices/generate', {
      method: 'POST', body: JSON.stringify({ from, to, ignoreGaps }),
    })
    if (!res) { setGenerating(false); return }
    if (res.error) {
      setWarning(res.error)
      if (res.gaps) setGaps(res.gaps)
      setGenerating(false)
      return
    }
    await download(`/api/crewfit/invoices/reports/${res.id}/download`, res.filename)
    toast.success(`${res.filename} — ${num(res.row_count)} rows, ${res.invoice_from} → ${res.invoice_to}`)
    setPreview(null); setGaps([])
    await loadReports()
    setGenerating(false)
  }

  const removeReport = async (r) => {
    if (!await toast.confirm({
      title: `Remove "${r.filename}" from the history?`,
      message: 'The invoice numbers it filed stay assigned, so regenerating the period reproduces the same file.',
      confirmLabel: 'Remove', danger: true,
    })) return
    const res = await apiFetch(`/api/crewfit/invoices/reports/${r.id}`, { method: 'DELETE' })
    if (res?.error) { toast.error(res.error); return }
    toast.success('Report removed')
    loadReports()
  }

  const stats = preview ? [
    { label: 'Register rows', value: num(preview.row_count), icon: 'invoice' },
    { label: 'Total quantity', value: num(preview.total_qty), icon: 'shirt' },
    { label: 'Taxable value', value: money(preview.taxable_value), icon: 'wallet' },
    { label: 'GST', value: money(preview.gst_total), icon: 'trending' },
    { label: 'Gross total', value: money(preview.gross_total), icon: 'card' },
  ] : []

  return (
    <div className="page-enter">
      {/* Title and controls share one row, so the date picker sits in the page's top-right corner
          rather than wrapping onto a line of its own where its panel opens back over the sidebar. */}
      <div className="dash-toolbar">
        <div>
          <h1>Crewfit · Invoices</h1>
          <p style={{ color: 'var(--text-muted)' }}>
            GST sales register for bulk orders, on its own invoice series.
            Built from issued tax invoices — proformas carry no GST.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <DateRangeFilter startDate={from} endDate={to}
            onApply={(s, e) => { if (s && e) applyRange(s, e) }}
            onClear={() => applyRange(...lastMonth())} />
          <button className="btn" onClick={runPreview} disabled={checking || generating}>{checking ? 'Checking…' : 'Preview'}</button>
          <button className="btn btn-primary" onClick={() => generate(false)} disabled={generating || checking}>
            <Icon name="download" size={15} style={{ marginRight: 6, verticalAlign: '-2px' }} />
            {generating ? 'Generating…' : 'Generate & Download'}
          </button>
        </div>
      </div>

      {warning && <div className="calc-warning" style={{ marginBottom: 18 }}>{warning}</div>}

      {/* A fully paid order with no tax invoice is an unbilled supply. Naming them is the point —
          "something is missing" is useless without saying which orders to go and invoice. */}
      {!!gaps.length && (
        <div className="card" style={{ marginBottom: 18 }}>
          <h2 style={{ fontSize: 15, marginBottom: 6 }}>Fully paid, not yet invoiced</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 12.5, marginBottom: 10 }}>
            Issue a tax invoice for each from its order, or generate anyway to leave them out of this period.
          </p>
          <div className="gap-list">
            {gaps.map(g => (
              <span className="gap-chip" key={g.sl_no}>
                CF-{g.sl_no} · {g.customer_name} · {money(g.grand_total)}
              </span>
            ))}
          </div>
          <button className="btn btn-secondary" style={{ marginTop: 12 }}
            onClick={() => generate(true)} disabled={generating}>
            Generate anyway, without them
          </button>
        </div>
      )}

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
          <p style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>
            Preview only — nothing is filed until you generate. An invoice covering more than one HSN
            contributes a row per HSN, so rows can exceed invoices.
          </p>
        </div>
      )}

      <div className="dash-toolbar" style={{ marginBottom: 12 }}>
        <div>
          <h2 style={{ fontSize: 17 }}>Downloaded registers</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>Every register generated, re-downloadable as filed</p>
        </div>
      </div>

      <div className="data-table-wrapper">
        {loadingReports ? <div className="loader"><div className="spinner" /></div> : !reports.length ? (
          <div className="empty-state"><div className="empty-icon">🧾</div><p>No Crewfit GST registers generated yet.</p></div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <SortTh label="Period" col="from_date" sort={table.sort} onSort={table.toggle} />
                <SortTh label="Invoice range" />
                <SortTh label="Rows" col="row_count" sort={table.sort} onSort={table.toggle} align="right" />
                <SortTh label="Taxable" col="taxable_value" sort={table.sort} onSort={table.toggle} align="right" />
                <SortTh label="GST" col="gst_total" sort={table.sort} onSort={table.toggle} align="right" />
                <SortTh label="Gross" col="gross_total" sort={table.sort} onSort={table.toggle} align="right" />
                <SortTh label="Generated" col="created_at" sort={table.sort} onSort={table.toggle} />
                <SortTh label="" />
              </tr>
            </thead>
            <tbody>
              {reports.map(r => (
                <tr key={r.id}>
                  <td className="cell-primary">
                    <div style={{ fontWeight: 600 }}>{r.period_label}</div>
                    {!/\d{2} \w{3} \d{4}/.test(r.period_label) && (
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{day(r.from_date)} — {day(r.to_date)}</div>
                    )}
                  </td>
                  <td data-label="Invoice range" style={{ fontSize: 12 }}>
                    {r.invoice_from ? <><div>{r.invoice_from}</div><div style={{ color: 'var(--text-muted)' }}>→ {r.invoice_to}</div></> : '—'}
                  </td>
                  <td data-label="Rows" style={{ textAlign: 'right' }}>{num(r.row_count)}</td>
                  <td data-label="Taxable" style={{ textAlign: 'right' }}>{money(r.taxable_value)}</td>
                  <td data-label="GST" style={{ textAlign: 'right' }}>{money(r.gst_total)}</td>
                  <td data-label="Gross" style={{ textAlign: 'right' }}>{money(r.gross_total)}</td>
                  <td data-label="Generated" style={{ fontSize: 12 }}>
                    <div>{dt(r.created_at)}</div>
                    {r.generated_by && <div style={{ color: 'var(--text-muted)' }}>{r.generated_by}</div>}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="mini-btn" disabled={downloading === r.id}
                      onClick={async () => { setDownloading(r.id); await download(`/api/crewfit/invoices/reports/${r.id}/download`, r.filename); setDownloading(null) }}>
                      {downloading === r.id ? 'Downloading…' : '⬇ Download'}
                    </button>
                    {isAdmin && <button className="mini-btn" style={{ marginLeft: 6 }} onClick={() => removeReport(r)}>Remove</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {!loadingReports && <Pagination table={table} noun="registers" />}
    </div>
  )
}
