import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApi, useAuth } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import TaskDrawer from './TaskDrawer'
import { Avatar, CompanyPill, handle, shortDay, today, num, useReason } from './teamUi'

/**
 * Team › Tasks. One page, four views of the work:
 *   - Board: the seven columns, drag a card to move it;
 *   - Backlog: plan sprints by moving tasks into them, with each person's load;
 *   - Analytics: what got done, on time or late, per person;
 *   - My tasks: everything assigned to me across boards.
 */
const PRIORITY_LABEL = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' }
const NEEDS_REASON = ['hold', 'blocked', 'rejected']

export default function Tasks() {
  const apiFetch = useApi()
  const { user } = useAuth()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const [boards, setBoards] = useState(null)
  const [users, setUsers] = useState([])
  const [canCreate, setCanCreate] = useState(false)
  const [boardDialog, setBoardDialog] = useState(null)
  const me = user?.username

  const boardId = params.get('board')
  const view = params.get('mine') ? 'mine' : (params.get('view') || 'board')
  const openTask = params.get('task')
  const go = (patch) => setParams(p => {
    const n = new URLSearchParams(p)
    for (const [k, v] of Object.entries(patch)) { if (v == null || v === '') n.delete(k); else n.set(k, v) }
    return n
  })

  const loadBoards = async () => {
    const r = await apiFetch('/api/tasks/boards')
    if (!r || r.error) { toast.error(r?.error || 'Could not load boards'); setBoards([]); return }
    setBoards(r.boards); setUsers(r.users); setCanCreate(r.canCreate)
    if (!boardId && !params.get('mine') && r.boards.length) go({ board: r.boards[0].id })
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadBoards() }, [])

  const [stamp, setStamp] = useState(0)
  const refresh = () => setStamp(s => s + 1)

  if (!boards) return <div className="page-enter"><div className="loader"><div className="spinner" /></div></div>

  return (
    <div className="page-enter tm-page">
      <div className="tm-boardbar">
        <nav className="tm-boardlist" aria-label="Boards">
          <button type="button" className={view === 'mine' ? 'on' : ''} onClick={() => go({ mine: 1, board: null, view: null, task: null })}>
            <Icon name="check" size={14} /> My tasks
          </button>
          {boards.map(b => (
            <button key={b.id} type="button" className={view !== 'mine' && String(b.id) === String(boardId) ? 'on' : ''}
              onClick={() => go({ board: b.id, mine: null, view: null, task: null })}>
              <span className="tm-key">{b.key}</span>{b.name}
              {b.late > 0 && <span className="tm-late-dot" title={`${b.late} late`}>{b.late}</span>}
            </button>
          ))}
          {canCreate && <button type="button" className="tm-new-board" onClick={() => setBoardDialog('new')}><Icon name="plus" size={14} /> New board</button>}
        </nav>
      </div>

      {view === 'mine' ? (
        <MyTasks apiFetch={apiFetch} toast={toast} stamp={stamp} onOpen={(t) => go({ task: t.id })} />
      ) : !boards.length ? (
        <div className="empty-state"><div className="empty-icon">🗂️</div>
          <p>{canCreate ? 'No boards yet. Make one for each team or project — Marketing, Production, Crewfit Sales…' : 'You are not on any board yet. Ask a board lead to add you.'}</p>
          {canCreate && <button className="btn btn-primary" onClick={() => setBoardDialog('new')}>+ New board</button>}
        </div>
      ) : boardId ? (
        <BoardView key={boardId} boardId={boardId} view={view} apiFetch={apiFetch} toast={toast} me={me} users={users} stamp={stamp}
          go={go} onEditBoard={(b) => setBoardDialog(b)} onOpen={(t) => go({ task: t.id })} />
      ) : null}

      {openTask && (
        <TaskDrawer key={openTask} taskId={openTask} apiFetch={apiFetch} toast={toast} me={me} users={users}
          onClose={() => go({ task: null })} onChanged={refresh} />
      )}
      {boardDialog && (
        <BoardDialog board={boardDialog === 'new' ? null : boardDialog} users={users} apiFetch={apiFetch} toast={toast}
          onClose={() => setBoardDialog(null)}
          onSaved={async (id) => { setBoardDialog(null); await loadBoards(); if (id) go({ board: id, mine: null, view: null }); refresh() }} />
      )}
    </div>
  )
}

/* ───────────────────────────── board ───────────────────────────── */

