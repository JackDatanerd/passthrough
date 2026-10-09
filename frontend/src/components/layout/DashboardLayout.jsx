import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import Navbar from './Navbar'
import Footer from './Footer'
import { cn } from '../../lib/utils'
import Alert from '../ui/Alert'
import { consumeFlash, peekFlash, flashMessage } from '../../lib/flash'

const nav = [
  { label: 'Scans',    to: '/dashboard' },
  // FEATURE GAP CLOSED (Payments & Pricing re-audit): the only other way to
  // reach payment history was a hand-typed URL — this nav array was already
  // the single, generic route to every dashboard sub-page (see the Settings
  // audit-fix comment below), so the new page just slots in the same way.
  { label: 'Payments', to: '/dashboard/payments' },
  { label: 'Settings', to: '/dashboard/settings' },
]

// Active on the tab's own page and anything nested under it ('/dashboard' itself only matches exactly,
// since every other tab lives beneath it).
function isActive(pathname, to) {
  const path = pathname.replace(/\/+$/, '') || '/'
  return path === to || (to !== '/dashboard' && path.startsWith(`${to}/`))
}

export default function DashboardLayout({ children }) {
  const { pathname } = useLocation()
  // A one-shot notice left by a redirect (a non-admin bounced off /admin): read on first render, cleared
  // by the effect below so it shows once (read-then-clear is split because a render-phase consume is not
  // StrictMode-safe — see peekFlash).
  const [notice] = useState(() => flashMessage(peekFlash()))
  useEffect(() => { consumeFlash() }, [])

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <Navbar />
      {/* AUDIT FIX (Section 6): this nav — the only route to /dashboard/settings
          anywhere in the app — was `hidden sm:block`, and Navbar never links to
          Settings either. Below the sm breakpoint there was no UI path to
          Settings at all, only a manually-typed URL. Now rendered unconditionally
          as a horizontal, scrollable tab strip above the content on narrow
          screens, and as the original vertical sidebar from sm upward. */}
      <div className="max-w-5xl mx-auto w-full px-4 py-8 flex-1 flex flex-col sm:flex-row gap-4 sm:gap-8">
        <aside className="w-full sm:w-44 sm:shrink-0">
          <nav aria-label="Dashboard" className="flex sm:flex-col gap-1 overflow-x-auto sm:overflow-visible pb-2 sm:pb-0 -mx-1 px-1 sm:mx-0 sm:px-0">
            {nav.map(item => (
              <Link
                key={item.to}
                to={item.to}
                aria-current={isActive(pathname, item.to) ? 'page' : undefined}
                className={cn(
                  'px-3 py-2 rounded-md text-sm font-medium transition-colors whitespace-nowrap shrink-0',
                  isActive(pathname, item.to)
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-gray-600 hover:bg-gray-100'
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </aside>
        <main className="flex-1 min-w-0">
          {notice && <Alert variant="warning" className="mb-4">{notice}</Alert>}
          {children}
        </main>
      </div>
      <Footer />
    </div>
  )
}
