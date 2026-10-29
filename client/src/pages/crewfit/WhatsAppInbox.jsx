import { useState, useEffect, useRef, useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useApi, useAuth, useMainMenu } from '../../App'
import { useToast } from '../../components/Toast'
import Icon from '../../components/Icon'
import CrewfitOrderDrawer from './CrewfitOrderDrawer'
import { PdfThumb, PdfViewer } from '../../components/PdfPreview'
import WaQuoteDrawer from './WaQuoteDrawer'
import { WA_BRANDS } from './waBrand'
import TicketDrawer from '../support/TicketDrawer'
import { refOf } from '../support/ticket'
import { useWaCalls, WaCallDock } from './WaCalls'
import WaNewChat from './WaNewChat'
import { WaText, Ticks, BubbleButtons } from './WaBubble'

const FILTERS = [
  { key: 'waiting', label: 'Needs a person', hot: true },
  { key: 'mine', label: 'Mine', badge: 'unread_mine' },
  { key: 'unassigned', label: 'Unassigned', badge: 'unread_unassigned' },
  { key: 'all', label: 'All', badge: 'unread' },
]

// Normless's queues, as the design lays them out: who needs a person first.
const NL_FILTERS = [
  { key: 'waiting', label: 'Needs a person', hot: true },
  { key: 'bot', label: 'Bot handling' },
  { key: 'mine', label: 'Mine' },
  { key: 'ticket', label: 'Ticket open' },
  { key: 'closed', label: 'Closed' },
  { key: 'all', label: 'All' },
]

const clock = (v) => (v ? new Date(v).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '')
const day = (v) => (v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '')

/** "2 hours ago" is what a thread list is read with, not a timestamp. */
const ago = (v) => {
  if (!v) return ''
  const mins = Math.max(0, Math.round((Date.now() - new Date(v).getTime()) / 60000))
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return day(v)
}

/** How long is left to reply freely, in the words somebody would use out loud. */
const windowLabel = (ms) => {
  const hrs = Math.floor(ms / 3600000)
  if (hrs >= 1) return `${hrs}h left to reply`
  const mins = Math.max(1, Math.round(ms / 60000))
  return `${mins}m left to reply`
}

const initials = (name) => String(name || '?').replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/)
  .slice(0, 2).map(w => w[0]).join('').toUpperCase() || '#'
const short = (u) => (u ? u.split('@')[0] : '')
const money = (v) => (v == null || v === '' ? '' : `₹${Number(v).toLocaleString('en-IN')}`)

// The order messages offered on each order, in the order they are usually needed.
const ORDER_SENDS = [
  ['summary', 'Summary'], ['advance_link', 'Advance link'], ['payment_qr', 'Payment QR'], ['mockups', 'Mockups'],
  ['proforma', 'Proforma'], ['photos', 'Photos'], ['balance_link', 'Balance link'], ['invoice', 'Invoice'], ['dispatch', 'Tracking'],
]
// What the customer owes, by the order's payment status.
const PAY_LOOK = {
  Pending: ['Advance due', '#fbbf24'],
  '50% Paid': ['Balance due', '#fb923c'],
  'Fully Paid': ['Paid', '#34d399'],
}

// Name, number and delivery address are what an order needs; the rest only for a GST invoice.
const BILLING = [
  ['contact_person', 'Name', false],
  ['billing_mobile', 'Contact number', false],
  ['delivery_address', 'Delivery address', true],
  ['billing_name', 'Billing / company name (optional)', false],
  ['billing_address', 'Billing address (optional)', true],
  ['billing_email', 'Email (optional)', false],
  ['gst_number', 'GST number (optional)', false],
]

/**
 * Save a file to the computer. Fetched and handed over as a blob, because a plain link with
 * `download` is ignored when the file is served from another origin — the API, in development —
 * and the browser just opens it instead.
 */
async function downloadFile(url, name) {
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(String(res.status))
    const blob = await res.blob()
    const href = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = href
    a.download = name || url.split('/').pop() || 'file'
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(href), 10000)
    return true
  } catch {
    window.open(url, '_blank')
    return false
  }
}

