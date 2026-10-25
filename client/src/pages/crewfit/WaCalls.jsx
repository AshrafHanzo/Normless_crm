import { useEffect, useRef, useState } from 'react'
import Icon from '../../components/Icon'

/**
 * WhatsApp voice calls in the inbox.
 *
 * The browser is the phone. It makes the WebRTC offer (or answer), the server passes it to Meta,
 * and the audio then runs straight between this tab and the customer's WhatsApp — the CRM's
 * server never carries sound. Meta takes the whole SDP at once rather than trickled candidates,
 * so every offer and answer waits for ICE gathering to finish before it is sent.
 *
 * Customer calls are found by polling /calls/live, like the rest of the inbox. That poll runs even
 * when the tab is in the background, because a call that only rings while somebody is looking at
 * the page is a call nobody answers. A customer's call rings for about 30–60 seconds; WhatsApp
 * hangs up on them after that.
 */

const STUN = [{ urls: 'stun:stun.l.google.com:19302' }]
const GATHER_MS = 2500

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

/** Wait for the candidates to be in the SDP, or as many as there are after GATHER_MS. */
function gathered(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise(resolve => {
    const done = () => { pc.removeEventListener('icegatheringstatechange', check); resolve() }
    const check = () => pc.iceGatheringState === 'complete' && done()
    pc.addEventListener('icegatheringstatechange', check)
    setTimeout(done, GATHER_MS)
  })
}

/** A phone-like ring made in the browser, so there is no sound file to ship or fail to load. */
function makeRinger() {
  let ctx = null
  let timer = null
  const burst = () => {
    const t = ctx.currentTime
    for (const [start, f] of [[0, 440], [0, 480], [0.5, 440], [0.5, 480]]) {
      const o = ctx.createOscillator(); const g = ctx.createGain()
      o.frequency.value = f
      g.gain.setValueAtTime(0.0001, t + start)
      g.gain.exponentialRampToValueAtTime(0.08, t + start + 0.03)
      g.gain.exponentialRampToValueAtTime(0.0001, t + start + 0.4)
      o.connect(g).connect(ctx.destination)
      o.start(t + start); o.stop(t + start + 0.42)
    }
  }
  return {
    start() {
      if (timer) return
      try {
        ctx = ctx || new (window.AudioContext || window.webkitAudioContext)()
        ctx.resume?.()
        burst()
        timer = setInterval(burst, 2500)
      } catch { /* no audio: the banner still shows */ }
    },
    stop() { clearInterval(timer); timer = null },
  }
}

