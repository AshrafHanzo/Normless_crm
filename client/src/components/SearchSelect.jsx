import { useState, useRef, useEffect, useMemo, useCallback } from 'react'

/**
 * A picker you type into.
 *
 * A native `<select>` stops being usable somewhere around a hundred entries, and the catalogue only
 * grows. Unlike ComboInput — which is a datalist and deliberately accepts free text — this one
 * always resolves to an option's value, because the caller needs an id, not a string that merely
 * looks like a product name.
 *
 * Matching is on every word typed, in any order, so "red hamilton" finds "Hamilton Ferrari
 * Edition — Red / M".
 */
export default function SearchSelect({
  value, onChange, options = [], placeholder = 'Search…', disabled, emptyText = 'No matches', autoFocus,
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const boxRef = useRef(null)
  const inputRef = useRef(null)

  const selected = options.find(o => String(o.value) === String(value)) || null

  const matches = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const hit = (o) => {
      if (!words.length) return true
      const hay = `${o.label} ${o.hint || ''}`.toLowerCase()
      return words.every(w => hay.includes(w))
    }
    // Capped: a thousand rendered rows is slower than it is useful, and nobody scrolls past
    // fifty — they type another word instead.
    return options.filter(hit).slice(0, 50)
  }, [options, query])

  // The highlight resets wherever the query is set, rather than in an effect watching it — same
  // result, one render instead of two.
  const close = useCallback(() => { setOpen(false); setQuery(''); setActive(0) }, [])
  const pick = (o) => { onChange(o.value, o); close() }

  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) close() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
    }
  }, [open, close])

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) { setOpen(true); return }
      setActive(i => Math.max(0, Math.min(matches.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))))
    } else if (e.key === 'Enter') {
      if (open && matches[active]) { e.preventDefault(); pick(matches[active]) }
    } else if (e.key === 'Escape') {
      if (open) { e.preventDefault(); e.stopPropagation(); close() }
    }
  }

  return (
    <div className={`ss ${disabled ? 'ss-disabled' : ''}`} ref={boxRef}>
      <input
        ref={inputRef}
        className="ss-input"
        // Closed, the field reads as the current choice; open, it is a search box.
        value={open ? query : (selected?.label || '')}
        placeholder={selected ? selected.label : placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete="off"
        onChange={e => { setQuery(e.target.value); setActive(0); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {!!selected && !open && !disabled && (
        <button type="button" className="ss-clear" title="Clear"
          onClick={() => onChange('', null)}>×</button>
      )}
      {open && (
        <div className="ss-menu">
          {!matches.length ? <div className="ss-empty">{emptyText}</div> : matches.map((o, i) => (
            <button type="button" key={o.value}
              className={`ss-option ${i === active ? 'ss-option-active' : ''} ${String(o.value) === String(value) ? 'ss-option-selected' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(o)}>
              <span className="ss-option-label">{o.label}</span>
              {o.hint && <span className="ss-option-hint">{o.hint}</span>}
            </button>
          ))}
          {options.length > matches.length && (
            <div className="ss-empty">{options.length - matches.length} more — keep typing to narrow it down</div>
          )}
        </div>
      )}
    </div>
  )
}
