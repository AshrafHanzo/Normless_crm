import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react'
import Icon from './Icon'

// App-wide notifications, replacing the browser's alert()/confirm()/prompt().
//
//   const toast = useToast()
//   toast.success('Order saved')
//   toast.error('Failed to save', { title: 'Save failed' })
//   if (!await toast.confirm({ title: 'Delete order?', danger: true })) return
//
// confirm() returns a Promise<boolean> so call sites read like the native version they replace.
// It renders a real modal rather than a toast: a destructive question must block until answered,
// and a toast that auto-dismisses could silently mean "no".

const ToastContext = createContext(null)
export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>')
  return ctx
}

const TONE_ICON = { success: 'check', error: 'alert', warning: 'alert', info: 'info' }
const DEFAULT_MS = { success: 3500, info: 4000, warning: 5000, error: 6000 }

function ToastItem({ t, onDismiss }) {
  const [leaving, setLeaving] = useState(false)
  const close = useCallback(() => { setLeaving(true); setTimeout(() => onDismiss(t.id), 180) }, [t.id, onDismiss])

  useEffect(() => {
    if (t.duration === 0) return // sticky — caller dismisses it
    const timer = setTimeout(close, t.duration)
    return () => clearTimeout(timer)
  }, [t.duration, close])

  return (
    <div className={`toast toast-${t.tone} ${leaving ? 'toast-leaving' : ''}`} role={t.tone === 'error' ? 'alert' : 'status'}>
      <span className="toast-icon"><Icon name={TONE_ICON[t.tone] || 'info'} size={16} /></span>
      <div className="toast-body">
        {t.title && <div className="toast-title">{t.title}</div>}
        <div className="toast-msg">{t.message}</div>
      </div>
      <button className="toast-close" onClick={close} aria-label="Dismiss"><Icon name="close" size={14} /></button>
      {t.duration > 0 && <span className="toast-progress" style={{ animationDuration: `${t.duration}ms` }} />}
    </div>
  )
}

function ConfirmDialog({ req, onResolve }) {
  const [typed, setTyped] = useState('')
  const inputRef = useRef(null)
  const needsText = !!req.requireText
  const ready = !needsText || typed.trim() === String(req.requireText)

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onResolve(false)
      if (e.key === 'Enter' && ready && !needsText) onResolve(true)
    }
    window.addEventListener('keydown', onKey)
    setTimeout(() => inputRef.current?.focus(), 60)
    return () => window.removeEventListener('keydown', onKey)
  }, [ready, needsText, onResolve])

  return (
    <div className="confirm-overlay" onClick={() => onResolve(false)}>
      <div className="confirm-card" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className={`confirm-icon ${req.danger ? 'confirm-icon-danger' : ''}`}>
          <Icon name={req.danger ? 'alert' : 'info'} size={22} />
        </div>
        <h3 className="confirm-title">{req.title}</h3>
        {req.message && <p className="confirm-message">{req.message}</p>}
        {needsText && (
          <div className="input-group confirm-input">
            <label>Type <b>{req.requireText}</b> to confirm</label>
            <input ref={inputRef} value={typed} onChange={e => setTyped(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && ready) onResolve(true) }} autoComplete="off" />
          </div>
        )}
        <div className="confirm-actions">
          <button className="btn btn-secondary" onClick={() => onResolve(false)}>{req.cancelLabel || 'Cancel'}</button>
          <button className={`btn ${req.danger ? 'btn-danger' : 'btn-primary'}`} disabled={!ready} onClick={() => onResolve(true)}>
            {req.confirmLabel || 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const [confirmReq, setConfirmReq] = useState(null)
  const seq = useRef(0)
  const resolver = useRef(null)

  const dismiss = useCallback((id) => setToasts(list => list.filter(t => t.id !== id)), [])

  const push = useCallback((tone, message, opts = {}) => {
    const id = ++seq.current
    const duration = opts.duration !== undefined ? opts.duration : DEFAULT_MS[tone]
    // Cap the stack so a loop of failures can't bury the screen.
    setToasts(list => [...list.slice(-3), { id, tone, message, title: opts.title, duration }])
    return id
  }, [])

  const api = useRef({
    success: (m, o) => push('success', m, o),
    error: (m, o) => push('error', m, o),
    warning: (m, o) => push('warning', m, o),
    info: (m, o) => push('info', m, o),
    dismiss,
    confirm: (req) => new Promise(resolve => { resolver.current = resolve; setConfirmReq(req) }),
  }).current

  const resolveConfirm = useCallback((val) => {
    setConfirmReq(null)
    resolver.current?.(val)
    resolver.current = null
  }, [])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack">
        {toasts.map(t => <ToastItem key={t.id} t={t} onDismiss={dismiss} />)}
      </div>
      {confirmReq && <ConfirmDialog req={confirmReq} onResolve={resolveConfirm} />}
    </ToastContext.Provider>
  )
}
