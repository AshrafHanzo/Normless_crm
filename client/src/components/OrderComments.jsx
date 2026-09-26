import { useState, useEffect, useRef, useMemo } from 'react'
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
const handleOf = (name) => (name ? String(name).split('@')[0] : '')
const who = (name) => handleOf(name) || 'Imported note'
const initials = (name) => (name ? handleOf(name).slice(0, 2).toUpperCase() : '—')

/**
 * A comment with its @mentions picked out.
 *
 * Highlighted against the same team list the picker uses, so a stray "@9am" stays plain text and
 * a real name stands out — the point of a mention is that the person it names can find it.
 */
function CommentText({ body, handles, meHandle }) {
  const parts = String(body || '').split(/(@[A-Za-z0-9._+-]+)/g)
  return (
    <div className="comment-text">
      {parts.map((part, i) => {
        if (part[0] !== '@') return <span key={i}>{part}</span>
        const token = part.slice(1).toLowerCase().replace(/[._+-]+$/, '')
        if (!handles.has(token)) return <span key={i}>{part}</span>
        const tail = part.slice(1 + token.length)
        return (
          <span key={i}>
            <span className={`mention${token === meHandle ? ' mention-me' : ''}`}>@{token}</span>{tail}
          </span>
        )
      })}
    </div>
  )
}

/**
 * The conversation about one order: comments, replies to them, and @mentions that notify.
 *
 * Replaces the single "internal notes" box, which had no author and no date. Each comment posts
 * on its own rather than with the order — a note about a delivery should not wait for someone to
 * finish editing prices, and must not be lost if they close the drawer without saving.
 *
 * On a brand-new order there is nothing to attach to yet, so what is typed is handed to the
 * parent, which posts it once the order has an id.
 */
