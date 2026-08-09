/**
 * Shared plumbing for list endpoints: a validated ORDER BY plus a LIMIT/OFFSET window.
 *
 * Sorting and paging both have to happen in SQL rather than in the browser. Sorting a page of 25
 * rows client-side only reorders that page, so "highest value first" silently means "highest of
 * the 25 you happen to be looking at" — which is worse than no sort at all, because it looks
 * right. Every list route therefore takes `sort`/`dir`/`page`/`limit` and answers with the same
 * pagination envelope.
 *
 * Column names cannot be bound as query parameters, so `sortable` is an allowlist mapping the
 * client's column key to a SQL expression. Nothing from the query string ever reaches the SQL —
 * an unknown key falls back to the default rather than erroring, so a stale bookmark still loads.
 */

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

function tableParams(query = {}, {
  sortable = {},
  defaultSort,
  defaultDir = 'desc',
  defaultLimit = DEFAULT_LIMIT,
  maxLimit = MAX_LIMIT,
  // Ties must break deterministically or rows drift between pages: with 30 orders sharing a date,
  // page 1 and page 2 can otherwise show the same row twice and skip another entirely.
  tiebreak = 'id',
} = {}) {
  const key = Object.prototype.hasOwnProperty.call(sortable, query.sort) ? query.sort : defaultSort;
  const expr = sortable[key];
  // `order` is accepted alongside `dir` because the Normless orders route shipped with that name.
  const dir = String(query.dir || query.order || defaultDir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const rawLimit = parseInt(query.limit, 10);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : defaultLimit, 1), maxLimit);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);

  // NULLS LAST in both directions: a missing deadline is "unknown", not "earliest", and burying
  // the blanks keeps the meaningful rows together. Mirrors what useTableSort does client-side.
  const parts = [];
  if (expr) parts.push(`${expr} ${dir} NULLS LAST`);
  if (tiebreak && tiebreak !== key) parts.push(`${tiebreak} DESC`);

  return {
    sort: key || null,
    dir: dir.toLowerCase(),
    limit,
    page,
    offset: (page - 1) * limit,
    orderBy: parts.length ? `ORDER BY ${parts.join(', ')}` : '',
  };
}

/**
 * Sort + page an array the route already holds in memory.
 *
 * A few lists can't be ordered in SQL: Crewfit orders sort on things derived from the JSON line
 * items (photo status, unit counts) that don't exist as columns. Doing it here rather than in the
 * browser still means the whole result set is ordered before it is sliced, which is the part that
 * matters — the client only ever sees the correct page.
 *
 * `accessors` maps a column key to a value getter; anything absent reads the field directly.
 */
function sortAndPage(rows, t, accessors = {}) {
  const read = t.sort ? (accessors[t.sort] || (row => row[t.sort])) : null;
  let out = rows;

  if (read) {
    const factor = t.dir === 'asc' ? 1 : -1;
    const isBlank = (v) => v === null || v === undefined || v === '';
    out = [...rows].sort((a, b) => {
      const av = read(a), bv = read(b);
      if (isBlank(av) && isBlank(bv)) return 0;
      if (isBlank(av)) return 1;   // blanks last in both directions, as in SQL's NULLS LAST
      if (isBlank(bv)) return -1;
      const an = Number(av), bn = Number(bv);
      if (Number.isFinite(an) && Number.isFinite(bn) && String(av).trim() !== '' && String(bv).trim() !== '') {
        return (an - bn) * factor;
      }
      return String(av).localeCompare(String(bv), undefined, { sensitivity: 'base' }) * factor;
    });
  }

  return { rows: out.slice(t.offset, t.offset + t.limit), total: out.length };
}

/** The envelope every list endpoint returns alongside its rows. */
function pagination(total, { page, limit }) {
  const n = parseInt(total, 10) || 0;
  return { total: n, page, limit, totalPages: Math.max(Math.ceil(n / limit), 1) };
}

module.exports = { tableParams, sortAndPage, pagination, DEFAULT_LIMIT, MAX_LIMIT };
