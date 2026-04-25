import { useState, useEffect, createContext, useContext } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import './index.css'

import { ThemeProvider } from './components/ThemeProvider'
import Sidebar from './components/Sidebar'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Customers from './pages/Customers'
import Orders from './pages/Orders'
import ScanHub from './pages/ScanHub'
import Settings from './pages/Settings'
import Admin from './pages/Admin'
import Profile from './pages/Profile'
import ForgotPassword from './pages/ForgotPassword'
import ResetPassword from './pages/ResetPassword'

const API_URL = import.meta.env.DEV ? 'http://localhost:5000' : (import.meta.env.VITE_API_URL || 'https://normless-crm-api.onrender.com')

// Auth Context
const AuthContext = createContext(null)

export function useAuth() {
  return useContext(AuthContext)
}

export function useApi() {
  const { token } = useAuth()
  
  const apiFetch = async (endpoint, options = {}) => {
    const res = await fetch(`${API_URL}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...options.headers,
      },
    })
    if (res.status === 401) {
      localStorage.removeItem('crm_token')
      window.location.reload()
      return null
    }

    const contentType = res.headers.get('content-type')
    if (contentType && contentType.includes('application/json')) {
        const data = await res.json()
        if (!res.ok) {
            return { error: data.error || 'Request failed', status: res.status }
        }
        return data
    }

    // Fallback for non-JSON errors (like HTML 404s)
    if (!res.ok) {
        return { error: `Server Error (${res.status})`, status: res.status }
    }
    return null
  }

  return apiFetch
}

function ProtectedRoute({ children }) {
  const { token } = useAuth()
  if (!token) return <Navigate to="/login" replace />
  return children
}

function AppLayout({ children }) {
  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">
        {children}
      </main>
    </div>
  )
}

function App() {
  const [token, setToken] = useState(localStorage.getItem('crm_token'))
  const [user, setUser] = useState(null)

  useEffect(() => {
    if (token) {
      fetch(`${API_URL}/api/auth/verify`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })
        .then(r => r.json())
        .then(data => {
          if (data.valid) {
            setUser(data.user)
          } else {
            logout()
          }
        })
        .catch(() => logout())
    }
  }, [token])

  const login = (newToken, userData) => {
    localStorage.setItem('crm_token', newToken)
    setToken(newToken)
    setUser(userData)
  }

  const logout = () => {
    localStorage.removeItem('crm_token')
    setToken(null)
    setUser(null)
  }

  return (
    <ThemeProvider>
      <AuthContext.Provider value={{ token, user, login, logout, API_URL }}>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={
              token ? <Navigate to="/" replace /> : <Login />
            } />
            <Route path="/forgot-password" element={
              token ? <Navigate to="/" replace /> : <ForgotPassword />
            } />
            <Route path="/reset-password" element={
              token ? <Navigate to="/" replace /> : <ResetPassword />
            } />
            <Route path="/" element={
              <ProtectedRoute>
                <AppLayout><Dashboard /></AppLayout>
              </ProtectedRoute>
            } />
            <Route path="/customers" element={
              <ProtectedRoute>
                <AppLayout><Customers /></AppLayout>
              </ProtectedRoute>
            } />
            <Route path="/orders" element={
              <ProtectedRoute>
                <AppLayout><Orders /></AppLayout>
              </ProtectedRoute>
            } />
            <Route path="/scan" element={
              <ProtectedRoute>
                <AppLayout><ScanHub /></AppLayout>
              </ProtectedRoute>
            } />
            <Route path="/settings" element={
              <ProtectedRoute>
                <AppLayout><Settings /></AppLayout>
              </ProtectedRoute>
            } />
            <Route path="/admin" element={
              <ProtectedRoute>
                <AppLayout><Admin /></AppLayout>
              </ProtectedRoute>
            } />
            <Route path="/profile" element={
              <ProtectedRoute>
                <AppLayout><Profile /></AppLayout>
              </ProtectedRoute>
            } />
          </Routes>
        </BrowserRouter>
      </AuthContext.Provider>
    </ThemeProvider>
  )
}

export default App
