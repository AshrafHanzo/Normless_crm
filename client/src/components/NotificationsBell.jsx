import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApi } from '../App'
import Icon from './Icon'

const when = (v) => {
  if (!v) return ''
  const d = new Date(v)
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 24 * 60) return `${Math.round(mins / 60)}h ago`
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
}

/**
 * Your inbox: who named you in a comment, and who answered you.
 *
 * In the sidebar rather than on a page of its own, because the whole value is being told without
 * going to look — someone asking a question on an order you cannot see is a question nobody
 * answers. Polled rather than pushed: this is a message from a colleague, not a fire alarm, and
 * a socket per open tab is a lot of machinery for something checked every couple of minutes.
 */
export default function NotificationsBell({ collapsed }) {
  const apiFetch = useApi()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState([])
  const [unread, setUnread] = useState(0)
  const boxRef = useRef(null)

  const load = async () => {
    const r = await apiFetch('/api/notifications?limit=20')
    if (r && !r.error) { setItems(r.notifications || []); setUnread(r.unread || 0) }
  }

  useEffect(() => {
    let live = true
    const tick = async () => { if (live) await load() }
    tick()
    const t = setInterval(tick, 60000)
    return () => { live = false; clearInterval(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Clicking anywhere else closes it — a panel that stays open over the menu is in the way.
  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const openPanel = async () => {
    const next = !open
    setOpen(next)
    if (next) await load()
  }

  const markAll = async () => {
    await apiFetch('/api/notifications/read', { method: 'POST', body: JSON.stringify({}) })
    setItems(list => list.map(n => ({ ...n, read_at: n.read_at || new Date().toISOString() })))
    setUnread(0)
  }

  const go = async (n) => {
    if (!n.read_at) {
      await apiFetch('/api/notifications/read', { method: 'POST', body: JSON.stringify({ ids: [n.id] }) })
      setItems(list => list.map(x => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)))
      setUnread(u => Math.max(0, u - 1))
    }
    setOpen(false)
    if (n.link) navigate(n.link)
  }

  return (
    <div className="notif" ref={boxRef}>
      <button type="button" className={`notif-btn${unread ? ' notif-btn-live' : ''}`} onClick={openPanel}
        title={unread ? `${unread} unread` : 'Notifications'} aria-label="Notifications" aria-expanded={open}>
        <Icon name="bell" size={16} />
        {!collapsed && <span className="notif-btn-label">Notifications</span>}
        {unread > 0 && <span className="nav-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>

      {open && (
        <div className="notif-panel" role="dialog" aria-label="Notifications">
          <div className="notif-head">
            <b>Notifications</b>
            {unread > 0 && <button type="button" className="comment-act" onClick={markAll}>Mark all read</button>}
          </div>
          {items.length ? (
            <ul className="notif-list">
              {items.map(n => (
                <li key={n.id}>
                  <button type="button" className={`notif-item${n.read_at ? '' : ' notif-unread'}`} onClick={() => go(n)}>
                    <span className="notif-title">{n.title}</span>
                    {n.body && <span className="notif-body">{n.body}</span>}
                    <span className="notif-when">{when(n.created_at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="notif-empty">Nothing yet. You'll hear when someone names you in a comment or replies to one of yours.</p>
          )}
        </div>
      )}
    </div>
  )
}