const extFor = (mime, url) => {
  const fromUrl = String(url || '').match(/\.([a-z0-9]{2,5})(?:\?|$)/i)?.[1]
  if (fromUrl) return fromUrl
  return { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf', 'video/mp4': 'mp4', 'audio/ogg': 'ogg' }[mime] || 'bin'
}
const fileNameFor = (m, who) => m.media_name || `${who || 'customer'}-${day(m.sent_at).replace(/\s+/g, '')}-${m.id}.${extFor(m.media_mime, m.media_url)}`

/** A file in the chat as WhatsApp shows one: type, name, and a way to look at it. */
function DocCard({ name, mime, url, onOpen }) {
  const ext = (String(name || '').split('.').pop() || 'file').slice(0, 4).toUpperCase()
  const isPdf = /pdf/i.test(mime || '') || ext === 'PDF'
  const [pages, setPages] = useState(null)
  return (
    <div className="wa-doc-wrap">
      {isPdf && url && <PdfThumb url={url} width={260} onPages={setPages} onClick={onOpen} />}
    <div className="wa-doc">
      <span className={`wa-doc-icon${isPdf ? ' wa-doc-pdf' : ''}`} aria-hidden="true">{isPdf ? 'PDF' : ext}</span>
      <span className="wa-doc-name">{name || 'File'}{pages ? <small>{pages} page{pages === 1 ? '' : 's'} · PDF</small> : null}</span>
      {url ? (
        <span className="wa-doc-actions">
          {isPdf && <button type="button" className="mini-btn" onClick={onOpen}>Preview</button>}
          <button type="button" className="mini-btn" onClick={() => downloadFile(url, name)}>Download</button>
        </span>
      ) : <span className="wa-doc-gone">Not kept on the server</span>}
    </div>
    </div>
  )
}

/** Why an order message cannot be sent yet, or null when it can. Shown on the greyed-out button. */
const NO_TRACKING = ['Porter', 'Self Pickup']
function notYet(o, kind) {
  const paid = o.payment_status
  switch (kind) {
    case 'advance_link': return paid !== 'Pending' ? 'The advance is already paid' : null
    case 'proforma': return paid === 'Pending' ? 'Record the advance first' : null
    case 'balance_link': return paid === 'Pending' ? 'Collect the advance first' : paid === 'Fully Paid' ? 'Already fully paid' : null
    case 'payment_qr': return paid === 'Fully Paid' ? 'Already fully paid' : null
    case 'invoice': return paid !== 'Fully Paid' ? 'Issued once the order is fully paid' : null
    case 'dispatch': return !o.tracking_link && !NO_TRACKING.includes(o.mot) ? 'Add the tracking ID on the order first' : null
    default: return null
  }
}

const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const ago10 = (phone) => String(phone || '').slice(-10)
const soName = (username) => { const n = String(username || '').split('@')[0].replace(/[._-]+/g, ' ').trim(); return n ? n.replace(/\b\w/g, c => c.toUpperCase()) : '' }


/** A status's colour as a pill: tinted ground, full-strength text. */
const pillStyle = (color) => ({ background: `color-mix(in srgb, ${color} 16%, transparent)`, color })

/** What a template's {{n}} is filled with, from the conversation in front of the rep. */
const fillFrom = (source, thread, me) => {
  const name = thread?.lead_name || thread?.profile_name || ''
  switch (source) {
    case 'first_name': return name.split(/\s+/)[0] || ''
    case 'name': return name
    case 'company': return thread?.lead_company || ''
    case 'product': return thread?.product_interest || ''
    case 'quantity': return thread?.quantity || ''
    case 'quoted_amount': return thread?.quoted_amount != null ? Number(thread.quoted_amount).toLocaleString('en-IN') : ''
    case 'balance_due': return thread?.quoted_amount != null
      ? Math.max(0, Number(thread.quoted_amount) - Number(thread.received_amount || 0)).toLocaleString('en-IN') : ''
    case 'needed_by': return thread?.needed_by ? day(thread.needed_by) : ''
    case 'agent_name': return short(me)
    default: return ''
  }
}

const leadFormFrom = (t) => ({
  product_interest: t?.product_interest || '',
  quantity: t?.quantity || '',
  branding: t?.branding || '',
  needed_by: t?.needed_by ? String(t.needed_by).slice(0, 10) : '',
  quoted_amount: t?.quoted_amount ?? '',
  received_amount: t?.received_amount ?? '',
  lead_company: t?.lead_company || '',
  lead_notes: t?.lead_notes || '',
})
// The panel's names for these, against the lead's own columns.
const LEAD_COLUMN = { lead_company: 'company', lead_notes: 'notes' }

/**
 * The WhatsApp inbox.
 *
 * Enquiries used to arrive on somebody's phone, which meant nobody else could see them: not who
 * had answered, not what was promised, not how many came in this week. This is that conversation,
 * in the CRM, beside the orders it turns into.
 *
 * Three columns: the threads, filtered by who has them and by the lead's status; the conversation
 * itself; and the lead it belongs to, edited in place. The lead's status is the shop's own list
 * (Settings › Lead statuses), so the filter chips and the panel read it from the server.
 *
 * Two WhatsApp rules show on the page because they change what a person can do. The first is the
 * 24-hour window: after a day of silence WhatsApp allows nothing but an approved template, so the
 * box says so and stops rather than letting the send fail. The second is that a thread belongs to
 * somebody — answering an unclaimed one takes it, which is how a shared inbox avoids two people
 * replying to the same customer.
 *
 * It polls rather than holding a socket open. The server runs as one process behind nginx, and a
 * three-second poll of a handful of rows is cheaper to run and far cheaper to reason about than
 * the connection handling a push would need; a message lands here within a tick of arriving.
 */
/** Their WhatsApp photo where we have one, else their initials. */
function Avatar({ who, large }) {
  // Which photo failed to load, so a new one is still tried.
  const [broken, setBroken] = useState(null)
  const cls = `wa-avatar${large ? ' wa-avatar-lg' : ''}`
  if (who?.avatar_url && who.avatar_url !== broken) return <img className={`${cls} wa-avatar-img`} src={who.avatar_url} alt="" onError={() => setBroken(who.avatar_url)} />
  return <span className={cls} aria-hidden="true">{initials(who?.display_name)}</span>
}

/** Whether chat a comes after chat b in the list: older last message, chats with none at the end. */
const olderThan = (a, b) => {
  const ta = a.last_message_at ? new Date(a.last_message_at).getTime() : -Infinity
  const tb = b.last_message_at ? new Date(b.last_message_at).getTime() : -Infinity
  return ta < tb || (ta === tb && a.id < b.id)
}

export default function WhatsAppInbox({ brand: brandKey = 'crewfit' }) {
  // Crewfit's inbox or Normless's: the same page, each brand's own number and API. Leads,
  // orders, quotes, the catalogue and the menu are Crewfit's alone.
  const brand = WA_BRANDS[brandKey]
  const API = brand.api
  const cf = brand.key === 'crewfit'
  const apiFetch = useApi()
  const toast = useToast()
  const { user, API_URL } = useAuth()
  const { openMenu } = useMainMenu()
  // Files the server keeps under /uploads are served from the API, which is another origin in dev.
  const fileUrl = (u) => (u && u.startsWith('/') ? `${API_URL}${u}` : u)
  const [params, setParams] = useSearchParams()
  // Voice calls: the call button, the ring for a customer's call, the in-call bar.
  const calls = useWaCalls({ API, apiFetch, toast })

  const [config, setConfig] = useState(null)
  const [filter, setFilter] = useState(params.get('filter') || 'all')
  const [focusOrder, setFocusOrder] = useState(null)    // Normless: the order the panel is about
  const [statusFilter, setStatusFilter] = useState(params.get('status') || '')
  const [search, setSearch] = useState('')
  const [term, setTerm] = useState('')
  const [conversations, setConversations] = useState([])
  const [statusCounts, setStatusCounts] = useState({})
  const [tally, setTally] = useState({ open: 0, unassigned: 0, unread: 0, waiting: 0, bot: 0, mine: 0, ticket: 0, closed: 0 })
  const [newChat, setNewChat] = useState(false)
  const [openId, setOpenId] = useState(params.get('c') ? Number(params.get('c')) : null)
  const [thread, setThread] = useState(null)
  const [messages, setMessages] = useState([])
  const [agents, setAgents] = useState([])
  const [statuses, setStatuses] = useState([])
  const [draft, setDraft] = useState('')
  const [quickReplies, setQuickReplies] = useState([])
  const [products, setProducts] = useState([])
  const [pop, setPop] = useState(null)                 // 'snippets' | 'templates' | 'catalogue'
  const [notes, setNotes] = useState([])
  const [settings, setSettings] = useState(null)
  const [templates, setTemplates] = useState([])
  // The "reopen the chat" templates: what to send when the customer has been quiet over a day.
  const [openers, setOpeners] = useState([])
  const [picking, setPicking] = useState(null)        // the template being filled in
  const [values, setValues] = useState([])
  const [noteDraft, setNoteDraft] = useState('')
  const [lead, setLead] = useState(leadFormFrom(null))
  const [sideTab, setSideTab] = useState(cf ? 'lead' : 'customer')   // 'lead' | 'orders' | 'activity' | 'customer'
  const [orders, setOrders] = useState([])
  const [canEditOrders, setCanEditOrders] = useState(false)
  const [activity, setActivity] = useState([])
  const [orderTarget, setOrderTarget] = useState(null)  // the order drawer: a prefill or an order
  const [pending, setPending] = useState([])            // sends in flight, shown in the chat
  const [billingForm, setBillingForm] = useState({})
  const [quotes, setQuotes] = useState([])
  const [menuFlow, setMenuFlow] = useState(null)
  const [mockups, setMockups] = useState([])
  const [mockPick, setMockPick] = useState([])           // mockup ids ticked to send
  const [mockUploading, setMockUploading] = useState(false)
  const [canQuote, setCanQuote] = useState(false)
  const [quoteOpen, setQuoteOpen] = useState(false)
  const quoteToLink = useRef(null)                      // the quote an order is being made from
  const [preview, setPreview] = useState(null)          // a document opened from the chat
  const [health, setHealth] = useState(null)            // is Meta still accepting our token?
  const [cataloguePdf, setCataloguePdf] = useState(null)
  const [snippetQuery, setSnippetQuery] = useState('')
  const [newReply, setNewReply] = useState(null)        // { title, body } while saving a new reply
  const [loading, setLoading] = useState(true)
  // Normless: the Shopify customer behind the chat, and a support ticket being raised from it.
  const [shop, setShop] = useState(null)               // { customer, orders, tickets, media }
  const [ticketDraft, setTicketDraft] = useState(null)  // the new ticket's prefill, while the drawer is open
  const [ticketOptions, setTicketOptions] = useState(null)
  const [ticketPhotos, setTicketPhotos] = useState([])  // chat photo message ids to copy onto it
  const [ticketNotify, setTicketNotify] = useState(true)

  const feedRef = useRef(null)
  const threadRef = useRef(null)
  const fileRef = useRef(null)
  // The newest message already on screen. The poll asks for what came after it rather than
  // re-reading the whole thread every three seconds.
  const lastSeen = useRef(0)
  const stickToBottom = useRef(true)

  useEffect(() => { threadRef.current = thread }, [thread])
  const statusOf = useMemo(() => Object.fromEntries(statuses.map(s => [s.key, s])), [statuses])
  const statusLook = (key) => statusOf[key] || { name: key || 'New', color: '#8a91a0' }

  useEffect(() => {
    apiFetch(`${API}/config`).then(r => r && !r.error && setConfig(r))
    apiFetch(`${API}/agents`).then(r => r && !r.error && setAgents(r.agents || []))
    apiFetch(`${API}/quick-replies`).then(r => r && !r.error && setQuickReplies(r.quickReplies || []))
    apiFetch(`${API}/templates`).then(r => r && !r.error && setTemplates(r.templates || []))
    apiFetch(`${API}/openers`).then(r => r && !r.error && setOpeners(r.openers || []))
    apiFetch(`${API}/health`).then(r => r && setHealth(r))
    if (!cf) return
    apiFetch(`${API}/statuses`).then(r => r && !r.error && setStatuses(r.statuses || []))
    apiFetch(`${API}/catalogue`).then(r => r && !r.error && setProducts(r.products || []))
    apiFetch(`${API}/settings`).then(r => r && !r.error && setSettings(r))
    apiFetch(`${API}/flows`).then(r => r && !r.error && setMenuFlow(r.flows?.[0] || null))
    apiFetch(`${API}/catalogue-pdf`).then(r => r && !r.error && setCataloguePdf(r.catalogue))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Typing in the search box should not put a query on the wire per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 350)
    return () => clearTimeout(t)
  }, [search])

  // A popover closes on a click anywhere outside it.
  useEffect(() => {
    if (!pop) return
    const close = (e) => {
      const el = e.target instanceof Element ? e.target : null
      if (!el?.closest('.wa-pop-anchor') && !el?.closest('.wa-compose-row')) setPop(null)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [pop])

  /* ── The thread list ─────────────────────────────────────────────────────────────────── */

  const listQuery = () => {
    const qs = new URLSearchParams({ filter, status: 'open' })
    if (term) qs.set('search', term)
    if (statusFilter) qs.set('lead_status', statusFilter)
    return qs
  }
  // Which filters the list on screen was loaded for: a refresh with the same ones keeps the pages
  // already scrolled through, a change of filter starts the list again.
  const listKey = useRef('')
  const conversationsRef = useRef([])
  conversationsRef.current = conversations
  const loadConversations = async () => {
    const qs = listQuery()
    const key = qs.toString()
    const r = await apiFetch(`${API}/conversations?${qs}`)
    if (r && !r.error) {
      const head = r.conversations || []
      const same = listKey.current === key
      listKey.current = key
      if (!same || conversationsRef.current.length <= head.length) {
        setConversations(head)
        setNextPage(r.next || null)
      } else {
        // The first page, refreshed, then the older chats already loaded below it.
        const ids = new Set(head.map(c => c.id))
        const last = head[head.length - 1]
        setConversations(prev => [...head, ...prev.filter(c => !ids.has(c.id) && (!last || olderThan(c, last)))])
      }
      setTally(r.tally || { open: 0, unassigned: 0, unread: 0 })
      setStatusCounts(r.statusCounts || {})
    }
    setLoading(false)
  }

  // The next 60 chats, when the list is scrolled near its end.
  const [nextPage, setNextPage] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const loadMore = async () => {
    if (!nextPage || loadingMore) return
    setLoadingMore(true)
    const qs = listQuery()
    qs.set('before_id', String(nextPage.before_id))
    qs.set('before_at', nextPage.before_at || '')
    const key = listQuery().toString()
    const r = await apiFetch(`${API}/conversations?${qs}`)
    if (r && !r.error && listKey.current === key) {
      setConversations(prev => {
        const have = new Set(prev.map(c => c.id))
        return [...prev, ...(r.conversations || []).filter(c => !have.has(c.id))]
      })
      setNextPage(r.next || null)
    }
    setLoadingMore(false)
  }
  const onListScroll = (e) => {
    const el = e.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 400) loadMore()
  }

  useEffect(() => {
    setLoading(true)
    loadConversations()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, term, statusFilter])

  /* ── One conversation ────────────────────────────────────────────────────────────────── */

  const showThread = (t) => {
    setThread(t)
    setLead(leadFormFrom(t))
    setBillingForm(Object.fromEntries(BILLING.map(([k]) => [k, t?.[k] || ''])))
  }

  const openConversation = async (id) => {
    setOpenId(id)
    setMessages([])
    setPop(null)
    lastSeen.current = 0
    stickToBottom.current = true
    // The chat's own address; an ?order= link has done its job once the chat is open.
    setParams(prev => { const next = new URLSearchParams(prev); next.set('c', String(id)); next.delete('order'); return next },
      { replace: true })

    const r = await apiFetch(`${API}/conversations/${id}`)
    if (!r || r.error) return toast.error(r?.error || 'Could not open that conversation')
    showThread(r.conversation)
    const m = await apiFetch(`${API}/conversations/${id}/messages`)
    if (m && !m.error) {
      setMessages(m.messages || [])
      lastSeen.current = m.messages?.length ? m.messages[m.messages.length - 1].id : 0
    }
    apiFetch(`${API}/conversations/${id}/read`, { method: 'POST' })
    setConversations(list => list.map(c => (c.id === id ? { ...c, unread_count: 0 } : c)))
    const n = await apiFetch(`${API}/conversations/${id}/notes`)
    if (n && !n.error) setNotes(n.notes || [])
    loadActivity(id)
    if (cf) { loadOrders(id); loadMockups(id) } else { setShop(null); setFocusOrder(null); loadShop(id) }
  }

  const loadShop = async (id = thread?.id) => {
    if (!id) return
    const r = await apiFetch(`${API}/conversations/${id}/customer`)
    if (r && !r.error) setShop(r)
  }

  const loadMockups = async (id = thread?.id) => {
    if (!id) return
    const r = await apiFetch(`${API}/conversations/${id}/mockups`)
    if (r && !r.error) { setMockups(r.mockups || []); setMockPick((r.mockups || []).filter(m => !m.sent_at).map(m => m.id)) }
  }

  const uploadMockups = async (files) => {
    if (!files?.length) return
    setMockUploading(true)
    const fd = new FormData()
    for (const f of files) fd.append('files', f)
    const r = await apiFetch(`${API}/conversations/${thread.id}/mockups`, { method: 'POST', body: fd })
    setMockUploading(false)
    if (!r || r.error) return toast.error(r?.error || 'Could not upload the mockups')
    setMockups(r.mockups)
    setMockPick(r.mockups.filter(m => !m.sent_at).map(m => m.id))
    loadActivity()
  }

  const removeMockup = async (m) => {
    const r = await apiFetch(`${API}/conversations/${thread.id}/mockups/${m.id}`, { method: 'DELETE' })
    if (!r || r.error) return toast.error(r?.error || 'Could not remove that')
    setMockups(r.mockups)
    setMockPick(p => p.filter(x => x !== m.id))
  }

  const sendMockups = async () => {
    const chosen = mockups.filter(m => mockPick.includes(m.id))
    if (!chosen.length) return toast.error('Tick the mockups to send')
    if (chosen.some(m => m.sent_at) && !await toast.confirm({
      title: 'Some of these were already sent',
      message: `${chosen.filter(m => m.sent_at).length} of the ${chosen.length} went to ${thread.display_name} before. Send them again?`,
      confirmLabel: 'Send again',
    })) return
    await track({
      label: `🎨 ${chosen.length} mockup${chosen.length > 1 ? 's' : ''} for approval`, retryKey: 'mockups',
      stages: [[0, 'Uploading the mockup…'], [3000, 'Sending to WhatsApp…']],
      run: () => apiFetch(`${API}/conversations/${thread.id}/mockups/send`, { method: 'POST', body: JSON.stringify({ ids: chosen.map(m => m.id) }) }),
      onDone: (r) => { for (const m of r.messages || []) appendSent(m); setMockups(r.mockups); setMockPick([]); loadActivity() },
    })
  }

  // Everything the customer has sent, newest first: logos, references, payment screenshots.
  const customerFiles = messages.filter(m => m.direction === 'in' && m.media_url).slice().reverse()
  const downloadAll = async () => {
    for (const m of customerFiles) {
      await downloadFile(fileUrl(m.media_url), fileNameFor(m, ago10(thread.phone)))
      await new Promise(r => setTimeout(r, 300))    // browsers drop downloads fired all at once
    }
  }

  const loadOrders = async (id = thread?.id) => {
    if (!id) return
    const [r, q] = await Promise.all([
      apiFetch(`${API}/conversations/${id}/orders`),
      apiFetch(`${API}/conversations/${id}/quotes`),
    ])
    if (r && !r.error) { setOrders(r.orders || []); setCanEditOrders(!!r.canEdit) }
    if (q && !q.error) { setQuotes(q.quotes || []); setCanQuote(!!q.canQuote) }
  }
  const loadActivity = async (id = thread?.id) => {
    if (!id) return
    const r = await apiFetch(`${API}/conversations/${id}/activity`)
    if (r && !r.error) setActivity(r.activity || [])
  }

  /* ── Normless: support tickets from the chat ───────────────────────────────────────────── */

  const canTicket = ['admin', 'owner'].includes(user?.role) || !!user?.can_edit_support
  // The order the Normless panel is about: the one picked, else the latest.
  const nlOrder = shop?.orders?.find(o => o.order_number === focusOrder) || shop?.orders?.[0] || null
  const chatPhotos = messages.filter(m => m.direction === 'in' && m.media_url && /^image\/(jpeg|png|webp)$/.test(m.media_mime || ''))

  /** Open Support's own ticket form, filled in from the chat and, when given, one order. */
  const raiseTicket = async (order = null) => {
    if (thread?.is_demo) return toast.info('This is the demo chat — tickets can only be raised from a real customer’s chat.')
    if (!ticketOptions) {
      const o = await apiFetch('/api/support/options')
      if (!o || o.error) return toast.error(o?.error || 'Could not open Support')
      setTicketOptions(o)
    }
    const c = shop?.customer
    // The latest photos the customer sent are the likely proof; a person unticks what is not.
    setTicketPhotos(chatPhotos.slice(-8).map(m => m.id))
    setTicketNotify(!!thread.window_open)
    setTicketDraft({
      order_number: order?.order_number || '',
      customer_name: c?.name || thread.profile_name || '',
      customer_phone: thread.phone_pretty || '',
      customer_email: c?.email || '',
      source: 'WhatsApp',
    })
  }

  const ticketRaised = async (ticket, isNew) => {
    setTicketDraft(null)
    if (!isNew || !ticket?.id) return
    const link = await apiFetch(`${API}/conversations/${thread.id}/ticket`, {
      method: 'POST', body: JSON.stringify({ ticket_id: ticket.id, message_ids: ticketPhotos }),
    })
    if (!link || link.error) toast.error(link?.error || 'The ticket was raised, but not tied to this chat')
    else if (link.copied) toast.success(`${link.copied} photo${link.copied === 1 ? '' : 's'} from the chat added to ${refOf(ticket)}`)
    if (ticketNotify && thread.window_open) {
      const first = (shop?.customer?.first_name || thread.profile_name || '').split(' ')[0]
      const text = `Thanks${first ? ` ${first}` : ''}, we've raised ticket ${refOf(ticket)}${ticket.order_number ? ` for order ${ticket.order_number}` : ''}. `
        + 'Our team will get back to you here between 9 am and 6 pm. You can reply in this chat anytime to ask about it.'
      const r = await apiFetch(`${API}/conversations/${thread.id}/messages`, { method: 'POST', body: JSON.stringify({ body: text }) })
      if (r && !r.error && r.message) appendSent(r.message)
      else toast.error(r?.error || 'The ticket was raised, but the message to the customer did not go')
    }
    setSideTab('tickets')
    loadShop()
    loadActivity()
  }

  /** Where an order is, written for the customer — put in the reply box to check before sending. */
  const orderStatusText = (o) => {
    const items = o.items.map(i => `${i.title}${i.variant ? ` (${i.variant})` : ''}`).join(', ')
    const lines = [`Your order ${o.order_number}${items ? ` — ${items}` : ''}:`]
    if (o.state === 'Cancelled') lines.push('This order was cancelled.')
    else if (o.state === 'Shipped') {
      lines.push(`Shipped${o.shipped_at ? ` on ${day(o.shipped_at)}` : ''}${o.dispatch?.courier ? ` with ${o.dispatch.courier}` : ''}.`)
      if (o.dispatch?.tracking_url) lines.push(`Track it here: ${o.dispatch.tracking_url}`)
    } else lines.push('It hasn’t shipped yet — orders go out within 1–3 business days.')
    setDraft(lines.join('\n'))
  }

  // Normless has no settings tab for templates yet: a manager pulls the approved ones from Meta here.
  const syncTemplates = async () => {
    const r = await apiFetch(`${API}/templates/sync`, { method: 'POST' })
    if (!r || r.error) return toast.error(r?.error || 'Could not read the templates from Meta')
    const t = await apiFetch(`${API}/templates`)
    if (t && !t.error) setTemplates(t.templates || [])
    toast.success(`${r.approved} approved template${r.approved === 1 ? '' : 's'}`)
  }

  // A conversation linked to from elsewhere — a notification, a bookmark — opens on arrival.
  useEffect(() => {
    const orderId = cf && params.get('order')
    if (orderId) {
      apiFetch(`${API}/orders/${orderId}/conversation`).then(r => {
        if (!r || r.error) return toast.error(r?.error || 'Could not open the chat for that order')
        openConversation(r.conversation.id).then(() => setSideTab('orders'))
        loadConversations()
      })
    } else if (openId && !thread) openConversation(openId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ── Keeping up ──────────────────────────────────────────────────────────────────────── */

  // Held in a ref and called by one interval that is created once. Hanging the interval off the
  // loading functions themselves re-creates it on every render — the page then reloads itself as
  // fast as the server can answer, and the thread list is rebuilt under the cursor.
  const poll = useRef(() => {})
  poll.current = async () => {
    if (document.hidden) return
    loadConversations()
    if (!openId) return
    const m = await apiFetch(`${API}/conversations/${openId}/messages?after=${lastSeen.current}`)
    if (m && !m.error && m.messages?.length) {
      setMessages(list => {
        const have = new Set(list.map(x => x.id))
        return [...list, ...m.messages.filter(x => !have.has(x.id))]
      })
      lastSeen.current = m.messages[m.messages.length - 1].id
      apiFetch(`${API}/conversations/${openId}/read`, { method: 'POST' })
    }
    // Ticks change on messages already here, and the 24-hour countdown moves whether or not
    // anything new arrives, so the header is refreshed with them. The lead form is left alone:
    // somebody may be typing in it.
    const r = await apiFetch(`${API}/conversations/${openId}`)
    if (r && !r.error) {
      // Fields the customer just filled in through the chat appear without a reload — but never
      // over something a rep is in the middle of typing.
      const prev = threadRef.current
      const focused = document.activeElement?.id?.startsWith('wa-b-') ? document.activeElement.id.slice(5) : null
      const changed = BILLING.map(([k]) => k).filter(k => k !== focused && (r.conversation[k] || '') !== (prev?.[k] || ''))
      if (changed.length) setBillingForm(f => ({ ...f, ...Object.fromEntries(changed.map(k => [k, r.conversation[k] || ''])) }))
      setThread(r.conversation)
    }
  }

  useEffect(() => {
    const t = setInterval(() => poll.current(), 3000)
    return () => clearInterval(t)
  }, [])

  // A call's line in the thread changes as the call goes (ringing → 4 min 10 s, or missed), which
  // the poll for new messages cannot see, so the thread is re-read whole when calls change.
  useEffect(() => {
    if (!openId || !calls.version) return
    apiFetch(`${API}/conversations/${openId}/messages`).then(all => {
      if (!all || all.error || !all.messages) return
      setMessages(list => [...all.messages, ...list.filter(x => x.id > (all.messages.at(-1)?.id || 0))])
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calls.version])

  // Follow the conversation down as it grows, unless the person has scrolled up to read history.
  useEffect(() => {
    const el = feedRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [messages])

  const onFeedScroll = () => {
    const el = feedRef.current
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  /* ── Sending ─────────────────────────────────────────────────────────────────────────── */

  const appendSent = (message) => {
    setMessages(list => [...list, message])
    lastSeen.current = message.id
    stickToBottom.current = true
    loadConversations()
  }

  /**
   * Every send shows in the chat the moment it is clicked, as a bubble that says what is happening
   * — making the link, generating the PDF, uploading — and turns into the real message when it
   * lands, or red with the reason and a Retry when it does not. Without it a send that takes a few
   * seconds looks like nothing happened, and people click again.
   */
  const track = async ({ label, stages = [], run, onDone, retryKey }) => {
    const id = `p${Date.now()}${Math.random().toString(36).slice(2, 6)}`
    stickToBottom.current = true
    setPending(list => [...list, { id, label, stage: stages[0]?.[1] || 'Sending…', retryKey }])
    const timers = stages.slice(1).map(([ms, text]) => setTimeout(() =>
      setPending(list => list.map(x => (x.id === id && !x.error ? { ...x, stage: text } : x))), ms))
    const r = await run()
    timers.forEach(clearTimeout)
    if (!r || r.error) {
      setPending(list => list.map(x => (x.id === id ? { ...x, error: r?.error || 'Could not send that', retry: () => { dismissPending(id); track({ label, stages, run, onDone, retryKey }) } } : x)))
      return null
    }
    setPending(list => list.filter(x => x.id !== id))
    onDone?.(r)
    return r
  }
  const dismissPending = (id) => setPending(list => list.filter(x => x.id !== id))
  const busyWith = (key) => pending.some(x => x.retryKey === key && !x.error)

  const send = async (file = null) => {
    if (!thread) return
    const body = draft.trim()
    if (!file && !body) return
    const form = new FormData()
    if (body) form.append('body', body)
    if (file) form.append('file', file)
    // The box is cleared at once: what was typed now lives in the pending bubble.
    setDraft('')
    await track({
      label: file ? `📎 ${file.name}${body ? ` — ${body}` : ''}` : body,
      stages: file ? [[0, 'Uploading the file…'], [2500, 'Sending to WhatsApp…']] : [[0, 'Sending…']],
      run: () => apiFetch(`${API}/conversations/${thread.id}/messages`, { method: 'POST', body: form }),
      onDone: (r) => appendSent(r.message),
    })
  }

  const onKeyDown = (e) => {
    if (pop === 'snippets' && draft.startsWith('/')) {
      if (e.key === 'Escape') { setPop(null); return }
      if (e.key === 'Enter') {
        e.preventDefault()
        const first = matchingReplies[0]
        if (first) pickReply(first, true)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  // "/" at the start of the reply box opens the saved replies, filtered by what follows it.
  const onDraftChange = (value) => {
    setDraft(value)
    if (value.startsWith('/')) { setSnippetQuery(value.slice(1)); setPop('snippets') }
    else if (pop === 'snippets' && draft.startsWith('/')) setPop(null)
  }

  const matchingReplies = quickReplies.filter(q => {
    const t = snippetQuery.trim().toLowerCase()
    return !t || q.title.toLowerCase().includes(t) || q.body.toLowerCase().includes(t)
  })

  const pickReply = (q, replaceSlash = false) => {
    setDraft(d => (replaceSlash || d.startsWith('/') ? q.body : (d ? d + '\n' : '') + q.body))
    setPop(null)
    setSnippetQuery('')
  }

  const saveReply = async () => {
    const title = newReply.title.trim()
    const body = newReply.body.trim()
    if (!title || !body) return toast.error('Give the reply a name and some words')
    const r = await apiFetch(`${API}/quick-replies`, { method: 'POST', body: JSON.stringify({ title, body }) })
    if (!r || r.error) return toast.error(r?.error || 'Could not save that reply')
    setQuickReplies(list => [...list, r.quickReply])
    setNewReply(null)
    toast.success(`Saved “${title}” — type / in the reply box to use it`)
  }

  const removeReply = async (q) => {
    if (!await toast.confirm({ title: `Remove “${q.title}”?`, message: 'Everyone on the team loses it.', danger: true })) return
    const r = await apiFetch(`${API}/quick-replies/${q.id}`, { method: 'DELETE' })
    if (!r || r.error) return toast.error(r?.error || 'Could not remove that reply')
    setQuickReplies(list => list.filter(x => x.id !== q.id))
  }

  const canChangeReply = (q) => config?.canManage || String(q.created_by || '').toLowerCase() === String(user?.username || '').toLowerCase()

  const sendCataloguePdf = async () => {
    setPop(null)
    if (busyWith('catalogue')) return
    await track({
      label: `📄 ${cataloguePdf?.filename || 'Catalogue PDF'}`, retryKey: 'catalogue',
      stages: [[0, 'Uploading the catalogue to WhatsApp…'], [6000, 'Still uploading — it is a large file…']],
      run: () => apiFetch(`${API}/conversations/${thread.id}/catalogue-pdf`, { method: 'POST' }),
      onDone: (r) => { appendSent(r.message); loadActivity() },
    })
  }

  const sendProduct = async (p) => {
    setPop(null)
    await track({
      label: `👕 ${p.name}`, retryKey: `product:${p.id}`,
      stages: p.image_url ? [[0, 'Uploading the photo…'], [2500, 'Sending to WhatsApp…']] : [[0, 'Sending…']],
      run: () => apiFetch(`${API}/conversations/${thread.id}/product`, { method: 'POST', body: JSON.stringify({ product_id: p.id }) }),
      onDone: (r) => appendSent(r.message),
    })
  }

  // What each order message is doing while it sends, in the order it does it.
  const ORDER_STAGES = {
    summary: [[0, 'Making the advance payment link…'], [2500, 'Sending the summary…']],
    advance_link: [[0, 'Making the Razorpay link…'], [2500, 'Sending it…']],
    balance_link: [[0, 'Making the Razorpay link…'], [2500, 'Sending it…']],
    advance_received: [[0, 'Generating the proforma PDF…'], [2500, 'Uploading to WhatsApp…'], [6000, 'Sending the message…']],
    proforma: [[0, 'Generating the proforma PDF…'], [2500, 'Uploading to WhatsApp…']],
    invoice: [[0, 'Generating the tax invoice PDF…'], [2500, 'Uploading to WhatsApp…']],
    photos: [[0, 'Preparing the photos…'], [3000, 'Uploading them to WhatsApp…'], [9000, 'Still uploading — several photos…']],
    mockups: [[0, 'Preparing the mockups…'], [3000, 'Uploading them to WhatsApp…']],
    payment_qr: [[0, 'Uploading the QR…'], [2500, 'Sending it…']],
    dispatch: [[0, 'Sending the tracking details…']],
  }

  /** One order message — a payment link, an invoice, the tracking — straight into this chat. */
  const sendOrder = async (order, kind) => {
    setPop(null)
    const key = `${order.id}:${kind}`
    if (busyWith(key)) return
    const label = ORDER_SENDS.find(([k]) => k === kind)?.[1] || kind
    // Already sent: say when, and let the rep decide. A customer who lost the link needs it again.
    const sentAt = order.sent?.[kind]
    if (sentAt && !await toast.confirm({
      title: `${label} already sent for CF-${order.sl_no}`,
      message: `It went to ${thread.display_name} on ${day(sentAt)} at ${clock(sentAt)}. Send it again?`,
      confirmLabel: 'Send again', cancelLabel: 'Cancel',
    })) return
    await track({
      label: `CF-${order.sl_no} · ${label}`, retryKey: key, stages: ORDER_STAGES[kind],
      run: () => apiFetch(`${API}/conversations/${thread.id}/orders/${order.id}/send`, { method: 'POST', body: JSON.stringify({ kind }) }),
      onDone: (r) => { for (const m of r.messages || []) appendSent(m); loadOrders(); loadActivity() },
    })
  }

  const sendQr = async () => {
    setPop(null)
    if (busyWith('qr')) return
    await track({
      label: '🔳 Payment QR', retryKey: 'qr', stages: ORDER_STAGES.payment_qr,
      run: () => apiFetch(`${API}/conversations/${thread.id}/payment-qr`, { method: 'POST', body: '{}' }),
      onDone: (r) => { appendSent(r.message); loadActivity() },
    })
  }

  const askBilling = async () => {
    if (busyWith('billing')) return
    await track({
      label: '🧾 Billing details request', retryKey: 'billing', stages: [[0, 'Sending the request…']],
      run: () => apiFetch(`${API}/conversations/${thread.id}/billing`, { method: 'POST' }),
      onDone: (r) => { setThread(r.conversation); loadActivity(); poll.current() },
    })
  }

  /** The order form, filled in from what the chat already knows. Nothing is saved until Save. */
  const createOrder = () => {
    // Only a plain number is a quantity; "50-200" from the menu is a range, left for the rep to settle.
    const qty = /^\s*\d+\s*(pcs|pieces|nos)?\s*$/i.test(String(thread.quantity || '')) ? parseInt(thread.quantity, 10) : ''
    const local = ago10(thread.phone)
    setOrderTarget({
      customer_name: thread.lead_name || thread.profile_name || '',
      contact_number: local, whatsapp_number: local,
      billing_name: thread.billing_name || thread.lead_company || '',
      billing_address: thread.billing_address || '',
      delivery_location: thread.delivery_address || thread.billing_address || '',
      billing_mobile: ago10(thread.billing_mobile || ''),
      billing_email: thread.billing_email || '',
      gst_number: /^na$/i.test(thread.gst_number || '') ? '' : (thread.gst_number || ''),
      order_date: todayStr(), status: 'Awaiting Payment', payment_status: 'Pending', layout_status: 'Pending',
      customer_type: 'New', ship_region: 'Tamil Nadu', _gstPct: 5,
      notes: thread.lead_notes || '',
      // Whoever raises it is the sales officer, by the name the order list knows them by.
      so: soName(user?.username),
      contact_person: thread.contact_person || thread.lead_name || thread.profile_name || '',
      wa_lead_id: thread.lead_id,
      line_items: [{
        product: thread.product_interest || '', color: '', printing_placement: 'Front',
        printing_type: /embroid/i.test(thread.branding || '') ? 'Embroidery' : '',
        qty, unit_price: '', product_total: '', size_breakdown: '',
      }],
    })
  }

  const sendQuote = async (q) => {
    const key = `quote:${q.id}`
    if (busyWith(key)) return
    if (q.sent_at && !await toast.confirm({
      title: `Quote #${q.id} already sent`,
      message: `It went to ${thread.display_name} on ${day(q.sent_at)} at ${clock(q.sent_at)}. Send it again?`,
      confirmLabel: 'Send again', cancelLabel: 'Cancel',
    })) return
    await track({
      label: `📄 Quote #${q.id} · ${money(q.grand_total)}`, retryKey: key,
      stages: [[0, 'Generating the quotation PDF…'], [2500, 'Uploading to WhatsApp…']],
      run: () => apiFetch(`${API}/conversations/${thread.id}/quotes/${q.id}/send`, { method: 'POST' }),
      onDone: (r) => { appendSent(r.message); loadOrders(); loadActivity() },
    })
  }

  const previewQuote = async (q) => {
    const r = await apiFetch(`/api/crewfit/quotes/${q.id}/pdf`, { responseType: 'blob' })
    if (!r || r.error) return toast.error(r?.error || 'Could not open the quote')
    setPreview({ url: URL.createObjectURL(r.blob), name: `Quote #${q.id}`, mime: 'application/pdf' })
  }

  /** The order form from an accepted quote: its products and prices, plus the billing details. */
  const orderFromQuote = (q) => {
    createOrder()
    quoteToLink.current = q.id
    setOrderTarget(t => ({
      ...t,
      shipping: q.shipping_charge,
      notes: `${t.notes ? `${t.notes}\n` : ''}From quote #${q.id}`,
      line_items: (q.line_items || []).map(li => ({
        product: li.product_name, color: '',
        printing_placement: li.printing_placement || 'Front', printing_type: li.printing_type || '',
        qty: li.qty, unit_price: li.price_per_piece, product_total: li.line_total, size_breakdown: '',
      })),
    }))
  }

  const openOrder = async (order) => {
    const r = await apiFetch(`/api/crewfit/orders/${order.id}`)
    if (!r || r.error) return toast.error(r?.error || 'Could not open that order')
    setOrderTarget(r)
  }

  /** Mute this chat for me: no badge from it. Unmuting brings its unread count back. */
  const toggleMute = async () => {
    const muted = !thread.muted
    const r = await apiFetch(`${API}/conversations/${thread.id}/mute`, { method: 'PUT', body: JSON.stringify({ muted }) })
    if (!r || r.error) return toast.error(r?.error || 'Could not change that')
    setThread(t => (t && t.id === thread.id ? { ...t, muted } : t))
    setConversations(list => list.map(c => (c.id === thread.id ? { ...c, muted } : c)))
    loadConversations()
  }

  const startCall = async () => {
    if (thread?.is_demo) return toast.info('This is the demo chat — calls only go to real customers.')
    const asked = await calls.call(thread)
    if (asked?.id) appendSent(asked)
  }

  const assign = async (username) => {
    const r = await apiFetch(`${API}/conversations/${thread.id}`, {
      method: 'PATCH', body: JSON.stringify({ assigned_to: username || null }),
    })
    if (!r || r.error) return toast.error(r?.error || 'Could not reassign that conversation')
    setThread(r.conversation)
    loadConversations()
    loadActivity()
    toast.success(username ? `Handed to ${short(username)}` : 'Put back in the unassigned list')
  }

  const addNote = async () => {
    const body = noteDraft.trim()
    if (!body || !thread) return
    const r = await apiFetch(`${API}/conversations/${thread.id}/notes`, {
      method: 'POST', body: JSON.stringify({ body }),
    })
    if (!r || r.error) return toast.error(r?.error || 'Could not save that note')
    setNotes(list => [r.note, ...list])
    setNoteDraft('')
  }

  const pickTemplate = (t) => {
    setPop(null)
    setPicking(t)
    const opener = openers.find(o => o.name === t.name)
    if (opener) {
      // Their name, yours, and their latest order when the chat knows it.
      const me = short(user?.username)
      const order = cf && orders[0]?.sl_no ? `CF-${orders[0].sl_no}` : ''
      return setValues(opener.gaps.map(g => (g === 'name' ? fillFrom('first_name', thread, user?.username) : g === 'me' ? me.charAt(0).toUpperCase() + me.slice(1) : order)))
    }
    const map = Array.isArray(t.var_map) ? t.var_map : []
    setValues(Array.from({ length: t.variables }, (_, i) => fillFrom(map[i], thread, user?.username)))
  }

  const sendTemplate = async () => {
    const t = picking
    const vars = values
    setPicking(null)
    setValues([])
    await track({
      label: `📋 ${t.name}`, retryKey: `tpl:${t.name}`, stages: [[0, 'Sending the template…']],
      run: () => apiFetch(`${API}/conversations/${thread.id}/template`, {
        method: 'POST', body: JSON.stringify({ name: t.name, language: t.language, variables: vars }),
      }),
      onDone: (r) => appendSent(r.message),
    })
  }

  const toggleMenu = async (on) => {
    const r = await apiFetch(`${API}/flows/${menuFlow.key}`, { method: 'PUT', body: JSON.stringify({ is_active: on }) })
    if (!r || r.error) return toast.error(r?.error || 'Could not change that')
    setMenuFlow(r.flow)
    toast.success(on ? 'New chats start with the menu' : 'The menu is off — new chats come straight to the team')
  }

  const setMode = async (mode) => {
    const r = await apiFetch(`${API}/conversations/${thread.id}/mode`, {
      method: 'POST', body: JSON.stringify({ mode }),
    })
    if (!r || r.error) return toast.error(r?.error || 'Could not change who is answering')
    setThread(r.conversation)
    toast.success(mode === 'human' ? 'You have the conversation' : mode === 'ai' ? (cf ? 'The assistant is answering' : 'The bot is answering again') : 'The menu is asking')
  }

  const setStatus = async (status) => {
    const r = await apiFetch(`${API}/conversations/${thread.id}`, {
      method: 'PATCH', body: JSON.stringify({ status }),
    })
    if (!r || r.error) return toast.error(r?.error || 'Could not change that')
    setThread(r.conversation)
    loadConversations()
  }

  /* ── The lead ────────────────────────────────────────────────────────────────────────── */

  const saveLead = async (patch) => {
    if (!thread?.lead_id) return
    const body = Object.fromEntries(Object.entries(patch).map(([k, v]) => [LEAD_COLUMN[k] || k, v]))
    const r = await apiFetch(`${API}/leads/${thread.lead_id}`, { method: 'PATCH', body: JSON.stringify(body) })
    if (!r || r.error) return toast.error(r?.error || 'Could not save that')
    if (r.conversation) {
      setThread(r.conversation)
      if (r.conversation.assigned_to !== thread.assigned_to && r.conversation.assigned_to) {
        toast.success(`Moved to ${short(r.conversation.assigned_to)} by the assignment rules`)
      }
    }
    loadConversations()
    if ('status' in patch) loadActivity()
  }

  // Saved as each field is left, and only if it changed: no save button to forget.
  const saveField = (key) => {
    const was = leadFormFrom(thread)[key]
    if (String(lead[key] ?? '') === String(was ?? '')) return
    saveLead({ [key]: lead[key] })
  }

  const billingFilled = BILLING.some(([k]) => thread?.[k])
  const saveBilling = (key) => {
    if (String(billingForm[key] ?? '') === String(thread?.[key] ?? '')) return
    setThread(t => ({ ...t, [key]: billingForm[key] }))
    saveLead({ [key]: billingForm[key] })
  }

  const setLeadStatus = (key) => {
    setThread(t => ({ ...t, lead_status: key }))
    saveLead({ status: key })
  }

  /* ── The page ────────────────────────────────────────────────────────────────────────── */


  // The customer's files and the team's notes: in Crewfit's Lead tab and Normless's Customer tab.
  const filesAndNotes = (
    <>
      {!!customerFiles.length && (
        <>
          <div className="form-section wa-billing-head">
            <span>Files from the customer</span>
            {customerFiles.length > 1 && <button type="button" className="mini-btn" onClick={downloadAll}>Download all</button>}
          </div>
          <ul className="wa-files">
            {customerFiles.map(m => (
              <li key={m.id}>
                {/^image\//.test(m.media_mime || '')
                  ? <img src={fileUrl(m.media_url)} alt="" loading="lazy" />
                  : <span className="wa-doc-icon">{extFor(m.media_mime, m.media_url).toUpperCase().slice(0, 4)}</span>}
                <span className="wa-files-name">{m.media_name || (/^image/.test(m.media_mime || '') ? 'Photo' : 'File')}<small>{day(m.sent_at)} {clock(m.sent_at)}</small></span>
                <button type="button" className="btn-icon" aria-label="Download" title="Download"
                  onClick={() => downloadFile(fileUrl(m.media_url), fileNameFor(m, ago10(thread.phone)))}><Icon name="download" size={14} /></button>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* Never sent: these live in their own table, which the sending code cannot read. */}
      <div className="form-section">Notes for the team</div>
      <div className="wa-note-new">
        <textarea rows={2} aria-label="New note for the team" placeholder="Something the next person should know…"
          value={noteDraft} onChange={e => setNoteDraft(e.target.value)} />
        <button type="button" className="mini-btn" disabled={!noteDraft.trim()} onClick={addNote}>Add</button>
      </div>
      {!!notes.length && (
        <ul className="wa-notes">
          {notes.map(n => (
            <li key={n.id}>
              <div className="wa-note-body">{n.body}</div>
              <div className="wa-note-who">{short(n.author) || 'someone'} · {day(n.created_at)}</div>
            </li>
          ))}
        </ul>
      )}
    </>
  )

  const quoted = Number(thread?.quoted_amount || 0)
  const received = Number(thread?.received_amount || 0)
  const paidPct = quoted > 0 ? Math.min(100, Math.round((received / quoted) * 100)) : 0
  const look = statusLook(thread?.lead_status)

  return (
    <div className="page wa-page">
      <header className="wa-topbar">
        <button type="button" className="btn-icon wa-menu-btn" aria-label="Open the main menu" title="Main menu" onClick={openMenu}>
          <Icon name="dashboard" size={18} />
        </button>
        {cf ? <h1>WhatsApp</h1> : (
          <nav className="wa-crumb" aria-label="Breadcrumb">
            <span>{brand.name}</span><span aria-hidden="true">/</span><b>WhatsApp</b>
            {health?.number && <small>{health.number}</small>}
          </nav>
        )}
        {!cf && <span className="wa-nl-hours"><span className={`wa-dot${health?.ok ? ' on' : ''}`} aria-hidden="true" />Team replies 9 am – 6 pm</span>}
        {cf && <div className="wa-counts">
          <span className="wa-count"><b>{tally.open}</b> open</span>
          <button type="button" className="wa-count" style={{ cursor: 'pointer' }} onClick={() => setFilter('unassigned')}>
            <b>{tally.unassigned}</b> waiting
          </button>
          <span className="wa-count"><b>{tally.unread}</b> unread</span>
        </div>}
        <div className="wa-topbar-end">
          {config?.canSettings && menuFlow && (
            <label className="wa-menu-switch" title="Whether a new chat is answered by the menu first. Outside working hours it always is, if that is set in Settings › Working hours.">
              <button type="button" role="switch" aria-checked={!!menuFlow.is_active} className={`toggle${menuFlow.is_active ? ' on' : ''}`}
                onClick={() => toggleMenu(!menuFlow.is_active)}><span /></button>
              <span>{menuFlow.is_active ? 'Menu answers new chats' : 'Menu off — new chats come to you'}</span>
            </label>
          )}
          {config?.canDashboard
            ? <Link to={`${brand.path}/dashboard`} className="btn btn-secondary btn-sm"><Icon name="trending" size={14} /> Dashboard</Link>
            : cf && <Link to={`${brand.path}/me`} className="btn btn-secondary btn-sm"><Icon name="trending" size={14} /> My performance</Link>}
          {config?.canSettings && (
            <Link to={`${brand.path}/settings`} className="btn btn-secondary btn-sm">
              <Icon name="settings" size={14} /> Settings
            </Link>
          )}
        </div>
      </header>

      {/* Not connected yet: the inbox still opens — chats can be read and settings reached —
          and the banner says where to connect, instead of the page being replaced by a notice. */}
      {health && !health.ok && (
        <div className="wa-health" role="alert">
          <Icon name="alert" size={16} />
          <div>
            <b>{health.reason === 'not_configured' ? `${brand.name}'s WhatsApp number isn't connected yet`
              : health.reason === 'token_expired' ? 'WhatsApp is disconnected' : 'WhatsApp is not answering'}</b>
            <span>{health.reason === 'not_configured'
              ? (config?.canConnect ? 'Connect it from Settings › Connect WhatsApp once Meta has approved the app. Until then nothing can be sent or received.'
                : 'An admin connects it from WhatsApp settings. Until then nothing can be sent or received.')
              : health.message}</span>
          </div>
          {health.reason === 'not_configured' && config?.canConnect && (
            <Link to={`${brand.path}/settings/connect`} className="mini-btn">Connect</Link>
          )}
          <button type="button" className="mini-btn" onClick={async () => setHealth(await apiFetch(`${API}/health?fresh=1`))}>Check again</button>
        </div>
      )}

      {picking && (
        <div className="modal-backdrop" onClick={() => setPicking(null)}>
          <div className="studio-open wa-template-fill" onClick={e => e.stopPropagation()}>
            <div className="studio-result-head">
              <h3>{picking.name}</h3>
              <button type="button" className="btn-icon" aria-label="Close" onClick={() => setPicking(null)}>
                <Icon name="close" size={15} />
              </button>
            </div>
            <p className="wa-flow-hint">
              Meta approved this wording; only the gaps can change. The customer will read it exactly
              as it appears below.
            </p>
            <div className="wa-template-preview">
              {values.reduce((text, v, i) => text.replaceAll(`{{${i + 1}}}`, v || `{{${i + 1}}}`), picking.body_text || '')}
            </div>
            {Array.from({ length: picking.variables }).map((_, i) => (
              <div className="input-group" key={i} style={{ marginBottom: 0 }}>
                <label htmlFor={`wa-var-${i}`}>Value {i + 1}</label>
                <input id={`wa-var-${i}`} value={values[i] || ''} placeholder={`What goes in {{${i + 1}}}`}
                  onChange={e => setValues(v => { const next = [...v]; next[i] = e.target.value; return next })} />
              </div>
            ))}
            <div className="studio-actions">
              <button type="button" className="btn btn-primary"
                disabled={values.filter(v => String(v).trim()).length < picking.variables}
                onClick={sendTemplate}>Send it</button>
              <button type="button" className="btn btn-secondary" onClick={() => setPicking(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {preview && (
        <div className="modal-backdrop" onClick={() => setPreview(null)}>
          <div className="studio-open wa-preview" onClick={e => e.stopPropagation()}>
            <div className="studio-result-head">
              <h3>{preview.name}</h3>
              <span style={{ display: 'flex', gap: 8 }}>
                <a className="btn btn-secondary btn-sm" href={preview.url} target="_blank" rel="noreferrer">Open in a new tab</a>
                <button type="button" className="btn-icon" aria-label="Close" onClick={() => setPreview(null)}><Icon name="close" size={15} /></button>
              </span>
            </div>
            <PdfViewer url={preview.url} />
          </div>
        </div>
      )}

      {newChat && (
        <WaNewChat API={API} brandName={brand.name} onClose={() => setNewChat(false)}
          onOpened={(id) => { setNewChat(false); loadConversations(); openConversation(id) }} />
      )}

      <div className={`wa-layout${thread ? '' : ' wa-layout-empty'}`}>
        {/* The threads */}
        <aside className="wa-list" aria-label="Conversations">
          <div className="wa-list-top">
          <div className="search-bar wa-search">
            <span className="search-icon" />
            <input aria-label="Search conversations" placeholder="Name, company or number…" value={search}
              onChange={e => setSearch(e.target.value)} />
            {!!search && <button type="button" className="search-clear" aria-label="Clear search" onClick={() => setSearch('')}>×</button>}
          </div>
          <button type="button" className="btn btn-primary btn-sm wa-new-chat" onClick={() => setNewChat(true)} title="Message a customer first">
            <Icon name="plus" size={14} /> New chat
          </button>
          </div>
          <div className="wa-filters" role="group" aria-label={cf ? 'Whose' : 'Queue'}>
            {(cf ? FILTERS : NL_FILTERS).map(f => (
              <button key={f.key} type="button" aria-pressed={filter === f.key}
                className={`chip${filter === f.key ? ' chip-on' : ''}`}
                onClick={() => setFilter(f.key)}>{f.label}
                {!cf && f.key !== 'all' && <span className={`wa-q-count${f.hot && tally[f.key] ? ' hot' : ''}`}>{tally[f.key] ?? 0}</span>}
                {/* Crewfit: chats waiting for somebody, and unread customer messages behind each chip. */}
                {cf && f.key === 'waiting' && <span className={`wa-q-count${tally.waiting ? ' hot' : ''}`} title="Chats waiting for somebody to pick up">{tally.waiting ?? 0}</span>}
                {cf && f.badge && tally[f.badge] > 0 && <span className="wa-q-count wa-q-unread" title="Unread messages from customers">{tally[f.badge]}</span>}
              </button>
            ))}
          </div>
          {!!statuses.length && (
            <label className="wa-status-filter">
              <span className="wa-dot" style={{ background: statuses.find(x => x.key === statusFilter)?.color || 'var(--text-muted)' }} aria-hidden="true" />
              <span className="sr-only">Lead status</span>
              <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} aria-label="Lead status">
                <option value="">Any status ({Object.values(statusCounts).reduce((n, v) => n + v, 0)})</option>
                {statuses.map(st => <option key={st.key} value={st.key}>{st.name} ({statusCounts[st.key] || 0})</option>)}
              </select>
            </label>
          )}

          {loading ? (
            <div className="loader"><div className="spinner" /></div>
          ) : !conversations.length ? (
            <p className="wa-empty">
              {statusFilter || term || filter !== 'all'
                ? 'No conversations match these filters.'
                : 'Nothing here yet. A customer messaging the business number starts a thread.'}
            </p>
          ) : (
            <ul className="wa-threads" onScroll={onListScroll}>
              {conversations.map(c => {
                const s = statusLook(c.lead_status)
                return (
                  <li key={c.id}>
                    <button type="button"
                      className={`wa-thread${c.id === openId ? ' wa-thread-on' : ''}`}
                      onClick={() => openConversation(c.id)}>
                      <Avatar who={c} />
                      <span className="wa-thread-main">
                        <span className="wa-thread-top">
                          <b>{c.display_name}</b>
                          <span className="wa-thread-when">{ago(c.last_message_at)}</span>
                        </span>
                        {c.display_name !== c.phone_pretty && <span className="wa-thread-num">{c.phone_pretty}</span>}
                        <span className="wa-thread-line">{c.last_message_preview || 'No messages yet'}</span>
                        <span className="wa-thread-foot">
                          {cf && <span className="wa-pill" style={pillStyle(s.color)}>{s.name}</span>}
                          {cf && c.unreplied > 0 && <span className="wa-pill" style={pillStyle('#f87171')}>Needs a person</span>}
                          {!cf && (c.status === 'closed'
                            ? <span className="wa-pill" style={pillStyle('#a8b0be')}>Closed</span>
                            : c.mode === 'flow' || c.mode === 'ai'
                              ? <span className="wa-pill" style={pillStyle('#b3a9ff')}>Bot</span>
                              : c.last_direction === 'in'
                                ? <span className="wa-pill" style={pillStyle('#f87171')}>Needs a person</span>
                                : <span className="wa-pill" style={pillStyle('#34d399')}>Answered</span>)}
                          {!cf && c.open_ticket_ref && <span className="wa-pill" style={pillStyle('#60a5fa')}>{refOf({ ref_no: c.open_ticket_ref })}</span>}
                          <span className="wa-thread-owner">{c.assigned_to ? short(c.assigned_to) : 'Unassigned'}</span>
                          {c.muted && <span className="wa-thread-muted" title="Muted for you"><Icon name="bellOff" size={12} /></span>}
                          {!!c.unread_count && <span className={`wa-unread${c.muted ? ' wa-unread-muted' : ''}`}>{c.unread_count}</span>}
                          {/* A backed-up chat's customer is still waiting: their messages since our last reply, until somebody answers. */}
                          {!c.unread_count && c.unreplied > 0 && <span className="wa-unread wa-unread-waiting" title="Messages waiting for a reply">{c.unreplied}</span>}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
              {nextPage && (
                <li className="wa-threads-more">
                  <button type="button" className="mini-btn" disabled={loadingMore} onClick={loadMore}>
                    {loadingMore ? 'Loading…' : 'Load older chats'}
                  </button>
                </li>
              )}
            </ul>
          )}
        </aside>

        {/* The conversation */}
        <section className="wa-chat" aria-label="Conversation">
          {!thread ? (
            <div className="wa-chat-empty">
              <Icon name="mail" size={22} />
              <p>Pick a conversation to read it.</p>
            </div>
          ) : (
            <>
              <header className="wa-chat-head">
                <Avatar who={thread} large />
                <div className="wa-chat-who">
                  <span className="wa-chat-name">
                    <b>{thread.display_name}</b>
                    {cf && <span className="wa-pill" style={pillStyle(look.color)} title="Lead status">{look.name}</span>}
                    {thread.is_demo && <span className="wa-pill wa-demo-chip" title="A made-up customer for trying the inbox. Nothing is sent from it.">Demo</span>}
                    {!cf && thread.status !== 'closed' && thread.last_direction === 'in' && <span className="wa-pill" style={pillStyle('#f87171')}>Needs a person</span>}
                    {!cf && thread.open_ticket_ref && <span className="wa-pill" style={pillStyle('#60a5fa')}>{refOf({ ref_no: thread.open_ticket_ref })} open</span>}
                  </span>
                  <span className="wa-chat-phone">
                    {thread.phone_pretty}{thread.lead_company ? ` · ${thread.lead_company}` : ''}
                    {!cf && shop?.customer?.created_at && ` · customer since ${new Date(shop.customer.created_at).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}`}
                    {!cf && thread.last_inbound_at && ` · wrote ${clock(thread.last_inbound_at)}`}
                  </span>
                  <span className="wa-chat-since" title={new Date(thread.created_at).toLocaleString('en-IN')}>
                    {cf ? 'Lead since' : 'First message'} {day(thread.created_at)}, {clock(thread.created_at)}{thread.ad_referral ? ' · from an ad' : ''}
                  </span>
                </div>
                {/* The order this chat is about, at a glance: which one, and where it stands. */}
                {!!orders.length && (
                  <button type="button" className="wa-head-order" onClick={() => openOrder(orders[0])}
                    title={orders.length > 1 ? `${orders.length} orders on this number — showing the latest` : 'Open the order'}>
                    <span className="wa-head-order-ref">CF-{orders[0].sl_no}</span>
                    <span className="wa-pill" title="Order status" style={pillStyle(orders[0].status === 'Dispatched' ? '#34d399' : orders[0].status === 'Cancelled' ? '#f87171' : '#60a5fa')}>{orders[0].status}</span>
                    {/* Money as what is owed, not the bare payment status — two "Pending" pills
                        side by side said nothing. */}
                    <span className="wa-pill" title={`Payment: ${orders[0].payment_status}`} style={pillStyle(PAY_LOOK[orders[0].payment_status]?.[1] || '#c3c9d4')}>
                      {PAY_LOOK[orders[0].payment_status]?.[0] || orders[0].payment_status}
                    </span>
                    {orders.length > 1 && <span className="wa-head-order-more">+{orders.length - 1}</span>}
                  </button>
                )}
                <div className="wa-chat-actions">
                  <button type="button" className="wa-head-icon" onClick={startCall}
                    disabled={calls.busy || !!calls.active}
                    title={calls.active ? 'You are on a call' : calls.settings && !calls.settings.enabled
                      ? 'Call on WhatsApp (calling is not switched on for this number yet)' : 'Call on WhatsApp'}
                    aria-label="Call on WhatsApp">
                    <Icon name="phone" size={16} />
                  </button>
                  <button type="button" className={`wa-head-icon${thread.muted ? ' wa-head-icon-on' : ''}`} onClick={toggleMute}
                    aria-pressed={!!thread.muted}
                    title={thread.muted ? 'Muted for you — unread messages here do not count. Click to unmute.' : 'Mute this chat for you'}
                    aria-label={thread.muted ? 'Unmute chat' : 'Mute chat'}>
                    <Icon name={thread.muted ? 'bellOff' : 'bell'} size={16} />
                  </button>
                  {thread.window_open ? (
                    thread.window_left_ms < 6 * 3600 * 1000 && (
                      <span className="wa-window-chip"><Icon name="clock" size={13} /> {windowLabel(thread.window_left_ms)}</span>
                    )
                  ) : (
                    <span className="wa-window-chip wa-window-shut"><Icon name="clock" size={13} /> Window closed</span>
                  )}
                  {config?.canManage ? (
                    <select aria-label="Assigned to" value={thread.assigned_to || ''} onChange={e => assign(e.target.value)}>
                      <option value="">Unassigned</option>
                      {agents.map(a => <option key={a.username} value={a.username}>{short(a.username)}</option>)}
                    </select>
                  ) : !thread.assigned_to ? (
                    <button type="button" className="mini-btn" onClick={() => assign(user?.username)}>Take it</button>
                  ) : (
                    <span className="wa-chat-owner">{short(thread.assigned_to)}</span>
                  )}
                  {/* Whoever is answering, and the one click it takes to change that. A rep
                      taking over has to be instant — a customer going round in circles with a
                      menu will not wait for it to finish its question. */}
                  {thread.mode === 'flow' || thread.mode === 'ai' || thread.mode === 'billing' ? (
                    <>
                      <span className="wa-mode wa-mode-bot">
                        {thread.mode === 'ai' ? (cf ? 'assistant is answering' : 'Bot is answering') : thread.mode === 'billing' ? 'collecting billing details' : 'menu is answering'}
                      </span>
                      <button type="button" className="mini-btn" onClick={() => setMode('human')}>Take over</button>
                    </>
                  ) : cf && (
                    <>
                      <button type="button" className="mini-btn" title="Let the menu ask the opening questions"
                        onClick={() => setMode('flow')}>Start the menu</button>
                      {settings?.aiEnabled && (
                        <button type="button" className="mini-btn" title="Let the assistant answer"
                          onClick={() => setMode('ai')}>Hand to assistant</button>
                      )}
                    </>
                  )}
                  {!cf && thread.mode !== 'ai' && thread.assigned_to?.toLowerCase() !== user?.username?.toLowerCase() && (
                    <button type="button" className="btn btn-primary btn-sm" title="Gives you the chat and tells the customer who is helping"
                      onClick={() => assign(user?.username)}>Take over</button>
                  )}
                  {!cf && thread.mode !== 'ai' && thread.status !== 'closed' && (
                    <button type="button" className="mini-btn" title="The bot answers this chat again" onClick={() => setMode('ai')}>Hand back to bot</button>
                  )}
                  {!cf && (
                    <button type="button" className="btn btn-secondary btn-sm" disabled={!canTicket}
                      title={canTicket ? 'Opens a Support ticket filled in from this chat' : 'Needs edit access to Support'}
                      onClick={() => raiseTicket(nlOrder)}>Raise support ticket</button>
                  )}
                  {!cf && thread.status !== 'closed' && (
                    <button type="button" className="mini-btn" title="Close the chat once the customer is sorted" onClick={() => setStatus('closed')}>Close chat</button>
                  )}
                  {/* No "Done": a chat that is closed by hand drops off the list and out of
                      follow-up. Chats stay open; the lead's status says where they stand. */}
                  {thread.status === 'closed' && (
                    <button type="button" className="mini-btn" onClick={() => setStatus('open')}>Reopen</button>
                  )}
                </div>
              </header>

              <div className="wa-feed" ref={feedRef} onScroll={onFeedScroll}>
                {thread.ad_referral && (
                  <div className="wa-sys">Came in from an ad{thread.ad_referral.headline ? `: ${thread.ad_referral.headline}` : ''}</div>
                )}
                {messages.map((m, i) => {
                  const mine = m.direction === 'out'
                  const prev = messages[i - 1]
                  const newDay = !prev || day(prev.sent_at) !== day(m.sent_at)
                  return (
                    <div key={m.id}>
                      {newDay && <div className="wa-day">{day(m.sent_at)}</div>}
                      <div className={`wa-msg${mine ? ' wa-msg-out' : ''}`}>
                      <div className={`wa-bubble${mine ? ' wa-bubble-out' : ''}${m.type === 'call' ? ` wa-bubble-call${/Missed|declined|Declined|no answer|failed/.test(m.body || '') ? ' wa-bubble-call-missed' : ''}` : ''}${(m.sender_type === 'bot' || m.sender_type === 'ai') ? ' wa-bubble-bot' : ''}${m.sender_type === 'auto' ? ' wa-bubble-auto' : ''}${m.status === 'failed' ? ' wa-bubble-bad' : ''}`}>
                        {m.media_url && /^image\//.test(m.media_mime || '') && (
                          <div className="wa-media-wrap">
                            <a href={fileUrl(m.media_url)} target="_blank" rel="noreferrer">
                              <img className="wa-media" src={fileUrl(m.media_url)} alt={m.media_name || 'Photo'} loading="lazy" />
                            </a>
                            <button type="button" className="wa-media-dl" aria-label="Download this photo" title="Download"
                              onClick={() => downloadFile(fileUrl(m.media_url), fileNameFor(m, ago10(thread.phone)))}>
                              <Icon name="download" size={14} />
                            </button>
                          </div>
                        )}
                        {m.type === 'call' && m.media_url && (
                          <audio className="wa-call-rec" controls preload="none" src={fileUrl(m.media_url)} aria-label="Call recording" />
                        )}
                        {/* A photo or file an imported chat refers to but its export didn't include. */}
                        {!m.media_url && m.media_name && ['image', 'video', 'audio', 'document'].includes(m.type) && /not included/i.test(m.media_name) && (
                          <div className="wa-missing-media"><Icon name={m.type === 'image' ? 'eye' : 'note'} size={14} /> {m.media_name}</div>
                        )}
                        {m.type !== 'call' && (m.media_url || (m.media_name && !/not included/i.test(m.media_name))) && !/^image\//.test(m.media_mime || '') && (
                          <DocCard name={m.media_name} mime={m.media_mime} url={m.media_url ? fileUrl(m.media_url) : null}
                            onOpen={() => m.media_url && setPreview({ url: fileUrl(m.media_url), name: m.media_name, mime: m.media_mime })} />
                        )}
                        {m.body && <WaText text={m.body} />}
                        {mine && m.interactive_payload?.kind === 'template' && m.interactive_payload.footer && (
                          <div className="wa-tfooter">{m.interactive_payload.footer}</div>
                        )}
                        {m.type === 'call' && !mine && /Missed/.test(m.body || '') && !calls.active && (
                          <button type="button" className="mini-btn wa-call-back" onClick={startCall}><Icon name="phone" size={12} /> Call back</button>
                        )}
                        <div className="wa-meta">
                          {m.type === 'template' && <span>template</span>}
                          {mine && (m.sender_type === 'phone' ? <span>from the phone app</span> : m.sender_type === 'auto' ? <span>sent automatically</span> : m.sender_type === 'bot' ? <span>{cf ? 'menu' : 'bot'}</span>
                            : m.sender_type === 'ai' ? <span>assistant</span>
                              : m.sender_user ? <span>{short(m.sender_user)}</span> : null)}
                          <span>{clock(m.sent_at)}</span>
                          {mine && <Ticks status={m.status} />}
                        </div>
                        {m.error && <div className="wa-error">{m.error}</div>}
                      </div>
                      {/* The buttons under it, as the customer's phone shows them. */}
                      {mine && <BubbleButtons payload={m.interactive_payload} />}
                      </div>
                    </div>
                  )
                })}
                {pending.map(p => (
                  <div key={p.id} className={`wa-bubble wa-bubble-out wa-bubble-pending${p.error ? ' wa-bubble-bad' : ''}`} aria-live="polite">
                    <div className="wa-text">{p.label}</div>
                    {p.error ? (
                      <div className="wa-pending-error">
                        <span>{p.error}</span>
                        <span className="wa-pending-actions">
                          <button type="button" className="mini-btn" onClick={p.retry}>Retry</button>
                          <button type="button" className="mini-btn" onClick={() => dismissPending(p.id)}>Dismiss</button>
                        </span>
                      </div>
                    ) : (
                      <div className="wa-pending-stage"><span className="wa-spin" aria-hidden="true" />{p.stage}</div>
                    )}
                  </div>
                ))}
              </div>

              {/* Replying is for the person the chat is with: nobody types into a chat that is
                  waiting for someone, or into someone else's, without taking it first. */}
              {!thread.is_demo && String(thread.assigned_to || '').toLowerCase() !== String(user?.username || '').toLowerCase() ? (
                <footer className="wa-compose wa-compose-locked">
                  <div className="wa-locked">
                    <Icon name="lock" size={15} />
                    <span>{thread.assigned_to
                      ? <><b>{short(thread.assigned_to)}</b> is handling this chat.</>
                      : <><b>Nobody has this chat yet.</b> Assign it to yourself to reply{cf ? '' : ' — the customer is told who is helping'}.</>}</span>
                    {(!thread.assigned_to || config?.canManage) && (
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => assign(user?.username)}>
                        {thread.assigned_to ? 'Take over' : 'Assign to me'}
                      </button>
                    )}
                  </div>
                </footer>
              ) : (
              <footer className={`wa-compose${thread.window_open ? '' : ' wa-compose-shut'}`}>
                <div className="wa-tools">
                  <div className="wa-pop-anchor">
                    <button type="button" className={`wa-tool${pop === 'templates' ? ' wa-tool-on' : ''}`}
                      onClick={() => setPop(p => (p === 'templates' ? null : 'templates'))}>
                      <Icon name="note" size={14} /> Template
                    </button>
                    {pop === 'templates' && (
                      <div className="wa-pop">
                        {!templates.length && (
                          <p className="wa-snippet-none">
                            No approved templates yet.{config?.canSettings && (cf
                              ? <> Sync them in <Link to={`${brand.path}/settings/templates`}>Settings</Link>.</>
                              : <> <button type="button" className="mini-btn" onClick={syncTemplates}>Sync from Meta</button></>)}
                          </p>
                        )}
                        {(() => {
                          // Reopen-the-chat templates first (and highlighted when the window has
                          // closed), with everything else folded away below them.
                          const reopen = openers.filter(o => o.status === 'APPROVED')
                            .map(o => ({ o, t: templates.find(t => t.name === o.name && t.language === o.language) || templates.find(t => t.name === o.name) }))
                            .filter(x => x.t)
                          // Only ours: Updatrr's (names ending in a 13-digit stamp) and Meta's samples are left out.
                          const ours = (t) => /^(nl_|nlcrm_|normless_|crewfit_)/.test(t.name) && !/\d{13}$/.test(t.name)
                          const rest = templates.filter(t => ours(t) && !reopen.some(x => x.t.id === t.id))
                          const restList = rest.map(t => (
                            <button key={t.id} type="button" className="wa-snippet-use" onClick={() => pickTemplate(t)}>
                              <b>{t.name}</b>
                              <span>{t.body_text}</span>
                            </button>
                          ))
                          return (
                            <>
                              {!!reopen.length && (
                                <div className={`wa-reopen${thread.window_open ? '' : ' wa-reopen-hot'}`}>
                                  <div className="wa-reopen-head">
                                    <b>{thread.window_open ? 'Reopen templates' : 'Reopen the chat'}</b>
                                    <span>{thread.window_open ? 'for when they’ve been quiet over a day' : 'they haven’t written in 24 hours — start with one of these'}</span>
                                  </div>
                                  {reopen.map(({ o, t }) => (
                                    <button key={t.id} type="button" className="wa-snippet-use" onClick={() => pickTemplate(t)}>
                                      <b>{o.label}</b>
                                      <span>{t.body_text}</span>
                                    </button>
                                  ))}
                                </div>
                              )}
                              {reopen.length && rest.length
                                ? <details className="wa-reopen-more"><summary>All templates ({rest.length})</summary>{restList}</details>
                                : restList}
                            </>
                          )
                        })()}
                      </div>
                    )}
                  </div>
                  {cf && thread.window_open && (
                    <div className="wa-pop-anchor">
                      <button type="button" className={`wa-tool${pop === 'pay' ? ' wa-tool-on' : ''}`}
                        onClick={() => setPop(p => (p === 'pay' ? null : 'pay'))}>
                        <Icon name="card" size={14} /> Payment
                      </button>
                      {pop === 'pay' && (
                        <div className="wa-pop wa-pop-wide">
                          {!orders.length && (
                            <button type="button" className="wa-snippet-use" onClick={sendQr}>
                              <b>Payment QR code</b>
                              <span>Sends the shop’s QR and asks for the payment screenshot</span>
                            </button>
                          )}
                          {canEditOrders && orders.filter(o => o.payment_status !== 'Fully Paid').map(o => (
                            <button key={`${o.id}qr`} type="button" className="wa-snippet-use" onClick={() => sendOrder(o, 'payment_qr')}>
                              <b>CF-{o.sl_no} · Payment QR</b>
                              <span>QR for the {o.payment_status === 'Pending' ? `advance ${money(o.advance)}` : `balance ${money(o.balance)}`}, asking for the screenshot</span>
                            </button>
                          ))}
                          {!canEditOrders && !!orders.length && <p className="wa-snippet-none">Payment links need edit access to bulk orders.</p>}
                          {canEditOrders && orders.flatMap(o => ['advance_link', 'balance_link'].map(k => {
                            const paid = (o.payments || []).some(p => p.kind === (k === 'advance_link' ? 'advance' : 'balance') && p.status === 'Paid')
                            return (
                              <button key={`${o.id}${k}`} type="button" className="wa-snippet-use" disabled={paid} onClick={() => sendOrder(o, k)}>
                                <b>CF-{o.sl_no} · {k === 'advance_link' ? 'Advance' : 'Balance'} {money(k === 'advance_link' ? o.advance : o.balance)}</b>
                                <span>{paid ? 'Already paid' : 'Makes the Razorpay link if there is none, and sends it'}</span>
                              </button>
                            )
                          }))}
                        </div>
                      )}
                    </div>
                  )}
                  {thread.window_open && (
                    <>
                      {cf && <div className="wa-pop-anchor">
                        <button type="button" className={`wa-tool${pop === 'catalogue' ? ' wa-tool-on' : ''}`}
                          onClick={() => setPop(p => (p === 'catalogue' ? null : 'catalogue'))}>
                          <Icon name="box" size={14} /> Catalogue
                        </button>
                        {pop === 'catalogue' && (
                          <div className="wa-pop wa-pop-wide">
                            <button type="button" className="wa-pop-pdf" disabled={!cataloguePdf} onClick={sendCataloguePdf}>
                              <span className="wa-pop-pdf-icon" aria-hidden="true">PDF</span>
                              <span>
                                <b>Send the full catalogue</b>
                                <span>{cataloguePdf ? `${cataloguePdf.filename} · version ${cataloguePdf.version}` : 'No catalogue PDF uploaded yet — add one on the Catalog page'}</span>
                              </span>
                            </button>
                            <div className="wa-pop-label">Or one product, with its photo and prices</div>
                            {!products.length && <p className="wa-snippet-none">Nothing in the WhatsApp catalogue.</p>}
                            {products.map(p => (
                              <button key={p.id} type="button" className="wa-product-pick" onClick={() => sendProduct(p)}>
                                {p.image_url
                                  ? <img src={fileUrl(p.image_url)} alt="" loading="lazy" />
                                  : <span className="wa-product-noimg" aria-hidden="true"><Icon name="shirt" size={16} /></span>}
                                <span>
                                  <b>{p.name}</b>
                                  <span>{[p.category, p.from_price ? `from ₹${Number(p.from_price)}` : null].filter(Boolean).join(' · ')}</span>
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>}
                      {!cf && nlOrder && (
                        <button type="button" className="wa-tool" title={`Puts ${nlOrder.order_number}'s status in the reply box`}
                          onClick={() => orderStatusText(nlOrder)}><Icon name="box" size={14} /> Order status</button>
                      )}
                      {/* The sentences that get typed twenty times a week, one click away. */}
                      <div className="wa-pop-anchor">
                        <button type="button" className={`wa-tool${pop === 'snippets' ? ' wa-tool-on' : ''}`}
                          onClick={() => setPop(p => (p === 'snippets' ? null : 'snippets'))}>
                          <Icon name="copy" size={14} /> Saved replies
                        </button>
                        {pop === 'snippets' && (
                          <div className="wa-pop wa-pop-wide">
                            {newReply ? (
                              <div className="wa-reply-new">
                                <b>New saved reply</b>
                                <input aria-label="Name" autoFocus placeholder="Name it — e.g. Bank details" value={newReply.title}
                                  onChange={e => setNewReply(n => ({ ...n, title: e.target.value }))} />
                                <textarea aria-label="Reply text" rows={4} placeholder="What it should say" value={newReply.body}
                                  onChange={e => setNewReply(n => ({ ...n, body: e.target.value }))} />
                                <div className="wa-reply-new-actions">
                                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setNewReply(null)}>Cancel</button>
                                  <button type="button" className="btn btn-primary btn-sm" disabled={!newReply.title.trim() || !newReply.body.trim()} onClick={saveReply}>Save reply</button>
                                </div>
                              </div>
                            ) : (
                              <>
                                {!draft.startsWith('/') && (
                                  <input className="wa-pop-search" aria-label="Search saved replies" placeholder="Search saved replies" autoFocus
                                    value={snippetQuery} onChange={e => setSnippetQuery(e.target.value)} />
                                )}
                                {!matchingReplies.length && (
                                  <p className="wa-snippet-none">{quickReplies.length ? 'No saved reply matches.' : 'Nothing saved yet. Save the sentences you type every day.'}</p>
                                )}
                                {matchingReplies.map((q, i) => (
                                  <div key={q.id} className={`wa-snippet-row${i === 0 && draft.startsWith('/') ? ' wa-snippet-first' : ''}`}>
                                    <button type="button" className="wa-snippet-use" onClick={() => pickReply(q)}>
                                      <b>{q.title}</b>
                                      <span>{q.body}</span>
                                    </button>
                                    {canChangeReply(q) && (
                                      <button type="button" className="btn-icon" aria-label={`Remove ${q.title}`} title="Remove" onClick={() => removeReply(q)}>
                                        <Icon name="trash" size={13} />
                                      </button>
                                    )}
                                  </div>
                                ))}
                                <div className="wa-pop-foot">
                                  <button type="button" className="mini-btn" onClick={() => setNewReply({ title: '', body: '' })}>+ New saved reply</button>
                                  {draft.trim() && !draft.startsWith('/') && (
                                    <button type="button" className="mini-btn" onClick={() => setNewReply({ title: '', body: draft.trim() })}>Save what I typed</button>
                                  )}
                                  <span className="wa-pop-hint">Tip: type / in the reply box</span>
                                </div>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>

                {thread.window_open ? (
                  <div className="wa-compose-row">
                    <button type="button" className="btn-icon" aria-label="Attach a file" title="Attach a file"
                      onClick={() => fileRef.current?.click()}>
                      <Icon name="plus" size={16} />
                    </button>
                    <input ref={fileRef} type="file" hidden
                      onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) send(f) }} />
                    <textarea rows={1} value={draft} aria-label="Reply" placeholder="Write a reply… or type / for saved replies"
                      onChange={e => onDraftChange(e.target.value)} onKeyDown={onKeyDown} />
                    <button type="button" className="btn btn-primary" disabled={!draft.trim() || draft.startsWith('/')}
                      onClick={() => send()}>Send</button>
                  </div>
                ) : (
                  <div className="wa-shut-text">
                    <b>This chat is past WhatsApp’s 24-hour window.</b>
                    <span> Only an approved template can be sent until the customer writes again.</span>
                  </div>
                )}
              </footer>
              )}
            </>
          )}
        </section>

        {/* Normless: the customer, their files and notes, and what has happened. Shopify orders
            and support tickets join this panel in the next phase. */}
        {thread && !cf && (
          <aside className="wa-side" aria-label="Customer">
            <div className="wa-side-head">
              <h2>{thread.display_name}</h2>
              <span>Since {day(thread.created_at)}</span>
            </div>
            <div className="wa-side-tabs" role="tablist">
              {[['customer', 'Customer'], ['tickets', `Tickets${shop?.tickets?.length ? ` (${shop.tickets.length})` : ''}`], ['activity', 'Activity']].map(([k, label]) => (
                <button key={k} type="button" role="tab" aria-selected={sideTab === k}
                  className={`wa-side-tab${sideTab === k ? ' wa-side-tab-on' : ''}`} onClick={() => setSideTab(k)}>{label}</button>
              ))}
            </div>
            {sideTab === 'customer' && (
              <>
                {!shop ? <div className="loader"><div className="spinner" /></div> : (() => {
                  const o = nlOrder
                  const days = o?.shipped_at ? Math.floor((Date.now() - new Date(o.shipped_at).getTime()) / 86400000) : null
                  const earlier = o ? shop.tickets.filter(t => o.tickets.includes(t.id)) : []
                  const others = shop.orders.filter(x => x !== o)
                  return (
                    <>
                      <section className="wa-nl-card">
                        <div className="wa-nl-card-head">
                          <b>{shop.customer?.name || thread.display_name}</b>
                          {shop.customer && <span className="wa-nl-muted">Shopify customer</span>}
                        </div>
                        {shop.customer ? (
                          <>
                            <div className="wa-nl-stats">
                              <div><span>Orders</span><b>{shop.customer.orders_count ?? 0}</b></div>
                              <div><span>Spent</span><b>{money(shop.customer.total_spent)}</b></div>
                              <div><span>Matched by</span><b className="wa-nl-small">Phone</b></div>
                            </div>
                            {shop.customer.email && <div className="wa-nl-muted">{shop.customer.email}</div>}
                          </>
                        ) : (
                          <div className="wa-nl-muted">No Shopify customer has {thread.phone_pretty} on file. Orders shipped to this number still show below.</div>
                        )}
                      </section>

                      {!o ? (
                        <section className="wa-nl-card"><div className="wa-nl-muted">No orders found for this number. Ask the customer for their order number.</div></section>
                      ) : (
                        <section className="wa-nl-card wa-nl-order">
                          <div className="wa-nl-card-head">
                            <b>Order {o.order_number}</b>
                            <span className="wa-pill" style={pillStyle(o.state === 'Shipped' ? '#34d399' : o.state === 'Cancelled' ? '#f87171' : '#60a5fa')}>{o.state}</span>
                          </div>
                          {o.items.map((it, k) => (
                            <div key={k} className="wa-nl-item">
                              <span className="wa-nl-thumb" aria-hidden="true"><Icon name="shirt" size={16} /></span>
                              <span><b>{it.title}</b><small>{[it.variant, it.price ? money(it.price) : null, it.quantity > 1 ? `×${it.quantity}` : null].filter(Boolean).join(' · ')}</small></span>
                            </div>
                          ))}
                          <div className="wa-nl-rows">
                            <div><span>Ordered</span><span>{day(o.created_at)} · {money(o.total_price)}</span></div>
                            {o.shipped_at && <div><span>Shipped</span><span>{day(o.shipped_at)}{o.dispatch?.courier ? ` · ${o.dispatch.courier}` : ''}{o.dispatch?.tracking_url && <> · <a href={o.dispatch.tracking_url} target="_blank" rel="noreferrer">{o.dispatch.awb ? `…${String(o.dispatch.awb).slice(-4)}` : 'track'} ↗</a></>}</span></div>}
                          </div>
                          <div className="wa-nl-checks-box">
                            <div className="wa-nl-label">Policy checks</div>
                            <ul className="wa-nl-checks">
                              <li className={o.payment.key === 'partial_cod' ? 'warn' : o.payment.key === 'prepaid' ? 'ok' : ''}>{o.payment.label}</li>
                              {days != null && <li>Shipped {days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`} — damage claims need the unboxing video within 24h of delivery</li>}
                              <li className={shop.media.photos ? 'ok' : ''}>{shop.media.photos ? `${shop.media.photos} photo${shop.media.photos === 1 ? '' : 's'} received in this chat` : 'No photos in this chat yet'}</li>
                              <li className={shop.media.videos ? 'ok' : ''}>{shop.media.videos ? 'Video received in this chat (unboxing?)' : 'No unboxing video in this chat'}</li>
                              {earlier.map(t => <li key={t.id} className="warn">Earlier ticket {refOf(t)} · {t.nature || 'request'} · {t.status}</li>)}
                            </ul>
                          </div>
                          <button type="button" className="btn btn-primary wa-nl-wide" disabled={!canTicket}
                            title={canTicket ? undefined : 'Needs edit access to Support'} onClick={() => raiseTicket(o)}>
                            Raise support ticket for {o.order_number}</button>
                        </section>
                      )}

                      {!!others.length && (
                        <section className="wa-nl-card">
                          <div className="wa-nl-label">Other orders</div>
                          {others.map(x => (
                            <button key={x.order_number} type="button" className="wa-nl-line" onClick={() => setFocusOrder(x.order_number)}
                              title="Show this order above">
                              <span><b>{x.order_number}</b> · {x.items.map(it => it.title).join(', ') || 'No items'}</span>
                              <span>{x.state}</span>
                            </button>
                          ))}
                        </section>
                      )}

                      <section className="wa-nl-card">
                        <div className="wa-nl-card-head"><span className="wa-nl-label">Support tickets</span><a href="/support">Open in Support</a></div>
                        {!shop.tickets.length && <div className="wa-nl-muted">None yet.</div>}
                        {shop.tickets.slice(0, 4).map(t => (
                          <a key={t.id} className="wa-nl-line" href={`/support?focus=${t.id}`}>
                            <span><b>{refOf(t)}</b> · {t.reason || t.nature || 'Request'}{t.order_number ? ` · ${t.order_number}` : ''}</span>
                            <span className={t.status === 'Closed' ? 'ok' : 'warn'}>{t.status}</span>
                          </a>
                        ))}
                      </section>
                    </>
                  )
                })()}
                {filesAndNotes}
              </>
            )}
            {sideTab === 'tickets' && (
              <div className="wa-orders">
                {!shop?.tickets?.length && <p className="wa-empty">No support tickets for this customer yet.</p>}
                {(shop?.tickets || []).map(t => (
                  <div key={t.id} className="wa-order">
                    <div className="wa-order-head">
                      <a className="wa-order-ref" href={`/support?focus=${t.id}`}>{refOf(t)}</a>
                      <span className="wa-pill" style={pillStyle(t.status === 'Closed' ? '#34d399' : '#fbbf24')}>{t.status}</span>
                      <span className="wa-order-total">{t.order_number || ''}</span>
                    </div>
                    <div className="wa-order-meta">
                      <span>{[t.nature, t.reason].filter(Boolean).join(' · ')}</span>
                      <span>· {t.progress}{t.action ? ` · ${t.action}` : ''}</span>
                      <span>· raised {day(t.raised_on)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {sideTab === 'activity' && (
              <ul className="wa-activity">
                {!activity.length && <li className="wa-empty">Nothing recorded yet.</li>}
                {activity.map(a => (
                  <li key={a.id}>
                    <span className={`wa-activity-dot k-${a.kind}`} aria-hidden="true" />
                    <span>{a.body}<span className="wa-activity-when">{day(a.created_at)} {clock(a.created_at)}</span></span>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        )}

        {/* The lead, its orders, and what has happened */}
        {thread && cf && (
          <aside className="wa-side" aria-label="Lead">
            <div className="wa-side-head">
              <h2>{thread.lead_name || thread.display_name}</h2>
              <span>Since {day(thread.created_at)}</span>
            </div>
            <div className="wa-side-actions">
              <button type="button" className="btn btn-secondary" disabled={!canQuote}
                title={canQuote ? 'Price it off the catalog and send the quotation PDF' : 'Needs access to Crewfit quotes'}
                onClick={() => setQuoteOpen(true)}><Icon name="invoice" size={14} /> New quote</button>
              <button type="button" className="btn btn-primary" disabled={!canEditOrders}
                title={canEditOrders ? 'Opens the order form filled in from this chat' : 'Needs edit access to bulk orders'}
                onClick={createOrder}><Icon name="plus" size={14} /> Create order</button>
              <button type="button" className="btn btn-secondary wa-span-2"
                disabled={thread.lead_status === 'need_mockup' || !statusOf.need_mockup}
                onClick={() => setLeadStatus('need_mockup')}><Icon name="palette" size={14} />
                {thread.lead_status === 'need_mockup' ? 'Waiting on the mockup' : 'Need mockup'}</button>
            </div>
            <div className="wa-side-tabs" role="tablist">
              {[['lead', 'Lead'], ['orders', `Orders & quotes${orders.length + quotes.length ? ` (${orders.length + quotes.length})` : ''}`], ['activity', 'Activity']].map(([k, label]) => (
                <button key={k} type="button" role="tab" aria-selected={sideTab === k}
                  className={`wa-side-tab${sideTab === k ? ' wa-side-tab-on' : ''}`} onClick={() => setSideTab(k)}>{label}</button>
              ))}
            </div>

            {sideTab === 'lead' && (
              <>
                <div className="input-group">
                  <label htmlFor="wa-lead-status">Status</label>
                  <div className="wa-status-select">
                    <span className="wa-dot" style={{ background: look.color }} />
                    <select id="wa-lead-status" value={thread.lead_status || ''} onChange={e => setLeadStatus(e.target.value)}>
                      {!statusOf[thread.lead_status] && <option value={thread.lead_status || ''}>{look.name}</option>}
                      {statuses.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
                    </select>
                  </div>
                </div>

                <div className="wa-side-grid">
                  <div className="input-group">
                    <label htmlFor="wa-lead-product">Product</label>
                    <input id="wa-lead-product" value={lead.product_interest}
                      onChange={e => setLead(l => ({ ...l, product_interest: e.target.value }))} onBlur={() => saveField('product_interest')} />
                  </div>
                  <div className="input-group">
                    <label htmlFor="wa-lead-qty">Quantity</label>
                    <input id="wa-lead-qty" value={lead.quantity}
                      onChange={e => setLead(l => ({ ...l, quantity: e.target.value }))} onBlur={() => saveField('quantity')} />
                  </div>
                  <div className="input-group">
                    <label htmlFor="wa-lead-brand">Branding</label>
                    <input id="wa-lead-brand" value={lead.branding} placeholder="Embroidery, print…"
                      onChange={e => setLead(l => ({ ...l, branding: e.target.value }))} onBlur={() => saveField('branding')} />
                  </div>
                  <div className="input-group">
                    <label htmlFor="wa-lead-date">Needed by</label>
                    <input id="wa-lead-date" type="date" value={lead.needed_by}
                      onChange={e => setLead(l => ({ ...l, needed_by: e.target.value }))} onBlur={() => saveField('needed_by')} />
                  </div>
                  <div className="input-group wa-span-2">
                    <label htmlFor="wa-lead-company">Company or team</label>
                    <input id="wa-lead-company" value={lead.lead_company}
                      onChange={e => setLead(l => ({ ...l, lead_company: e.target.value }))} onBlur={() => saveField('lead_company')} />
                  </div>
                  <div className="input-group">
                    <label htmlFor="wa-lead-quoted">Quoted (₹)</label>
                    <input id="wa-lead-quoted" inputMode="decimal" value={lead.quoted_amount}
                      onChange={e => setLead(l => ({ ...l, quoted_amount: e.target.value.replace(/[^\d.]/g, '') }))} onBlur={() => saveField('quoted_amount')} />
                  </div>
                  <div className="input-group">
                    <label htmlFor="wa-lead-received">Received (₹)</label>
                    <input id="wa-lead-received" inputMode="decimal" value={lead.received_amount}
                      onChange={e => setLead(l => ({ ...l, received_amount: e.target.value.replace(/[^\d.]/g, '') }))} onBlur={() => saveField('received_amount')} />
                  </div>
                </div>

                {quoted > 0 && (
                  <div className="wa-paid">
                    <div className="wa-paid-bar"><div style={{ width: `${paidPct}%` }} /></div>
                    <span>{money(received)} of {money(quoted)} received{received < quoted ? ` · ${money(quoted - received)} due` : ''}</span>
                  </div>
                )}

                {thread.logo_url && (
                  <a className="wa-file" href={fileUrl(thread.logo_url)} target="_blank" rel="noreferrer">
                    <Icon name="palette" size={14} /> Logo they sent
                  </a>
                )}

                <div className="input-group">
                  <label htmlFor="wa-lead-notes">About the order</label>
                  <textarea id="wa-lead-notes" rows={3} value={lead.lead_notes}
                    onChange={e => setLead(l => ({ ...l, lead_notes: e.target.value }))} onBlur={() => saveField('lead_notes')} />
                </div>

                <div className="form-section wa-billing-head">
                  <span>Billing details</span>
                  <button type="button" className="mini-btn" disabled={!thread.window_open || busyWith('billing') || thread.mode === 'billing'}
                    title={thread.window_open ? 'Sends the details request and reads the reply into these fields' : 'The customer has to write first'}
                    onClick={askBilling}>{thread.mode === 'billing' ? 'Waiting for reply…' : billingFilled ? 'Ask again' : 'Ask customer'}</button>
                </div>
                {BILLING.map(([key, label, wide]) => (
                  <div key={key} className={`input-group${wide ? '' : ''}`}>
                    <label htmlFor={`wa-b-${key}`}>{label}</label>
                    {wide ? (
                      <textarea id={`wa-b-${key}`} rows={2} value={billingForm[key] ?? ''}
                        onChange={e => setBillingForm(f => ({ ...f, [key]: e.target.value }))} onBlur={() => saveBilling(key)} />
                    ) : (
                      <input id={`wa-b-${key}`} value={billingForm[key] ?? ''}
                        onChange={e => setBillingForm(f => ({ ...f, [key]: e.target.value }))} onBlur={() => saveBilling(key)} />
                    )}
                  </div>
                ))}

                {(thread.lead_status === 'need_mockup' || mockups.length > 0) && (
                  <>
                    <div className="form-section wa-billing-head">
                      <span>Design mockups</span>
                      <label className="mini-btn" style={{ cursor: 'pointer' }}>
                        {mockUploading ? 'Uploading…' : '+ Upload'}
                        <input type="file" multiple accept="image/*,application/pdf" hidden
                          onChange={e => { uploadMockups([...e.target.files]); e.target.value = '' }} />
                      </label>
                    </div>
                    {!mockups.length ? (
                      <p className="wa-empty" style={{ padding: '4px 0 12px', textAlign: 'left' }}>
                        Upload the design here, then send it to the customer for approval.
                      </p>
                    ) : (
                      <>
                        <div className="wa-mocks">
                          {mockups.map(m => (
                            <div key={m.id} className={`wa-mock${mockPick.includes(m.id) ? ' wa-mock-on' : ''}`}>
                              <label className="wa-mock-pick">
                                <input type="checkbox" checked={mockPick.includes(m.id)}
                                  onChange={e => setMockPick(p => (e.target.checked ? [...p, m.id] : p.filter(x => x !== m.id)))} />
                                {/^image\//.test(m.mime || '') ? <img src={fileUrl(m.url)} alt={m.file_name || 'Mockup'} /> : <span className="wa-doc-icon wa-doc-pdf">PDF</span>}
                              </label>
                              <span className="wa-mock-meta">{m.sent_at ? `Sent ${day(m.sent_at)}` : 'Not sent yet'}</span>
                              <button type="button" className="btn-icon wa-mock-x" aria-label={`Remove ${m.file_name || 'mockup'}`} onClick={() => removeMockup(m)}>
                                <Icon name="close" size={12} />
                              </button>
                            </div>
                          ))}
                        </div>
                        <button type="button" className="btn btn-primary btn-sm wa-mock-send" disabled={!mockPick.length || !thread.window_open || busyWith('mockups')}
                          title={thread.window_open ? '' : 'The chat is past the 24-hour window — the customer has to write first'}
                          onClick={sendMockups}>
                          {busyWith('mockups') ? 'Sending…' : `Send ${mockPick.length || ''} to customer for approval`}
                        </button>
                      </>
                    )}
                  </>
                )}

                {filesAndNotes}

                {thread.ad_referral && (
                  <>
                    <div className="form-section">Came from an ad</div>
                    <div className="wa-ad">
                      {thread.ad_referral.headline && <b>{thread.ad_referral.headline}</b>}
                      {thread.ad_referral.body && <p>{thread.ad_referral.body}</p>}
                      {thread.ad_referral.source_url && (
                        <a href={thread.ad_referral.source_url} target="_blank" rel="noreferrer">The ad</a>
                      )}
                    </div>
                  </>
                )}
              </>
            )}

            {sideTab === 'orders' && (
              <div className="wa-orders">
                {!!quotes.length && <div className="wa-list-label">Quotes</div>}
                {quotes.map(q => (
                  <div key={`q${q.id}`} className="wa-order">
                    <div className="wa-order-head">
                      <button type="button" className="wa-order-ref" onClick={() => previewQuote(q)} title="Preview the quotation">Quote #{q.id}</button>
                      <span className="wa-pill" style={pillStyle(q.order_id ? '#34d399' : q.status === 'Sent' ? '#60a5fa' : '#c3c9d4')}>
                        {q.order_id ? 'Ordered' : q.status}
                      </span>
                      <span className="wa-order-total">{money(q.grand_total)}</span>
                    </div>
                    <div className="wa-order-meta">
                      <span>{(q.line_items || []).map(li => `${li.product_name} × ${li.qty}`).join(', ')}</span>
                      {q.sent_at && <span>· sent {day(q.sent_at)}</span>}
                    </div>
                    <div className="wa-order-actions">
                      <button type="button" className="mini-btn" onClick={() => previewQuote(q)}>Preview</button>
                      <button type="button" className="mini-btn" disabled={busyWith(`quote:${q.id}`) || !thread.window_open}
                        title={thread.window_open ? 'Send the quotation PDF in this chat' : 'The customer has to write first'}
                        onClick={() => sendQuote(q)}>{busyWith(`quote:${q.id}`) ? 'Sending…' : q.sent_at ? 'Send again' : 'Send PDF'}</button>
                      {!q.order_id && canEditOrders && (
                        <button type="button" className="mini-btn" onClick={() => orderFromQuote(q)}>Convert to order</button>
                      )}
                    </div>
                  </div>
                ))}
                {!!quotes.length && <div className="wa-list-label">Orders</div>}
                {!orders.length && <p className="wa-empty">No orders on this number yet. {quotes.length ? 'Convert a quote above once the customer agrees.' : 'Make a quote, or create an order once the details are agreed.'}</p>}
                {orders.map(o => {
                  const link = (kind) => (o.payments || []).find(p => p.kind === kind)
                  return (
                    <div key={o.id} className="wa-order">
                      <div className="wa-order-head">
                        <button type="button" className="wa-order-ref" onClick={() => openOrder(o)} title="Open the order">CF-{o.sl_no}</button>
                        <span className="wa-pill" style={pillStyle(o.status === 'Dispatched' ? '#34d399' : o.status === 'Cancelled' ? '#f87171' : '#60a5fa')}>{o.status}</span>
                        <span className="wa-order-total">{money(o.grand_total)}</span>
                      </div>
                      <div className="wa-order-meta">
                        <span>{o.payment_status}</span>
                        {o.product && <span>· {o.product}{o.qty ? ` × ${o.qty}` : ''}</span>}
                        {o.tracking_link && <span>· Tracking {o.tracking_link}</span>}
                      </div>
                      {(link('advance') || link('balance')) && (
                        <div className="wa-order-pay">
                          {['advance', 'balance'].map(k => link(k) && (
                            <a key={k} href={link(k).url} target="_blank" rel="noreferrer">
                              {k === 'advance' ? 'Advance' : 'Balance'} {money(link(k).amount)} · {link(k).status === 'Paid' ? 'paid' : link(k).sent_at ? 'sent' : 'not sent'}
                            </a>
                          ))}
                        </div>
                      )}
                      {canEditOrders && (
                        <div className="wa-order-actions" role="group" aria-label={`Send for CF-${o.sl_no}`}>
                          {ORDER_SENDS.map(([k, label]) => (
                            <button key={k} type="button" className="mini-btn" disabled={busyWith(`${o.id}:${k}`) || !!notYet(o, k)}
                              title={notYet(o, k) || `Send ${label.toLowerCase()} to ${thread.display_name}`}
                              onClick={() => sendOrder(o, k)}>{busyWith(`${o.id}:${k}`) ? 'Sending…' : o.sent?.[k] ? <>{label} <span className="wa-sent-tick" aria-label="already sent">✓</span></> : label}</button>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {sideTab === 'activity' && (
              <ul className="wa-activity">
                {!activity.length && <li className="wa-empty">Nothing recorded yet.</li>}
                {activity.map(a => (
                  <li key={a.id}>
                    <span className={`wa-activity-dot k-${a.kind}`} aria-hidden="true" />
                    <span>{a.body}<span className="wa-activity-when">{day(a.created_at)} {clock(a.created_at)}</span></span>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        )}
      </div>

      {quoteOpen && thread && (
        <WaQuoteDrawer thread={thread} onClose={() => setQuoteOpen(false)}
          onSaved={(q, andSend) => {
            setQuoteOpen(false)
            setSideTab('orders')
            loadOrders()
            if (andSend) sendQuote({ ...q, sent_at: null })
            else toast.success(`Quote #${q.id} saved — send it from Orders & quotes`)
          }} />
      )}

      {ticketDraft && thread && (
        <TicketDrawer ticket={ticketDraft} options={ticketOptions} canEdit={canTicket}
          onClose={() => setTicketDraft(null)} onSaved={ticketRaised}>
          <div className="form-section">From the WhatsApp chat</div>
          {chatPhotos.length ? (
            <div className="wa-nl-pick" role="group" aria-label="Photos to copy onto the ticket">
              {chatPhotos.slice(-12).map(m => (
                <label key={m.id} className={ticketPhotos.includes(m.id) ? 'on' : ''}>
                  <input type="checkbox" checked={ticketPhotos.includes(m.id)}
                    onChange={e => setTicketPhotos(p => (e.target.checked ? [...p, m.id].slice(-8) : p.filter(x => x !== m.id)))} />
                  <img src={fileUrl(m.media_url)} alt={`Photo sent ${day(m.sent_at)}`} loading="lazy" />
                </label>
              ))}
            </div>
          ) : <p className="label-hint">The customer hasn’t sent any photos in this chat.</p>}
          <p className="label-hint">Ticked photos are copied onto the ticket. Videos stay in the chat, which the ticket links to.</p>
          <label className="page-check">
            <input type="checkbox" checked={ticketNotify && !!thread.window_open} disabled={!thread.window_open}
              onChange={e => setTicketNotify(e.target.checked)} />
            {thread.window_open ? 'Tell the customer the ticket number on WhatsApp' : 'Can’t message the customer — the 24-hour window has closed'}
          </label>
        </TicketDrawer>
      )}

      <CrewfitOrderDrawer target={orderTarget} onClose={() => { setOrderTarget(null); quoteToLink.current = null }}
        onSaved={async (saved) => {
          setOrderTarget(null)
          if (quoteToLink.current && saved?.id) {
            await apiFetch(`/api/crewfit/quotes/${quoteToLink.current}/link-order`, { method: 'POST', body: JSON.stringify({ orderId: saved.id }) })
          }
          quoteToLink.current = null
          loadOrders()
          loadActivity()
          if (saved?.sl_no) { setSideTab('orders'); toast.success(`CF-${saved.sl_no} is on this chat — send the summary from the Orders tab`) }
        }} />
      <WaCallDock calls={calls} onOpen={(id) => id && id !== openId && openConversation(id)} />
    </div>
  )
}

