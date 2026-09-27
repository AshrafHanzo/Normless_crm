import { useState, useEffect, useRef } from 'react'
import { useApi, useAuth } from '../App'
import { useToast } from '../components/Toast'
import Icon from '../components/Icon'

/**
 * System → Backup.
 *
 * Four steps, shown in order and unlocked in order, because every one of them depends on the one
 * before: connect Telegram → set a passphrase → back up → schedule it. Showing all four at once
 * invites someone to press "Back up now" before there is anywhere to put it.
 *
 * The passphrase is asked for per action rather than remembered in the page. It is the one secret
 * the server cannot recover, and a copy of it sitting in a React state variable on a shared
 * warehouse browser is exactly the wrong place for it.
 */

const fmtBytes = (n) => {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0, v = Number(n)
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`
}
const fmtWhen = (d) => d ? new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—'
const fmtDur = (ms) => {
  if (!ms) return '—'
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

const CRON_PRESETS = [
  { label: 'Every night at 2:30am', value: '30 2 * * *' },
  { label: 'Every night at 3:30am', value: '30 3 * * *' },
  { label: 'Twice a day (2:30am & 2:30pm)', value: '30 2,14 * * *' },
  { label: 'Every 6 hours', value: '0 */6 * * *' },
  { label: 'Weekly, Sunday 2:30am', value: '30 2 * * 0' },
]

/** Asks for the passphrase and nothing else. Used by every action that needs one. */
function PassphrasePrompt({ title, note, danger, confirmLabel, onCancel, onConfirm }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const ref = useRef(null)
  useEffect(() => { ref.current?.focus() }, [])

  const go = async () => {
    if (!value) return
    setBusy(true)
    try { await onConfirm(value) } finally { setBusy(false) }
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal-card" onClick={e => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <h3 style={{ marginBottom: 6 }}>{title}</h3>
        {note && <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>{note}</p>}
        <div className="input-group">
          <label>Encryption passphrase</label>
          <input ref={ref} type="password" value={value} autoComplete="off"
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && go()}
            placeholder="The passphrase you set for backups" />
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={go} disabled={!value || busy}>
            {busy ? 'Working…' : (confirmLabel || 'Continue')}
          </button>
          <button className="btn btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

export default function Backup() {
  const apiFetch = useApi()
  const { user } = useAuth()
  const toast = useToast()
  const isOwner = user?.role === 'owner'

  const [status, setStatus] = useState(null)
  const [runs, setRuns] = useState([])
  const [loading, setLoading] = useState(true)
  const [prompt, setPrompt] = useState(null)
  const [openRun, setOpenRun] = useState(null)
  const pollRef = useRef(null)

  const load = async () => {
    const [s, r] = await Promise.all([apiFetch('/api/backup/status'), apiFetch('/api/backup/runs?limit=25')])
    if (s && !s.error) setStatus(s)
    if (r && !r.error) setRuns(r.runs || [])
    setLoading(false)
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [])

  // While something is moving, poll often; otherwise leave the server alone.
  const busy = status?.running || status?.restoring
  useEffect(() => {
    clearInterval(pollRef.current)
    if (!busy) return
    pollRef.current = setInterval(async () => {
      const p = await apiFetch('/api/backup/progress')
      if (!p || p.error) return
      if (!p.backup && !p.restore) { await load(); return }   // finished — refresh everything
      setStatus(s => s ? { ...s, running: p.backup, restoring: p.restore } : s)
    }, 1500)
    return () => clearInterval(pollRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!busy])

  if (loading) return <div className="loader"><div className="spinner" /></div>

  const cfg = status?.config || {}
  const env = status?.environment || {}
  const sched = status?.schedule || {}

  const step = !cfg.connected ? 1 : !cfg.encryption ? 2 : runs.length === 0 ? 3 : 4

  return (
    <div className="page-enter">
      <div className="admin-header">
        <div className="admin-header-icon"><Icon name="cloud" size={26} /></div>
        <div className="admin-header-content">
          <h1>Backup</h1>
          <p>Encrypted copies of both CRMs — database, design mocks and GST workbooks — sent to your own Telegram</p>
        </div>
      </div>

      {!isOwner && (
        <div className="admin-note" style={{ marginBottom: 20 }}>
          <Icon name="info" size={16} /> You can see the history and start a backup. Connecting Telegram, changing the passphrase and restoring are owner-only.
        </div>
      )}

      <HealthStrip env={env} cfg={cfg} sched={sched} />

      {busy && <ProgressPanel running={status.running} restoring={status.restoring} />}

      <TelegramCard cfg={cfg} isOwner={isOwner} apiFetch={apiFetch} toast={toast} reload={load} step={step} />

      {cfg.connected && (
        <EncryptionCard cfg={cfg} isOwner={isOwner} apiFetch={apiFetch} toast={toast} reload={load} />
      )}

      {cfg.connected && cfg.encryption && (
        <RunCard env={env} busy={!!busy} setPrompt={setPrompt} apiFetch={apiFetch} toast={toast} reload={load} />
      )}

      {cfg.connected && cfg.encryption && isOwner && (
        <ScheduleCard cfg={cfg} sched={sched} apiFetch={apiFetch} toast={toast} reload={load} setPrompt={setPrompt} />
      )}

      {status?.restoredOnDisk?.length > 0 && isOwner && (
        <RestoredWarning files={status.restoredOnDisk} apiFetch={apiFetch} toast={toast} reload={load} />
      )}

      <HistoryCard
        runs={runs} openRun={openRun} setOpenRun={setOpenRun}
        isOwner={isOwner} apiFetch={apiFetch} toast={toast} reload={load} setPrompt={setPrompt} busy={!!busy}
      />

      {prompt && <PassphrasePrompt {...prompt} onCancel={() => setPrompt(null)} />}
    </div>
  )
}

/* ─────────────────────────── pieces ─────────────────────────── */

function HealthStrip({ env, cfg, sched }) {
  const items = [
    { ok: !!cfg.connected, icon: 'spark', label: 'Telegram', value: cfg.connected ? (cfg.tg_user || 'Connected') : 'Not connected' },
    { ok: !!cfg.encryption, icon: 'lock', label: 'Encryption', value: cfg.encryption ? 'AES-256-GCM' : 'No passphrase' },
    { ok: !!env.pgDump?.ok, icon: 'database', label: 'pg_dump', value: env.pgDump?.ok ? (env.pgDump.version || 'available') : 'missing' },
    { ok: !!cfg.schedule_enabled && sched.active, icon: 'clock', label: 'Schedule', value: cfg.schedule_enabled ? (sched.active ? 'Armed' : 'Enabled, not armed') : 'Off' },
  ]
  return (
    <div className="grid-4 backup-health" style={{ marginBottom: 20 }}>
      {items.map((s, i) => (
        <div className="glass-card" key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px' }}>
          <div className="stat-icon" style={{ color: s.ok ? 'var(--success)' : 'var(--text-muted)' }}><Icon name={s.icon} size={20} /></div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{s.label}</div>
            <div style={{ fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.value}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

function ProgressPanel({ running, restoring }) {
  const p = running || restoring
  if (!p) return null
  return (
    <div className="glass-card" style={{ marginBottom: 20, borderColor: 'var(--primary)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <div className="spinner" style={{ width: 18, height: 18 }} />
        <b style={{ textTransform: 'capitalize' }}>{running ? `Backing up — ${p.phase}` : `Restoring — ${p.phase}`}</b>
        <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)' }}>{Math.round(p.pct || 0)}%</span>
      </div>
      <div className="progress-track"><div className="progress-fill" style={{ width: `${p.pct || 0}%` }} /></div>
      <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 8 }}>{p.detail || '…'}</div>
    </div>
  )
}

function TelegramCard({ cfg, isOwner, apiFetch, toast, reload, step }) {
  const [form, setForm] = useState({ apiId: cfg.tg_api_id || '', apiHash: '', phone: '' })
  const [stage, setStage] = useState('idle')      // idle | code | password
  const [token, setToken] = useState(null)
  const [code, setCode] = useState('')
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)

  const start = async () => {
    setBusy(true)
    const r = await apiFetch('/api/backup/telegram/start', { method: 'POST', body: JSON.stringify(form) })
    setBusy(false)
    if (r?.error) return toast.error(r.error)
    setToken(r.token); setStage('code')
    toast.success(r.viaApp ? 'Code sent to your Telegram app' : 'Code sent by SMS')
  }

  const sendCode = async () => {
    setBusy(true)
    const r = await apiFetch('/api/backup/telegram/code', { method: 'POST', body: JSON.stringify({ token, code, ...form }) })
    setBusy(false)
    if (r?.error) return toast.error(r.error)
    if (r.needsPassword) { setStage('password'); return toast.info('This account has two-factor on — enter your Telegram password') }
    toast.success(`Connected as ${r.user?.name || r.user?.username || 'your account'}`)
    setStage('idle'); reload()
  }

  const sendPw = async () => {
    setBusy(true)
    const r = await apiFetch('/api/backup/telegram/password', { method: 'POST', body: JSON.stringify({ token, password: pw, ...form }) })
    setBusy(false)
    if (r?.error) return toast.error(r.error)
    toast.success('Connected'); setStage('idle'); setPw(''); reload()
  }

  const disconnect = async () => {
    if (!await toast.confirm({
      title: 'Disconnect Telegram?',
      message: 'Scheduled backups stop. The channel and everything already backed up stay exactly where they are — sign in again to restore from them.',
      confirmLabel: 'Disconnect', danger: true,
    })) return
    const r = await apiFetch('/api/backup/telegram/disconnect', { method: 'POST' })
    if (r?.ok) { toast.success('Disconnected'); reload() } else toast.error(r?.error || 'Failed')
  }

  return (
    <div className="glass-card" style={{ marginBottom: 20 }}>
      <CardHead n={1} done={cfg.connected} title="Connect Telegram" active={step === 1} />

      {cfg.connected ? (
        <div className="backup-connected">
          <div>
            <div style={{ fontWeight: 650 }}>{cfg.tg_user || 'Telegram account'}</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
              {cfg.tg_username ? `@${cfg.tg_username} · ` : ''}{cfg.tg_phone}
              {cfg.tg_premium ? ' · Premium (4 GB per file)' : ' · 2 GB per file'}
            </div>
            {cfg.channel_title && (
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 4 }}>
                <Icon name="box" size={13} style={{ verticalAlign: -2 }} /> Uploading to private channel “{cfg.channel_title}”
              </div>
            )}
          </div>
          {isOwner && <button className="btn btn-secondary" onClick={disconnect}>Disconnect</button>}
        </div>
      ) : !isOwner ? (
        <p style={{ color: 'var(--text-muted)', fontSize: 13.5 }}>An owner needs to connect the Telegram account.</p>
      ) : (
        <>
          <div className="admin-note" style={{ marginBottom: 16 }}>
            <Icon name="info" size={16} />
            <span>
              Get an <b>API ID</b> and <b>API hash</b> from <a href="https://my.telegram.org/apps" target="_blank" rel="noreferrer">my.telegram.org/apps</a> —
              log in with this phone number, open <em>API development tools</em>, and create an app (any title will do).
              These are yours; backups go to your own account and nobody else can read them.
            </span>
          </div>

          {stage === 'idle' && (
            <>
              <div className="form-row">
                <div className="input-group"><label>API ID</label>
                  <input value={form.apiId} onChange={e => setForm(f => ({ ...f, apiId: e.target.value }))} placeholder="e.g. 30990994" /></div>
                <div className="input-group"><label>API hash</label>
                  <input value={form.apiHash} onChange={e => setForm(f => ({ ...f, apiHash: e.target.value }))} placeholder="32-character hash" /></div>
                <div className="input-group"><label>Phone number</label>
                  <input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="+919876543210" /></div>
              </div>
              <button className="btn btn-primary" onClick={start} disabled={busy || !form.apiId || !form.apiHash || !form.phone}>
                {busy ? 'Sending…' : 'Send login code'}
              </button>
            </>
          )}

          {stage === 'code' && (
            <div className="form-row" style={{ alignItems: 'end' }}>
              <div className="input-group"><label>Login code from Telegram</label>
                <input value={code} onChange={e => setCode(e.target.value)} placeholder="5 digits" autoFocus
                  onKeyDown={e => e.key === 'Enter' && sendCode()} /></div>
              <button className="btn btn-primary" onClick={sendCode} disabled={busy || !code}>{busy ? 'Checking…' : 'Verify'}</button>
              <button className="btn btn-secondary" onClick={() => { apiFetch('/api/backup/telegram/cancel', { method: 'POST', body: JSON.stringify({ token }) }); setStage('idle') }}>Cancel</button>
            </div>
          )}

          {stage === 'password' && (
            <div className="form-row" style={{ alignItems: 'end' }}>
              <div className="input-group"><label>Telegram two-factor password</label>
                <input type="password" value={pw} onChange={e => setPw(e.target.value)} autoFocus
                  onKeyDown={e => e.key === 'Enter' && sendPw()} /></div>
              <button className="btn btn-primary" onClick={sendPw} disabled={busy || !pw}>{busy ? 'Checking…' : 'Sign in'}</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function EncryptionCard({ cfg, isOwner, apiFetch, toast, reload }) {
  const [open, setOpen] = useState(false)
  const [f, setF] = useState({ current: '', passphrase: '', confirm: '' })
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    const r = await apiFetch('/api/backup/passphrase', { method: 'POST', body: JSON.stringify(f) })
    setBusy(false)
    if (r?.error) return toast.error(r.error)
    toast.success('Passphrase set')
    if (r.rearmScheduleNeeded) toast.info('Automatic backups were switched off — turn them back on with the new passphrase')
    setOpen(false); setF({ current: '', passphrase: '', confirm: '' }); setAck(false); reload()
  }

  return (
    <div className="glass-card" style={{ marginBottom: 20 }}>
      <CardHead n={2} done={cfg.encryption} title="Encryption passphrase" active={!cfg.encryption} />

      {!open ? (
        <div className="backup-connected">
          <div style={{ fontSize: 13.5, color: 'var(--text-muted)', maxWidth: 620 }}>
            {cfg.encryption
              ? 'Archives are encrypted with AES-256-GCM before they leave this server. Telegram only ever holds ciphertext.'
              : 'Set a passphrase. Every archive is encrypted with it before upload — without one, your customer list would sit readable in Telegram.'}
          </div>
          {isOwner && <button className="btn btn-secondary" onClick={() => setOpen(true)}>{cfg.encryption ? 'Change' : 'Set passphrase'}</button>}
        </div>
      ) : (
        <>
          <div className="admin-note danger-note" style={{ marginBottom: 16 }}>
            <Icon name="alert" size={16} />
            <span>
              <b>Write this down somewhere safe before you continue.</b> The server stores only a check value, never the
              passphrase itself — that is what stops a stolen backup from being readable. If you lose it, every backup
              becomes permanently unrecoverable. Nobody can reset it.
              {cfg.encryption && ' Changing it does not re-encrypt existing backups: keep the old one to restore anything made before now.'}
            </span>
          </div>
          {cfg.encryption && (
            <div className="input-group"><label>Current passphrase</label>
              <input type="password" value={f.current} onChange={e => setF(v => ({ ...v, current: e.target.value }))} /></div>
          )}
          <div className="form-row">
            <div className="input-group"><label>New passphrase (12+ characters)</label>
              <input type="password" value={f.passphrase} onChange={e => setF(v => ({ ...v, passphrase: e.target.value }))} /></div>
            <div className="input-group"><label>Confirm</label>
              <input type="password" value={f.confirm} onChange={e => setF(v => ({ ...v, confirm: e.target.value }))} /></div>
          </div>
          <label className="page-check" style={{ margin: '4px 0 14px' }}>
            <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} />
            <span><b>I have written this passphrase down somewhere safe.</b></span>
          </label>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-primary" disabled={busy || !ack || f.passphrase.length < 12 || f.passphrase !== f.confirm} onClick={save}>
              {busy ? 'Saving…' : 'Save passphrase'}
            </button>
            <button className="btn btn-secondary" onClick={() => { setOpen(false); setAck(false) }}>Cancel</button>
          </div>
        </>
      )}
    </div>
  )
}

function RunCard({ env, busy, setPrompt, apiFetch, toast, reload }) {
  const start = (kind, label) => setPrompt({
    title: `Back up ${label}`,
    note: 'The archive is encrypted with this passphrase before it is uploaded.',
    confirmLabel: 'Start backup',
    onConfirm: async (passphrase) => {
      const r = await apiFetch('/api/backup/run', { method: 'POST', body: JSON.stringify({ kind, passphrase }) })
      if (r?.error) return toast.error(r.error)
      toast.success('Backup started'); setPrompt(null); reload()
    },
  })

  const dbSize = env.dbBytes
  const uploads = env.sources?.find(s => s.key === 'uploads')
  const storage = env.sources?.find(s => s.key === 'storage')

  return (
    <div className="glass-card" style={{ marginBottom: 20 }}>
      <CardHead n={3} title="Back up now" />
      {!env.pgDump?.ok && (
        <div className="admin-note danger-note" style={{ marginBottom: 14 }}>
          <Icon name="alert" size={16} /> {env.pgDump?.error} — the database cannot be dumped from this machine. File backups still work.
        </div>
      )}
      <div className="backup-sources">
        <div><Icon name="database" size={15} /> <b>Database</b><span>{fmtBytes(dbSize)} · both brands, all 42 tables</span></div>
        <div><Icon name="box" size={15} /> <b>Uploads</b><span>{uploads ? `${uploads.files} files · ${fmtBytes(uploads.bytes)}` : '—'}</span></div>
        <div><Icon name="invoice" size={15} /> <b>Storage</b><span>{storage ? `${storage.files} files · ${fmtBytes(storage.bytes)}` : '—'}</span></div>
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 16 }}>
        <button className="btn btn-primary" disabled={busy} onClick={() => start('full', 'everything')}>
          <Icon name="play" size={15} /> Back up everything
        </button>
        <button className="btn btn-secondary" disabled={busy || !env.pgDump?.ok} onClick={() => start('db', 'the database only')}>
          <Icon name="database" size={15} /> Database only
        </button>
        <button className="btn btn-secondary" disabled={busy} onClick={() => start('files', 'the files only')}>
          <Icon name="box" size={15} /> Files only
        </button>
      </div>
    </div>
  )
}

function ScheduleCard({ cfg, sched, apiFetch, toast, reload, setPrompt }) {
  const [f, setF] = useState({
    db_cron: cfg.db_cron || '30 2 * * *',
    files_cron: cfg.files_cron || '30 3 * * *',
    timezone: cfg.timezone || 'Asia/Kolkata',
    keep_daily: cfg.keep_daily ?? 14,
    keep_weekly: cfg.keep_weekly ?? 8,
    keep_monthly: cfg.keep_monthly ?? 6,
    include_uploads: cfg.include_uploads !== false,
    include_storage: cfg.include_storage !== false,
  })
  const [busy, setBusy] = useState(false)

  const save = async (extra = {}) => {
    setBusy(true)
    const r = await apiFetch('/api/backup/settings', { method: 'PUT', body: JSON.stringify({ ...f, ...extra }) })
    setBusy(false)
    if (r?.error) return toast.error(r.error)
    toast.success('Saved'); reload()
  }

  const toggle = async (on) => {
    if (!on) return save({ schedule_enabled: false })
    setPrompt({
      title: 'Turn on automatic backups',
      note: 'Nobody is here to type the passphrase at 3am, so it gets stored — sealed with this server\'s JWT_SECRET, which is never part of a backup. A stolen backup still cannot be opened; someone who takes both the server and its .env could.',
      confirmLabel: 'Enable automatic backups',
      onConfirm: async (passphrase) => {
        const r = await apiFetch('/api/backup/settings', { method: 'PUT', body: JSON.stringify({ ...f, schedule_enabled: true, passphrase }) })
        if (r?.error) return toast.error(r.error)
        toast.success('Automatic backups are on'); setPrompt(null); reload()
      },
    })
  }

  return (
    <div className="glass-card" style={{ marginBottom: 20 }}>
      <CardHead n={4} done={cfg.schedule_enabled} title="Automatic schedule" />

      <div className="backup-connected" style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 13.5, color: 'var(--text-muted)', maxWidth: 620 }}>
          The database is dumped nightly. Files go up incrementally — only what changed — with a full copy every 7 days,
          because re-uploading {fmtBytes(cfg.uploadsBytes)} of unchanged photos every night would be wasted bandwidth.
        </div>
        <button className={`toggle ${cfg.schedule_enabled ? 'on' : ''}`} onClick={() => toggle(!cfg.schedule_enabled)}><span /></button>
      </div>

      {sched.lastError && (
        <div className="admin-note danger-note" style={{ marginBottom: 14 }}><Icon name="alert" size={16} /> {sched.lastError}</div>
      )}

      {sched.jobs?.length > 0 && (
        <div className="backup-next">
          {sched.jobs.map(j => (
            <div key={j.key}>
              <Icon name="clock" size={14} />
              <b>{j.key === 'db' ? 'Database' : 'Files'}</b>
              <code>{j.cron}</code>
              <span>next {fmtWhen(j.nextRun)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="form-row" style={{ marginTop: 14 }}>
        <div className="input-group"><label>Database schedule</label>
          <select value={f.db_cron} onChange={e => setF(v => ({ ...v, db_cron: e.target.value }))}>
            {CRON_PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            {!CRON_PRESETS.some(p => p.value === f.db_cron) && <option value={f.db_cron}>{f.db_cron} (custom)</option>}
          </select></div>
        <div className="input-group"><label>Files schedule</label>
          <select value={f.files_cron} onChange={e => setF(v => ({ ...v, files_cron: e.target.value }))}>
            {CRON_PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            {!CRON_PRESETS.some(p => p.value === f.files_cron) && <option value={f.files_cron}>{f.files_cron} (custom)</option>}
          </select></div>
        <div className="input-group"><label>Timezone</label>
          <input value={f.timezone} onChange={e => setF(v => ({ ...v, timezone: e.target.value }))} placeholder="Asia/Kolkata" /></div>
      </div>

      <div className="form-row">
        <div className="input-group"><label>Keep daily</label>
          <input type="number" min="1" max="365" value={f.keep_daily} onChange={e => setF(v => ({ ...v, keep_daily: e.target.value }))} /></div>
        <div className="input-group"><label>Keep weekly</label>
          <input type="number" min="1" max="365" value={f.keep_weekly} onChange={e => setF(v => ({ ...v, keep_weekly: e.target.value }))} /></div>
        <div className="input-group"><label>Keep monthly</label>
          <input type="number" min="1" max="365" value={f.keep_monthly} onChange={e => setF(v => ({ ...v, keep_monthly: e.target.value }))} /></div>
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', margin: '4px 0 14px' }}>
        <label className="page-check" style={{ margin: 0 }}>
          <input type="checkbox" checked={f.include_uploads} onChange={e => setF(v => ({ ...v, include_uploads: e.target.checked }))} />
          <Icon name="box" size={15} /><span>Include uploads (design mocks &amp; production photos)</span>
        </label>
        <label className="page-check" style={{ margin: 0 }}>
          <input type="checkbox" checked={f.include_storage} onChange={e => setF(v => ({ ...v, include_storage: e.target.checked }))} />
          <Icon name="invoice" size={15} /><span>Include generated GST workbooks</span>
        </label>
      </div>

      <button className="btn btn-primary" onClick={() => save()} disabled={busy}>{busy ? 'Saving…' : 'Save schedule'}</button>
    </div>
  )
}

function RestoredWarning({ files, apiFetch, toast, reload }) {
  const total = files.reduce((n, f) => n + f.bytes, 0)
  const clear = async () => {
    const r = await apiFetch('/api/backup/restored', { method: 'DELETE' })
    if (r?.ok) { toast.success('Cleared'); reload() } else toast.error(r?.error || 'Failed')
  }
  return (
    <div className="glass-card" style={{ marginBottom: 20, borderColor: 'var(--warning, var(--danger))' }}>
      <div className="backup-connected">
        <div>
          <b><Icon name="alert" size={15} style={{ verticalAlign: -2 }} /> Decrypted files are sitting on this server</b>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 4 }}>
            {files.length} file{files.length > 1 ? 's' : ''} · {fmtBytes(total)} — unencrypted production data. Delete them once the restore is finished.
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6, fontFamily: 'var(--font-mono, monospace)' }}>
            {files.slice(0, 4).map(f => <div key={f.file}>{f.file}</div>)}
          </div>
        </div>
        <button className="btn btn-danger" onClick={clear}>Delete them</button>
      </div>
    </div>
  )
}

function HistoryCard({ runs, openRun, setOpenRun, isOwner, apiFetch, toast, reload, setPrompt, busy }) {
  const [detail, setDetail] = useState(null)

  const open = async (id) => {
    if (openRun === id) { setOpenRun(null); return }
    setOpenRun(id)
    const r = await apiFetch(`/api/backup/runs/${id}`)
    if (r && !r.error) setDetail(r)
  }

  const verify = (art) => setPrompt({
    title: `Verify ${art.filename}`,
    note: 'Downloads it from Telegram, decrypts it and checks both hashes, then throws the plaintext away. Nothing on the server changes.',
    confirmLabel: 'Verify',
    onConfirm: async (passphrase) => {
      const r = await apiFetch(`/api/backup/artifacts/${art.id}/verify`, { method: 'POST', body: JSON.stringify({ passphrase }) })
      if (r?.error) return toast.error(r.error)
      toast.success('Verifying — watch the progress bar'); setPrompt(null); reload()
    },
  })

  const restore = (art) => setPrompt({
    title: `Restore ${art.filename}`,
    danger: true,
    note: 'Downloads and decrypts it onto this server. It does NOT overwrite the live database or files — you get the decrypted file plus the exact command to finish the job by hand.',
    confirmLabel: 'Download & decrypt',
    onConfirm: async (passphrase) => {
      const r = await apiFetch(`/api/backup/artifacts/${art.id}/restore`, { method: 'POST', body: JSON.stringify({ passphrase }) })
      if (r?.error) return toast.error(r.error)
      toast.success('Restoring — watch the progress bar'); setPrompt(null); reload()
    },
  })

  const badge = (s) => ({
    success: { t: 'Success', c: 'var(--success)' }, running: { t: 'Running', c: 'var(--info)' },
    failed: { t: 'Failed', c: 'var(--danger)' }, empty: { t: 'Nothing new', c: 'var(--text-muted)' },
    pruned: { t: 'Pruned', c: 'var(--text-muted)' },
  }[s] || { t: s, c: 'var(--text-muted)' })

  return (
    <div className="glass-card">
      <h3 style={{ marginBottom: 16 }}>History</h3>
      {!runs.length ? (
        <p style={{ color: 'var(--text-muted)', fontSize: 13.5 }}>No backups yet.</p>
      ) : (
        <div className="backup-runs">
          {runs.map(r => {
            const b = badge(r.status)
            return (
              <div key={r.id} className={`backup-run ${openRun === r.id ? 'open' : ''}`}>
                <div className="backup-run-head" onClick={() => open(r.id)}>
                  <span className="backup-dot" style={{ background: b.c }} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                      #{r.id} · {r.kind} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>· {r.trigger}</span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{fmtWhen(r.started_at)}</div>
                  </div>
                  <div style={{ textAlign: 'right', fontSize: 12.5 }}>
                    <div style={{ color: b.c, fontWeight: 600 }}>{b.t}</div>
                    <div style={{ color: 'var(--text-muted)' }}>{fmtBytes(r.cipher_bytes)} · {fmtDur(r.duration_ms)}</div>
                  </div>
                  <Icon name={openRun === r.id ? 'chevronLeft' : 'chevronRight'} size={15} />
                </div>

                {openRun === r.id && detail?.id === r.id && (
                  <div className="backup-run-body">
                    {r.error && <div className="admin-note danger-note" style={{ marginBottom: 10 }}><Icon name="alert" size={15} /> {r.error}</div>}
                    {!detail.artifacts?.length && <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No artifacts in this run.</div>}
                    {detail.artifacts?.map(a => (
                      <div key={a.id} className="backup-artifact">
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>
                            <Icon name={a.kind === 'database' ? 'database' : 'box'} size={14} style={{ verticalAlign: -2 }} /> {a.filename}
                          </div>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                            {fmtBytes(a.cipher_bytes)} encrypted · {a.part_count} part{a.part_count > 1 ? 's' : ''}
                            {a.file_count != null && ` · ${a.file_count} files`}
                            {a.meta?.incremental && ' · incremental'}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono, monospace)', marginTop: 2 }}>
                            sha256 {String(a.cipher_sha256 || '').slice(0, 24)}…
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => verify(a)}>Verify</button>
                          {isOwner && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => restore(a)}>Restore</button>}
                        </div>
                      </div>
                    ))}
                    {detail.manifest_message_id && (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
                        <Icon name="note" size={13} style={{ verticalAlign: -2 }} /> Recovery manifest posted to the channel (message {detail.manifest_message_id}) — it is the index for rebuilding on a new server.
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function CardHead({ n, title, done, active }) {
  return (
    <div className="backup-step-head">
      <span className={`backup-step-n ${done ? 'done' : active ? 'active' : ''}`}>{done ? <Icon name="check" size={13} /> : n}</span>
      <h3 style={{ margin: 0 }}>{title}</h3>
    </div>
  )
}
