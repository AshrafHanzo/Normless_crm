import { useEffect, useState } from 'react'
import { useApi } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import { LeaveForm, LeaveTab, ClaimsTab, describeLeave } from './Payroll'
import { inr, num, shortDay, monthLabel, today } from './teamUi'

/**
 * Team › My pay & leave: anyone's own payslips, leave and claims, and which updates they want by
 * email. A manager also approves their team's requests here.
 */
const KIND = { leave: 'Leave', half: 'Half day', permission: 'Permission', absent: 'Absent' }
const CLAIM_STATUS = { pending: 'Waiting', lead_ok: 'Manager approved', approved: 'Approved', paid: 'Paid', rejected: 'Rejected' }

export default function Me() {
  const apiFetch = useApi()
  const toast = useToast()
  const [data, setData] = useState(null)
  const [tab, setTab] = useState('mine')
  const [asking, setAsking] = useState(false)
  const [claiming, setClaiming] = useState(false)
  const load = async () => {
    const r = await apiFetch('/api/team/me')
    if (!r || r.error) { toast.error(r?.error || 'Could not load your page'); return }
    setData(r)
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const openPayslip = async (s) => {
    const r = await apiFetch(`/api/team/runs/${s.run_id}/payslip/${data.employee.id}`, { responseType: 'blob' })
    if (!r || r.error) { toast.error(r?.error || 'Could not open the payslip'); return }
    const url = URL.createObjectURL(r.blob)
    window.open(url, '_blank')
    setTimeout(() => URL.revokeObjectURL(url), 60000)
  }
  const cancel = async (l) => {
    if (!await toast.confirm({ title: 'Cancel this request?', message: describeLeave(l), confirmLabel: 'Cancel it' })) return
    const r = await apiFetch(`/api/team/leave/${l.id}/cancel`, { method: 'POST' })
    if (r?.error) { toast.error(r.error); return }
    load()
  }

  if (!data) return <div className="page-enter"><div className="loader"><div className="spinner" /></div></div>
  const emp = data.employee
  const tabs = [['mine', 'Mine'], ...(data.isManager ? [['team-leave', 'My team’s leave'], ['team-claims', 'My team’s claims']] : []), ['emails', 'Notifications']]

  return (
    <div className="page-enter tm-page">
      <div className="dash-toolbar">
        <div><h1>My pay &amp; leave</h1><p style={{ color: 'var(--text-muted)' }}>{emp ? `${emp.name} · ${emp.emp_code}${emp.designation ? ` · ${emp.designation}` : ''}` : 'Your payslips, leave and claims'}</p></div>
        {emp && <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" onClick={() => setClaiming(true)}><Icon name="invoice" size={15} /> New claim</button>
          <button className="btn btn-primary" onClick={() => setAsking(true)}><Icon name="calendar" size={15} /> Ask for leave or permission</button>
        </div>}
      </div>
      {tabs.length > 1 && (
        <div className="scan-tabs" style={{ marginBottom: 18 }} role="tablist">
          {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>)}
        </div>
      )}

      {tab === 'mine' && (!emp ? (
        <div className="empty-state"><div className="empty-icon">🪪</div><p>Your login isn't linked to a person in Payroll yet. Ask the payroll manager to link it — then your payslips, leave and claims show here.</p></div>
      ) : (
        <>
          <div className="tm-kpis">
            <div className="tm-kpi"><b>{num(data.balance.paidLeft)} day{data.balance.paidLeft === 1 ? '' : 's'}</b><span>Paid leave left this month</span></div>
            <div className="tm-kpi"><b>{num(data.balance.permissionUsed)}h of {num(data.balance.permissionAllowed)}h</b><span>Permission used this month</span></div>
            <div className="tm-kpi"><b>{data.payslips[0] ? inr(data.payslips[0].net) : '—'}</b><span>{data.payslips[0] ? `Last salary · ${monthLabel(data.payslips[0].month)}` : 'No payslip yet'}</span></div>
            <div className="tm-kpi"><b>{emp.bank_last4 ? `····${emp.bank_last4}` : '—'}</b><span>{emp.bank_name || 'Paid into'}</span></div>
          </div>
          <div className="tm-me-grid">
            <section className="tm-set-card">
              <h3>My leave</h3>
              {data.leave.map(l => (
                <div key={l.id} className="tm-kv">
                  <span>{KIND[l.kind]} · {describeLeave(l)}{l.reason ? ` · ${l.reason}` : ''}{l.decision_note ? <em className="tm-muted"> — {l.decision_note}</em> : null}</span>
                  <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span className={`tm-st-word tm-${l.status}`}>{l.status}</span>
                    {l.status === 'pending' && <button className="mini-btn" onClick={() => cancel(l)}>Cancel</button>}</span>
                </div>
              ))}
              {!data.leave.length && <p className="tm-muted">No leave yet.</p>}
            </section>
            <section className="tm-set-card">
              <h3>My payslips</h3>
              {data.payslips.map(s => (
                <div key={s.id} className="tm-kv"><span>{monthLabel(s.month)} · {s.status === 'paid' ? `paid ${shortDay(s.paid_at)}` : 'approved, not paid yet'}</span>
                  <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}><b>{inr(s.net)}</b><button className="mini-btn" onClick={() => openPayslip(s)}>PDF</button></span></div>
              ))}
              {!data.payslips.length && <p className="tm-muted">Your payslips appear here once a month's payroll is approved.</p>}
            </section>
            <section className="tm-set-card">
              <h3>My claims</h3>
              {data.claims.map(c => (
                <div key={c.id} className="tm-kv"><span>{c.title} · {shortDay(c.spent_on)}{c.rejected_reason ? <em className="tm-muted"> — {c.rejected_reason}</em> : null}</span>
                  <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}><b>{inr(c.amount)}</b><span className={`tm-st-word tm-${c.status}`}>{CLAIM_STATUS[c.status]}</span></span></div>
              ))}
              {!data.claims.length && <p className="tm-muted">Spent money for work? Submit a claim with the receipt.</p>}
            </section>
          </div>
        </>
      ))}
      {tab === 'team-leave' && <LeaveTab apiFetch={apiFetch} toast={toast} onChange={load} />}
      {tab === 'team-claims' && <ClaimsTab apiFetch={apiFetch} toast={toast} onChange={load} />}
      {tab === 'emails' && <NotifySettings data={data} apiFetch={apiFetch} toast={toast} onSaved={load} />}

      {asking && <LeaveForm apiFetch={apiFetch} toast={toast} balance={data.balance} onClose={() => setAsking(false)} onSaved={() => { setAsking(false); load() }} />}
      {claiming && <ClaimForm categories={data.categories} company={emp?.company} apiFetch={apiFetch} toast={toast} onClose={() => setClaiming(false)} onSaved={() => { setClaiming(false); load() }} />}
    </div>
  )
}

