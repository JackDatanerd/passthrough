import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import useSignOut from '../../hooks/useSignOut'
import LogoMark from './LogoMark'

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

// Top-level links, in the order the homepage itself runs (the proof, the receipt, stories, hot fields, pricing, employers).
// Hash links all point at "/" so they work from any page; /pricing is its own route.
const LINKS = [
  ['/#proof', 'Proof'],
  ['/#receipt', 'The receipt'],
  ['/#stories', 'Stories'],
  ['/#hot', 'Hot categories'],
  ['/pricing', 'Pricing'],
  ['/#employers', 'For employers'],
]
const linkCls = 'text-ink-2 hover:text-ink transition-colors'

export default function Navbar() {
  const { user } = useAuth()
  const handleLogout = useSignOut()
  const { pathname, hash } = useLocation()
  // Below lg the six links (and Sign in / Dashboard / Sign out) do not fit next to the logo and the Scan free button,
  // so they live in this menu; from lg up they are all in the bar.
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
    <nav ref={navRef} aria-label="Main" className="sticky top-0 z-50 bg-paper/90 backdrop-blur-md border-b border-gray-200">
      <a
        href="#main"
        onClick={skipToMain}
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-[70] focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-blue-700 focus:shadow-lg focus:ring-2 focus:ring-blue-500"
      >
        Skip to content
      </a>
      <div className="max-w-[1180px] mx-auto px-4 max-[359px]:px-3 sm:px-6 h-16 flex items-center justify-between gap-3 sm:gap-4">
        <Link to="/" className="flex items-center gap-2 max-[359px]:gap-1.5 sm:gap-2.5 font-display font-extrabold text-ink text-xl max-[359px]:text-[1.05rem] sm:text-[1.4rem] tracking-[-0.03em]">
          <LogoMark className="w-[26px] h-[26px] sm:w-[30px] sm:h-[30px]" />
          Passthrough
        </Link>
        <div className="hidden lg:flex items-center gap-6 text-[15px] font-semibold whitespace-nowrap">
          {LINKS.map(([to, label]) => (
            <Link key={to} to={to} aria-current={here(pathname, to)} className={linkCls}>{label}</Link>
          ))}
        </div>
        <div className="flex items-center gap-1 sm:gap-2 text-[15px] font-semibold whitespace-nowrap">
          <button
            ref={moreBtn}
            type="button"
            onClick={() => setMenuOpen(o => !o)}
            aria-expanded={menuOpen}
            aria-controls="navbar-more"
            className="lg:hidden px-1.5 max-[359px]:px-1 py-3 text-ink-2 hover:text-ink transition-colors"
          >
            {menuOpen ? 'Close' : 'More'}
          </button>
          {user ? (
            <>
              <Link to="/dashboard" aria-current={here(pathname, '/dashboard')} className={`hidden lg:block px-2.5 py-2 ${linkCls}`}>
                Dashboard
              </Link>
              {/* The admin page had no link anywhere — admins had to type the URL. */}
              {user.role === 'ADMIN' && (
                <Link to="/admin" aria-current={here(pathname, '/admin')} className={`hidden lg:block px-2.5 py-2 ${linkCls}`}>
                  Admin
                </Link>
              )}
              <button type="button" onClick={handleLogout} className={`hidden lg:block px-2.5 py-2 ${linkCls}`}>
                Sign out
              </button>
            </>
          ) : (
            <Link to="/login" className={`hidden lg:block px-2.5 py-2 ${linkCls}`}>
              Sign in
            </Link>
          )}
          {/* The page's one job is the scan, so the bar's one button is the scan (it used to be "Get started" -> /register). */}
          <Link
            to="/#scan-form"
            className="bg-blue-700 text-white font-bold px-3 max-[359px]:px-2.5 max-[359px]:text-sm sm:px-4 py-2.5 rounded-[10px] shadow-[0_3px_0_#1e3a8a] hover:bg-blue-800 transition-colors"
          >
            Scan free
          </Link>
        </div>
      </div>
      {menuOpen && (
        <div id="navbar-more" className="lg:hidden border-t border-gray-200 px-4 sm:px-6 py-2 flex flex-col text-[15px] font-semibold">
          {LINKS.map(([to, label]) => (
            <Link key={to} to={to} aria-current={here(pathname, to)} onClick={() => setMenuOpen(false)} className="py-2.5 text-ink-2 hover:text-ink">{label}</Link>
          ))}
          {user ? (
            <>
              <Link to="/dashboard" aria-current={here(pathname, '/dashboard')} onClick={() => setMenuOpen(false)} className="py-2.5 text-ink-2 hover:text-ink">Dashboard</Link>
              {user.role === 'ADMIN' && (
                <Link to="/admin" aria-current={here(pathname, '/admin')} onClick={() => setMenuOpen(false)} className="py-2.5 text-ink-2 hover:text-ink">Admin</Link>
              )}
              <button type="button" onClick={() => { setMenuOpen(false); handleLogout() }} className="py-2.5 text-left text-ink-2 hover:text-ink">Sign out</button>
            </>
          ) : (
            <Link to="/login" onClick={() => setMenuOpen(false)} className="py-2.5 text-ink-2 hover:text-ink">Sign in</Link>
          )}
        </div>
      )}
    </nav>
  )
}
