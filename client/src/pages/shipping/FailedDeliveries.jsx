import { useState, useEffect } from 'react'
import { useApi } from '../../App'
import { useToast } from '../../components/Toast'
import { dayTime, money, plural } from './common'

/**
 * Failed deliveries (NDR). Delhivery's API allows one action on a forward parcel: RE-ATTEMPT,
 * for certain reasons, on attempt 1 or 2. Changing the phone or address goes through the edit
 * API; "return to us" is a cancellation, which after pickup becomes an RTO.
 */
export default function FailedDeliveries({ canManage, changed, open, rev }) {
  const apiFetch = useApi()
  const toast = useToast()
  const [rows, setRows] = useState(null)
  const [view, setView] = useState('need')
  const [busy, setBusy] = useState(null)

  useEffect(() => {
    apiFetch('/api/shipping/shipments?bucket=ndr&size=100').then(r => setRows(r && !r.error ? r.shipments : []))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev])

  if (!rows) return <div className="loader"><div className="spinner" /></div>
  const needs = (s) => !s.ndr_action_at || (s.status_at && new Date(s.ndr_action_at) < new Date(s.status_at))
  const list = rows.filter(s => (view === 'need' ? needs(s) : !needs(s)))

  const reattempt = async (s) => {
    setBusy(s.id)
    const r = await apiFetch('/api/shipping/reattempt', { method: 'POST', body: JSON.stringify({ ids: [s.id] }) })
    setBusy(null)
    if (!r || r.error) return toast.error(r?.error || 'Delhivery refused')
    toast.success('Re-attempt requested'); changed()
  }
  const sendBack = async (s) => {
    if (!await toast.confirm({ title: `Return ${s.order_number} to us?`, danger: true, message: `Delhivery turns AWB ${s.awb} into a return (RTO). This can't be undone.` })) return
    setBusy(s.id)
    const r = await apiFetch(`/api/shipping/shipments/${s.id}/cancel`, { method: 'POST' })
    setBusy(null)
    if (!r || r.error) return toast.error(r?.error || 'Delhivery refused')
    toast.success('Return requested'); changed()
  }

  return (
    <>
      <p style={{ color: 'var(--text-secondary)', marginTop: 0, maxWidth: 820, fontSize: 14 }}>
        Delhivery couldn't deliver these. Pick an action and it goes straight to Delhivery. Delhivery advises asking for re-attempts after 9 PM,
        when the day's deliveries are closed. Re-attempt only works for some reasons, and only on attempt 1 or 2.
      </p>
      <div className="scan-tabs" style={{ marginBottom: 14 }}>
        <button className={view === 'need' ? 'active' : ''} onClick={() => setView('need')}>Need action <span className="tab-badge">{rows.filter(needs).length}</span></button>
        <button className={view === 'done' ? 'active' : ''} onClick={() => setView('done')}>Action taken <span className="tab-badge">{rows.filter(s => !needs(s)).length}</span></button>
      </div>

      {!list.length ? (
        <div className="data-table-wrapper"><div className="empty-state"><div className="empty-icon">🚚</div><h3>{view === 'need' ? 'Nothing needs action' : 'No actions taken yet'}</h3></div></div>
      ) : list.map(s => (
        <article key={s.id} className="ship-ndr">
          <div>
            <button className="mini-btn" style={{ alignSelf: 'flex-start', fontSize: 13 }} onClick={() => open(s.id)}>{s.order_number || s.awb}</button>
            <span>{s.consignee_name || '—'}</span>
            <span className="packed-sub" style={{ margin: 0 }}>{[s.consignee_city || s.destination, s.payment_mode === 'COD' ? `COD ${money(s.cod_amount)}` : s.payment_mode].filter(Boolean).join(' · ')}</span>
          </div>
          <div>
            <span className="ship-section-title">Delhivery says</span>
            <strong style={{ color: 'var(--warning)' }}>{s.ndr_reason || s.instructions || s.status}</strong>
            <span className="packed-sub" style={{ margin: 0 }}>{plural(s.ndr_attempts || 1, 'attempt')} · {dayTime(s.status_at)} · {s.status_code}</span>
          </div>
          <div>
            <span className="ship-section-title">Our action</span>
            <span>{s.ndr_action ? `${s.ndr_action === 'RE-ATTEMPT' ? 'Re-attempt asked' : 'Details changed'} · ${dayTime(s.ndr_action_at)}` : 'None yet'}</span>
          </div>
          {canManage && (
            <div className="ship-ndr-actions">
              <button className="btn btn-primary btn-sm" disabled={busy === s.id} onClick={() => reattempt(s)}>Re-attempt</button>
              <button className="btn btn-secondary btn-sm" onClick={() => open(s.id)}>Change phone or address</button>
              <button className="btn btn-secondary btn-sm" disabled={busy === s.id} onClick={() => sendBack(s)}>Return to us</button>
            </div>
          )}
        </article>
      ))}
    </>
  )
}
