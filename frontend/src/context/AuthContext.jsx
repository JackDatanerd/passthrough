import { createContext, useState, useEffect } from 'react'
import api from '../lib/api'
import { getAnonScanTokens, clearAnonScanTokens } from '../lib/anonScans'

// PATCH 3: exported so hooks/useAuth.js can import it directly
export const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('passthrough_user')) }
    catch (_) { return null }
  })

  // AUDIT FIX (Admin panel): exposed so route guards (see AdminRoute in
  // App.jsx) can tell "we don't know yet" apart from "there's no user".
  // Previously AdminRoute treated a null/not-yet-loaded `user` as "not
  // gated" and rendered the admin page's shell immediately — a real,
  // if narrow, gap: clear localStorage's cached user (or load the app for
  // the first time with only a token present) and a non-admin briefly saw
  // admin page chrome before refreshUser() resolved and redirected them
  // away. The actual data was always safe (adminOnly.js re-checks role from
  // the DB on every request), but the UI shouldn't render as if a role is
  // known when it isn't yet.
  const [authLoading, setAuthLoading] = useState(() => !!localStorage.getItem('passthrough_token'))

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
      // AUDIT FIX (feature gap): getMe() now silently reissues a token when
      // the current one is within 24h of expiring (see auth.controller.js).
      // refreshUser() already runs on every app load and dashboard visit,
      // so picking this up here is what turns that server-side renewal into
      // an actual sliding session — without it, the server could mint fresh
      // tokens all day and the client would keep using the old one until it
      // hard-expired anyway.
      const renewedToken = res.data.data.token
      if (renewedToken) localStorage.setItem('passthrough_token', renewedToken)
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
    if (localStorage.getItem('passthrough_token')) refreshUser().finally(() => setAuthLoading(false))
    else setAuthLoading(false)
  }, [])

  async function postRegisterActions(token, newUser) {
    localStorage.setItem('passthrough_token', token)
    localStorage.setItem('passthrough_user', JSON.stringify(newUser))
    setUser(newUser)

    // AUDIT FIX (feature gap): this used to read a single stored anon token
    // and claim just that one — an anonymous visitor who scanned more than
    // once before registering (anonScan's rate limit allows 1/hour, so a
    // full day gives up to ~24) could only ever recover the LAST scan; every
    // earlier one silently aged out at its 24h TTL, unclaimed, with no way
    // for the user to know they'd lost it. Now claims every tracked token
    // (see anonScans.js), sequentially so a failed/expired one doesn't stop
    // the rest, and still returns the LAST one's scanId for navigation —
    // same "go straight to your most recent scan" behavior as before.
    const anonEntries = getAnonScanTokens()
    let lastClaimedScanId = null
    for (const { token: anonToken } of anonEntries) {
      try {
        const res = await api.post('/auth/claim-scan', { anonToken })
        lastClaimedScanId = res.data.data.scanId
      } catch (_) {
        // Expired/already-claimed/not-found — drop this one and keep going
        // with the rest, same as the original single-token behavior did.
      }
    }
    clearAnonScanTokens()
    return lastClaimedScanId  // caller should navigate to /scan/:id, or /dashboard if null
  }

  function logout() {
    localStorage.removeItem('passthrough_token')
    localStorage.removeItem('passthrough_user')
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, setUser, postRegisterActions, logout, refreshUser, authLoading }}>
      {children}
    </AuthContext.Provider>
  )
}
