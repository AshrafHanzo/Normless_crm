import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'

function EyeIcon({ off }) {
  return off ? (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3.5 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  ) : (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" />
    </svg>
  )
}

const LockLogo = () => (
  <div className="login-logo" style={{ color: '#fff' }}>
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  </div>
)

export default function ResetPassword() {
  const [searchParams] = useSearchParams()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [showPw, setShowPw] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const navigate = useNavigate()
  const token = searchParams.get('token')

  useEffect(() => { if (!token) setError('Invalid reset link. Please request a new one.') }, [token])

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (password !== confirmPassword) { setError('Passwords do not match'); return }
    if (password.length < 6) { setError('Password must be at least 6 characters'); return }
    setLoading(true); setError('')
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message || 'Failed to reset password')
      setSuccess(true)
      setTimeout(() => navigate('/login'), 2000)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  if (!token) {
    return (
      <div className="login-page">
        <div className="login-card page-enter" style={{ textAlign: 'center' }}>
          <LockLogo />
          <h1>Invalid link</h1>
          <p>This password reset link is invalid or has expired.</p>
          <Link to="/forgot-password" className="btn btn-primary" style={{ width: '100%', marginTop: 8 }}>Request New Link</Link>
          <div style={{ marginTop: 18 }}><Link to="/login" style={{ color: 'var(--primary-light)', fontSize: 13 }}>Back to Login</Link></div>
        </div>
      </div>
    )
  }

  return (
    <div className="login-page">
      <div className="login-card page-enter">
        <LockLogo />
        <h1>Set new password</h1>
        <p>Choose a strong new password for your account</p>

        {success ? (
          <div style={{ padding: 16, background: 'var(--success-bg)', borderRadius: 'var(--radius-md)', textAlign: 'center' }}>
            <div style={{ color: 'var(--success)', fontWeight: 600 }}>✓ Password reset successfully</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 6 }}>Redirecting to login…</div>
          </div>
        ) : (
          <>
            {error && <div className="login-error">{error}</div>}
            <form onSubmit={handleSubmit}>
              <div className="input-group">
                <label>New Password</label>
                <div className="password-wrap">
                  <input type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter new password" required autoFocus />
                  <button type="button" className="password-toggle" onClick={() => setShowPw(v => !v)} aria-label="Toggle password"><EyeIcon off={showPw} /></button>
                </div>
              </div>

              <div className="input-group">
                <label>Confirm Password</label>
                <div className="password-wrap">
                  <input type={showConfirm ? 'text' : 'password'} value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} placeholder="Re-enter new password" required />
                  <button type="button" className="password-toggle" onClick={() => setShowConfirm(v => !v)} aria-label="Toggle confirm password"><EyeIcon off={showConfirm} /></button>
                </div>
                {confirmPassword && password !== confirmPassword && <span style={{ fontSize: 12, color: 'var(--danger)', marginTop: 6, display: 'block' }}>Passwords don't match</span>}
              </div>

              <button type="submit" className="btn btn-primary" disabled={loading} style={{ width: '100%', marginTop: 8 }}>
                {loading ? 'Resetting…' : 'Reset Password'}
              </button>
            </form>
          </>
        )}

        <div style={{ marginTop: 22, textAlign: 'center', paddingTop: 18, borderTop: '1px solid var(--border)' }}>
          <Link to="/login" style={{ color: 'var(--primary-light)', fontWeight: 600, fontSize: 14 }}>Back to Login</Link>
        </div>
      </div>
    </div>
  )
}
