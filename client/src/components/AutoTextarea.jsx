import { useEffect, useRef } from 'react'

/**
 * Textarea that grows to fit what's in it, instead of trapping a long note behind a two-line
 * scroll box. Falls back to scrolling once it reaches `maxRows` so a very long note can't push
 * the save button off the screen.
 *
 * Height is measured rather than derived from the character count: wrapping depends on the
 * field's actual width, which varies with the drawer, the column layout and the viewport.
 */
export default function AutoTextarea({ value, minRows = 3, maxRows = 16, style, ...props }) {
  const ref = useRef(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const cs = getComputedStyle(el)
    const lineHeight = parseFloat(cs.lineHeight) || 20
    const chrome = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
      + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)
    const max = lineHeight * maxRows + chrome

    // Collapse first: scrollHeight only shrinks back if the element isn't already holding the
    // taller height from the previous value.
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, max)}px`
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'
  }, [value, maxRows])

  return <textarea ref={ref} value={value} rows={minRows} style={{ resize: 'none', ...style }} {...props} />
}
