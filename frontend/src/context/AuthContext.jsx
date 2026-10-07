import { createContext, useState, useEffect } from 'react'
import api, { SESSION_ENDED_EVENT } from '../lib/api'
import { signedOutElsewhereTarget } from '../lib/session'
import { getAnonScanTokens, removeAnonScanToken } from '../lib/anonScans'
import { getToken, setToken, getCachedUser, setCachedUser, storageRemove } from '../lib/storage'
import { TOKEN_KEY, USER_KEY } from '../lib/session'

// PATCH 3: exported so hooks/useAuth.js can import it directly
export const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  // All storage access goes through lib/storage.js: a browser with storage blocked used to
  // throw right here, in the first render, and white-screen the whole app.
  const [user, setUser] = useState(() => getCachedUser())

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
  const [authLoading, setAuthLoading] = useState(() => !!getToken())

  // `user` was previously populated once at login/register and cached in
  // localStorage — nothing ever re-synced it with the server afterward. Any
  // change made server-side (e.g. verifying email via a link opened on a
  // different device/session) would never be reflected here until the user
  // explicitly logged out and back in, no matter how many times they
  // reloaded the page or re-visited the dashboard.
  //
  // AUDIT FIX (Auth round 2, B3): every tab runs this on load, and a token
  // issued before server-side sessions existed is upgraded to a session-bound
  // one by /auth/me — so N tabs opening together each minted their OWN session
  // from the same legacy token, and all but the last stored one became ghost
  // devices. Serialising across tabs (Web Locks) makes the second tab read the
  // token the first one already upgraded, so it asks with a session-bound token
  // and gets no new session. Falls back to running directly where Web Locks
  // isn't available.
  async function refreshUser() {
    if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
      try { return await navigator.locks.request('passthrough-auth-refresh', () => refreshUserUnlocked()) }
      catch (_) { return refreshUserUnlocked() }
    }
    return refreshUserUnlocked()
  }

  async function refreshUserUnlocked() {
    // AUDIT FIX (Auth/Scan round): an /auth/me still in flight when the person
    // clicked Sign out (or another tab signed in as someone else) used to
    // resolve afterwards and write its user — and any renewed token — back
    // into storage, silently resurrecting the session that had just ended.
    // The response only counts if the session it was requested under is
    // still the current one.
    const tokenAtStart = getToken()
    try {
      const res = await api.get('/auth/me')
      if (getToken() !== tokenAtStart) return null
      const fresh = res.data.data.user
      // AUDIT FIX (feature gap): getMe() now silently reissues a token when
      // the current one is within 24h of expiring (see auth.controller.js).
      // refreshUser() already runs on every app load and dashboard visit,
      // so picking this up here is what turns that server-side renewal into
      // an actual sliding session — without it, the server could mint fresh
      // tokens all day and the client would keep using the old one until it
      // hard-expired anyway.
      const renewedToken = res.data.data.token
      if (renewedToken) setToken(renewedToken)
      setCachedUser(fresh)
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
    if (getToken()) refreshUser().finally(() => setAuthLoading(false))
    else setAuthLoading(false)
  }, [])

  // The API client ends the session (expired / banned) WITHOUT a page reload on
  // public pages — drop the in-memory user so the UI flips to logged-out.
  useEffect(() => {
    const onEnded = () => { setUser(null); setAuthLoading(false) }
    window.addEventListener(SESSION_ENDED_EVENT, onEnded)
    return () => window.removeEventListener(SESSION_ENDED_EVENT, onEnded)
  }, [])

  // Keep every open tab consistent: signing out (or in) in one tab used to
  // leave the others showing a logged-in UI until they were reloaded.
  useEffect(() => {
    function onStorage(e) {
      // e.key === null is localStorage.clear() in another tab.
      if ((e.key === TOKEN_KEY && !e.newValue) || e.key === null) {
        setUser(null)
        // Another tab signed out. A tab sitting on a page that needs a session must follow:
        // AuthProvider lives outside the router, so a hard replace is the way. Re-check the
        // token first — a sign-out immediately followed by a sign-in elsewhere (token removed,
        // then set again) must not bounce this tab.
        if (!getToken()) {
          const to = signedOutElsewhereTarget(window.location.pathname, window.location.search)
          if (to) window.location.replace(to)
        }
      }
      if (e.key === USER_KEY) {
        try { setUser(e.newValue ? JSON.parse(e.newValue) : null) } catch (_) {}
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // Shared by register AND login: stores the session, then claims any pending
  // anonymous scans. Login used to skip the claim, so a returning user who
  // scanned anonymously and then signed in was left holding a scan they could
  // never pay for (initializePayment requires scan.userId === user.id).
  async function postAuthActions(token, newUser) {
    setToken(token)
    setCachedUser(newUser)
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
    for (const { scanId, token: anonToken } of anonEntries) {
      try {
        const res = await api.post('/auth/claim-scan', { anonToken })
        lastClaimedScanId = res.data.data.scanId
        removeAnonScanToken(scanId)
      } catch (err) {
        // 400/404 = expired / already claimed / not found: this token is dead,
        // drop it. Anything else (network blip, 5xx) may be transient — KEEP it
        // for a later attempt. (Clearing everything unconditionally lost
        // recoverable scans whenever one claim hit a transient error.)
        const status = err.response?.status
        if (status === 400 || status === 404) removeAnonScanToken(scanId)
      }
    }
    return lastClaimedScanId  // caller should navigate to /scan/:id, or /dashboard if null
  }

  // FEATURE GAP CLOSED (Auth round 2): records acceptance of the CURRENT Terms /
  // Privacy version (see TermsUpdateBanner) and swaps in the user the server
  // answers with, whose `termsCurrent` is now true.
  async function acceptTerms() {
    const res = await api.post('/auth/accept-terms')
    const fresh = res.data.data.user
    setCachedUser(fresh)
    setUser(fresh)
    return fresh
  }

  // AUDIT FIX (Auth section round 1, feature gap G2): this used to only clear
  // the browser's own copy of the token — a copied/stolen token, or another
  // tab that still held the old one, stayed valid for its full lifetime.
  // POST /auth/logout (migration 0047) revokes the server-side session the
  // token is bound to, so it stops working everywhere the instant this
  // returns. The local state is cleared immediately either way — the UI
  // shouldn't wait on a network round trip to look signed out, and a token
  // issued before sessions existed has nothing server-side to revoke anyway
  // (the endpoint just answers success for it).
  function logout() {
    // api.js's request interceptor reads the token from localStorage at
    // request time — it has to be sent explicitly here, BEFORE it's cleared
    // below, or this call would go out with no Authorization header at all.
    const token = getToken()
    storageRemove(TOKEN_KEY)
    storageRemove(USER_KEY)
    setUser(null)
    if (!token) return Promise.resolve()
    // Best-effort, and it never rejects. Returned so a caller that is about to leave the page
    // with a hard navigation can wait for the request to go out first (an unload can cancel an
    // in-flight XHR, leaving the session alive on the server). Everyone else ignores it.
    return api.post('/auth/logout', null, { headers: { Authorization: `Bearer ${token}` } }).then(() => {}, () => {})
  }

  return (
    <AuthContext.Provider value={{ user, setUser, postAuthActions, postRegisterActions: postAuthActions, logout, refreshUser, acceptTerms, authLoading }}>
      {children}
    </AuthContext.Provider>
  )
}
