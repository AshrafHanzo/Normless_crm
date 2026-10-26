import Icon from '../../components/Icon'

/**
 * Pieces of a chat message drawn the way WhatsApp draws them on the customer's phone: its text
 * formatting (*bold*, _italic_, ~strike~, ```mono```, links), the ticks (one grey, two grey, two
 * blue once read), and the buttons under a template or menu message.
 */

const TOKEN = /(```[\s\S]+?```|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|https?:\/\/[^\s]+)/g

/** WhatsApp's own formatting, as React elements (never as HTML). */
export function WaText({ text }) {
  const parts = String(text || '').split(TOKEN)
  return (
    <div className="wa-text">
      {parts.map((p, i) => {
        if (!p) return null
        if (p.startsWith('```') && p.endsWith('```') && p.length > 6) return <code key={i}>{p.slice(3, -3)}</code>
        if (/^\*[^*\n]+\*$/.test(p)) return <strong key={i}>{p.slice(1, -1)}</strong>
        if (/^_[^_\n]+_$/.test(p)) return <em key={i}>{p.slice(1, -1)}</em>
        if (/^~[^~\n]+~$/.test(p)) return <s key={i}>{p.slice(1, -1)}</s>
        if (/^https?:\/\//.test(p)) return <a key={i} href={p} target="_blank" rel="noreferrer">{p}</a>
        return <span key={i}>{p}</span>
      })}
    </div>
  )
}

/** ✓ sent · ✓✓ delivered · blue ✓✓ read · ! not sent. */
export function Ticks({ status }) {
  if (status === 'failed') return <span className="wa-ticks wa-ticks-bad" title="Not sent" aria-label="Not sent">!</span>
  const two = status === 'delivered' || status === 'read'
  const label = status === 'read' ? 'Read' : two ? 'Delivered' : status === 'sent' ? 'Sent' : 'Sending'
  if (!['sent', 'delivered', 'read'].includes(status)) return <span className="wa-ticks" title={label} aria-label={label}><Icon name="clock" size={11} /></span>
  return (
    <span className={`wa-ticks${status === 'read' ? ' wa-ticks-read' : ''}`} title={label} aria-label={label}>
      <svg width={two ? 16 : 11} height="11" viewBox={two ? '0 0 16 11' : '0 0 11 11'} aria-hidden="true">
        {two
          ? <><path d="M1 6l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /><path d="M6.5 8.5l.5.5 6-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></>
          : <path d="M1.5 6l3 3 5-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />}
      </svg>
    </span>
  )
}

const BUTTON_ICON = { URL: 'eye', PHONE_NUMBER: 'phone', QUICK_REPLY: 'refresh', COPY_CODE: 'copy' }

/** The buttons a template or menu message showed under it on the phone. */
export function BubbleButtons({ payload }) {
  if (!payload) return null
  let items = []
  if (payload.kind === 'template') items = (payload.buttons || []).map(b => ({ icon: BUTTON_ICON[b.type] || 'refresh', text: b.text }))
  else if (payload.kind === 'buttons') items = (payload.options || []).map(t => ({ icon: 'refresh', text: t }))
  else if (payload.kind === 'list') items = [{ icon: 'note', text: payload.button || 'Choose', list: payload.options || [] }]
  else if (payload.kind === 'cta_url') items = [{ icon: 'eye', text: payload.label || 'Open link' }]
  if (!items.length) return null
  return (
    <div className="wa-bbuttons">
      {items.map((b, i) => (
        <div key={i} className="wa-bbutton" title={b.list ? b.list.join(' · ') : undefined}>
          <Icon name={b.icon} size={12} /> {b.text}
          {b.list && <span className="wa-bbutton-list">{b.list.length} options: {b.list.join(' · ')}</span>}
        </div>
      ))}
    </div>
  )
}
