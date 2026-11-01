import { useEffect, useRef, useState } from 'react'

/** Shared bits for the Team pages: money and dates, initials, and a small "why?" dialog. */

export const inr = (v) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(v) || 0)
export const num = (v) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(Number(v) || 0)
export const day = (v) => (v ? new Date(String(v).length === 10 ? `${v}T00:00:00` : v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—')
export const shortDay = (v) => (v ? new Date(String(v).length === 10 ? `${v}T00:00:00` : v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '')
export const when = (v) => (v ? new Date(v).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '')
export const handle = (u) => String(u || '').split('@')[0]
export const initials = (s) => {
  const parts = String(s || '').split('@')[0].split(/[\s._-]+/).filter(Boolean)
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || parts[0]?.[1] || '')).toUpperCase() || '?'
}
const pad = (n) => String(n).padStart(2, '0')
export const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
export const thisMonth = () => today().slice(0, 7)
export const monthLabel = (m) => new Date(`${String(m).slice(0, 7)}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })

// A colour per person, stable across pages, so the same face reads the same everywhere.
const AVATAR = ['#7c6cff', '#34d399', '#fbbf24', '#60a5fa', '#f472b6', '#f87171', '#a78bfa', '#2dd4bf']
export const avatarColor = (s) => AVATAR[[...String(s || '')].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR.length]

export function Avatar({ name, size = 26, title }) {
  if (!name) return <span className="tm-avatar tm-avatar-empty" style={{ width: size, height: size }} title="Nobody yet">—</span>
  const bg = avatarColor(name)
  return (
    <span className="tm-avatar" title={title || name}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4), background: bg, color: ['#34d399', '#fbbf24', '#2dd4bf'].includes(bg) ? '#0a0b10' : '#fff' }}>
      {initials(name)}
    </span>
  )
}

export const COMPANY_LABEL = { normless: 'Normless', crewfit: 'Crewfit', both: 'Both' }
export function CompanyPill({ company }) {
  return <span className={`tm-co tm-co-${company || 'both'}`}>{COMPANY_LABEL[company] || 'Both'}</span>
}

/**
 * Asks for a short reason (a task put on hold, a claim rejected). Resolves with the text, or
 * null when cancelled.
 */
export function ReasonDialog({ title, label = 'Reason', placeholder, confirmLabel = 'Save', danger, onDone }) {
  const [text, setText] = useState('')
  const box = useRef(null)
  useEffect(() => { box.current?.focus() }, [])
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') onDone(null) }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [onDone])
  return (
    <div className="modal-backdrop tm-modal-top" onClick={() => onDone(null)}>
      <form className="modal-card" role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}
        onSubmit={e => { e.preventDefault(); if (text.trim()) onDone(text.trim()) }}>
        <h3 style={{ margin: '0 0 14px' }}>{title}</h3>
        <div className="input-group">
          <label htmlFor="tm-reason">{label}</label>
          <textarea id="tm-reason" ref={box} rows={3} value={text} placeholder={placeholder} onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (text.trim()) onDone(text.trim()) } }} />
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-secondary" onClick={() => onDone(null)}>Cancel</button>
          <button type="submit" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={!text.trim()}>{confirmLabel}</button>
        </div>
      </form>
    </div>
  )
}

/** Renders a hook-driven ReasonDialog: const [ask, dialog] = useReason(); const why = await ask({ title }) */
export function useReason() {
  const [req, setReq] = useState(null)
  const ask = (opts) => new Promise(resolve => setReq({ ...opts, resolve }))
  const dialog = req ? <ReasonDialog {...req} onDone={(v) => { req.resolve(v); setReq(null) }} /> : null
  return [ask, dialog]
}
