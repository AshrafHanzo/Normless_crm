import { useCallback, useEffect, useRef, useState } from 'react'
import { useApi } from '../App'
import { useToast } from './Toast'
import Icon from './Icon'

/**
 * A team guide (server/routes/guides.js): an HTML page of how-we-work, shown in a sandboxed frame
 * so its styles never touch the CRM's and no script in a replaced file can run. Admins can replace
 * it with their own HTML file, or go back to the original.
 *
 * `inline` sizes the frame to the guide and puts it in the page (a tab); otherwise it opens as a
 * large panel over the screen, closed with Esc.
 */
export default function TeamGuide({ guideKey, inline = false, onClose }) {
  const apiFetch = useApi()
  const toast = useToast()
  const [guide, setGuide] = useState(null)
  const [busy, setBusy] = useState(false)
  const [height, setHeight] = useState(600)
  const frame = useRef(null)
  const picker = useRef(null)

  const load = useCallback(() => {
    apiFetch(`/api/guides/${guideKey}`).then(r => {
      if (!r || r.error) { toast.error(r?.error || 'Could not load the guide'); return }
      setGuide(r)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guideKey])
  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (inline || !onClose) return
    const esc = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [inline, onClose])

  // The guides follow the CRM's theme rather than the computer's: the CRM is dark unless
  // light-mode is on, and the guides read data-theme on their root.
  const theme = document.documentElement.classList.contains('light-mode') ? 'light' : 'dark'
  const doc = guide && (/<html[\s>]/i.test(guide.html) ? guide.html
    : `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><base target="_blank"></head><body style="margin:0">${guide.html}</body></html>`)

  // Inline, the frame grows to the guide so the page scrolls rather than a box inside it — and
  // keeps growing as its fonts arrive or the window narrows and the text rewraps.
  const watcher = useRef(null)
  const fit = () => {
    if (!inline) return
    const d = frame.current?.contentDocument
    if (!d?.body) return
    const measure = () => setHeight(d.documentElement.scrollHeight + 8)
    measure()
    watcher.current?.disconnect()
    watcher.current = new ResizeObserver(measure)
    watcher.current.observe(d.body)
  }
  useEffect(() => () => watcher.current?.disconnect(), [])

  const replace = async (file) => {
    if (!file) return
    if (!/\.html?$/i.test(file.name)) { toast.error('Choose an HTML file (.html)'); return }
    if (file.size > 3 * 1024 * 1024) { toast.error('The file is over 3 MB'); return }
    const ok = await toast.confirm({ title: `Replace the ${guide.title.toLowerCase()}?`,
      message: `Everyone will see ${file.name} from now on. You can restore the original at any time.`, confirmLabel: 'Replace' })
    if (!ok) return
    setBusy(true)
    const r = await apiFetch(`/api/guides/${guideKey}`, { method: 'PUT', body: JSON.stringify({ html: await file.text(), file_name: file.name }) })
    setBusy(false)
    if (r?.error) { toast.error(r.error); return }
    toast.success('Guide replaced')
    load()
  }

  const restore = async () => {
    const ok = await toast.confirm({ title: 'Restore the original guide?', message: `${guide.replaced?.file_name || 'The uploaded file'} will be removed.`, confirmLabel: 'Restore' })
    if (!ok) return
    setBusy(true)
    const r = await apiFetch(`/api/guides/${guideKey}`, { method: 'DELETE' })
    setBusy(false)
    if (r?.error) { toast.error(r.error); return }
    toast.success('Original guide restored')
    load()
  }

  const download = () => {
    const url = URL.createObjectURL(new Blob([guide.html], { type: 'text/html' }))
    const a = document.createElement('a')
    a.href = url; a.download = guide.replaced?.file_name || `${guideKey}.html`
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10000)
  }

  const bar = guide && (
    <div className="tg-bar">
      <div className="tg-title">
        <Icon name="info" size={16} />
        <b>{guide.title}</b>
        {guide.replaced && (
          <span className="tg-note">
            Replaced{guide.replaced.by ? ` by ${guide.replaced.by}` : ''}
            {guide.replaced.at ? ` on ${new Date(guide.replaced.at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}
          </span>
        )}
      </div>
      <div className="tg-actions">
        {guide.canReplace && (
          <>
            <button type="button" className="mini-btn" title="Download this guide as an HTML file to edit it" onClick={download}>Download</button>
            <button type="button" className="mini-btn" disabled={busy} onClick={() => picker.current?.click()}>Replace…</button>
            {guide.replaced && <button type="button" className="mini-btn" disabled={busy} onClick={restore}>Restore original</button>}
            <input ref={picker} type="file" accept=".html,.htm,text/html" hidden
              onChange={e => { replace(e.target.files?.[0]); e.target.value = '' }} />
          </>
        )}
        {!inline && <button type="button" className="btn-icon" aria-label="Close" onClick={onClose}><Icon name="close" size={15} /></button>}
      </div>
    </div>
  )

  const body = !guide ? <div className="loader"><div className="spinner" /></div> : (
    <iframe ref={frame} key={guide.replaced?.at || 'shipped'} title={guide.title} className="tg-frame"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={doc} onLoad={fit} style={inline ? { height } : undefined} />
  )

  if (inline) return <div className="tg tg-inline">{bar}{body}</div>
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="tg tg-panel" role="dialog" aria-modal="true" aria-label={guide?.title || 'Guide'} onClick={e => e.stopPropagation()}>
        {bar}{body}
      </div>
    </div>
  )
}
