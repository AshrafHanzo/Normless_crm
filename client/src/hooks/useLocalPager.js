import { useState, useMemo } from 'react'

/**
 * Pagination for a list already in memory.
 *
 * Produces the same shape useServerTable does, so <Pagination table={…} /> works unchanged — the
 * difference is only where the slicing happens. Meant for lists the API returns whole because they
 * are bounded and needed in full anyway (a shelf, a set of notices), not as a way to avoid paging
 * on the server where the data is genuinely large.
 */
export default function useLocalPager(rows, initialLimit = 10) {
  const [page, setPage] = useState(1)
  const [limit, setLimit] = useState(initialLimit)
  const total = rows?.length || 0
  const totalPages = Math.max(Math.ceil(total / limit), 1)
  // A list that shrinks under you — a notice answered on the last page — must not leave the pager
  // pointing past the end, which would render an empty table with no way back.
  const safePage = Math.min(page, totalPages)

  const slice = useMemo(
    () => (rows || []).slice((safePage - 1) * limit, safePage * limit),
    [rows, safePage, limit],
  )

  return {
    slice,
    table: {
      page: safePage,
      setPage,
      limit,
      setLimit: (n) => { setLimit(n); setPage(1) },
      pagination: { total, totalPages },
    },
  }
}
