import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'

export default function ResetPassword() {
  const [searchParams] = useSearchParams()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const navigate = useNavigate()
  const token = searchParams.get('token')

  useEffect(() => {
    if (!token) {
      setError('Invalid reset link. Please request a new one.')
    }
  }, [token])

  const handleSubmit = async (e) => {
    e.preventDefault()

    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    if (password.length < 6) {
      setError('Password must be at least 6 characters')
      return
    }

    setLoading(true)
    setError('')

    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password })
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.message || 'Failed to reset password')
      }

      setSuccess(true)
      setTimeout(() => {
        navigate('/login')
      }, 2000)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  if (!token) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg, var(--bg-primary), var(--bg-secondary))' }}>
        <div style={{ width: '100%', maxWidth: '420px', padding: '24px' }}>
          <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '40px 32px', textAlign: 'center', boxShadow: 'var(--shadow-lg)' }}>
            <div style={{ fontSize: '48px', marginBottom: '12px' }}>❌</div>
            <h1 style={{ fontSize: '20px', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '8px' }}>Invalid Link</h1>
            <p style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '24px' }}>This password reset link is invalid or has expired.</p>
            <Link to="/forgot-password" style={{ display: 'inline-block', padding: '12px 24px', background: 'var(--primary)', color: 'white', borderRadius: 'var(--radius-md)', textDecoration: 'none', fontWeight: '600', transition: 'all 0.2s' }}>
              Request New Link
            </Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg, var(--bg-primary), var(--bg-secondary))' }}>
      <div style={{ width: '100%', maxWidth: '420px', padding: '24px' }}>
        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '40px 32px', boxShadow: 'var(--shadow-lg)' }}>
          {/* Header */}
          <div style={{ marginBottom: '32px', textAlign: 'center' }}>
            <div style={{ fontSize: '48px', marginBottom: '12px' }}>🔑</div>
            <h1 style={{ fontSize: '24px', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '8px' }}>Set New Password</h1>
            <p style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>Enter your new password below</p>
          </div>

          {success ? (
            <div style={{ padding: '16px', background: 'var(--success-bg)', border: `1px solid var(--success)`, borderRadius: 'var(--radius-md)', marginBottom: '24px', textAlign: 'center' }}>
              <p style={{ color: 'var(--success)', fontWeight: '500', fontSize: '14px' }}>✓ Password reset successfully!</p>
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
                {/* Password */}
                <div style={{ marginBottom: '16px' }}>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '8px' }}>New Password</label>
                  <div style={{ position: 'relative' }}>
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Enter new password"
                      required
                      style={{
                        width: '100%',
                        padding: '12px 14px',
                        paddingRight: '40px',
                        background: 'var(--surface)',
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-md)',
                        color: 'var(--text-primary)',
                        fontSize: '14px',
                        transition: 'all 0.2s'
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
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      style={{
                        position: 'absolute',
                        right: '12px',
                        top: '50%',
                        transform: 'translateY(-50%)',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        fontSize: '16px',
                        opacity: 0.6
                      }}
                    >
                      {showPassword ? '👁️' : '🙈'}
                    </button>
                  </div>
                </div>

                {/* Confirm Password */}
                <div style={{ marginBottom: '24px' }}>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: '600', color: 'var(--text-secondary)', marginBottom: '8px' }}>Confirm Password</label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Confirm password"
                    required
                    style={{
                      width: '100%',
                      padding: '12px 14px',
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-md)',
                      color: 'var(--text-primary)',
                      fontSize: '14px',
                      transition: 'all 0.2s'
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
                  {loading ? 'Resetting...' : 'Reset Password'}
                </button>
              </form>
            </>
          )}

          {/* Back to Login */}
          <div style={{ marginTop: '24px', textAlign: 'center', paddingTop: '20px', borderTop: '1px solid var(--border)' }}>
            <p style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>
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
