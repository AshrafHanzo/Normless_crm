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
  const [openId, setOpenId] = useState(null)            // shipment in the detail drawer
  const [syncing, setSyncing] = useState(false)
  const [rev, setRev] = useState(0)                     // bumps when anything changed

  const loadShared = useCallback(async () => {
    const [st, c, s] = await Promise.all([
      apiFetch('/api/shipping/status'), apiFetch('/api/shipping/counts'), apiFetch('/api/shipping/settings'),
    ])
    if (st && !st.error) setStatus(st)
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

  const shared = { counts, settings, canManage, isAdmin: !!status?.is_admin, rev, changed, go, ship: setShipOrders, open: setOpenId }

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
          <button className="btn btn-secondary" onClick={syncNow} disabled={syncing || status?.configured === false}>
            <Icon name="refresh" size={15} /> {syncing ? 'Updating…' : 'Update tracking'}
          </button>
        )}
      </div>

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

      {tab === 'overview' && <Overview {...shared} />}
      {tab === 'shipments' && <Shipments {...shared} bucket={bucket} setBucket={(b) => go('shipments', b)} />}
      {tab === 'cancelled' && <AutoCancelled {...shared} />}
      {tab === 'pickups' && <Pickups {...shared} />}
      {tab === 'ndr' && <FailedDeliveries {...shared} />}
      {tab === 'activity' && <Activity {...shared} />}
      {tab === 'settings' && (settings
        ? <ShippingSettings {...shared} onSaved={(s) => { setSettings(s); changed() }} />
        : <div className="loader"><div className="spinner" /></div>)}

      {shipOrders && (
        <ShipDrawer orders={shipOrders} settings={settings} onClose={() => setShipOrders(null)}
          onDone={() => { changed() }} />
      )}
      {openId && (
        <ShipmentDrawer id={openId} canManage={canManage} onClose={() => setOpenId(null)}
          onChanged={changed} onRecreate={() => { setOpenId(null); go('cancelled') }} />
      )}
    </div>
  )
}
