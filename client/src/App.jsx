import { useState, useEffect, createContext, useContext } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import './index.css'

import { ThemeProvider } from './components/ThemeProvider'
import ToastProvider from './components/Toast'
import Sidebar from './components/Sidebar'
import ErrorBoundary from './components/ErrorBoundary'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Customers from './pages/Customers'
import Orders from './pages/Orders'
import ScanHub from './pages/ScanHub'
import Invoices from './pages/Invoices'
import Marketing from './pages/Marketing'
import Settings from './pages/Settings'
import Admin from './pages/Admin'
import Profile from './pages/Profile'
import ForgotPassword from './pages/ForgotPassword'
import ResetPassword from './pages/ResetPassword'
import CrewfitDashboard from './pages/crewfit/CrewfitDashboard'
import CrewfitAnalytics from './pages/crewfit/CrewfitAnalytics'
import CrewfitOrders from './pages/crewfit/CrewfitOrders'
import CrewfitCatalog from './pages/crewfit/CrewfitCatalog'
import CrewfitQuotes from './pages/crewfit/CrewfitQuotes'
import CrewfitPayments from './pages/crewfit/CrewfitPayments'
import CrewfitCustomers from './pages/crewfit/CrewfitCustomers'
import CrewfitVendorOrders from './pages/crewfit/CrewfitVendorOrders'

// API base. In dev, VITE_API_URL (from .env.development.local) points at the
// production backend + Postgres so previews use the real database.
const API_URL = import.meta.env.DEV
  ? (import.meta.env.VITE_API_URL || 'http://localhost:5000')
  : (import.meta.env.VITE_API_URL || '')

const AuthContext = createContext(null)
export function useAuth() { return useContext(AuthContext) }

export function useApi() {
  const { token } = useAuth()
  const apiFetch = async (endpoint, options = {}) => {
    // FormData sets its own multipart Content-Type (with boundary) — never override it.
    const isFormData = options.body instanceof FormData
    const res = await fetch(`${API_URL}${endpoint}`, {
      ...options,
      headers: { ...(isFormData ? {} : { 'Content-Type': 'application/json' }), 'Authorization': `Bearer ${token}`, ...options.headers },
    })
    if (res.status === 401) { localStorage.removeItem('crm_token'); window.location.reload(); return null }
    const ct = res.headers.get('content-type')
    if (options.responseType === 'blob') {
      if (!res.ok) {
        if (ct && ct.includes('application/json')) { const data = await res.json(); return { error: data.error || 'Request failed', status: res.status } }
        return { error: `Server Error (${res.status})`, status: res.status }
      }
      const disposition = res.headers.get('content-disposition') || ''
      const filename = disposition.match(/filename="?([^"]+)"?/)?.[1]
      return { blob: await res.blob(), filename }
    }
    if (ct && ct.includes('application/json')) {
      const data = await res.json()
      if (!res.ok) return { error: data.error || 'Request failed', status: res.status }
      return data
    }
    if (!res.ok) return { error: `Server Error (${res.status})`, status: res.status }
    return null
  }
  return apiFetch
}

function ProtectedRoute({ children, permission }) {
  const { token, user } = useAuth()
  if (!token) return <Navigate to="/login" replace />
  if (permission && user) {
    const isOwnerOrAdmin = user.role === 'owner' || user.role === 'admin'
    if (!isOwnerOrAdmin && !user[permission]) return <Navigate to="/scan" replace />
  }
  return children
}

function AppLayout({ children }) {
  const { brand } = useAuth()
  const location = useLocation()
  return (
    <div className={`app-layout brand-${brand}`}>
      <Sidebar />
      <main className="main-content">
        <ErrorBoundary key={location.pathname}>{children}</ErrorBoundary>
      </main>
    </div>
  )
}

