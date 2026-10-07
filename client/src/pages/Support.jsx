import { useState, useEffect, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApi, useAuth } from '../App'
import { useToast } from '../components/Toast'
import Icon from '../components/Icon'
import SortTh from '../components/SortTh'
import Pagination from '../components/Pagination'
import DateRangeFilter from '../components/DateRangeFilter'
import useServerTable from '../hooks/useServerTable'
import TicketDrawer from './support/TicketDrawer'
import { blankTicket, refOf, trackingFor } from './support/ticket'

const day = (v) => (v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—')
const TABS = [
  { key: 'open', label: 'Open' },
  { key: 'closed', label: 'Closed' },
  { key: 'all', label: 'All' },
]
// What each stage looks like at a glance. Closed is quiet on purpose — the eye should land on the
// tickets somebody still has to do something about.
const PROGRESS_CLASS = { Pending: 'pending', 'In Progress': 'warning', Completed: 'fulfilled' }

/**
 * Customer support — everything a customer asked for after the order shipped.
 *
 * Returns, replacements, reships and refunds are arranged by hand, mostly over WhatsApp, and used
 * to live in a spreadsheet. The page is built the way that sheet was read: open tickets first,
 * the oldest ones marked, and every ticket carrying the order it is about so nobody has to go
 * looking for it in another tab.
 *
 * Marketing's seeding orders are not here. They have their own page, and the only reason the two
 * were ever in one file is that it was one file.
 */
export default function Support() {
  const apiFetch = useApi()
  const toast = useToast()
  const { user } = useAuth()
  const isAdmin = ['owner', 'admin'].includes(user?.role)
  const canEdit = isAdmin || !!user?.can_edit_support
  const [params, setParams] = useSearchParams()

  const [tickets, setTickets] = useState([])
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [options, setOptions] = useState({})
  const [view, setView] = useState('open')
  const [search, setSearch] = useState('')
  const [term, setTerm] = useState('')
  const [nature, setNature] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [target, setTarget] = useState(null)      // the ticket in the drawer, or a blank one
  const t = useServerTable({ sort: 'raised_on', dir: 'desc' })

  useEffect(() => {
    apiFetch('/api/support/options').then(r => { if (r && !r.error) setOptions(r) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => { setTerm(search); t.resetPage() }, 350)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  const load = async () => {
    setLoading(true)
    const q = { view, ...(term && { search: term }), ...(nature && { nature }), ...(from && { from }), ...(to && { to }) }
    const r = await apiFetch('/api/support/tickets?' + t.query(q))
    if (r && !r.error) {
      setTickets(r.tickets || [])
      setSummary(r.summary || null)
      if (r.pagination) t.setPagination(r.pagination)
    } else if (r?.error) toast.error(r.error)
    setLoading(false)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [view, term, nature, from, to, t.key])

  // A notification about a ticket links straight at it, and it may be on no page under the
  // filters in view — so it is fetched by id rather than looked for in the list.
  useEffect(() => {
    const focus = params.get('focus')
    if (!focus) return
    let live = true
    apiFetch(`/api/support/tickets/${focus}`).then(r => {
      if (!live) return
      if (r && !r.error && r.ticket) setTarget(r.ticket)
      params.delete('focus'); setParams(params, { replace: true })
    })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params])

  const onSaved = (saved, isNew) => { setTarget(isNew ? null : saved); load() }

  const remove = async (row) => {
    if (!await toast.confirm({
      title: `Delete ${refOf(row)}?`,
      message: 'The ticket and its comments go for good. Closing it keeps the record instead.',
      confirmLabel: 'Delete', cancelLabel: 'Keep it', danger: true,
    })) return
    const r = await apiFetch(`/api/support/tickets/${row.id}`, { method: 'DELETE' })
    if (!r || r.error) { toast.error(r?.error || 'Could not delete it'); return }
    toast.success(`${refOf(row)} deleted`)
    setTarget(null); load()
  }

  const kpis = useMemo(() => ([
    { icon: '📬', value: summary?.open ?? 0, label: 'Open tickets' },
    { icon: '⏳', value: summary?.stale ?? 0, label: 'Waiting over 7 days', warn: (summary?.stale ?? 0) > 0 },
    { icon: '🆕', value: summary?.today ?? 0, label: 'Raised today' },
    { icon: '✅', value: summary?.closed ?? 0, label: 'Closed' },
  ]), [summary])

  return (
    <div className="page-enter">
      <div className="dash-toolbar">
        <div>
          <h1>Customer Support</h1>
          <p style={{ color: 'var(--text-muted)' }}>Returns, replacements, reships and refunds arranged by hand</p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <DateRangeFilter startDate={from} endDate={to}
            onApply={(s, e) => { setFrom(s); setTo(e); t.resetPage() }}
            onClear={() => { setFrom(''); setTo(''); t.resetPage() }} />
          {canEdit && (
            <button className="btn btn-primary" onClick={() => setTarget(blankTicket())}>
              <Icon name="plus" size={15} /> New ticket
            </button>
          )}
        </div>
      </div>

      <div className="scan-tabs" style={{ marginBottom: 16 }}>
        {TABS.map(tab => (
          <button key={tab.key} className={view === tab.key ? 'active' : ''}
            onClick={() => { setView(tab.key); t.resetPage() }}>
            {tab.label}
            {tab.key === 'open' && summary?.open > 0 && <span className="tab-badge">{summary.open}</span>}
          </button>
        ))}
      </div>

      <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        {kpis.map(k => (
          <div className="kpi-card" key={k.label}>
            <div className="kpi-head"><div className="kpi-icon">{k.icon}</div></div>
            <div className="kpi-value" style={k.warn ? { color: 'var(--warning)' } : undefined}>{k.value}</div>
            <div className="kpi-label">{k.label}</div>
          </div>
        ))}
      </div>

      <div className="filters-row">
        <div className="search-bar"><span className="search-icon" />
          <input placeholder="Order number, customer, phone, AWB or what they asked for…"
            value={search} onChange={e => setSearch(e.target.value)} /></div>
        <select value={nature} style={{ width: 'auto' }} onChange={e => { setNature(e.target.value); t.resetPage() }}>
          <option value="">Every kind of request</option>
          {(options.natures || []).map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>

      <div className="data-table-wrapper">
        {loading ? <div className="loader"><div className="spinner" /></div> : !tickets.length ? (
          <div className="empty-state">
            <div className="empty-icon">🎧</div>
            <h3>{term || nature || from ? 'Nothing matches that' : view === 'open' ? 'No open tickets' : 'Nothing here yet'}</h3>
            <p>{view === 'open'
              ? 'Every customer request has been settled. A new one starts with the order number.'
              : 'Raise a ticket when a customer asks for a return, a replacement or a refund.'}</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead><tr>
                <SortTh label="Ticket" col="ref_no" sort={t.sort} onSort={t.toggle} />
                <SortTh label="Order" col="order_number" sort={t.sort} onSort={t.toggle} />
                <SortTh label="Customer" col="customer_name" sort={t.sort} onSort={t.toggle} />
                <SortTh label="Request" col="nature" sort={t.sort} onSort={t.toggle} />
                <th>What we did</th>
                <SortTh label="Stage" col="progress" sort={t.sort} onSort={t.toggle} />
                <SortTh label="Raised" col="raised_on" sort={t.sort} onSort={t.toggle} />
                <SortTh label="Aging" col="aging" sort={t.sort} onSort={t.toggle} />
              </tr></thead>
              <tbody>
                {tickets.map(x => {
                  const stale = x.status !== 'Closed' && x.aging > 7
                  return (
                    <tr key={x.id} onClick={() => setTarget(x)} style={{ cursor: 'pointer' }}
                      className={stale ? 'support-row-stale' : undefined}>
                      <td data-label="Ticket" className="cell-primary support-nowrap">{refOf(x)}</td>
                      <td data-label="Order">
                        {x.order_number || '—'}
                        {/* Followed from the list without opening the ticket — the row click opens
                            the drawer, so the link has to keep the click to itself. */}
                        {[['F', x.forward_awb], ['R', x.return_awb]].filter(([, n]) => n).map(([tag, n]) => (
                          <div className="packed-sub" key={tag}>
                            {tag}{' '}
                            <a className="support-awb" href={trackingFor(n)} target="_blank" rel="noreferrer"
                              onClick={e => e.stopPropagation()}>{n}</a>
                          </div>
                        ))}
                      </td>
                      <td data-label="Customer">
                        {x.customer_name || '—'}
                        <div className="packed-sub">{[x.customer_phone, x.source].filter(Boolean).join(' · ') || '—'}</div>
                      </td>
                      <td data-label="Request">
                        {x.nature || '—'}
                        {/* Said in the list, because a ticket with a photograph of the damage is a
                            different thing to pick up than one without. */}
                        {x.images?.length > 0 && (
                          <span className="bank-chip" title={`${x.images.length} proof photo${x.images.length === 1 ? '' : 's'}`}>
                            📷 {x.images.length}
                          </span>
                        )}
                        <div className="packed-sub">{[x.reason, x.request].filter(Boolean).join(' · ') || '—'}</div>
                      </td>
                      <td data-label="What we did">
                        {x.action || <span style={{ color: 'var(--text-muted)' }}>Nothing yet</span>}
                        {/* Money the customer owes for a replacement is the thing that holds a
                            parcel up, so it is said here rather than hidden in the drawer. */}
                        {x.payment_status === 'Pending' && <div className="packed-sub" style={{ color: 'var(--warning)' }}>Payment pending</div>}
                      </td>
                      <td data-label="Stage">
                        <span className={`status-badge ${x.status === 'Closed' ? 'fulfilled' : PROGRESS_CLASS[x.progress] || 'pending'}`}>
                          {x.status === 'Closed' ? 'Closed' : x.progress || 'Pending'}
                        </span>
                      </td>
                      <td data-label="Raised" className="support-nowrap">{day(x.raised_on)}</td>
                      <td data-label="Aging" style={stale ? { color: 'var(--warning)', fontWeight: 700 } : undefined}>
                        {x.aging}d
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <Pagination table={t} noun="tickets" />

      {target && (
        <TicketDrawer
          ticket={target}
          options={options}
          canEdit={canEdit}
          onClose={() => setTarget(null)}
          onSaved={onSaved}
          onDelete={user?.role === 'owner' ? remove : null}
        />
      )}
    </div>
  )
}
