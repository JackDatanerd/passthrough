import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Footer from '../layout/Footer'
import { cn } from '../../lib/utils'

// The partner pages are reached by a private link, not a login, so they get a header of their own instead of the
// public site's: the logo, a "Partners" label, the partner's name, and (on the dashboard) a strip that jumps to each
// section of the page. The public site's links (Pricing, For employers, Log in...) mean nothing to someone on this page.
//
// `sections`: [{ id, label }], each id an element on the page. The one in view is marked as current.
function useActiveSection(ids) {
  const [active, setActive] = useState(ids[0] || null)
  const key = ids.join('|')
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined' || ids.length === 0) return undefined
    const seen = new Map()
    const observer = new IntersectionObserver(entries => {
      entries.forEach(e => seen.set(e.target.id, e.isIntersecting ? e.boundingClientRect.top : null))
      // The topmost section that is inside the band just below the header.
      const visible = [...seen.entries()].filter(([, top]) => top !== null).sort((a, b) => a[1] - b[1])
      if (visible.length) setActive(visible[0][0])
    }, { rootMargin: '-96px 0px -60% 0px' })
    ids.forEach(id => { const el = document.getElementById(id); if (el) observer.observe(el) })
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return [active, setActive]
}

function initialOf(name) {
  const ch = String(name || '').trim().charAt(0)
  return ch ? ch.toUpperCase() : '·'
}

export default function PartnerLayout({ children, sections = [], name }) {
  const [active, setActive] = useActiveSection(sections.map(s => s.id))
  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <header className="sticky top-0 z-30 bg-white border-b border-gray-200">
        <a href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-[70] focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-blue-700 focus:shadow">
          Skip to content
        </a>
        <div className="max-w-6xl mx-auto px-4 flex flex-wrap items-center gap-x-4 sm:flex-nowrap">
          <Link to="/" className="order-1 h-14 flex items-center gap-2 shrink-0">
            <span className="font-bold text-blue-700 text-lg tracking-tight">Passthrough</span>
            <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-700">Partners</span>
          </Link>
          {sections.length > 0 && (
            <nav aria-label="Dashboard sections" className="order-3 w-full sm:order-2 sm:w-auto sm:flex-1 min-w-0 flex gap-0.5 overflow-x-auto pb-2 sm:pb-0">
              {sections.map(s => {
                const current = s.id === active
                return (
                  <a key={s.id} href={`#${s.id}`} onClick={() => setActive(s.id)} aria-current={current ? 'true' : undefined}
                    className={cn('px-3 py-1.5 rounded-md text-sm font-semibold transition-colors whitespace-nowrap shrink-0',
                      current ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-100')}>
                    {s.label}
                  </a>
                )
              })}
            </nav>
          )}
          {name && (
            <div className="order-2 sm:order-3 ml-auto flex items-center gap-2 text-sm text-gray-700 min-w-0">
              <span aria-hidden="true" className="h-8 w-8 shrink-0 rounded-full bg-blue-700 text-white text-sm font-bold flex items-center justify-center">{initialOf(name)}</span>
              <span className="hidden sm:block truncate max-w-[12rem] font-medium">{name}</span>
            </div>
          )}
        </div>
      </header>
      <main id="main" className="flex-1 max-w-6xl mx-auto w-full px-4 py-8 min-w-0">{children}</main>
      <Footer />
    </div>
  )
}
