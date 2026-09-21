import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

// Every route used to share the single <title> from index.html, so browser
// tabs, history and bookmarks were all "Passthrough — Does your resume pass…".
// Also marks private/per-user pages noindex (robots.txt only covered /dashboard/).

import { DEFAULT_TITLE, titleFor, isPrivatePath } from '../lib/pageTitles'
export { DEFAULT_TITLE, titleFor, isPrivatePath }

export default function usePageTitle(override) {
  const { pathname } = useLocation()

  useEffect(() => {
    document.title = override || titleFor(pathname)
    let meta = document.querySelector('meta[name="robots"]')
    if (isPrivatePath(pathname) || override === 'Page not found') {
      if (!meta) {
        meta = document.createElement('meta')
        meta.setAttribute('name', 'robots')
        document.head.appendChild(meta)
      }
      meta.setAttribute('content', 'noindex,nofollow')
    } else if (meta) {
      meta.remove()
    }
  }, [pathname, override])
}