// eslint-disable-next-line react-refresh/only-export-components -- the hook and its dock belong together
export function useWaCalls({ API, apiFetch, toast }) {
  const [settings, setSettings] = useState(null)       // { enabled, status, canManage }
  const [incoming, setIncoming] = useState([])          // customer calls ringing, not yet taken
  const [active, setActive] = useState(null)            // the call this tab is on
  const [micOff, setMicOff] = useState(false)
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)
  // Bumped whenever a call starts, changes or ends, so the open thread can re-read its call lines.
  const [version, setVersion] = useState(0)
  const liveKey = useRef('')

  const pc = useRef(null)
  const stream = useRef(null)
  const audio = useRef(null)
  const activeRef = useRef(null)
  const dismissed = useRef(new Set())                   // declined here: stop ringing for them
  const ringer = useRef(null)
  if (!ringer.current) ringer.current = makeRinger()

  useEffect(() => { activeRef.current = active }, [active])

  const loadSettings = async (fresh = false) => {
    const r = await apiFetch(`${API}/calls/settings${fresh ? '?fresh=1' : ''}`)
    if (r && !r.error) setSettings(r)
    return r
  }
  useEffect(() => { loadSettings() }, [API]) // eslint-disable-line react-hooks/exhaustive-deps

  /* ── The connection ──────────────────────────────────────────────────────────────────── */

  const teardown = () => {
    try { pc.current?.close() } catch { /* already closed */ }
    pc.current = null
    stream.current?.getTracks().forEach(t => t.stop())
    stream.current = null
    if (audio.current) audio.current.srcObject = null
    setMicOff(false)
  }

  const openLine = async () => {
    let media
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    } catch {
      throw new Error('The browser did not allow the microphone. Allow it for this site and try again.')
    }
    stream.current = media
    const conn = new RTCPeerConnection({ iceServers: STUN })
    media.getTracks().forEach(t => conn.addTrack(t, media))
    conn.ontrack = (e) => { if (audio.current) { audio.current.srcObject = e.streams[0]; audio.current.play?.().catch(() => {}) } }
    pc.current = conn
    return conn
  }

  /* ── Keeping up ──────────────────────────────────────────────────────────────────────── */

  const poll = useRef(() => {})
  poll.current = async () => {
    const r = await apiFetch(`${API}/calls/live`)
    if (!r || r.error) return
    const list = r.calls || []
    const key = list.map(c => `${c.id}:${c.status}`).join(',')
    if (key !== liveKey.current) {
      liveKey.current = key
      setVersion(v => v + 1)
      // WhatsApp's terminate webhook (with its own duration) lands a moment after a call ends.
      setTimeout(() => setVersion(v => v + 1), 4000)
    }
    setIncoming(list.filter(c => c.direction === 'in' && c.status === 'ringing' && !c.mine && !dismissed.current.has(c.id)))

    const mine = activeRef.current
    if (!mine?.id) return
    const now = list.find(c => c.id === mine.id)
    if (now) {
      // WhatsApp's answer to our offer: the customer's phone is reachable and ringing.
      if (now.answer_sdp && pc.current && !pc.current.remoteDescription) {
        try { await pc.current.setRemoteDescription({ type: 'answer', sdp: now.answer_sdp }) }
        catch (err) { toast.error(`Could not connect the audio: ${err.message}`) }
      }
      if (now.status !== mine.status || now.answered_at !== mine.answered_at) setActive(a => (a && a.id === now.id ? { ...a, ...now, answer_sdp: undefined } : a))
      return
    }
    // Gone from the live list: it ended — by the customer, by WhatsApp, or on another tab.
    const done = await apiFetch(`${API}/calls/${mine.id}`)
    teardown()
    setActive(null)
    const status = done?.call?.status
    if (status === 'rejected') toast.info('The customer declined the call')
    else if (status === 'no_answer') toast.info('No answer')
    else if (status === 'failed') toast.error(done?.call?.error || 'The call failed')
    else if (status === 'completed') toast.success(`Call ended${done.call.duration_sec ? ` · ${mmss(done.call.duration_sec)}` : ''}`)
  }

  useEffect(() => {
    const t = setInterval(() => poll.current(), 1500)
    return () => clearInterval(t)
  }, [])

  // The ring, while anything is ringing and this tab is not already on a call.
  useEffect(() => {
    if (incoming.length && !active) ringer.current.start()
    else ringer.current.stop()
  }, [incoming.length, active])

  // The in-call timer.
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setTick(x => x + 1), 1000)
    return () => clearInterval(t)
  }, [active])

  useEffect(() => () => { ringer.current.stop(); teardown() }, [])

  /* ── Placing a call ──────────────────────────────────────────────────────────────────── */

  const askPermission = async (thread) => {
    if (!thread.window_open) {
      return toast.error('The customer has not allowed calls, and the chat is past the 24-hour window — they need to write (or call) first before we can ask.')
    }
    const r = await apiFetch(`${API}/conversations/${thread.id}/call-permission`, { method: 'POST', body: JSON.stringify({}) })
    if (!r || r.error) return toast.error(r?.error || 'Could not ask for permission')
    toast.success('Asked. You can call once they tap Allow — WhatsApp lets us ask once a day.')
    return r.message
  }

  /** Turn calling on for the number, if this person may and agrees. */
  const ensureEnabled = async () => {
    const s = settings || await loadSettings()
    if (s?.enabled) return true
    if (s?.status === 'ERROR') { toast.error(s.error || 'Could not read the calling settings from WhatsApp'); return false }
    if (!s?.canManage) { toast.error('Calling is not switched on for this WhatsApp number. Ask a WhatsApp manager to turn it on.'); return false }
    if (!await toast.confirm({
      title: 'Turn on WhatsApp calling?',
      message: 'Customers will see a call button in their chat with this number, and the team can call customers who allow it. A customer who calls us can be called back for 7 days. Calls ring in this inbox.',
      confirmLabel: 'Turn on calling',
    })) return false
    const r = await apiFetch(`${API}/calls/settings`, { method: 'PUT', body: JSON.stringify({ enabled: true }) })
    if (!r || r.error) { toast.error(r?.error || 'WhatsApp would not switch calling on'); return false }
    setSettings(r)
    return r.enabled
  }

  /** Returns the permission message when one was sent, so the thread can show it. */
  const call = async (thread) => {
    if (active) return toast.error('You are already on a call')
    if (busy) return
    setBusy(true)
    try {
      if (!await ensureEnabled()) return
      const p = await apiFetch(`${API}/conversations/${thread.id}/call-permission`)
      if (!p || p.error) return toast.error(p?.error || 'Could not check whether the customer allows calls')
      if (p.status === 'no_permission' || p.can_call === false) {
        if (p.can_ask === false) return toast.error('The customer has not allowed calls, and WhatsApp will not let us ask again yet (once a day, twice a week).')
        if (!await toast.confirm({
          title: 'Ask to call first',
          message: `${thread.display_name} has not allowed calls from this number yet. Send them WhatsApp’s “May we call you?” message? They can allow it for 7 days or always.`,
          confirmLabel: 'Ask permission',
        })) return
        return await askPermission(thread)
      }

      const conn = await openLine()
      await conn.setLocalDescription(await conn.createOffer({ offerToReceiveAudio: true }))
      await gathered(conn)
      const r = await apiFetch(`${API}/conversations/${thread.id}/calls`, { method: 'POST', body: JSON.stringify({ sdp: conn.localDescription.sdp }) })
      if (!r || r.error) {
        teardown()
        if (r?.status === 409 && await toast.confirm({ title: 'Ask to call first', message: r.error, confirmLabel: 'Ask permission' })) return await askPermission(thread)
        return toast.error(r?.error || 'Could not place the call')
      }
      setActive({ ...r.call, display_name: thread.display_name, phone_pretty: thread.phone_pretty, startedAt: Date.now() })
    } catch (err) {
      teardown()
      toast.error(err.message || 'Could not place the call')
    } finally {
      setBusy(false)
    }
  }

  /* ── Taking a customer's call ────────────────────────────────────────────────────────── */

  const answer = async (c) => {
    if (active) return toast.error('Hang up the call you are on first')
    if (!c.offer_sdp) return toast.error('That call has already ended')
    setBusy(true)
    ringer.current.stop()
    try {
      const conn = await openLine()
      await conn.setRemoteDescription({ type: 'offer', sdp: c.offer_sdp })
      await conn.setLocalDescription(await conn.createAnswer())
      await gathered(conn)
      const pre = await apiFetch(`${API}/calls/${c.id}/pre-accept`, { method: 'POST', body: JSON.stringify({ sdp: conn.localDescription.sdp }) })
      if (!pre || pre.error) { teardown(); setIncoming(l => l.filter(x => x.id !== c.id)); return toast.error(pre?.error || 'Could not answer') }
      setActive({ ...pre.call, display_name: c.display_name, phone_pretty: c.phone_pretty, conversation_id: c.conversation_id, status: 'connecting', startedAt: Date.now() })
      setIncoming(l => l.filter(x => x.id !== c.id))
      // WhatsApp wants the media path up before it joins the customer in; a few seconds at most.
      for (let i = 0; i < 16 && !['connected', 'failed'].includes(conn.connectionState); i++) await sleep(250)
      const ok = await apiFetch(`${API}/calls/${c.id}/accept`, { method: 'POST', body: JSON.stringify({}) })
      if (!ok || ok.error) { teardown(); setActive(null); return toast.error(ok?.error || 'Could not connect the call') }
      setActive(a => (a ? { ...a, ...ok.call, startedAt: Date.now() } : a))
    } catch (err) {
      teardown(); setActive(null)
      toast.error(err.message || 'Could not answer')
    } finally {
      setBusy(false)
    }
  }

  const decline = async (c) => {
    dismissed.current.add(c.id)
    setIncoming(l => l.filter(x => x.id !== c.id))
    const r = await apiFetch(`${API}/calls/${c.id}/reject`, { method: 'POST', body: JSON.stringify({}) })
    if (r?.error) toast.error(r.error)
  }

  /** Stop ringing on this tab only; the call keeps ringing for the rest of the team. */
  const silence = (c) => { dismissed.current.add(c.id); setIncoming(l => l.filter(x => x.id !== c.id)) }

  const hangUp = async () => {
    const c = activeRef.current
    teardown()
    setActive(null)
    if (!c?.id) return
    const r = await apiFetch(`${API}/calls/${c.id}/hangup`, { method: 'POST', body: JSON.stringify({}) })
    if (r?.error) toast.error(r.error)
    else if (r?.call?.duration_sec) toast.success(`Call ended · ${mmss(r.call.duration_sec)}`)
  }

  const toggleMic = () => {
    const next = !micOff
    stream.current?.getAudioTracks().forEach(t => { t.enabled = !next })
    setMicOff(next)
  }

  const elapsed = active?.answered_at || active?.status === 'accepted'
    ? Math.max(0, Math.floor((Date.now() - (active.answered_at ? new Date(active.answered_at).getTime() : active.startedAt)) / 1000))
    : null
  void tick

  return { settings, incoming, active, micOff, busy, elapsed, audio, version, call, answer, decline, silence, hangUp, toggleMic, loadSettings }
}

