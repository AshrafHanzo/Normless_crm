import { useState, useEffect } from 'react'
import { useApi, useAuth } from '../../App'
import { useToast } from '../../components/Toast'
import { CATALOG, COLOR_HEX, CONTACT } from './catalog'

const CATS = ['All', 'Polos', 'T-Shirts', 'Kids']
const catGradient = {
  Polos: 'linear-gradient(135deg,#0f9e8e,#2dd4bf)',
  'T-Shirts': 'linear-gradient(135deg,#6d5cf0,#9d92ff)',
  Kids: 'linear-gradient(135deg,#f97362,#f5c518)',
}
const priceOf = (p) => p.from_price ?? p.from

export default function CrewfitCatalog() {
  const apiFetch = useApi()
  const { user } = useAuth()
  const toast = useToast()
  // Catalog pricing is commercially sensitive — only the owner may add, edit or remove
  // products. The server enforces the same rule; this just keeps the buttons honest.
  const isOwner = user?.role === 'owner'
  const [cat, setCat] = useState('All')
  const [q, setQ] = useState('')
  const [products, setProducts] = useState(null)
  const [edit, setEdit] = useState(null) // product being edited/created
  const [saving, setSaving] = useState(false)

  const load = () => apiFetch('/api/crewfit/products').then(r => setProducts(r?.products?.length ? r.products : CATALOG))
  useEffect(() => { load() }, [])

  const list = (products || CATALOG).filter(p =>
    (cat === 'All' || p.category === cat) &&
    (!q || p.name.toLowerCase().includes(q.toLowerCase()) || (p.material || '').toLowerCase().includes(q.toLowerCase()))
  )

  const openNew = () => setEdit({ name: '', category: 'Polos', fit: 'Unisex', gsm: '', material: '', from_price: '', blurb: '', _features: '', _colors: '', _tiers: '5–10 = \n11–20 = \n21–50 = \n51–100 = \n100+ = On request' })
  const openEdit = (p) => setEdit({ ...p, _features: (p.features || []).join(', '), _colors: (p.colors || []).join(', '), _tiers: (p.tiers || []).map(([l, v]) => `${l} = ${v}`).join('\n') })

  const save = async () => {
    setSaving(true)
    const body = {
      name: edit.name, category: edit.category, fit: edit.fit, gsm: String(edit.gsm), material: edit.material,
      from_price: parseFloat(edit.from_price) || 0, blurb: edit.blurb,
      features: edit._features.split(',').map(s => s.trim()).filter(Boolean),
      colors: edit._colors.split(',').map(s => s.trim()).filter(Boolean),
      tiers: edit._tiers.split('\n').map(l => l.split('=')).filter(a => a[0]?.trim()).map(([l, v]) => {
        v = (v || '').trim(); const n = parseFloat(v); return [l.trim(), isNaN(n) ? (v || 'On request') : n]
      }),
    }
    const isNew = !edit.id
    const res = await apiFetch(`/api/crewfit/products${isNew ? '' : '/' + edit.id}`, { method: isNew ? 'POST' : 'PUT', body: JSON.stringify(body) })
    setSaving(false)
    if (res && !res.error) { setEdit(null); load(); toast.success(edit.id ? 'Product updated' : 'Product added') } else toast.error(res?.error || 'Save failed')
  }

  const del = async (p) => {
    if (!await toast.confirm({ title: `Delete "${p.name}"?`, message: 'This removes the product from the catalog. Existing orders are unaffected.', confirmLabel: 'Delete product', danger: true })) return
    await apiFetch(`/api/crewfit/products/${p.id}`, { method: 'DELETE' }); load()
  }

  return (
    <div className="page-enter">
      <div className="dash-toolbar">
        <div><h1>Crewfit · Catalog</h1><p style={{ color: 'var(--text-muted)' }}>{list.length} products · prices include printing</p></div>
        {isOwner && <button className="btn btn-primary" onClick={openNew}>+ Add Product</button>}
      </div>

      <div className="filters-row">
        <div className="search-bar"><span className="search-icon">🔍</span><input placeholder="Search products or fabric…" value={q} onChange={e => setQ(e.target.value)} /></div>
        <div className="cat-chips">{CATS.map(c => <button key={c} className={`cat-chip ${cat === c ? 'active' : ''}`} onClick={() => setCat(c)}>{c}</button>)}</div>
      </div>

      <div className="catalog-grid">
        {list.map((p, i) => (
          <div className="product-card" key={p.id || i}>
            <div className="product-head" style={{ background: catGradient[p.category] || 'linear-gradient(135deg,#6d5cf0,#9d92ff)' }}>
              <span className="product-cat">{p.category}</span>
              <span className="product-gsm">{p.gsm} GSM</span>
              <h3>{p.name}</h3>
              <span className="product-fit">{p.fit}</span>
              {isOwner && p.id && <div className="product-actions"><button onClick={() => openEdit(p)} title="Edit">✏️</button><button onClick={() => del(p)} title="Delete">🗑️</button></div>}
            </div>
            <div className="product-body">
              <p className="product-blurb">{p.blurb}</p>
              <div className="product-material">🧵 {p.material}</div>
              <div className="product-features">{(p.features || []).map(f => <span key={f} className="feature-chip">{f}</span>)}</div>
              <div className="product-colors"><span className="mini-label">{(p.colors || []).length} colors</span>
                <div className="swatches">{(p.colors || []).map(c => <span key={c} className="swatch" title={c} style={{ background: COLOR_HEX[c] || '#888', borderColor: c === 'White' ? 'var(--border-hover)' : 'transparent' }} />)}</div>
              </div>
              <div className="product-price"><div><span className="price-from">from</span> <span className="price-val">₹{priceOf(p)}</span> <span className="price-unit">/ pc</span></div></div>
              <div className="tier-table">
                <div className="tier-head"><span>Qty (MOQ)</span><span>Price / pc</span></div>
                {(p.tiers || []).map(([qty, price], j) => <div className="tier-row" key={j}><span>{qty}</span><span>{typeof price === 'number' ? `₹${price}` : price}</span></div>)}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="catalog-contact glass-card">
        <div><strong>Crew Fit</strong> · Premium bulk customized apparel</div>
        <div className="contact-row"><span>📞 {CONTACT.phone}</span><span>✉️ {CONTACT.email}</span><span>📍 {CONTACT.address}</span></div>
      </div>

      {edit && (
        <>
          <div className="drawer-overlay" onClick={() => setEdit(null)} />
          <div className="drawer">
            <div className="drawer-header"><h2>{edit.id ? 'Edit Product' : 'Add Product'}</h2><button className="btn-icon" onClick={() => setEdit(null)}>✕</button></div>
            <div className="drawer-body">
              <div className="form-row">
                <div className="input-group"><label>Name *</label><input value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} /></div>
                <div className="input-group"><label>Category</label><select value={edit.category} onChange={e => setEdit({ ...edit, category: e.target.value })}>{['Polos', 'T-Shirts', 'Kids', 'Other'].map(c => <option key={c}>{c}</option>)}</select></div>
                <div className="input-group"><label>Fit</label><input value={edit.fit} onChange={e => setEdit({ ...edit, fit: e.target.value })} /></div>
                <div className="input-group"><label>GSM</label><input value={edit.gsm} onChange={e => setEdit({ ...edit, gsm: e.target.value })} /></div>
              </div>
              <div className="input-group"><label>Material</label><input value={edit.material} onChange={e => setEdit({ ...edit, material: e.target.value })} /></div>
              <div className="input-group"><label>Blurb</label><input value={edit.blurb} onChange={e => setEdit({ ...edit, blurb: e.target.value })} /></div>
              <div className="input-group"><label>From price (₹/pc)</label><input type="number" value={edit.from_price} onChange={e => setEdit({ ...edit, from_price: e.target.value })} /></div>
              <div className="input-group"><label>Features (comma separated)</label><input value={edit._features} onChange={e => setEdit({ ...edit, _features: e.target.value })} /></div>
              <div className="input-group"><label>Colors (comma separated)</label><input value={edit._colors} onChange={e => setEdit({ ...edit, _colors: e.target.value })} /></div>
              <div className="input-group"><label>MOQ tiers (one per line: <code>label = price</code>)</label><textarea rows={5} value={edit._tiers} onChange={e => setEdit({ ...edit, _tiers: e.target.value })} /></div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button className="btn btn-primary" onClick={save} disabled={saving || !edit.name}>{saving ? 'Saving…' : 'Save product'}</button>
                <button className="btn btn-secondary" onClick={() => setEdit(null)}>Cancel</button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
