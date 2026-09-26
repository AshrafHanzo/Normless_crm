import { useState, useRef, useEffect } from 'react'
import { useApi } from '../App'
import { useToast } from './Toast'
import Icon from './Icon'
import drawPickList from './pick-list-png'

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
  // Reads as a sentence in the menu and as a heading on the export, so it is capitalised once.
  const span = from && to ? (from === to ? from : `${from} — ${to}`) : 'All open orders'

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
    const canvas = drawPickList(data, span)
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
          <p className="export-menu-note">Unfulfilled orders only, grouped by edition, colour and size. {span}.</p>
          <button type="button" onClick={() => file('csv')}>CSV <span>opens in Excel</span></button>
          <button type="button" onClick={png}>PNG <span>to paste in a chat</span></button>
          <button type="button" onClick={() => file('pdf')}>PDF <span>to print and pin up</span></button>
        </div>
      )}
    </div>
  )
}