function BoardView({ boardId, view, apiFetch, toast, me, users, stamp, go, onEditBoard, onOpen }) {
  const [data, setData] = useState(null)
  const [filters, setFilters] = useState({ q: '', person: '', mine: false, label: '', priority: '', hideClosed: false })
  const [dragId, setDragId] = useState(null)
  const [overCol, setOverCol] = useState(null)
  const [adding, setAdding] = useState(null)
  const [ask, reasonDialog] = useReason()

  const load = async () => {
    const r = await apiFetch(`/api/tasks/boards/${boardId}`)
    if (!r || r.error) { toast.error(r?.error || 'Could not load the board'); return }
    setData(r)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [boardId, stamp])

  const tasks = useMemo(() => {
    if (!data) return []
    const q = filters.q.toLowerCase()
    return data.tasks.filter(t =>
      (!q || t.title.toLowerCase().includes(q) || `${t.board_key}-${t.number}`.toLowerCase().includes(q))
      && (!filters.person || t.assignee === filters.person)
      && (!filters.mine || t.assignee === me)
      && (!filters.label || (t.labels || []).includes(filters.label))
      && (!filters.priority || t.priority === filters.priority))
  }, [data, filters, me])

  if (!data) return <div className="loader"><div className="spinner" /></div>
  const b = data.board
  const sprint = data.activeSprint
  // With sprints on, the board shows the running sprint (and ideas, which never belong to one).
  const onBoard = (t) => !b.use_sprints || !sprint || t.sprint_id === sprint.id || t.status === 'ideas'
  const columns = data.statuses.filter(s => !(filters.hideClosed && (s === 'done' || s === 'rejected')))
  const people = [...new Set([...(b.members || []), b.lead_username].filter(Boolean))]
  const daysLeft = sprint ? Math.max(0, Math.round((new Date(`${sprint.ends_on}T23:59:59`) - new Date()) / 86400000)) : null

  const move = async (task, status, beforeTask) => {
    if (task.status === status && !beforeTask) return
    let status_reason
    if (status !== task.status && NEEDS_REASON.includes(status)) {
      status_reason = await ask({ title: `Why is ${task.board_key}-${task.number} ${data.statusLabels[status].toLowerCase()}?`, placeholder: 'A short reason, shown on the card', confirmLabel: 'Move' })
      if (!status_reason) return
    }
    const col = data.tasks.filter(t => t.status === status && t.id !== task.id).sort((a, c) => a.position - c.position)
    let position
    if (beforeTask) {
      const i = col.findIndex(t => t.id === beforeTask.id)
      const prev = col[i - 1]
      position = prev ? (Number(prev.position) + Number(beforeTask.position)) / 2 : Number(beforeTask.position) - 1
    } else position = (col.length ? Number(col[col.length - 1].position) : 0) + 1
    // Move it on screen first; the server's answer replaces it.
    setData(d => ({ ...d, tasks: d.tasks.map(t => t.id === task.id ? { ...t, status, position, status_reason: status_reason ?? t.status_reason } : t) }))
    const body = { position, ...(status !== task.status ? { status, status_reason } : {}) }
    let r = await apiFetch(`/api/tasks/${task.id}`, { method: 'PUT', body: JSON.stringify(body) })
    if (r?.overLimit && await toast.confirm({ title: 'Over the column limit', message: `${r.error}. Move it anyway?`, confirmLabel: 'Move anyway' })) {
      r = await apiFetch(`/api/tasks/${task.id}`, { method: 'PUT', body: JSON.stringify({ ...body, overLimit: true }) })
    }
    if (!r || r.error) { if (!r?.overLimit) toast.error(r?.error || 'Could not move the task') }
    load()
  }

  const quickAdd = async (status, title) => {
    const r = await apiFetch('/api/tasks', { method: 'POST', body: JSON.stringify({
      board_id: b.id, title, status, sprint_id: b.use_sprints && sprint && status !== 'ideas' ? sprint.id : null,
      assignee: filters.mine ? me : (filters.person || null) }) })
    if (!r || r.error) { toast.error(r?.error || 'Could not add the task'); return }
    load()
  }

  return (
    <>
      <header className="tm-head">
        <div>
          <div className="tm-title-row">
            <h1>{b.name}</h1><CompanyPill company={b.company} />
            {b.use_sprints && (sprint
              ? <span className="tm-sprint">{sprint.name} · {shortDay(sprint.starts_on)} – {shortDay(sprint.ends_on)} · {daysLeft} day{daysLeft === 1 ? '' : 's'} left</span>
              : <span className="tm-sprint tm-muted">No sprint running — plan one in Backlog</span>)}
          </div>
          {sprint?.goal && <p className="tm-goal">Goal: {sprint.goal}</p>}
        </div>
        <div className="tm-head-actions">
          <div className="tm-views" role="tablist" aria-label="View">
            {[['board', 'Board'], ['backlog', b.use_sprints ? 'Backlog' : 'List'], ['analytics', 'Analytics']].map(([v, l]) => (
              <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => go({ view: v === 'board' ? null : v })}>{l}</button>
            ))}
          </div>
          {data.canRun && <button type="button" className="btn btn-secondary btn-sm" onClick={() => onEditBoard(b)}><Icon name="settings" size={14} /> Board settings</button>}
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setAdding('todo')}><Icon name="plus" size={14} /> New task</button>
        </div>
      </header>

      {view === 'analytics' ? <TaskAnalytics apiFetch={apiFetch} boardId={b.id} statusLabels={data.statusLabels} /> : view === 'backlog' ? (
        <Backlog data={data} apiFetch={apiFetch} toast={toast} reload={load} onOpen={onOpen} />
      ) : (
        <>
          <div className="tm-filters">
            <input type="search" placeholder="Search tasks…" aria-label="Search tasks" value={filters.q} onChange={e => setFilters(f => ({ ...f, q: e.target.value }))} />
            <div className="tm-people" role="group" aria-label="Filter by person">
              {people.map(p => (
                <button key={p} type="button" aria-pressed={filters.person === p} className={filters.person === p ? 'on' : ''}
                  onClick={() => setFilters(f => ({ ...f, person: f.person === p ? '' : p }))}><Avatar name={p} size={30} title={handle(p)} /></button>
              ))}
            </div>
            <button type="button" className={`tm-chip${filters.mine ? ' on' : ''}`} aria-pressed={filters.mine} onClick={() => setFilters(f => ({ ...f, mine: !f.mine }))}>Only my tasks</button>
            <select aria-label="Label" value={filters.label} onChange={e => setFilters(f => ({ ...f, label: e.target.value }))}>
              <option value="">Any label</option>{data.labels.map(l => <option key={l}>{l}</option>)}
            </select>
            <select aria-label="Priority" value={filters.priority} onChange={e => setFilters(f => ({ ...f, priority: e.target.value }))}>
              <option value="">Any priority</option>{Object.entries(PRIORITY_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <button type="button" className={`tm-chip${filters.hideClosed ? ' on' : ''}`} aria-pressed={filters.hideClosed} onClick={() => setFilters(f => ({ ...f, hideClosed: !f.hideClosed }))}>Hide Done &amp; Rejected</button>
          </div>

          <div className="tm-board-scroll">
            <div className="tm-board" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(250px, 1fr))` }}>
              {columns.map(status => {
                const list = tasks.filter(t => t.status === status && onBoard(t)).sort((a, c) => a.position - c.position)
                const limit = Number(b.wip_limits?.[status]) || 0
                return (
                  <section key={status} className={`tm-col tm-col-${status}${overCol === status ? ' tm-drop' : ''}`} aria-label={`${data.statusLabels[status]}, ${list.length} tasks`}
                    onDragOver={e => { e.preventDefault(); setOverCol(status) }} onDragLeave={() => setOverCol(null)}
                    onDrop={e => { e.preventDefault(); setOverCol(null); const t = data.tasks.find(x => String(x.id) === String(dragId)); if (t) move(t, status) }}>
                    <div className="tm-col-head">
                      <b>{data.statusLabels[status].toUpperCase()}</b>
                      <span className={limit && list.length >= limit ? 'tm-over' : ''}>{list.length}{limit ? ` / ${limit}` : ''}</span>
                      {status !== 'done' && status !== 'rejected' && (
                        <button type="button" className="btn-icon" aria-label={`Add a task to ${data.statusLabels[status]}`} onClick={() => setAdding(status)}><Icon name="plus" size={15} /></button>
                      )}
                    </div>
                    {adding === status && <QuickAdd onAdd={(title) => quickAdd(status, title)} onClose={() => setAdding(null)} />}
                    {list.map(t => (
                      <TaskCard key={t.id} t={t} statusLabels={data.statusLabels} dragging={String(dragId) === String(t.id)}
                        onOpen={() => onOpen(t)} onDragStart={() => setDragId(t.id)} onDragEnd={() => setDragId(null)}
                        onDropBefore={() => { const d = data.tasks.find(x => String(x.id) === String(dragId)); if (d && d.id !== t.id) move(d, status, t) }} />
                    ))}
                    {!list.length && adding !== status && <div className="tm-col-empty">Nothing here</div>}
                  </section>
                )
              })}
            </div>
          </div>
          <p className="tm-muted tm-foot">Drag a card to change its status, or drop it on another card to put it above. Hold, Blocked and Rejected ask for a reason, shown on the card.</p>
        </>
      )}
      {reasonDialog}
    </>
  )
}

function QuickAdd({ onAdd, onClose }) {
  const [title, setTitle] = useState('')
  return (
    <form className="tm-quick" onSubmit={e => { e.preventDefault(); if (title.trim()) { onAdd(title.trim()); setTitle('') } }}>
      <textarea autoFocus rows={2} value={title} placeholder="What needs doing? Enter to add" aria-label="New task title"
        onChange={e => setTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form.requestSubmit() } if (e.key === 'Escape') onClose() }} />
      <div><button type="submit" className="btn btn-primary btn-sm" disabled={!title.trim()}>Add</button><button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>Done</button></div>
    </form>
  )
}

function TaskCard({ t, statusLabels, dragging, onOpen, onDragStart, onDragEnd, onDropBefore }) {
  const late = t.due_on && t.due_on < today() && !['done', 'rejected', 'ideas'].includes(t.status)
  const checklist = t.checklist || []
  const closed = t.status === 'done' || t.status === 'rejected'
  return (
    <button type="button" className={`tm-card${late ? ' tm-card-late' : ''}${dragging ? ' tm-dragging' : ''}${closed ? ' tm-card-closed' : ''}`}
      draggable onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; onDragStart() }} onDragEnd={onDragEnd}
      onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); e.stopPropagation(); onDropBefore() }} onClick={onOpen}>
      <span className={`tm-card-title${t.status === 'rejected' ? ' tm-struck' : ''}`}>{t.title}</span>
      {t.status_reason && ['hold', 'blocked', 'rejected'].includes(t.status) && <span className={`tm-card-reason tm-reason-${t.status}`}>{statusLabels[t.status]}: {t.status_reason}</span>}
      {(t.labels?.length > 0 || ['high', 'urgent'].includes(t.priority) || t.repeat) && (
        <span className="tm-tags">
          {t.labels?.map(l => <span key={l} className="tm-label">{l}</span>)}
          {['high', 'urgent'].includes(t.priority) && <span className={`tm-prio tm-prio-${t.priority}`}>{PRIORITY_LABEL[t.priority]}</span>}
          {t.repeat && <span className="tm-label tm-label-grey">↻ {t.repeat.every === 'weekday' ? 'Weekdays' : `Every ${t.repeat.every}`}</span>}
        </span>
      )}
      <span className="tm-card-foot">
        <span>{t.board_key}-{t.number}
          {t.due_on && <> · {late ? <b className="tm-late">late, due {shortDay(t.due_on)}</b> : closed ? `done ${shortDay(t.done_at)}` : `due ${shortDay(t.due_on)}`}</>}
          {checklist.length > 0 && <> · {checklist.filter(i => i.done).length}/{checklist.length}</>}
          {t.comments > 0 && <> · {t.comments} comment{t.comments === 1 ? '' : 's'}</>}
        </span>
        <Avatar name={t.assignee} size={24} />
      </span>
    </button>
  )
}

/* ───────────────────────────── backlog and sprints ───────────────────────────── */

function Backlog({ data, apiFetch, toast, reload, onOpen }) {
  const b = data.board
  const [busy, setBusy] = useState(false)
  const [planning, setPlanning] = useState(false)
  const open = data.tasks.filter(t => !['done', 'rejected'].includes(t.status))
  const backlog = open.filter(t => !t.sprint_id || !data.sprints.some(s => s.id === t.sprint_id))
  const unit = b.estimate_kind === 'hours' ? 'h' : b.estimate_kind === 'points' ? 'pts' : ''
  const pts = (list) => list.reduce((a, t) => a + Number(t.estimate || 0), 0)

  const setSprint = async (t, sprintId) => {
    const r = await apiFetch(`/api/tasks/${t.id}`, { method: 'PUT', body: JSON.stringify({ sprint_id: sprintId || null }) })
    if (!r || r.error) { toast.error(r?.error || 'Could not move it'); return }
    reload()
  }
  const sprintAction = async (s, action) => {
    if (action === 'close') {
      const left = data.tasks.filter(t => t.sprint_id === s.id && !['done', 'rejected'].includes(t.status)).length
      if (!await toast.confirm({ title: `Close ${s.name}?`, message: left ? `${left} unfinished task${left === 1 ? '' : 's'} will move to the next planned sprint, or the backlog.` : 'Everything in it is finished.', confirmLabel: 'Close sprint' })) return
    }
    setBusy(true)
    const r = await apiFetch(`/api/tasks/sprints/${s.id}`, { method: 'PUT', body: JSON.stringify({ action }) })
    setBusy(false)
    if (!r || r.error) { toast.error(r?.error || 'Could not update the sprint'); return }
    if (action === 'close') toast.success(r.moved ? `${r.moved} task(s) moved to the ${r.to}` : 'Sprint closed')
    reload()
  }

  // Each person's load in the next sprint to start, against what they finished in recent sprints.
  const target = data.sprints.find(s => s.status === 'planned') || data.activeSprint
  const load = {}
  for (const t of open.filter(t => target && t.sprint_id === target.id)) {
    const k = t.assignee || ''
    load[k] = (load[k] || 0) + Number(t.estimate || 0)
  }

  const Row = ({ t }) => (
    <li className="tm-row">
      <button type="button" className="tm-row-open" onClick={() => onOpen(t)}>
        <span className="tm-muted">{t.board_key}-{t.number}</span>
        <span className="tm-row-title">{t.title}{t.sprint_id && data.activeSprint && t.sprint_id === data.activeSprint.id && t.status === 'todo' ? '' : ''}</span>
        {t.labels?.slice(0, 2).map(l => <span key={l} className="tm-label">{l}</span>)}
        <span className={`tm-st tm-st-${t.status}`}>{data.statusLabels[t.status]}</span>
      </button>
      <Avatar name={t.assignee} size={24} />
      <span className="tm-row-est">{t.estimate != null && unit ? `${num(t.estimate)} ${unit}` : <span className="tm-muted">no est.</span>}</span>
      {b.use_sprints && (
        <select aria-label={`Sprint for ${t.board_key}-${t.number}`} value={t.sprint_id || ''} onChange={e => setSprint(t, e.target.value)}>
          <option value="">Backlog</option>
          {data.sprints.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      )}
    </li>
  )

  return (
    <div className="tm-backlog">
      <div className="tm-backlog-main">
        {b.use_sprints && data.sprints.map(s => {
          const list = open.filter(t => t.sprint_id === s.id).concat(data.tasks.filter(t => t.sprint_id === s.id && ['done', 'rejected'].includes(t.status)))
          return (
            <section key={s.id} className={`tm-sprint-box${s.status === 'active' ? ' tm-active' : ''}`}>
              <div className="tm-sprint-head">
                <div><h2>{s.name} · {shortDay(s.starts_on)} – {shortDay(s.ends_on)} {s.status === 'active' && <span className="tm-now">running</span>}</h2>
                  {s.goal && <span className="tm-muted">Goal: {s.goal}</span>}</div>
                <span className="tm-muted">{list.length} task{list.length === 1 ? '' : 's'}{unit && ` · ${num(pts(list))} ${unit}`}</span>
                {data.canRun && s.status === 'planned' && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => sprintAction(s, 'start')}>Start sprint</button>}
                {data.canRun && s.status === 'active' && <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => sprintAction(s, 'close')}>Close sprint</button>}
              </div>
              <ul className="tm-rows">{list.map(t => <Row key={t.id} t={t} />)}{!list.length && <li className="tm-row-empty">Move tasks here from the backlog below</li>}</ul>
            </section>
          )
        })}
        {b.use_sprints && data.canRun && (
          planning
            ? <SprintForm apiFetch={apiFetch} toast={toast} boardId={b.id} onDone={() => { setPlanning(false); reload() }} onCancel={() => setPlanning(false)} />
            : <button type="button" className="btn btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setPlanning(true)}><Icon name="plus" size={14} /> Plan a sprint</button>
        )}
        <section className="tm-sprint-box">
          <div className="tm-sprint-head"><h2>{b.use_sprints ? 'Backlog' : 'All open tasks'} · {backlog.length}</h2>{unit && <span className="tm-muted">{num(pts(backlog))} {unit}</span>}</div>
          <ul className="tm-rows">{[...backlog].sort((a, c) => ['urgent', 'high', 'medium', 'low'].indexOf(a.priority) - ['urgent', 'high', 'medium', 'low'].indexOf(c.priority)).map(t => <Row key={t.id} t={t} />)}
            {!backlog.length && <li className="tm-row-empty">Nothing waiting</li>}</ul>
        </section>
      </div>
      {b.use_sprints && target && (
        <aside className="tm-load">
          <h3>Load in {target.name}</h3>
          {Object.keys(load).length === 0 && <p className="tm-muted">No tasks in it yet.</p>}
          {Object.entries(load).sort((a, c) => c[1] - a[1]).map(([who, n]) => (
            <div key={who || 'none'} className="tm-load-row">
              <div><span>{who ? handle(who) : 'Nobody assigned'}</span><b>{num(n)} {unit}</b></div>
              <div className="tm-progress"><span style={{ width: `${Math.min(100, (n / Math.max(...Object.values(load), 1)) * 100)}%` }} /></div>
            </div>
          ))}
          <p className="tm-muted" style={{ fontSize: 12 }}>Compare with each person's usual in Analytics before starting.</p>
        </aside>
      )}
    </div>
  )
}

function SprintForm({ apiFetch, toast, boardId, onDone, onCancel }) {
  const [f, setF] = useState({ name: '', goal: '', starts_on: '', ends_on: '' })
  const save = async (e) => {
    e.preventDefault()
    const r = await apiFetch(`/api/tasks/boards/${boardId}/sprints`, { method: 'POST', body: JSON.stringify(f) })
    if (!r || r.error) { toast.error(r?.error || 'Could not plan the sprint'); return }
    onDone()
  }
  return (
    <form className="tm-sprint-box tm-sprint-form" onSubmit={save}>
      <h2>Plan a sprint</h2>
      <div className="form-row">
        <div className="input-group"><label htmlFor="sp-name">Name</label><input id="sp-name" value={f.name} placeholder="Next number if left empty" onChange={e => setF({ ...f, name: e.target.value })} /></div>
        <div className="input-group"><label htmlFor="sp-start">Starts</label><input id="sp-start" type="date" value={f.starts_on} onChange={e => setF({ ...f, starts_on: e.target.value })} /></div>
        <div className="input-group"><label htmlFor="sp-end">Ends</label><input id="sp-end" type="date" value={f.ends_on} onChange={e => setF({ ...f, ends_on: e.target.value })} /></div>
      </div>
      <div className="input-group"><label htmlFor="sp-goal">Goal</label><input id="sp-goal" value={f.goal} placeholder="What this sprint is for, in a line" onChange={e => setF({ ...f, goal: e.target.value })} /></div>
      <div style={{ display: 'flex', gap: 10 }}><button type="submit" className="btn btn-primary btn-sm">Save sprint</button><button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>Cancel</button></div>
      <p className="tm-muted" style={{ fontSize: 12, margin: 0 }}>Dates left empty follow on from the last sprint, at the board's sprint length.</p>
    </form>
  )
}

/* ───────────────────────────── analytics ───────────────────────────── */

export function TaskAnalytics({ apiFetch, boardId, statusLabels }) {
  const [days, setDays] = useState(30)
  const [data, setData] = useState(null)
  useEffect(() => {
    setData(null)
    apiFetch(`/api/tasks/analytics?days=${days}${boardId ? `&board=${boardId}` : ''}`).then(r => { if (r && !r.error) setData(r) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, boardId])
  if (!data) return <div className="loader"><div className="spinner" /></div>
  const t = data.totals
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—')
  const bd = data.burndown
  const maxBurn = bd ? Math.max(bd.total, 1) : 1
  const maxSprint = Math.max(1, ...data.sprints.map(s => Math.max(Number(s.planned), Number(s.done))))
  return (
    <div className="tm-analytics">
      <div className="tm-an-bar">
        <span className="tm-muted">{data.scope === 'me' ? 'Your own work' : data.scope === 'lead' ? 'Boards you lead and are on' : 'Every board'}</span>
        <select aria-label="Period" value={days} onChange={e => setDays(Number(e.target.value))}>
          <option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option>
        </select>
      </div>
      <div className="tm-kpis">
        <div className="tm-kpi"><b>{t.finished}</b><span>Tasks finished</span><em className={t.finished >= t.before ? 'tm-up' : 'tm-down'}>{t.finished - t.before >= 0 ? '+' : ''}{t.finished - t.before} vs the {days} days before</em></div>
        <div className="tm-kpi"><b>{pct(t.on_time, t.with_due)}</b><span>Finished by the due date</span><em>{t.on_time} of {t.with_due} with a date</em></div>
        <div className="tm-kpi"><b>{t.avg_days == null ? '—' : `${num(t.avg_days.toFixed(1))} days`}</b><span>Average from start to done</span></div>
        <div className={`tm-kpi${t.overdue ? ' tm-kpi-bad' : ''}`}><b>{t.overdue}</b><span>Late now</span><em>{t.open} open in all</em></div>
      </div>
      <div className="tm-an-grid">
        {bd && (
          <section className="tm-an-card">
            <h3>{bd.sprint.name} — points left each day</h3>
            <div className="tm-burn" role="img" aria-label={`Points left in ${bd.sprint.name}`}>
              {bd.days.map((d, i) => {
                const ideal = bd.total - (bd.total / Math.max(1, bd.days.length - 1)) * i
                return (
                  <div key={d.day} className="tm-burn-col" title={`${shortDay(d.day)}: ${d.left == null ? 'to come' : `${num(d.left)} left`} · ideal ${num(ideal.toFixed(1))}`}>
                    <span className="tm-burn-ideal" style={{ bottom: `${(ideal / maxBurn) * 100}%` }} />
                    {d.left != null && <span className="tm-burn-bar" style={{ height: `${(d.left / maxBurn) * 100}%` }} />}
                  </div>
                )
              })}
            </div>
            <div className="tm-axis"><span>{shortDay(bd.sprint.starts_on)} · {num(bd.total)}</span><span>{shortDay(bd.sprint.ends_on)}</span></div>
          </section>
        )}
        {data.sprints.length > 0 && (
          <section className="tm-an-card">
            <h3>Planned vs done, recent sprints</h3>
            <div className="tm-vel" role="img" aria-label="Planned and done per sprint">
              {data.sprints.map(s => (
                <div key={s.id} className="tm-vel-col" title={`${s.name}: ${num(s.done)} of ${num(s.planned)}`}>
                  <div className="tm-vel-bars"><span className="tm-vel-plan" style={{ height: `${(Number(s.planned) / maxSprint) * 100}%` }} /><span className="tm-vel-done" style={{ height: `${(Number(s.done) / maxSprint) * 100}%` }} /></div>
                  <span>{s.name.replace('Sprint ', 'S')}</span>
                </div>
              ))}
            </div>
            <div className="tm-legend"><span><i className="tm-vel-plan" /> Planned</span><span><i className="tm-vel-done" /> Done</span></div>
          </section>
        )}
        <section className="tm-an-card">
          <h3>Where the work is</h3>
          {data.byStatus.map(s => (
            <div key={s.status} className="tm-load-row"><div><span>{statusLabels[s.status]}</span><b>{s.n}</b></div>
              <div className="tm-progress"><span className={`tm-st-bg-${s.status}`} style={{ width: `${(s.n / Math.max(...data.byStatus.map(x => x.n), 1)) * 100}%` }} /></div></div>
          ))}
        </section>
      </div>
      <section className="data-table-wrapper">
        <table className="data-table">
          <thead><tr><th>Person</th><th style={{ textAlign: 'center' }}>Open</th><th style={{ textAlign: 'center' }}>Finished</th><th style={{ textAlign: 'center' }}>On time</th><th style={{ textAlign: 'center' }}>Late now</th><th>Avg time to done</th><th>Boards</th></tr></thead>
          <tbody>
            {data.people.map(p => (
              <tr key={p.username}>
                <td className="cell-primary"><span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><Avatar name={p.username} size={26} /><b>{handle(p.username)}</b></span></td>
                <td data-label="Open" style={{ textAlign: 'center' }}>{p.open}</td>
                <td data-label="Finished" style={{ textAlign: 'center' }}>{p.finished}</td>
                <td data-label="On time" style={{ textAlign: 'center' }}>{pct(p.on_time, p.with_due)}</td>
                <td data-label="Late now" style={{ textAlign: 'center', color: p.overdue ? 'var(--danger)' : undefined }}>{p.overdue}</td>
                <td data-label="Avg time">{p.avg_days == null ? '—' : `${num(p.avg_days.toFixed(1))} days`}</td>
                <td data-label="Boards" style={{ fontSize: 12.5 }}>{(p.boards || []).join(', ')}</td>
              </tr>
            ))}
            {!data.people.length && <tr><td colSpan={7} className="tm-muted" style={{ textAlign: 'center' }}>No assigned tasks yet</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  )
}

/* ───────────────────────────── my tasks ───────────────────────────── */

function MyTasks({ apiFetch, toast, stamp, onOpen }) {
  const [data, setData] = useState(null)
  useEffect(() => {
    apiFetch('/api/tasks/mine').then(r => { if (!r || r.error) toast.error(r?.error || 'Could not load your tasks'); else setData(r) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp])
  if (!data) return <div className="loader"><div className="spinner" /></div>
  const t0 = today()
  const groups = [
    ['Late', data.tasks.filter(t => t.due_on && t.due_on < t0 && !['done', 'rejected', 'ideas'].includes(t.status))],
    ['Due today', data.tasks.filter(t => t.due_on === t0 && !['done', 'rejected'].includes(t.status))],
    ['Coming up', data.tasks.filter(t => !['done', 'rejected'].includes(t.status) && (!t.due_on || t.due_on > t0 || t.status === 'ideas'))],
    ['Finished this week', data.tasks.filter(t => ['done', 'rejected'].includes(t.status))],
  ]
  return (
    <>
      <header className="tm-head"><div><h1>My tasks</h1><p className="tm-muted">Everything assigned to you, across every board</p></div></header>
      {!data.tasks.length && <div className="empty-state"><div className="empty-icon">✅</div><p>Nothing assigned to you right now.</p></div>}
      {groups.filter(([, l]) => l.length).map(([name, list]) => (
        <section key={name} className="tm-sprint-box" style={{ marginBottom: 14 }}>
          <div className="tm-sprint-head"><h2 className={name === 'Late' ? 'tm-late' : ''}>{name} · {list.length}</h2></div>
          <ul className="tm-rows">
            {list.map(t => (
              <li key={t.id} className="tm-row">
                <button type="button" className="tm-row-open" onClick={() => onOpen(t)}>
                  <span className="tm-muted">{t.board_key}-{t.number}</span><span className="tm-row-title">{t.title}</span>
                  <span className="tm-muted">{t.board_name}</span>
                  <span className={`tm-st tm-st-${t.status}`}>{data.statusLabels[t.status]}</span>
                  {t.due_on && <span className={name === 'Late' ? 'tm-late' : 'tm-muted'}>due {shortDay(t.due_on)}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  )
}

/* ───────────────────────────── board settings ───────────────────────────── */

function BoardDialog({ board, users, apiFetch, toast, onClose, onSaved }) {
  const [f, setF] = useState(() => board ? {
    name: board.name, company: board.company, lead_username: board.lead_username || '', members: board.members || [],
    use_sprints: board.use_sprints, sprint_weeks: board.sprint_weeks, estimate_kind: board.estimate_kind,
    wip_in_progress: board.wip_limits?.in_progress || '',
  } : { key: '', name: '', company: 'both', lead_username: '', members: [], use_sprints: true, sprint_weeks: 2, estimate_kind: 'points', wip_in_progress: '' })
  const [saving, setSaving] = useState(false)
  const toggleMember = (u) => setF(x => ({ ...x, members: x.members.includes(u) ? x.members.filter(m => m !== u) : [...x.members, u] }))
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [onClose])

  const save = async (e) => {
    e.preventDefault()
    setSaving(true)
    const body = { ...f, wip_limits: { in_progress: f.wip_in_progress } }
    const r = await apiFetch(board ? `/api/tasks/boards/${board.id}` : '/api/tasks/boards', { method: board ? 'PUT' : 'POST', body: JSON.stringify(body) })
    setSaving(false)
    if (!r || r.error) { toast.error(r?.error || 'Could not save the board'); return }
    toast.success(board ? 'Board saved' : 'Board created')
    onSaved(r.id || board?.id)
  }
  const archive = async () => {
    if (!await toast.confirm({ title: `Archive ${board.name}?`, message: 'It disappears from everyone’s boards. Its tasks are kept.', danger: true, confirmLabel: 'Archive' })) return
    const r = await apiFetch(`/api/tasks/boards/${board.id}`, { method: 'PUT', body: JSON.stringify({ archived: true }) })
    if (r?.error) { toast.error(r.error); return }
    onSaved(null)
  }

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <form className="drawer" role="dialog" aria-modal="true" aria-label={board ? 'Board settings' : 'New board'} onSubmit={save}>
        <div className="drawer-header"><h2 style={{ margin: 0, fontSize: 18 }}>{board ? 'Board settings' : 'New board'}</h2>
          <button type="button" className="btn-icon" aria-label="Close" onClick={onClose}><Icon name="close" size={16} /></button></div>
        <div className="drawer-body">
          <div className="form-row">
            <div className="input-group"><label htmlFor="bd-name">Name</label><input id="bd-name" required value={f.name} placeholder="Marketing" onChange={e => setF({ ...f, name: e.target.value })} /></div>
            {!board && <div className="input-group"><label htmlFor="bd-key">Short key</label><input id="bd-key" required value={f.key} placeholder="MKT" maxLength={6} onChange={e => setF({ ...f, key: e.target.value.toUpperCase() })} /></div>}
          </div>
          <div className="form-row">
            <div className="input-group"><label htmlFor="bd-co">Company</label>
              <select id="bd-co" value={f.company} onChange={e => setF({ ...f, company: e.target.value })}><option value="both">Both</option><option value="normless">Normless</option><option value="crewfit">Crewfit</option></select></div>
            <div className="input-group"><label htmlFor="bd-lead">Lead</label>
              <select id="bd-lead" value={f.lead_username} onChange={e => setF({ ...f, lead_username: e.target.value })}><option value="">Nobody</option>{users.map(u => <option key={u} value={u}>{handle(u)}</option>)}</select></div>
          </div>
          <fieldset className="tm-fieldset">
            <legend>Members — who can see and work on this board</legend>
            <div className="tm-member-grid">
              {users.map(u => <label key={u}><input type="checkbox" checked={f.members.includes(u) || f.lead_username === u} disabled={f.lead_username === u} onChange={() => toggleMember(u)} />{handle(u)}</label>)}
            </div>
          </fieldset>
          <fieldset className="tm-fieldset">
            <legend>Planning</legend>
            <label className="tm-check-line"><input type="checkbox" checked={f.use_sprints} onChange={e => setF({ ...f, use_sprints: e.target.checked })} />Work in sprints (otherwise a plain board)</label>
            <div className="form-row">
              {f.use_sprints && <div className="input-group"><label htmlFor="bd-weeks">Sprint length</label>
                <select id="bd-weeks" value={f.sprint_weeks} onChange={e => setF({ ...f, sprint_weeks: Number(e.target.value) })}><option value={1}>1 week</option><option value={2}>2 weeks</option><option value={3}>3 weeks</option><option value={4}>4 weeks</option></select></div>}
              <div className="input-group"><label htmlFor="bd-est">Estimates</label>
                <select id="bd-est" value={f.estimate_kind} onChange={e => setF({ ...f, estimate_kind: e.target.value })}><option value="points">Points</option><option value="hours">Hours</option><option value="none">None</option></select></div>
              <div className="input-group"><label htmlFor="bd-wip">In progress limit</label><input id="bd-wip" type="number" min="0" value={f.wip_in_progress} placeholder="No limit" onChange={e => setF({ ...f, wip_in_progress: e.target.value })} /></div>
            </div>
          </fieldset>
          <p className="tm-muted" style={{ fontSize: 12.5, margin: 0 }}>Every board has the same columns: Ideas → To do → In progress → Hold → Blocked → Done → Rejected.</p>
        </div>
        <div className="drawer-footer">
          {board && <button type="button" className="btn btn-secondary" style={{ flex: '0 0 auto', color: 'var(--danger)' }} onClick={archive}>Archive</button>}
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : board ? 'Save' : 'Create board'}</button>
        </div>
      </form>
    </>
  )
}
