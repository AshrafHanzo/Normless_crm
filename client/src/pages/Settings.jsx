import { useState, useEffect } from 'react'
import { useApi } from '../App'

export default function Settings() {
  const apiFetch = useApi()
  const [lastSync, setLastSync] = useState(null)
  const [connectionStatus, setConnectionStatus] = useState(null)
  const [testing, setTesting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState(null)

  useEffect(() => {
    loadSyncStatus()
    testConnection()
    // Poll sync status every 5 seconds
    const interval = setInterval(loadSyncStatus, 5000)
    return () => clearInterval(interval)
  }, [])

  const loadSyncStatus = async () => {
    const result = await apiFetch('/api/sync/status')
    if (result) setLastSync(result.lastSync)
  }

  const testConnection = async () => {
    setTesting(true)
    try {
      const result = await apiFetch('/api/sync/test')
      setConnectionStatus(result)
    } catch {
      setConnectionStatus({ connected: false, error: 'Could not reach Shopify' })
    }
    setTesting(false)
  }

  const runSync = async () => {
    setSyncing(true)
    setSyncResult(null)
    const result = await apiFetch('/api/sync/run', { method: 'POST' })
    if (result) {
      setSyncResult(result)
      loadSyncStatus()
    }
    setSyncing(false)
  }

  const formatDate = (d) => d ? new Date(d).toLocaleString('en-IN') : '-'

  return (
    <div className="page-enter">
      <div className="page-header">
        <h1>Settings & Sync</h1>
        <p>Shopify data syncs automatically every 30 seconds</p>
      </div>

      <div className="grid-2" style={{ marginBottom: '24px' }}>
        {/* Connection Status */}
        <div className="glass-card">
          <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '20px' }}>🔌 Shopify Connection</h3>

          {testing ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div className="spinner" style={{ width: '20px', height: '20px' }}></div>
              <span style={{ color: 'var(--text-secondary)' }}>Testing connection...</span>
            </div>
          ) : connectionStatus ? (
            <div>
              <div style={{
                display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px',
                padding: '12px', borderRadius: 'var(--radius-md)',
                background: connectionStatus.connected ? 'var(--success-bg)' : 'var(--danger-bg)',
              }}>
                <span style={{ fontSize: '20px' }}>{connectionStatus.connected ? '✅' : '❌'}</span>
                <span style={{ fontWeight: 600, color: connectionStatus.connected ? 'var(--success)' : 'var(--danger)' }}>
                  {connectionStatus.connected ? 'Connected' : 'Disconnected'}
                </span>
              </div>

              {connectionStatus.connected && connectionStatus.shop && (
                <div style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>
                  <div style={{ marginBottom: '6px' }}><strong>Store:</strong> {connectionStatus.shop.name}</div>
                  <div style={{ marginBottom: '6px' }}><strong>Domain:</strong> {connectionStatus.shop.myshopifyDomain}</div>
                  <div><strong>Email:</strong> {connectionStatus.shop.email}</div>
                </div>
              )}

              {!connectionStatus.connected && (
                <div style={{ fontSize: '13px', color: 'var(--danger)' }}>{connectionStatus.error}</div>
              )}
            </div>
          ) : null}

          <button className="btn btn-secondary btn-sm" onClick={testConnection} disabled={testing} style={{ marginTop: '16px' }}>
            Test Connection
          </button>
        </div>

        {/* Last Sync Info */}
        <div className="glass-card">
          <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '20px' }}>📊 Last Sync Info</h3>

          {lastSync ? (
            <div style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>
              <div style={{ marginBottom: '8px' }}>
                <strong>Status:</strong>{' '}
                <span className={`status-badge ${lastSync.status === 'success' ? 'fulfilled' : 'refunded'}`}>
                  {lastSync.status}
                </span>
              </div>
              <div style={{ marginBottom: '6px' }}><strong>Type:</strong> {lastSync.type}</div>
              <div style={{ marginBottom: '6px' }}><strong>Records Synced:</strong> {lastSync.records_synced}</div>
              <div style={{ marginBottom: '6px' }}><strong>Started:</strong> {formatDate(lastSync.started_at)}</div>
              <div><strong>Completed:</strong> {formatDate(lastSync.completed_at)}</div>
              {lastSync.error_message && (
                <div style={{ marginTop: '8px', color: 'var(--danger)', fontSize: '13px' }}>
                  Error: {lastSync.error_message}
                </div>
              )}
            </div>
          ) : (
            <div style={{ color: 'var(--text-muted)', fontSize: '14px' }}>
              Auto-sync will run soon... First sync in progress!
            </div>
          )}
        </div>
      </div>

      {/* Auto-Sync Status - Always Active */}
      <div className="glass-card" style={{ marginBottom: '24px' }}>
        <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '12px' }}>⚡ Real-Time Auto-Sync</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '20px' }}>
          Your Shopify data is automatically synced every 30 seconds. Customers, orders, and inventory are always current - no manual action needed!
        </p>

        <div style={{
          padding: '16px', borderRadius: 'var(--radius-md)',
          background: 'var(--success-bg)', border: '1px solid var(--success)20'
        }}>
          <div style={{ fontWeight: 600, color: 'var(--success)', marginBottom: '8px' }}>
            ✅ Auto-Sync Active
          </div>
          <div style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>
            Syncing every 30 seconds • In background • Always current
          </div>
        </div>
      </div>

      {/* Manual Sync (Optional - for emergency refresh) */}
      <div className="glass-card">
        <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '12px' }}>🔄 Manual Refresh (Optional)</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '20px' }}>
          Click below to force an immediate sync. Usually not needed since auto-sync is running.
        </p>

        {syncResult && (
          <div style={{
            padding: '16px', borderRadius: 'var(--radius-md)', marginBottom: '16px',
            background: syncResult.success ? 'var(--success-bg)' : 'var(--danger-bg)',
            border: `1px solid ${syncResult.success ? 'var(--success)' : 'var(--danger)'}20`,
          }}>
            {syncResult.success ? (
              <div>
                <div style={{ fontWeight: 600, color: 'var(--success)', marginBottom: '8px' }}>✅ Sync Completed!</div>
                <div style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>
                  Synced {syncResult.customers} customers and {syncResult.orders} orders.
                </div>
              </div>
            ) : (
              <div>
                <div style={{ fontWeight: 600, color: 'var(--danger)', marginBottom: '8px' }}>❌ Sync Failed</div>
                <div style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>{syncResult.error}</div>
              </div>
            )}
          </div>
        )}

        <button className="btn btn-secondary" onClick={runSync} disabled={syncing}>
          {syncing ? (
            <>
              <div className="spinner" style={{ width: '18px', height: '18px', borderWidth: '2px' }}></div>
              Syncing...
            </>
          ) : (
            '🔄 Force Sync Now'
          )}
        </button>
      </div>
    </div>
  )
}
