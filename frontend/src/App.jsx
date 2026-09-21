import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { useAuth } from './hooks/useAuth'
import { ToastProvider } from './components/ui/Toast'
import useScrollToHash from './hooks/useScrollToHash'
import { useReferralCapture } from './hooks/useReferralCapture'

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
import PartnerDashboard     from './pages/PartnerDashboard'
import AdminLayout        from './pages/admin/AdminLayout'
import AdminDashboard     from './pages/admin/AdminDashboard'
import AdminPartners      from './pages/admin/AdminPartners'
import PartnerDetail      from './pages/admin/PartnerDetail'
import AdminUsers         from './pages/admin/AdminUsers'
import AdminScans         from './pages/admin/AdminScans'
import AdminPayments      from './pages/admin/AdminPayments'
import AdminLeads         from './pages/admin/AdminLeads'
import AdminSystemHealth  from './pages/admin/AdminSystemHealth'

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
//
// AUDIT FIX (Admin panel): previously rendered `children` immediately
// whenever `user` was falsy (only redirecting when a user object WAS
// present and its role wasn't ADMIN) — so a null/not-yet-loaded `user`
// (cleared localStorage cache, or the very first paint after opening the
// app with only a token present) briefly rendered the admin page's client
// shell before refreshUser() resolved. The actual data was always safe
// (adminOnly.js re-checks role from the DB on every request — see
// api.js's new 403 handler too), but the UI shouldn't render as admin
// before a role is actually confirmed. Now waits for authLoading to clear
// before deciding either way.
function AdminRoute({ children }) {
  const token = localStorage.getItem('passthrough_token')
  const { user, authLoading } = useAuth()
  if (!token) return <Navigate to="/login" replace />
  if (authLoading) return null
  if (!user || user.role !== 'ADMIN') return <Navigate to="/dashboard" replace />
  return children
}

// Needs to render inside BrowserRouter (useLocation requires Router
// context) — that's the only reason this isn't just called from App().
// Referral capture lives here too, for the same reason: it also needs
// useLocation to see the current ?ref= query string on every navigation.
function RouteEffects() {
  useScrollToHash()
  useReferralCapture()
  return null
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <BrowserRouter>
          <RouteEffects />
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
            <Route path="/partner/dashboard"      element={<PartnerDashboard />} />

            {/* Protected routes — redirect to /login if no token */}
            <Route path="/dashboard"
              element={<ProtectedRoute><DashboardIndex /></ProtectedRoute>} />
            <Route path="/dashboard/settings"
              element={<ProtectedRoute><Settings /></ProtectedRoute>} />
            <Route path="/admin"
              element={<AdminRoute><AdminLayout /></AdminRoute>}>
              <Route index element={<Navigate to="dashboard" replace />} />
              <Route path="dashboard"     element={<AdminDashboard />} />
              <Route path="partners"      element={<AdminPartners />} />
              <Route path="partners/:id"  element={<PartnerDetail />} />
              <Route path="users"         element={<AdminUsers />} />
              <Route path="scans"         element={<AdminScans />} />
              <Route path="payments"      element={<AdminPayments />} />
              <Route path="leads"         element={<AdminLeads />} />
              <Route path="health"        element={<AdminSystemHealth />} />
            </Route>

            {/* Catch-all */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </AuthProvider>
  )
}
