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
      <div className="max-w-5xl mx-auto w-full px-4 py-8 flex-1 flex gap-8">
        <aside className="hidden sm:block w-44 shrink-0">
          <nav className="flex flex-col gap-1">
            {nav.map(item => (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  'px-3 py-2 rounded-md text-sm font-medium transition-colors',
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
