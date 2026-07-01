import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { ToastProvider } from './components/ui/Toast'

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
import PaymentSuccess from './pages/PaymentSuccess'
import DashboardIndex from './pages/dashboard/Index'
import Settings       from './pages/dashboard/Settings'

// ProtectedRoute — redirects to /login if no token
// Reads localStorage directly — no hook needed, avoids dead import (Patch 3)
function ProtectedRoute({ children }) {
  const token = localStorage.getItem('passthrough_token')
  if (!token) return <Navigate to="/login" replace />
  return children
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <BrowserRouter>
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
            <Route path="/payment/success" element={<PaymentSuccess />} />

            {/* Protected routes — redirect to /login if no token */}
            <Route path="/dashboard"
              element={<ProtectedRoute><DashboardIndex /></ProtectedRoute>} />
            <Route path="/dashboard/settings"
              element={<ProtectedRoute><Settings /></ProtectedRoute>} />

            {/* Catch-all */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </AuthProvider>
  )
}
