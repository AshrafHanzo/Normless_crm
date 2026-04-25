import React, { useState, useEffect, useRef } from 'react';
import { useApi } from '../App';
import OrderDetailsCard from '../components/OrderDetailsCard';

const ScanHub = () => {
  const [activeTab, setActiveTab] = useState('scan');
  const [scanValue, setScanValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');
  
  const inputRef = useRef(null);
  const apiFetch = useApi();
  const executeSearchRef = useRef();

  // Always keep the ref perfectly synced with the latest version of the function
  executeSearchRef.current = async (codeToSearch) => {
    const currentScan = codeToSearch.trim();
    if (!currentScan) return;

    setLoading(true);
    setError('');

    try {
      // Aggressive normalization: Strip all words, spaces, and stray small numbers (like 1x). 
      // Extract ONLY a sequence of 4 or more digits which represents the order ID!
      const numberMatch = currentScan.match(/\d{4,}/);
      let cleanValue = numberMatch ? numberMatch[0] : currentScan.replace(/^#/, '');

      // CALL THE NEW VIP ROUTE
      const endpoint = `/api/scanner/lookup/${encodeURIComponent(cleanValue)}`;
      const data = await apiFetch(endpoint);

      if (data && !data.error) {
        setOrder(data);
      } else {
        setError(data?.error || `Order not found. (Scanned: "${currentScan}", isolated ID: "${cleanValue}")`);
        setOrder(null);
      }
    } catch (err) {
      console.error('Scan error:', err);
      setError('Cannot connect to server. Ensure back-end is running.');
      setOrder(null);
    } finally {
      setLoading(false);
    }
  };

  // Aggressive Focus Lock: Forces the invisible input to remain focused AT ALL TIMES
  useEffect(() => {
    if (activeTab !== 'scan') return;

    const enforceFocus = () => {
      if (inputRef.current && document.activeElement !== inputRef.current) {
        // Use preventScroll so the screen doesn't unexpectedly jump to the hidden input
        inputRef.current.focus({ preventScroll: true });
      }
    };

    // Immediately focus
    enforceFocus();

    // Re-focus anytime the user clicks anywhere on the page
    document.addEventListener('click', enforceFocus);
    
    // Aggressive polling to lock focus permanently even after asynchronous data arrivals
    const interval = setInterval(enforceFocus, 500);

    return () => {
      document.removeEventListener('click', enforceFocus);
      clearInterval(interval);
    };
  }, [activeTab]);

  const handleHiddenScanKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = e.target.value;
      if (val.trim() !== '') {
        executeSearchRef.current(val);
        setScanValue(''); // Instantly wipe field clean for next shot
      }
    }
  };

  const handleManualSubmit = (e) => {
    if (e) e.preventDefault();
    executeSearchRef.current(scanValue);
  };

  return (
    <div className="page-enter">
      <div className="page-header">
        <h1>Order Lookup Hub</h1>
        <p>Manage your orders using barcode scanning or manual entry.</p>
      </div>

      <div className="scan-container">
        <div className="scan-tabs">
          <button
            className={`scan-tab ${activeTab === 'scan' ? 'active' : ''}`}
            onClick={() => { setActiveTab('scan'); setOrder(null); setError(''); setScanValue(''); }}
          >
            🎯 Scan Mode
          </button>
          <button
            className={`scan-tab ${activeTab === 'manual' ? 'active' : ''}`}
            onClick={() => { setActiveTab('manual'); setOrder(null); setError(''); setScanValue(''); }}
          >
            ⌨️ Manual Lookup
          </button>
        </div>

        <div className="scan-input-section glass-card">
          {activeTab === 'scan' ? (
            <div className="scan-mode-view">
              <div className={`scan-status ${loading ? 'loading' : 'ready'}`}>
                {loading ? '🔍 Reading...' : '📡 Listening for Scan'}
              </div>
              <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>
                Use your barcode gun to scan the order now.
              </p>
              {/* Restored Native DOM Input for hardware-level scanning protection */}
              <input
                ref={inputRef}
                type="text"
                value={scanValue}
                onChange={(e) => setScanValue(e.target.value)}
                onKeyDown={handleHiddenScanKeyDown}
                style={{ position: 'absolute', opacity: 0, top: '-9999px', left: '-9999px' }}
                autoComplete="off"
              />
            </div>
          ) : (
            <form onSubmit={handleManualSubmit} className="manual-lookup-form">
              <input
                type="text"
                value={scanValue}
                onChange={(e) => setScanValue(e.target.value)}
                placeholder="Type Order ID (e.g. #1001)..."
                className="input"
                autoComplete="off"
              />
              <button type="submit" className="btn btn-primary" disabled={loading}>
                {loading ? '...' : 'Lookup'}
              </button>
            </form>
          )}

          {error && <div className="scan-error-msg">{error}</div>}
        </div>

        <div className="scan-results-view">
          {order ? (
            <OrderDetailsCard order={order} />
          ) : !loading && !error && (
            <div className="empty-state">
              <div className="empty-icon">📦</div>
              <h3>No Scan Detected</h3>
              <p>
                {activeTab === 'scan'
                  ? 'Waiting for barcode input from your scanner...'
                  : 'Enter an order number and click Lookup to begin'}
              </p>
              <div style={{ marginTop: '20px', padding: '16px', borderRadius: '12px', background: 'rgba(255,165,0,0.1)', color: 'rgba(255,165,0,0.9)', fontSize: '13px', maxWidth: '400px', margin: '20px auto' }}>
                <strong>Tip:</strong> If you are sure the Order ID is correct, make sure you have run a <strong>Full Sync</strong> in the Settings page!
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ScanHub;
