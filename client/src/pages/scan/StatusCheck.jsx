import { useState, useRef, useEffect } from 'react'
import { useApi } from '../../App'
import { useToast } from '../../components/Toast'

/**
 * Check many parcels' Delhivery status at the packing bench: scan each label (AWB or order
 * barcode) one after another, or paste a list. Each code is checked live with Delhivery, so a
 * label cancelled since the last sync is caught before the parcel goes out.
 */

const VERDICTS = {
  cancelled: { tone: 'bad', badge: 'cancelled', short: 'Cancelled', text: 'Cancelled by Delhivery. Don\'t send it: re-create it in Shipping → Auto-cancelled and swap the label.' },
  replaced: { tone: 'bad', badge: 'cancelled', short: 'Old label', text: 'This label was cancelled and re-made. Swap it for the new label.' },
  order_cancelled: { tone: 'bad', badge: 'cancelled', short: 'Order cancelled', text: 'The order is cancelled in Shopify. Don\'t send it.' },
  on_hold: { tone: 'warn', badge: 'on-hold', short: 'On hold', text: 'The order is on hold in Shopify. Don\'t send it until it is released.' },
  no_awb: { tone: 'warn', badge: 'pending', short: 'No AWB', text: 'No Delhivery AWB for this order yet: get one in Shipping.' },
  unknown_awb: { tone: 'warn', badge: 'error', short: 'Not found', text: 'Delhivery and the CRM don\'t know this AWB. Check the label.' },
  unknown_order: { tone: 'warn', badge: 'error', short: 'Not found', text: 'No such order in the CRM. Check the number.' },
  moving: { tone: 'info', badge: 'partial', short: 'Already moving', text: '' },
  ok: { tone: 'ok', badge: 'fulfilled', short: 'OK to send', text: 'Waiting for pickup.' },
}
const PROBLEM = (v) => ['bad', 'warn'].includes(VERDICTS[v]?.tone)
const split = (text) => String(text || '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean)
const keyOf = (it) => it.awb || it.order || it.code

// A short tone, so a bad label is noticed without looking at the screen.
function beep(bad) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return
    const ctx = beep.ctx || (beep.ctx = new Ctx())
    const o = ctx.createOscillator(); const g = ctx.createGain()
    o.type = bad ? 'square' : 'sine'
    o.frequency.value = bad ? 220 : 880
    g.gain.value = 0.08
    o.connect(g); g.connect(ctx.destination)
    o.start(); o.stop(ctx.currentTime + (bad ? 0.45 : 0.08))
  } catch { /* no sound available */ }
}

