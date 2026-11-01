import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Icon from '../../components/Icon'
import useDirtyGuard from '../../hooks/useDirtyGuard'
import { CompanyPill, inr, day, monthLabel, num, today } from './teamUi'

/**
 * A person on the payroll: their details and bank on one tab, salary and its history on
 * another, then leave, payslips and their CRM login. New people open straight on Details.
 */
const blank = () => ({
  name: '', emp_code: '', phone: '', email: '', username: '', company: 'normless', department: '', designation: '',
  manager_username: '', joined_on: today(), left_on: '', status: 'active', monthly_salary: '', paid_leave_per_month: '',
  bank_name: '', bank_account: '', bank_ifsc: '', upi_id: '', pan: '', notes: '',
})
const KIND = { leave: 'Leave', half: 'Half day', permission: 'Permission', absent: 'Absent' }

export default function PersonDrawer({ personId, meta, apiFetch, toast, onClose, onSaved, onOpenPayslip }) {
  const isNew = personId === 'new'
  const [data, setData] = useState(null)
  const [form, setForm] = useState(isNew ? blank() : null)
  const [tab, setTab] = useState('details')
  const [saving, setSaving] = useState(false)
  const [rev, setRev] = useState({ effective_from: today().slice(0, 8) + '01', monthly_salary: '', note: '' })
  const [adv, setAdv] = useState({ amount: '', recover_per_month: '', given_on: today(), note: '' })

  const load = async () => {
    const r = await apiFetch(`/api/team/people/${personId}`)
    if (!r || r.error) { toast.error(r?.error || 'Could not open'); onClose(); return }
    setData(r)
    const p = r.person
    setForm(Object.fromEntries(Object.keys(blank()).map(k => [k, p[k] ?? ''])))
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (!isNew) load() }, [personId])

  const guard = useDirtyGuard({
    snapshot: form, identity: data?.person?.id ?? 'new', onDiscard: onClose, confirm: toast.confirm,
    title: isNew ? 'Discard this person?' : 'Discard your edits?', message: 'There are unsaved details. Closing now will lose them.',
  })
  const set = (patch) => setForm(f => ({ ...f, ...patch }))

  const save = async (e) => {
    e?.preventDefault()
    setSaving(true)
    const r = await apiFetch(isNew ? '/api/team/people' : `/api/team/people/${personId}`, { method: isNew ? 'POST' : 'PUT', body: JSON.stringify(form) })
    setSaving(false)
    if (!r || r.error) { toast.error(r?.error || 'Could not save'); return }
    guard.reset()
    toast.success(isNew ? `${form.name} added` : 'Saved')
    onSaved(r.person)
  }
  const revise = async (e) => {
    e.preventDefault()
    const r = await apiFetch(`/api/team/people/${personId}/salary`, { method: 'POST', body: JSON.stringify(rev) })
    if (!r || r.error) { toast.error(r?.error || 'Could not save the salary'); return }
    toast.success('Salary saved')
    setRev(x => ({ ...x, monthly_salary: '', note: '' }))
    load(); onSaved()
  }
  const giveAdvance = async (e) => {
    e.preventDefault()
    const r = await apiFetch('/api/team/advances', { method: 'POST', body: JSON.stringify({ ...adv, employee_id: personId }) })
    if (!r || r.error) { toast.error(r?.error || 'Could not save the advance'); return }
    toast.success('Advance recorded')
    setAdv({ amount: '', recover_per_month: '', given_on: today(), note: '' })
    load()
  }

  const p = data?.person
  const tabs = isNew ? [['details', 'Details']] : [['details', 'Details'], ['salary', 'Salary'], ['leave', 'Leave'], ['payslips', 'Payslips'], ['access', 'CRM access']]

  return (
    <>
      <div className="drawer-overlay" onClick={guard.requestClose} />
      <div className="drawer tm-person-drawer" role="dialog" aria-modal="true" aria-label={p?.name || 'New person'}>
        <div className="drawer-header">
          <div>
            <h2 style={{ margin: 0, fontSize: 18 }}>{isNew ? 'Add a person' : p?.name || '…'}</h2>
            {p && <span className="tm-muted" style={{ fontSize: 12.5 }}>{p.emp_code} · {p.designation || 'No role set'} · <CompanyPill company={p.company} /></span>}
          </div>
          <button type="button" className="btn-icon" aria-label="Close" onClick={guard.requestClose}><Icon name="close" size={16} /></button>
        </div>
        <div className="tm-tabs tm-tabs-pad" role="tablist">
          {tabs.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
        </div>
        {!form ? <div className="loader"><div className="spinner" /></div> : (
          <div className="drawer-body">
            {tab === 'details' && (
              <>
                <div className="form-row">
                  <div className="input-group"><label htmlFor="p-name">Full name</label><input id="p-name" required value={form.name} onChange={e => set({ name: e.target.value })} /></div>
                  <div className="input-group"><label htmlFor="p-code">Employee ID</label><input id="p-code" value={form.emp_code} placeholder="Given automatically" onChange={e => set({ emp_code: e.target.value })} /></div>
                </div>
                <div className="form-row">
                  <div className="input-group"><label htmlFor="p-phone">Phone</label><input id="p-phone" value={form.phone} inputMode="tel" onChange={e => set({ phone: e.target.value })} /></div>
                  <div className="input-group"><label htmlFor="p-email">Email (for payslips)</label><input id="p-email" type="email" value={form.email} onChange={e => set({ email: e.target.value })} /></div>
                </div>
                <div className="form-row">
                  <div className="input-group"><label htmlFor="p-co">Company</label>
                    <select id="p-co" value={form.company} onChange={e => set({ company: e.target.value })}><option value="normless">Normless</option><option value="crewfit">Crewfit</option><option value="both">Both</option></select></div>
                  <div className="input-group"><label htmlFor="p-dept">Department</label>
                    <input id="p-dept" list="tm-depts" value={form.department} placeholder="Sales, Production…" onChange={e => set({ department: e.target.value })} />
                    <datalist id="tm-depts">{(meta?.departments || []).map(d => <option key={d} value={d} />)}</datalist></div>
                </div>
                <div className="form-row">
                  <div className="input-group"><label htmlFor="p-role">Designation</label><input id="p-role" value={form.designation} placeholder="Sales executive" onChange={e => set({ designation: e.target.value })} /></div>
                  <div className="input-group"><label htmlFor="p-mgr">Manager (approves leave and claims)</label>
                    <select id="p-mgr" value={form.manager_username} onChange={e => set({ manager_username: e.target.value })}>
                      <option value="">Nobody — payroll approves</option>{(meta?.users || []).map(u => <option key={u} value={u}>{u}</option>)}</select></div>
                </div>
                <div className="form-row">
                  <div className="input-group"><label htmlFor="p-join">Joined on</label><input id="p-join" type="date" value={form.joined_on} onChange={e => set({ joined_on: e.target.value })} /></div>
                  <div className="input-group"><label htmlFor="p-status">Status</label>
                    <select id="p-status" value={form.status} onChange={e => set({ status: e.target.value })}><option value="active">Active</option><option value="notice">On notice</option><option value="left">Left</option></select></div>
                  {form.status !== 'active' && <div className="input-group"><label htmlFor="p-left">Last day</label><input id="p-left" type="date" value={form.left_on} onChange={e => set({ left_on: e.target.value })} /></div>}
                </div>
                {isNew && (
                  <div className="form-row">
                    <div className="input-group"><label htmlFor="p-sal">Monthly salary (₹)</label><input id="p-sal" type="number" min="0" required value={form.monthly_salary} onChange={e => set({ monthly_salary: e.target.value })} /></div>
                    <div className="input-group"><label htmlFor="p-pl">Paid leave a month</label><input id="p-pl" type="number" min="0" step="0.5" value={form.paid_leave_per_month} placeholder="Payroll default" onChange={e => set({ paid_leave_per_month: e.target.value })} /></div>
                  </div>
                )}
                <h4 className="tm-subhead">Bank — where the salary goes</h4>
                <div className="form-row">
                  <div className="input-group"><label htmlFor="p-bank">Bank</label><input id="p-bank" value={form.bank_name} placeholder="HDFC" onChange={e => set({ bank_name: e.target.value })} /></div>
                  <div className="input-group"><label htmlFor="p-ifsc">IFSC</label><input id="p-ifsc" value={form.bank_ifsc} placeholder="HDFC0001234" onChange={e => set({ bank_ifsc: e.target.value.toUpperCase() })} /></div>
                </div>
                <div className="form-row">
                  <div className="input-group"><label htmlFor="p-acc">Account number</label><input id="p-acc" value={form.bank_account} inputMode="numeric" onChange={e => set({ bank_account: e.target.value })} /></div>
                  <div className="input-group"><label htmlFor="p-upi">UPI (if no account)</label><input id="p-upi" value={form.upi_id} onChange={e => set({ upi_id: e.target.value })} /></div>
                </div>
                <h4 className="tm-subhead">CRM login</h4>
                <div className="form-row">
                  <div className="input-group"><label htmlFor="p-login">Linked login</label>
                    <select id="p-login" value={form.username} onChange={e => set({ username: e.target.value })}>
                      <option value="">No CRM login</option>{(meta?.users || []).map(u => <option key={u} value={u}>{u}</option>)}</select></div>
                  {!isNew && <div className="input-group"><label htmlFor="p-pl2">Paid leave a month</label><input id="p-pl2" type="number" min="0" step="0.5" value={form.paid_leave_per_month} placeholder="Payroll default" onChange={e => set({ paid_leave_per_month: e.target.value })} /></div>}
                </div>
                <p className="tm-muted" style={{ fontSize: 12.5, margin: 0 }}>With a login linked, they see their own payslips, ask for leave and submit claims under My pay &amp; leave.</p>
                <div className="input-group"><label htmlFor="p-notes">Notes</label><textarea id="p-notes" rows={2} value={form.notes} onChange={e => set({ notes: e.target.value })} /></div>
              </>
            )}

            {tab === 'salary' && data && (
              <>
                <div className="tm-salary-head">
                  <div><span className="tm-muted">Monthly salary now</span><b>{inr(p.monthly_salary)}</b></div>
                  <div><span className="tm-muted">One day's pay</span><b>{data.dayRate ? `${inr(data.dayRate)} (÷ 30)` : 'Varies by month'}</b></div>
                </div>
                <div className="tm-parts">
                  <div><span>Salary</span><b>{inr(p.monthly_salary)}</b></div>
                  <div className="tm-parts-total"><span>Paid to the bank, before leave</span><b>{inr(p.monthly_salary)}</b></div>
                  <p className="tm-muted">One amount, no split. Allowances, PF, ESI, professional tax and TDS can be added in a later version when the business needs them.</p>
                </div>
                <form className="tm-mini-form" onSubmit={revise}>
                  <h4 className="tm-subhead">Change the salary</h4>
                  <div className="form-row">
                    <div className="input-group"><label htmlFor="r-amt">New monthly salary (₹)</label><input id="r-amt" type="number" min="0" required value={rev.monthly_salary} onChange={e => setRev({ ...rev, monthly_salary: e.target.value })} /></div>
                    <div className="input-group"><label htmlFor="r-from">From</label><input id="r-from" type="date" required value={rev.effective_from} onChange={e => setRev({ ...rev, effective_from: e.target.value })} /></div>
                  </div>
                  <div className="input-group"><label htmlFor="r-note">Why</label><input id="r-note" value={rev.note} placeholder="Annual revision" onChange={e => setRev({ ...rev, note: e.target.value })} /></div>
                  <button type="submit" className="btn btn-secondary btn-sm">Save new salary</button>
                </form>
                <div>
                  <h4 className="tm-subhead">History</h4>
                  {data.history.map(h => <div key={h.id} className="tm-kv"><span>{day(h.effective_from)} · {h.note || 'Revision'}</span><b>{inr(h.monthly_salary)}</b></div>)}
                </div>
                <form className="tm-mini-form" onSubmit={giveAdvance}>
                  <h4 className="tm-subhead">Salary advance</h4>
                  {data.advances.map(a => <div key={a.id} className="tm-kv"><span>{day(a.given_on)}{a.note ? ` · ${a.note}` : ''} · {inr(a.recover_per_month)}/month back</span><b>{inr(a.amount)}</b></div>)}
                  <div className="form-row">
                    <div className="input-group"><label htmlFor="a-amt">Amount given (₹)</label><input id="a-amt" type="number" min="1" value={adv.amount} onChange={e => setAdv({ ...adv, amount: e.target.value })} /></div>
                    <div className="input-group"><label htmlFor="a-per">Take back each month (₹)</label><input id="a-per" type="number" min="1" value={adv.recover_per_month} onChange={e => setAdv({ ...adv, recover_per_month: e.target.value })} /></div>
                    <div className="input-group"><label htmlFor="a-on">Given on</label><input id="a-on" type="date" value={adv.given_on} onChange={e => setAdv({ ...adv, given_on: e.target.value })} /></div>
                  </div>
                  <button type="submit" className="btn btn-secondary btn-sm" disabled={!adv.amount || !adv.recover_per_month}>Record advance</button>
                </form>
              </>
            )}

            {tab === 'leave' && data && (
              <>
                <div className="tm-salary-head">
                  <div><span className="tm-muted">Paid leave left this month</span><b>{num(data.balance.paidLeft)} day{data.balance.paidLeft === 1 ? '' : 's'}</b></div>
                  <div><span className="tm-muted">Permission used</span><b>{num(data.balance.permissionUsed)}h of {num(data.balance.permissionAllowed)}h</b></div>
                </div>
                {data.leave.map(l => (
                  <div key={l.id} className="tm-kv"><span>{KIND[l.kind]} · {l.kind === 'permission' ? `${num(l.hours)}h on ${day(l.from_date)}` : l.from_date === l.to_date ? day(l.from_date) : `${day(l.from_date)} – ${day(l.to_date)}`}{l.reason ? ` · ${l.reason}` : ''}</span>
                    <span className={`tm-st-word tm-${l.status}`}>{l.status}</span></div>
                ))}
                {!data.leave.length && <p className="tm-muted">No leave recorded.</p>}
              </>
            )}

            {tab === 'payslips' && data && (
              <>
                {data.payslips.map(s => (
                  <div key={s.id} className="tm-kv">
                    <span>{monthLabel(s.month)} · {s.run_status === 'draft' ? 'draft' : s.status}</span>
                    <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}><b>{inr(s.net)}</b>
                      <button type="button" className="mini-btn" onClick={() => onOpenPayslip(s.run_id, p.id)}>PDF</button></span>
                  </div>
                ))}
                {!data.payslips.length && <p className="tm-muted">No payroll runs include them yet.</p>}
              </>
            )}

            {tab === 'access' && data && (
              data.login ? (
                <>
                  <div className="tm-kv"><span>Login</span><b>{p.username}</b></div>
                  <div className="tm-kv"><span>Role</span><b>{data.login.role}{data.login.active ? '' : ' (disabled)'}</b></div>
                  <div className="tm-access">{data.login.access.map(a => <span key={a} className="tm-label">{a}</span>)}</div>
                  <Link to="/admin" className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }}>Change access in Admin</Link>
                </>
              ) : <p className="tm-muted">No CRM login linked. Link one on the Details tab, or create a login in Admin first.</p>
            )}
          </div>
        )}
        {tab === 'details' && (
          <div className="drawer-footer">
            <button type="button" className="btn btn-secondary" onClick={guard.requestClose}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={save} disabled={saving || !form?.name}>{saving ? 'Saving…' : isNew ? 'Add person' : 'Save'}</button>
          </div>
        )}
      </div>
    </>
  )
}
