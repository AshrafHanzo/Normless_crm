import React, { useState } from 'react';

const OrderDetailsCard = ({ order }) => {
  const [selectedImage, setSelectedImage] = useState(null);
  const [carouselIndex, setCarouselIndex] = useState({});

  if (!order) return null;

  // Get all images for an item
  const getItemImages = (item) => {
    if (item.all_images && item.all_images.length > 0) {
      return item.all_images;
    } else if (item.image || item.main_image) {
      return [item.image || item.main_image];
    }
    return [];
  };

  // Handle carousel navigation
  const handleCarouselNav = (itemIdx, direction) => {
    const item = order.line_items[itemIdx];
    const images = getItemImages(item);
    if (images.length === 0) return;

    const currentIndex = carouselIndex[itemIdx] || 0;
    let newIndex;

    if (direction === 'next') {
      newIndex = (currentIndex + 1) % images.length;
    } else {
      newIndex = (currentIndex - 1 + images.length) % images.length;
    }

    setCarouselIndex({ ...carouselIndex, [itemIdx]: newIndex });
  };

  // Open image in modal with carousel
  const openImageModal = (image, itemIdx) => {
    setSelectedImage({ image, itemIdx });
  };

  // Navigate in modal carousel
  const handleModalCarouselNav = (direction) => {
    if (!selectedImage) return;

    const item = order.line_items[selectedImage.itemIdx];
    const images = getItemImages(item);
    if (images.length === 0) return;

    const currentImage = selectedImage.image;
    const currentIdx = images.indexOf(currentImage);

    let newIdx;
    if (direction === 'next') {
      newIdx = (currentIdx + 1) % images.length;
    } else {
      newIdx = (currentIdx - 1 + images.length) % images.length;
    }

    setSelectedImage({ image: images[newIdx], itemIdx: selectedImage.itemIdx });
  };

  return (
    <>
      <div className="glass-card page-enter" style={{ marginTop: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px', borderBottom: '1px solid var(--border)', paddingBottom: '16px' }}>
          <div>
            <h2 style={{ fontSize: '20px', fontWeight: 700 }}>Order {String(order.order_number || order.name || order.id).startsWith('#') ? '' : '#'}{order.order_number || order.name || order.id}</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
              {order.customer?.first_name} {order.customer?.last_name} ({order.customer?.email})
            </p>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <span className={`status-badge ${order.financial_status === 'paid' ? 'paid' : ''}`}>
              {order.financial_status}
            </span>
            <span className={`status-badge ${order.fulfillment_status === 'fulfilled' ? 'fulfilled' : 'unfulfilled'}`}>
              {order.fulfillment_status || 'Unfulfilled'}
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
          {order.line_items.map((item, itemIdx) => {
            const images = getItemImages(item);
            const currentImageIdx = carouselIndex[itemIdx] || 0;
            const currentImage = images.length > 0 ? images[currentImageIdx] : null;

            return (
              <div key={itemIdx} style={{ padding: '20px', background: 'rgba(255,255,255,0.02)', borderRadius: '12px', border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                  <h3 style={{ fontSize: '16px', fontWeight: 600 }}>{item.title}</h3>
                  <div className="spec-badge-item qty-badge">
                    Qty: <strong>{item.quantity}</strong>
                  </div>
                </div>

                {/* Image Carousel */}
                {images.length > 0 ? (
                  <div className="image-carousel-container">
                    <div className="image-carousel-main">
                      <img
                        src={currentImage}
                        alt={`${item.title} - Image ${currentImageIdx + 1}`}
                        className="carousel-main-image"
                        onClick={() => openImageModal(currentImage, itemIdx)}
                      />

                      {/* Carousel Controls */}
                      {images.length > 1 && (
                        <>
                          <button
                            className="carousel-nav-btn carousel-nav-prev"
                            onClick={() => handleCarouselNav(itemIdx, 'prev')}
                            title="Previous image"
                          >
                            ‹
                          </button>
                          <button
                            className="carousel-nav-btn carousel-nav-next"
                            onClick={() => handleCarouselNav(itemIdx, 'next')}
                            title="Next image"
                          >
                            ›
                          </button>

                          {/* Image Counter */}
                          <div className="carousel-counter">
                            {currentImageIdx + 1} / {images.length}
                          </div>
                        </>
                      )}
                    </div>

                    {/* Thumbnail Strip */}
                    {images.length > 1 && (
                      <div className="carousel-thumbnails">
                        {images.map((img, i) => (
                          <button
                            key={i}
                            className={`carousel-thumbnail ${i === currentImageIdx ? 'active' : ''}`}
                            onClick={() => setCarouselIndex({ ...carouselIndex, [itemIdx]: i })}
                            title={`Image ${i + 1}`}
                          >
                            <img src={img} alt={`Thumbnail ${i + 1}`} />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="item-gallery-image" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface)' }}>
                    No Image
                  </div>
                )}

                {/* Specs */}
                <div className="specs-grid-items">
                  {item.options && item.options.map((opt, i) => (
                    <div key={i} className="spec-badge-item">
                      <span style={{ color: 'var(--text-muted)' }}>{opt.name}:</span>
                      <span style={{ marginLeft: '6px', fontWeight: 600 }}>{opt.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Image Modal with Carousel */}
      {selectedImage && (
        <div className="image-modal-overlay" onClick={() => setSelectedImage(null)}>
          <div className="image-modal-content" onClick={e => e.stopPropagation()}>
            <button className="image-modal-close" onClick={() => setSelectedImage(null)}>✕</button>

            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <img
                src={selectedImage.image}
                alt="Full screen preview"
                className="full-image"
              />

              {/* Modal Carousel Controls */}
              {getItemImages(order.line_items[selectedImage.itemIdx]).length > 1 && (
                <>
                  <button
                    className="modal-carousel-nav-btn modal-carousel-prev"
                    onClick={() => handleModalCarouselNav('prev')}
                    title="Previous image"
                  >
                    ‹
                  </button>
                  <button
                    className="modal-carousel-nav-btn modal-carousel-next"
                    onClick={() => handleModalCarouselNav('next')}
                    title="Next image"
                  >
                    ›
                  </button>

                  <div className="modal-carousel-counter">
                    {getItemImages(order.line_items[selectedImage.itemIdx]).indexOf(selectedImage.image) + 1} / {getItemImages(order.line_items[selectedImage.itemIdx]).length}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default OrderDetailsCard;
