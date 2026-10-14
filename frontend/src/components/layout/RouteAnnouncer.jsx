import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'

// SHARED FRONTEND (section 11, feature gap): a single-page app never reloads, so nothing told a screen-reader user that
// following a link had taken them to another page, and a keyboard user kept a focus position that no longer existed (the
// link they pressed was unmounted with the old page, which drops focus to <body> — the next Tab starts again at the top of
// the document, through the whole header). After a change of PATH this:
//   1. moves focus to the new page's <main> (tabindex -1), so the next Tab lands on the page's own content and the header
//      is skipped — exactly what a full page load does for free;
//   2. announces the new page's title in a polite live region.
// Left alone on purpose: the first load (the browser already does this), a change of query string or hash only (same page),
// a navigation that carries a #hash (useScrollToHash owns that), a page that already put focus somewhere real (an autoFocus
// field, anything inside <main>), and while a dialog is open.
//
// Pages arrive lazily, so <main> may not exist yet when the path changes: it is looked for every 100ms for up to 5s, and
// the title is read only once the page is there (pages set their own title as they mount), so the announcement is the
// real one rather than the previous page's.
const POLL_MS = 100
const MAX_TRIES = 50

function focusIsSpoken(main) {
  const a = document.activeElement
  if (a && a !== document.body && a !== document.documentElement) {
    if (main.contains(a)) return true                                                // the page placed it itself
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable) return true   // an autoFocus field elsewhere
    if (a.closest?.('[role="dialog"],[role="alertdialog"]')) return true
  }
  return !!document.querySelector('[role="dialog"][aria-modal="true"]')
}

export default function RouteAnnouncer() {
  const { pathname, hash } = useLocation()
  const [message, setMessage] = useState('')
  const first = useRef(true)
  const flip = useRef(false)

  useEffect(() => {
    if (first.current) { first.current = false; return undefined }
    let cancelled = false
    let timer = null
    let tries = 0

    const finish = main => {
      if (main && !hash && !focusIsSpoken(main)) {
        if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1')
        main.focus({ preventScroll: true })
      }
      // A trailing no-break space on every other announcement: two pages with the same title in a row (/scan/a -> /scan/b)
      // would otherwise set identical text, which a live region does not re-announce.
      flip.current = !flip.current
      setMessage(`${document.title}${flip.current ? ' ' : ''}`)
    }
    const look = () => {
      if (cancelled) return
      const main = document.querySelector('main')
      if (main || tries >= MAX_TRIES) { finish(main); return }
      tries++
      timer = setTimeout(look, POLL_MS)
    }
    timer = setTimeout(look, 0)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [pathname])   // eslint-disable-line react-hooks/exhaustive-deps

  return <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-route-announcer="">{message}</div>
}
