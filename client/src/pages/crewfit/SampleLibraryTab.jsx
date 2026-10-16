import { useState, useEffect, useMemo } from 'react'
import { useApi, useAuth } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'

const SOURCES = ['Production', 'Mock', 'Uploaded']
const day = (v) => (v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '')

/**
 * Every photograph we hold of our own work.
 *
 * The pictures already exist — four hundred-odd of them, shot by the people who packed the orders
 * — so this reads them where they lie rather than making a second copy to drift out of date. Each
 * tile says which order and which customer it came from, because a production photo is somebody
 * else's branded shirt and that is the thing to check before sending it on.
 *
 * Downloading is a zip, at a size chosen at the point of use: the original for a printer, a
 * web-size copy for WhatsApp, which will not take six hundred megabytes of phone photographs.
 */
export default function SampleLibraryTab() {
  const apiFetch = useApi()
  const toast = useToast()
  const { user, API_URL } = useAuth()
  const isAdmin = ['owner', 'admin'].includes(user?.role)
  const canUpload = isAdmin || !!user?.can_upload_crewfit_samples

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [term, setTerm] = useState('')
  const [product, setProduct] = useState('')
  const [source, setSource] = useState('')
  const [picked, setPicked] = useState(() => new Set())
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState(null)      // { product, title, files }
  const [viewing, setViewing] = useState(null)

  useEffect(() => {
    const t = setTimeout(() => setTerm(search), 300)
    return () => clearTimeout(t)
  }, [search])

  const load = async () => {
    setLoading(true)
    const q = new URLSearchParams({ ...(term && { search: term }), ...(product && { product }), ...(source && { source }) })
    const r = await apiFetch(`/api/crewfit/catalog/samples?${q}`)
    if (r && !r.error) setData(r)
    else if (r?.error) toast.error(r.error)
    setLoading(false)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [term, product, source])

  const images = data?.images || []
  const thumb = (url) => `${API_URL}/api/thumb?src=${encodeURIComponent(url)}&w=220`
  const full = (url) => `${API_URL}${url}`

  const toggle = (img) => setPicked(prev => {
    const next = new Set(prev)
    if (next.has(img.url)) next.delete(img.url); else next.add(img.url)
    return next
  })
  const pickAllShown = () => setPicked(new Set(images.map(i => i.url)))
  const clearPicked = () => setPicked(new Set())

  // What the download button is about to send, named after whatever narrowed the list.
  const label = useMemo(() => product || term || 'crewfit-samples', [product, term])

  const downloadZip = async (size) => {
    const urls = picked.size ? [...picked] : images.map(i => i.url)
    if (!urls.length) { toast.error('Nothing to download'); return }
    setBusy(true)
    const res = await apiFetch('/api/crewfit/catalog/samples/zip', {
      method: 'POST', responseType: 'blob', body: JSON.stringify({ urls, size, name: label }),
    })
    setBusy(false)
    if (!res || res.error) { toast.error(res?.error || 'Could not build that download'); return }
    const url = URL.createObjectURL(res.blob)
    const a = document.createElement('a')
    a.href = url; a.download = res.filename || 'samples.zip'
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
    toast.success(`${urls.length} image${urls.length === 1 ? '' : 's'} downloaded`)
  }

  // nginx caps a request at 55MB, and phone photographs are three or four megabytes each — so a
  // batch is checked here, where it can be said plainly, rather than coming back as a wall of
  // HTML from a server that rejected it.
  const BATCH_LIMIT_MB = 45

  const upload = async () => {
    if (!form?.files?.length) { toast.error('Choose the images'); return }
    if (!form.product?.trim()) { toast.error('Name the product these are of'); return }
    const totalMb = form.files.reduce((n, f) => n + f.size, 0) / (1024 * 1024)
    if (totalMb > BATCH_LIMIT_MB) {
      toast.error(`That is ${totalMb.toFixed(0)}MB in one go — send them in batches under ${BATCH_LIMIT_MB}MB`)
      return
    }
    const body = new FormData()
    for (const f of form.files) body.append('images', f)
    body.append('product', form.product.trim())
    if (form.title) body.append('title', form.title)
    setBusy(true)
    const res = await apiFetch('/api/crewfit/catalog/samples', { method: 'POST', body })
    setBusy(false)
    if (!res || res.error) { toast.error(res?.error || 'Could not add those samples'); return }
    toast.success(`${res.added} sample${res.added === 1 ? '' : 's'} added under ${form.product.trim()}`)
    setForm(null); load()
  }

  const removeSample = async (img) => {
    if (!await toast.confirm({
      title: 'Remove this sample?', message: 'The file goes with it.',
      confirmLabel: 'Remove', cancelLabel: 'Keep it', danger: true,
    })) return
    const r = await apiFetch(`/api/crewfit/catalog/samples/${img.sample_id}`, { method: 'DELETE' })
    if (!r || r.error) { toast.error(r?.error || 'Could not remove it'); return }
    setViewing(null); load()
  }

  const chosen = picked.size || images.length

  return (
    <div className="samples-tab">
      <div className="filters-row">
        <div className="search-bar">
          <span className="search-icon" />
          <input placeholder="Search a product, a customer, an order number or a colour…"
            value={search} onChange={e => setSearch(e.target.value)} />
          {!!search && <button type="button" className="search-clear" title="Clear the search" onClick={() => setSearch('')}>×</button>}
        </div>
        <select value={source} style={{ width: 'auto' }} onChange={e => setSource(e.target.value)}>
          <option value="">Every kind</option>
          {SOURCES.map(s => <option key={s} value={s}>{s === 'Mock' ? 'Design mocks' : s === 'Production' ? 'Production photos' : 'Uploaded samples'}</option>)}
        </select>
        {canUpload && (
          <button className="btn btn-secondary" onClick={() => setForm({ product: product || '' })}>
            <Icon name="plus" size={15} /> Add samples
          </button>
        )}
      </div>

      {/* The products we actually hold pictures of, with how many — the question is almost always
          "do we have polo pictures", and this answers it before anything is typed. */}
      <div className="chip-picker samples-products">
        <button type="button" className={`chip${!product ? ' chip-on' : ''}`} onClick={() => setProduct('')}>
          All products <b>{data?.total ?? 0}</b>
        </button>
        {(data?.products || []).map(p => (
          <button type="button" key={p.name} className={`chip${product === p.name ? ' chip-on' : ''}`}
            onClick={() => setProduct(product === p.name ? '' : p.name)}>
            {p.name} <b>{p.count}</b>
          </button>
        ))}
      </div>

      <div className="samples-bar">
        <span>
          {loading ? 'Looking…' : `${images.length} image${images.length === 1 ? '' : 's'}`}
          {picked.size > 0 && <> · <b>{picked.size} selected</b></>}
        </span>
        <span className="samples-bar-actions">
          {!!images.length && (picked.size
            ? <button type="button" className="mini-btn" onClick={clearPicked}>Clear selection</button>
            : <button type="button" className="mini-btn" onClick={pickAllShown}>Select all shown</button>)}
          {/* Two buttons rather than a menu: which one you want is decided by where the pictures
              are going, and it is a different answer every time. */}
          <button type="button" className="mini-btn" disabled={busy || !images.length} onClick={() => downloadZip('web')}>
            {busy ? 'Zipping…' : `⬇ Web-size zip (${chosen})`}
          </button>
          <button type="button" className="mini-btn" disabled={busy || !images.length} onClick={() => downloadZip('original')}>
            ⬇ Originals ({chosen})
          </button>
        </span>
      </div>

      {form && (
        <div className="catalog-upload">
          <div className="form-row">
            <div className="input-group">
              <label>Product *</label>
              <input list="samples-products" value={form.product || ''} placeholder="Poly Cotton Polos"
                onChange={e => setForm(f => ({ ...f, product: e.target.value }))} />
              <datalist id="samples-products">
                {(data?.products || []).map(p => <option key={p.name} value={p.name} />)}
              </datalist>
            </div>
            <div className="input-group">
              <label>Note <span className="label-hint">optional</span></label>
              <input value={form.title || ''} placeholder="Navy, chest embroidery"
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
            </div>
          </div>
          <div className="input-group">
            <label>Images *</label>
            <input type="file" accept="image/png,image/jpeg,image/webp" multiple
              onChange={e => setForm(f => ({ ...f, files: [...(e.target.files || [])] }))} />
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button className="btn btn-secondary" onClick={() => setForm(null)}>Cancel</button>
            <button className="btn btn-primary" disabled={busy || !form.files?.length} onClick={upload}>
              {busy ? 'Uploading…' : `Add ${form.files?.length || 0} image${form.files?.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}

      {loading ? <div className="loader"><div className="spinner" /></div> : !images.length ? (
        <div className="empty-state">
          <div className="empty-icon">🖼</div>
          <h3>Nothing matches that</h3>
          <p>Every production photo and design mock from past orders is here, alongside anything uploaded.</p>
        </div>
      ) : (
        <div className="samples-grid">
          {images.map(img => (
            <div key={img.id} className={`sample-tile${picked.has(img.url) ? ' sample-tile-on' : ''}`}>
              <button type="button" className="sample-shot" onClick={() => setViewing(img)} title="Open">
                <img src={thumb(img.url)} alt={img.product || 'Sample'} loading="lazy" />
              </button>
              <button type="button" className="sample-pick" aria-pressed={picked.has(img.url)}
                onClick={() => toggle(img)} title={picked.has(img.url) ? 'Deselect' : 'Select'}>
                {picked.has(img.url) ? '✓' : ''}
              </button>
              <div className="sample-meta">
                <b>{img.product || 'Not named'}</b>
                {/* Whose shirt this is. The thing to know before sending it to somebody else. */}
                <span>{img.source === 'Uploaded'
                  ? (img.title || 'Uploaded sample')
                  : `CF-${img.order_no}${img.customer_name ? ` · ${img.customer_name}` : ''}`}</span>
                <span className="sample-date">{img.source} · {day(img.taken_on)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {viewing && (
        <div className="image-modal-overlay" onClick={() => setViewing(null)}>
          <div className="image-modal-content" onClick={e => e.stopPropagation()}>
            <button className="image-modal-close" onClick={() => setViewing(null)}>✕</button>
            <div className="image-modal-toolbar">
              <a className="image-modal-action" href={full(viewing.url)} target="_blank" rel="noreferrer">⬇ Open full size</a>
              {viewing.source !== 'Uploaded' && (
                <a className="image-modal-action" href={`/crewfit/orders?focus=${viewing.order_id}`}>↗ Its order</a>
              )}
              {viewing.sample_id && canUpload && user?.role === 'owner' && (
                <button className="image-modal-action image-modal-action-danger" onClick={() => removeSample(viewing)}>🗑 Remove</button>
              )}
            </div>
            <img src={full(viewing.url)} alt={viewing.product || 'Sample'} className="full-image" />
            <div className="modal-carousel-counter">
              {viewing.product || 'Not named'}
              {viewing.source !== 'Uploaded' ? ` · CF-${viewing.order_no}${viewing.customer_name ? ` · ${viewing.customer_name}` : ''}` : ''}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
