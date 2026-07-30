import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

// BrowserRouter does not scroll to `#hash` fragments on navigation the way a
// plain multi-page site does — clicking a `to="/#employers"` link from any
// route other than "/" itself just lands at the top of the page with no
// scroll. This hook fixes that: on every location change, if there's a hash
// and a matching element exists in the DOM, scroll to it.
//
// The small delay + rAF is needed because on first navigation to "/" from
// another route, the target page's content (and therefore the element with
// that id) may not be mounted yet in the same tick this effect runs.
export default function useScrollToHash() {
  const { hash, pathname } = useLocation()

  useEffect(() => {
    if (!hash) return
    const id = hash.slice(1)
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
