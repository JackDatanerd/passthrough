// Who is signed in, from the server only. The page keeps the sign-in STAGE in memory while the person is mid-way (password done, second factor
// to do); the credential itself is the HttpOnly cookie, which this code cannot see.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { realm } from './api'

const Ctx = createContext(null)
export const useSession = () => useContext(Ctx)

// Mirrors the server's matrix for what to SHOW. The server decides what is allowed; this only hides links that would be refused.
export const SHOW = { desk: ['expert', 'grader'], board: ['expert_admin', 'expert_support'], directory: ['expert_admin'], audit: ['expert_admin'] }
export const mayShow = (roles, area) => (roles || []).some(r => SHOW[area].includes(r))

export function SessionProvider({ children }) {
  const [state, setState] = useState({ status: 'loading', me: null, stage: null })
  const refresh = useCallback(async () => {
    try { const me = await realm.me(); setState(s => ({ status: 'in', me, stage: null })); return me }
    catch (_) { setState(s => ({ status: 'out', me: null, stage: s.stage })); return null }
  }, [])
  useEffect(() => { refresh() }, [refresh])
  const value = useMemo(() => ({ ...state, refresh,
    setStage: stage => setState(s => ({ ...s, stage })),
    signOut: async () => { try { await realm.logout() } finally { setState({ status: 'out', me: null, stage: null }) } } }), [state, refresh])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
