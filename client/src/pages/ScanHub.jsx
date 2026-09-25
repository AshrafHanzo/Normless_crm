import React, { useState, useEffect, useRef } from 'react';
import { useApi } from '../App';
import { useToast } from '../components/Toast';
import OrderDetailsCard from '../components/OrderDetailsCard';
import PackedTab from './scan/PackedTab';

const ScanHub = () => {
  const [activeTab, setActiveTab] = useState('scan');
  const [scanValue, setScanValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');
  
  // The parcel this order has already been logged as, if it has — set by the lookup and by
  // confirming, so the button can say what happened rather than logging a dispatch twice.
  const [packed, setPacked] = useState(null);
  const [packing, setPacking] = useState(false);

  const inputRef = useRef(null);
  const apiFetch = useApi();
  const toast = useToast();
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
        setPacked(data.packed || null);
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

  const clearOrder = () => { setOrder(null); setPacked(null); setError(''); setScanValue(''); };

  /**
   * Confirm the parcel packed.
   *
   * Clears the screen afterwards, because the next thing that happens at the bench is the next
   * label — leaving the finished order up is how the wrong one gets confirmed twice. The tracking
   * number is read off the Shopify fulfilment by the server; nobody types an AWB.
   */
  const confirmPacked = async () => {
    if (!order || packing) return;
    setPacking(true);
    const res = await apiFetch('/api/scanner/packed', {
      method: 'POST',
      body: JSON.stringify({ order_number: order.order_number }),
    });
    setPacking(false);
    if (!res || res.error) { toast.error(res?.error || 'Could not record this parcel'); return; }
    if (res.already) {
      setPacked(res.packed);
      toast.info(`${res.packed.order_number} was already packed by ${res.packed.packed_by || 'someone'}`);
      return;
    }
    toast.success(`${res.packed.order_number} packed${res.packed.awb ? ` · AWB ${res.packed.awb}` : ''}`,
      { title: 'Logged for dispatch' });
    clearOrder();
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
              onClick={() => { setActiveTab('scan'); clearOrder(); }}
            >
              🎯 Scan
            </button>
            <button
              className={`scan-tab ${activeTab === 'manual' ? 'active' : ''}`}
              onClick={() => { setActiveTab('manual'); clearOrder(); }}
            >
              ⌨️ Manual
            </button>
            {/* What has gone out. Beside the scanner rather than on a page of its own: the person
                asking "did that one ship?" is standing at the packing bench. */}
            <button
              className={`scan-tab ${activeTab === 'packed' ? 'active' : ''}`}
              onClick={() => { setActiveTab('packed'); clearOrder(); }}
            >
              📦 Packed
            </button>
          </div>
        </div>

        {activeTab === 'scan' ? (
          <div className={`scan-listen ${loading ? 'loading' : ''}`}>
            <span className="scan-listen-dot" />
            <span className="scan-listen-text">{loading ? 'Reading…' : 'Listening for scan'}</span>
            {!compact && <span className="scan-listen-hint">Use your barcode gun to scan the order now.</span>}
            {compact && <button type="button" className="mini-btn" onClick={clearOrder}>Clear</button>}
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
        ) : activeTab === 'packed' ? (
          <PackedTab />
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
          <>
            <OrderDetailsCard order={order} />
            <div className="pack-confirm">
              {packed ? (
                <div className="pack-done">
                  <span className="pack-done-icon">✓</span>
                  <div>
                    <b>Already packed</b> by {packed.packed_by || 'someone'} · {new Date(packed.packed_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    <div className="pack-done-sub">{packed.awb ? `AWB ${packed.awb}${packed.courier ? ` · ${packed.courier}` : ''}` : 'No tracking number recorded yet'}</div>
                  </div>
                  <button type="button" className="mini-btn" onClick={clearOrder}>Next order</button>
                </div>
              ) : (
                <button type="button" className="btn btn-primary pack-confirm-btn" onClick={confirmPacked} disabled={packing}>
                  {packing ? 'Recording…' : '📦 Confirm packed'}
                </button>
              )}
            </div>
          </>
        ) : activeTab === 'packed' ? null : !loading && !error && (
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
