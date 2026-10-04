import { useState, useEffect, useMemo } from 'react'
import { useApi, useAuth } from '../App'
import { useToast } from '../components/Toast'
import Icon from '../components/Icon'
import SortTh from '../components/SortTh'
import Pagination from '../components/Pagination'
import DateRangeFilter from '../components/DateRangeFilter'
import useServerTable from '../hooks/useServerTable'
import ComboInput from '../components/ComboInput'
import UploadDrawer from './banking/UploadDrawer'

const inr = (v) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(v) || 0)
const inrExact = (v) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 }).format(Number(v) || 0)
const day = (v) => (v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—')
const monthName = (m) => new Date(`${m}-01`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })

const iso = (d) => d.toLocaleDateString('en-CA')
const monthsAgo = (n) => { const d = new Date(); d.setMonth(d.getMonth() - n); d.setDate(1); return iso(d) }
// The windows anyone actually asks for, and the one that answers "where did it all go".
const RANGES = [
  { key: 'month', label: 'This month', from: () => iso(new Date(new Date().getFullYear(), new Date().getMonth(), 1)) },
  { key: '3m', label: 'Last 3 months', from: () => monthsAgo(2) },
  { key: '6m', label: 'Last 6 months', from: () => monthsAgo(5) },
  { key: '12m', label: 'Last 12 months', from: () => monthsAgo(11) },
  { key: 'all', label: 'Everything', from: () => '' },
]

/**
 * The company's money, as the bank recorded it.
 *
 * Built from uploaded statements and nothing else, so every figure on the page can be traced to a
 * printed line. The top answers "what came in, what went out, what is left"; the middle answers
 * "on what"; and the list below is every single transaction, because a summary nobody can drill
 * into is a summary nobody can act on.
 */
