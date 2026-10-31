import { useEffect, useMemo, useState } from 'react'
import Icon from '../../components/Icon'

/**
 * Photos of our work for a customer: pick the product, narrow to colours, tick up to 30 photos.
 * The suggested set — one colour after another, newest first — comes ticked. Each photo goes as
 * its own WhatsApp image with the product and colour as its caption.
 */
export default function WaSamplesPicker({ API, apiFetch, toast, fileUrl, conversationId, onClose, onSent }) {
  const [data, setData] = useState(null)
  const [product, setProduct] = useState('')
  const [colors, setColors] = useState(new Set())
  const [picked, setPicked] = useState(new Set())
  const [sending, setSending] = useState(false)

  useEffect(() => {
    const q = product ? `?product=${encodeURIComponent(product)}` : ''
    apiFetch(`${API}/conversations/${conversationId}/samples${q}`).then(r => {
      if (!r || r.error) { toast.error(r?.error || 'Could not load the photos'); return }
      setData(r)
      if (!product) setProduct(r.product)
      setColors(new Set())
      setPicked(new Set(r.suggested))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product])

  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [onClose])

  const shown = useMemo(() => (data?.photos || []).filter(p => !colors.size || colors.has(p.color || 'Other')), [data, colors])
  const max = data?.max || 30
  const toggle = (url) => setPicked(s => {
    const n = new Set(s)
    if (n.has(url)) n.delete(url)
    else if (n.size < max) n.add(url)
    else toast.error(`Up to ${max} photos at a time`)
    return n
  })
  const toggleColor = (c) => setColors(s => { const n = new Set(s); if (n.has(c)) n.delete(c); else n.add(c); return n })
  // Narrowing to colours ticks what's shown, up to the limit.
  const pickShown = () => setPicked(new Set(shown.slice(0, max).map(p => p.url)))

  const send = async () => {
    setSending(true)
    const r = await apiFetch(`${API}/conversations/${conversationId}/samples/send`, { method: 'POST', body: JSON.stringify({ urls: [...picked] }) })
    setSending(false)
    if (!r || r.error) return toast.error(r?.error || 'Could not send the photos')
    toast.success(`Sent ${r.messages.length} photo${r.messages.length === 1 ? '' : 's'}`)
    onSent(r.messages)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="wsm" role="dialog" aria-modal="true" aria-label="Send sample photos" onClick={e => e.stopPropagation()}>
        <header className="wsm-head">
          <div>
            <h3>Send photos of our work</h3>
            <span className="was-hint">Production photos from orders and the Samples library. Up to {max} at a time.</span>
          </div>
          <button type="button" className="btn-icon" aria-label="Close" onClick={onClose}><Icon name="close" size={15} /></button>
        </header>
        {!data ? <div className="loader"><div className="spinner" /></div> : (
          <>
            <div className="wsm-filters">
              <label className="input-group wsm-product">
                <span>Product</span>
                <select value={product} onChange={e => setProduct(e.target.value)}>
                  {data.products.map(p => <option key={p.name} value={p.name}>{p.name} ({p.count})</option>)}
                </select>
              </label>
              <div className="wsm-colors" role="group" aria-label="Colours">
                {data.colors.map(c => (
                  <button key={c.color} type="button" className={`chip${colors.has(c.color) ? ' chip-on' : ''}`} onClick={() => toggleColor(c.color)}>
                    {c.color} <span className="wa-q-count">{c.count}</span>
                  </button>
                ))}
                {colors.size > 0 && <button type="button" className="mini-btn" onClick={pickShown}>Tick these</button>}
              </div>
            </div>
            {!shown.length ? <p className="wa-empty">No photos of {product} yet — add some in Catalog › Samples.</p> : (
              <ul className="wsm-grid">
                {shown.map(p => {
                  const on = picked.has(p.url)
                  return (
                    <li key={p.url}>
                      <button type="button" className={`wsm-shot${on ? ' wsm-on' : ''}`} aria-pressed={on} onClick={() => toggle(p.url)}
                        title={[p.color, p.order_no ? `from CF-${p.order_no}` : p.source].filter(Boolean).join(' · ')}>
                        <img src={fileUrl(p.url)} alt={`${p.product} ${p.color || ''}`} loading="lazy" />
                        <span className="wsm-tick" aria-hidden="true">{on ? <Icon name="check" size={13} /> : null}</span>
                        {p.color && <span className="wsm-color">{p.color}</span>}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
            <footer className="wsm-foot">
              <span>{picked.size} of {max} picked</span>
              <button type="button" className="mini-btn" disabled={!picked.size} onClick={() => setPicked(new Set())}>Clear</button>
              <button type="button" className="btn btn-primary btn-sm" disabled={!picked.size || sending} onClick={send}>
                {sending ? 'Sending…' : `Send ${picked.size} photo${picked.size === 1 ? '' : 's'}`}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  )
}
