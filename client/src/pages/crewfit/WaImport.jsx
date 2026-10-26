import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import { Head } from './waSettingsUi'
import { useWaBrand } from './waBrand'

/**
 * Settings › Import chats: bringing chats from the WhatsApp (Business) app on the phone into the
 * CRM, before the number moves here. Each export is read first — who is in it, how many messages,
 * which dates — then imported into that customer's chat with its photos and files. Importing the
 * same export twice adds nothing.
 */

const fmt = (at) => (at ? new Date(at.replace(' ', 'T')).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '')

export function WaImportTab() {
  const apiFetch = useApi()
  const toast = useToast()
  const brand = useWaBrand()
  const [rows, setRows] = useState([])             // { id, file, status, preview, phone, name, customer, result, error }
  const set = (id, patch) => setRows(rs => rs.map(r => (r.id === id ? { ...r, ...patch } : r)))

  const add = async (files) => {
    const fresh = [...files].map(file => ({ id: `${file.name}-${file.size}-${Math.random()}`, file, status: 'reading' }))
    setRows(rs => [...rs, ...fresh])
    for (const r of fresh) {
      const form = new FormData()
      form.append('file', r.file)
      const p = await apiFetch(`${brand.api}/import/preview`, { method: 'POST', body: form })
      if (!p || p.error) { set(r.id, { status: 'error', error: p?.error || 'Could not read that export' }); continue }
      set(r.id, {
        status: 'ready', preview: p, customer: p.customer || p.senders[0]?.name || '',
        phone: p.contact?.phone || '', name: p.contact?.name || (p.customer && !/\d{6,}/.test(p.customer) ? p.customer : ''),
      })
    }
  }

  const importOne = async (r) => {
    set(r.id, { status: 'importing', error: null })
    const form = new FormData()
    form.append('file', r.file)
    form.append('phone', r.phone)
    form.append('name', r.name || '')
    form.append('customer', r.customer)
    const res = await apiFetch(`${brand.api}/import/commit`, { method: 'POST', body: form })
    if (!res || res.error) { set(r.id, { status: 'ready', error: res?.error || 'Could not import that chat' }); return false }
    set(r.id, { status: 'done', result: res })
    return true
  }
  const importAll = async () => {
    let n = 0
    for (const r of rows.filter(x => x.status === 'ready' && x.phone.trim() && x.customer)) if (await importOne(r)) n++
    if (n) toast.success(`${n} chat${n === 1 ? '' : 's'} imported`)
  }
  const ready = rows.filter(r => r.status === 'ready' && r.phone.trim() && r.customer).length

  return (
    <>
      <Head title="Import chats" actions={ready > 1 && <button type="button" className="btn btn-primary btn-sm" onClick={importAll}>Import {ready} chats</button>}>
        Bring chats from the WhatsApp Business app on your phone into the CRM — before the number moves here — so every customer’s history, payment screenshots and billing details are in their chat.
      </Head>

      <section className="was-card">
        <h3>1. Export each chat from the phone</h3>
        <ol className="wim-steps">
          <li><b>Android:</b> open the chat › ⋮ (top right) › More › <b>Export chat</b> › <b>Include media</b> › save to Google Drive or send to yourself.</li>
          <li><b>iPhone:</b> open the chat › tap the name at the top › <b>Export chat</b> › <b>Attach media</b> › save to Files.</li>
          <li>Each export is a .zip file. Start with the customers who matter now: open orders, partial payments, billing details.</li>
        </ol>
      </section>

      <section className="was-card">
        <h3>2. Add the exports here</h3>
        <label className="wim-drop">
          <Icon name="download" size={20} />
          <span><b>Choose exported chats</b> (.zip or .txt) — several at once is fine</span>
          <input type="file" accept=".zip,.txt" multiple onChange={e => { add(e.target.files); e.target.value = '' }} />
        </label>

        {!!rows.length && (
          <div className="wim-rows">
            {rows.map(r => (
              <div key={r.id} className={`wim-row wim-${r.status}`}>
                <div className="wim-file">
                  <b>{r.file.name}</b>
                  {r.status === 'reading' && <span className="was-hint">Reading…</span>}
                  {r.preview && <span className="was-hint">{r.preview.count} messages · {fmt(r.preview.first)} – {fmt(r.preview.last)}{r.preview.media ? ` · ${r.preview.media} files` : ' · no media (export with media to bring photos)'}</span>}
                  {r.error && <span className="was-bad">{r.error}</span>}
                </div>
                {r.preview && r.status !== 'done' && (
                  <div className="wim-fields">
                    <label className="input-group"><span>The customer is</span>
                      <select value={r.customer} onChange={e => set(r.id, { customer: e.target.value })}>
                        <option value="">Choose who is the customer…</option>
                        {r.preview.senders.map(s => <option key={s.name} value={s.name}>{s.name} ({s.n} messages)</option>)}
                      </select>
                    </label>
                    <label className="input-group"><span>Their WhatsApp number</span>
                      <input inputMode="tel" value={r.phone} placeholder="98765 43210" onChange={e => set(r.id, { phone: e.target.value })} />
                    </label>
                    <label className="input-group"><span>Name</span>
                      <input value={r.name} placeholder="Customer’s name" onChange={e => set(r.id, { name: e.target.value })} />
                    </label>
                    <button type="button" className="btn btn-primary btn-sm" disabled={r.status === 'importing' || !r.phone.trim() || !r.customer} onClick={() => importOne(r)}>
                      {r.status === 'importing' ? 'Importing…' : 'Import'}
                    </button>
                  </div>
                )}
                {r.status === 'done' && (
                  <div className="wim-done">
                    <span className="status-badge success">Imported</span>
                    <span>{r.result.imported} messages{r.result.media ? `, ${r.result.media} files` : ''}{r.result.already ? ` · ${r.result.already} were already here` : ''}</span>
                    <Link to={`${brand.path}?c=${r.result.conversation_id}`} className="mini-btn">Open the chat</Link>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <p className="was-hint">Nothing is sent to the customer. Messages you sent show as “from the phone app”; the 24-hour reply window is not reopened by imported messages.</p>
      </section>
    </>
  )
}
