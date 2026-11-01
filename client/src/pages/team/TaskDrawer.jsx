import { useEffect, useState } from 'react'
import Icon from '../../components/Icon'
import { Avatar, handle, day, when, shortDay, useReason } from './teamUi'

/**
 * One task opened: everything about it, edited in place. Each field saves as it changes (there
 * is no Save button to forget), and the server tells the assignee and watchers.
 */
const PRIORITIES = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['urgent', 'Urgent']]
const REPEATS = [['', 'Never'], ['day', 'Every day'], ['weekday', 'Every weekday'], ['week', 'Every week'], ['month', 'Every month']]
const NEEDS_REASON = ['hold', 'blocked', 'rejected']
const ACTIVITY = {
  created: () => 'created the task', status: (a) => `moved it from ${a.from_val} to ${a.to_val}`,
  assignee: (a) => (a.to_val ? `assigned it to ${handle(a.to_val)}` : 'removed the assignee'),
  due_on: (a) => `changed the due date to ${a.to_val ? shortDay(a.to_val) : 'none'}`, priority: (a) => `set priority to ${a.to_val}`,
  title: () => 'renamed it', estimate: (a) => `set the estimate to ${a.to_val || 'none'}`,
  sprint_id: (a) => (a.to_val ? 'moved it to a sprint' : 'moved it to the backlog'), files: (a) => `added ${a.to_val} file(s)`,
}