export default function StatusCheck() {
  const apiFetch = useApi()
  const toast = useToast()
  const [rows, setRows] = useState([])          // newest first
  const [scan, setScan] = useState('')
  const [paste, setPaste] = useState('')
  const [pasting, setPasting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [onlyProblems, setOnlyProblems] = useState(false)
  const [sound, setSound] = useState(true)
  const [note, setNote] = useState('')
  const inputRef = useRef(null)

  useEffect(() => { if (!pasting) inputRef.current?.focus() }, [pasting, busy])

  const check = async (codes, { replace = false } = {}) => {
    const list = [...new Set(codes)]
    if (!list.length) return
    setBusy(true)
    const r = await apiFetch('/api/shipping/bulk-check', { method: 'POST', body: JSON.stringify({ codes: list, live: true }) })
    setBusy(false)
    if (!r || r.error) return toast.error(r?.error || 'Could not check the parcels')
    setNote(r.live_error || '')
    const got = r.items.map(it => ({ ...it, at: r.checked_at }))
    if (sound && got.length) beep(got.some(it => PROBLEM(it.verdict)))
    setRows(prev => {
      if (replace) return got
      const fresh = new Set(got.map(keyOf))
      return [...got.reverse(), ...prev.filter(p => !fresh.has(keyOf(p)))]
    })
  }

  const onScan = (e) => {
    e.preventDefault()
    const codes = split(scan)
    setScan('')
    check(codes)
  }
  const onPaste = () => {
    const codes = split(paste)
    if (!codes.length) return
    if (codes.length > 300) toast.info('Checking the first 300')
    check(codes.slice(0, 300))
    setPaste(''); setPasting(false)
  }
  const recheck = () => check(rows.map(r => r.code).reverse(), { replace: true })

  const counts = rows.reduce((c, r) => { c[VERDICTS[r.verdict]?.tone || 'info'] = (c[VERDICTS[r.verdict]?.tone || 'info'] || 0) + 1; return c }, {})
  const shown = onlyProblems ? rows.filter(r => PROBLEM(r.verdict)) : rows

  const download = () => {
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const lines = [['Scanned', 'Order', 'AWB', 'Result', 'Delhivery status', 'New AWB', 'What to do'].map(cell).join(',')]
    for (const r of rows) {
      const v = VERDICTS[r.verdict] || {}
      lines.push([r.code, r.order_number, r.shipment?.awb || r.awb, v.short, r.shipment?.label, r.replacement?.awb, v.text].map(cell).join(','))
    }
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }))
    a.download = `parcel-status-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`
    document.body.appendChild(a); a.click(); a.remove()
  }

  return (
    <div className="stc">
      <div className="stc-head">
        {pasting ? (
          <div className="stc-paste">
            <textarea className="input" rows={6} autoFocus value={paste} onChange={e => setPaste(e.target.value)}
              placeholder={'Paste AWBs or order numbers, one per line (or separated by commas)\n44544810116502\n#13584'} />
            <div className="stc-actions">
              <button type="button" className="btn btn-primary" onClick={onPaste} disabled={busy || !split(paste).length}>
                Check {split(paste).length || ''} {split(paste).length === 1 ? 'parcel' : 'parcels'}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setPasting(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <form className="manual-lookup-form" onSubmit={onScan}>
            <input ref={inputRef} className="input" value={scan} onChange={e => setScan(e.target.value)} autoComplete="off"
              placeholder="Scan each label (AWB or order barcode), or type one and press Enter" aria-label="AWB or order number" />
            <button type="submit" className="btn btn-primary" disabled={busy || !scan.trim()}>{busy ? 'Checking…' : 'Check'}</button>
            <button type="button" className="btn btn-secondary" onClick={() => setPasting(true)}>Paste a list</button>
          </form>
        )}
        <p className="stc-hint">Each label is checked live with Delhivery. A cancelled label, an old label that has been re-made, or an order that is cancelled or on hold turns red{sound ? ' and plays a low tone' : ''}.</p>
      </div>

      {note && <div className="scan-error-msg">{note}</div>}

      {rows.length > 0 && (
        <div className="stc-bar">
          <div className="stc-counts">
            <span className="stc-chip bad">{counts.bad || 0} don't send</span>
            <span className="stc-chip warn">{counts.warn || 0} check</span>
            <span className="stc-chip ok">{counts.ok || 0} OK</span>
            {counts.info > 0 && <span className="stc-chip">{counts.info} already moving</span>}
            <span className="stc-total">{rows.length} checked</span>
          </div>
          <div className="stc-actions">
            <label className="stc-toggle"><input type="checkbox" checked={onlyProblems} onChange={e => setOnlyProblems(e.target.checked)} /> Problems only</label>
            <label className="stc-toggle"><input type="checkbox" checked={sound} onChange={e => setSound(e.target.checked)} /> Sound</label>
            <button type="button" className="btn btn-secondary btn-sm" onClick={recheck} disabled={busy}>Check all again</button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={download}>Download CSV</button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setRows([]); setNote('') }}>Clear</button>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">🔎</div>
          <h3>Check parcels before they go</h3>
          <p>Scan the labels on the parcels one after another. Each one appears here with its Delhivery status.</p>
        </div>
      ) : (
        <div className="data-table-wrapper">
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table stc-table">
              <thead><tr><th>Scanned</th><th>Order</th><th>AWB</th><th>Result</th><th>What to do</th></tr></thead>
              <tbody>
                {shown.map(r => {
                  const v = VERDICTS[r.verdict] || VERDICTS.moving
                  const s = r.shipment
                  return (
                    <tr key={keyOf(r)} className={`stc-row ${v.tone}`}>
                      <td data-label="Scanned" className="ship-mono">{r.code}</td>
                      <td data-label="Order" className="cell-primary">{r.order_number || '—'}</td>
                      <td data-label="AWB" className="ship-mono">{s?.awb || r.awb || '—'}</td>
                      <td data-label="Result">
                        <span className={`status-badge ${v.badge}`}>{v.short}</span>
                        {s && <div className="packed-sub">{s.label}{s.detail && s.detail !== s.label ? ` · ${s.detail}` : ''}</div>}
                      </td>
                      <td data-label="What to do">
                        {r.verdict === 'replaced'
                          ? <>Swap it for the new label: AWB <b className="ship-mono">{r.replacement?.awb}</b>{r.replacement?.label ? ` (${r.replacement.label})` : ''}.</>
                          : r.verdict === 'moving' ? `Delhivery already has it: ${s?.label || 'on its way'}.` : v.text}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
