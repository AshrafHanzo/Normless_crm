import { useState, useEffect } from 'react'
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
  const setRule = (i, patch) => setF(x => ({ ...x, pack_rules: x.pack_rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) }))
  const ro = !isAdmin
  const [cat, setCat] = useState(null)     // { products, types } from Shopify, for the rule picker
  const [catError, setCatError] = useState('')

  useEffect(() => {
    if (!isAdmin) return
    apiFetch('/api/shipping/catalog').then(r => { if (r && !r.error) setCat(r); else setCatError(r?.error || 'Could not load products from Shopify') })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin])

  const boxName = (k) => f.boxes.find(b => b.key === k)?.name
  const ruleLabel = (r) => r.label || (r.match === 'type' ? r.value : cat?.products.find(p => p.id === r.value)?.title) || r.value
  // Whole-order rules: [{ label, when: [{ match, value, label, min_qty }], items_min, items_max, box, weight_g }]
  const combos = f.combo_rules || []
  const setCombos = (list) => set({ combo_rules: list })
  const setCombo = (i, patch) => setCombos(combos.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const setCond = (i, k, patch) => setCombo(i, { when: combos[i].when.map((w, j) => (j === k ? { ...w, ...patch } : w)) })
  const moveCombo = (i, d) => { const l = [...combos]; const [x] = l.splice(i, 1); l.splice(i + d, 0, x); setCombos(l) }
  const targetOf = (v) => {
    const [match, ...rest] = v.split(':'); const value = rest.join(':')
    return { match, value, label: match === 'type' ? value : (cat?.products.find(p => p.id === value)?.title || '') }
  }
  const TargetSelect = ({ value, onChange, label }) => (
    <select aria-label={label} value={value} onChange={e => onChange(targetOf(e.target.value))}>
      <option value="">Choose a product or type…</option>
      <optgroup label="Product types">{(cat?.types || []).map(t => <option key={t} value={`type:${t}`}>{t} (any)</option>)}</optgroup>
      <optgroup label="Products">{(cat?.products || []).map(p => <option key={p.id} value={`product:${p.id}`}>{p.title}{p.status !== 'ACTIVE' ? ` (${p.status.toLowerCase()})` : ''}</option>)}</optgroup>
    </select>
  )
  const pickTarget = (i, v) => {
    const [match, ...rest] = v.split(':'); const value = rest.join(':')
    const label = match === 'type' ? value : (cat?.products.find(p => p.id === value)?.title || '')
    setRule(i, { match, value, label })
  }

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
            <div className="input-group"><span className="ship-field-label">Pickup location</span>
              <div className="ship-readonly">{settings.pickup_location || '—'}</div>
              <span className="packed-sub" style={{ margin: 0 }}>{settings.pickup_location_from === 'delhivery' ? 'From your Delhivery account, as on your shipments' : 'Shown here once Delhivery tracking has run'}</span></div>
            <div className="input-group"><label htmlFor="st-pin">Warehouse pincode <span className="label-hint">optional</span></label>
              <input id="st-pin" inputMode="numeric" maxLength={6} value={f.origin_pincode} disabled={ro} onChange={e => set({ origin_pincode: e.target.value })} />
              <span className="packed-sub" style={{ margin: 0 }}>Only to show the charge before shipping</span></div>
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
          <div className="ship-card-head">
            <div><h3>Packaging</h3>
              <p className="packed-sub" style={{ maxWidth: 'none', margin: '2px 0 0' }}>The polybags and boxes you pack in. Delhivery charges on size and weight, so keep these close to the real thing.</p></div>
            {!ro && <button className="btn btn-secondary btn-sm"
              onClick={() => set({ boxes: [...f.boxes, { key: `pack${Date.now()}`, name: 'New packaging', kind: 'box', l: 30, b: 25, h: 10, pack_g: 150, max_items: 4 }] })}><Icon name="plus" size={14} /> Add packaging</button>}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table ship-boxes-table">
              <thead><tr><th>Name</th><th>Type</th><th>L cm</th><th>B cm</th><th>H cm</th><th>Empty weight g</th><th>Fits pieces</th><th aria-label="Remove" /></tr></thead>
              <tbody>
                {f.boxes.map((b, i) => (
                  <tr key={b.key}>
                    <td><input aria-label="Packaging name" value={b.name} disabled={ro} onChange={e => setBox(i, { name: e.target.value })} /></td>
                    <td><select aria-label="Type" value={b.kind || 'box'} disabled={ro} onChange={e => setBox(i, { kind: e.target.value })}>
                      <option value="polybag">Polybag</option><option value="box">Box</option></select></td>
                    {[['l', 'Length'], ['b', 'Breadth'], ['h', 'Height'], ['pack_g', 'Empty weight in grams'], ['max_items', 'Pieces it fits']].map(([k, label]) => (
                      <td key={k}><input aria-label={label} type="number" min={k === 'pack_g' ? 0 : 1} value={b[k] ?? ''} disabled={ro} onChange={e => setBox(i, { [k]: e.target.value })} /></td>
                    ))}
                    <td>{!ro && f.boxes.length > 1 && <button className="mini-btn mini-btn-danger" onClick={() => set({ boxes: f.boxes.filter((_, j) => j !== i) })}>Remove</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="form-row" style={{ alignItems: 'flex-start' }}>
            <div className="input-group" style={{ marginBottom: 0 }}><label htmlFor="st-defbox">Default packaging</label>
              <select id="st-defbox" value={f.default_box} disabled={ro} onChange={e => set({ default_box: e.target.value })}>
                {f.boxes.map(b => <option key={b.key} value={b.key}>{b.name}</option>)}</select>
              <span className="packed-sub" style={{ margin: 0 }}>For products no rule below mentions</span></div>
            <div className="input-group" style={{ marginBottom: 0 }}><label htmlFor="st-itemg">Weight per piece, grams</label>
              <input id="st-itemg" type="number" min="10" value={f.default_item_g} disabled={ro} onChange={e => set({ default_item_g: e.target.value })} />
              <span className="packed-sub" style={{ margin: 0 }}>When neither a rule nor Shopify has a weight</span></div>
            <div className="input-group" style={{ marginBottom: 0 }}><label htmlFor="st-mode">Default shipping mode</label>
              <select id="st-mode" value={f.default_mode} disabled={ro} onChange={e => set({ default_mode: e.target.value })}><option>Surface</option><option>Express</option></select></div>
          </div>
        </section>

        <section className="ship-card" style={{ margin: 0, gridColumn: '1 / -1' }}>
          <div className="ship-card-head">
            <div><h3>Order combinations</h3>
              <p className="packed-sub" style={{ maxWidth: 'none', margin: '2px 0 0' }}>
                Packaging for a whole order, checked first and top to bottom; the first that fits decides. For example "Hoodie + Mask → Medium box", or "3 or more pieces → Large box".
                Orders no combination fits use the per-product rules below.</p></div>
            {!ro && <button className="btn btn-secondary btn-sm" onClick={() => setCombos([...combos, { label: '', when: [], items_min: '', items_max: '', box: f.default_box, weight_g: '' }])}><Icon name="plus" size={14} /> Add combination</button>}
          </div>
          {!combos.length ? <p className="packed-sub" style={{ maxWidth: 'none', margin: 0 }}>No combinations yet.</p> : (
            <div className="ship-combos">
              {combos.map((r, i) => (
                <div className="ship-combo" key={i}>
                  <div className="ship-combo-head">
                    <span className="ship-combo-no">{i + 1}</span>
                    <input aria-label="Rule name" placeholder="Name, e.g. Hoodie + mask" value={r.label} disabled={ro} onChange={e => setCombo(i, { label: e.target.value })} />
                    {!ro && <div className="ship-combo-tools">
                      <button type="button" className="btn-icon" aria-label="Move up" disabled={i === 0} onClick={() => moveCombo(i, -1)}>↑</button>
                      <button type="button" className="btn-icon" aria-label="Move down" disabled={i === combos.length - 1} onClick={() => moveCombo(i, 1)}>↓</button>
                      <button type="button" className="mini-btn mini-btn-danger" onClick={() => setCombos(combos.filter((_, j) => j !== i))}>Remove</button>
                    </div>}
                  </div>
                  <div className="ship-combo-body">
                    <div>
                      <span className="ship-field-label">The order has</span>
                      {(r.when || []).map((w, k) => (
                        <div className="ship-cond" key={k}>
                          {ro || !cat ? <span>{w.label || w.value}{w.match === 'type' ? ' (any)' : ''}</span>
                            : TargetSelect({ label: 'Product or type', value: w.value ? `${w.match}:${w.value}` : '', onChange: (t) => setCond(i, k, t) })}
                          <input aria-label="At least how many" type="number" min="1" title="at least" value={w.min_qty || 1} disabled={ro} onChange={e => setCond(i, k, { min_qty: e.target.value })} />
                          {!ro && <button type="button" className="btn-icon" aria-label="Remove item" onClick={() => setCombo(i, { when: r.when.filter((_, j) => j !== k) })}><Icon name="close" size={14} /></button>}
                        </div>
                      ))}
                      {!ro && <button type="button" className="mini-btn" disabled={!cat} onClick={() => setCombo(i, { when: [...(r.when || []), { match: 'type', value: '', label: '', min_qty: 1 }] })}>+ product or type</button>}
                    </div>
                    <div className="form-row">
                      <div className="input-group" style={{ marginBottom: 0 }}><label htmlFor={`cb-min-${i}`}>Pieces from</label><input id={`cb-min-${i}`} type="number" min="1" placeholder="any" value={r.items_min ?? ''} disabled={ro} onChange={e => setCombo(i, { items_min: e.target.value })} /></div>
                      <div className="input-group" style={{ marginBottom: 0 }}><label htmlFor={`cb-max-${i}`}>to</label><input id={`cb-max-${i}`} type="number" min="1" placeholder="any" value={r.items_max ?? ''} disabled={ro} onChange={e => setCombo(i, { items_max: e.target.value })} /></div>
                      <div className="input-group" style={{ marginBottom: 0 }}><label htmlFor={`cb-box-${i}`}>Packaging</label>
                        <select id={`cb-box-${i}`} value={r.box} disabled={ro} onChange={e => setCombo(i, { box: e.target.value })}>{f.boxes.map(b => <option key={b.key} value={b.key}>{b.name}</option>)}</select></div>
                      <div className="input-group" style={{ marginBottom: 0 }}><label htmlFor={`cb-w-${i}`}>Weight g</label><input id={`cb-w-${i}`} type="number" min="50" placeholder="worked out" value={r.weight_g ?? ''} disabled={ro} onChange={e => setCombo(i, { weight_g: e.target.value })} /></div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="ship-card" style={{ margin: 0, gridColumn: '1 / -1' }}>
          <div className="ship-card-head">
            <div><h3>Per-product rules</h3>
              <p className="packed-sub" style={{ maxWidth: 'none', margin: '2px 0 0' }}>
                Which products need which packaging. Each order goes in the biggest packaging any of its items needs, so a hoodie with a mask goes in the mask's box.
                If there are more pieces than it fits, the next size up. A rule for a product beats a rule for its type. You can still change it per order.</p></div>
            {!ro && <button className="btn btn-secondary btn-sm" onClick={() => set({ pack_rules: [...f.pack_rules, { match: 'type', value: '', label: '', box: '', item_g: '' }] })}><Icon name="plus" size={14} /> Add rule</button>}
          </div>
          {catError && <div className="ship-alert warning" style={{ margin: 0 }}><span>Your products couldn't be loaded from Shopify, so rules can't be added or changed right now. ({catError})</span></div>}
          {!f.pack_rules.length ? <p className="packed-sub" style={{ maxWidth: 'none', margin: 0 }}>No rules yet: every order goes in the {(boxName(f.default_box) || 'default packaging').toLowerCase()}.</p> : (
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table ship-boxes-table ship-rules-table">
                <thead><tr><th>Applies to</th><th>Packaging</th><th>Weight per piece g</th><th aria-label="Remove" /></tr></thead>
                <tbody>
                  {f.pack_rules.map((r, i) => (
                    <tr key={i}>
                      <td>{ro || !cat ? <span>{ruleLabel(r) || '—'}{r.match === 'type' && <span className="packed-sub"> · product type</span>}</span> : (
                        <select aria-label="Product or product type" value={r.value ? `${r.match}:${r.value}` : ''} onChange={e => pickTarget(i, e.target.value)}>
                          <option value="">Choose a product or type…</option>
                          <optgroup label="Product types">{cat.types.map(t => <option key={t} value={`type:${t}`}>{t} (every product of this type)</option>)}</optgroup>
                          <optgroup label="Products">{cat.products.map(p => <option key={p.id} value={`product:${p.id}`}>{p.title}{p.status !== 'ACTIVE' ? ` (${p.status.toLowerCase()})` : ''}</option>)}</optgroup>
                        </select>
                      )}</td>
                      <td><select aria-label="Packaging" value={r.box || ''} disabled={ro} onChange={e => setRule(i, { box: e.target.value })}>
                        <option value="">Default packaging</option>
                        {f.boxes.map(b => <option key={b.key} value={b.key}>{b.name}</option>)}</select></td>
                      <td><input aria-label="Weight per piece in grams" type="number" min="10" placeholder="From Shopify" value={r.item_g ?? ''} disabled={ro} onChange={e => setRule(i, { item_g: e.target.value })} /></td>
                      <td>{!ro && <button className="mini-btn mini-btn-danger" onClick={() => set({ pack_rules: f.pack_rules.filter((_, j) => j !== i) })}>Remove</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="ship-card" style={{ margin: 0 }}>
          <h3>Automatic steps</h3>
          <div>
            <div className="ship-setting"><span>Mark the order fulfilled in Shopify with the AWB<small>Sends the customer the shipped WhatsApp. Only for shipments created in the CRM.</small></span>
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
