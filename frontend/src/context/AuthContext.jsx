import { createContext, useState, useEffect } from 'react'
import api from '../lib/api'

// PATCH 3: exported so hooks/useAuth.js can import it directly
export const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('passthrough_user')) }
    catch (_) { return null }
  })

  // `user` was previously populated once at login/register and cached in
  // localStorage — nothing ever re-synced it with the server afterward. Any
  // change made server-side (e.g. verifying email via a link opened on a
  // different device/session) would never be reflected here until the user
  // explicitly logged out and back in, no matter how many times they
  // reloaded the page or re-visited the dashboard.
  async function refreshUser() {
    try {
      const res = await api.get('/auth/me')
      const fresh = res.data.data.user
      localStorage.setItem('passthrough_user', JSON.stringify(fresh))
      setUser(fresh)
      return fresh
    } catch (_) {
      // Token invalid/expired — leave existing state as-is; normal
      // 401-handling elsewhere (api.js response interceptor) covers logout.
      return null
    }
  }

  // Refresh once on app load if a token exists, so the very first render
  // after opening/reloading the app reflects current server state rather
  // than whatever was cached at the last login.
  useEffect(() => {
    if (localStorage.getItem('passthrough_token')) refreshUser()
  }, [])

  async function postRegisterActions(token, newUser) {
    localStorage.setItem('passthrough_token', token)
    localStorage.setItem('passthrough_user', JSON.stringify(newUser))
    setUser(newUser)

    // Check for pending anonymous scan to claim
    const anonToken = localStorage.getItem('passthrough_anon_token')
    if (anonToken) {
      try {
        const res = await api.post('/auth/claim-scan', { anonToken })
        localStorage.removeItem('passthrough_anon_token')
        return res.data.data.scanId  // caller should navigate to /scan/:id
      } catch (_) {
        localStorage.removeItem('passthrough_anon_token')
      }
    }
    return null  // caller should navigate to /dashboard
  }

  function logout() {
    localStorage.removeItem('passthrough_token')
    localStorage.removeItem('passthrough_user')
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, setUser, postRegisterActions, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  )
}
