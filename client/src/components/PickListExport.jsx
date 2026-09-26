import { useState, useRef, useEffect } from 'react'
import { useApi } from '../App'
import { useToast } from './Toast'
import Icon from './Icon'

/**
 * Draw the pick list as an image.
 *
 * Rendered onto a canvas here rather than fetched from the server because the whole reason anyone
 * wants a PNG is to paste it into WhatsApp, and this way it needs no image library on the server
 * and no screenshot of a browser. The layout is the PDF's, at twice the scale so it stays sharp
 * when someone pinches into it on a phone.
 */
function drawPng(data, title) {
  const S = 2                       // draw at 2×, present at 1× — crisp on any screen
  const W = 900
  const PAD = 28
  const LINE = 26
  const rows = data.rows || []

  // Height first: a heading per product type, a design heading and a column row per design.
  let lines = 3
  let type = null, edition = null
  for (const r of rows) {
    if (r.type !== type) { lines += 2; type = r.type; edition = null }
    if (r.edition !== edition) { lines += 2; edition = r.edition }
    lines += 1
  }
  const H = PAD * 2 + 76 + lines * LINE

  // Drawn onto a canvas tall enough for the worst case, then cropped to what was actually used —
  // the height guess above runs a little long, and an image with a foot of white under it looks
  // like something failed to load.
  const canvas = document.createElement('canvas')
  canvas.width = W * S
  canvas.height = H * S
  const c = canvas.getContext('2d')
  c.scale(S, S)
  c.fillStyle = '#ffffff'
  c.fillRect(0, 0, W, H)

  const text = (s, x, y, { size = 13, weight = '400', color = '#111', align = 'left' } = {}) => {
    c.font = `${weight} ${size}px -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif`
    c.fillStyle = color
    c.textAlign = align
    c.fillText(String(s), x, y)
    c.textAlign = 'left'
  }

  let y = PAD + 22
  text(title, PAD, y, { size: 22, weight: '700' })
  y += 22
  text(`${data.summary.units} units · ${data.summary.lines} lines · ${data.summary.orders} orders`, PAD, y, { size: 12.5, color: '#666' })
  y += 18
  text('Unfulfilled orders only — held, cancelled and refunded orders are left out.', PAD, y, { size: 11, color: '#999' })
  y += 16
  c.strokeStyle = '#e2e2e2'; c.beginPath(); c.moveTo(PAD, y); c.lineTo(W - PAD, y); c.stroke()
  y += 26

  const COL = { colour: PAD + 16, size: 330, qty: 430, orders: 470 }
  type = null; edition = null
  for (const r of rows) {
    if (r.type !== type) {
      type = r.type; edition = null
      y += 8
      text(r.type, PAD, y, { size: 16, weight: '700' })
      y += LINE
    }
    if (r.edition !== edition) {
      edition = r.edition
      text(r.edition, PAD + 8, y, { size: 13, weight: '700', color: '#333' })
      y += 20
      text('COLOUR', COL.colour, y, { size: 10, color: '#999' })
      text('SIZE', COL.size, y, { size: 10, color: '#999' })
      text('QTY', COL.qty, y, { size: 10, color: '#999', align: 'right' })
      text('ORDERS', COL.orders, y, { size: 10, color: '#999' })
      y += 18
    }
    text(r.color, COL.colour, y, { size: 13 })
    text(r.size, COL.size, y, { size: 13 })
    text(r.qty, COL.qty, y, { size: 13, weight: '700', align: 'right' })
    text(r.orders.join(' '), COL.orders, y, { size: 10.5, color: '#777' })
    y += LINE
  }

  if (!rows.length) { text('Nothing waiting to go out in this period.', PAD, y, { size: 13, color: '#666' }); y += LINE }

  const used = Math.min(y + PAD - 8, H)
  const out = document.createElement('canvas')
  out.width = W * S
  out.height = used * S
  const oc = out.getContext('2d')
  oc.fillStyle = '#ffffff'
  oc.fillRect(0, 0, out.width, out.height)
  oc.drawImage(canvas, 0, 0)
  return out
}

/**
 * Export what is ordered and not yet sent, as a spreadsheet, a picture or a printable page.
 *
 * Three formats because the list is used three ways: opened in Excel, pasted into a chat, and
 * pinned up beside the press.
 */
export default function PickListExport({ from, to }) {
  const apiFetch = useApi()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState('')
  const boxRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const params = new URLSearchParams({ ...(from && { from }), ...(to && { to }) }).toString()
  const span = from && to ? (from === to ? from : `${from} to ${to}`) : 'all open orders'

  const save = (href, name, revoke) => {
    const a = document.createElement('a')
    a.href = href; a.download = name
    document.body.appendChild(a); a.click(); a.remove()
    if (revoke) URL.revokeObjectURL(href)
  }

  const file = async (kind) => {
    setBusy(kind); setOpen(false)
    const r = await apiFetch(`/api/orders/pick-list.${kind}${params ? `?${params}` : ''}`, { responseType: 'blob' })
    setBusy('')
    if (!r || r.error) { toast.error(r?.error || 'Export failed'); return }
    save(URL.createObjectURL(r.blob), r.filename || `pick-list.${kind}`, true)
    toast.success(`Pick list exported as ${kind.toUpperCase()}`)
  }

  const png = async () => {
    setBusy('png'); setOpen(false)
    const data = await apiFetch(`/api/orders/pick-list${params ? `?${params}` : ''}`)
    if (!data || data.error) { setBusy(''); toast.error(data?.error || 'Export failed'); return }
    const canvas = drawPng(data, `Pick list — ${span}`)
    canvas.toBlob(blob => {
      setBusy('')
      if (!blob) { toast.error('Could not draw the image'); return }
      save(URL.createObjectURL(blob), `Pick list — ${span}.png`, true)
      toast.success(`Pick list exported as PNG · ${data.summary.units} units`)
    }, 'image/png')
  }

  return (
    <div className="export-menu" ref={boxRef}>
      <button type="button" className="btn btn-primary" onClick={() => setOpen(o => !o)} disabled={!!busy} aria-expanded={open}>
        <Icon name="download" size={15} style={{ marginRight: 6, verticalAlign: '-2px' }} />
        {busy ? `Exporting ${busy.toUpperCase()}…` : 'Export pick list'}
      </button>
      {open && (
        <div className="export-menu-panel" role="menu">
          <p className="export-menu-note">Unfulfilled orders only, grouped by edition, colour and size. {span === 'all open orders' ? 'All open orders.' : span}</p>
          <button type="button" onClick={() => file('csv')}>CSV <span>opens in Excel</span></button>
          <button type="button" onClick={png}>PNG <span>to paste in a chat</span></button>
          <button type="button" onClick={() => file('pdf')}>PDF <span>to print and pin up</span></button>
        </div>
      )}
    </div>
  )
}