export default function TaskDrawer({ taskId, apiFetch, toast, me, users, onClose, onChanged }) {
  const [data, setData] = useState(null)
  const [draft, setDraft] = useState({})
  const [comment, setComment] = useState('')
  const [tab, setTab] = useState('comments')
  const [newItem, setNewItem] = useState('')
  const [ask, reasonDialog] = useReason()

  const load = async () => {
    const r = await apiFetch(`/api/tasks/${taskId}`)
    if (!r || r.error) { toast.error(r?.error || 'Could not open the task'); onClose(); return }
    setData(r)
    setDraft({ title: r.task.title, description: r.task.description || '', labels: (r.task.labels || []).join(', ') })
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [taskId])
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape' && !reasonDialog) onClose() }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [onClose, reasonDialog])

  const t = data?.task
  const save = async (patch) => {
    let r = await apiFetch(`/api/tasks/${taskId}`, { method: 'PUT', body: JSON.stringify(patch) })
    if (r?.overLimit && await toast.confirm({ title: 'Over the column limit', message: `${r.error}. Move it anyway?`, confirmLabel: 'Move anyway' })) {
      r = await apiFetch(`/api/tasks/${taskId}`, { method: 'PUT', body: JSON.stringify({ ...patch, overLimit: true }) })
    }
    if (!r || r.error) { if (!r?.overLimit) toast.error(r?.error || 'Could not save'); return false }
    setData(d => ({ ...d, task: r.task }))
    onChanged?.()
    load()
    return true
  }
  const setStatus = async (status) => {
    if (status === t.status) return
    let status_reason
    if (NEEDS_REASON.includes(status)) {
      status_reason = await ask({ title: `Why is it ${data.statusLabels[status].toLowerCase()}?`, placeholder: status === 'blocked' ? 'Blocked by…' : 'A short reason, shown on the card', confirmLabel: 'Move' })
      if (!status_reason) return
    }
    save({ status, status_reason })
  }
  const saveText = (key) => {
    const value = key === 'labels' ? draft.labels.split(',').map(s => s.trim()).filter(Boolean) : draft[key]
    const before = key === 'labels' ? (t.labels || []).join(', ') : (t[key] || '')
    if (String(draft[key]) !== String(before)) save({ [key]: value })
  }
  const checklist = t?.checklist || []
  const setChecklist = (list) => save({ checklist: list })

  const postComment = async (e) => {
    e.preventDefault()
    if (!comment.trim()) return
    const r = await apiFetch(`/api/tasks/${taskId}/comments`, { method: 'POST', body: JSON.stringify({ body: comment }) })
    if (!r || r.error) { toast.error(r?.error || 'Could not post'); return }
    setComment('')
    load()
  }
  const upload = async (files) => {
    if (!files?.length) return
    const fd = new FormData()
    for (const f of files) fd.append('files', f)
    const r = await apiFetch(`/api/tasks/${taskId}/files`, { method: 'POST', body: fd })
    if (!r || r.error) { toast.error(r?.error || 'Could not upload'); return }
    load()
  }
  const openFile = async (f) => {
    const r = await apiFetch(`/api/tasks/files/${f.id}`, { responseType: 'blob' })
    if (!r || r.error) { toast.error(r?.error || 'Could not open the file'); return }
    const url = URL.createObjectURL(r.blob)
    window.open(url, '_blank')
    setTimeout(() => URL.revokeObjectURL(url), 60000)
  }
  const removeFile = async (f) => {
    if (!await toast.confirm({ title: `Remove ${f.name}?`, danger: true, confirmLabel: 'Remove' })) return
    const r = await apiFetch(`/api/tasks/files/${f.id}`, { method: 'DELETE' })
    if (r?.error) { toast.error(r.error); return }
    load()
  }
  const remove = async () => {
    if (!await toast.confirm({ title: `Delete ${t.board_key}-${t.number}?`, message: 'The task, its comments and files go for good.', danger: true, confirmLabel: 'Delete' })) return
    const r = await apiFetch(`/api/tasks/${taskId}`, { method: 'DELETE' })
    if (r?.error) { toast.error(r.error); return }
    onChanged?.()
    onClose()
  }
  const watching = (t?.watchers || []).includes(me)
  const toggleWatch = async () => {
    const r = await apiFetch(`/api/tasks/${taskId}/watch`, { method: 'POST', body: JSON.stringify({ watching: !watching }) })
    if (r && !r.error) setData(d => ({ ...d, task: { ...d.task, watchers: r.watchers } }))
  }
  const copyLink = async () => {
    await navigator.clipboard.writeText(`${window.location.origin}/team/tasks?board=${t.board_id}&task=${t.id}`)
    toast.success('Link copied')
  }

  const members = data ? [...new Set([...(data.board?.members || []), data.board?.lead_username, t?.assignee].filter(Boolean))] : []
  const estimateKind = data?.board?.estimate_kind

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <aside className="drawer tm-task-drawer" role="dialog" aria-modal="true" aria-label={t ? `${t.board_key}-${t.number}` : 'Task'}>
        {!t ? <div className="loader"><div className="spinner" /></div> : (
          <>
            <div className="drawer-header">
              <span className="tm-ref">{t.board_key}-{t.number} <span>· {t.board_name}</span></span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" className={`mini-btn${watching ? ' tm-on' : ''}`} onClick={toggleWatch} title="Get told about changes to this task">
                  {watching ? 'Watching' : 'Watch'} · {(t.watchers || []).length}
                </button>
                <button type="button" className="mini-btn" onClick={copyLink}>Copy link</button>
                <button type="button" className="btn-icon" aria-label="Close" onClick={onClose}><Icon name="close" size={16} /></button>
              </div>
            </div>
            <div className="drawer-body tm-task-body">
              <textarea className="tm-title-input" aria-label="Title" rows={1} value={draft.title}
                onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} onBlur={() => saveText('title')}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } }} />
              {t.status_reason && <p className={`tm-reason tm-reason-${t.status}`}>{data.statusLabels[t.status]}: {t.status_reason}</p>}

              <div className="tm-fields">
                <label className="tm-field"><span>Status</span>
                  <select className={`tm-status-select tm-st-${t.status}`} value={t.status} onChange={e => setStatus(e.target.value)}>
                    {data.statuses.map(s => <option key={s} value={s}>{data.statusLabels[s]}</option>)}
                  </select></label>
                <label className="tm-field"><span>Assignee</span>
                  <select value={t.assignee || ''} onChange={e => save({ assignee: e.target.value || null })}>
                    <option value="">Nobody</option>
                    {[...new Set([...members, ...users])].map(u => <option key={u} value={u}>{handle(u)}</option>)}
                  </select></label>
                <label className="tm-field"><span>Due</span>
                  <input type="date" value={t.due_on || ''} onChange={e => save({ due_on: e.target.value || null })} /></label>
                <label className="tm-field"><span>Priority</span>
                  <select value={t.priority} onChange={e => save({ priority: e.target.value })}>
                    {PRIORITIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select></label>
                {estimateKind !== 'none' && (
                  <label className="tm-field"><span>Estimate ({estimateKind})</span>
                    <input type="number" min="0" step="0.5" defaultValue={t.estimate ?? ''} key={`e${t.estimate}`}
                      onBlur={e => { if (String(e.target.value) !== String(t.estimate ?? '')) save({ estimate: e.target.value }) }} /></label>
                )}
                {data.board?.use_sprints && (
                  <label className="tm-field"><span>Sprint</span>
                    <select value={t.sprint_id || ''} onChange={e => save({ sprint_id: e.target.value || null })}>
                      <option value="">Backlog</option>
                      {data.sprints.map(s => <option key={s.id} value={s.id}>{s.name}{s.status === 'active' ? ' (now)' : ''}</option>)}
                    </select></label>
                )}
                <label className="tm-field"><span>Repeats</span>
                  <select value={t.repeat?.every || ''} onChange={e => save({ repeat: e.target.value ? { every: e.target.value, next_on: t.repeat?.next_on || t.due_on || null } : null })}>
                    {REPEATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select></label>
                {t.repeat?.every && (
                  <label className="tm-field"><span>Next copy on</span>
                    <input type="date" value={t.repeat.next_on || ''} onChange={e => save({ repeat: { ...t.repeat, next_on: e.target.value || null } })} /></label>
                )}
                <label className="tm-field tm-field-wide"><span>Labels (comma between)</span>
                  <input value={draft.labels} placeholder="Content, Ads" onChange={e => setDraft(d => ({ ...d, labels: e.target.value }))} onBlur={() => saveText('labels')} /></label>
              </div>

              <section className="tm-block">
                <h4>Description</h4>
                <textarea rows={5} value={draft.description} placeholder="What needs doing, and what done looks like"
                  onChange={e => setDraft(d => ({ ...d, description: e.target.value }))} onBlur={() => saveText('description')} />
              </section>

              <section className="tm-block">
                <h4>Checklist {checklist.length > 0 && <span>· {checklist.filter(i => i.done).length} of {checklist.length}</span>}</h4>
                {checklist.length > 0 && <div className="tm-progress"><span style={{ width: `${(checklist.filter(i => i.done).length / checklist.length) * 100}%` }} /></div>}
                {checklist.map((item, i) => (
                  <div key={i} className="tm-check">
                    <label><input type="checkbox" checked={item.done} onChange={() => setChecklist(checklist.map((x, j) => j === i ? { ...x, done: !x.done } : x))} />
                      <span className={item.done ? 'tm-done' : ''}>{item.text}</span></label>
                    <button type="button" className="btn-icon" aria-label={`Remove ${item.text}`} onClick={() => setChecklist(checklist.filter((_, j) => j !== i))}><Icon name="close" size={13} /></button>
                  </div>
                ))}
                <form className="tm-inline-add" onSubmit={e => { e.preventDefault(); if (newItem.trim()) { setChecklist([...checklist, { text: newItem.trim(), done: false }]); setNewItem('') } }}>
                  <input value={newItem} placeholder="Add an item" aria-label="New checklist item" onChange={e => setNewItem(e.target.value)} />
                  <button type="submit" className="btn btn-secondary btn-sm" disabled={!newItem.trim()}>Add</button>
                </form>
              </section>

              {data.subtasks.length > 0 && (
                <section className="tm-block">
                  <h4>Sub-tasks</h4>
                  {data.subtasks.map(s => <div key={s.id} className="tm-sub">{t.board_key}-{s.number} · {s.title} <span>{data.statusLabels[s.status]} · {handle(s.assignee) || 'nobody'}</span></div>)}
                </section>
              )}

              <section className="tm-block">
                <h4>Files {data.files.length > 0 && <span>· {data.files.length}</span>}</h4>
                <div className="tm-files">
                  {data.files.map(f => (
                    <div key={f.id} className="tm-file">
                      <button type="button" className="tm-file-open" onClick={() => openFile(f)}><Icon name="note" size={14} /> {f.name}</button>
                      <button type="button" className="btn-icon" aria-label={`Remove ${f.name}`} onClick={() => removeFile(f)}><Icon name="close" size={13} /></button>
                    </div>
                  ))}
                  <label className="tm-file-drop" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); upload(e.dataTransfer.files) }}>
                    <input type="file" multiple hidden onChange={e => { upload(e.target.files); e.target.value = '' }} />
                    Drop files or <u>choose</u>
                  </label>
                </div>
              </section>

              <section className="tm-block">
                <div className="tm-tabs" role="tablist">
                  <button type="button" role="tab" aria-selected={tab === 'comments'} className={tab === 'comments' ? 'on' : ''} onClick={() => setTab('comments')}>Comments · {data.comments.length}</button>
                  <button type="button" role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>History</button>
                </div>
                {tab === 'comments' ? (
                  <>
                    {data.comments.map(c => (
                      <div key={c.id} className="tm-comment">
                        <Avatar name={c.author} size={30} />
                        <div><b>{handle(c.author)}</b> <span className="tm-muted">· {when(c.created_at)}</span>
                          <p>{c.body.split(/(@[A-Za-z0-9._+-]+)/g).map((part, i) => part.startsWith('@') ? <mark key={i}>{part}</mark> : part)}</p></div>
                      </div>
                    ))}
                    <form className="tm-comment-form" onSubmit={postComment}>
                      <label className="sr-only" htmlFor="tm-comment">Write a comment</label>
                      <textarea id="tm-comment" rows={3} value={comment} placeholder="Write a comment — type @ and a name to tell someone"
                        onChange={e => setComment(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) postComment(e) }} />
                      <div className="tm-mention-hint">{members.map(m => `@${handle(m)}`).join('  ')}</div>
                      <button type="submit" className="btn btn-primary btn-sm" disabled={!comment.trim()}>Comment</button>
                    </form>
                  </>
                ) : (
                  <ul className="tm-history">
                    {data.activity.map((a, i) => <li key={i}><b>{handle(a.actor) || 'CRM'}</b> {(ACTIVITY[a.what] || (() => a.what))(a)} <span className="tm-muted">· {when(a.created_at)}</span></li>)}
                  </ul>
                )}
              </section>
              <p className="tm-muted" style={{ fontSize: 12 }}>Created by {handle(t.reporter)} on {day(t.created_at)}{t.done_at ? ` · finished ${day(t.done_at)}` : ''}</p>
            </div>
            <div className="drawer-footer">
              <button type="button" className="btn btn-secondary" style={{ color: 'var(--danger)', flex: '0 0 auto' }} onClick={remove}><Icon name="trash" size={14} /> Delete</button>
              <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
            </div>
          </>
        )}
      </aside>
      {reasonDialog}
    </>
  )
}
