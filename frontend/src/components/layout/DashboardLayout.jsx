import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import Footer from './Footer'
import SkipLink from './SkipLink'
import { cn } from '../../lib/utils'
import Alert from '../ui/Alert'
import { useAuth } from '../../hooks/useAuth'
import useSignOut from '../../hooks/useSignOut'
import { useNeedsDecisionCount } from '../../lib/needsDecision'
import { consumeFlash, peekFlash, flashMessage } from '../../lib/flash'

// The signed-in area has its own header: the logo, the dashboard's tabs, and sign out. The marketing links
// (Stories, Hot categories, Pricing, For employers) belong to the public site, so they are not repeated here.
// `badge` marks the tab that carries the "waiting for you" count.
const tabs = [
  { label: 'Scans',    to: '/dashboard', badge: true },
  // Verified links in one place: the credential is the product, so it gets its own tab.
  { label: 'Proof',    to: '/dashboard/proof' },
  // Stories the person shared about how it went: read, edit, take down.
  { label: 'My Story', to: '/dashboard/story' },
  // FEATURE GAP CLOSED (Payments & Pricing re-audit): the only other way to
  // reach payment history was a hand-typed URL — this array is the single, generic route to every
  // dashboard sub-page (see the Settings audit-fix comment below), so a new page just slots in the same way.
  { label: 'Payments', to: '/dashboard/payments' },
  { label: 'Settings', to: '/dashboard/settings' },
]

// Active on the tab's own page and anything nested under it ('/dashboard' itself only matches exactly,
// since every other tab lives beneath it).
function isActive(pathname, to) {
  const path = (pathname.replace(/\/+$/, '') || '/').toLowerCase()   // the router matches case-insensitively, so must this
  return path === to || (to !== '/dashboard' && path.startsWith(`${to}/`))
}

export default function DashboardLayout({ children }) {
  const { pathname } = useLocation()
  const { user } = useAuth()
  const handleLogout = useSignOut()
  const waiting = useNeedsDecisionCount(user?.id)
  // A one-shot notice left by a redirect (a non-admin bounced off /admin): read on first render, cleared
  // by the effect below so it shows once (read-then-clear is split because a render-phase consume is not
  // StrictMode-safe — see peekFlash).
  const [notice] = useState(() => flashMessage(peekFlash()))
  useEffect(() => { consumeFlash() }, [])

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <SkipLink />
        {/* AUDIT FIX (Section 6): the tab strip is the only route to /dashboard/settings anywhere in the app, so it
            must never be hidden. One row from sm upward (logo, tabs, sign out); on a phone the tabs drop to their
            own row and scroll sideways rather than wrap. */}
        <div className="max-w-5xl mx-auto px-4 flex flex-wrap items-center gap-x-4 sm:flex-nowrap">
          <Link to="/" className="order-1 h-14 flex items-center font-bold text-blue-700 text-lg tracking-tight shrink-0">
            Passthrough
          </Link>
          <nav aria-label="Dashboard" className="order-3 w-full sm:order-2 sm:w-auto sm:flex-1 min-w-0 flex gap-0.5 overflow-x-auto pb-2 sm:pb-0">
            {tabs.map(item => {
              const current = isActive(pathname, item.to)
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  aria-current={current ? 'page' : undefined}
                  className={cn(
                    'px-3 py-1.5 rounded-md text-sm font-semibold transition-colors whitespace-nowrap shrink-0',
                    current ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-100'
                  )}
                >
                  {item.label}
                  {item.badge && waiting > 0 && (
                    <span className="ml-1.5 rounded-full bg-blue-700 px-1.5 py-px text-[11px] font-bold text-white">
                      {waiting}<span className="sr-only"> waiting for your decision</span>
                    </span>
                  )}
                </Link>
              )
            })}
          </nav>
          <div className="order-2 sm:order-3 ml-auto flex items-center gap-4 text-sm">
            {/* The admin page had no link anywhere — admins had to type the URL. */}
            {user?.role === 'ADMIN' && (
              <Link to="/admin" className="text-gray-600 hover:text-gray-900 transition-colors">Admin</Link>
            )}
            <button type="button" onClick={handleLogout} className="py-4 text-gray-600 hover:text-gray-900 transition-colors">
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main id="main" className="max-w-5xl mx-auto w-full px-4 py-8 flex-1 min-w-0">
        {notice && <Alert variant="warning" className="mb-4">{notice}</Alert>}
        {children}
      </main>
      <Footer />
    </div>
  )
}
