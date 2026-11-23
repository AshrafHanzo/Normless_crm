import { useState, useEffect } from 'react'
import { useApi } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'

const Toggle = ({ on, onChange, label, disabled }) => (
  <button type="button" role="switch" aria-checked={!!on} aria-label={label} disabled={disabled} className={`toggle ${on ? 'on' : ''}`} onClick={() => onChange(!on)}><span /></button>
)

/** One setting: what it is and why on the left, the control on the right. */
const Row = ({ label, hint, htmlFor, children, wide }) => (
  <div className={`stg-row ${wide ? 'wide' : ''}`}>
    <div className="stg-row-l">
      {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span className="stg-row-t">{label}</span>}
      {hint && <p>{hint}</p>}
    </div>
    <div className="stg-row-c">{children}</div>
  </div>
)

const SECTIONS = [
  { key: 'warehouse', label: 'Warehouse', icon: 'box', blurb: 'Where parcels are picked up from, and where returns come back to.' },
  { key: 'packaging', label: 'Packaging', icon: 'shirt', blurb: 'The polybags and boxes you pack in. Delhivery charges on size and weight, so keep these close to the real thing.' },
  { key: 'rules', label: 'Packing rules', icon: 'note', blurb: 'Which packaging each order gets. Whole-order combinations are checked first, then the per-product rules.' },
  { key: 'automation', label: 'Automation', icon: 'refresh', blurb: 'What the CRM does on its own.' },
  { key: 'alerts', label: 'Alerts', icon: 'bell', blurb: 'Who hears about auto-cancels and parcels left waiting.' },
]

