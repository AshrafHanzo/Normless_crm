import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApi } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import PersonDrawer from './PersonDrawer'
import { Avatar, CompanyPill, inr, num, day, shortDay, monthLabel, thisMonth, today, useReason } from './teamUi'

/**
 * Team › Payroll: People, the monthly Payroll run, Leave, Claims and Settings. Shared by both
 * brands; the company filter narrows any list to Normless or Crewfit.
 */
const TABS = [['people', 'People'], ['run', 'Payroll'], ['leave', 'Leave'], ['claims', 'Claims'], ['settings', 'Settings']]

export default function Payroll() {
  const apiFetch = useApi()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') || 'people'
  const [meta, setMeta] = useState(null)
  const [counts, setCounts] = useState({ leave: 0, claims: 0 })

  useEffect(() => {
    apiFetch('/api/team/meta').then(r => r && !r.error && setMeta(r))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const refreshCounts = async () => {
    const [l, c] = await Promise.all([apiFetch('/api/team/leave?status=pending'), apiFetch('/api/team/claims?status=open')])
    setCounts({ leave: l?.leave?.length || 0, claims: c?.claims?.length || 0 })
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { refreshCounts() }, [tab])

  // A payslip is fetched with the login token and opened as a blob — a plain link would 401.
  const openPayslip = async (runId, empId) => {
    const r = await apiFetch(`/api/team/runs/${runId}/payslip/${empId}`, { responseType: 'blob' })
    if (!r || r.error) { toast.error(r?.error || 'Could not open the payslip'); return }
    const url = URL.createObjectURL(r.blob)
    window.open(url, '_blank')
    setTimeout(() => URL.revokeObjectURL(url), 60000)
  }

  return (
    <div className="page-enter tm-page">
      <div className="dash-toolbar">
        <div><h1>Payroll</h1><p style={{ color: 'var(--text-muted)' }}>People, salaries, leave and claims for Normless and Crewfit</p></div>
      </div>
      <div className="scan-tabs" style={{ marginBottom: 18 }} role="tablist">
        {TABS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setParams({ tab: k })}>
            {l}{k === 'leave' && counts.leave > 0 && <span className="tab-badge">{counts.leave}</span>}
            {k === 'claims' && counts.claims > 0 && <span className="tab-badge">{counts.claims}</span>}
          </button>
        ))}
      </div>
      {tab === 'people' && <People meta={meta} apiFetch={apiFetch} toast={toast} openPayslip={openPayslip} />}
      {tab === 'run' && <PayRun meta={meta} apiFetch={apiFetch} toast={toast} openPayslip={openPayslip} />}
      {tab === 'leave' && <LeaveTab apiFetch={apiFetch} toast={toast} onChange={refreshCounts} canPayroll />}
      {tab === 'claims' && <ClaimsTab apiFetch={apiFetch} toast={toast} onChange={refreshCounts} canPayroll />}
      {tab === 'settings' && <SettingsTab apiFetch={apiFetch} toast={toast} />}
    </div>
  )
}

/* ───────────────────────────── people ───────────────────────────── */

