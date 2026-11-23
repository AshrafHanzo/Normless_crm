import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApi } from '../App'
import { useToast } from '../components/Toast'
import Icon from '../components/Icon'
import Overview from './shipping/Overview'
import Shipments from './shipping/Shipments'
import AutoCancelled from './shipping/AutoCancelled'
import Pickups from './shipping/Pickups'
import FailedDeliveries from './shipping/FailedDeliveries'
import Activity from './shipping/Activity'
import ShippingSettings from './shipping/ShippingSettings'
import ShipDrawer from './shipping/ShipDrawer'
import ShipmentDrawer from './shipping/ShipmentDrawer'
import ManualShipDrawer from './shipping/ManualShipDrawer'
import { ago } from './shipping/common'

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'shipments', label: 'Shipments' },
  { key: 'cancelled', label: 'Auto-cancelled', count: 'cancelled_open', hot: true },
  { key: 'pickups', label: 'Pickups' },
  { key: 'ndr', label: 'Failed deliveries', count: 'ndr_open' },
  { key: 'activity', label: 'Activity' },
  { key: 'settings', label: 'Settings' },
]

/**
 * Shipping with Delhivery, run from the CRM instead of the Delhivery portal.
 *
 * One page, seven tabs. The page holds what every tab shares: the counts (for the tab badges),
 * the settings (box sizes for the ship drawer), and the two drawers — creating shipments and
 * looking at one — so any tab can open either.
 */