/** Delhivery settings: the warehouse, packaging and packing rules, automation and alerts. Owners and admins. */
export default function ShippingSettings({ settings, isAdmin, onSaved }) {
  const apiFetch = useApi()
  const toast = useToast()
  // The parent only renders this once settings have loaded, so they seed the form once.
  const [f, setF] = useState(() => JSON.parse(JSON.stringify(settings)))
  const [base, setBase] = useState(() => JSON.stringify(settings))
  const [section, setSection] = useState('warehouse')
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [tested, setTested] = useState(null)
  const set = (patch) => setF(x => ({ ...x, ...patch }))
  const setRet = (patch) => setF(x => ({ ...x, return_address: { ...x.return_address, ...patch } }))
  const setBox = (i, patch) => setF(x => ({ ...x, boxes: x.boxes.map((b, j) => (j === i ? { ...b, ...patch } : b)) }))
  const setRule = (i, patch) => setF(x => ({ ...x, pack_rules: x.pack_rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) }))
  const ro = !isAdmin
  const dirty = JSON.stringify(f) !== base
  const [cat, setCat] = useState(null)     // { products, types } from Shopify, for the rule pickers
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
  // Called as a function, not a component, so a re-render doesn't remount the open dropdown.
  const targetSelect = ({ value, onChange, label, anyText = '(any)' }) => (
    <select aria-label={label} value={value} onChange={e => onChange(targetOf(e.target.value))}>
      <option value="">Choose a product or type…</option>
      <optgroup label="Product types">{(cat?.types || []).map(t => <option key={t} value={`type:${t}`}>{t} {anyText}</option>)}</optgroup>
      <optgroup label="Products">{(cat?.products || []).map(p => <option key={p.id} value={`product:${p.id}`}>{p.title}{p.status !== 'ACTIVE' ? ` (${p.status.toLowerCase()})` : ''}</option>)}</optgroup>
    </select>
  )

  const save = async () => {
    setBusy(true)
    const r = await apiFetch('/api/shipping/settings', { method: 'PUT', body: JSON.stringify(f) })
    setBusy(false)
    if (!r || r.error) return toast.error(r?.error || 'Could not save')
    toast.success('Shipping settings saved')
    setF(JSON.parse(JSON.stringify(r.settings))); setBase(JSON.stringify(r.settings)); onSaved(r.settings)
  }
  const discard = () => setF(JSON.parse(base))
  const test = async () => {
    setTesting(true)
    const r = await apiFetch('/api/shipping/settings/test', { method: 'POST' })
    setTesting(false)
    setTested(r && !r.error ? 'ok' : (r?.error || 'Could not reach Delhivery'))
  }
  const current = SECTIONS.find(s => s.key === section)

  return (
    <div className="stg">
      <nav className="stg-nav" aria-label="Settings sections">
        {SECTIONS.map(s => (
          <button key={s.key} type="button" className={section === s.key ? 'active' : ''} aria-current={section === s.key ? 'page' : undefined} onClick={() => setSection(s.key)}>
            <Icon name={s.icon} size={16} /> {s.label}
          </button>
        ))}
      </nav>

      <div className="stg-main">
        <header className="stg-head">
          <h2>{current.label}</h2>
          <p>{current.blurb}</p>
          {ro && <p className="stg-ro"><Icon name="lock" size={13} /> Only an owner or admin can change these.</p>}
        </header>

        {section === 'warehouse' && (
          <div className="stg-card">
            <Row label="Delhivery connection" hint="The API token stays on the server; it is never shown here or sent to the browser.">
              <div className="stg-inline">
                {isAdmin && <button className="btn btn-secondary btn-sm" onClick={test} disabled={testing}>{testing ? 'Testing…' : 'Test connection'}</button>}
                {tested === 'ok' && <span className="stg-ok"><Icon name="check" size={14} /> Connected</span>}
                {tested && tested !== 'ok' && <span className="stg-bad">{tested}</span>}
              </div>
            </Row>
            <Row label="Pickup location" hint={settings.pickup_location_from === 'delhivery' ? 'Read from your Delhivery account, as it appears on your shipments.' : 'Shown once Delhivery tracking has run.'}>
              <div className="stg-value">{settings.pickup_location || '—'}</div>
            </Row>
            <Row label="Warehouse pincode" htmlFor="st-pin" hint="Used to work out each shipment's freight and the charge before shipping.">
              <input id="st-pin" className="stg-short" inputMode="numeric" maxLength={6} placeholder="e.g. 600125" value={f.origin_pincode} disabled={ro} onChange={e => set({ origin_pincode: e.target.value.replace(/\D/g, '') })} />
            </Row>
            <Row label="Default shipping mode" htmlFor="st-mode" hint="Surface is cheaper; Express is faster. Can be changed per order.">
              <select id="st-mode" className="stg-short" value={f.default_mode} disabled={ro} onChange={e => set({ default_mode: e.target.value })}><option>Surface</option><option>Express</option></select>
            </Row>
            <Row label="Return address" hint="Where undelivered parcels come back to. Leave blank to use the pickup location." wide>
              <div className="stg-grid">
                <div className="input-group"><label htmlFor="st-rn">Name</label><input id="st-rn" value={f.return_address.name} disabled={ro} onChange={e => setRet({ name: e.target.value })} /></div>
                <div className="input-group"><label htmlFor="st-rp">Phone</label><input id="st-rp" inputMode="tel" value={f.return_address.phone} disabled={ro} onChange={e => setRet({ phone: e.target.value })} /></div>
                <div className="input-group span2"><label htmlFor="st-ra">Address</label><input id="st-ra" value={f.return_address.address} disabled={ro} onChange={e => setRet({ address: e.target.value })} /></div>
                <div className="input-group"><label htmlFor="st-rc">City</label><input id="st-rc" value={f.return_address.city} disabled={ro} onChange={e => setRet({ city: e.target.value })} /></div>
                <div className="input-group"><label htmlFor="st-rs">State</label><input id="st-rs" value={f.return_address.state} disabled={ro} onChange={e => setRet({ state: e.target.value })} /></div>
                <div className="input-group"><label htmlFor="st-rz">Pincode</label><input id="st-rz" inputMode="numeric" maxLength={6} value={f.return_address.pincode} disabled={ro} onChange={e => setRet({ pincode: e.target.value })} /></div>
              </div>
            </Row>
          </div>
        )}

        {section === 'packaging' && (
          <>
            <div className="stg-card">
              <div className="stg-card-head">
                <div><h3>Your packaging</h3><p>Size in centimetres; empty weight in grams; how many pieces fit.</p></div>
                {!ro && <button className="btn btn-secondary btn-sm" onClick={() => set({ boxes: [...f.boxes, { key: `pack${Date.now()}`, name: 'New packaging', kind: 'box', l: 30, b: 25, h: 10, pack_g: 150, max_items: 4 }] })}><Icon name="plus" size={14} /> Add packaging</button>}
              </div>
              <div className="stg-table-wrap">
                <table className="stg-table">
                  <thead><tr><th>Name</th><th>Type</th><th className="num">Length</th><th className="num">Breadth</th><th className="num">Height</th><th className="num">Empty g</th><th className="num">Fits</th><th aria-label="Remove" /></tr></thead>
                  <tbody>
                    {f.boxes.map((b, i) => (
                      <tr key={b.key}>
                        <td><input aria-label="Packaging name" value={b.name} disabled={ro} onChange={e => setBox(i, { name: e.target.value })} /></td>
                        <td><select aria-label="Type" value={b.kind || 'box'} disabled={ro} onChange={e => setBox(i, { kind: e.target.value })}><option value="polybag">Polybag</option><option value="box">Box</option></select></td>
                        {[['l', 'Length cm'], ['b', 'Breadth cm'], ['h', 'Height cm'], ['pack_g', 'Empty weight in grams'], ['max_items', 'Pieces it fits']].map(([k, label]) => (
                          <td key={k} className="num"><input aria-label={label} type="number" min={k === 'pack_g' ? 0 : 1} value={b[k] ?? ''} disabled={ro} onChange={e => setBox(i, { [k]: e.target.value })} /></td>
                        ))}
                        <td className="act">{!ro && f.boxes.length > 1 && <button className="btn-icon" aria-label={`Remove ${b.name}`} onClick={() => set({ boxes: f.boxes.filter((_, j) => j !== i) })}><Icon name="trash" size={15} /></button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="stg-card">
              <Row label="Default packaging" htmlFor="st-defbox" hint="For orders no rule mentions.">
                <select id="st-defbox" className="stg-short" value={f.default_box} disabled={ro} onChange={e => set({ default_box: e.target.value })}>
                  {f.boxes.map(b => <option key={b.key} value={b.key}>{b.name}</option>)}</select>
              </Row>
              <Row label="Weight per piece" htmlFor="st-itemg" hint="Used when neither a rule nor Shopify has the product's weight.">
                <div className="stg-unit"><input id="st-itemg" type="number" min="10" value={f.default_item_g} disabled={ro} onChange={e => set({ default_item_g: e.target.value })} /><span>g</span></div>
              </Row>
            </div>
          </>
        )}

        {section === 'rules' && (
          <>
            {catError && <div className="ship-alert warning"><span>Your products couldn't be loaded from Shopify, so rules can't be added or changed right now. ({catError})</span></div>}
            <div className="stg-card">
              <div className="stg-card-head">
                <div><h3>Order combinations</h3><p>Checked first, top to bottom; the first that fits the order decides. For example "Hoodie + Mask → Medium box", or "3 or more pieces → Large box".</p></div>
                {!ro && <button className="btn btn-secondary btn-sm" onClick={() => setCombos([...combos, { label: '', when: [], items_min: '', items_max: '', box: f.default_box, weight_g: '' }])}><Icon name="plus" size={14} /> Add combination</button>}
              </div>
              {!combos.length ? <p className="stg-empty">No combinations yet.</p> : (
                <div className="ship-combos">
                  {combos.map((r, i) => (
                    <div className="ship-combo" key={i}>
                      <div className="ship-combo-head">
                        <span className="ship-combo-no">{i + 1}</span>
                        <input aria-label="Rule name" placeholder="Name, e.g. Hoodie + mask" value={r.label} disabled={ro} onChange={e => setCombo(i, { label: e.target.value })} />
                        {!ro && <div className="ship-combo-tools">
                          <button type="button" className="btn-icon" aria-label="Move up" disabled={i === 0} onClick={() => moveCombo(i, -1)}>↑</button>
                          <button type="button" className="btn-icon" aria-label="Move down" disabled={i === combos.length - 1} onClick={() => moveCombo(i, 1)}>↓</button>
                          <button type="button" className="btn-icon" aria-label="Remove combination" onClick={() => setCombos(combos.filter((_, j) => j !== i))}><Icon name="trash" size={15} /></button>
                        </div>}
                      </div>
                      <div className="ship-combo-body">
                        <div>
                          <span className="ship-field-label">The order has</span>
                          {(r.when || []).map((w, k) => (
                            <div className="ship-cond" key={k}>
                              {ro || !cat ? <span>{w.label || w.value}{w.match === 'type' ? ' (any)' : ''}</span>
                                : targetSelect({ label: 'Product or type', value: w.value ? `${w.match}:${w.value}` : '', onChange: (t) => setCond(i, k, t) })}
                              <span className="ship-cond-x">at least</span>
                              <input aria-label="At least how many" type="number" min="1" value={w.min_qty || 1} disabled={ro} onChange={e => setCond(i, k, { min_qty: e.target.value })} />
                              {!ro && <button type="button" className="btn-icon" aria-label="Remove item" onClick={() => setCombo(i, { when: r.when.filter((_, j) => j !== k) })}><Icon name="close" size={14} /></button>}
                            </div>
                          ))}
                          {!ro && <button type="button" className="mini-btn" disabled={!cat} onClick={() => setCombo(i, { when: [...(r.when || []), { match: 'type', value: '', label: '', min_qty: 1 }] })}>+ product or type</button>}
                          {!(r.when || []).length && <p className="packed-sub" style={{ margin: '4px 0 0', maxWidth: 'none' }}>Any products.</p>}
                        </div>
                        <div className="stg-grid four">
                          <div className="input-group"><label htmlFor={`cb-min-${i}`}>Pieces from</label><input id={`cb-min-${i}`} type="number" min="1" placeholder="any" value={r.items_min ?? ''} disabled={ro} onChange={e => setCombo(i, { items_min: e.target.value })} /></div>
                          <div className="input-group"><label htmlFor={`cb-max-${i}`}>to</label><input id={`cb-max-${i}`} type="number" min="1" placeholder="any" value={r.items_max ?? ''} disabled={ro} onChange={e => setCombo(i, { items_max: e.target.value })} /></div>
                          <div className="input-group"><label htmlFor={`cb-box-${i}`}>Packaging</label>
                            <select id={`cb-box-${i}`} value={r.box} disabled={ro} onChange={e => setCombo(i, { box: e.target.value })}>{f.boxes.map(b => <option key={b.key} value={b.key}>{b.name}</option>)}</select></div>
                          <div className="input-group"><label htmlFor={`cb-w-${i}`}>Weight g</label><input id={`cb-w-${i}`} type="number" min="50" placeholder="worked out" value={r.weight_g ?? ''} disabled={ro} onChange={e => setCombo(i, { weight_g: e.target.value })} /></div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="stg-card">
              <div className="stg-card-head">
                <div><h3>Per-product rules</h3><p>For orders no combination fits. Each order goes in the biggest packaging any of its items needs; with more pieces than that fits, the next size up. A rule for a product beats a rule for its type.</p></div>
                {!ro && <button className="btn btn-secondary btn-sm" onClick={() => set({ pack_rules: [...f.pack_rules, { match: 'type', value: '', label: '', box: '', item_g: '' }] })}><Icon name="plus" size={14} /> Add rule</button>}
              </div>
              {!f.pack_rules.length ? <p className="stg-empty">No rules yet: every order goes in the {(boxName(f.default_box) || 'default packaging').toLowerCase()}.</p> : (
                <div className="stg-table-wrap">
                  <table className="stg-table">
                    <thead><tr><th>Applies to</th><th>Packaging</th><th className="num">Weight per piece</th><th aria-label="Remove" /></tr></thead>
                    <tbody>
                      {f.pack_rules.map((r, i) => (
                        <tr key={i}>
                          <td style={{ minWidth: 240 }}>{ro || !cat ? <span>{ruleLabel(r) || '—'}{r.match === 'type' && <span className="packed-sub"> · product type</span>}</span>
                            : targetSelect({ label: 'Product or product type', value: r.value ? `${r.match}:${r.value}` : '', anyText: '(every product of this type)', onChange: (t) => setRule(i, t) })}</td>
                          <td><select aria-label="Packaging" value={r.box || ''} disabled={ro} onChange={e => setRule(i, { box: e.target.value })}>
                            <option value="">Default packaging</option>
                            {f.boxes.map(b => <option key={b.key} value={b.key}>{b.name}</option>)}</select></td>
                          <td className="num"><div className="stg-unit"><input aria-label="Weight per piece in grams" type="number" min="10" placeholder="Shopify" value={r.item_g ?? ''} disabled={ro} onChange={e => setRule(i, { item_g: e.target.value })} /><span>g</span></div></td>
                          <td className="act">{!ro && <button className="btn-icon" aria-label="Remove rule" onClick={() => set({ pack_rules: f.pack_rules.filter((_, j) => j !== i) })}><Icon name="trash" size={15} /></button>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}

        {section === 'automation' && (
          <div className="stg-card">
            <Row label="Fulfil in Shopify with the AWB" hint="When the CRM creates an AWB, the Shopify order is marked fulfilled with it, which sends the customer the Shipped WhatsApp. A re-created AWB replaces the old number.">
              <Toggle label="Shopify fulfil" on={f.shopify_fulfil} disabled={ro} onChange={v => set({ shopify_fulfil: v })} />
            </Row>
            <Row label="Update tracking every 30 minutes" hint="Also finds shipments made in the Delhivery portal, and keeps support tickets and marketing orders up to date.">
              <Toggle label="Tracking sync" on={f.sync_enabled} disabled={ro} onChange={v => set({ sync_enabled: v })} />
            </Row>
            <Row label="Look back" htmlFor="st-days" hint="How far back to look for orders shipped from the portal.">
              <select id="st-days" className="stg-short" value={f.sync_days} disabled={ro} onChange={e => set({ sync_days: Number(e.target.value) })}>
                {[30, 60, 90, 120, 180, 365].map(d => <option key={d} value={d}>{d} days</option>)}
              </select>
            </Row>
            <Row label="Book the daily pickup automatically" hint="Between 10 AM and 4 PM, when parcels are waiting and no pickup is booked yet.">
              <Toggle label="Auto pickup" on={f.auto_pickup} disabled={ro} onChange={v => set({ auto_pickup: v })} />
            </Row>
            <Row label="Pickup time" htmlFor="st-time" hint="The time asked for when a pickup is booked.">
              <input id="st-time" type="time" className="stg-short" value={String(f.pickup_time || '18:00').slice(0, 5)} disabled={ro} onChange={e => set({ pickup_time: e.target.value })} />
            </Row>
          </div>
        )}

        {section === 'alerts' && (
          <div className="stg-card">
            <Row label="Waiting for pickup too long" htmlFor="st-risk" hint="Parcels still waiting after this long reach the bell, before Delhivery cancels them.">
              <select id="st-risk" className="stg-short" value={f.alert_risk_days} disabled={ro} onChange={e => set({ alert_risk_days: Number(e.target.value) })}>
                {[1, 2, 3, 4, 5].map(d => <option key={d} value={d}>{d} day{d > 1 ? 's' : ''}</option>)}
              </select>
            </Row>
            <Row label="CRM bell" hint="Auto-cancels, parcels left waiting and anything Delhivery refuses always reach the bell of everyone with Shipping access.">
              <span className="stg-ok"><Icon name="check" size={14} /> Always on</span>
            </Row>
            <Row label="Also send to WhatsApp" hint="From the Normless number. WhatsApp only delivers it if that number has messaged ours in the last 24 hours.">
              <Toggle label="WhatsApp alerts" on={f.alert_whatsapp} disabled={ro} onChange={v => set({ alert_whatsapp: v })} />
            </Row>
            <Row label="Ops WhatsApp number" htmlFor="st-ops" hint="10-digit mobile.">
              <input id="st-ops" className="stg-short" inputMode="tel" placeholder="98765 43210" value={f.ops_phone} disabled={ro} onChange={e => set({ ops_phone: e.target.value })} />
            </Row>
          </div>
        )}

        {!ro && dirty && (
          <div className="stg-savebar" role="region" aria-label="Unsaved changes">
            <span>You have unsaved changes</span>
            <button className="btn btn-secondary btn-sm" onClick={discard} disabled={busy}>Discard</button>
            <button className="btn btn-primary btn-sm" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button>
          </div>
        )}
      </div>
    </div>
  )
}
