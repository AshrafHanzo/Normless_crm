import { useState, useEffect } from 'react'
import { useApi, useAuth } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import FileDrop from '../../components/FileDrop'

// The sizes anybody actually asks for, in the words they ask for them.
const PRESETS = [
  { label: 'Chest', mm: 95, hint: 'left chest logo' },
  { label: 'Cap front', mm: 55, hint: 'front panel' },
  { label: 'Sleeve', mm: 70, hint: 'upper arm' },
  { label: 'Full back', mm: 250, hint: 'across the shoulders' },
]
// The stitches a machine can lay, in the words the trade uses for them.
const STITCHES = [
  { key: 'auto', label: 'Auto', hint: 'satin where it fits, fill where it does not' },
  { key: 'satin', label: 'Satin', hint: 'thread straight across — letters, bars, borders' },
  { key: 'tatami', label: 'Fill', hint: 'tatami, for anything wide' },
  { key: 'satin_border', label: 'Fill + satin edge', hint: 'filled, with a clean stitched outline' },
  { key: 'run', label: 'Outline', hint: 'a single run along the edge' },
]
const STITCH_LABEL = Object.fromEntries(STITCHES.map(s => [s.key, s.label]))
const when = (v) => (v ? new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '')
const num = (v) => new Intl.NumberFormat('en-IN').format(Math.round(Number(v) || 0))

/**
 * Turning a customer's logo into something an embroidery machine can stitch.
 *
 * The conversion is the easy half. The half that matters afterwards is being able to find the
 * file again — so every one is kept with the logo it came from, the preview, the finished width
 * and the thread colours. A DST file carries no colour information at all, which is why the
 * colours are shown beside it rather than left to be guessed at the machine.
 *
 * Results are flat-colour work: logos and text. Photographs and hairline detail need a human
 * digitiser, and the page says so rather than letting someone find out on the fabric.
 */
