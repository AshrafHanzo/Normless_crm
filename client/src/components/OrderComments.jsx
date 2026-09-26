import { useState, useEffect, useRef } from 'react'
import { useApi, useAuth } from '../App'
import { useToast } from './Toast'
import AutoTextarea from './AutoTextarea'

const when = (v) => {
  if (!v) return ''
  const d = new Date(v)
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 24 * 60) return `${Math.round(mins / 60)}h ago`
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

// "anu@normless.store" reads as "anu" in a thread where everyone is from the same company.
const who = (name) => (name ? String(name).split('@')[0] : 'Imported note')
const initials = (name) => (name ? who(name).slice(0, 2).toUpperCase() : '—')

/**
 * The conversation about one order.
 *
 * Replaces the single "internal notes" box, which had no author and no date: the second person to
 * write in it either overwrote the first or left a paragraph nobody could attribute. Each comment
 * is posted on its own, not with the order — a note about a delivery should not wait for someone
 * to finish editing prices, and it must not be lost if they close the drawer without saving.
 *
 * On a brand-new order there is nothing to attach to yet, so what is typed is handed to the
 * parent, which posts it once the order has an id.
 */
export default function OrderComments({ orderId, draft, onDraft }) {
  const apiFetch = useApi()
  const toast = useToast()
  const { user } = useAuth()
  // Removing a comment is the owner's alone — it is a record of what the team knew and when, and
  // the author is usually the one who would most want it gone.
  const canDelete = user?.role === 'owner'

  const [comments, setComments] = useState([])
  const [loading, setLoading] = useState(!!orderId)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const endRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    if (!orderId) { setComments([]); setLoading(false); return () => { cancelled = true } }
    setLoading(true)
    apiFetch(`/api/crewfit/orders/${orderId}/comments`).then(res => {
      if (cancelled) return
      if (res && !res.error) setComments(res.comments || [])
      setLoading(false)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId])

  const post = async () => {
    const body = text.trim()
    if (!body || busy) return
    if (!orderId) { setText(''); onDraft?.(body); return }   // parent posts it after the order exists
    setBusy(true)
    const res = await apiFetch(`/api/crewfit/orders/${orderId}/comments`, {
      method: 'POST', body: JSON.stringify({ body }),
    })
    setBusy(false)
    if (!res || res.error) { toast.error(res?.error || 'Could not post that'); return }
    setComments(c => [...c, res.comment])
    setText('')
    requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: 'nearest' }))
  }

  const remove = async (c) => {
    if (!await toast.confirm({
      title: 'Delete this comment?', message: c.body.slice(0, 160),
      confirmLabel: 'Delete', cancelLabel: 'Keep it', danger: true,
    })) return
    const res = await apiFetch(`/api/crewfit/comments/${c.id}`, { method: 'DELETE' })
    if (!res || res.error) { toast.error(res?.error || 'Failed'); return }
    setComments(list => list.filter(x => x.id !== c.id))
  }

  // Enter sends, Shift+Enter starts a line — what everyone expects of a comment box.
  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); post() }
  }

  return (
    <div className="order-comments">
      {loading ? (
        <div className="loader"><div className="spinner" /></div>
      ) : comments.length ? (
        <div className="comment-list">
          {comments.map(c => {
            const mine = c.created_by && c.created_by === user?.username
            return (
              <div className={`comment${mine ? ' comment-mine' : ''}`} key={c.id}>
                <span className="comment-avatar" title={c.created_by || 'Imported from the old notes box'}>{initials(c.created_by)}</span>
                <div className="comment-body">
                  <div className="comment-head">
                    <b>{who(c.created_by)}</b>
                    <span className="comment-when">{when(c.created_at)}</span>
                    {canDelete && (
                      <button type="button" className="comment-del" onClick={() => remove(c)} title="Delete this comment">✕</button>
                    )}
                  </div>
                  <div className="comment-text">{c.body}</div>
                </div>
              </div>
            )
          })}
          <div ref={endRef} />
        </div>
      ) : (
        <p className="comment-empty">No comments yet — anything the team should know about this order goes here.</p>
      )}

      {draft && (
        <div className="comment-draft">First comment, posted when the order is created: “{draft}”</div>
      )}

      <div className="comment-compose">
        <AutoTextarea
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={orderId ? 'Write a comment… (Enter to post, Shift+Enter for a new line)' : 'Write the first comment — it posts when the order is created'}
        />
        <button type="button" className="btn btn-secondary" onClick={post} disabled={busy || !text.trim()}>
          {busy ? 'Posting…' : orderId ? 'Post' : 'Keep for the order'}
        </button>
      </div>
    </div>
  )
}
