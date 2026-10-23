import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import useSignOut from '../../hooks/useSignOut'
import LogoMark from './LogoMark'
import SkipLink from './SkipLink'

// The page a top-level link points at, for assistive tech. Hash links (/#stories) never count: the page is Home either way.
const here = (pathname, to) => (pathname === to || pathname.startsWith(`${to}/`) ? 'page' : undefined)

// Top-level bar: four plain entries. "Stories" is a dropdown that holds the proof-style sections (the example, the receipt,
// the hot fields) so the bar itself stays short next to the one button. Hash links all point at "/" so they work from any
// page; /pricing is its own route.
const HOW = ['/#how', 'How it works']
const STORIES = {
  label: 'Stories',
  items: [['/#stories', 'Applicant stories'], ['/#proof', 'Proof'], ['/#receipt', 'The receipt'], ['/#hot', 'Hot categories']],
}
const AFTER = [['/pricing', 'Pricing'], ['/#employers', 'For employers']]
const linkCls = 'text-ink-2 hover:text-ink transition-colors'

export default function Navbar() {
  const { user } = useAuth()
  const handleLogout = useSignOut()
  const { pathname, hash } = useLocation()
  // Below lg the links (and Sign in / Dashboard / Sign out) do not fit next to the logo and the Scan free button,
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

  // The Stories dropdown (lg+). A disclosure, not an ARIA "menu": a button that shows a short list of ordinary links.
  // Closes on Escape (focus goes back to the button), on a press outside, on Tab leaving it, and on any navigation.
  const [storiesOpen, setStoriesOpen] = useState(false)
  useEffect(() => { setStoriesOpen(false) }, [pathname, hash])
  const storiesRef = useRef(null)
  const storiesBtn = useRef(null)
  useEffect(() => {
    if (!storiesOpen) return undefined
    const onKey = e => { if (e.key === 'Escape') { setStoriesOpen(false); storiesBtn.current?.focus() } }
    const onPointer = e => { if (storiesRef.current && !storiesRef.current.contains(e.target)) setStoriesOpen(false) }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onPointer) }
  }, [storiesOpen])

  return (
    <nav ref={navRef} aria-label="Main" className="sticky top-0 z-50 bg-paper/90 backdrop-blur-md border-b border-gray-200">
      <SkipLink />
      <div className="max-w-[1180px] mx-auto px-4 max-[359px]:px-3 sm:px-6 h-16 flex items-center justify-between gap-3 sm:gap-4">
        <Link to="/" className="flex items-center gap-2 max-[359px]:gap-1.5 sm:gap-2.5 font-display font-extrabold text-ink text-xl max-[359px]:text-[1.05rem] sm:text-[1.4rem] tracking-[-0.03em]">
          <LogoMark className="w-[26px] h-[26px] sm:w-[30px] sm:h-[30px]" />
          Passthrough
        </Link>
        <div className="hidden lg:flex items-center gap-6 text-[15px] font-semibold whitespace-nowrap">
          <Link to={HOW[0]} className={linkCls}>{HOW[1]}</Link>
          <div
            ref={storiesRef}
            className="relative"
            // Round 23: relatedTarget is null when focus goes to something that cannot take it — a link clicked with the mouse in Safari, which
            // does not focus links — so closing on null unmounted the list between mousedown and click and the click never landed. A press
            // outside is already closed by the pointerdown handler above; only a Tab to another element closes here.
            onBlur={e => { if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) setStoriesOpen(false) }}
          >
            <button
              ref={storiesBtn}
              type="button"
              onClick={() => setStoriesOpen(o => !o)}
              aria-expanded={storiesOpen}
              aria-controls={storiesOpen ? 'navbar-stories' : undefined}
              className={`inline-flex items-center gap-1 ${linkCls}`}
            >
              {STORIES.label}
              <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false" className={`w-4 h-4 transition-transform ${storiesOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m5 8 5 5 5-5" /></svg>
            </button>
            {storiesOpen && (
              <div id="navbar-stories" className="absolute left-1/2 -translate-x-1/2 top-full mt-3 w-56 rounded-xl border border-gray-200 bg-white shadow-lg py-1.5 flex flex-col">
                {STORIES.items.map(([to, label]) => (
                  <Link key={to} to={to} onClick={() => setStoriesOpen(false)} className="px-4 py-2 text-ink-2 hover:bg-gray-50 hover:text-ink">{label}</Link>
                ))}
              </div>
            )}
          </div>
          {AFTER.map(([to, label]) => (
            <Link key={to} to={to} aria-current={here(pathname, to)} className={linkCls}>{label}</Link>
          ))}
        </div>
        <div className="flex items-center gap-1 sm:gap-2 text-[15px] font-semibold whitespace-nowrap">
          <button
            ref={moreBtn}
            type="button"
            onClick={() => setMenuOpen(o => !o)}
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? 'navbar-more' : undefined}
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
          <Link to={HOW[0]} onClick={() => setMenuOpen(false)} className="py-2.5 text-ink-2 hover:text-ink">{HOW[1]}</Link>
          {/* No nested dropdown on a phone: the group is just listed, under a label. */}
          <div role="group" aria-labelledby="navbar-stories-label" className="flex flex-col">
            <span id="navbar-stories-label" className="pt-2.5 pb-0.5 text-xs font-semibold uppercase tracking-wide text-gray-500">{STORIES.label}</span>
            {STORIES.items.map(([to, label]) => (
              <Link key={to} to={to} onClick={() => setMenuOpen(false)} className="py-2.5 pl-3 text-ink-2 hover:text-ink">{label}</Link>
            ))}
          </div>
          {AFTER.map(([to, label]) => (
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
