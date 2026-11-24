import { useState, useRef, useEffect, useMemo, useCallback } from 'react'

/**
 * SearchSelect for several choices: type to narrow the list, tick as many as you like (the list
 * stays open), and the picks show as chips under the box, each with its own ×.
 * `value` is an array of option values; `onChange` gets the new array.
 */
export default function MultiSearchSelect({ value = [], onChange, options = [], placeholder = 'Search…', emptyText = 'No matches', id }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const boxRef = useRef(null)
  const chosen = useMemo(() => new Set(value.map(String)), [value])

  const { matches, hidden } = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const all = options.filter(o => !words.length || words.every(w => `${o.label} ${o.hint || ''}`.toLowerCase().includes(w)))
    return { matches: all.slice(0, 50), hidden: Math.max(0, all.length - 50) }
  }, [options, query])

  const close = useCallback(() => { setOpen(false); setQuery(''); setActive(0) }, [])
  const flip = (o) => onChange(chosen.has(String(o.value)) ? value.filter(v => String(v) !== String(o.value)) : [...value, o.value])

  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) close() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('touchstart', onDown) }
  }, [open, close])

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) { setOpen(true); return }
      setActive(i => Math.max(0, Math.min(matches.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))))
    } else if (e.key === 'Enter') {
      if (open && matches[active]) { e.preventDefault(); flip(matches[active]) }
    } else if (e.key === 'Escape') {
      if (open) { e.preventDefault(); e.stopPropagation(); close() }
    } else if (e.key === 'Backspace' && !query && value.length) {
      onChange(value.slice(0, -1))
    }
  }

  const labelOf = (v) => options.find(o => String(o.value) === String(v))?.label || v
  return (
    <div className="mss" ref={boxRef}>
      {/* The menu hangs off the box itself, so chips appearing below don't move it mid-pick. */}
      <div className="ss">
      <input id={id} className="ss-input" value={query} autoComplete="off"
        placeholder={value.length ? `${value.length} chosen — add more…` : placeholder}
        onChange={e => { setQuery(e.target.value); setActive(0); setOpen(true) }}
        onFocus={() => setOpen(true)} onKeyDown={onKeyDown} />
      {open && (
        <div className="ss-menu">
          {!matches.length ? <div className="ss-empty">{emptyText}</div> : matches.map((o, i) => (
            <button type="button" key={o.value} role="option" aria-selected={chosen.has(String(o.value))}
              className={`ss-option mss-option ${i === active ? 'ss-option-active' : ''}`}
              onMouseEnter={() => setActive(i)} onClick={() => flip(o)}>
              <input type="checkbox" readOnly tabIndex={-1} checked={chosen.has(String(o.value))} />
              <span className="ss-option-label">{o.label}</span>
            </button>
          ))}
          {hidden > 0 && <div className="ss-empty">{hidden} more — keep typing to narrow it down</div>}
        </div>
      )}
      </div>
      {!!value.length && (
        <div className="mss-chips">
          {value.map(v => (
            <span key={v} className="mss-chip">
              <span>{labelOf(v)}</span>
              <button type="button" aria-label={`Remove ${labelOf(v)}`} onClick={() => onChange(value.filter(x => x !== v))}>×</button>
            </span>
          ))}
          {value.length > 1 && <button type="button" className="mss-clear" onClick={() => onChange([])}>Clear all</button>}
        </div>
      )}
    </div>
  )
}