export default function Shipping() {
  const apiFetch = useApi()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const tab = TABS.some(t => t.key === params.get('tab')) ? params.get('tab') : 'overview'
  const [bucket, setBucket] = useState(params.get('bucket') || 'pending')
  const [status, setStatus] = useState(null)
  const [counts, setCounts] = useState({})
  const [settings, setSettings] = useState(null)
  const [shipOrders, setShipOrders] = useState(null)    // orders in the create drawer
  const [shipOpts, setShipOpts] = useState({})
  const [find, setFind] = useState('')
  const [findBy, setFindBy] = useState('any')
  const [finding, setFinding] = useState(false)
  const [errs, setErrs] = useState([])
  const [openId, setOpenId] = useState(null)            // shipment in the detail drawer
  const [syncing, setSyncing] = useState(false)
  const [manual, setManual] = useState(false)
  const [rev, setRev] = useState(0)                     // bumps when anything changed

  const loadShared = useCallback(async () => {
    const [st, c, s] = await Promise.all([
      apiFetch('/api/shipping/status'), apiFetch('/api/shipping/counts'), apiFetch('/api/shipping/settings'),
    ])
    if (st && !st.error) setStatus(st)
    apiFetch('/api/shipping/errors').then(e => { if (e && !e.error) setErrs(e.errors || []) })
    if (c && !c.error) setCounts(c)
    if (s && !s.error) setSettings(s.settings)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => { loadShared() }, [loadShared, rev])

  const go = (key, b) => {
    const next = new URLSearchParams(params)
    next.set('tab', key)
    if (b) { next.set('bucket', b); setBucket(b) } else next.delete('bucket')
    setParams(next)
  }
  const changed = () => setRev(r => r + 1)
  const canManage = !!status?.can_manage

  const syncNow = async () => {
    setSyncing(true)
    const r = await apiFetch('/api/shipping/sync', { method: 'POST' })
    setSyncing(false)
    if (!r || r.error) return toast.error(r?.error || 'Sync failed')
    toast.success(`Tracking updated: ${r.checked} checked, ${r.moved} moved${r.found ? `, ${r.found} found from the portal` : ''}`)
    changed()
  }

  const ship = (orders, opts = {}) => { setShipOpts(opts); setShipOrders(orders) }
  const shared = { counts, settings, canManage, isAdmin: !!status?.is_admin, rev, changed, go, ship, open: setOpenId }

  /**
   * The search at the top, like the Delhivery portal's: AWBs or order numbers, one or many. One
   * shipment found opens it; several go to the list; an order with no AWB goes to Pending AWB.
   */
  const runFind = async (e) => {
    e?.preventDefault()
    const term = find.trim()
    if (!term) return
    setFinding(true)
    const list = term.split(/[\s,]+/).filter(Boolean)
    const asOrders = findBy === 'order' || (findBy === 'any' && list.every(x => /^#?\d{3,7}[A-Z]?$/i.test(x)))
    const q = new URLSearchParams({ q: list.join(','), limit: '5' })
    const r = await apiFetch(`/api/shipping/shipments?bucket=everything&${q}`)
    setFinding(false)
    const n = r?.pagination?.total || 0
    if (n === 1) return setOpenId(r.shipments[0].id)
    if (n > 1) { setSearchSeed(term); return go('shipments', 'everything') }
    if (asOrders) {
      const p = await apiFetch(`/api/shipping/pending?${new URLSearchParams({ q: list.join(','), limit: '5' })}`)
      if (p?.pagination?.total) { setSearchSeed(term); return go('shipments', 'pending') }
      const h = await apiFetch(`/api/shipping/pending?${new URLSearchParams({ q: list.join(','), hold: 'only', limit: '5' })}`)
      if (h?.pagination?.total) { setSearchSeed(term); return go('shipments', 'on_hold') }
    }
    toast.warning(`Nothing found for ${term}`)
  }
  const [searchSeed, setSearchSeed] = useState('')
  const dismissErr = async (id) => {
    setErrs(list => list.filter(x => x.id !== id))
    await apiFetch(`/api/shipping/errors/${id}/dismiss`, { method: 'POST' })
  }

  return (
    <div className="page-enter">
      <div className="dash-toolbar">
        <div>
          <h1>Shipping</h1>
          <p style={{ color: 'var(--text-muted)' }}>
            Delhivery · {settings?.pickup_location || 'pickup location not set'}
            {status?.last_sync && <> · tracking updated {ago(status.last_sync.started_at)}</>}
          </p>
        </div>
        {canManage && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-secondary" onClick={syncNow} disabled={syncing || status?.configured === false}>
              <Icon name="refresh" size={15} /> {syncing ? 'Updating…' : 'Update tracking'}
            </button>
            <button className="btn btn-primary" onClick={() => setManual(true)} disabled={status?.configured === false}>
              <Icon name="plus" size={15} /> New shipment
            </button>
          </div>
        )}
      </div>

      <form className="ship-find" onSubmit={runFind} role="search">
        <select aria-label="Search by" value={findBy} onChange={e => setFindBy(e.target.value)}>
          <option value="any">AWB or order</option><option value="awb">AWB</option><option value="order">Order ID</option>
        </select>
        <div className="search-bar" style={{ flex: 1 }}><span className="search-icon" />
          <input value={find} onChange={e => setFind(e.target.value)}
            placeholder={findBy === 'order' ? 'Order IDs, e.g. #13584 (paste many)' : findBy === 'awb' ? 'AWB numbers (paste many)' : 'Search AWBs or order IDs (paste many)'} /></div>
        <button type="submit" className="btn btn-primary" disabled={finding || !find.trim()}>{finding ? 'Searching…' : 'Find'}</button>
      </form>

      {errs.length > 0 && (
        <div className="ship-errors" role="alert">
          {errs.map(e => (
            <div key={e.id} className="ship-alert danger" style={{ marginBottom: 8 }}>
              <strong>Delhivery: {e.title || e.kind}</strong>
              <span>{(e.errors || []).filter(x => x.error && !x.soft).slice(0, 2).map(x => `${x.order_number ? `${x.order_number}: ` : ''}${x.error}`).join(' · ') || e.summary}</span>
              <span className="ship-alert-action" style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-secondary btn-sm" onClick={() => go('activity')}>Details</button>
                <button className="btn btn-secondary btn-sm" onClick={() => dismissErr(e.id)}>Dismiss</button>
              </span>
            </div>
          ))}
        </div>
      )}

      {status && !status.configured && (
        <div className="ship-alert danger">
          <strong>Delhivery isn't connected.</strong>
          <span>The server has no DELHIVERY_API_TOKEN, so nothing can be created or tracked.</span>
        </div>
      )}

      <div className="scan-tabs" style={{ marginBottom: 18, maxWidth: '100%', overflowX: 'auto' }}>
        {TABS.map(t => (
          <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => go(t.key)} style={{ whiteSpace: 'nowrap' }}>
            {t.label}
            {t.count && counts[t.count] > 0 && (
              <span className="tab-badge" style={t.hot && tab !== t.key ? { background: 'var(--danger)', color: '#fff' } : undefined}>{counts[t.count]}</span>
            )}
          </button>
        ))}
      </div>

      {tab === 'overview' && <Overview {...shared} settings={settings} />}
      {tab === 'shipments' && <Shipments key={`${bucket}|${searchSeed}`} {...shared} bucket={bucket} searchSeed={searchSeed} setBucket={(b) => { setSearchSeed(''); go('shipments', b) }} />}
      {tab === 'cancelled' && <AutoCancelled {...shared} />}
      {tab === 'pickups' && <Pickups {...shared} />}
      {tab === 'ndr' && <FailedDeliveries {...shared} />}
      {tab === 'activity' && <Activity {...shared} />}
      {tab === 'settings' && (settings
        ? <ShippingSettings {...shared} onSaved={(s) => { setSettings(s); changed() }} />
        : <div className="loader"><div className="spinner" /></div>)}

      {shipOrders && (
        <ShipDrawer orders={shipOrders} settings={settings} editFirst={!!shipOpts.editFirst} onClose={() => setShipOrders(null)}
          onDone={() => { changed() }} />
      )}
      {manual && <ManualShipDrawer onClose={() => setManual(false)} onDone={changed} />}
      {openId && (
        <ShipmentDrawer id={openId} canManage={canManage} settings={settings} onClose={() => setOpenId(null)}
          onChanged={changed} onRecreate={() => { setOpenId(null); go('cancelled') }} />
      )}
    </div>
  )
}
