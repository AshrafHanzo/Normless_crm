import { useEffect, useRef, useState } from 'react'
import Icon from '../../components/Icon'

/**
 * Picking a lead status: the current one as a coloured chip, and a list of every status with its
 * colour, what it means, and (for the inbox filter) how many chats are at it. Arrow keys move,
 * Enter picks, Esc closes; typing a letter jumps to the status starting with it.
 *
 * statuses: [{ key, name, color, description }]. With `anyLabel`, an "any status" row comes first
 * and stands for ''.
 */
export default function WaStatusPicker({ statuses, value, onChange, counts, anyLabel, label = 'Lead status', className = '' }) {
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState(0)
  const box = useRef(null)
  const rows = [...(anyLabel ? [{ key: '', name: anyLabel, color: null }] : []), ...statuses]
  const current = rows.find(r => r.key === (value || '')) || { key: value, name: value || anyLabel || '—', color: null }
  const total = counts ? Object.values(counts).reduce((n, v) => n + v, 0) : null
  const countOf = (r) => (counts ? (r.key ? counts[r.key] || 0 : total) : null)

  useEffect(() => {
    if (!open) return
    setHover(Math.max(0, rows.findIndex(r => r.key === (value || ''))))
    const away = (e) => { if (!box.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const pick = (r) => { setOpen(false); if (r.key !== (value || '')) onChange(r.key) }
  const onKey = (e) => {
    if (!open && ['ArrowDown', 'Enter', ' '].includes(e.key)) { e.preventDefault(); setOpen(true); return }
    if (!open) return
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setHover(h => Math.min(rows.length - 1, h + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHover(h => Math.max(0, h - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); pick(rows[hover]) }
    else if (/^[a-z]$/i.test(e.key)) {
      const i = rows.findIndex(r => r.name.toLowerCase().startsWith(e.key.toLowerCase()))
      if (i >= 0) setHover(i)
    }
  }

  return (
    <div className={`wsp ${className}`} ref={box}>
      <button type="button" className={`wsp-trigger${open ? ' wsp-open' : ''}`} aria-haspopup="listbox" aria-expanded={open}
        aria-label={`${label}: ${current.name}`} onClick={() => setOpen(o => !o)} onKeyDown={onKey}>
        <span className="wsp-dot" style={{ background: current.color || 'var(--text-muted)' }} aria-hidden="true" />
        <span className="wsp-name">{current.name}</span>
        {counts && <span className="wsp-count">{countOf(current)}</span>}
        <Icon name="chevronDown" size={14} className="wsp-caret" />
      </button>
      {open && (
        <ul className="wsp-menu" role="listbox" aria-label={label}>
          {rows.map((r, i) => {
            const on = r.key === (value || '')
            return (
              <li key={r.key || 'any'} role="option" aria-selected={on}
                className={`wsp-row${i === hover ? ' wsp-hover' : ''}${on ? ' wsp-on' : ''}`}
                onMouseEnter={() => setHover(i)} onMouseDown={e => e.preventDefault()} onClick={() => pick(r)}>
                <span className="wsp-chip" style={r.color ? { '--c': r.color } : undefined}>
                  <span className="wsp-dot" style={{ background: r.color || 'var(--text-muted)' }} aria-hidden="true" />
                  {r.name}
                </span>
                {r.description && <small className="wsp-desc">{r.description}</small>}
                {counts && <span className="wsp-count">{countOf(r)}</span>}
                {on && <Icon name="check" size={14} className="wsp-check" />}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
