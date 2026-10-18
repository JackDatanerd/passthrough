import { useCallback, useEffect, useRef, useState } from 'react'

// Section 11 (round 16, feature gap): the shared way to debounce a search box.
//
// Before this existed every list page either hand-rolled its own timer or, worse, fired a request per keystroke.
// AdminUsers did the latter: ~8 requests to type one email, against an app-wide limiter of 100 requests / 15 minutes
// (rateLimiter.js `general`, which covers /admin/*), so a few searches could lock the admin out of every call.
//
//   const search = useDebouncedState('', 350, () => setPage(1))
//   <Input value={search.value} onChange={e => search.setValue(e.target.value)} />
//   useEffect(load, [search.committed])
//
// - `value` is what the field shows (updates on every keystroke); `committed` is what the request should use and only
//   changes once typing has paused for `delayMs`.
// - `onCommit(next)` runs in the SAME tick as the `committed` update (React batches them), so "reset to page 1" costs
//   one render and one request, not a request with the new text on the old page followed by a second one.
// - Typing A -> B -> A inside the window commits nothing (value === committed), so no pointless refetch.
// - `commitNow()` skips the wait (Enter key, blur, a "Search" button). The timer is cleared on unmount.
export default function useDebouncedState(initial = '', delayMs = 350, onCommit) {
  const [value, setValue] = useState(initial)
  const [committed, setCommitted] = useState(initial)
  const valueRef = useRef(initial)
  valueRef.current = value
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit

  const commit = useCallback(next => {
    setCommitted(next)
    onCommitRef.current?.(next)
  }, [])

  useEffect(() => {
    if (value === committed) return undefined
    const t = setTimeout(() => commit(value), delayMs)
    return () => clearTimeout(t)
  }, [value, committed, delayMs, commit])

  const committedRef = useRef(initial)
  committedRef.current = committed
  const commitNow = useCallback(() => {
    // Read through refs so a key handler firing in the same tick as the last keystroke still sees it, and so the
    // onCommit side effect never runs inside a state updater (those run during render).
    const next = valueRef.current
    if (next === committedRef.current) return
    commit(next)
  }, [commit])

  return { value, setValue, committed, commitNow }
}
