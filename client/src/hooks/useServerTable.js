import { useState, useCallback, useMemo } from 'react'

/**
 * Sort + page state for a table whose ordering and paging are done by the server.
 *
 * The counterpart to server/utils/table.js. Client-side sorting can only reorder the page you
 * already have, which on a paginated list quietly means "the highest of these 25" rather than
 * "the highest" — so the column headers here change a query parameter instead of resorting an
 * array. Changing the sort or a filter returns to page 1: staying on page 7 of a list that was
 * just reordered lands you somewhere arbitrary.
 *
 *   const t = useServerTable({ sort: 'order_date' })
 *   useEffect(() => { load() }, [t.key])          // one dep covers sort, dir, page and limit
 *   const res = await apiFetch('/api/x?' + t.query({ search, status }))
 *   ...
 *   <SortTh label="Date" col="order_date" sort={t.sort} onSort={t.toggle} />
 *   <Pagination table={t} />
 */
export default function useServerTable({ sort: initialSort = null, dir: initialDir = 'desc', limit: initialLimit = 25 } = {}) {
  const [sort, setSort] = useState({ key: initialSort, dir: initialDir })
  const [page, setPage] = useState(1)
  const [limit, setLimitState] = useState(initialLimit)
  const [pagination, setPagination] = useState({ total: 0, page: 1, limit: initialLimit, totalPages: 1 })

  const toggle = useCallback((key) => {
    setSort(s => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
    setPage(1)
  }, [])

  const setLimit = useCallback((n) => { setLimitState(n); setPage(1) }, [])

  /** Call when a filter changes, so the new result set starts from the top. */
  const resetPage = useCallback(() => setPage(1), [])

  /** Query string for the request — merge in the page's own filters. */
  const query = useCallback((filters = {}) => new URLSearchParams(
    Object.entries({ ...filters, sort: sort.key, dir: sort.dir, page, limit })
      .filter(([, v]) => v !== '' && v !== null && v !== undefined)
      .map(([k, v]) => [k, String(v)])
  ).toString(), [sort.key, sort.dir, page, limit])

  // A single value to hang the fetch effect off, so pages don't list four deps and forget one.
  const key = useMemo(() => `${sort.key}|${sort.dir}|${page}|${limit}`, [sort.key, sort.dir, page, limit])

  return { sort, toggle, page, setPage, limit, setLimit, pagination, setPagination, query, key, resetPage }
}
