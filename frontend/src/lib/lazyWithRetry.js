import { lazy } from 'react'

// React.lazy() wrapper for route-level code splitting.
//
// After a deploy, an already-open tab still references the OLD hashed chunk
// filenames, which no longer exist — navigating to a lazy route then fails with
// "Failed to fetch dynamically imported module". Reload once to pick up the new
// build (guarded by a sessionStorage flag so a genuine outage can't reload-loop),
// and only surface the error if the retry also fails.
const FLAG = 'passthrough_chunk_reload'

export default function lazyWithRetry(importer) {
  return lazy(async () => {
    try {
      const mod = await importer()
      try { sessionStorage.removeItem(FLAG) } catch (_) {}
      return mod
    } catch (err) {
      let alreadyReloaded = true
      try { alreadyReloaded = sessionStorage.getItem(FLAG) === '1' } catch (_) {}
      if (!alreadyReloaded) {
        try { sessionStorage.setItem(FLAG, '1') } catch (_) {}
        window.location.reload()
        return new Promise(() => {})   // page is reloading; never resolve
      }
      throw err
    }
  })
}