function App() {
  const [token, setToken] = useState(localStorage.getItem('crm_token'))
  const [user, setUser] = useState(null)
  const [brand, setBrandState] = useState(localStorage.getItem('crm_brand') || 'normless')

  const setBrand = (b) => { localStorage.setItem('crm_brand', b); setBrandState(b) }

  useEffect(() => {
    if (token) {
      fetch(`${API_URL}/api/auth/verify`, { headers: { 'Authorization': `Bearer ${token}` } })
        .then(r => r.json())
        .then(data => { data.valid ? setUser(data.user) : logout() })
        .catch(() => logout())
    }
  }, [token])

  // When the user loads, make sure the active brand is one they can access.
  useEffect(() => {
    if (!user) return
    const isAdmin = user.role === 'owner' || user.role === 'admin'
    const allowed = isAdmin ? ['normless', 'crewfit']
      : [user.can_access_normless && 'normless', user.can_access_crewfit && 'crewfit'].filter(Boolean)
    const list = allowed.length ? allowed : ['normless']
    if (!list.includes(brand)) setBrand(list[0])
  }, [user])

  const login = (newToken, userData) => { localStorage.setItem('crm_token', newToken); setToken(newToken); setUser(userData) }
  const logout = () => { localStorage.removeItem('crm_token'); setToken(null); setUser(null) }

  const homeFor = (b) => (b === 'crewfit' ? '/crewfit' : '/')

  return (
    <ThemeProvider>
      <ToastProvider>
        <AuthContext.Provider value={{ token, user, login, logout, API_URL, brand, setBrand }}>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={token ? <Navigate to={homeFor(brand)} replace /> : <Login />} />
            <Route path="/forgot-password" element={token ? <Navigate to={homeFor(brand)} replace /> : <ForgotPassword />} />
            <Route path="/reset-password" element={token ? <Navigate to={homeFor(brand)} replace /> : <ResetPassword />} />

            {/* Normless CRM */}
            <Route path="/" element={<ProtectedRoute permission="can_view_dashboard"><AppLayout><Dashboard /></AppLayout></ProtectedRoute>} />
            <Route path="/customers" element={<ProtectedRoute permission="can_view_customers"><AppLayout><Customers /></AppLayout></ProtectedRoute>} />
            <Route path="/orders" element={<ProtectedRoute permission="can_view_orders"><AppLayout><Orders /></AppLayout></ProtectedRoute>} />
            <Route path="/scan" element={<ProtectedRoute permission="can_scan_orders"><AppLayout><ScanHub /></AppLayout></ProtectedRoute>} />
            <Route path="/marketing" element={<ProtectedRoute permission="can_view_marketing"><AppLayout><Marketing /></AppLayout></ProtectedRoute>} />
            <Route path="/invoices" element={<ProtectedRoute permission="can_view_invoices"><AppLayout><Invoices /></AppLayout></ProtectedRoute>} />
            <Route path="/settings" element={<ProtectedRoute permission="can_sync_data"><AppLayout><Settings /></AppLayout></ProtectedRoute>} />
            <Route path="/admin" element={<ProtectedRoute><AppLayout>{(user?.role === 'owner' || user?.role === 'admin') ? <Admin /> : <Navigate to="/" replace />}</AppLayout></ProtectedRoute>} />
            <Route path="/profile" element={<ProtectedRoute><AppLayout><Profile /></AppLayout></ProtectedRoute>} />

            {/* Crewfit CRM */}
            <Route path="/crewfit" element={<ProtectedRoute permission="can_view_crewfit_followups"><AppLayout><CrewfitDashboard /></AppLayout></ProtectedRoute>} />
            <Route path="/crewfit/dashboard" element={<ProtectedRoute permission="can_view_crewfit_analytics"><AppLayout><CrewfitAnalytics /></AppLayout></ProtectedRoute>} />
            <Route path="/crewfit/orders" element={<ProtectedRoute permission="can_view_crewfit_orders"><AppLayout><CrewfitOrders /></AppLayout></ProtectedRoute>} />
            <Route path="/crewfit/catalog" element={<ProtectedRoute permission="can_view_crewfit_catalog"><AppLayout><CrewfitCatalog /></AppLayout></ProtectedRoute>} />
            <Route path="/crewfit/quotes" element={<ProtectedRoute permission="can_view_crewfit_calculator"><AppLayout><CrewfitQuotes /></AppLayout></ProtectedRoute>} />
            <Route path="/crewfit/payments" element={<ProtectedRoute permission="can_view_crewfit_payments"><AppLayout><CrewfitPayments /></AppLayout></ProtectedRoute>} />
            <Route path="/crewfit/customers" element={<ProtectedRoute permission="can_view_crewfit_customers"><AppLayout><CrewfitCustomers /></AppLayout></ProtectedRoute>} />
            <Route path="/crewfit/vendor-orders" element={<ProtectedRoute permission="can_view_crewfit_vendors"><AppLayout><CrewfitVendorOrders /></AppLayout></ProtectedRoute>} />
          </Routes>
        </BrowserRouter>
        </AuthContext.Provider>
      </ToastProvider>
    </ThemeProvider>
  )
}

export default App
