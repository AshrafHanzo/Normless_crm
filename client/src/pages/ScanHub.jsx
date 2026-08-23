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

  // Once an order is on screen the packer needs the garments, not the instructions — the header
  // and the scanner panel collapse into a single slim bar so the items start near the top.
  const compact = !!order;

  return (
    <div className="page-enter">
      <div className={`scan-container ${compact ? 'scan-compact' : ''}`}>
        <div className="scan-bar">
          <div className="scan-bar-title">
            <h1>Order Lookup</h1>
            {!compact && <p>Scan a barcode or look an order up by number.</p>}
          </div>
          <div className="scan-tabs">
            <button
              className={`scan-tab ${activeTab === 'scan' ? 'active' : ''}`}
              onClick={() => { setActiveTab('scan'); setOrder(null); setError(''); setScanValue(''); }}
            >
              🎯 Scan
            </button>
            <button
              className={`scan-tab ${activeTab === 'manual' ? 'active' : ''}`}
              onClick={() => { setActiveTab('manual'); setOrder(null); setError(''); setScanValue(''); }}
            >
              ⌨️ Manual
            </button>
          </div>
        </div>

        {activeTab === 'scan' ? (
          <div className={`scan-listen ${loading ? 'loading' : ''}`}>
            <span className="scan-listen-dot" />
            <span className="scan-listen-text">{loading ? 'Reading…' : 'Listening for scan'}</span>
            {!compact && <span className="scan-listen-hint">Use your barcode gun to scan the order now.</span>}
            {compact && <button type="button" className="mini-btn" onClick={() => { setOrder(null); setError(''); setScanValue(''); }}>Clear</button>}
            {/* Native DOM input, kept focused for hardware-level scanning protection */}
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

        {/* Said before the garments, because this is the last moment before someone pulls a blank
            off the shelf and prints a second copy of something already in the building. */}
        {order && !!(order.rto_matches || []).length && (
          <div className="rto-scan-alert">
            <span className="rto-scan-icon">↩</span>
            <div>
              <b>This order can be filled from the RTO shelf — don't print a new one.</b>
              {order.rto_matches.map((m, i) => (
                <div key={i} className="rto-scan-line">
                  {m.product_title} · {m.variant} — <b>{m.available}</b> waiting
                  {m.blank_type ? ` · ${m.blank_type} ${m.color} ${m.size}` : ''}
                </div>
              ))}
              <div className="rto-scan-hint">Mark it used in Inventory → RTO so the blank goes back into stock.</div>
            </div>
          </div>
        )}

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
            <div className="scan-tip">
              <strong>Tip:</strong> If you are sure the Order ID is correct, make sure you have run a <strong>Full Sync</strong> in the Settings page!
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ScanHub;
