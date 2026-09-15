import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { useAuth } from './hooks/useAuth'
import { ToastProvider } from './components/ui/Toast'
import useScrollToHash from './hooks/useScrollToHash'

// Pages
import Home           from './pages/Home'
import Login          from './pages/Login'
import Register       from './pages/Register'
import ForgotPassword from './pages/ForgotPassword'
import ResetPassword  from './pages/ResetPassword'
import VerifyEmail    from './pages/VerifyEmail'
import ScanResult     from './pages/ScanResult'
import Verify         from './pages/Verify'
import Pricing        from './pages/Pricing'
import Terms          from './pages/Terms'
import Privacy        from './pages/Privacy'
import PaymentSuccess from './pages/PaymentSuccess'
import DashboardIndex from './pages/dashboard/Index'
import Settings       from './pages/dashboard/Settings'
import PartnerPayoutDetails from './pages/PartnerPayoutDetails'
import AdminPartners  from './pages/admin/AdminPartners'

// ProtectedRoute — redirects to /login if no token
// Reads localStorage directly — no hook needed, avoids dead import (Patch 3)
function ProtectedRoute({ children }) {
  const token = localStorage.getItem('passthrough_token')
  if (!token) return <Navigate to="/login" replace />
  return children
}

// AdminRoute — needs the actual user object (for role), not just a token,
// so this one does use useAuth/AuthContext rather than a raw localStorage
// check. AuthProvider already refreshes `user` from /auth/me on load (see
// AuthContext.jsx), so `role` here reflects the server, not a stale cache.
function AdminRoute({ children }) {
  const token = localStorage.getItem('passthrough_token')
  const { user } = useAuth()
  if (!token) return <Navigate to="/login" replace />
  if (user && user.role !== 'ADMIN') return <Navigate to="/dashboard" replace />
  return children
}

// Needs to render inside BrowserRouter (useLocation requires Router
// context) — that's the only reason this isn't just called from App().
function ScrollToHash() {
  useScrollToHash()
  return null
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <BrowserRouter>
          <ScrollToHash />
          <Routes>
            {/* Public routes */}
            <Route path="/"                element={<Home />} />
            <Route path="/scan/:id"        element={<ScanResult />} />
            <Route path="/v/:code"         element={<Verify />} />
            <Route path="/login"           element={<Login />} />
            <Route path="/register"        element={<Register />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password"  element={<ResetPassword />} />
            <Route path="/verify-email"    element={<VerifyEmail />} />
            <Route path="/pricing"         element={<Pricing />} />
            <Route path="/terms"           element={<Terms />} />
            <Route path="/privacy"         element={<Privacy />} />
            <Route path="/payment/success" element={<PaymentSuccess />} />
            <Route path="/partner/payout-details" element={<PartnerPayoutDetails />} />

            {/* Protected routes — redirect to /login if no token */}
            <Route path="/dashboard"
              element={<ProtectedRoute><DashboardIndex /></ProtectedRoute>} />
            <Route path="/dashboard/settings"
              element={<ProtectedRoute><Settings /></ProtectedRoute>} />
            <Route path="/admin/partners"
              element={<AdminRoute><AdminPartners /></AdminRoute>} />

            {/* Catch-all */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </AuthProvider>
  )
}
