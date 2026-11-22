import { useState } from 'react'
import { useApi } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'

const Toggle = ({ on, onChange, label }) => (
  <button type="button" role="switch" aria-checked={!!on} aria-label={label} className={`toggle ${on ? 'on' : ''}`} onClick={() => onChange(!on)}><span /></button>
)

/** Delhivery settings: the warehouse, box sizes, what happens automatically, and alerts. Owners and admins. */
export default function ShippingSettings({ settings, isAdmin, onSaved }) {
  const apiFetch = useApi()
  const toast = useToast()
  // The parent only renders this once settings have loaded, so they seed the form once.
  const [f, setF] = useState(() => JSON.parse(JSON.stringify(settings)))
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const set = (patch) => setF(x => ({ ...x, ...patch }))
  const setRet = (patch) => setF(x => ({ ...x, return_address: { ...x.return_address, ...patch } }))
  const setBox = (i, patch) => setF(x => ({ ...x, boxes: x.boxes.map((b, j) => (j === i ? { ...b, ...patch } : b)) }))
  const ro = !isAdmin

  const save = async () => {
    setBusy(true)
    const r = await apiFetch('/api/shipping/settings', { method: 'PUT', body: JSON.stringify(f) })
    setBusy(false)
    if (!r || r.error) return toast.error(r?.error || 'Could not save')
    toast.success('Shipping settings saved'); onSaved(r.settings)
  }
  const test = async () => {
    setTesting(true)
    const r = await apiFetch('/api/shipping/settings/test', { method: 'POST' })
    setTesting(false)
    if (!r || r.error) toast.error(r?.error || 'Could not reach Delhivery'); else toast.success('Delhivery answered: the token works')
  }

  return (
    <>
      {ro && <div className="ship-alert info"><span>Only an owner or admin can change these.</span></div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(420px, 100%), 1fr))', gap: 18, alignItems: 'start' }}>
        <section className="ship-card" style={{ margin: 0 }}>
          <h3>Connection</h3>
          <p className="packed-sub" style={{ maxWidth: 'none', margin: 0 }}>The Delhivery token stays on the server (.env). It's never shown here or sent to the browser.</p>
          {isAdmin && <button className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} onClick={test} disabled={testing}>{testing ? 'Testing…' : 'Test connection'}</button>}
        </section>

        <section className="ship-card" style={{ margin: 0 }}>
          <h3>Warehouse</h3>
          <div className="form-row">
            <div className="input-group"><label htmlFor="st-loc">Pickup location</label>
              <input id="st-loc" value={f.pickup_location} disabled={ro} onChange={e => set({ pickup_location: e.target.value })} />
              <span className="packed-sub" style={{ margin: 0 }}>Exactly as registered with Delhivery</span></div>
            <div className="input-group"><label htmlFor="st-pin">Warehouse pincode</label>
              <input id="st-pin" inputMode="numeric" maxLength={6} value={f.origin_pincode} disabled={ro} onChange={e => set({ origin_pincode: e.target.value })} />
              <span className="packed-sub" style={{ margin: 0 }}>Used for charge estimates</span></div>
          </div>
          <p className="ship-section-title">Return address</p>
          <p className="packed-sub" style={{ margin: '-6px 0 0', maxWidth: 'none' }}>Leave blank to use the pickup location.</p>
          <div className="form-row">
            <div className="input-group"><label htmlFor="st-rn">Name</label><input id="st-rn" value={f.return_address.name} disabled={ro} onChange={e => setRet({ name: e.target.value })} /></div>
            <div className="input-group"><label htmlFor="st-rp">Phone</label><input id="st-rp" inputMode="tel" value={f.return_address.phone} disabled={ro} onChange={e => setRet({ phone: e.target.value })} /></div>
          </div>
          <div className="input-group"><label htmlFor="st-ra">Address</label><input id="st-ra" value={f.return_address.address} disabled={ro} onChange={e => setRet({ address: e.target.value })} /></div>
          <div className="form-row">
            <div className="input-group"><label htmlFor="st-rc">City</label><input id="st-rc" value={f.return_address.city} disabled={ro} onChange={e => setRet({ city: e.target.value })} /></div>
            <div className="input-group"><label htmlFor="st-rs">State</label><input id="st-rs" value={f.return_address.state} disabled={ro} onChange={e => setRet({ state: e.target.value })} /></div>
            <div className="input-group"><label htmlFor="st-rz">Pincode</label><input id="st-rz" inputMode="numeric" maxLength={6} value={f.return_address.pincode} disabled={ro} onChange={e => setRet({ pincode: e.target.value })} /></div>
          </div>
        </section>

        <section className="ship-card" style={{ margin: 0, gridColumn: '1 / -1' }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <h3>Box sizes</h3>
            {!ro && <button className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto' }}
              onClick={() => set({ boxes: [...f.boxes, { key: `box${Date.now()}`, name: 'New box', l: 30, b: 25, h: 5, grams: 500 }] })}><Icon name="plus" size={14} /> Add box</button>}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table ship-boxes-table">
              <thead><tr><th>Name</th><th>L cm</th><th>B cm</th><th>H cm</th><th>Weight g</th><th aria-label="Remove" /></tr></thead>
              <tbody>
                {f.boxes.map((b, i) => (
                  <tr key={b.key}>
                    <td><input aria-label="Box name" value={b.name} disabled={ro} onChange={e => setBox(i, { name: e.target.value })} /></td>
                    {['l', 'b', 'h', 'grams'].map(k => (
                      <td key={k}><input aria-label={k} type="number" min="1" value={b[k]} disabled={ro} onChange={e => setBox(i, { [k]: e.target.value })} /></td>
                    ))}
                    <td>{!ro && f.boxes.length > 1 && <button className="mini-btn mini-btn-danger" onClick={() => set({ boxes: f.boxes.filter((_, j) => j !== i) })}>Remove</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="input-group" style={{ marginBottom: 0 }}><label htmlFor="st-mode">Default shipping mode</label>
            <select id="st-mode" value={f.default_mode} disabled={ro} onChange={e => set({ default_mode: e.target.value })}><option>Surface</option><option>Express</option></select></div>
        </section>

        <section className="ship-card" style={{ margin: 0 }}>
          <h3>Automatic steps</h3>
          <div>
            <div className="ship-setting"><span>Mark the order fulfilled in Shopify with the AWB<small>Sends the customer the shipped WhatsApp. Needs fulfilment access for the CRM's Shopify app.</small></span>
              <Toggle label="Shopify fulfil" on={f.shopify_fulfil} onChange={v => !ro && set({ shopify_fulfil: v })} /></div>
            <div className="ship-setting"><span>Update tracking every 30 minutes<small>Also finds shipments made in the Delhivery portal, from the last {f.sync_days} days.</small></span>
              <Toggle label="Tracking sync" on={f.sync_enabled} onChange={v => !ro && set({ sync_enabled: v })} /></div>
            <div className="ship-setting"><span>Book the daily pickup automatically<small>Between 10 AM and 4 PM, when parcels are waiting and none is booked yet.</small></span>
              <Toggle label="Auto pickup" on={f.auto_pickup} onChange={v => !ro && set({ auto_pickup: v })} /></div>
            <div className="ship-setting"><span>Pickup time</span>
              <input type="time" aria-label="Pickup time" style={{ width: 130 }} value={String(f.pickup_time || '18:00').slice(0, 5)} disabled={ro} onChange={e => set({ pickup_time: e.target.value })} /></div>
          </div>
        </section>

        <section className="ship-card" style={{ margin: 0 }}>
          <h3>Alerts</h3>
          <p className="packed-sub" style={{ maxWidth: 'none', margin: 0 }}>Auto-cancels and parcels left waiting always reach the CRM bell of everyone with Shipping access.</p>
          <div>
            <div className="ship-setting"><span>Warn when a parcel has waited for pickup longer than</span>
              <select aria-label="Days waiting" style={{ width: 110 }} value={f.alert_risk_days} disabled={ro} onChange={e => set({ alert_risk_days: Number(e.target.value) })}>
                {[1, 2, 3, 4, 5].map(d => <option key={d} value={d}>{d} day{d > 1 ? 's' : ''}</option>)}
              </select></div>
            <div className="ship-setting"><span>Also send to the ops WhatsApp number<small>From the Normless WhatsApp number. WhatsApp only delivers it if that number has messaged ours in the last 24 hours.</small></span>
              <Toggle label="WhatsApp alerts" on={f.alert_whatsapp} onChange={v => !ro && set({ alert_whatsapp: v })} /></div>
          </div>
          <div className="input-group" style={{ marginBottom: 0 }}><label htmlFor="st-ops">Ops WhatsApp number</label>
            <input id="st-ops" inputMode="tel" placeholder="10-digit mobile" value={f.ops_phone} disabled={ro} onChange={e => set({ ops_phone: e.target.value })} /></div>
        </section>
      </div>
      {!ro && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
          <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button>
        </div>
      )}
    </>
  )
}
