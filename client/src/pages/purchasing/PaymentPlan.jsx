import { useState } from 'react'
import Icon from '../../components/Icon'
import { INSTALMENT_CLASS, inr, dueText } from './format'

const num = (v) => Math.round((Number(v) || 0) * 100) / 100
const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const blankRow = () => ({ label: '', by: 'percent', value: '', due_kind: 'date', due_date: '' })
const toRow = (i) => ({
  label: i.label || '',
  by: i.percent ? 'percent' : 'amount',
  value: String(i.percent || i.amount || ''),
  due_kind: i.due_kind === 'delivery' ? 'delivery' : 'date',
  due_date: i.due_date || '',
})
const rowAmount = (r, total) => (r.by === 'percent' ? num(total * (Number(r.value) || 0) / 100) : num(r.value))

/**
 * The payment plan on an order: the instalments and how far the money paid has got through them,
 * and (for people who record payments) an editor for it.
 */
export default function PaymentPlan({ order, vendorName, defaultPlan, canEdit, apiFetch, toast, onSaved }) {
  const [editing, setEditing] = useState(false)
  const [rows, setRows] = useState([])
  const [equal, setEqual] = useState('5')
  const [saveDefault, setSaveDefault] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const total = order.total
  const plan = order.instalments || []

  const start = () => {
    setRows(plan.length ? plan.map(toRow) : [blankRow()])
    setSaveDefault(false); setError(''); setEditing(true)
  }
  const setRow = (idx, patch) => setRows(rs => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  const splitEqually = () => {
    const n = Math.max(1, Math.min(24, parseInt(equal, 10) || 1))
    // Whole rupees where possible; the last one takes what is left.
    const each = Math.floor(total / n)
    setRows(Array.from({ length: n }, (_, i) => ({ ...blankRow(), by: 'amount', value: String(i === n - 1 ? num(total - each * (n - 1)) : each) })))
  }
  const useDefault = () => setRows((defaultPlan || []).map(t => ({
    label: t.label || '',
    by: t.percent ? 'percent' : 'amount',
    value: String(t.percent || t.amount || ''),
    due_kind: t.due_kind === 'delivery' ? 'delivery' : 'date',
    due_date: t.due_kind === 'delivery' || t.days == null ? '' : addDays(order.order_date, Number(t.days) || 0),
  })))

  const sum = num(rows.reduce((s, r) => s + rowAmount(r, total), 0))
  const off = num(total - sum)

  const save = async (instalments = rows) => {
    setSaving(true); setError('')
    const res = await apiFetch(`/api/vendor-orders/${order.id}/plan`, {
      method: 'PUT',
      body: JSON.stringify({
        save_as_default: saveDefault,
        instalments: instalments.map(r => ({
          label: r.label, due_kind: r.due_kind, due_date: r.due_kind === 'date' ? r.due_date || null : null,
          ...(r.by === 'percent' ? { percent: Number(r.value) } : { amount: Number(r.value) }),
        })),
      }),
    })
    setSaving(false)
    if (!res) return
    if (res.error) { setError(res.error); return }
    toast.success(instalments.length ? 'Payment plan saved' : 'Payment plan removed')
    setEditing(false)
    onSaved(res.order)
  }

  if (!total) return null

  return (
    <div className="pp">
      <div className="form-section">
        Payment plan {plan.length > 0 && <span className="section-count">{plan.length} instalment{plan.length > 1 ? 's' : ''}</span>}
        {canEdit && !editing && <button type="button" className="mini-btn" onClick={start}>{plan.length ? 'Edit plan' : '+ Set a plan'}</button>}
      </div>

      {!editing && (plan.length ? (
        <>
          {order.plan_mismatch && (
            <div className="calc-warning">The instalments add up to {inr(order.plan_mismatch)}, but the order total is now {inr(total)}. Edit the plan to match.</div>
          )}
          <div className="pp-list">
            {plan.map(i => (
              <div key={i.id} className="pp-item">
                <span className="pp-num">{i.number}</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{i.label || `Instalment ${i.number} of ${i.of}`}{i.percent ? <span className="pp-muted"> · {Number(i.percent)}%</span> : null}</div>
                  <div className="pp-muted">{dueText(i)}{i.part ? ` · ${inr(i.covered)} paid, ${inr(i.remaining)} left` : ''}</div>
                </div>
                <b className="pp-amt">{inr(i.amount)}</b>
                <span className={`status-badge ${INSTALMENT_CLASS[i.status] || ''}`}>{i.part && i.status !== 'Paid' ? `Part paid · ${i.status}` : i.status}</span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13 }}>
          No plan yet. {canEdit ? 'Set one to see what falls due when — an advance, then instalments.' : 'Someone who records payments can set one.'}
        </p>
      ))}

      {editing && (
        <div className="pp-edit">
          {error && <div className="calc-warning" role="alert">{error}</div>}
          <div className="pp-tools">
            <label className="pp-equal">Split equally into
              <input type="number" min="1" max="24" value={equal} onChange={e => setEqual(e.target.value)} aria-label="Number of equal instalments" />
            </label>
            <button type="button" className="mini-btn" onClick={splitEqually}>Split</button>
            {defaultPlan?.length > 0 && <button type="button" className="mini-btn" onClick={useDefault}>Use {vendorName || 'the vendor'}’s usual plan</button>}
          </div>

          {rows.map((r, idx) => (
            <div key={idx} className="pp-row">
              <span className="pp-num">{idx + 1}</span>
              <input value={r.label} onChange={e => setRow(idx, { label: e.target.value })} placeholder={idx === 0 ? 'e.g. Advance' : `Instalment ${idx + 1}`} aria-label={`Instalment ${idx + 1} name`} />
              <div className="pp-value">
                <select value={r.by} onChange={e => setRow(idx, { by: e.target.value })} aria-label={`Instalment ${idx + 1} as`}>
                  <option value="percent">%</option>
                  <option value="amount">₹</option>
                </select>
                <input type="number" min="0" step="any" value={r.value} onChange={e => setRow(idx, { value: e.target.value })} aria-label={`Instalment ${idx + 1} ${r.by === 'percent' ? 'percent' : 'amount'}`} />
              </div>
              <div className="pp-due">
                <select value={r.due_kind} onChange={e => setRow(idx, { due_kind: e.target.value })} aria-label={`Instalment ${idx + 1} due`}>
                  <option value="date">On a date</option>
                  <option value="delivery">On delivery</option>
                </select>
                {r.due_kind === 'date' && <input type="date" value={r.due_date} onChange={e => setRow(idx, { due_date: e.target.value })} aria-label={`Instalment ${idx + 1} date`} />}
              </div>
              <span className="pp-amt pp-muted">{r.by === 'percent' && r.value ? inr(rowAmount(r, total)) : ''}</span>
              <button type="button" className="btn-icon" aria-label={`Remove instalment ${idx + 1}`} onClick={() => setRows(rs => rs.filter((_, i) => i !== idx))}><Icon name="close" size={14} /></button>
            </div>
          ))}
          <button type="button" className="add-item-btn" onClick={() => setRows(rs => [...rs, blankRow()])}>+ Add instalment</button>

          <div className="pp-sum" style={{ color: Math.abs(off) > 1 ? 'var(--warning)' : undefined }}>
            {rows.length ? (Math.abs(off) > 1
              ? `Instalments add up to ${inr(sum)} — ${off > 0 ? `${inr(off)} short of` : `${inr(-off)} over`} the ${inr(total)} total`
              : `Adds up to the ${inr(total)} total`) : 'Saving with no instalments removes the plan.'}
          </div>
          {rows.length > 0 && (
            <label className="pp-default">
              <input type="checkbox" checked={saveDefault} onChange={e => setSaveDefault(e.target.checked)} />
              <span><b>Make this {vendorName || 'the vendor'}’s usual plan</b><em>Offered on their next order, with dates counted from that order’s date.</em></span>
            </label>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-secondary" onClick={() => setEditing(false)}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={saving} onClick={() => save()}>{saving ? 'Saving…' : 'Save plan'}</button>
          </div>
        </div>
      )}
    </div>
  )
}