function People({ meta, apiFetch, toast, openPayslip }) {
  const [data, setData] = useState(null)
  const [f, setF] = useState({ q: '', company: '', department: '', status: '' })
  const [open, setOpen] = useState(null)
  const load = async () => {
    const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v))
    const r = await apiFetch(`/api/team/people?${q}`)
    if (!r || r.error) { toast.error(r?.error || 'Could not load people'); return }
    setData(r)
  }
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t) }, [f]) // eslint-disable-line react-hooks/exhaustive-deps
  const s = data?.summary

  return (
    <>
      <div className="tm-kpis">
        <div className="tm-kpi"><b>{s?.active ?? '—'}</b><span>Active people</span></div>
        <div className="tm-kpi"><b>{s ? `${s.normless} · ${s.crewfit} · ${s.both}` : '—'}</b><span>Normless · Crewfit · both</span></div>
        <div className="tm-kpi"><b>{s ? inr(s.monthly) : '—'}</b><span>Monthly salaries</span></div>
        <div className={`tm-kpi${s?.missingBank ? ' tm-kpi-warn' : ''}`}><b>{s?.missingBank ?? '—'}</b><span>Missing bank details</span></div>
      </div>
      <div className="filters-row filters-row-search">
        <div className="search-bar"><span className="search-icon" /><input placeholder="Name, phone, employee ID or login…" value={f.q} onChange={e => setF({ ...f, q: e.target.value })} /></div>
        <button className="btn btn-primary" onClick={() => setOpen('new')}><Icon name="plus" size={15} /> Add person</button>
      </div>
      <div className="filters-row">
        <select aria-label="Company" value={f.company} onChange={e => setF({ ...f, company: e.target.value })} style={{ width: 'auto' }}><option value="">All companies</option><option value="normless">Normless</option><option value="crewfit">Crewfit</option></select>
        <select aria-label="Department" value={f.department} onChange={e => setF({ ...f, department: e.target.value })} style={{ width: 'auto' }}><option value="">All departments</option>{(meta?.departments || []).map(d => <option key={d}>{d}</option>)}</select>
        <select aria-label="Status" value={f.status} onChange={e => setF({ ...f, status: e.target.value })} style={{ width: 'auto' }}><option value="">Working now</option><option value="notice">On notice</option><option value="left">Left</option><option value="all">Everyone</option></select>
      </div>
      <div className="data-table-wrapper">
        {!data ? <div className="loader"><div className="spinner" /></div> : !data.people.length ? (
          <div className="empty-state"><div className="empty-icon">👥</div><p>No one here yet. Add the people you pay — with or without a CRM login.</p></div>
        ) : (
          <table className="data-table">
            <thead><tr><th>Person</th><th>Company</th><th>Department</th><th style={{ textAlign: 'right' }}>Monthly salary</th><th>CRM login</th><th>Status</th></tr></thead>
            <tbody>
              {data.people.map(p => (
                <tr key={p.id} onClick={() => setOpen(p.id)}>
                  <td className="cell-primary"><span style={{ display: 'flex', gap: 10, alignItems: 'center' }}><Avatar name={p.name} size={32} />
                    <span><b>{p.name}</b><div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{p.emp_code}{p.designation ? ` · ${p.designation}` : ''}</div></span></span></td>
                  <td data-label="Company"><CompanyPill company={p.company} /></td>
                  <td data-label="Department">{p.department || '—'}</td>
                  <td data-label="Salary" style={{ textAlign: 'right', fontWeight: 600 }}>{inr(p.monthly_salary)}</td>
                  <td data-label="Login" style={{ color: p.has_login ? 'var(--success)' : 'var(--text-muted)' }}>{p.has_login ? 'Yes' : 'No'}</td>
                  <td data-label="Status">{!p.bank_account && !p.upi_id && p.status !== 'left'
                    ? <span className="tm-warn">No bank details</span>
                    : p.status === 'notice' ? <span className="tm-muted">On notice{p.left_on ? ` · last day ${shortDay(p.left_on)}` : ''}</span>
                      : p.status === 'left' ? <span className="tm-muted">Left</span> : <span style={{ color: 'var(--success)' }}>Active</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {open && <PersonDrawer key={open} personId={open} meta={meta} apiFetch={apiFetch} toast={toast} onClose={() => setOpen(null)}
        onSaved={(p) => { load(); if (open === 'new' && p) setOpen(p.id) }} onOpenPayslip={openPayslip} />}
    </>
  )
}

/* ───────────────────────────── payroll run ───────────────────────────── */

function PayRun({ meta, apiFetch, toast, openPayslip }) {
  const [runs, setRuns] = useState(null)
  const [runId, setRunId] = useState(null)
  const [data, setData] = useState(null)
  const [month, setMonth] = useState(() => { const d = new Date(); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` })
  const [company, setCompany] = useState('')
  const [busy, setBusy] = useState(false)
  const [picked, setPicked] = useState(new Set())
  const [expand, setExpand] = useState(null)

  const loadRuns = async () => {
    const r = await apiFetch('/api/team/runs')
    if (r && !r.error) { setRuns(r.runs); if (!runId && r.runs[0]) setRunId(r.runs[0].id) }
  }
  const loadRun = async (id = runId) => {
    if (!id) return
    const r = await apiFetch(`/api/team/runs/${id}`)
    if (!r || r.error) { toast.error(r?.error || 'Could not load the run'); return }
    setData(r); setPicked(new Set())
  }
  useEffect(() => { loadRuns() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadRun() }, [runId]) // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    setBusy(true)
    const r = await apiFetch('/api/team/runs', { method: 'POST', body: JSON.stringify({ month }) })
    setBusy(false)
    if (!r || r.error) { toast.error(r?.error || 'Could not start the run'); return }
    await loadRuns(); setRunId(r.id); loadRun(r.id)
  }
  const saveIncentive = async (line, incentive, note) => {
    if (Number(incentive || 0) === Number(line.incentive) && (note ?? line.incentive_note) === line.incentive_note) return
    const r = await apiFetch(`/api/team/runs/${data.run.id}/lines/${line.id}`, { method: 'PUT', body: JSON.stringify({ incentive, incentive_note: note ?? line.incentive_note }) })
    if (!r || r.error) { toast.error(r?.error || 'Could not save'); return }
    loadRun()
  }
  const act = async (path, confirm, done) => {
    if (confirm && !await toast.confirm(confirm)) return
    setBusy(true)
    const r = await apiFetch(`/api/team/runs/${data.run.id}/${path.url}`, { method: 'POST', body: JSON.stringify(path.body || {}) })
    setBusy(false)
    if (!r || r.error) { toast.error(r?.error || 'Could not do that'); return }
    if (done) toast.success(typeof done === 'function' ? done(r) : done)
    loadRun(); loadRuns()
  }
  const bankFile = async () => {
    const r = await apiFetch(`/api/team/runs/${data.run.id}/bank.csv${company ? `?company=${company}` : ''}`, { responseType: 'blob' })
    if (!r || r.error) { toast.error(r?.error || 'Could not build the file'); return }
    const url = URL.createObjectURL(r.blob)
    const a = document.createElement('a'); a.href = url; a.download = r.filename || 'salaries.csv'
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10000)
  }

  const lines = useMemo(() => (data?.lines || []).filter(l => !company || l.company === company || l.company === 'both'), [data, company])
  const sum = (k) => lines.reduce((a, l) => a + Number(l[k] || 0), 0)
  const draft = data?.run.status === 'draft'

  if (!runs) return <div className="loader"><div className="spinner" /></div>
  return (
    <>
      <div className="tm-run-bar">
        <label className="tm-field-inline">Run
          <select value={runId || ''} onChange={e => setRunId(Number(e.target.value))}>
            {!runs.length && <option value="">No runs yet</option>}
            {runs.map(r => <option key={r.id} value={r.id}>{monthLabel(r.month)} · {r.status}</option>)}
          </select></label>
        <label className="tm-field-inline">Company
          <select value={company} onChange={e => setCompany(e.target.value)}><option value="">Both companies</option><option value="normless">Normless</option><option value="crewfit">Crewfit</option></select></label>
        <span className="tm-spacer" />
        <label className="tm-field-inline">Start a month <input type="month" value={month} max={thisMonth()} onChange={e => setMonth(e.target.value)} /></label>
        <button className="btn btn-secondary btn-sm" disabled={busy} onClick={start}>Start or open</button>
      </div>

      {!data ? (runs.length ? <div className="loader"><div className="spinner" /></div> : <div className="empty-state"><div className="empty-icon">🧾</div><p>Start the month you are paying for. Everyone's salary, leave and claims fill in by themselves.</p></div>) : (
        <>
          <header className="tm-run-head">
            <div><h2>{data.run.name}</h2><span className="tm-muted">Pay date {day(data.run.pay_date)} · prepared by {data.run.prepared_by}{data.run.approved_by ? ` · approved by ${data.run.approved_by}` : ''}</span></div>
            <div className="tm-head-actions">
              {draft && data.canApprove && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act({ url: 'approve' }, { title: `Approve ${data.run.name}?`, message: `${inr(data.totals.net)} for ${data.lines.length} people. The amounts lock until reopened.`, confirmLabel: 'Approve' }, 'Payroll approved')}>Approve</button>}
              {draft && !data.canApprove && <span className="tm-muted">An owner or admin approves it</span>}
              {data.run.status === 'approved' && data.canApprove && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => act({ url: 'reopen' }, { title: 'Reopen as a draft?', message: 'The amounts are worked out again.', confirmLabel: 'Reopen' }, 'Reopened')}>Reopen</button>}
              {!draft && <button className="btn btn-secondary btn-sm" onClick={bankFile}><Icon name="download" size={14} /> Bank file</button>}
              {data.run.status === 'approved' && (
                <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act({ url: 'paid', body: { line_ids: picked.size ? [...picked] : 'all' } },
                  { title: picked.size ? `Mark ${picked.size} paid?` : 'Mark everyone paid?', message: 'Each person gets their payslip by email and in the CRM.', confirmLabel: 'Mark paid' },
                  (r) => `${r.paid} marked paid${r.emailed ? `, ${r.emailed} payslip${r.emailed === 1 ? '' : 's'} emailed` : ''}`)}>
                  {picked.size ? `Mark ${picked.size} paid` : 'Mark all paid'}</button>
              )}
            </div>
          </header>

          <ol className="tm-steps" aria-label="Steps">
            {[['Leave and LOP', 'From approved leave', true], ['Incentives and claims', `${inr(data.totals.claims)} in claims`, true],
              ['Review', draft ? `${data.checks.length} to check` : 'Checked', !draft], ['Approve', 'Locks the numbers', !draft],
              ['Pay and payslips', 'Bank file · email', data.run.status === 'paid']]
              .map(([title, sub, done], i) => {
                const now = (draft && i === 2) || (data.run.status === 'approved' && i === 4)
                return <li key={title} className={now ? 'now' : done ? 'done' : ''}><small>{i + 1}{now ? ' · Now' : done ? ' · Done' : ''}</small><b>{title}</b><span>{sub}</span></li>
              })}
          </ol>

          <div className="tm-kpis">
            <div className="tm-kpi"><b>{inr(sum('salary'))}</b><span>Salaries for the month</span></div>
            <div className="tm-kpi tm-kpi-bad"><b>− {inr(sum('lop_amount'))}</b><span>Loss of pay · {num(sum('lop_days'))} days, {lines.filter(l => Number(l.lop_days) > 0).length} people</span></div>
            <div className="tm-kpi"><b>+ {inr(sum('incentive') + sum('claims'))}</b><span>Incentives and claims{sum('advance_back') ? ` · − ${inr(sum('advance_back'))} advances` : ''}</span></div>
            <div className="tm-kpi tm-kpi-good"><b>{inr(sum('net'))}</b><span>To bank accounts{data.totals.previous ? ` · vs ${inr(data.totals.previous)} last month` : ''}</span></div>
          </div>

          {data.checks.length > 0 && draft && (
            <div className="tm-checks" role="note"><b>{data.checks.length} to check before approval</b>{data.checks.map((c, i) => <span key={i}>{c.text}</span>)}</div>
          )}

          <div className="data-table-wrapper">
            <table className="data-table tm-run-table">
              <thead><tr>
                {data.run.status === 'approved' && <th aria-label="Pick" />}
                <th>Person</th><th style={{ textAlign: 'right' }}>Salary</th><th style={{ textAlign: 'center' }}>Paid leave</th><th style={{ textAlign: 'center' }}>LOP days</th>
                <th style={{ textAlign: 'right' }}>LOP</th><th style={{ textAlign: 'right' }}>Incentive / bonus</th><th style={{ textAlign: 'right' }}>Claims</th>
                <th style={{ textAlign: 'right' }}>Advance back</th><th style={{ textAlign: 'right' }}>Net pay</th><th>Pay to</th><th aria-label="Payslip" />
              </tr></thead>
              <tbody>
                {lines.map(l => (
                  <FragmentRow key={l.id} l={l} draft={draft} approved={data.run.status === 'approved'} picked={picked.has(l.id)}
                    onPick={() => setPicked(s => { const n = new Set(s); n.has(l.id) ? n.delete(l.id) : n.add(l.id); return n })}
                    expanded={expand === l.id} onExpand={() => setExpand(expand === l.id ? null : l.id)}
                    onIncentive={saveIncentive} onPayslip={() => openPayslip(data.run.id, l.employee_id)} />
                ))}
                <tr className="tm-total-row">
                  {data.run.status === 'approved' && <td />}
                  <td>{lines.length} people</td><td style={{ textAlign: 'right' }}>{inr(sum('salary'))}</td><td style={{ textAlign: 'center' }}>{num(sum('paid_leave_days'))}</td>
                  <td style={{ textAlign: 'center' }}>{num(sum('lop_days'))}</td><td style={{ textAlign: 'right' }}>− {inr(sum('lop_amount'))}</td>
                  <td style={{ textAlign: 'right' }}>{inr(sum('incentive'))}</td><td style={{ textAlign: 'right' }}>{inr(sum('claims'))}</td>
                  <td style={{ textAlign: 'right' }}>− {inr(sum('advance_back'))}</td><td style={{ textAlign: 'right' }}>{inr(sum('net'))}</td><td colSpan={2} />
                </tr>
              </tbody>
            </table>
          </div>
          <p className="tm-muted" style={{ fontSize: 12.5 }}>Click a LOP number to see the days behind it. A draft is worked out again each time it is opened, so newly approved leave and claims show up by themselves.</p>
        </>
      )}
    </>
  )
}

function FragmentRow({ l, draft, approved, picked, onPick, expanded, onExpand, onIncentive, onPayslip }) {
  const [inc, setInc] = useState(String(Number(l.incentive) || ''))
  useEffect(() => { setInc(String(Number(l.incentive) || '')) }, [l.incentive])
  const det = l.detail || {}
  const KIND = { leave: 'Leave', absent: 'Absent', permission: 'Permission' }
  return (
    <>
      <tr className={!l.has_bank && !l.upi_id ? 'tm-row-warn' : ''}>
        {approved && <td onClick={e => e.stopPropagation()}>{l.status !== 'paid' && <input type="checkbox" aria-label={`Pick ${l.name}`} checked={picked} onChange={onPick} />}</td>}
        <td className="cell-primary"><b>{l.name}</b><div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{l.company === 'both' ? 'Both' : l.company === 'crewfit' ? 'Crewfit' : 'Normless'}{l.department ? ` · ${l.department}` : ''}</div></td>
        <td data-label="Salary" style={{ textAlign: 'right' }}>{inr(l.salary)}</td>
        <td data-label="Paid leave" style={{ textAlign: 'center' }}>{num(l.paid_leave_days)}</td>
        <td data-label="LOP days" style={{ textAlign: 'center' }}>
          {Number(l.lop_days) > 0 ? <button type="button" className="tm-link" onClick={onExpand} aria-expanded={expanded}>{num(l.lop_days)}</button> : <span className="tm-muted">0</span>}</td>
        <td data-label="LOP" style={{ textAlign: 'right', color: Number(l.lop_amount) ? 'var(--danger)' : undefined }}>{Number(l.lop_amount) ? `− ${inr(l.lop_amount)}` : '—'}</td>
        <td data-label="Incentive" style={{ textAlign: 'right' }}>
          {draft ? <input className="tm-num-input" aria-label={`Incentive for ${l.name}`} inputMode="numeric" value={inc} placeholder="0"
            onChange={e => setInc(e.target.value.replace(/[^\d.]/g, ''))} onBlur={() => onIncentive(l, inc || 0)} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />
            : (Number(l.incentive) ? inr(l.incentive) : '—')}</td>
        <td data-label="Claims" style={{ textAlign: 'right' }}>{Number(l.claims) ? inr(l.claims) : '—'}</td>
        <td data-label="Advance" style={{ textAlign: 'right', color: Number(l.advance_back) ? 'var(--danger)' : undefined }}>{Number(l.advance_back) ? `− ${inr(l.advance_back)}` : '—'}</td>
        <td data-label="Net pay" style={{ textAlign: 'right', fontWeight: 700 }}>{inr(l.net)}</td>
        <td data-label="Pay to" style={{ fontSize: 12.5, color: !l.has_bank && !l.upi_id ? 'var(--warning)' : 'var(--text-secondary)' }}>
          {l.status === 'paid' ? <span style={{ color: 'var(--success)' }}>Paid{l.utr ? ` · ${l.utr}` : ''}</span> : (l.pay_to || 'No bank account')}</td>
        <td><button type="button" className="mini-btn" onClick={onPayslip}>Payslip</button></td>
      </tr>
      {expanded && (
        <tr className="tm-detail-row"><td colSpan={12}>
          <div className="tm-lop-detail">
            <span>Paid leave at the start: {num(det.opening_balance)} + {num(det.allowance)} this month</span>
            {(det.leave || []).map((d, i) => <span key={i}>{KIND[d.kind]} {shortDay(d.day)}{d.hours ? ` · ${num(d.hours)}h` : d.days !== 1 ? ` · ${d.days} day` : ''}</span>)}
            {det.permission_lop > 0 && <span>Permission over the allowance: {num(det.permission_lop)} day LOP</span>}
            {det.not_employed_days > 0 && <span>Days before joining or after leaving: {num(det.not_employed_days)}</span>}
            <span>Day rate {inr(l.day_rate)}</span>
          </div>
        </td></tr>
      )}
    </>
  )
}

/* ───────────────────────────── leave ───────────────────────────── */

const KIND_LABEL = { leave: 'Leave', half: 'Half day', permission: 'Permission', absent: 'Absent' }
export const describeLeave = (l) => (l.kind === 'permission'
  ? `${shortDay(l.from_date)}${l.start_time ? `, ${l.start_time}–${l.end_time || ''}` : ''} · ${num(l.hours)}h`
  : l.kind === 'half' ? `${shortDay(l.from_date)}, ${l.half === 'am' ? 'morning' : 'afternoon'}`
    : l.from_date === l.to_date ? shortDay(l.from_date) : `${shortDay(l.from_date)} – ${shortDay(l.to_date)}`)

export function LeaveTab({ apiFetch, toast, onChange, canPayroll }) {
  const [view, setView] = useState('pending')
  const [month, setMonth] = useState(thisMonth())
  const [data, setData] = useState(null)
  const [recording, setRecording] = useState(false)
  const [holidays, setHolidays] = useState([])
  const [ask, reasonDialog] = useReason()
  const load = async () => {
    const q = view === 'pending' ? 'status=pending' : view === 'calendar' ? `status=all&month=${month}` : 'status=all'
    const r = await apiFetch(`/api/team/leave?${q}`)
    if (!r || r.error) { toast.error(r?.error || 'Could not load leave'); return }
    setData(r)
  }
  useEffect(() => { load() }, [view, month]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { apiFetch('/api/team/holidays').then(r => r && !r.error && setHolidays(r.holidays)) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const decide = async (l, decision) => {
    let note
    if (decision === 'reject') { note = await ask({ title: `Reject ${l.name}'s ${KIND_LABEL[l.kind].toLowerCase()}?`, label: 'Tell them why', confirmLabel: 'Reject', danger: true }); if (!note) return }
    const r = await apiFetch(`/api/team/leave/${l.id}/decide`, { method: 'POST', body: JSON.stringify({ decision, note }) })
    if (!r || r.error) { toast.error(r?.error || 'Could not save'); return }
    toast.success(decision === 'approve' ? 'Approved' : 'Rejected')
    load(); onChange?.()
  }
  const cancel = async (l) => {
    if (!await toast.confirm({ title: 'Cancel this leave?', message: `${l.name} · ${describeLeave(l)}`, confirmLabel: 'Cancel it', danger: true })) return
    const r = await apiFetch(`/api/team/leave/${l.id}/cancel`, { method: 'POST' })
    if (r?.error) { toast.error(r.error); return }
    load(); onChange?.()
  }

  return (
    <>
      <div className="tm-run-bar">
        <div className="tm-views" role="tablist">
          {[['pending', 'To approve'], ['calendar', 'Calendar'], ['history', 'History'], ...(canPayroll ? [['holidays', 'Holidays']] : [])].map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={view === k} className={view === k ? 'on' : ''} onClick={() => setView(k)}>{l}</button>
          ))}
        </div>
        {view === 'calendar' && <input type="month" aria-label="Month" value={month} onChange={e => setMonth(e.target.value)} />}
        <span className="tm-spacer" />
        <button className="btn btn-primary btn-sm" onClick={() => setRecording(true)}><Icon name="plus" size={14} /> Record leave or absence</button>
      </div>
      {view === 'holidays' ? <Holidays holidays={holidays} setHolidays={setHolidays} apiFetch={apiFetch} toast={toast} /> : !data ? <div className="loader"><div className="spinner" /></div>
        : view === 'calendar' ? <LeaveCalendar data={data} month={month} holidays={holidays} /> : (
          <div className="tm-list">
            {!data.leave.length && <div className="empty-state"><div className="empty-icon">🌴</div><p>{view === 'pending' ? 'Nothing waiting for approval.' : 'No leave recorded yet.'}</p></div>}
            {data.leave.map(l => (
              <article key={l.id} className="tm-request">
                <Avatar name={l.name} size={40} />
                <div className="tm-request-main">
                  <div className="tm-request-title"><b>{l.name} · {KIND_LABEL[l.kind]}</b>
                    <span className="tm-label">{l.kind === 'permission' ? `${num(l.hours)} hours` : l.kind === 'half' ? '0.5 day' : `${Math.round((new Date(l.to_date) - new Date(l.from_date)) / 86400000) + 1} day(s)`}</span>
                    {view !== 'pending' && <span className={`tm-st-word tm-${l.status}`}>{l.status}</span>}</div>
                  <span>{describeLeave(l)}{l.reason ? ` · "${l.reason}"` : ''}</span>
                  {l.effect && <span className="tm-muted">
                    {l.kind === 'permission'
                      ? `Used ${num(l.effect.permissionUsed)}h of ${num(l.effect.permissionAllowed)}h this month`
                      : `Has ${num(l.effect.paidLeft)} paid day${l.effect.paidLeft === 1 ? '' : 's'} left${(() => {
                        const days = l.kind === 'half' ? 0.5 : Math.round((new Date(l.to_date) - new Date(l.from_date)) / 86400000) + 1
                        const lop = Math.max(0, days - l.effect.paidLeft)
                        return lop ? ` → up to ${num(lop)} day${lop === 1 ? '' : 's'} loss of pay` : ' → paid'
                      })()}`}
                  </span>}
                  {l.decision_note && <span className="tm-muted">Note: {l.decision_note}</span>}
                </div>
                <div className="tm-request-actions">
                  {l.status === 'pending' ? (
                    <><button className="btn btn-secondary btn-sm tm-reject" onClick={() => decide(l, 'reject')}>Reject</button>
                      <button className="btn btn-sm tm-approve" onClick={() => decide(l, 'approve')}>Approve</button></>
                  ) : l.status === 'approved' && <button className="mini-btn" onClick={() => cancel(l)}>Cancel</button>}
                </div>
              </article>
            ))}
          </div>
        )}
      {recording && <LeaveForm people={data?.people || []} apiFetch={apiFetch} toast={toast} forSomeone
        onClose={() => setRecording(false)} onSaved={() => { setRecording(false); load(); onChange?.() }} />}
      {reasonDialog}
    </>
  )
}

function LeaveCalendar({ data, month, holidays }) {
  const days = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()
  const list = Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)
  const hol = new Set(holidays.map(h => h.day))
  const people = [...new Set(data.leave.filter(l => ['approved', 'pending'].includes(l.status)).map(l => l.name))].sort()
  const cell = (name, d) => {
    const off = new Date(`${d}T00:00:00`).getDay() === 0 || hol.has(d)
    const hit = data.leave.find(l => l.name === name && ['approved', 'pending'].includes(l.status) && l.from_date <= d && l.to_date >= d)
    if (hit) return { cls: `tm-cal-${hit.kind}${hit.status === 'pending' ? ' tm-cal-pending' : ''}`, title: `${KIND_LABEL[hit.kind]}${hit.status === 'pending' ? ' (waiting)' : ''}` }
    return off ? { cls: 'tm-cal-off', title: hol.has(d) ? holidays.find(h => h.day === d).name : 'Sunday' } : { cls: '', title: '' }
  }
  return (
    <section className="tm-cal-box">
      <div className="tm-legend"><span><i className="tm-cal-leave" />Leave</span><span><i className="tm-cal-half" />Half day</span><span><i className="tm-cal-permission" />Permission</span><span><i className="tm-cal-absent" />Absent</span><span><i className="tm-cal-off" />Sunday / holiday</span><span><i className="tm-cal-leave tm-cal-pending" />Waiting</span></div>
      {!people.length ? <p className="tm-muted">Nobody is away in {monthLabel(month)}.</p> : (
        <div className="tm-cal-scroll">
          <div className="tm-cal" style={{ gridTemplateColumns: `140px repeat(${days}, minmax(22px, 1fr))` }}>
            <span />{list.map(d => <span key={d} className="tm-cal-day">{Number(d.slice(8))}</span>)}
            {people.map(name => (
              <div key={name} style={{ display: 'contents' }}>
                <span className="tm-cal-name">{name}</span>
                {list.map(d => { const c = cell(name, d); return <span key={d} className={`tm-cal-cell ${c.cls}`} title={c.title ? `${name}, ${shortDay(d)}: ${c.title}` : undefined} /> })}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

function Holidays({ holidays, setHolidays, apiFetch, toast }) {
  const [f, setF] = useState({ day: '', name: '' })
  const reload = async () => { const r = await apiFetch('/api/team/holidays'); if (r && !r.error) setHolidays(r.holidays) }
  const add = async (e) => {
    e.preventDefault()
    const r = await apiFetch('/api/team/holidays', { method: 'POST', body: JSON.stringify(f) })
    if (!r || r.error) { toast.error(r?.error || 'Could not save'); return }
    setF({ day: '', name: '' }); reload()
  }
  const remove = async (h) => { await apiFetch(`/api/team/holidays/${h.day}`, { method: 'DELETE' }); reload() }
  return (
    <section className="tm-cal-box">
      <p className="tm-muted" style={{ margin: 0 }}>Paid days off for everyone. Sundays are already off. Leave over a holiday doesn't use up leave.</p>
      <form className="tm-inline-add" onSubmit={add}>
        <input type="date" aria-label="Date" required value={f.day} onChange={e => setF({ ...f, day: e.target.value })} />
        <input aria-label="Name" placeholder="Diwali" required value={f.name} onChange={e => setF({ ...f, name: e.target.value })} />
        <button className="btn btn-secondary btn-sm" type="submit">Add holiday</button>
      </form>
      {holidays.map(h => <div key={h.day} className="tm-kv"><span>{day(h.day)} · {h.name}</span><button className="mini-btn" onClick={() => remove(h)}>Remove</button></div>)}
    </section>
  )
}

/** Asking for leave (for yourself) or recording it (for someone you manage, already approved). */
export function LeaveForm({ people = [], apiFetch, toast, forSomeone, balance, onClose, onSaved }) {
  const [f, setF] = useState({ employee_id: '', kind: 'leave', from_date: today(), to_date: today(), half: 'pm', hours: '', start_time: '', end_time: '', reason: '' })
  const [saving, setSaving] = useState(false)
  const kinds = forSomeone ? [['leave', 'Full day'], ['half', 'Half day'], ['permission', 'Permission'], ['absent', 'Absent (didn’t ask)']] : [['leave', 'Full-day leave'], ['half', 'Half day'], ['permission', 'Permission (hours)']]
  // Hours from the two times, so nobody has to do the sum.
  useEffect(() => {
    if (f.kind !== 'permission' || !f.start_time || !f.end_time) return
    const [a, b] = [f.start_time, f.end_time].map(t => { const [h, m] = t.split(':').map(Number); return h * 60 + m })
    if (b > a) setF(x => ({ ...x, hours: String(Math.round(((b - a) / 60) * 4) / 4) }))
  }, [f.kind, f.start_time, f.end_time])
  const days = f.kind === 'half' ? 0.5 : f.kind === 'leave' || f.kind === 'absent' ? Math.max(1, Math.round((new Date(f.to_date) - new Date(f.from_date)) / 86400000) + 1) : 0
  const save = async (e) => {
    e.preventDefault()
    setSaving(true)
    const body = { ...f, employee_id: forSomeone ? f.employee_id : undefined }
    const r = await apiFetch('/api/team/leave', { method: 'POST', body: JSON.stringify(body) })
    setSaving(false)
    if (!r || r.error) { toast.error(r?.error || 'Could not save'); return }
    toast.success(r.status === 'pending' ? 'Sent for approval' : 'Recorded')
    onSaved()
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal-card tm-leave-form" role="dialog" aria-modal="true" aria-label="Leave" onClick={e => e.stopPropagation()} onSubmit={save}>
        <h3 style={{ margin: '0 0 14px' }}>{forSomeone ? 'Record leave or an absence' : 'Ask for leave or permission'}</h3>
        {forSomeone && (
          <div className="input-group"><label htmlFor="lf-who">Who</label>
            <select id="lf-who" required value={f.employee_id} onChange={e => setF({ ...f, employee_id: e.target.value })}>
              <option value="">Choose…</option>{people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
        )}
        <div className="tm-kind" role="radiogroup" aria-label="Type">
          {kinds.map(([k, l]) => <label key={k} className={f.kind === k ? 'on' : ''}><input type="radio" name="lf-kind" checked={f.kind === k} onChange={() => setF({ ...f, kind: k })} />{l}</label>)}
        </div>
        <div className="form-row">
          <div className="input-group"><label htmlFor="lf-from">{f.kind === 'leave' || f.kind === 'absent' ? 'From' : 'On'}</label><input id="lf-from" type="date" required value={f.from_date} onChange={e => setF({ ...f, from_date: e.target.value, to_date: e.target.value > f.to_date ? e.target.value : f.to_date })} /></div>
          {(f.kind === 'leave' || f.kind === 'absent') && <div className="input-group"><label htmlFor="lf-to">To</label><input id="lf-to" type="date" min={f.from_date} required value={f.to_date} onChange={e => setF({ ...f, to_date: e.target.value })} /></div>}
          {f.kind === 'half' && <div className="input-group"><label htmlFor="lf-half">Which half</label><select id="lf-half" value={f.half} onChange={e => setF({ ...f, half: e.target.value })}><option value="am">Morning</option><option value="pm">Afternoon</option></select></div>}
        </div>
        {f.kind === 'permission' && (
          <div className="form-row">
            <div className="input-group"><label htmlFor="lf-s">From</label><input id="lf-s" type="time" value={f.start_time} onChange={e => setF({ ...f, start_time: e.target.value })} /></div>
            <div className="input-group"><label htmlFor="lf-e">To</label><input id="lf-e" type="time" value={f.end_time} onChange={e => setF({ ...f, end_time: e.target.value })} /></div>
            <div className="input-group"><label htmlFor="lf-h">Hours</label><input id="lf-h" type="number" min="0.25" max="8" step="0.25" required value={f.hours} onChange={e => setF({ ...f, hours: e.target.value })} /></div>
          </div>
        )}
        <div className="input-group"><label htmlFor="lf-r">Reason</label><input id="lf-r" value={f.reason} placeholder={f.kind === 'absent' ? 'Didn’t come in, didn’t call' : 'Family function'} onChange={e => setF({ ...f, reason: e.target.value })} /></div>
        {balance && f.kind !== 'permission' && <p className="tm-hint">You have {num(balance.paidLeft)} paid day{balance.paidLeft === 1 ? '' : 's'} left{days > balance.paidLeft ? ` — ${num(days - balance.paidLeft)} day${days - balance.paidLeft === 1 ? '' : 's'} of this will be loss of pay` : ' — this is paid'}.</p>}
        {balance && f.kind === 'permission' && <p className="tm-hint">You've used {num(balance.permissionUsed)}h of {num(balance.permissionAllowed)}h this month.</p>}
        {forSomeone && <p className="tm-hint">Recorded as approved. {f.kind === 'absent' ? 'An absence counts as loss of pay.' : ''}</p>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : forSomeone ? 'Record' : 'Send for approval'}</button>
        </div>
      </form>
    </div>
  )
}

/* ───────────────────────────── claims ───────────────────────────── */

const CLAIM_STATUS = { pending: 'Waiting', lead_ok: 'Manager approved', approved: 'Approved', paid: 'Paid', rejected: 'Rejected' }

export function ClaimsTab({ apiFetch, toast, onChange, canPayroll }) {
  const [view, setView] = useState('open')
  const [data, setData] = useState(null)
  const [ask, reasonDialog] = useReason()
  const load = async () => {
    const r = await apiFetch(`/api/team/claims?status=${view === 'advances' ? 'open' : view}`)
    if (!r || r.error) { toast.error(r?.error || 'Could not load claims'); return }
    setData(r)
  }
  useEffect(() => { load() }, [view]) // eslint-disable-line react-hooks/exhaustive-deps
  const decide = async (c, decision) => {
    let reason
    if (decision === 'reject') { reason = await ask({ title: `Reject "${c.title}"?`, label: 'Tell them why', confirmLabel: 'Reject', danger: true }); if (!reason) return }
    const r = await apiFetch(`/api/team/claims/${c.id}/decide`, { method: 'POST', body: JSON.stringify({ decision, reason }) })
    if (!r || r.error) { toast.error(r?.error || 'Could not save'); return }
    toast.success(r.status === 'lead_ok' ? 'Approved — now with payroll' : r.status === 'approved' ? 'Approved' : 'Rejected')
    load(); onChange?.()
  }
  const paid = async (c) => {
    if (!await toast.confirm({ title: `Mark "${c.title}" paid?`, message: `${inr(c.amount)} to ${c.name}, outside the salary.`, confirmLabel: 'Mark paid' })) return
    const r = await apiFetch(`/api/team/claims/${c.id}/paid`, { method: 'POST' })
    if (r?.error) { toast.error(r.error); return }
    load()
  }
  const openReceipt = async (c, n) => {
    const r = await apiFetch(`/api/team/claims/${c.id}/receipt/${n}`, { responseType: 'blob' })
    if (!r || r.error) { toast.error(r?.error || 'Could not open the receipt'); return }
    const url = URL.createObjectURL(r.blob)
    window.open(url, '_blank')
    setTimeout(() => URL.revokeObjectURL(url), 60000)
  }
  const counts = data?.counts || {}
  const views = [['open', 'To approve', (counts.pending || 0) + (counts.lead_ok || 0)], ['approved', 'Approved, not paid', counts.approved], ['paid', 'Paid'], ['rejected', 'Rejected'], ...(canPayroll ? [['advances', 'Advances']] : [])]
  return (
    <>
      <div className="tm-run-bar">
        <div className="tm-views" role="tablist">
          {views.map(([k, l, n]) => <button key={k} type="button" role="tab" aria-selected={view === k} className={view === k ? 'on' : ''} onClick={() => setView(k)}>{l}{n ? <span className="tm-count">{n}</span> : null}</button>)}
        </div>
      </div>
      {!data ? <div className="loader"><div className="spinner" /></div> : view === 'advances' ? (
        <section className="tm-cal-box">
          <p className="tm-muted" style={{ margin: 0 }}>Salary given ahead, taken back from each month's pay. Give one from a person's Salary tab.</p>
          {data.advances.map(a => <div key={a.id} className="tm-kv"><span>{a.name} · {day(a.given_on)} · {inr(a.recover_per_month)}/month{a.note ? ` · ${a.note}` : ''}</span><b>{inr(a.amount)} · {inr(a.owed)} left</b></div>)}
          {!data.advances.length && <p className="tm-muted">No advances.</p>}
        </section>
      ) : (
        <div className="tm-list">
          {!data.claims.length && <div className="empty-state"><div className="empty-icon">🧾</div><p>Nothing here.</p></div>}
          {data.claims.map(c => (
            <article key={c.id} className="tm-request">
              <button type="button" className="tm-receipt" disabled={!c.receipts} onClick={() => openReceipt(c, 0)} aria-label={c.receipts ? `Open the receipt for ${c.title}` : 'No receipt'}>
                {c.receipts ? <><Icon name="invoice" size={18} /><span>{c.receipts} receipt{c.receipts === 1 ? '' : 's'}</span></> : <span>No receipt</span>}
              </button>
              <div className="tm-request-main">
                <div className="tm-request-title"><b>{c.title}</b><CompanyPill company={c.company} /><span className="tm-muted">{c.category}</span></div>
                <span>{c.name} · spent {shortDay(c.spent_on)}{c.link_ref ? ` · ${c.link_ref}` : ''} · {c.with_salary ? 'with salary' : 'paid straight away'}</span>
                <span className="tm-muted">{CLAIM_STATUS[c.status]}{c.lead_by ? ` · manager ${c.lead_by.split('@')[0]}` : ''}{c.rejected_reason ? ` · ${c.rejected_reason}` : ''}</span>
              </div>
              <div className="tm-request-actions">
                <b className="tm-amount">{inr(c.amount)}</b>
                {['pending', 'lead_ok'].includes(c.status) && (
                  <div style={{ display: 'flex', gap: 8 }}><button className="btn btn-secondary btn-sm tm-reject" onClick={() => decide(c, 'reject')}>Reject</button>
                    <button className="btn btn-sm tm-approve" onClick={() => decide(c, 'approve')}>Approve</button></div>
                )}
                {c.status === 'approved' && !c.with_salary && canPayroll && <button className="mini-btn" onClick={() => paid(c)}>Mark paid</button>}
              </div>
            </article>
          ))}
        </div>
      )}
      {reasonDialog}
    </>
  )
}

/* ───────────────────────────── settings ───────────────────────────── */

function SettingsTab({ apiFetch, toast }) {
  const [s, setS] = useState(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => { apiFetch('/api/team/settings').then(r => r && !r.error && setS(r.settings)) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return <div className="loader"><div className="spinner" /></div>
  const set = (patch) => setS(x => ({ ...x, ...patch }))
  const setLop = (k, v) => setS(x => ({ ...x, lop: { ...x.lop, [k]: v } }))
  const setCo = (co, k, v) => setS(x => ({ ...x, companies: { ...x.companies, [co]: { ...x.companies[co], [k]: v } } }))
  const save = async () => {
    setSaving(true)
    const r = await apiFetch('/api/team/settings', { method: 'PUT', body: JSON.stringify(s) })
    setSaving(false)
    if (!r || r.error) { toast.error(r?.error || 'Could not save'); return }
    setS(r.settings); toast.success('Settings saved — they apply from the next draft run')
  }
  const example = 22000
  const rate = s.day_basis === 'thirty' ? example / 30 : null
  return (
    <div className="tm-settings">
      <section className="tm-set-card">
        <h3>Loss of pay</h3>
        <div className="input-group"><label htmlFor="st-basis">One day's pay is the monthly salary divided by</label>
          <select id="st-basis" value={s.day_basis} onChange={e => set({ day_basis: e.target.value })}>
            <option value="thirty">30 (every month the same)</option><option value="month">Days in that month (28–31)</option><option value="working">Working days in that month (no Sundays or holidays)</option></select></div>
        <div className="form-row">
          <div className="input-group"><label htmlFor="st-pl">Paid leave each month (days)</label><input id="st-pl" type="number" min="0" step="0.5" value={s.paid_leave_per_month} onChange={e => set({ paid_leave_per_month: e.target.value })} /></div>
          <div className="input-group"><label htmlFor="st-carry">Unused leave carries over, up to (days)</label><input id="st-carry" type="number" min="0" step="0.5" value={s.carry_max} onChange={e => set({ carry_max: e.target.value })} /></div>
        </div>
        <div className="form-row">
          <div className="input-group"><label htmlFor="st-ph">Permission allowed each month (hours)</label><input id="st-ph" type="number" min="0" step="0.5" value={s.permission_hours} onChange={e => set({ permission_hours: e.target.value })} /></div>
          <div className="input-group"><label htmlFor="st-pb">Over that, every … hours is half a day's LOP</label><input id="st-pb" type="number" min="0.5" step="0.5" value={s.permission_block_hours} onChange={e => set({ permission_block_hours: e.target.value })} /></div>
        </div>
        <fieldset className="tm-fieldset">
          <legend>Counts as loss of pay</legend>
          {[['beyond_balance', 'Leave beyond the paid balance'], ['absent', 'Absent without asking (marked by the manager)'],
            ['sandwich', 'A Sunday or holiday between two leave days (leave Sat and Mon also counts Sun)'], ['first_month', 'Leave in the first month after joining (no paid leave yet)']]
            .map(([k, l]) => <label key={k} className="tm-check-line"><input type="checkbox" checked={!!s.lop[k]} onChange={e => setLop(k, e.target.checked)} />{l}</label>)}
        </fieldset>
        <div className="tm-example">
          <b>How it works out</b>
          {rate ? <>Salary {inr(example)} ÷ 30 = {inr(rate)} a day. Two days off with one paid day left → one day LOP = − {inr(rate)}.</>
            : <>One day's pay depends on the month, so a day off costs a little more in a short month.</>}
          <span>{num(Number(s.permission_hours) + Number(s.permission_block_hours))} hours of permission in a month → {num(s.permission_block_hours)} over the free {num(s.permission_hours)} → half a day LOP.</span>
        </div>
      </section>
      <section className="tm-set-card">
        <h3>Pay and payslips</h3>
        <div className="input-group"><label htmlFor="st-day">Salary is paid on day … of the next month</label><input id="st-day" type="number" min="1" max="28" value={s.pay_day} onChange={e => set({ pay_day: e.target.value })} /></div>
        {['normless', 'crewfit'].map(co => (
          <div key={co} className="tm-co-block">
            <h4 className="tm-subhead">{co === 'normless' ? 'Normless' : 'Crewfit'} — on its payslips</h4>
            <div className="input-group"><label htmlFor={`st-${co}-n`}>Company name</label><input id={`st-${co}-n`} value={s.companies[co]?.name || ''} onChange={e => setCo(co, 'name', e.target.value)} /></div>
            <div className="input-group"><label htmlFor={`st-${co}-a`}>Address</label><textarea id={`st-${co}-a`} rows={2} value={s.companies[co]?.address || ''} onChange={e => setCo(co, 'address', e.target.value)} /></div>
          </div>
        ))}
        <h4 className="tm-subhead">Salary parts</h4>
        <p className="tm-muted" style={{ margin: 0, fontSize: 13 }}>Only "Salary", paid in full with no split. PF, ESI, professional tax, TDS and allowances can be added later when the business registers for them.</p>
      </section>
      <div className="tm-settings-save"><button className="btn btn-primary" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save settings'}</button></div>
    </div>
  )
}
