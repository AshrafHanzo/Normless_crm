import { useEffect, useState } from 'react'
import Icon from '../../components/Icon'
import { PdfViewer } from '../../components/PdfPreview'
import { mediaKind as kindOf } from './waMedia'

/**
 * Every file in a chat, looked at in place: photos (fit to the window, click to see full size),
 * PDFs drawn page by page, videos and voice notes played here. Design files the browser cannot draw
 * (.cdr, .ai, .psd…) get a card with their name and a download. The arrows (and ← →) step through
 * the chat's other files; Esc closes.
 *
 * items: [{ url, name, mime, when }], index: the one to start on.
 */

const extOf = (item) => (String(item?.name || item?.url || '').split('?')[0].split('.').pop() || 'file').slice(0, 5).toUpperCase()

export default function WaMediaViewer({ items, index = 0, onClose, onDownload }) {
  const [at, setAt] = useState(index)
  const [full, setFull] = useState(false)
  const item = items[at]
  const kind = kindOf(item)
  const many = items.length > 1
  const go = (step) => { setFull(false); setAt(i => (i + step + items.length) % items.length) }

  useEffect(() => {
    const key = (e) => {
      if (e.key === 'Escape') onClose()
      else if (many && e.key === 'ArrowRight') go(1)
      else if (many && e.key === 'ArrowLeft') go(-1)
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [many, items.length])

  if (!item) return null
  return (
    <div className="wmv-backdrop" role="dialog" aria-modal="true" aria-label={item.name || 'File'} onClick={onClose}>
      <div className="wmv" onClick={e => e.stopPropagation()}>
        <header className="wmv-head">
          <div className="wmv-title">
            <b>{item.name || (kind === 'image' ? 'Photo' : 'File')}</b>
            <small>{[many && `${at + 1} of ${items.length}`, item.when].filter(Boolean).join(' · ')}</small>
          </div>
          <div className="wmv-actions">
            <a className="btn-icon" href={item.url} target="_blank" rel="noreferrer" aria-label="Open in a new tab" title="Open in a new tab"><Icon name="external" size={15} /></a>
            <button type="button" className="btn-icon" aria-label="Download" title="Download" onClick={() => onDownload(item)}><Icon name="download" size={15} /></button>
            <button type="button" className="btn-icon" aria-label="Close" title="Close (Esc)" onClick={onClose}><Icon name="close" size={15} /></button>
          </div>
        </header>

        <div className={`wmv-stage wmv-${kind}${full ? ' wmv-full' : ''}`}>
          {kind === 'image' && (
            <img src={item.url} alt={item.name || 'Photo'} onClick={() => setFull(f => !f)} title={full ? 'Fit to the window' : 'See full size'} />
          )}
          {kind === 'pdf' && <div className="wmv-pdf"><PdfViewer url={item.url} /></div>}
          {kind === 'video' && <video src={item.url} controls autoPlay playsInline />}
          {kind === 'audio' && <audio src={item.url} controls autoPlay />}
          {kind === 'file' && (
            <div className="wmv-card">
              <span className="wa-doc-icon">{extOf(item)}</span>
              <b>{item.name || 'File'}</b>
              <p>This kind of file can’t be shown in the browser — download it and open it in its own app.</p>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => onDownload(item)}><Icon name="download" size={14} /> Download</button>
            </div>
          )}
          {many && (
            <>
              <button type="button" className="wmv-nav wmv-prev" aria-label="Previous file" onClick={() => go(-1)}><Icon name="chevronLeft" size={20} /></button>
              <button type="button" className="wmv-nav wmv-next" aria-label="Next file" onClick={() => go(1)}><Icon name="chevronRight" size={20} /></button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