export default function Banking() {
  const apiFetch = useApi()
  const toast = useToast()
  const { user } = useAuth()
  const isOwner = user?.role === 'owner'
  const canEdit = isOwner || user?.role === 'admin' || !!user?.can_edit_banking

  const [range, setRange] = useState('6m')
  const [from, setFrom] = useState(monthsAgo(5))
  const [to, setTo] = useState('')
  const [category, setCategory] = useState('')
  const [direction, setDirection] = useState('')
  const [search, setSearch] = useState('')
  const [term, setTerm] = useState('')

  const [summary, setSummary] = useState(null)
  const [options, setOptions] = useState({ categories: [] })
  const [statements, setStatements] = useState([])
  const [rows, setRows] = useState([])
  const [totals, setTotals] = useState(null)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [editing, setEditing] = useState(null)      // the transaction being explained
  const [view, setView] = useState('who')           // who it was with, or every line
  const [groups, setGroups] = useState([])
  const [groupInfo, setGroupInfo] = useState(null)
  const [sorting, setSorting] = useState(null)      // the name being sorted in one go
  const t = useServerTable({ sort: 'txn_date', dir: 'desc', limit: 50 })

  useEffect(() => {
    const timer = setTimeout(() => { setTerm(search); t.resetPage() }, 350)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  const scope = useMemo(() => ({
    ...(from && { from }), ...(to && { to }),
    ...(category && { category }), ...(direction && { direction }), ...(term && { search: term }),
  }), [from, to, category, direction, term])

  const load = async () => {
    setLoading(true)
    const q = new URLSearchParams(scope).toString()
    const [s, list, who, st, opt] = await Promise.all([
      apiFetch(`/api/banking/summary?${q}`),
      apiFetch(`/api/banking/transactions?${t.query(scope)}`),
      apiFetch(`/api/banking/counterparties?${q}&limit=300`),
      apiFetch('/api/banking/statements'),
      apiFetch('/api/banking/options'),
    ])
    if (s && !s.error) setSummary(s)
    if (list && !list.error) {
      setRows(list.transactions || [])
      setTotals(list.totals || null)
      if (list.pagination) t.setPagination(list.pagination)
    }
    if (who && !who.error) { setGroups(who.counterparties || []); setGroupInfo({ ...who.summary, unnamed: who.unnamed }) }
    if (st && !st.error) setStatements(st.statements || [])
    if (opt && !opt.error) setOptions(opt)
    setLoading(false)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [scope, t.key])

  const pickRange = (key) => {
    setRange(key)
    const r = RANGES.find(x => x.key === key)
    setFrom(r ? r.from() : '')
    setTo('')
    t.resetPage()
  }

  const explain = async (row, patch, learn) => {
    const res = await apiFetch(`/api/banking/transactions/${row.id}`, {
      method: 'PATCH', body: JSON.stringify({ ...patch, ...(learn ? { learn_match: learn } : {}) }),
    })
    if (!res || res.error) { toast.error(res?.error || 'Could not save that'); return }
    toast.success(learn && res.applied > 1
      ? `${res.applied} transactions like this one are now ${patch.category}`
      : 'Saved')
    setEditing(null)
    load()
  }

  /** One decision for every payment with a name on it — and the rule that keeps it that way. */
  const sortGroup = async (g, category, rename) => {
    const res = await apiFetch('/api/banking/counterparties', {
      method: 'POST', body: JSON.stringify({ name: g.key, category, ...(rename && rename !== g.name ? { rename } : {}) }),
    })
    if (!res || res.error) { toast.error(res?.error || 'Could not sort those'); return }
    toast.success(`${res.updated} transaction${res.updated === 1 ? '' : 's'} with ${res.name} → ${category}. Next month's statement will sort itself.`)
    setSorting(null)
    load()
  }

  const removeStatement = async (s) => {
    if (!await toast.confirm({
      title: `Remove the statement for ${day(s.period_from)} – ${day(s.period_to)}?`,
      message: `Its ${s.txn_count} transactions go with it, and the figures above will change.`,
      confirmLabel: 'Remove', cancelLabel: 'Keep it', danger: true,
    })) return
    const r = await apiFetch(`/api/banking/statements/${s.id}`, { method: 'DELETE' })
    if (!r || r.error) { toast.error(r?.error || 'Could not remove it'); return }
    toast.success(`${r.transactions} transactions removed`)
    load()
  }

  const tot = summary?.totals
  const spendBars = (summary?.byCategory || []).filter(c => c.out > 0)
  const biggestSpend = Math.max(1, ...spendBars.map(c => c.out))
  const months = summary?.byMonth || []
  const biggestMonth = Math.max(1, ...months.flatMap(m => [m.in, m.out]))
  const unreconciled = statements.filter(s => !s.reconciled)

  return (
    <div className="page-enter">
      <div className="dash-toolbar">
        <div>
          <h1>Bank</h1>
          <p style={{ color: 'var(--text-muted)' }}>
            {statements.length
              ? `${statements.length} statement${statements.length === 1 ? '' : 's'} loaded · every rupee from ${day(options.span?.first)} to ${day(options.span?.last)}`
              : 'Upload a statement to see where the money goes'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <DateRangeFilter startDate={from} endDate={to}
            onApply={(s, e) => { setRange('custom'); setFrom(s); setTo(e); t.resetPage() }}
            onClear={() => pickRange('all')} />
          {canEdit && (
            <button className="btn btn-primary" onClick={() => setUploading(true)}>
              <Icon name="plus" size={15} /> Load a statement
            </button>
          )}
        </div>
      </div>

      <div className="scan-tabs" style={{ marginBottom: 16 }}>
        {RANGES.map(r => (
          <button key={r.key} className={range === r.key ? 'active' : ''} onClick={() => pickRange(r.key)}>{r.label}</button>
        ))}
        {range === 'custom' && <button className="active">{day(from)} – {day(to) || 'now'}</button>}
      </div>

      {!!unreconciled.length && (
        <div className="bank-check bank-check-bad" style={{ marginBottom: 16 }}>
          <b>{unreconciled.length} statement{unreconciled.length === 1 ? '' : 's'} did not add up</b>
          <div>{unreconciled.map(s => `${day(s.period_from)}–${day(s.period_to)}: ${s.reconcile_note}`).join(' · ')}</div>
        </div>
      )}

      <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <div className="kpi-card">
          <div className="kpi-head"><div className="kpi-icon">↓</div></div>
          <div className="kpi-value bank-in">{inr(tot?.credits)}</div>
          <div className="kpi-label">Money in</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-head"><div className="kpi-icon">↑</div></div>
          <div className="kpi-value bank-out">{inr(tot?.debits)}</div>
          <div className="kpi-label">Money out</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-head"><div className="kpi-icon">=</div></div>
          <div className="kpi-value" style={{ color: (tot?.net ?? 0) >= 0 ? 'var(--success)' : 'var(--danger)' }}>{inr(tot?.net)}</div>
          <div className="kpi-label">Net for the period</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-head"><div className="kpi-icon">🏦</div></div>
          <div className="kpi-value">{inr(tot?.closing_balance)}</div>
          <div className="kpi-label">Balance after the last line</div>
        </div>
      </div>

      {!!tot?.uncategorised && (
        <button type="button" className="bank-nudge" onClick={() => { setCategory('Uncategorised'); t.resetPage() }}>
          {tot.uncategorised} transaction{tot.uncategorised === 1 ? '' : 's'} are not sorted yet — sorting one teaches the rest like it.
        </button>
      )}

      <div className="bank-panels">
        <div className="bank-panel">
          <div className="bank-panel-head"><h3>Where it went</h3><span>{tot?.txns || 0} transactions</span></div>
          {spendBars.length ? spendBars.map(c => (
            <button type="button" key={c.category} className="bank-bar" onClick={() => { setCategory(c.category === category ? '' : c.category); t.resetPage() }}>
              <span className="bank-bar-label">{c.category}</span>
              <span className="bank-bar-track"><span className="bank-bar-fill" style={{ width: `${(c.out / biggestSpend) * 100}%` }} /></span>
              <span className="bank-bar-value">{inr(c.out)}</span>
              <span className="bank-bar-count">{c.txns}</span>
            </button>
          )) : <p className="bank-empty">Nothing in this window.</p>}
        </div>

        <div className="bank-panel">
          <div className="bank-panel-head"><h3>Month by month</h3><span>in vs out</span></div>
          {months.length ? (
            <div className="bank-months">
              {months.map(m => (
                <div className="bank-month" key={m.month} title={`${monthName(m.month)} · in ${inrExact(m.in)} · out ${inrExact(m.out)}`}>
                  <div className="bank-month-bars">
                    <span className="bank-month-in" style={{ height: `${(m.in / biggestMonth) * 100}%` }} />
                    <span className="bank-month-out" style={{ height: `${(m.out / biggestMonth) * 100}%` }} />
                  </div>
                  <span className="bank-month-label">{monthName(m.month)}</span>
                  <span className={`bank-month-net ${m.net >= 0 ? 'bank-in' : 'bank-out'}`}>{inr(m.net)}</span>
                </div>
              ))}
            </div>
          ) : <p className="bank-empty">Nothing in this window.</p>}
        </div>

        <div className="bank-panel">
          <div className="bank-panel-head"><h3>Biggest payments out</h3><span>who</span></div>
          {(summary?.topOut || []).slice(0, 8).map((r, i) => (
            <button type="button" key={i} className="bank-who" onClick={() => { setSearch(r.counterparty); }}>
              <span>{r.counterparty}</span>
              <span className="bank-who-cat">{r.category}</span>
              <b className="bank-out">{inr(r.out)}</b>
            </button>
          ))}
          {!summary?.topOut?.length && <p className="bank-empty">Nothing in this window.</p>}
        </div>

        <div className="bank-panel">
          <div className="bank-panel-head"><h3>Biggest money in</h3><span>who</span></div>
          {(summary?.topIn || []).slice(0, 8).map((r, i) => (
            <button type="button" key={i} className="bank-who" onClick={() => { setSearch(r.counterparty); }}>
              <span>{r.counterparty}</span>
              <span className="bank-who-cat">{r.category}</span>
              <b className="bank-in">{inr(r.in)}</b>
            </button>
          ))}
          {!summary?.topIn?.length && <p className="bank-empty">Nothing in this window.</p>}
        </div>
      </div>

      <div className="filters-row">
        <div className="search-bar">
          <span className="search-icon" />
          <input placeholder="A name, a reference, or an amount — 14986, >50000, 1000-2000"
            value={search} onChange={e => setSearch(e.target.value)} />
          {/* Clicking a name in the panels above fills this box, so getting back out of it has to
              be one click — not a text field you have to select and delete. */}
          {!!search && (
            <button type="button" className="search-clear" title="Clear the search"
              onClick={() => { setSearch(''); t.resetPage() }}>×</button>
          )}
        </div>
        <select value={category} style={{ width: 'auto' }} onChange={e => { setCategory(e.target.value); t.resetPage() }}>
          <option value="">Every category</option>
          {(options.categories || []).map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={direction} style={{ width: 'auto' }} onChange={e => { setDirection(e.target.value); t.resetPage() }}>
          <option value="">In and out</option>
          <option value="in">Money in</option>
          <option value="out">Money out</option>
        </select>
        {totals && (
          <span className="bank-filter-total">
            {/* What the filters in force actually add up to — the figure the search was asked for. */}
            <b className="bank-in">{inrExact(totals.credits)}</b> in · <b className="bank-out">{inrExact(totals.debits)}</b> out
          </span>
        )}
      </div>

      {/* Two ways of reading the same money: by who it was with, or line by line. Grouped first,
          because that is the question a month of transactions is usually hiding. */}
      <div className="scan-tabs" style={{ marginBottom: 14 }}>
        <button className={view === 'who' ? 'active' : ''} onClick={() => setView('who')}>
          Who it was with{groupInfo?.names ? <span className="tab-badge">{groupInfo.names}</span> : null}
        </button>
        <button className={view === 'lines' ? 'active' : ''} onClick={() => setView('lines')}>
          Every transaction{t.pagination?.total ? <span className="tab-badge">{t.pagination.total}</span> : null}
        </button>
      </div>

      {view === 'who' ? (
        <div className="data-table-wrapper">
          {loading ? <div className="loader"><div className="spinner" /></div> : !groups.length ? (
            <div className="empty-state">
              <div className="empty-icon">🤝</div>
              <h3>Nobody to show</h3>
              <p>Load a statement, or widen the window.</p>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead><tr>
                  <th>Who</th>
                  <th>Category</th>
                  <th style={{ textAlign: 'right' }}>Paid out</th>
                  <th style={{ textAlign: 'right' }}>Received</th>
                  <th style={{ textAlign: 'center' }}>Times</th>
                  <th>Last</th>
                  {canEdit && <th />}
                </tr></thead>
                <tbody>
                  {groups.map(g => (
                    <tr key={g.key} className="bank-row" onClick={() => { setSearch(g.name); setView('lines') }}>
                      <td data-label="Who">
                        <span className="cell-primary">{g.name}</span>
                        {g.channel && <span className="bank-chip">{g.channel}</span>}
                        {g.txns > 1 && <div className="packed-sub">{g.first === g.last ? g.first : `since ${day(g.first)}`}</div>}
                      </td>
                      <td data-label="Category">
                        <span className={`status-badge ${g.unsorted ? 'pending' : 'info'}`}>{g.category}</span>
                        {g.categories > 1 && <div className="packed-sub">+{g.categories - 1} other</div>}
                      </td>
                      <td data-label="Paid out" className="bank-amount bank-out">{g.out > 0 ? inrExact(g.out) : ''}</td>
                      <td data-label="Received" className="bank-amount bank-in">{g.in > 0 ? inrExact(g.in) : ''}</td>
                      <td data-label="Times" style={{ textAlign: 'center' }}>
                        {g.txns > 1 ? <b className="bank-repeat">{g.txns}</b> : g.txns}
                      </td>
                      <td data-label="Last" className="support-nowrap">{day(g.last)}</td>
                      {canEdit && (
                        <td data-label="">
                          <button type="button" className="mini-btn"
                            onClick={e => { e.stopPropagation(); setSorting({ ...g, category: g.category, rename: g.name }) }}>
                            {g.unsorted ? 'Sort these' : 'Change'}
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                  {!!groupInfo?.unnamed?.txns && (
                    <tr className="bank-row" onClick={() => { setSearch(''); setView('lines') }}>
                      <td data-label="Who"><span style={{ color: 'var(--text-muted)' }}>No name on the transaction</span></td>
                      <td />
                      <td className="bank-amount bank-out">{groupInfo.unnamed.out > 0 ? inrExact(groupInfo.unnamed.out) : ''}</td>
                      <td className="bank-amount bank-in">{groupInfo.unnamed.in > 0 ? inrExact(groupInfo.unnamed.in) : ''}</td>
                      <td style={{ textAlign: 'center' }}>{groupInfo.unnamed.txns}</td>
                      <td colSpan={canEdit ? 2 : 1} />
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
      <div className="data-table-wrapper">
        {loading ? <div className="loader"><div className="spinner" /></div> : !rows.length ? (
          <div className="empty-state">
            <div className="empty-icon">🏦</div>
            <h3>{statements.length ? 'Nothing matches that' : 'No statements loaded yet'}</h3>
            <p>{statements.length
              ? 'Try a wider window, or clear the filters.'
              : 'Upload the PDF your bank sends, password and all. Every line in it will be read and checked against the bank’s own totals.'}</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead><tr>
                <SortTh label="Date" col="txn_date" sort={t.sort} onSort={t.toggle} />
                <SortTh label="What it was" col="counterparty" sort={t.sort} onSort={t.toggle} />
                <SortTh label="Category" col="category" sort={t.sort} onSort={t.toggle} />
                <SortTh label="Out" col="debit" sort={t.sort} onSort={t.toggle} />
                <SortTh label="In" col="credit" sort={t.sort} onSort={t.toggle} />
                <SortTh label="Balance" col="balance" sort={t.sort} onSort={t.toggle} />
              </tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} className={canEdit ? 'bank-row' : undefined}
                    onClick={canEdit ? () => setEditing(r) : undefined}>
                    <td data-label="Date" className="support-nowrap">{day(r.txn_date)}</td>
                    <td data-label="What it was">
                      <span className="cell-primary">{r.counterparty || 'Not named'}</span>
                      {r.channel && <span className="bank-chip">{r.channel}</span>}
                      {/* The bank's own words, kept whole — it is the only record of what this was. */}
                      <div className="packed-sub bank-narration">{r.narration}</div>
                      {r.note && <div className="packed-sub bank-note-line">{r.note}</div>}
                    </td>
                    <td data-label="Category">
                      <span className={`status-badge ${r.category === 'Uncategorised' ? 'pending' : 'info'}`}>{r.category}</span>
                    </td>
                    <td data-label="Out" className="bank-amount bank-out">{r.debit > 0 ? inrExact(r.debit) : ''}</td>
                    <td data-label="In" className="bank-amount bank-in">{r.credit > 0 ? inrExact(r.credit) : ''}</td>
                    <td data-label="Balance" className="bank-amount">{inrExact(r.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      )}
      {view === 'lines' && <Pagination table={t} noun="transactions" />}

      {!!statements.length && (
        <div className="bank-statements">
          <h3>Statements loaded</h3>
          {statements.map(s => (
            <div className="bank-statement" key={s.id}>
              <span className={`bank-dot ${s.reconciled ? 'ok' : 'bad'}`} title={s.reconciled ? 'Adds up' : s.reconcile_note} />
              <b>{day(s.period_from)} – {day(s.period_to)}</b>
              <span>{s.bank || 'Bank'} ···{s.account_last4}</span>
              <span>{s.txn_count} transactions</span>
              <span className="bank-in">{inr(s.stated_credits)} in</span>
              <span className="bank-out">{inr(s.stated_debits)} out</span>
              <span className="bank-statement-file">{s.file_name}</span>
              {isOwner && (
                <button type="button" className="mini-btn" style={{ color: 'var(--danger)' }} onClick={() => removeStatement(s)}>
                  <Icon name="trash" size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {uploading && <UploadDrawer onClose={() => setUploading(false)} onLoaded={() => { setUploading(false); load() }} />}

      {sorting && (
        <div className="confirm-overlay" onClick={() => setSorting(null)}>
          <div className="confirm-card" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
            <h3 className="confirm-title">{sorting.name}</h3>
            <p className="confirm-message">
              {sorting.txns} transaction{sorting.txns === 1 ? '' : 's'} ·
              {sorting.out > 0 ? ` ${inrExact(sorting.out)} paid out` : ''}
              {sorting.in > 0 ? `${sorting.out > 0 ? ' ·' : ''} ${inrExact(sorting.in)} received` : ''}
              {' '}· {day(sorting.first)} to {day(sorting.last)}
            </p>
            <div className="form-row">
              <div className="input-group">
                <label>What are these? <span className="label-hint">pick or type a new one</span></label>
                <ComboInput value={sorting.category === 'Uncategorised' ? '' : sorting.category}
                  options={options.categories || []}
                  placeholder="e.g. Stitching, or something of your own"
                  onChange={v => setSorting({ ...sorting, category: v })} />
              </div>
              <div className="input-group">
                {/* Two spellings of one supplier are one supplier: renaming here merges them. */}
                <label>Name <span className="label-hint">rename to merge spellings</span></label>
                <input value={sorting.rename} onChange={e => setSorting({ ...sorting, rename: e.target.value })} />
              </div>
            </div>
            <p className="bank-note">
              Every transaction with this name is sorted at once, and the next statement you load
              will sort itself the same way.
            </p>
            <div className="confirm-actions">
              <button className="btn btn-secondary" onClick={() => setSorting(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={!sorting.category?.trim()}
                onClick={() => sortGroup(sorting, sorting.category.trim(), sorting.rename)}>
                Sort all {sorting.txns}
              </button>
            </div>
          </div>
        </div>
      )}

      {editing && (
        <div className="confirm-overlay" onClick={() => setEditing(null)}>
          <div className="confirm-card" style={{ maxWidth: 620 }} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
            <h3 className="confirm-title">What was this?</h3>
            <p className="confirm-message bank-narration">{editing.narration}</p>
            <div className="bank-facts" style={{ marginBottom: 14 }}>
              <div><span>Date</span><b>{day(editing.txn_date)}</b></div>
              <div><span>Amount</span><b className={editing.credit ? 'bank-in' : 'bank-out'}>{inrExact(editing.credit || editing.debit)}</b></div>
              <div><span>Reference</span><b>{editing.ref_no || '—'}</b></div>
            </div>
            <div className="form-row">
              <div className="input-group">
                {/* Pick one or type one: the list is a starting point, not a cage. Anything typed
                    here is a category from then on and comes back in the list. */}
                <label>Category <span className="label-hint">pick or type a new one</span></label>
                <ComboInput value={editing.category || ''} options={options.categories || []}
                  placeholder="e.g. Fabric, or something of your own"
                  onChange={v => setEditing({ ...editing, category: v })} />
              </div>
              <div className="input-group">
                <label>Who it was with</label>
                <input value={editing.counterparty || ''} onChange={e => setEditing({ ...editing, counterparty: e.target.value })} />
              </div>
            </div>
            <div className="input-group">
              <label>Note <span className="label-hint">optional</span></label>
              <input value={editing.note || ''} onChange={e => setEditing({ ...editing, note: e.target.value })} />
            </div>
            <div className="confirm-actions" style={{ flexWrap: 'wrap' }}>
              <button className="btn btn-secondary" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn btn-secondary"
                onClick={() => explain(editing, { category: editing.category, counterparty: editing.counterparty, note: editing.note })}>
                Just this one
              </button>
              {/* The counterparty is the phrase worth learning: every other line naming them is the
                  same kind of payment, and sorting them one at a time is the tedium this removes. */}
              {editing.counterparty && (
                <button className="btn btn-primary"
                  onClick={() => explain(editing, { category: editing.category, counterparty: editing.counterparty, note: editing.note }, editing.counterparty)}>
                  Every payment with {editing.counterparty}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
