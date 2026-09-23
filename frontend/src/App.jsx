import { Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { useAuth } from './hooks/useAuth'
import { ToastProvider } from './components/ui/Toast'
import Spinner from './components/ui/Spinner'
import ErrorBoundary from './components/ErrorBoundary'
import lazyWithRetry from './lib/lazyWithRetry'
import useScrollToHash from './hooks/useScrollToHash'
import usePageTitle from './hooks/usePageTitle'
import { useReferralCapture } from './hooks/useReferralCapture'

// Landing + auth pages stay in the main bundle (first paint / most common entry
// points). Everything else is split into its own chunk — the homepage used to
// download the admin console, partner pages and the Paystack integration too.
import Home           from './pages/Home'
import Login          from './pages/Login'
import Register       from './pages/Register'
import NotFound       from './pages/NotFound'

const ForgotPassword = lazyWithRetry(() => import('./pages/ForgotPassword'))
const ResetPassword  = lazyWithRetry(() => import('./pages/ResetPassword'))
const VerifyEmail    = lazyWithRetry(() => import('./pages/VerifyEmail'))
const ConfirmEmailChange = lazyWithRetry(() => import('./pages/ConfirmEmailChange'))
const ScanResult     = lazyWithRetry(() => import('./pages/ScanResult'))
const Verify         = lazyWithRetry(() => import('./pages/Verify'))
const Pricing        = lazyWithRetry(() => import('./pages/Pricing'))
const Terms          = lazyWithRetry(() => import('./pages/Terms'))
const Privacy        = lazyWithRetry(() => import('./pages/Privacy'))
const PaymentSuccess = lazyWithRetry(() => import('./pages/PaymentSuccess'))
const DashboardIndex = lazyWithRetry(() => import('./pages/dashboard/Index'))
const Settings       = lazyWithRetry(() => import('./pages/dashboard/Settings'))
// FEATURE GAP CLOSED (Payments & Pricing re-audit): see PaymentHistory.jsx's
// header comment — GET /api/payments/history had no frontend consumer at all.
const PaymentHistory  = lazyWithRetry(() => import('./pages/dashboard/PaymentHistory'))
const PartnerPayoutDetails = lazyWithRetry(() => import('./pages/PartnerPayoutDetails'))
const PartnerDashboard     = lazyWithRetry(() => import('./pages/PartnerDashboard'))
// Admin console (upstream Admin-panel work) — lazy like everything else non-landing.
const AdminLayout        = lazyWithRetry(() => import('./pages/admin/AdminLayout'))
const AdminDashboard     = lazyWithRetry(() => import('./pages/admin/AdminDashboard'))
const AdminPartners      = lazyWithRetry(() => import('./pages/admin/AdminPartners'))
const PartnerDetail      = lazyWithRetry(() => import('./pages/admin/PartnerDetail'))
const AdminUsers         = lazyWithRetry(() => import('./pages/admin/AdminUsers'))
const AdminScans         = lazyWithRetry(() => import('./pages/admin/AdminScans'))
const AdminPayments      = lazyWithRetry(() => import('./pages/admin/AdminPayments'))
const AdminLeads         = lazyWithRetry(() => import('./pages/admin/AdminLeads'))
const AdminSystemHealth  = lazyWithRetry(() => import('./pages/admin/AdminSystemHealth'))

// Sends a signed-out visitor to /login, remembering where they were headed so
// login can return them there (Login validates ?next= via safeNext).
function loginRedirect(location) {
  const next = encodeURIComponent(location.pathname + location.search)
  return <Navigate to={`/login?next=${next}`} replace />
}

// ProtectedRoute — redirects to /login if no token
// Reads localStorage directly — no hook needed, avoids dead import (Patch 3)
function ProtectedRoute({ children }) {
  const token = localStorage.getItem('passthrough_token')
  const location = useLocation()
  if (!token) return loginRedirect(location)
  return children
}

// AdminRoute — needs the actual user object (for role), not just a token,
// so this one does use useAuth/AuthContext rather than a raw localStorage
// check. AuthProvider already refreshes `user` from /auth/me on load (see
// AuthContext.jsx), so `role` here reflects the server, not a stale cache.
function AdminRoute({ children }) {
  const token = localStorage.getItem('passthrough_token')
  const { user, authLoading } = useAuth()
  const location = useLocation()
  if (!token) return loginRedirect(location)
  // Don't render admin chrome before the role is actually confirmed (upstream
  // fix: a null/not-yet-loaded `user` used to render the admin shell briefly).
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
  usePageTitle()
  useReferralCapture()
  return null
}

// Inside the Router so it can reset itself when the route changes — one page
// crashing must not leave the whole app stuck on the error screen.
function RoutedApp() {
  const { pathname } = useLocation()
  return (
    <ErrorBoundary resetKey={pathname}>
      <Suspense fallback={
        <div className="min-h-screen flex items-center justify-center bg-gray-50">
          <Spinner size="lg" />
        </div>
      }>
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
          <Route path="/confirm-email-change" element={<ConfirmEmailChange />} />
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
          <Route path="/dashboard/payments"
            element={<ProtectedRoute><PaymentHistory /></ProtectedRoute>} />
          <Route path="/admin" element={<AdminRoute><AdminLayout /></AdminRoute>}>
            <Route index element={<Navigate to="dashboard" replace />} />
            <Route path="dashboard"    element={<AdminDashboard />} />
            <Route path="partners"     element={<AdminPartners />} />
            <Route path="partners/:id" element={<PartnerDetail />} />
            <Route path="users"        element={<AdminUsers />} />
            <Route path="scans"        element={<AdminScans />} />
            <Route path="payments"     element={<AdminPayments />} />
            <Route path="leads"        element={<AdminLeads />} />
            <Route path="health"       element={<AdminSystemHealth />} />
          </Route>

          {/* Catch-all: a real 404 page instead of a silent redirect home */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <BrowserRouter>
          <RouteEffects />
          <RoutedApp />
        </BrowserRouter>
      </ToastProvider>
    </AuthProvider>
  )
}
