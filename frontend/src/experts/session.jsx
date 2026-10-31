// Who is signed in, from the server only. The page keeps the sign-in STAGE in memory while the person is mid-way (password done, second factor
// to do); the credential itself is the HttpOnly cookie, which this code cannot see.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { realm, onSessionEnded } from './api'

const Ctx = createContext(null)
export const useSession = () => useContext(Ctx)

// Mirrors the server's matrix for what to SHOW. The server decides what is allowed; this only hides links that would be refused.
export const SHOW = { desk: ['expert', 'grader'], board: ['expert_admin', 'expert_support'], directory: ['expert_admin'], audit: ['expert_admin'] }
export const mayShow = (roles, area) => (roles || []).some(r => SHOW[area].includes(r))

// How long a tab may sit hidden before coming back to it asks the server whether the session is still good (the server also changes roles and ends sessions).
const RECHECK_MS = 60_000

export function SessionProvider({ children }) {
  const [state, setState] = useState({ status: 'loading', me: null, stage: null, setup: null, ended: false })
  const setupRef = useRef(null); const lastCheck = useRef(Date.now())
  const refresh = useCallback(async () => {
    try { const me = await realm.me(); lastCheck.current = Date.now(); setState(() => ({ status: 'in', me, stage: null, setup: null, ended: false })); return me }
    catch (_) { setState(s => ({ ...s, status: 'out', me: null })); return null }
  }, [])
  useEffect(() => { refresh() }, [refresh])

  // A11: the server ended the session: go back to sign-in and say why (only if the person was signed in or part-way in)
  useEffect(() => onSessionEnded(() => { setupRef.current = null; setState(s => (s.status === 'in' || s.stage ? { status: 'out', me: null, stage: null, setup: null, ended: true } : s)) }), [])
  // ...and notice it on coming back to the tab, rather than at the next click
  useEffect(() => {
    const back = () => {
      if (document.hidden || Date.now() - lastCheck.current < RECHECK_MS) return
      lastCheck.current = Date.now()
      realm.me().then(me => setState(s => (s.status === 'in' ? { ...s, me } : s))).catch(() => { /* a 401 is handled by the interceptor; anything else is tried again later */ })
    }
    document.addEventListener('visibilitychange', back); return () => document.removeEventListener('visibilitychange', back)
  }, [])

  // A11: ONE setup key per enrolment. The server replaces the unconfirmed key every time it is asked, so asking again (the screen mounting twice, or the
  // person leaving and coming back) would invalidate the key already in their authenticator app. The key (and the pending request) live here.
  const ensureSetup = useCallback(() => {
    if (!setupRef.current) setupRef.current = realm.totpSetup().then(setup => { setState(s => ({ ...s, setup })); return setup }).catch(err => { setupRef.current = null; throw err })
    return setupRef.current
  }, [])
  const value = useMemo(() => ({ ...state, refresh, ensureSetup,
    setStage: stage => { setupRef.current = null; setState(s => ({ ...s, stage, setup: null, ended: false })) },
    signOut: async () => { try { await realm.logout() } finally { setupRef.current = null; setState({ status: 'out', me: null, stage: null, setup: null, ended: false }) } } }), [state, refresh, ensureSetup])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
