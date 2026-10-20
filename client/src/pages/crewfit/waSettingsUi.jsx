/**
 * The small pieces every WhatsApp settings screen is built from — Crewfit's and Normless's alike.
 */
import Icon from '../../components/Icon'

/** A save button that says what state the form is in, so nobody has to wonder. */
export function SaveButton({ dirty, saving, onClick, idle = 'Saved', label = 'Save changes' }) {
  return (
    <button type="button" className={`btn btn-sm ${dirty ? 'btn-primary' : 'btn-secondary'}`} disabled={saving || !dirty} onClick={onClick}>
      {saving ? 'Saving…' : dirty ? label : <><Icon name="check" size={14} /> {idle}</>}
    </button>
  )
}

export function Head({ title, children, actions }) {
  return (
    <div className="was-head">
      <div>
        <h2>{title}</h2>
        {children && <p>{children}</p>}
      </div>
      {actions && <div className="was-actions">{actions}</div>}
    </div>
  )
}

export function Toggle({ on, onChange, label, disabled }) {
  return (
    <button type="button" role="switch" aria-checked={!!on} aria-label={label} disabled={disabled}
      className={`toggle${on ? ' on' : ''}`} onClick={() => onChange(!on)}><span /></button>
  )
}

export const Loading = () => <div className="loader"><div className="spinner" /></div>
