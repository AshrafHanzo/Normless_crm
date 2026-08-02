import { useState, useRef, useEffect } from 'react'
import Icon from './Icon'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const pad = (n) => String(n).padStart(2, '0')
const toKey = (d) => d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : ''
const fromKey = (s) => {
  if (!s) return null
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}
const fmtLabel = (d) => d ? `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` : ''
const sameDay = (a, b) => !!a && !!b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r }
const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1)
const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1)
const endOfMonth = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0)
const startOfWeek = (d) => { const r = startOfDay(d); r.setDate(r.getDate() - r.getDay()); return r }
const startOfQuarter = (d) => new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1)
const endOfQuarter = (d) => { const s = startOfQuarter(d); return new Date(s.getFullYear(), s.getMonth() + 3, 0) }
const startOfYear = (d) => new Date(d.getFullYear(), 0, 1)
const endOfYear = (d) => new Date(d.getFullYear(), 11, 31)

function buildPresets() {
  const today = startOfDay(new Date())
  const lastWeekStart = addDays(startOfWeek(today), -7)
  const lastMonthDate = addMonths(today, -1)
  const lastQuarterDate = addMonths(today, -3)
  const lastYearDate = addMonths(today, -12)
  return [
    { label: 'Today', start: today, end: today },
    { label: 'Yesterday', start: addDays(today, -1), end: addDays(today, -1) },
    { label: 'Last 7 days', start: addDays(today, -6), end: today, divider: true },
    { label: 'Last 30 days', start: addDays(today, -29), end: today },
    { label: 'Last 90 days', start: addDays(today, -89), end: today },
    { label: 'Last 365 days', start: addDays(today, -364), end: today },
    { label: 'Week to date', start: startOfWeek(today), end: today, divider: true },
    { label: 'Month to date', start: startOfMonth(today), end: today },
    { label: 'Quarter to date', start: startOfQuarter(today), end: today },
    { label: 'Year to date', start: startOfYear(today), end: today },
    { label: 'Last week', start: lastWeekStart, end: addDays(lastWeekStart, 6), divider: true },
    { label: 'Last month', start: startOfMonth(lastMonthDate), end: endOfMonth(lastMonthDate) },
    { label: 'Last quarter', start: startOfQuarter(lastQuarterDate), end: endOfQuarter(lastQuarterDate) },
    { label: 'Last 12 months', start: addDays(addMonths(today, -12), 1), end: today },
    { label: 'Last year', start: startOfYear(lastYearDate), end: endOfYear(lastYearDate) },
  ]
}

