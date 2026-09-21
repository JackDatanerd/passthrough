import axios from 'axios'

// Dev: Vite proxy handles /api → localhost:4000
// Prod: VITE_API_URL=https://api.passthrough.dev (Cloudflare Pages env)
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api'
})

api.interceptors.request.use(config => {
  const token = localStorage.getItem('passthrough_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// AUDIT FIX: this used to treat ANY 401 as "your session died", including
// the plain business-logic 401 auth/login itself returns for a wrong
// password ({ success:false, message:'Invalid credentials' }, no code).
// That meant mistyping a password on the login page raced its own error
// message against this interceptor's window.location.href — the redirect
// usually won, wiping any token and showing a false "Your session expired,
// please sign in again" instead of "Invalid credentials", on literally the
// most common login-page interaction there is. auth/login and auth/register
// never have a real session to invalidate in the first place, so their 401s
// (and any other 4xx) are left alone here for the calling page's own catch
// block to handle and display.
const AUTH_ENDPOINTS_WITHOUT_SESSION = ['/auth/login', '/auth/register']

api.interceptors.response.use(
  res => res,
  err => {
    const code   = err.response?.data?.code
    const status = err.response?.status
    const url    = err.config?.url || ''
    const isAuthEntry = AUTH_ENDPOINTS_WITHOUT_SESSION.some(p => url.includes(p))

    if (!isAuthEntry && (status === 401 || code === 'SESSION_INVALID' || code === 'TOKEN_EXPIRED')) {
      localStorage.removeItem('passthrough_token')
      localStorage.removeItem('passthrough_user')
      window.location.href = '/login?expired=true'
    }
    if (!isAuthEntry && code === 'BANNED') {
      localStorage.removeItem('passthrough_token')
      localStorage.removeItem('passthrough_user')
      window.location.href = '/login?banned=true'
    }
    // AUDIT FIX (Admin panel): a 403 from an admin-gated endpoint (server-
    // side role check failed — see middleware/adminOnly.js) previously had
    // no handling here at all. A non-admin who reached an /admin/* route —
    // even just during AuthContext's refresh race — got a generic "failed
    // to load" toast and stayed parked on the admin URL with nothing to
    // load, instead of being sent somewhere useful. Scoped to /admin paths
    // only: a 403 elsewhere (e.g. a partner-token endpoint rejecting a bad
    // token) means something different and shouldn't redirect the page.
    if (status === 403 && window.location.pathname.startsWith('/admin')) {
      window.location.href = '/dashboard'
    }
    return Promise.reject(err)
  }
)

export default api
