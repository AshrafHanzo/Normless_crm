import { useState, useEffect } from 'react'
import { useApi } from '../../App'
import { dayTime } from './common'

const KINDS = [
  { key: '', label: 'All' }, { key: 'create', label: 'Get AWB' }, { key: 'recreate', label: 'Re-create' },
  { key: 'pickup', label: 'Pickups' }, { key: 'ndr', label: 'Failed deliveries' }, { key: 'sync', label: 'Tracking sync' },
]
const BADGE = { done: 'fulfilled', done_with_errors: 'pending', failed: 'error', running: 'partial' }
const WORDS = { done: 'Done', done_with_errors: 'Done with errors', failed: 'Failed', running: 'Running' }

/** Every bulk action and automatic job, with each failure and its reason in the row. */
export default function Activity({ canManage, ship, rev }) {
  const apiFetch = useApi()
  const [kind, setKind] = useState('')
  const [failedOnly, setFailedOnly] = useState(false)
  const [jobs, setJobs] = useState(null)

  useEffect(() => {
    const q = new URLSearchParams()
    if (kind) q.set('kind', kind)
    if (failedOnly) q.set('failed', '1')
    if (!kind) q.set('hide_sync', '1')
    apiFetch(`/api/shipping/jobs?${q}`).then(r => setJobs(r && !r.error ? r.jobs : []))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, failedOnly, rev])

  return (
    <>
      <div className="filters-row" style={{ marginBottom: 14 }}>
        <div className="scan-tabs" style={{ maxWidth: '100%', overflowX: 'auto' }}>
          {KINDS.map(k => <button key={k.key} className={kind === k.key ? 'active' : ''} onClick={() => setKind(k.key)} style={{ whiteSpace: 'nowrap' }}>{k.label}</button>)}
        </div>
        <label className="page-check" style={{ width: 'auto' }}><input type="checkbox" checked={failedOnly} onChange={e => setFailedOnly(e.target.checked)} /> Failures only</label>
      </div>
      {!kind && <p className="packed-sub" style={{ maxWidth: 'none', marginTop: -6, marginBottom: 12 }}>Tracking syncs that went fine are hidden here. Pick "Tracking sync" to see them.</p>}
      <div className="data-table-wrapper">
        {!jobs ? <div className="loader"><div className="spinner" /></div> : !jobs.length ? <div className="empty-state"><h3>Nothing yet</h3></div> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead><tr><th>Job</th><th>By</th><th>Started</th><th>Status</th><th>Result</th></tr></thead>
              <tbody>
                {jobs.map(j => (
                  <tr key={j.id}>
                    <td data-label="Job" className="cell-primary">{j.title || j.kind}</td>
                    <td data-label="By">{(j.actor || '—').split('@')[0]}</td>
                    <td data-label="Started">{dayTime(j.started_at)}</td>
                    <td data-label="Status"><span className={`status-badge ${BADGE[j.status] || 'pending'}`}>{WORDS[j.status] || j.status}</span></td>
                    <td data-label="Result" style={{ minWidth: 320, whiteSpace: 'normal' }}>
                      <div>{j.summary || '—'}</div>
                      {(j.errors || []).filter(e => e.error).slice(0, 20).map((e, i) => (
                        <div key={i} className="ship-err">
                          {e.order_number && <b>{e.order_number}</b>}<span>{e.error}</span>
                          {canManage && e.order_number && ['create', 'recreate'].includes(j.kind) && !e.soft && (
                            <button className="mini-btn" style={{ marginLeft: 'auto' }} onClick={() => ship([{ order_number: e.order_number }])}>Fix and retry</button>
                          )}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
