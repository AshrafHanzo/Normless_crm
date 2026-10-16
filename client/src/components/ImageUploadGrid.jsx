import { useState, useRef } from 'react'

/**
 * A tile grid of pictures, with an add tile on the end.
 *
 * Shared by anything that collects images against a record: a Crewfit order's design mocks, a
 * support ticket's proof photographs. Uploads are available before the record exists — a new one
 * queues its picks as "pending" (dashed amber outline) and they are pushed to the server the
 * moment it has an id. Clicking a thumbnail hands off to the caller's lightbox rather than opening
 * a new tab, so the picture stays inside the thing being worked on.
 */
function ImageUploadGrid({ icon, label, thumbs, max = 5, busy, onUpload, onView, onDownloadAll, downloadBusy, accept = 'image/png,image/jpeg,image/webp' }) {
  const uploadedCount = thumbs.filter(t => !t.pending).length
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  // Dragging a photo onto the tiles is the obvious thing to try, and it used to open the file in
  // the browser instead — losing whatever was half-filled in behind it.
  const drop = (e) => {
    e.preventDefault()
    depth.current = 0
    setOver(false)
    if (busy || !onUpload) return
    const files = [...(e.dataTransfer?.files || [])]
    if (files.length) onUpload(files)
  }
  return (
    <div className={`img-upload-block${over ? ' img-upload-over' : ''}`}
      onDragEnter={e => { e.preventDefault(); depth.current++; if (onUpload && !busy) setOver(true) }}
      onDragOver={e => { if (onUpload) e.preventDefault() }}
      onDragLeave={() => { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setOver(false) }}
      onDrop={drop}>
      <div className="img-upload-head">
        <span className="img-upload-label">{icon} {label}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Only offered when the caller can actually do it — a button that does nothing is worse
              than no button. */}
          {uploadedCount > 1 && onDownloadAll && (
            <button type="button" className="mini-btn" onClick={onDownloadAll} disabled={downloadBusy}>{downloadBusy ? 'Downloading…' : '⬇ Download all'}</button>
          )}
          <span className="img-count-badge">{thumbs.length}/{max}</span>
        </span>
      </div>
      <div className="img-thumb-grid">
        {thumbs.map((t, i) => (
          <div className={`img-thumb ${t.pending ? 'img-thumb-pending' : ''}`} key={t.pending ? t.src : t.ref} onClick={() => onView(i)} title={t.pending ? 'Pending upload — click to view' : 'Click to view'}>
            {/^.+\.(pdf|ai|eps|cdr|zip)$/i.test(typeof t.ref === 'string' ? t.ref : t.ref?.file?.name || '')
              ? <span className="img-thumb-doc">📄</span>
              : <img src={t.src} alt={label} />}
            {t.pending && <span className="img-pending-badge" title="Will upload once the order is saved" />}
          </div>
        ))}
        {thumbs.length < max && (
          <label className={`img-thumb img-thumb-add ${busy ? 'img-thumb-busy' : ''}`}>
            {busy ? <span className="img-spinner" /> : <span className="img-thumb-add-icon">+</span>}
            <input type="file" accept={accept} multiple hidden disabled={busy}
              onChange={e => { onUpload(e.target.files); e.target.value = '' }} />
          </label>
        )}
      </div>
    </div>
  )
}

export default ImageUploadGrid
