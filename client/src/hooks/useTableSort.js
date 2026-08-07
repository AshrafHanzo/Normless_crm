import { useMemo, useState } from 'react'

/**
 * Client-side column sorting for a list already held in memory.
 *
 * Values are compared by type rather than stringified: quantities and money have to sort
 * numerically (2 before 10), and ISO dates sort correctly as text only because they're
 * zero-padded — anything else falls back to a locale-aware string compare so "Ashna" and
 * "ashna" don't end up in different halves of the list.
 *
 *   const { rows, sort, toggle } = useTableSort(orders, { key: 'order_date', dir: 'desc' }, {
 *     products: o => summarise(o.items).join(' '),
 *   })
 *
 * `accessors` supplies a value for columns that aren't a plain field on the row. Blank values
 * always sink to the bottom regardless of direction — an empty delivery date is "unknown", not
 * "earliest", and burying it keeps the meaningful rows together.
 */
export default function useTableSort(list, initial = { key: null, dir: 'asc' }, accessors = {}) {
  const [sort, setSort] = useState(initial)

  const toggle = (key) => setSort(s => (
    s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }
  ))

  const rows = useMemo(() => {
    if (!sort.key) return list
    const read = accessors[sort.key] || (row => row[sort.key])
    const factor = sort.dir === 'asc' ? 1 : -1

    const isBlank = (v) => v === null || v === undefined || v === ''
    return [...list].sort((a, b) => {
      const av = read(a), bv = read(b)
      if (isBlank(av) && isBlank(bv)) return 0
      if (isBlank(av)) return 1   // blanks last, both directions
      if (isBlank(bv)) return -1

      const an = Number(av), bn = Number(bv)
      if (Number.isFinite(an) && Number.isFinite(bn) && String(av).trim() !== '' && String(bv).trim() !== '') {
        return (an - bn) * factor
      }
      return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' }) * factor
    })
    // accessors is a literal at every call site, so keying on the sort state alone is correct
    // and avoids re-sorting on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, sort.key, sort.dir])

  return { rows, sort, toggle }
}
