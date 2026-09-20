import { Link, useLocation } from 'react-router-dom'
import Navbar from './Navbar'
import Footer from './Footer'
import { cn } from '../../lib/utils'

const nav = [
  { label: 'Scans',    to: '/dashboard' },
  { label: 'Settings', to: '/dashboard/settings' },
]

export default function DashboardLayout({ children }) {
  const { pathname } = useLocation()

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
          <nav className="flex sm:flex-col gap-1 overflow-x-auto sm:overflow-visible pb-2 sm:pb-0 -mx-1 px-1 sm:mx-0 sm:px-0">
            {nav.map(item => (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  'px-3 py-2 rounded-md text-sm font-medium transition-colors whitespace-nowrap shrink-0',
                  pathname === item.to
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-gray-600 hover:bg-gray-100'
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </aside>
        <main className="flex-1 min-w-0">{children}</main>
      </div>
      <Footer />
    </div>
  )
}
