import { useState } from 'react'
import { useApi } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'

const inr = (v) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(v) || 0)
const day = (v) => (v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—')

/**
 * Loading a statement.
 *
 * Two steps on purpose. The first reads the file and reports what it found — the period, the
 * number of transactions, and whether the arithmetic matches what the bank itself printed at the
 * end of the statement. Only then is there a button to keep it. A statement that does not tie out
 * is not quietly imported and averaged into a chart.
 *
 * The password is typed, used for that one read, and never sent anywhere else.
 */
export default function UploadDrawer({ onClose, onLoaded }) {
  const apiFetch = useApi()
  const toast = useToast()
  const [file, setFile] = useState(null)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [found, setFound] = useState(null)   // what the preview read back

  const send = async (preview) => {
    if (!file) { toast.error('Choose the statement PDF'); return }
    const body = new FormData()
    body.append('file', file)
    body.append('password', password)
    if (preview) body.append('preview', 'true')

    setBusy(true)
    const res = await apiFetch('/api/banking/statements', { method: 'POST', body })
    setBusy(false)

    if (!res || res.error) { toast.error(res?.error || 'Could not read that statement'); return }
    if (preview) { setFound(res); return }
    toast.success(`${res.statement.txn_count} transactions loaded${res.statement.skipped ? ` · ${res.statement.skipped} already held` : ''}`)
    onLoaded(res.statement)
  }

  const s = found?.statement
  const c = found?.check

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div className="drawer" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="drawer-header">
          <h2>Load a statement</h2>
          <button type="button" className="btn-icon" onClick={onClose}><Icon name="close" size={16} /></button>
        </div>

        <div className="drawer-body">
          <div className="support-form">
            <div className="input-group">
              <label>The statement, as the bank sent it <span className="label-hint">PDF</span></label>
              <input type="file" accept="application/pdf"
                onChange={e => { setFile(e.target.files?.[0] || null); setFound(null) }} />
            </div>
            <div className="input-group">
              <label>Password <span className="label-hint">used to open the file, never stored</span></label>
              <input type="password" value={password} autoComplete="off" placeholder="The one the bank mails with it"
                onChange={e => { setPassword(e.target.value); setFound(null) }}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); send(true) } }} />
            </div>

            {found && (
              <>
                <div className="form-section">What is in it</div>
                <div className={`bank-check ${c.ok ? 'bank-check-ok' : 'bank-check-bad'}`}>
                  <b>{c.ok ? 'Every rupee accounted for' : 'This statement does not add up'}</b>
                  <div>
                    {c.ok
                      ? `${s.txn_count} transactions, and the running balance holds from the first line to the last.`
                      : s.reconcile_note}
                  </div>
                  {/* Two different strengths of evidence, so the page says which one it has: the
                      bank's own printed tally is an independent check, the running balance is not. */}
                  {c.against ? (
                    <div className="bank-check-break">
                      Checked against the bank's own summary: {found.summary.dr_count} debits totalling {inr(found.summary.debits)},
                      {' '}{found.summary.cr_count} credits totalling {inr(found.summary.credits)}, closing {inr(found.summary.closing_balance)}
                      {c.ok ? ' — all matched exactly.' : ' — these do not match.'}
                    </div>
                  ) : (
                    <div className="bank-check-break">
                      This statement prints no summary to check against, so only the running balance was verified.
                    </div>
                  )}
                  {!c.ok && c.breaks?.slice(0, 3).map(b => (
                    <div key={b.row_no} className="bank-check-break">
                      Row {b.row_no} · {b.date} · printed {inr(b.printed)}, expected {inr(b.expected)} ({inr(b.diff)} out)
                    </div>
                  ))}
                </div>

                <div className="bank-facts">
                  <div><span>Account</span><b>{s.bank || 'Bank'} ···{s.account_last4 || '—'}</b></div>
                  <div><span>Period</span><b>{day(s.period_from)} – {day(s.period_to)}</b></div>
                  <div><span>Opening</span><b>{inr(s.opening_balance)}</b></div>
                  <div><span>Closing</span><b>{inr(s.closing_balance)}</b></div>
                  <div><span>Money in</span><b className="bank-in">{inr(c.credits)} <small>({c.cr_count})</small></b></div>
                  <div><span>Money out</span><b className="bank-out">{inr(c.debits)} <small>({c.dr_count})</small></b></div>
                </div>

                {found.duplicate && (
                  <p className="bank-note">This exact file is already loaded — loading it again adds nothing.</p>
                )}
                <div className="form-section">The first few lines</div>
                <div className="bank-sample">
                  {found.sample.map((t, i) => (
                    <div key={i}>
                      <span>{t.txn_date}</span>
                      <span className="bank-sample-what">{t.counterparty || t.narration.slice(0, 40)}</span>
                      <span className={t.credit ? 'bank-in' : 'bank-out'}>{inr(t.credit || t.debit)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="drawer-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          {!found ? (
            <button type="button" className="btn btn-primary" disabled={busy || !file} onClick={() => send(true)}>
              {busy ? 'Reading…' : 'Read it'}
            </button>
          ) : (
            <button type="button" className="btn btn-primary" disabled={busy || found.duplicate} onClick={() => send(false)}>
              {busy ? 'Loading…' : found.duplicate ? 'Already loaded' : `Keep these ${s.txn_count} transactions`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
