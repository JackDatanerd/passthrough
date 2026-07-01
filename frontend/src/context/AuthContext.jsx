import { createContext, useState } from 'react'
import api from '../lib/api'

// PATCH 3: exported so hooks/useAuth.js can import it directly
export const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('passthrough_user')) }
    catch (_) { return null }
  })

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
    <AuthContext.Provider value={{ user, setUser, postRegisterActions, logout }}>
      {children}
    </AuthContext.Provider>
  )
}