function MonthCalendar({ month, lo, hi, onPick, onHover }) {
  const first = startOfMonth(month)
  const startWeekday = first.getDay()
  const daysInMonth = endOfMonth(month).getDate()
  const cells = []
  for (let i = 0; i < startWeekday; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(month.getFullYear(), month.getMonth(), d))

  return (
    <div className="cal-month">
      <div className="cal-month-title">{MONTHS[month.getMonth()]} {month.getFullYear()}</div>
      <div className="cal-grid cal-grid-head">
        {WEEKDAYS.map(w => <span key={w} className="cal-weekday">{w}</span>)}
      </div>
      <div className="cal-grid">
        {cells.map((cell, i) => {
          if (!cell) return <span key={i} className="cal-cell cal-cell-empty" />
          const isEdge = sameDay(cell, lo) || sameDay(cell, hi)
          const inRange = lo && hi && cell > lo && cell < hi
          return (
            <button type="button" key={i}
              className={`cal-cell ${isEdge ? 'cal-cell-edge' : ''} ${inRange ? 'cal-cell-inrange' : ''}`}
              onMouseEnter={() => onHover(cell)}
              onClick={() => onPick(cell)}>
              {cell.getDate()}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// Shopify-admin-style date filter: preset sidebar + dual month calendar with range selection,
// staged behind Cancel/Apply so nothing fires until the user commits.
export default function DateRangeFilter({ startDate, endDate, onApply, onClear }) {
  const [open, setOpen] = useState(false)
  const [pendingStart, setPendingStart] = useState(null)
  const [pendingEnd, setPendingEnd] = useState(null)
  const [hoverDate, setHoverDate] = useState(null)
  const [viewMonth, setViewMonth] = useState(startOfMonth(addMonths(new Date(), -1)))
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const s = fromKey(startDate), e = fromKey(endDate)
    setPendingStart(s); setPendingEnd(e); setHoverDate(null)
    setViewMonth(startOfMonth(addMonths(e || new Date(), -1)))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const presets = buildPresets()
  let lo = pendingStart, hi = pendingEnd
  if (lo && !hi && hoverDate) hi = hoverDate
  if (lo && hi && lo > hi) { const t = lo; lo = hi; hi = t }

  const pick = (day) => {
    if (!pendingStart || (pendingStart && pendingEnd)) { setPendingStart(day); setPendingEnd(null) }
    else if (day < pendingStart) { setPendingEnd(pendingStart); setPendingStart(day) }
    else setPendingEnd(day)
  }
  const pickPreset = (p) => { setPendingStart(p.start); setPendingEnd(p.end); setHoverDate(null); setViewMonth(startOfMonth(addMonths(p.end, -1))) }
  const pickCustom = () => { setPendingStart(null); setPendingEnd(null); setHoverDate(null) }

  const apply = () => {
    if (!pendingStart || !pendingEnd) return
    onApply(toKey(pendingStart), toKey(pendingEnd))
    setOpen(false)
  }
  const clearAll = () => { onClear(); setOpen(false) }

  const triggerLabel = startDate && endDate ? `${fmtLabel(fromKey(startDate))} → ${fmtLabel(fromKey(endDate))}` : 'All time'
  const isActivePreset = (p) => pendingStart && pendingEnd && sameDay(pendingStart, p.start) && sameDay(pendingEnd, p.end)

  return (
    <div className="drf" ref={ref}>
      <button type="button" className="drf-trigger" onClick={() => setOpen(o => !o)}>
        <Icon name="calendar" size={15} />
        <span>{triggerLabel}</span>
      </button>
      {open && (
        <div className="drf-panel">
          <div className="drf-sidebar">
            {presets.map(p => (
              <div key={p.label}>
                {p.divider && <div className="drf-divider" />}
                <button type="button" className={`drf-preset ${isActivePreset(p) ? 'active' : ''}`} onClick={() => pickPreset(p)}>{p.label}</button>
              </div>
            ))}
            <div className="drf-divider" />
            <button type="button" className={`drf-preset ${!pendingStart && !pendingEnd ? 'active' : ''}`} onClick={pickCustom}>Custom range</button>
          </div>
          <div className="drf-main">
            <div className="drf-fields">
              <div className="drf-field">{fmtLabel(pendingStart) || 'Start date'}</div>
              <span className="drf-arrow">→</span>
              <div className="drf-field">{fmtLabel(pendingEnd) || 'End date'}</div>
            </div>
            <div className="drf-calendars" onMouseLeave={() => setHoverDate(null)}>
              <button type="button" className="drf-nav drf-nav-prev" onClick={() => setViewMonth(m => addMonths(m, -1))}>‹</button>
              <MonthCalendar month={viewMonth} lo={lo} hi={hi} onPick={pick} onHover={setHoverDate} />
              <MonthCalendar month={addMonths(viewMonth, 1)} lo={lo} hi={hi} onPick={pick} onHover={setHoverDate} />
              <button type="button" className="drf-nav drf-nav-next" onClick={() => setViewMonth(m => addMonths(m, 1))}>›</button>
            </div>
            <div className="drf-footer">
              <span className="drf-summary">{pendingStart && pendingEnd ? `${fmtLabel(lo)} – ${fmtLabel(hi)}` : 'Select a date range'}</span>
              <span style={{ display: 'flex', gap: 8 }}>
                {(startDate || endDate) && <button type="button" className="btn btn-secondary btn-sm" onClick={clearAll}>Clear</button>}
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(false)}>Cancel</button>
                <button type="button" className="btn btn-primary btn-sm" disabled={!pendingStart || !pendingEnd} onClick={apply}>Apply</button>
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