export default function OrderComments({ entity = 'crewfit_order', orderId, draft, onDraft }) {
  const base = orderId ? `/api/comments/${entity}/${orderId}` : null
  const apiFetch = useApi()
  const toast = useToast()
  const { user } = useAuth()
  // Removing a comment is the owner's alone — it is a record of what the team knew and when, and
  // the author is usually the one who would most want it gone.
  const canDelete = user?.role === 'owner'
  const meHandle = handleOf(user?.username).toLowerCase()

  const [comments, setComments] = useState([])
  const [team, setTeam] = useState([])
  const [loading, setLoading] = useState(!!orderId)
  const [replyTo, setReplyTo] = useState(null)
  const endRef = useRef(null)

  const handles = useMemo(() => new Set(team.map(t => t.handle)), [team])

  useEffect(() => {
    let cancelled = false
    if (!base) { setTeam([]); return () => { cancelled = true } }
    apiFetch(`${base}/team`).then(r => { if (!cancelled && r && !r.error) setTeam(r.team || []) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base])

  useEffect(() => {
    let cancelled = false
    if (!orderId) { setComments([]); setLoading(false); return () => { cancelled = true } }
    setLoading(true)
    apiFetch(base).then(res => {
      if (cancelled) return
      if (res && !res.error) setComments(res.comments || [])
      setLoading(false)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId])

  // Top-level comments, each with the replies that hang off it.
  const threads = useMemo(() => {
    const roots = comments.filter(c => !c.parent_id)
    const byParent = new Map()
    for (const c of comments) {
      if (!c.parent_id) continue
      byParent.set(c.parent_id, [...(byParent.get(c.parent_id) || []), c])
    }
    return roots.map(root => ({ root, replies: byParent.get(root.id) || [] }))
  }, [comments])

  const post = async (body, parentId) => {
    if (!orderId) { onDraft?.(body); return true }
    const res = await apiFetch(base, {
      method: 'POST', body: JSON.stringify({ body, ...(parentId ? { parent_id: parentId } : {}) }),
    })
    if (!res || res.error) { toast.error(res?.error || 'Could not post that'); return false }
    setComments(c => [...c, res.comment])
    setReplyTo(null)
    if (res.comment.mentions?.length) {
      toast.info(`${res.comment.mentions.map(handleOf).join(', ')} notified`)
    }
    requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: 'nearest' }))
    return true
  }

  const remove = async (c) => {
    const replies = comments.filter(x => x.parent_id === c.id).length
    if (!await toast.confirm({
      title: 'Delete this comment?',
      message: replies ? `${c.body.slice(0, 120)}\n\nIts ${replies} ${replies === 1 ? 'reply goes' : 'replies go'} too.` : c.body.slice(0, 160),
      confirmLabel: 'Delete', cancelLabel: 'Keep it', danger: true,
    })) return
    const res = await apiFetch(`${base}/${c.id}`, { method: 'DELETE' })
    if (!res || res.error) { toast.error(res?.error || 'Failed'); return }
    setComments(list => list.filter(x => x.id !== c.id && x.parent_id !== c.id))
  }

  const Comment = ({ c, isReply }) => {
    const mine = c.created_by && c.created_by === user?.username
    const namesMe = (c.mentions || []).includes(user?.username)
    return (
      <div className={`comment${isReply ? ' comment-reply' : ''}${namesMe ? ' comment-names-me' : ''}`}>
        <span className="comment-avatar" title={c.created_by || 'Imported from the old notes box'}>{initials(c.created_by)}</span>
        <div className={`comment-body${mine ? ' comment-mine' : ''}`}>
          <div className="comment-head">
            <b>{who(c.created_by)}</b>
            <span className="comment-when">{when(c.created_at)}</span>
            {orderId && <button type="button" className="comment-act" onClick={() => setReplyTo(c)}>Reply</button>}
            {canDelete && <button type="button" className="comment-del" onClick={() => remove(c)} title="Delete this comment">✕</button>}
          </div>
          <CommentText body={c.body} handles={handles} meHandle={meHandle} />
        </div>
      </div>
    )
  }

  return (
    <div className="order-comments">
      {loading ? (
        <div className="loader"><div className="spinner" /></div>
      ) : threads.length ? (
        <div className="comment-list">
          {threads.map(({ root, replies }) => (
            <div className="comment-thread" key={root.id}>
              <Comment c={root} />
              {replies.map(r => <Comment key={r.id} c={r} isReply />)}
            </div>
          ))}
          <div ref={endRef} />
        </div>
      ) : (
        <p className="comment-empty">No comments yet — anything the team should know about this order goes here. Type @ to name someone and they are notified.</p>
      )}

      {draft && <div className="comment-draft">First comment, posted when the order is created: “{draft}”</div>}

      <Composer
        key={replyTo?.id || 'new'}
        team={team}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        onSubmit={(text) => post(text, replyTo ? replyTo.id : null)}
        placeholder={orderId
          ? 'Write a comment… type @ to name someone'
          : 'Write the first comment — it posts when the order is created'}
        cta={orderId ? 'Post' : 'Keep for the order'}
      />
    </div>
  )
}

/**
 * The box you type in, with the @ picker.
 *
 * The picker opens on an @ that starts a word and filters as you type. Enter takes the highlighted
 * name rather than posting, because a half-typed handle sent by accident notifies the wrong person
 * — or nobody.
 */
function Composer({ team, replyTo, onCancelReply, onSubmit, placeholder, cta }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [picker, setPicker] = useState(null)   // { query, at, index }
  const ref = useRef(null)

  const matches = useMemo(() => {
    if (!picker) return []
    const q = picker.query.toLowerCase()
    // Names that START with what was typed come first: typing "@zz" and pressing Enter should
    // take zz-anu, not the ashrafdamzz12 that merely contains those letters.
    const hits = team.filter(t => t.handle.includes(q))
    return [...hits.filter(t => t.handle.startsWith(q)), ...hits.filter(t => !t.handle.startsWith(q))].slice(0, 6)
  }, [picker, team])

  const readPicker = (el) => {
    const upto = el.value.slice(0, el.selectionStart)
    // Only an @ that begins a word, and only while it has no space after it.
    const m = /(^|\s)@([A-Za-z0-9._+-]*)$/.exec(upto)
    setPicker(m ? { query: m[2], at: upto.length - m[2].length - 1, index: 0 } : null)
  }

  const choose = (member) => {
    const el = ref.current
    if (!el || !picker) return
    const before = text.slice(0, picker.at)
    const after = text.slice(el.selectionStart)
    const next = `${before}@${member.handle} ${after}`
    setText(next)
    setPicker(null)
    requestAnimationFrame(() => {
      el.focus()
      const caret = before.length + member.handle.length + 2
      el.setSelectionRange(caret, caret)
    })
  }

  const send = async () => {
    const body = text.trim()
    if (!body || busy) return
    setBusy(true)
    const ok = await onSubmit(body)
    setBusy(false)
    if (ok) setText('')
  }

  const onKeyDown = (e) => {
    if (picker && matches.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setPicker(p => ({ ...p, index: (p.index + 1) % matches.length })); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setPicker(p => ({ ...p, index: (p.index - 1 + matches.length) % matches.length })); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(matches[picker.index]); return }
      if (e.key === 'Escape') { setPicker(null); return }
    }
    // Enter sends, Shift+Enter starts a line — what everyone expects of a comment box.
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  return (
    <div className="comment-compose-wrap">
      {replyTo && (
        <div className="comment-replying">
          Replying to <b>{who(replyTo.created_by)}</b>: “{replyTo.body.slice(0, 60)}{replyTo.body.length > 60 ? '…' : ''}”
          <button type="button" className="comment-act" onClick={onCancelReply}>Cancel</button>
        </div>
      )}
      <div className="comment-compose">
        <div className="comment-input">
          <AutoTextarea
            inputRef={el => { ref.current = el }}
            value={text}
            minRows={2}
            onChange={e => { setText(e.target.value); readPicker(e.target) }}
            onKeyUp={e => readPicker(e.target)}
            onBlur={() => setTimeout(() => setPicker(null), 150)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
          />
          {picker && !!matches.length && (
            <ul className="mention-picker" role="listbox">
              {matches.map((m, i) => (
                <li key={m.username}>
                  <button type="button" className={i === picker.index ? 'active' : ''} onMouseDown={e => { e.preventDefault(); choose(m) }}>
                    <span className="mention-handle">@{m.handle}</span>
                    <span className="mention-name">{m.username}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button type="button" className="btn btn-secondary" onClick={send} disabled={busy || !text.trim()}>
          {busy ? 'Posting…' : replyTo ? 'Reply' : cta}
        </button>
      </div>
    </div>
  )
}
