import { useState } from 'react'
import Shipments from './Shipments'

/**
 * Parcels re-made after Delhivery cancelled them (in the CRM or cloned in the portal), so their
 * new labels can be printed together and swapped for the old ones before the next pickup.
 */
export default function Recreated(props) {
  const [all, setAll] = useState(false)
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <p style={{ color: 'var(--text-secondary)', margin: 0, maxWidth: 760, fontSize: 14 }}>
          Each of these replaced an auto-cancelled AWB. Tick them and use <b>Labels</b> to print the new labels in one go,
          then swap each old label for the new one before the pickup.
        </p>
        <div className="scan-tabs" style={{ margin: 0 }}>
          <button className={!all ? 'active' : ''} onClick={() => setAll(false)}>Waiting for pickup</button>
          <button className={all ? 'active' : ''} onClick={() => setAll(true)}>All re-created</button>
        </div>
      </div>
      <Shipments key={all ? 'all' : 'open'} {...props} hideNav bucket={all ? 'recreated_all' : 'recreated'} setBucket={() => {}} />
    </div>
  )
}
