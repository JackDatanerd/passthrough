import { useState, useCallback, useRef, useEffect } from 'react'
import { getErrorMessage, isCancelError } from '../lib/errors'

// Thin wrapper for "run an API call, track loading + error". It had real
// flaws before being adopted more widely:
//  - a single boolean `loading`, so with two overlapping calls the FIRST to
//    finish flipped it to false while the second was still running;
//  - state updates after unmount;
//  - errors reduced to `.message`, so Zod field errors ("Validation failed")
//    and network failures were reported wrongly.
//
// BUG FIX (audit): `pending`'s counter fixed the `loading` half of "two
// overlapping calls" above, but `error` was still a single slot — if two
// execute() calls overlap and the FIRST-STARTED one happens to resolve
// (fail or succeed) AFTER the second, its result clobbered whatever the
// second one had just set, regardless of which was actually the user's
// most recent action. Guarded with a call-id ref: only the latest-STARTED
// call is allowed to write `error` when it finishes, so an earlier call
// settling late can no longer override a newer one's outcome.
//
// Abort support: `apiCall` receives `{ signal }` — pass it on (`api.get(url, { signal })`) and the
// request is cancelled when the component unmounts (nothing is left running for a screen that is
// gone). `execute(fn, { replace: true })` also cancels the PREVIOUS still-running call when a newer
// one starts (search-as-you-type: only the latest matters). A cancelled call rethrows its cancel
// error but never writes `error` — it is not a failure to show. Callers that ignore the argument
// (`() => api.post(...)`) behave exactly as before.
//
//   const { loading, error, execute, reset } = useApi()
//   const data = await execute(() => api.post('/scan', formData))   // returns res.data; rethrows on failure
export function useApi() {
  const [pending, setPending] = useState(0)
  const [error, setError] = useState(null)
  const mounted = useRef(true)
  const callId = useRef(0)
  const controllers = useRef(new Map())   // call id -> AbortController, for calls still running

  useEffect(() => {
    mounted.current = true
    const live = controllers.current
    return () => {
      mounted.current = false
      live.forEach(c => c.abort())
      live.clear()
    }
  }, [])

  const execute = useCallback(async (apiCall, options) => {
    const { fallback, replace = false } = options || {}
    const id = ++callId.current
    if (replace) {
      controllers.current.forEach((c, otherId) => { if (otherId !== id) c.abort() })
    }
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    if (controller) controllers.current.set(id, controller)
    if (mounted.current) { setPending(n => n + 1); setError(null) }
    try {
      const res = await apiCall(controller ? { signal: controller.signal } : {})
      // apiCall is usually `() => api.post(...)`, but callers sometimes do more
      // work in there (claim a resource, navigate) and don't care about the
      // return value — don't crash on `res.data` if apiCall didn't resolve to
      // an axios response.
      if (mounted.current && id === callId.current) setError(null)
      return res?.data
    } catch (err) {
      // A call cancelled on purpose (unmount, or replaced by a newer one) is not an error to display.
      if (!isCancelError(err) && mounted.current && id === callId.current) setError(getErrorMessage(err, fallback))
      throw err
    } finally {
      controllers.current.delete(id)
      if (mounted.current) setPending(n => Math.max(0, n - 1))
    }
  }, [])

  const reset = useCallback(() => setError(null), [])

  return { loading: pending > 0, error, execute, reset }
}