function ClaimForm({ categories = [], company, apiFetch, toast, onClose, onSaved }) {
  const [f, setF] = useState({ title: '', amount: '', spent_on: today(), category: categories[0] || 'Other', company: company === 'crewfit' ? 'crewfit' : 'normless', link_ref: '', with_salary: true })
  const [files, setFiles] = useState([])
  const [saving, setSaving] = useState(false)
  const save = async (e) => {
    e.preventDefault()
    setSaving(true)
    const fd = new FormData()
    for (const [k, v] of Object.entries(f)) fd.append(k, String(v))
    for (const file of files) fd.append('receipts', file)
    const r = await apiFetch('/api/team/claims', { method: 'POST', body: fd })
    setSaving(false)
    if (!r || r.error) { toast.error(r?.error || 'Could not submit'); return }
    toast.success('Claim sent for approval')
    onSaved()
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal-card tm-leave-form" role="dialog" aria-modal="true" aria-label="New claim" onClick={e => e.stopPropagation()} onSubmit={save}>
        <h3 style={{ margin: '0 0 14px' }}>New claim</h3>
        <div className="input-group"><label htmlFor="cl-t">What was it for</label><input id="cl-t" required value={f.title} placeholder="Courier for Crewfit samples" onChange={e => setF({ ...f, title: e.target.value })} /></div>
        <div className="form-row">
          <div className="input-group"><label htmlFor="cl-a">Amount (₹)</label><input id="cl-a" type="number" min="1" required value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} /></div>
          <div className="input-group"><label htmlFor="cl-d">Date spent</label><input id="cl-d" type="date" required value={f.spent_on} max={today()} onChange={e => setF({ ...f, spent_on: e.target.value })} /></div>
        </div>
        <div className="form-row">
          <div className="input-group"><label htmlFor="cl-c">Category</label><select id="cl-c" value={f.category} onChange={e => setF({ ...f, category: e.target.value })}>{categories.map(c => <option key={c}>{c}</option>)}</select></div>
          <div className="input-group"><label htmlFor="cl-co">Company</label><select id="cl-co" value={f.company} onChange={e => setF({ ...f, company: e.target.value })}><option value="normless">Normless</option><option value="crewfit">Crewfit</option></select></div>
        </div>
        <div className="input-group"><label htmlFor="cl-l">Link to (optional)</label><input id="cl-l" value={f.link_ref} placeholder="CF-9021, a customer, an order…" onChange={e => setF({ ...f, link_ref: e.target.value })} /></div>
        <label className="tm-file-drop" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); setFiles([...files, ...e.dataTransfer.files].slice(0, 5)) }}>
          <input type="file" multiple hidden accept="image/*,application/pdf" onChange={e => { setFiles([...files, ...e.target.files].slice(0, 5)); e.target.value = '' }} />
          {files.length ? `${files.length} receipt${files.length === 1 ? '' : 's'}: ${files.map(x => x.name).join(', ')}` : <>Drop the receipt photo or PDF here, or <u>choose a file</u></>}
        </label>
        <label className="tm-check-line"><input type="checkbox" checked={f.with_salary} onChange={e => setF({ ...f, with_salary: e.target.checked })} />Pay with next month's salary (else paid straight away)</label>
        <p className="tm-hint">Goes to your manager first, then payroll. You're told at each step.</p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Sending…' : 'Submit for approval'}</button>
        </div>
      </form>
    </div>
  )
}

