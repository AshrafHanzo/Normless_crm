import { useState, useEffect } from 'react'
import { useApi, useAuth } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import FileDrop from '../../components/FileDrop'

const mb = (n) => `${((Number(n) || 0) / (1024 * 1024)).toFixed(1)} MB`
const when = (v) => (v ? new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—')

/**
 * The catalogue as customers receive it.
 *
 * One current version to download and send, and the ones before it kept rather than overwritten:
 * a quote sent last month was priced off last month's catalogue, and somebody always asks which
 * sheet a number came from.
 *
 * Downloading is for everyone who can see the catalogue; replacing it is its own permission,
 * because this single file is what every customer is told the prices are.
 */
export default function CatalogPdfTab() {
  const apiFetch = useApi()
  const toast = useToast()
  const { user } = useAuth()
  const isAdmin = ['owner', 'admin'].includes(user?.role)
  const canUpload = isAdmin || !!user?.can_upload_crewfit_catalog

  const [versions, setVersions] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState(null)   // { files, title, note }
  // The PDF is behind a login, so it cannot be handed to an <iframe> as a URL — it is fetched
  // once and shown from a blob, which is also why it is kept while the tab is open.
  const [preview, setPreview] = useState(null)   // { id, url, title }
  const [opening, setOpening] = useState(null)

  const load = async () => {
    const r = await apiFetch('/api/crewfit/catalog/pdf')
    if (r && !r.error) setVersions(r.versions || [])
    setLoading(false)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [])

  const download = async (v) => {
    if (!v) return
    setBusy(true)
    const res = await apiFetch(`/api/crewfit/catalog/pdf/${v.id}/file`, { responseType: 'blob' })
    setBusy(false)
    if (!res || res.error) { toast.error(res?.error || 'Could not download the catalogue'); return }
    const url = URL.createObjectURL(res.blob)
    const a = document.createElement('a')
    a.href = url; a.download = res.filename || v.file_name
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
  }

  const openPreview = async (v) => {
    setOpening(v.id)
    const res = await apiFetch(`/api/crewfit/catalog/pdf/${v.id}/file?inline=1`, { responseType: 'blob' })
    setOpening(null)
    if (!res || res.error) { toast.error(res?.error || 'Could not open the catalogue'); return }
    setPreview({ id: v.id, url: URL.createObjectURL(res.blob), title: v.title || v.file_name, version: v.version })
  }
  const closePreview = () => {
    if (preview?.url) URL.revokeObjectURL(preview.url)
    setPreview(null)
  }
  // Leaving the tab with a 24MB blob still held is a leak nobody would ever notice.
  useEffect(() => () => { if (preview?.url) URL.revokeObjectURL(preview.url) }, [preview])

  const upload = async () => {
    const file = form?.files?.[0]
    if (!file) { toast.error('Choose the PDF first'); return }
    const body = new FormData()
    body.append('file', file)
    if (form.title) body.append('title', form.title)
    if (form.note) body.append('note', form.note)
    setBusy(true)
    const res = await apiFetch('/api/crewfit/catalog/pdf', { method: 'POST', body })
    setBusy(false)
    if (!res || res.error) { toast.error(res?.error || 'Could not save that catalogue'); return }
    toast.success(`Version ${res.version.version} is now the current catalogue — send this one from here on`)
    setForm(null); load()
  }

  const remove = async (v) => {
    if (!await toast.confirm({
      title: `Remove version ${v.version}?`,
      message: 'The file goes for good. Quotes priced off it stay as they are.',
      confirmLabel: 'Remove', cancelLabel: 'Keep it', danger: true,
    })) return
    const r = await apiFetch(`/api/crewfit/catalog/pdf/${v.id}`, { method: 'DELETE' })
    if (!r || r.error) { toast.error(r?.error || 'Could not remove it'); return }
    toast.success(`Version ${v.version} removed`); load()
  }

  const current = versions[0]
  const older = versions.slice(1)

  if (loading) return <div className="loader"><div className="spinner" /></div>

  return (
    <div className="catalog-pdf">
      {current ? (
        <div className="catalog-current">
          <div className="catalog-current-icon">📄</div>
          <div className="catalog-current-body">
            <h3>
              {current.title || current.file_name}
              {/* The whole point of keeping versions is that the wrong one is downloadable. This
                  is the one to send, and it says so. */}
              <span className="catalog-badge-current">Latest · send this one</span>
            </h3>
            <div className="packed-sub">
              Version {current.version} · {mb(current.size_bytes)} · uploaded {when(current.uploaded_at)}
              {current.uploaded_by ? ` by ${String(current.uploaded_by).split('@')[0]}` : ''}
            </div>
            {current.note && <div className="catalog-note">{current.note}</div>}
          </div>
          <div className="catalog-current-actions">
            <button className="btn btn-secondary" disabled={opening === current.id} onClick={() => openPreview(current)}>
              {opening === current.id ? 'Opening…' : '👁 Preview'}
            </button>
            <button className="btn btn-primary" disabled={busy} onClick={() => download(current)}>
              {busy ? 'Preparing…' : '⬇ Download'}
            </button>
          </div>
        </div>
      ) : (
        <div className="empty-state">
          <div className="empty-icon">📄</div>
          <h3>No catalogue uploaded yet</h3>
          <p>{canUpload
            ? 'Upload the PDF you send customers. Replacing it later keeps the old one, so a quote can always be traced to the prices it was made from.'
            : 'Ask whoever maintains the catalogue to upload it here.'}</p>
        </div>
      )}

      {canUpload && (
        form ? (
          <div className="catalog-upload">
            <FileDrop
              icon="📄" accept="application/pdf" busy={busy}
              files={form.files || []}
              onFiles={files => setForm(f => ({ ...f, files }))}
              label="Drag the catalogue PDF here, or click to choose"
              hint="One PDF, up to 40MB. It becomes the version everyone downloads." />
            <div className="input-group">
              <label>Name it <span className="label-hint">optional</span></label>
              <input value={form.title || ''} placeholder="Catalogue V4 · October 2026"
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
            </div>
            <div className="input-group">
              <label>What changed <span className="label-hint">optional — worth a line for whoever reads it next</span></label>
              <input value={form.note || ''} placeholder="Polo prices revised, aprons added"
                onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setForm(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || !form.files?.length} onClick={upload}>
                {busy ? 'Uploading…' : current ? 'Make this the current catalogue' : 'Upload the catalogue'}
              </button>
            </div>
          </div>
        ) : (
          <button className="btn btn-secondary catalog-upload-btn" onClick={() => setForm({})}>
            <Icon name="plus" size={15} /> {current ? 'Upload a new version' : 'Upload the catalogue'}
          </button>
        )
      )}

      {!!older.length && (
        <div className="catalog-history">
          <h3>Earlier versions <span className="label-hint">kept so a past quote can be traced — not for sending</span></h3>
          {older.map(v => (
            <div className="catalog-version catalog-version-old" key={v.id}>
              <b>v{v.version}</b>
              <span className="catalog-version-name">{v.title || v.file_name}</span>
              <span className="catalog-badge-old">Superseded</span>
              <span className="catalog-version-meta">{mb(v.size_bytes)} · {when(v.uploaded_at)}</span>
              <button type="button" className="mini-btn" disabled={opening === v.id} onClick={() => openPreview(v)}>👁</button>
              <button type="button" className="mini-btn" onClick={() => download(v)}>⬇</button>
              {canUpload && (
                <button type="button" className="mini-btn" style={{ color: 'var(--danger)' }} onClick={() => remove(v)}
                  title="Remove this version">
                  <Icon name="trash" size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* The catalogue read here rather than downloaded, because most of the time the question is
          "what price is on it" and the answer does not need a file in the downloads folder. */}
      {preview && (
        <div className="image-modal-overlay" onClick={closePreview}>
          <div className="pdf-preview" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="pdf-preview-head">
              <b>{preview.title}</b>
              <span className={preview.version === current?.version ? 'catalog-badge-current' : 'catalog-badge-old'}>
                {preview.version === current?.version ? 'Latest' : `v${preview.version} · superseded`}
              </span>
              <button type="button" className="mini-btn" onClick={() => download(versions.find(v => v.id === preview.id))}>⬇ Download</button>
              <button type="button" className="btn-icon" onClick={closePreview}><Icon name="close" size={16} /></button>
            </div>
            {/* <object> rather than <iframe>: a browser with no PDF viewer — most phones — shows
                the fallback instead of a blank rectangle nobody can explain. */}
            <object data={preview.url} type="application/pdf" className="pdf-preview-frame" aria-label={preview.title}>
              <div className="pdf-preview-fallback">
                <p>This browser will not display a PDF in the page.</p>
                <button type="button" className="btn btn-primary"
                  onClick={() => download(versions.find(v => v.id === preview.id))}>⬇ Download it instead</button>
              </div>
            </object>
          </div>
        </div>
      )}
    </div>
  )
}
