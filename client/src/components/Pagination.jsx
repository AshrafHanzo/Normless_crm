/**
 * The pager under a server-paginated table. Pairs with useServerTable:
 *
 *   <Pagination table={t} noun="orders" />
 *
 * Renders nothing when everything already fits on one page — a single-page list doesn't need
 * controls, but it does still need the row count, so that stays visible whenever there are rows.
 */
export default function Pagination({ table, noun = 'rows' }) {
  const { page, setPage, limit, setLimit, pagination } = table
  const total = pagination?.total || 0
  const totalPages = Math.max(pagination?.totalPages || 1, 1)
  if (!total) return null

  const start = (page - 1) * limit + 1
  const end = Math.min(page * limit, total)

  // A long list gets a window around the current page rather than 40 buttons.
  const windowSize = 5
  let first = Math.max(1, page - Math.floor(windowSize / 2))
  const last = Math.min(totalPages, first + windowSize - 1)
  first = Math.max(1, last - windowSize + 1)
  const pages = Array.from({ length: last - first + 1 }, (_, i) => first + i)

  return (
    <div className="pagination">
      <span className="pagination-info">Showing {start}–{end} of {total.toLocaleString('en-IN')} {noun}</span>
      {totalPages > 1 && (
        <div className="pagination-pages">
          <button disabled={page <= 1} onClick={() => setPage(1)} title="First page">«</button>
          <button disabled={page <= 1} onClick={() => setPage(page - 1)} title="Previous page">‹</button>
          {first > 1 && <button disabled>…</button>}
          {pages.map(p => (
            <button key={p} className={p === page ? 'active' : ''} onClick={() => setPage(p)}>{p}</button>
          ))}
          {last < totalPages && <button disabled>…</button>}
          <button disabled={page >= totalPages} onClick={() => setPage(page + 1)} title="Next page">›</button>
          <button disabled={page >= totalPages} onClick={() => setPage(totalPages)} title="Last page">»</button>
        </div>
      )}
      <label className="pagination-limit">
        Rows per page
        <select value={limit} onChange={e => setLimit(Number(e.target.value))}>
          {[10, 25, 50, 100].map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
    </div>
  )
}
