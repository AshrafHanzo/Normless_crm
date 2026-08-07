/**
 * A sortable table heading. Pairs with useTableSort:
 *
 *   <SortTh label="Qty" col="total_qty" sort={sort} onSort={toggle} align="center" />
 *
 * Renders a plain <th> when no `col` is given, so a header row can mix sortable and fixed
 * columns without special-casing at the call site.
 */
export default function SortTh({ label, col, sort, onSort, align, style }) {
  if (!col) return <th style={{ textAlign: align, ...style }}>{label}</th>

  const active = sort?.key === col
  const dir = active ? sort.dir : null
  return (
    <th style={{ textAlign: align, ...style }}>
      <button
        type="button"
        className={`sort-th${active ? ' active' : ''}`}
        onClick={() => onSort(col)}
        // Announces the current order to screen readers, which can't see the arrow.
        aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
        title={`Sort by ${label}`}
        style={{ justifyContent: align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start' }}
      >
        <span>{label}</span>
        <span className="sort-arrow" aria-hidden="true">{active ? (dir === 'asc' ? '▲' : '▼') : '↕'}</span>
      </button>
    </th>
  )
}
