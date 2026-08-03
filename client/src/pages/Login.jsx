import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../App'
import Icon from '../components/Icon'

function EyeIcon({ off }) {
  return off ? (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3.5 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  ) : (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

const BRANDS = {
  normless: { name: 'Normless', tag: 'Shopify retail CRM', glyph: 'activity' },
  crewfit: { name: 'Crewfit', tag: 'Bulk-order CRM', glyph: 'shirt' },
}

export default function Login() {
  const { login, API_URL, brand, setBrand } = useAuth()
  const [selected, setSelected] = useState(brand || 'normless')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const b = BRANDS[selected]

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(''); setLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const data = await res.json()
      if (res.ok) {
        setBrand(selected)          // pick which CRM to open
        login(data.token, data.user)
      } else {
        setError(data.error || 'Login failed')
      }
    } catch {
      setError('Server is not reachable. Make sure the backend is running.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={`login-page brand-${selected}`}>
      <div className="login-card page-enter">
        {/* Brand toggle */}
        <div className="brand-toggle">
          {Object.entries(BRANDS).map(([key, val]) => (
            <button key={key} type="button" className={selected === key ? 'active' : ''} onClick={() => setSelected(key)}>
              <Icon name={val.glyph} size={15} strokeWidth={2.2} />{val.name}
            </button>
          ))}
        </div>

        <div className={`login-logo ${selected === 'crewfit' ? 'cf-logo' : 'n-logo'}`} role="img" aria-label={b.name} />
        <h1>Welcome back</h1>
        <p>Sign in to your <strong>{b.name}</strong> CRM — {b.tag}</p>

        {error && <div className="login-error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="input-group">
            <label>Username</label>
            <input type="text" value={username} onChange={e => setUsername(e.target.value)} placeholder="Enter your username" required autoFocus />
          </div>

          <div className="input-group">
            <label>Password</label>
            <div className="password-wrap">
              <input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter your password" required />
              <button type="button" className="password-toggle" onClick={() => setShowPassword(v => !v)} title={showPassword ? 'Hide password' : 'Show password'} aria-label="Toggle password visibility">
                <EyeIcon off={showPassword} />
              </button>
            </div>
            <Link to="/forgot-password" style={{ fontSize: '12px', color: 'var(--primary-light)', marginTop: '8px', display: 'inline-block' }}>Forgot password?</Link>
          </div>

          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Signing in…' : `Sign in to ${b.name}`}
          </button>
        </form>
      </div>
    </div>
  )
}
