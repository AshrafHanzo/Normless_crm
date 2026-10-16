import { useState, useEffect } from 'react'
import { useApi, useAuth } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'

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
  const [form, setForm] = useState(null)   // { file, title, note }

  const load = async () => {
    const r = await apiFetch('/api/crewfit/catalog/pdf')
    if (r && !r.error) setVersions(r.versions || [])
    setLoading(false)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [])

  const download = async (v) => {
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

  const upload = async () => {
    if (!form?.file) { toast.error('Choose the PDF first'); return }
    const body = new FormData()
    body.append('file', form.file)
    if (form.title) body.append('title', form.title)
    if (form.note) body.append('note', form.note)
    setBusy(true)
    const res = await apiFetch('/api/crewfit/catalog/pdf', { method: 'POST', body })
    setBusy(false)
    if (!res || res.error) { toast.error(res?.error || 'Could not save that catalogue'); return }
    toast.success(`Version ${res.version.version} is now the current catalogue`)
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
            <h3>{current.title || current.file_name}</h3>
            <div className="packed-sub">
              Version {current.version} · {mb(current.size_bytes)} · uploaded {when(current.uploaded_at)}
              {current.uploaded_by ? ` by ${String(current.uploaded_by).split('@')[0]}` : ''}
            </div>
            {current.note && <div className="catalog-note">{current.note}</div>}
          </div>
          <button className="btn btn-primary" disabled={busy} onClick={() => download(current)}>
            {busy ? 'Preparing…' : '⬇ Download'}
          </button>
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
            <div className="form-row">
              <div className="input-group">
                <label>The catalogue PDF *</label>
                <input type="file" accept="application/pdf" onChange={e => setForm(f => ({ ...f, file: e.target.files?.[0] || null }))} />
              </div>
              <div className="input-group">
                <label>Name it <span className="label-hint">optional</span></label>
                <input value={form.title || ''} placeholder="Catalogue V4 · October 2026"
                  onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
              </div>
            </div>
            <div className="input-group">
              <label>What changed <span className="label-hint">optional — worth a line for whoever reads it next</span></label>
              <input value={form.note || ''} placeholder="Polo prices revised, aprons added"
                onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setForm(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || !form.file} onClick={upload}>
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
          <h3>Earlier versions</h3>
          {older.map(v => (
            <div className="catalog-version" key={v.id}>
              <b>v{v.version}</b>
              <span>{v.title || v.file_name}</span>
              <span className="catalog-version-meta">{mb(v.size_bytes)} · {when(v.uploaded_at)}</span>
              <button type="button" className="mini-btn" onClick={() => download(v)}>⬇</button>
              {user?.role === 'owner' && canUpload && (
                <button type="button" className="mini-btn" style={{ color: 'var(--danger)' }} onClick={() => remove(v)}>
                  <Icon name="trash" size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
