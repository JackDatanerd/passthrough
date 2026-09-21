import { useEffect } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'

// Two jobs, both things BrowserRouter does not do on its own:
//
// 1. New page -> scroll to top. Without this, following a footer link (which
//    sits at the bottom of a long page) opened the destination at the same
//    scroll offset, i.e. near its bottom. Skipped for browser back/forward
//    (POP) so the browser can restore where the user was.
//
// 2. `#hash` -> scroll to that element. Clicking a `to="/#employers"` link from
//    any route other than "/" itself would otherwise land at the top with no
//    scroll. The small delay + rAF retry is needed because on first navigation
//    to "/" from another route, the target page's content (and therefore the
//    element with that id) may not be mounted yet in the same tick this runs.
export default function useScrollToHash() {
  const { hash, pathname } = useLocation()
  const navType = useNavigationType()

  useEffect(() => {
    if (hash || navType === 'POP') return
    window.scrollTo(0, 0)
  }, [pathname])   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!hash) return
    const id = decodeURIComponent(hash.slice(1))
    let cancelled = false

    function tryScroll(attempt = 0) {
      if (cancelled) return
      const el = document.getElementById(id)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      } else if (attempt < 10) {
        // Element not mounted yet (route just changed) — retry briefly
        // rather than give up after one tick.
        requestAnimationFrame(() => tryScroll(attempt + 1))
      }
    }
    requestAnimationFrame(() => tryScroll())

    return () => { cancelled = true }
  }, [hash, pathname])
}
