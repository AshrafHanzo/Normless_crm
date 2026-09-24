import { useState, useEffect } from 'react'
import { useApi, useAuth } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import Pagination from '../../components/Pagination'
import useLocalPager from '../../hooks/useLocalPager'

const day = (v) => (v ? new Date(`${v}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }) : '—')
const stamp = (v) => (v ? new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—')
const size = (b) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round((b || 0) / 1024))} KB`)

/**
 * Daily reports — the HTML a scheduled Claude run posts each morning from Meta Ads and Shopify.
 *
 * Nothing here is created by hand; the run uploads straight to the server. The team reads it,
 * saves a copy, or clears out the ones nobody needs any more.
 */
export default function ReportsTab() {
  const apiFetch = useApi()
  const toast = useToast()
  const { user } = useAuth()
  // The server refuses anyone else; the button is hidden so nobody is offered it.
  const canDelete = user?.role === 'owner'

  const [reports, setReports] = useState([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(null)       // { id, title, report_date, html, filename }
  const [busyId, setBusyId] = useState(null)

  const load = async () => {
    const r = await apiFetch('/api/marketing/reports')
    if (r && !r.error) setReports(r.reports || [])
    else if (r?.error) toast.error(r.error)
    setLoading(false)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [])

  const pager = useLocalPager(reports, 20)

  const fetchReport = async (row) => {
    setBusyId(row.id)
    const r = await apiFetch(`/api/marketing/reports/${row.id}`)
    setBusyId(null)
    if (!r || r.error) { toast.error(r?.error || 'Could not open the report'); return null }
    return r
  }

  const preview = async (row) => { const r = await fetchReport(row); if (r) setOpen(r) }

  const saveFile = (r) => {
    const url = URL.createObjectURL(new Blob([r.html], { type: 'text/html;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url; a.download = r.filename
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const download = async (row) => { const r = open?.id === row.id ? open : await fetchReport(row); if (r) saveFile(r) }

  const remove = async (row) => {
    if (!await toast.confirm({
      title: `Delete the ${day(row.report_date)} report?`,
      message: 'It is removed for everyone. Download a copy first if you may need it again.',
      confirmLabel: 'Delete', danger: true,
    })) return
    const r = await apiFetch(`/api/marketing/reports/${row.id}`, { method: 'DELETE' })
    if (!r || r.error) { toast.error(r?.error || 'Failed to delete'); return }
    setReports(l => l.filter(x => x.id !== row.id))
    if (open?.id === row.id) setOpen(null)
    toast.success('Report deleted')
  }

  return (
    <>
      <div className="data-table-wrapper">
        {loading ? <div className="loader"><div className="spinner" /></div> : reports.length === 0 ? (
          <div className="empty-state"><div className="empty-icon">📊</div>
            <p>No reports yet. The daily run posts one here each morning at 9am.</p></div>
        ) : (
          <>
          <table className="data-table">
            <thead><tr><th>Report date</th><th>Title</th><th>Source</th><th>Size</th><th>Received</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
            <tbody>
              {pager.slice.map(row => (
                <tr key={row.id}>
                  <td style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>{day(row.report_date)}</td>
                  <td><button className="link-name" onClick={() => preview(row)} disabled={busyId === row.id}>{row.title}</button></td>
                  <td style={{ color: 'var(--text-muted)' }}>{row.source || '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{size(row.size_bytes)}</td>
                  <td style={{ whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>{stamp(row.created_at)}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn btn-secondary btn-sm" onClick={() => preview(row)} disabled={busyId === row.id}>
                      <Icon name="eye" size={14} /> Preview</button>{' '}
                    <button className="btn btn-secondary btn-sm" onClick={() => download(row)} disabled={busyId === row.id}>
                      <Icon name="download" size={14} /> Download</button>{' '}
                    {canDelete && <button className="btn-icon" title="Delete" onClick={() => remove(row)}><Icon name="trash" size={15} /></button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination table={pager.table} noun="reports" />
          </>
        )}
      </div>

      {open && (
        <div className="drawer-overlay" onClick={() => setOpen(null)}>
          <div className="drawer drawer-wide report-drawer" onClick={e => e.stopPropagation()}>
            <div className="drawer-header">
              <div>
                <h2>{open.title}</h2>
                <p style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 2 }}>{day(open.report_date)}</p>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button className="btn btn-secondary btn-sm" onClick={() => saveFile(open)}><Icon name="download" size={14} /> Download</button>
                <button type="button" className="btn-icon" onClick={() => setOpen(null)}><Icon name="close" size={16} /></button>
              </div>
            </div>
            {/* Sandboxed without allow-same-origin: the report's own charts still run, but it
                cannot reach the CRM's session or storage. */}
            <iframe className="report-frame" title={open.title} srcDoc={open.html} sandbox="allow-scripts allow-popups" />
          </div>
        </div>
      )}
    </>
  )
}