function NotifySettings({ data, apiFetch, toast, onSaved }) {
  const [p, setP] = useState(data.prefs)
  const [saving, setSaving] = useState(false)
  const set = (k, ch, v) => setP(x => ({ ...x, events: { ...x.events, [k]: { ...x.events[k], [ch]: v } } }))
  const save = async () => {
    setSaving(true)
    const r = await apiFetch('/api/team/me/prefs', { method: 'PUT', body: JSON.stringify(p) })
    setSaving(false)
    if (!r || r.error) { toast.error(r?.error || 'Could not save'); return }
    toast.success('Saved'); onSaved()
  }
  return (
    <section className="tm-set-card" style={{ maxWidth: 640 }}>
      <h3>What I'm told about</h3>
      <p className="tm-muted" style={{ margin: 0, fontSize: 13 }}>The CRM bell shows updates straight away. Emails go to your login's address; several changes to one task within 5 minutes come as one email.</p>
      <table className="tm-pref-table">
        <thead><tr><th>When</th><th>CRM</th><th>Email</th></tr></thead>
        <tbody>
          {Object.entries(data.events).map(([k, label]) => (
            <tr key={k}><td>{label}</td>
              <td><input type="checkbox" aria-label={`CRM: ${label}`} checked={p.events[k]?.crm !== false} onChange={e => set(k, 'crm', e.target.checked)} /></td>
              <td><input type="checkbox" aria-label={`Email: ${label}`} checked={!!p.events[k]?.email} onChange={e => set(k, 'email', e.target.checked)} /></td></tr>
          ))}
        </tbody>
      </table>
      <label className="tm-check-line"><input type="checkbox" checked={p.digest !== false} onChange={e => setP({ ...p, digest: e.target.checked })} />Morning email at 9:30 am: my tasks due today and late</label>
      <div><button className="btn btn-primary btn-sm" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button></div>
    </section>
  )
}