export default function DesignStudio() {
  const apiFetch = useApi()
  const toast = useToast()
  const { API_URL } = useAuth()

  const [service, setService] = useState(null)      // { up, configured }
  const [files, setFiles] = useState([])
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [widthMm, setWidthMm] = useState(95)
  const [colors, setColors] = useState('auto')
  const [underlay, setUnderlay] = useState(true)
  // Satin is what this shop mostly uses, but a panel wider than a centimetre cannot have it —
  // so the default lets the engine choose per shape rather than making the wrong promise.
  const [stitchType, setStitchType] = useState('auto')
  const [busy, setBusy] = useState(false)
  const [made, setMade] = useState(null)            // the conversion just finished

  const [designs, setDesigns] = useState([])
  const [summary, setSummary] = useState(null)
  const [search, setSearch] = useState('')
  const [term, setTerm] = useState('')
  const [loading, setLoading] = useState(true)
  const [renaming, setRenaming] = useState(null)
  const [opened, setOpened] = useState(null)   // a design from the library, looked at properly

  useEffect(() => {
    apiFetch('/api/crewfit/embroidery/health').then(r => { if (r && !r.error) setService(r) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    const t = setTimeout(() => setTerm(search), 300)
    return () => clearTimeout(t)
  }, [search])

  const load = async () => {
    const r = await apiFetch(`/api/crewfit/embroidery/designs?${new URLSearchParams({ ...(term && { search: term }), limit: 60 })}`)
    if (r && !r.error) { setDesigns(r.designs || []); setSummary(r.summary || null) }
    setLoading(false)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [term])

  // The preview is drawn from its own path: an <img> cannot send the login token, and the stitch
  // render is the one of the three files that is safe to serve that way. The logo and the stitch
  // file stay behind the login and are fetched, with it, only when downloaded.
  const previewUrl = (d) => `${API_URL}${d.preview_path}`

  const download = async (d, kind) => {
    const res = await apiFetch(`/api/crewfit/embroidery/designs/${d.id}/${kind}`, { responseType: 'blob' })
    if (!res || res.error) { toast.error(res?.error || 'Could not download that'); return }
    const url = URL.createObjectURL(res.blob)
    const a = document.createElement('a')
    a.href = url; a.download = res.filename || `${d.name}.${kind === 'dst' ? 'dst' : 'png'}`
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
  }

  const convert = async () => {
    const file = files[0]
    if (!file) { toast.error('Choose the logo first'); return }
    const body = new FormData()
    body.append('file', file)
    body.append('width_mm', String(widthMm))
    body.append('colors', colors)
    body.append('underlay', String(underlay))
    body.append('stitch_type', stitchType)
    if (name.trim()) body.append('name', name.trim())
    if (note.trim()) body.append('note', note.trim())

    setBusy(true)
    const res = await apiFetch('/api/crewfit/embroidery/convert', { method: 'POST', body })
    setBusy(false)
    if (!res || res.error) { toast.error(res?.error || 'Could not convert that logo'); return }
    setMade(res.design)
    setFiles([]); setName(''); setNote('')
    toast.success(`${num(res.design.stitch_count)} stitches, ${res.design.thread_colors.length} thread${res.design.thread_colors.length === 1 ? '' : 's'}`)
    load()
  }

  const rename = async (d, patch) => {
    const r = await apiFetch(`/api/crewfit/embroidery/designs/${d.id}`, { method: 'PATCH', body: JSON.stringify(patch) })
    if (!r || r.error) { toast.error(r?.error || 'Could not save that'); return }
    setRenaming(null); load()
    if (made?.id === d.id) setMade(r.design)
  }

  const remove = async (d) => {
    if (!await toast.confirm({
      title: `Delete ${d.name}?`,
      message: 'The logo, the stitch file and the preview all go. The conversion can be run again from the logo if you still have it.',
      confirmLabel: 'Delete', cancelLabel: 'Keep it', danger: true,
    })) return
    const r = await apiFetch(`/api/crewfit/embroidery/designs/${d.id}`, { method: 'DELETE' })
    if (!r || r.error) { toast.error(r?.error || 'Could not delete it'); return }
    if (made?.id === d.id) setMade(null)
    toast.success(`${d.name} deleted`); load()
  }

  return (
    <div className="page-enter">
      <div className="dash-toolbar">
        <div>
          <h1>Crewfit · Design Studio</h1>
          <p style={{ color: 'var(--text-muted)' }}>
            {summary?.designs
              ? `${summary.designs} design${summary.designs === 1 ? '' : 's'} digitised · ${num(summary.stitches)} stitches in all`
              : 'Turn a logo into a stitch file an embroidery machine can run'}
          </p>
        </div>
      </div>

      {service && !service.up && (
        <div className="bank-check bank-check-bad" style={{ marginBottom: 16 }}>
          <b>The converter is not running</b>
          <div>
            The design studio talks to a small service on the CRM server. It is not answering, so
            nothing can be converted until it is started
            {service.configured ? '' : ' — and EMB_API_KEY is not set in the CRM environment'}.
          </div>
        </div>
      )}

      <div className="studio">
        <div className="studio-form">
          <div className="form-section" style={{ marginTop: 0 }}>The logo</div>
          <FileDrop
            icon="🪡" accept="image/png,image/jpeg" busy={busy}
            files={files} onFiles={setFiles}
            label="Drag the logo here, or click to choose"
            hint="PNG or JPG, up to 15MB. A white or transparent background is ignored." />

          <div className="form-section">How it will be stitched</div>
          <div className="input-group">
            <label>Finished width <span className="label-hint">the height follows the artwork</span></label>
            <div className="chip-picker" role="group" aria-label="Size presets">
              {PRESETS.map(p => (
                <button type="button" key={p.label} title={p.hint}
                  className={`chip${Number(widthMm) === p.mm ? ' chip-on' : ''}`}
                  onClick={() => setWidthMm(p.mm)}>{p.label} <b>{p.mm}mm</b></button>
              ))}
            </div>
            <div className="studio-width">
              <input type="number" min="10" max="400" value={widthMm}
                onChange={e => setWidthMm(e.target.value)} />
              <span>mm wide</span>
            </div>
          </div>

          <div className="input-group">
            <label>Stitch <span className="label-hint">how the thread is laid down</span></label>
            <div className="chip-picker" role="group" aria-label="Stitch type">
              {STITCHES.map(st => (
                <button type="button" key={st.key} title={st.hint}
                  className={`chip${stitchType === st.key ? ' chip-on' : ''}`}
                  onClick={() => setStitchType(st.key)}>{st.label}</button>
              ))}
            </div>
            <div className="studio-stitch-hint">{STITCHES.find(s => s.key === stitchType)?.hint}</div>
          </div>

          <div className="form-row">
            <div className="input-group">
              <label>Thread colours</label>
              <select value={colors} onChange={e => setColors(e.target.value)}>
                <option value="auto">Work them out from the logo</option>
                {[1, 2, 3, 4, 5, 6, 8].map(n => <option key={n} value={String(n)}>{n} colour{n === 1 ? '' : 's'}</option>)}
              </select>
            </div>
            <div className="input-group">
              <label>Underlay <span className="label-hint">stitched first, to hold the fabric</span></label>
              <select value={underlay ? 'on' : 'off'} onChange={e => setUnderlay(e.target.value === 'on')}>
                <option value="on">Zigzag underlay</option>
                <option value="off">None</option>
              </select>
            </div>
          </div>

          <div className="form-row">
            <div className="input-group">
              <label>Name it <span className="label-hint">optional — how you will search for it</span></label>
              <input value={name} placeholder="Ashna Garments · chest logo" onChange={e => setName(e.target.value)} />
            </div>
            <div className="input-group">
              <label>Note <span className="label-hint">optional</span></label>
              <input value={note} placeholder="Navy polo, left chest" onChange={e => setNote(e.target.value)} />
            </div>
          </div>

          <button className="btn btn-primary studio-go" disabled={busy || !files.length || (service && !service.up)}
            onClick={convert}>
            {busy ? 'Digitising… this takes a few seconds' : '🪡 Make the stitch file'}
          </button>

          <p className="studio-caveat">
            Good for flat-colour logos and text. Photographs, gradients, lines under about 1mm and
            text under about 6mm need a professional digitiser — and whatever comes out, test-stitch
            it before a bulk run.
          </p>
        </div>

        {/* What just came out, big enough to judge before anyone threads a machine. Before the
            first run the column says so rather than sitting there as a hole beside the form. */}
        {!made ? (
          <div className="studio-await">
            <div className="studio-await-mark">🪡</div>
            <b>The stitch file appears here</b>
            <span>Its preview, thread list and downloads, beside the settings that made it.</span>
          </div>
        ) : (
          <div className="studio-result">
            <div className="studio-result-head">
              <h3>{made.name}</h3>
              <button type="button" className="btn-icon" onClick={() => setMade(null)}><Icon name="close" size={15} /></button>
            </div>
            <img className="studio-preview" src={previewUrl(made)} alt={`${made.name} stitch preview`} />
            <div className="bank-facts">
              <div><span>Size</span><b>{Math.round(made.width_mm)} × {Math.round(made.height_mm)} mm</b></div>
              <div><span>Stitches</span><b>{num(made.stitch_count)}</b></div>
              <div><span>Threads</span><b>{made.thread_colors.length}</b></div>
              {/* What it was actually stitched with, which is not always what was asked for. */}
              <div><span>Stitched as</span><b>{made.fill_used || STITCH_LABEL[made.stitch_type] || '—'}</b></div>
              {/* Measured off the finished file: how much of the artwork the thread reaches.
                  Anything short of it is detail too fine for thread to hold. */}
              {made.coverage_pct != null && (
                <div><span>Artwork covered</span><b>{Number(made.coverage_pct).toFixed(1)}%</b></div>
              )}
            </div>
            {/* A DST says nothing about colour, so this list is the only instruction the machine
                operator gets. In stitching order. */}
            <div className="studio-threads">
              {made.thread_colors.map((c, i) => (
                <span className="studio-thread" key={`${c}-${i}`}>
                  <i style={{ background: c }} /> {i + 1}. {c}
                </span>
              ))}
            </div>
            {!!made.warnings?.length && (
              <div className="bank-check bank-check-bad">
                <b>Worth reading before you stitch it</b>
                {made.warnings.map((w, i) => <div key={i}>{w}</div>)}
              </div>
            )}
            <div className="studio-actions">
              <button className="btn btn-primary" onClick={() => download(made, 'dst')}>⬇ Download the DST</button>
              <button className="btn btn-secondary" onClick={() => download(made, 'preview')}>⬇ Preview</button>
              <button className="btn btn-secondary" onClick={() => download(made, 'source')}>⬇ The logo</button>
            </div>
          </div>
        )}
      </div>

      <div className="form-section">Everything digitised so far</div>
      <div className="filters-row">
        <div className="search-bar">
          <span className="search-icon" />
          <input placeholder="Search by name, note or the file that was uploaded…"
            value={search} onChange={e => setSearch(e.target.value)} />
          {!!search && <button type="button" className="search-clear" onClick={() => setSearch('')}>×</button>}
        </div>
      </div>

      {loading ? <div className="loader"><div className="spinner" /></div> : !designs.length ? (
        <div className="empty-state">
          <div className="empty-icon">🪡</div>
          <h3>{term ? 'Nothing matches that' : 'No designs yet'}</h3>
          <p>Convert a logo above and it will be kept here, with its stitch file and thread colours.</p>
        </div>
      ) : (
        <div className="studio-grid">
          {designs.map(d => (
            <div className="studio-card" key={d.id}>
              {/* The whole card opens it: a stitch file is judged by looking at it, and the row
                  of small buttons was all there was to go on. */}
              <button type="button" className="studio-card-open" onClick={() => setOpened(d)} title={`Open ${d.name}`}>
                <img src={previewUrl(d)} alt={d.name} loading="lazy" decoding="async" />
              </button>
              <div className="studio-card-body">
                <b title={d.name}>{d.name}</b>
                <span className="studio-card-stitch">{d.fill_used || STITCH_LABEL[d.stitch_type] || ''}</span>
                <span>{Math.round(d.width_mm)}mm · {num(d.stitch_count)} stitches · {d.thread_colors.length} thread{d.thread_colors.length === 1 ? '' : 's'}</span>
                {d.note && <span className="studio-card-note">{d.note}</span>}
                <span className="studio-card-when">{when(d.created_at)}{d.created_by ? ` · ${String(d.created_by).split('@')[0]}` : ''}</span>
                <div className="studio-card-threads">
                  {d.thread_colors.map((c, i) => <i key={`${c}-${i}`} style={{ background: c }} title={c} />)}
                </div>
              </div>
              <div className="studio-card-actions">
                <button type="button" className="mini-btn" onClick={() => setOpened(d)}>Open</button>
                <button type="button" className="mini-btn" onClick={() => download(d, 'dst')}>⬇ DST</button>
                <button type="button" className="mini-btn" style={{ color: 'var(--danger)' }} onClick={() => remove(d)}>
                  <Icon name="trash" size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* One design, large: the preview to judge it by, what it is made of, and the three files.
          This is the view somebody opens months later when the same customer reorders. */}
      {opened && (
        <div className="image-modal-overlay" onClick={() => setOpened(null)}>
          <div className="studio-open" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="studio-result-head">
              <div>
                <h3>{opened.name}</h3>
                <div className="packed-sub">
                  {when(opened.created_at)}{opened.created_by ? ` · ${String(opened.created_by).split('@')[0]}` : ''}
                  {opened.source_name ? ` · from ${opened.source_name}` : ''}
                </div>
              </div>
              <button type="button" className="btn-icon" onClick={() => setOpened(null)}><Icon name="close" size={16} /></button>
            </div>

            <div className="studio-open-body">
              <img className="studio-preview" src={previewUrl(opened)} alt={`${opened.name} stitch preview`} />
              <div className="studio-open-side">
                <div className="bank-facts">
                  <div><span>Size</span><b>{Math.round(opened.width_mm)} × {Math.round(opened.height_mm)} mm</b></div>
                  <div><span>Stitches</span><b>{num(opened.stitch_count)}</b></div>
                  <div><span>Stitched as</span><b>{opened.fill_used || STITCH_LABEL[opened.stitch_type] || '—'}</b></div>
                  <div><span>Underlay</span><b>{opened.underlay_used || (opened.underlay ? 'yes' : 'none')}</b></div>
                  {opened.coverage_pct != null && (
                    <div><span>Artwork covered</span><b>{Number(opened.coverage_pct).toFixed(1)}%</b></div>
                  )}
                </div>
                {/* The thread list is the only colour instruction a DST can carry — which is to
                    say, none. It has to be read off here. */}
                <div className="studio-threads">
                  {opened.thread_colors.map((c, i) => (
                    <span className="studio-thread" key={`${c}-${i}`}><i style={{ background: c }} /> {i + 1}. {c}</span>
                  ))}
                </div>
                {opened.note && <p className="studio-open-note">{opened.note}</p>}
                {!!opened.warnings?.length && (
                  <div className="bank-check bank-check-bad">
                    <b>Worth reading before you stitch it</b>
                    {opened.warnings.map((w, i) => <div key={i}>{w}</div>)}
                  </div>
                )}
                <div className="studio-actions">
                  <button className="btn btn-primary" onClick={() => download(opened, 'dst')}>⬇ Download the DST</button>
                  <button className="btn btn-secondary" onClick={() => download(opened, 'source')}>⬇ Download the logo</button>
                  <button className="btn btn-secondary" onClick={() => download(opened, 'preview')}>⬇ Preview</button>
                </div>
                <div className="studio-actions">
                  <button className="mini-btn" onClick={() => { setRenaming({ ...opened }); setOpened(null) }}>Rename</button>
                  <button className="mini-btn" style={{ color: 'var(--danger)' }} onClick={() => remove(opened)}>Delete</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {renaming && (
        <div className="confirm-overlay" onClick={() => setRenaming(null)}>
          <div className="confirm-card" style={{ maxWidth: 520 }} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
            <h3 className="confirm-title">Rename this design</h3>
            <div className="support-form">
              <div className="input-group">
                <label>Name</label>
                <input value={renaming.name} autoFocus onChange={e => setRenaming({ ...renaming, name: e.target.value })} />
              </div>
              <div className="input-group">
                <label>Note <span className="label-hint">optional</span></label>
                <input value={renaming.note || ''} onChange={e => setRenaming({ ...renaming, note: e.target.value })} />
              </div>
            </div>
            <div className="confirm-actions">
              <button className="btn btn-secondary" onClick={() => setRenaming(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={!renaming.name?.trim()}
                onClick={() => rename(renaming, { name: renaming.name.trim(), note: renaming.note || '' })}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
