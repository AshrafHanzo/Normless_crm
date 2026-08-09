import React, { useState, useEffect } from 'react';

// Shopify hands the same product back under a few different shapes depending on whether the
// gallery was resolved at sync time or backfilled later — normalise to a plain array of URLs.
const getItemImages = (item) => {
  if (item?.all_images?.length) return item.all_images;
  const single = item?.image || item?.main_image;
  return single ? [single] : [];
};

// Shopify statuses arrive lowercase snake_case ("partially_refunded") — title-case them.
const label = (s) => String(s).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

const orderDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const OrderDetailsCard = ({ order }) => {
  // { itemIdx, index } — the item and position being previewed full-screen, or null.
  const [lightbox, setLightbox] = useState(null);

  // A fresh scan must not inherit the previous order's open lightbox.
  const orderKey = order?.id ?? order?.order_number ?? order?.name;
  useEffect(() => { setLightbox(null); }, [orderKey]);

  const items = order?.line_items || [];

  const stepLightbox = (delta) => setLightbox((lb) => {
    if (!lb) return lb;
    const total = getItemImages(items[lb.itemIdx]).length;
    if (total < 2) return lb;
    return { ...lb, index: (lb.index + delta + total) % total };
  });

  // The scanner gun owns the keyboard on this page, so the lightbox only binds keys while it is
  // actually open — otherwise a scan ending in Enter would fight with these handlers.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e) => {
      if (e.key === 'Escape') setLightbox(null);
      else if (e.key === 'ArrowLeft') stepLightbox(-1);
      else if (e.key === 'ArrowRight') stepLightbox(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightbox, items]);

  if (!order) return null;

  // The picker's headline number: how many physical units to pull off the shelf, which is the
  // sum of the line quantities — not the number of lines.
  const totalQty = items.reduce((sum, it) => sum + (Number(it.quantity) || 0), 0);
  const orderRef = String(order.order_number || order.name || order.id || '');
  const customerName = [order.first_name, order.last_name].filter(Boolean).join(' ');
  const placed = orderDate(order.created_at);
  const fulfilled = (order.fulfillment_status || '').toLowerCase() === 'fulfilled';

  return (
    <>
      <div className="scan-order-card page-enter">
        {/* Order identity and the pick counts share one band. They were two stacked strips, which
            cost ~90px of height that the packer has to scroll past to reach the garments. */}
        <div className="scan-order-head">
          <div className="scan-order-id">
            <h2>{orderRef.startsWith('#') ? orderRef : `#${orderRef}`}</h2>
            <div className="scan-order-meta">
              {customerName && <span className="scan-order-customer">{customerName}</span>}
              {placed && <span>{placed}</span>}
              <span>{items.length} {items.length === 1 ? 'product' : 'products'}</span>
            </div>
          </div>
          <div className="scan-order-badges">
            <span className={`status-badge ${fulfilled ? 'fulfilled' : 'unfulfilled'}`}>{label(order.fulfillment_status || 'Unfulfilled')}</span>
            <div className="scan-total-pill">
              <span className="scan-total-value">{totalQty}</span>
              <span className="scan-total-label">units<br />to pack</span>
            </div>
          </div>
        </div>

        {/* One row per product: identity on the left, every image of that product in a single row
            beside it, count on the right. Keeping the three side by side rather than stacking the
            heading above the photos is what lets a whole order fit on one screen. */}
        <div className="scan-items">
          {items.map((item, itemIdx) => {
            const images = getItemImages(item);
            const options = (item.options || []).filter(o => o?.value && o.value !== 'N/A');

            return (
              <div className="scan-item" key={item.id ?? `${item.title}-${itemIdx}`}>
                <div className="scan-item-body">
                  <div className="scan-item-title">{item.title}</div>
                  <div className="scan-item-specs">
                    {options.map((opt, i) => (
                      <span className="scan-spec" key={i}>
                        <span className="scan-spec-name">{opt.name}</span>
                        <span className="scan-spec-value">{opt.value}</span>
                      </span>
                    ))}
                  </div>
                  {item.sku && <div className="scan-item-sku">SKU {item.sku}</div>}
                </div>

                <div className="scan-item-gallery">
                  {images.length > 0 ? images.map((img, i) => (
                    <button
                      type="button"
                      key={i}
                      className="scan-item-shot"
                      onClick={() => setLightbox({ itemIdx, index: i })}
                      title="Click to enlarge"
                    >
                      <img src={img} alt={`${item.title} — ${i + 1}`} loading="lazy" />
                    </button>
                  )) : (
                    <div className="scan-item-shot scan-item-shot-empty">No image</div>
                  )}
                </div>

                <div className="scan-item-qty">
                  <span className="scan-item-qty-value">×{item.quantity}</span>
                  <span className="scan-item-qty-label">to pack</span>
                </div>
              </div>
            );
          })}
          {items.length === 0 && <div className="scan-item-empty">This order has no line items recorded.</div>}
        </div>
      </div>

      {lightbox && (() => {
        const images = getItemImages(items[lightbox.itemIdx]);
        if (!images.length) return null;
        return (
          <div className="image-modal-overlay" onClick={() => setLightbox(null)}>
            <div className="image-modal-content" onClick={e => e.stopPropagation()}>
              <button className="image-modal-close" onClick={() => setLightbox(null)}>✕</button>
              <img src={images[lightbox.index]} alt={items[lightbox.itemIdx]?.title || 'Preview'} className="full-image" />
              {images.length > 1 && (
                <>
                  <button className="modal-carousel-nav-btn modal-carousel-prev" onClick={() => stepLightbox(-1)}>‹</button>
                  <button className="modal-carousel-nav-btn modal-carousel-next" onClick={() => stepLightbox(1)}>›</button>
                  <div className="modal-carousel-counter">{lightbox.index + 1} / {images.length}</div>
                </>
              )}
            </div>
          </div>
        );
      })()}
    </>
  );
};

export default OrderDetailsCard;
