import { useRef, useState } from 'react'

const mb = (n) => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
const isImage = (f) => /^image\//.test(f.type)

/**
 * Choosing files, the way people actually do it.
 *
 * A bare file input is a grey button that says "No file chosen" — it gives no sign that a folder
 * can be dragged onto it, no idea of size before an upload fails, and no way to take one file back
 * out of a selection of eight. This is the same input underneath, with the drop target made
 * visible and the chosen files shown as something that can be removed.
 *
 * Images preview as a thumbnail from the local file, so a wrong picture is caught before it is
 * sent rather than after.
 *
 * `onFiles` always receives an array, whether or not `multiple` is set, so a caller never has to
 * care which it asked for.
 */
export default function FileDrop({
  files = [],
  onFiles,
  accept,
  multiple = false,
  disabled = false,
  busy = false,
  label,
  hint,
  icon = '📎',
}) {
  const inputRef = useRef(null)
  const [over, setOver] = useState(false)
  // Drag events fire for every child element; counting enter/leave keeps the highlight steady
  // instead of flickering as the pointer crosses the text inside the zone.
  const depth = useRef(0)

  const take = (list) => {
    const picked = [...(list || [])]
    if (!picked.length) return
    onFiles(multiple ? [...files, ...picked] : picked.slice(0, 1))
  }
  const drop = (e) => {
    e.preventDefault()
    depth.current = 0
    setOver(false)
    if (disabled || busy) return
    take(e.dataTransfer?.files)
  }
  const remove = (i) => onFiles(files.filter((_, n) => n !== i))

  return (
    <div className="filedrop">
      <div
        className={`filedrop-zone${over ? ' filedrop-over' : ''}${disabled || busy ? ' filedrop-off' : ''}`}
        onDragEnter={e => { e.preventDefault(); depth.current++; if (!disabled && !busy) setOver(true) }}
        onDragOver={e => e.preventDefault()}
        onDragLeave={() => { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setOver(false) }}
        onDrop={drop}
        onClick={() => !disabled && !busy && inputRef.current?.click()}
        role="button"
        tabIndex={disabled ? -1 : 0}
        onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && !disabled && !busy) { e.preventDefault(); inputRef.current?.click() } }}
      >
        <span className="filedrop-icon">{busy ? <span className="img-spinner" /> : icon}</span>
        <span className="filedrop-text">
          <b>{over ? 'Drop it here' : label || (multiple ? 'Drag files here, or click to choose' : 'Drag a file here, or click to choose')}</b>
          {hint && <span className="filedrop-hint">{hint}</span>}
        </span>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple={multiple}
          disabled={disabled || busy}
          hidden
          onChange={e => { take(e.target.files); e.target.value = '' }}
        />
      </div>

      {!!files.length && (
        <div className="filedrop-list">
          {files.map((f, i) => (
            <div className="filedrop-file" key={`${f.name}-${i}`}>
              {isImage(f)
                ? <img className="filedrop-thumb" src={URL.createObjectURL(f)} alt="" onLoad={e => URL.revokeObjectURL(e.target.src)} />
                : <span className="filedrop-thumb filedrop-thumb-doc">📄</span>}
              <span className="filedrop-name" title={f.name}>{f.name}</span>
              <span className="filedrop-size">{mb(f.size)}</span>
              <button type="button" className="filedrop-x" title="Take this one out"
                onClick={e => { e.stopPropagation(); remove(i) }} disabled={busy}>×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
