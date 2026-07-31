import { useState } from 'react'
import { CATALOG, COLOR_HEX, CONTACT } from './catalog'

const CATS = ['All', 'Polos', 'T-Shirts', 'Kids']
const catGradient = {
  Polos: 'linear-gradient(135deg,#0f9e8e,#2dd4bf)',
  'T-Shirts': 'linear-gradient(135deg,#6d5cf0,#9d92ff)',
  Kids: 'linear-gradient(135deg,#f97362,#f5c518)',
}

export default function CrewfitCatalog() {
  const [cat, setCat] = useState('All')
  const [q, setQ] = useState('')

  const items = CATALOG.filter(p =>
    (cat === 'All' || p.category === cat) &&
    (!q || p.name.toLowerCase().includes(q.toLowerCase()) || p.material.toLowerCase().includes(q.toLowerCase()))
  )

  return (
    <div className="page-enter">
      <div className="page-header">
        <h1>Crewfit · Catalog</h1>
        <p>{CATALOG.length} products · bulk customized apparel · prices include printing</p>
      </div>

      <div className="filters-row">
        <div className="search-bar">
          <span className="search-icon">🔍</span>
          <input placeholder="Search products or fabric…" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <div className="cat-chips">
          {CATS.map(c => <button key={c} className={`cat-chip ${cat === c ? 'active' : ''}`} onClick={() => setCat(c)}>{c}</button>)}
        </div>
      </div>

      <div className="catalog-grid">
        {items.map(p => (
          <div className="product-card" key={p.id}>
            <div className="product-head" style={{ background: catGradient[p.category] || 'linear-gradient(135deg,#6d5cf0,#9d92ff)' }}>
              <span className="product-cat">{p.category}</span>
              <span className="product-gsm">{p.gsm} GSM</span>
              <h3>{p.name}</h3>
              <span className="product-fit">{p.fit}</span>
            </div>

            <div className="product-body">
              <p className="product-blurb">{p.blurb}</p>
              <div className="product-material">🧵 {p.material}</div>

              <div className="product-features">
                {p.features.map(f => <span key={f} className="feature-chip">{f}</span>)}
              </div>

              <div className="product-colors">
                <span className="mini-label">{p.colors.length} colors</span>
                <div className="swatches">
                  {p.colors.map(c => (
                    <span key={c} className="swatch" title={c} style={{ background: COLOR_HEX[c] || '#888', borderColor: c === 'White' ? 'var(--border-hover)' : 'transparent' }} />
                  ))}
                </div>
              </div>

              <div className="product-price">
                <div><span className="price-from">from</span> <span className="price-val">₹{p.from}</span> <span className="price-unit">/ pc</span></div>
              </div>

              <div className="tier-table">
                <div className="tier-head"><span>Qty (MOQ)</span><span>Price / pc</span></div>
                {p.tiers.map(([qty, price]) => (
                  <div className="tier-row" key={qty}><span>{qty}</span><span>{typeof price === 'number' ? `₹${price}` : price}</span></div>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="catalog-contact glass-card">
        <div><strong>Crew Fit</strong> · Premium bulk customized apparel</div>
        <div className="contact-row">
          <span>📞 {CONTACT.phone}</span><span>✉️ {CONTACT.email}</span><span>📍 {CONTACT.address}</span>
        </div>
      </div>
    </div>
  )
}
