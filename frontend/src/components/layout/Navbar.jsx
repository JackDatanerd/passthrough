import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'

// Moves keyboard focus past the nav into the page's <main> (every page that renders this Navbar
// has one). Without it a keyboard user tabs through the nav links on every single page.
function skipToMain(e) {
  const main = document.querySelector('main')
  if (!main) return
  e.preventDefault()
  if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1')
  main.focus()
  main.scrollIntoView?.()
}

export default function Navbar() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const { pathname, hash } = useLocation()
  // Phones hide "Pricing" (signed in) and "For employers" (everyone) to keep the row on one line;
  // this menu is how they are reached without scrolling to the footer.
  const [menuOpen, setMenuOpen] = useState(false)
  useEffect(() => { setMenuOpen(false) }, [pathname, hash])
  useEffect(() => {
    if (!menuOpen) return undefined
    const onKey = e => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [menuOpen])

  function handleLogout() {
    logout()
    navigate('/')
  }

  return (
    <nav aria-label="Main" className="bg-white border-b border-gray-200">
      <a
        href="#main"
        onClick={skipToMain}
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-[70] focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-blue-700 focus:shadow-lg focus:ring-2 focus:ring-blue-500"
      >
        Skip to content
      </a>
      <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
        <Link to="/" className="font-bold text-blue-700 text-lg tracking-tight">
          Passthrough
        </Link>
        <div className="flex items-center gap-2 sm:gap-4 text-xs sm:text-sm">
          <button
            type="button"
            onClick={() => setMenuOpen(o => !o)}
            aria-expanded={menuOpen}
            aria-controls="navbar-more"
            className="sm:hidden text-gray-600 hover:text-gray-900 transition-colors"
          >
            {menuOpen ? 'Close' : 'More'}
          </button>
          {/* Hidden for logged-in users on narrow screens — least essential
              item once someone already has an account (still reachable via
              the footer), and without it this row was right at the edge of
              overflowing a 375px viewport alongside Dashboard/Sign out. */}
          <Link to="/pricing" className={`text-gray-600 hover:text-gray-900 transition-colors ${user ? 'hidden sm:block' : ''}`}>
            Pricing
          </Link>
          {/* Anchor into the employer section on the homepage */}
          <Link to="/#employers" className="text-gray-600 hover:text-gray-900 transition-colors hidden sm:block">
            For employers
          </Link>
          {/* Employers' first need is to check a resume they were sent — the homepage's verification section
              leads with it, so it is one click from every page. */}
          <Link to="/check" className="text-gray-600 hover:text-gray-900 transition-colors hidden md:block">
            Check a resume
          </Link>
          {user ? (
            <>
              <Link to="/dashboard" className="text-gray-600 hover:text-gray-900 transition-colors">
                Dashboard
              </Link>
              {/* The admin page had no link anywhere — admins had to type the URL. */}
              {user.role === 'ADMIN' && (
                <Link to="/admin" className="text-gray-600 hover:text-gray-900 transition-colors">
                  Admin
                </Link>
              )}
              <button
                type="button"
                onClick={handleLogout}
                className="text-gray-600 hover:text-gray-900 transition-colors"
              >
                Sign out
              </button>
            </>
          ) : (
            <>
              <Link to="/login" className="text-gray-600 hover:text-gray-900 transition-colors">
                Sign in
              </Link>
              <Link
                to="/register"
                className="bg-blue-700 text-white px-3 py-1.5 rounded-md hover:bg-blue-800 transition-colors"
              >
                Get started
              </Link>
            </>
          )}
        </div>
      </div>
      {menuOpen && (
        <div id="navbar-more" className="sm:hidden border-t border-gray-100 px-4 py-2 flex flex-col text-sm">
          <Link to="/pricing" className="py-2 text-gray-700 hover:text-gray-900">Pricing</Link>
          <Link to="/#employers" className="py-2 text-gray-700 hover:text-gray-900">For employers</Link>
          <Link to="/check" className="py-2 text-gray-700 hover:text-gray-900">Check a resume</Link>
        </div>
      )}
    </nav>
  )
}
