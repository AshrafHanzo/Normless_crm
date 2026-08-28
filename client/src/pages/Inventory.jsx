import { useState, useEffect } from 'react'
import { useApi } from '../App'
import StockTab from './inventory/StockTab'
import RtoTab from './inventory/RtoTab'
import DamagedTab from './inventory/DamagedTab'

const TABS = [
  { key: 'stock', label: 'Inventory' },
  { key: 'rto', label: 'RTO' },
  { key: 'damaged', label: 'Damaged' },
]

/**
 * Three shelves, one page.
 *
 * They are tabs rather than three menu items because they are the same question asked three ways —
 * what have we got — and because a piece moves between them: a return lands on the RTO shelf, goes
 * out to another order (crediting its blank), or is written off.
 */
export default function Inventory() {
  const apiFetch = useApi()
  const [tab, setTab] = useState(() => localStorage.getItem('crm_inventory_tab') || 'stock')
  const [alerts, setAlerts] = useState(0)

  const choose = (key) => { setTab(key); localStorage.setItem('crm_inventory_tab', key) }

  // The badge is the whole point of the RTO shelf, so it is loaded by the page itself rather than
  // waiting for someone to open the tab that would tell them to open it.
  const loadAlerts = async () => {
    const r = await apiFetch('/api/inventory/rto/alerts')
    if (r && !r.error) setAlerts(r.orders || 0)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadAlerts() }, [tab])

  return (
    <div className="page-enter">
      {/* Each tab describes itself in its own toolbar, so the shell carries only the name. */}
      <h1 style={{ marginBottom: 14 }}>Inventory</h1>

      <div className="scan-tabs" style={{ marginBottom: 14 }}>
        {TABS.map(t => (
          <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => choose(t.key)}>
            {t.label}
            {t.key === 'rto' && alerts > 0 && <span className="tab-badge">{alerts}</span>}
          </button>
        ))}
      </div>

      {tab === 'stock' && <StockTab />}
      {/* The tab reports that something moved; the count itself always comes from the one endpoint
          that defines it. Reading a field off the tab's payload coupled the badge to that field's
          name, and renaming it silently zeroed the badge the moment the tab was opened. */}
      {tab === 'rto' && <RtoTab onChanged={loadAlerts} />}
      {tab === 'damaged' && <DamagedTab />}
    </div>
  )
}
