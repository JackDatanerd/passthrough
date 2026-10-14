import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import useSignOut from '../../hooks/useSignOut'

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

// The page a top-level link points at, for assistive tech. Hash links (/#stories) never count: the page is Home either way.
const here = (pathname, to) => (pathname === to || pathname.startsWith(`${to}/`) ? 'page' : undefined)

export default function Navbar() {
  const { user } = useAuth()
  const handleLogout = useSignOut()
  const { pathname, hash } = useLocation()
  // Phones hide "Pricing" (signed in) and "For employers" (everyone) to keep the row on one line;
  // this menu is how they are reached without scrolling to the footer.
  const [menuOpen, setMenuOpen] = useState(false)
  useEffect(() => { setMenuOpen(false) }, [pathname, hash])
  const moreBtn = useRef(null)
  const navRef = useRef(null)
  useEffect(() => {
    if (!menuOpen) return undefined
    // Escape closes the menu AND hands focus back to the button that opened it (the menu — and the focused link in
    // it — disappears, which would otherwise drop a keyboard user on <body>); a press or tap outside closes it too.
    const onKey = e => { if (e.key === 'Escape') { setMenuOpen(false); moreBtn.current?.focus() } }
    const onPointer = e => { if (navRef.current && !navRef.current.contains(e.target)) setMenuOpen(false) }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onPointer) }
  }, [menuOpen])

  return (
    <nav ref={navRef} aria-label="Main" className="bg-white border-b border-gray-200">
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
        <div className="flex items-center gap-3 sm:gap-4 text-[13px] sm:text-sm whitespace-nowrap">
          <button
            ref={moreBtn}
            type="button"
            onClick={() => setMenuOpen(o => !o)}
            aria-expanded={menuOpen}
            aria-controls="navbar-more"
            className="sm:hidden py-3 text-gray-600 hover:text-gray-900 transition-colors"
          >
            {menuOpen ? 'Close' : 'More'}
          </button>
          {/* The links follow the order of the homepage itself (stories, hot fields, pricing, employers). The two
              proof anchors only show from md up; a logged-in user on a narrow screen loses Pricing too, which is
              still in the footer — without that this row was at the edge of overflowing a 375px viewport. */}
          <Link to="/#stories" className="text-gray-600 hover:text-gray-900 transition-colors hidden md:block">
            Stories
          </Link>
          <Link to="/#hot" className="text-gray-600 hover:text-gray-900 transition-colors hidden md:block">
            Hot categories
          </Link>
          <Link to="/pricing" aria-current={here(pathname, '/pricing')} className="text-gray-600 hover:text-gray-900 transition-colors hidden sm:block">
            Pricing
          </Link>
          {/* Anchor into the employer section on the homepage */}
          <Link to="/#employers" className="text-gray-600 hover:text-gray-900 transition-colors hidden sm:block">
            For employers
          </Link>
          {user ? (
            <>
              <Link to="/dashboard" aria-current={here(pathname, '/dashboard')} className="py-3 sm:py-0 text-gray-600 hover:text-gray-900 transition-colors">
                Dashboard
              </Link>
              {/* The admin page had no link anywhere — admins had to type the URL. */}
              {user.role === 'ADMIN' && (
                <Link to="/admin" aria-current={here(pathname, '/admin')} className="text-gray-600 hover:text-gray-900 transition-colors">
                  Admin
                </Link>
              )}
              <button
                type="button"
                onClick={handleLogout}
                className="py-3 sm:py-0 text-gray-600 hover:text-gray-900 transition-colors"
              >
                Sign out
              </button>
            </>
          ) : (
            <>
              {/* Below 340px there is no room for it next to the button; it moves into "More" (see below). */}
              <Link to="/login" className="py-3 text-gray-600 hover:text-gray-900 transition-colors hidden min-[340px]:block">
                Sign in
              </Link>
              <Link
                to="/register"
                className="bg-blue-700 text-white px-3 py-2 sm:py-1.5 rounded-md hover:bg-blue-800 transition-colors"
              >
                Get started
              </Link>
            </>
          )}
        </div>
      </div>
      {menuOpen && (
        <div id="navbar-more" className="sm:hidden border-t border-gray-100 px-4 py-2 flex flex-col text-sm">
          <Link to="/#stories" onClick={() => setMenuOpen(false)} className="py-2 text-gray-700 hover:text-gray-900">Stories</Link>
          <Link to="/#hot" onClick={() => setMenuOpen(false)} className="py-2 text-gray-700 hover:text-gray-900">Hot categories</Link>
          <Link to="/pricing" aria-current={here(pathname, '/pricing')} onClick={() => setMenuOpen(false)} className="py-2 text-gray-700 hover:text-gray-900">Pricing</Link>
          <Link to="/#employers" onClick={() => setMenuOpen(false)} className="py-2 text-gray-700 hover:text-gray-900">For employers</Link>
          {!user && <Link to="/login" onClick={() => setMenuOpen(false)} className="py-2 text-gray-700 hover:text-gray-900 min-[340px]:hidden">Sign in</Link>}
        </div>
      )}
    </nav>
  )
}
