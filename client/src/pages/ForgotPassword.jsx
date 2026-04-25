import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'

export default function ForgotPassword() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  const navigate = useNavigate()

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    setMessage('')

    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.message || 'Failed to send reset email')
      }

      setMessage(data.message)
      setSent(true)
      setTimeout(() => {
        navigate('/login')
      }, 3000)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg, var(--bg-primary), var(--bg-secondary))' }}>
      <div style={{ width: '100%', maxWidth: '420px', padding: '24px' }}>
        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '40px 32px', boxShadow: 'var(--shadow-lg)' }}>
          {/* Header */}
          <div style={{ marginBottom: '32px', textAlign: 'center' }}>
            <div style={{ fontSize: '48px', marginBottom: '12px' }}>🔐</div>
            <h1 style={{ fontSize: '24px', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '8px' }}>Reset Password</h1>
            <p style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>Enter your email to receive a password reset link</p>
          </div>

          {sent ? (
            <div style={{ padding: '16px', background: 'var(--success-bg)', border: `1px solid var(--success)`, borderRadius: 'var(--radius-md)', marginBottom: '24px', textAlign: 'center' }}>
              <p style={{ color: 'var(--success)', fontWeight: '500', fontSize: '14px' }}>✓ {message || 'Reset link sent! Check your email.'}</p>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '8px' }}>Redirecting to login...</p>
            </div>
          ) : (
            <>
              {error && (
                <div style={{ padding: '12px 16px', background: 'var(--danger-bg)', border: `1px solid var(--danger)`, borderRadius: 'var(--radius-md)', marginBottom: '20px' }}>
                  <p style={{ color: 'var(--danger)', fontSize: '13px', fontWeight: '500' }}>✕ {error}</p>
                </div>
              )}

              <form onSubmit={handleSubmit}>
                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '8px' }}>Email Address</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="normlessfashion@gmail.com"
                    required
                    style={{
                      width: '100%',
                      padding: '12px 14px',
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-md)',
                      color: 'var(--text-primary)',
                      fontSize: '14px',
                      transition: 'all 0.2s',
                      outlineOffset: '-1px'
                    }}
                    onFocus={(e) => {
                      e.target.style.borderColor = 'var(--primary)'
                      e.target.style.boxShadow = '0 0 0 3px rgba(99, 102, 241, 0.1)'
                    }}
                    onBlur={(e) => {
                      e.target.style.borderColor = 'var(--border)'
                      e.target.style.boxShadow = 'none'
                    }}
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  style={{
                    width: '100%',
                    padding: '12px 16px',
                    background: loading ? 'rgba(99, 102, 241, 0.5)' : 'linear-gradient(135deg, var(--primary), var(--primary-light))',
                    color: 'white',
                    border: 'none',
                    borderRadius: 'var(--radius-md)',
                    fontSize: '14px',
                    fontWeight: '600',
                    cursor: loading ? 'not-allowed' : 'pointer',
                    transition: 'all 0.3s',
                    opacity: loading ? 0.7 : 1
                  }}
                >
                  {loading ? 'Sending...' : 'Send Reset Link'}
                </button>
              </form>
            </>
          )}

          {/* Back to Login */}
          <div style={{ marginTop: '24px', textAlign: 'center', paddingTop: '20px', borderTop: '1px solid var(--border)' }}>
            <p style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>
              Remember your password?{' '}
              <Link to="/login" style={{ color: 'var(--primary)', fontWeight: '600', textDecoration: 'none', transition: 'color 0.2s' }} onMouseEnter={(e) => e.target.style.color = 'var(--primary-light)'} onMouseLeave={(e) => e.target.style.color = 'var(--primary)'}>
                Back to Login
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
