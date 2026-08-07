import { useCallback, useEffect, useMemo, useRef } from 'react'

/**
 * Canonical form of a value for comparison purposes.
 *
 * Two normalisations matter, and both come from how forms actually behave rather than from
 * tidiness:
 *
 *  - Empty is empty. A blank template often omits an optional key entirely, while typing into
 *    that field and clearing it again leaves `''` behind. Undefined, null and '' therefore all
 *    collapse to "absent", so clearing a field you typed into returns the form to clean.
 *  - Numbers compare as text. The API hands back numerics while inputs always produce strings,
 *    so retyping the value that was already there would otherwise read as a change.
 */
function normalise(value) {
  if (value === null || value === undefined || value === '') return undefined
  if (Array.isArray(value)) return value.map(v => { const n = normalise(v); return n === undefined ? null : n })
  if (typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value).sort()) {
      const v = normalise(value[k])
      if (v !== undefined) out[k] = v
    }
    return out
  }
  return typeof value === 'number' ? String(value) : value
}

const stableStringify = (value) => JSON.stringify(normalise(value) ?? null)

/**
 * Stops a form with genuinely unsaved edits from being thrown away by a stray click.
 *
 * Dirtiness is a comparison, not a touch flag: the form's current values are diffed against the
 * values it was last known to be saved at. Typing into a field and putting it back, or a change
 * that has already been persisted by its own API call, therefore leave the form clean and close
 * without a prompt.
 *
 * `snapshot` should project only what actually gets saved — leave out anything derived, anything
 * the server owns, and anything unserialisable (File objects, blob URLs). `identity` is what
 * changes when a *different* record is loaded; the baseline is re-captured whenever it changes,
 * which is what makes opening a second record start clean.
 *
 *   const guard = useDirtyGuard({
 *     snapshot: form && { ...form },
 *     identity: form ? (form.id ?? 'new') : null,
 *     onDiscard: closeDrawer,
 *     confirm: toast.confirm,
 *   })
 *
 * Call `reset()` at any other point the form becomes the saved truth — after a save, or after
 * merging a server response back in.
 */
export default function useDirtyGuard({
  snapshot,
  identity,
  onDiscard,
  confirm,
  title = 'Discard your changes?',
  message = 'This form has unsaved edits. Closing now will lose them.',
  confirmLabel = 'Discard changes',
  cancelLabel = 'Keep editing',
} = {}) {
  const current = useMemo(() => (snapshot == null ? null : stableStringify(snapshot)), [snapshot])

  // Read inside callbacks/effects that must not re-subscribe on every keystroke.
  const currentRef = useRef(current)
  currentRef.current = current

  // null means "no baseline yet", which reads as clean — never as "everything changed".
  const baseline = useRef(null)
  useEffect(() => { baseline.current = currentRef.current }, [identity])

  const dirty = current != null && baseline.current != null && current !== baseline.current

  const reset = useCallback(() => { baseline.current = currentRef.current }, [])

  // Guards against a second prompt when an impatient click lands on the overlay twice.
  const asking = useRef(false)

  const requestClose = useCallback(async () => {
    if (dirty && confirm) {
      if (asking.current) return false
      asking.current = true
      let ok
      try {
        ok = await confirm({ title, message, confirmLabel, cancelLabel, danger: true })
      } finally {
        asking.current = false
      }
      if (!ok) return false
    }
    baseline.current = currentRef.current
    onDiscard?.()
    return true
  }, [dirty, confirm, onDiscard, title, message, confirmLabel, cancelLabel])

  // Reloading or closing the tab bypasses every in-app handler, so the browser's own prompt is
  // the only thing left. Browsers ignore custom text here and show their own wording.
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  return { dirty, reset, requestClose }
}
