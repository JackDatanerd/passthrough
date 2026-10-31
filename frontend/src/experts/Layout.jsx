import { useEffect } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useSession, mayShow } from './session'

export function Page({ title, children, wide }) {
  return (
    <main className={`mx-auto px-4 py-6 ${wide ? 'max-w-6xl' : 'max-w-xl'}`}>
      {title && <h1 className="serif text-2xl mb-4">{title}</h1>}
      {children}
    </main>
  )
}

// A11: the tab title says where you are, and a screen reader is told when the screen changes (the page never reloads, so neither happens by itself)
const TITLES = [[/^\/sign-in/, 'Sign in'], [/^\/two-factor/, 'Two-factor code'], [/^\/recovery-codes/, 'Recovery codes'], [/^\/forgot-password/, 'Forgot your password'], [/^\/reset-password/, 'Reset your password'],
  [/^\/desk/, 'Desk'], [/^\/settings/, 'Settings'], [/^\/admin\/jobs/, 'Job'], [/^\/admin\/experts/, 'Experts'], [/^\/admin\/audit/, 'Audit log'], [/^\/admin/, 'Job board']]
export const routeTitle = pathname => { const hit = TITLES.find(([re]) => re.test(pathname)); return hit ? `${hit[1]} \u2014 Passthrough Experts` : 'Passthrough Experts' }

export function Shell({ children }) {
  const { pathname } = useLocation(); const title = routeTitle(pathname)
  useEffect(() => { document.title = title }, [title])
  const { me, signOut } = useSession(); const nav = useNavigate(); const roles = me ? me.roles : []
  const link = ({ isActive }) => `px-3 py-2 text-sm ${isActive ? 'underline' : 'opacity-90 hover:opacity-100'}`
  return (
    <div className="xp">
      <header className="nav">
        <div className="mx-auto max-w-6xl px-4 flex items-center gap-2 flex-wrap">
          <Link to="/" className="serif py-3 mr-3 text-lg" style={{ color: 'inherit' }}>Passthrough Experts</Link>
          {me && mayShow(roles, 'desk') && <NavLink to="/desk" className={link} style={{ color: 'inherit' }}>Desk</NavLink>}
          {me && mayShow(roles, 'board') && <NavLink to="/admin" end className={link} style={{ color: 'inherit' }}>Job board</NavLink>}
          {me && mayShow(roles, 'directory') && <NavLink to="/admin/experts" className={link} style={{ color: 'inherit' }}>Experts</NavLink>}
          {me && mayShow(roles, 'audit') && <NavLink to="/admin/audit" className={link} style={{ color: 'inherit' }}>Audit log</NavLink>}
          <span className="flex-1" />
          {me && <NavLink to="/settings" className={link} style={{ color: 'inherit' }}>Settings</NavLink>}
          {me && <button type="button" className="px-3 py-2 text-sm" onClick={async () => { await signOut(); nav('/sign-in') }}>Sign out</button>}
        </div>
      </header>
      <div role="status" aria-live="polite" className="sr-only" data-testid="route-announcer">{title}</div>
      {children}
    </div>
  )
}