const STATUS_WORDS = {
  calling: 'Calling…', ringing: 'Ringing…', connecting: 'Connecting…', accepted: 'On call',
}

/** The banner for a ringing customer call, and the bar for the call this tab is on. */
export function WaCallDock({ calls, onOpen }) {
  const { incoming, active, micOff, busy, elapsed, audio, answer, decline, silence, hangUp, toggleMic } = calls
  return (
    <>
      {/* Remote audio. Kept mounted so the stream can be attached before the call connects. */}
      <audio ref={audio} autoPlay playsInline hidden />
      {(!!incoming.length || active) && (
        <div className="wa-call-dock" role="region" aria-label="WhatsApp calls" aria-live="assertive">
          {active && (
            <div className="wa-call-bar">
              <span className="wa-call-pulse" aria-hidden="true"><Icon name="phone" size={16} /></span>
              <button type="button" className="wa-call-who" onClick={() => onOpen?.(active.conversation_id)} title="Open the chat">
                <b>{active.display_name || 'Customer'}</b>
                <span>{elapsed != null ? mmss(elapsed) : (STATUS_WORDS[active.status] || active.status)}{micOff ? ' · muted' : ''}</span>
              </button>
              <button type="button" className={`wa-call-btn${micOff ? ' wa-call-btn-on' : ''}`} onClick={toggleMic}
                aria-pressed={micOff} title={micOff ? 'Unmute your microphone' : 'Mute your microphone'}>
                <Icon name={micOff ? 'micOff' : 'mic'} size={18} />
                <span>{micOff ? 'Unmute' : 'Mute'}</span>
              </button>
              <button type="button" className="wa-call-btn wa-call-end" onClick={hangUp} title="Hang up">
                <Icon name="phoneOff" size={18} /><span>Hang up</span>
              </button>
            </div>
          )}
          {incoming.map(c => (
            <div key={c.id} className="wa-call-ring">
              <span className="wa-call-pulse wa-call-pulse-ring" aria-hidden="true"><Icon name="phone" size={16} /></span>
              <button type="button" className="wa-call-who" onClick={() => onOpen?.(c.conversation_id)} title="Open the chat">
                <b>{c.display_name}</b>
                <span>WhatsApp voice call · {c.phone_pretty}</span>
              </button>
              <button type="button" className="wa-call-btn wa-call-accept" disabled={busy || !!active} onClick={() => answer(c)}
                title={active ? 'Hang up first' : 'Answer'}>
                <Icon name="phone" size={18} /><span>Answer</span>
              </button>
              <button type="button" className="wa-call-btn wa-call-end" onClick={() => decline(c)} title="Decline the call for everyone">
                <Icon name="phoneOff" size={18} /><span>Decline</span>
              </button>
              <button type="button" className="wa-call-btn" onClick={() => silence(c)} title="Stop ringing here; it keeps ringing for the team">
                <Icon name="bellOff" size={18} /><span>Silence</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
