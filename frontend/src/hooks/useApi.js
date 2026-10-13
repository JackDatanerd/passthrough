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
// settling late can no longer override a newer one's outcome. (Only a SUCCESS is latest-wins now: a failure from any
// call is reported, because hiding a failed save behind a newer reload meant no error was ever shown.)
//
// Abort support: `apiCall` receives `{ signal }` — pass it on (`api.get(url, { signal })`) and the
// request is cancelled when the component unmounts (nothing is left running for a screen that is
// gone). `execute(fn, { replace: true })` also cancels the PREVIOUS still-running call when a newer
// one starts (search-as-you-type: only the latest matters). A cancelled call rethrows its cancel
// error but never writes `error` — it is not a failure to show. Callers that ignore the argument
// (`() => api.post(...)`) behave exactly as before.
//
// Progress: `execute(opts => api.post('/scan', fd, opts), { progress: true })` — `opts` then also carries an
// `onUploadProgress` that feeds `progress` (0-100, or null when nothing is uploading / the size is unknown). Render it
// with <ProgressBar value={progress} />. Callers that do not pass the option see no change.
//
//   const { loading, error, progress, execute, reset } = useApi()
//   const data = await execute(() => api.post('/scan', formData))   // returns res.data; rethrows on failure
export function useApi() {
  const [pending, setPending] = useState(0)
  const [error, setError] = useState(null)
  const [progress, setProgress] = useState(null)
  const mounted = useRef(true)
  const callId = useRef(0)
  // The newest call that had STARTED when the displayed error landed. A success clears the error only if it started after
  // that: a call that was already running when a failure arrived knows nothing about that failure, and used to wipe it.
  const errorMark = useRef(-1)
  const controllers = useRef(new Map())   // call id -> AbortController, for calls still running
  const superseded = useRef(new Set())    // ids a `replace: true` call pushed aside — their outcome no longer matters

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
    // keepAlive: for a write that must finish even if its screen goes away (a dialog closed mid-save): the call is
    // handed no signal and is never aborted by unmount or `replace`.
    const { fallback, replace = false, keepAlive = false, progress: wantsProgress = false } = options || {}
    const id = ++callId.current
    if (replace) {
      controllers.current.forEach((c, otherId) => { if (otherId !== id) { superseded.current.add(otherId); c.abort() } })
    }
    const controller = !keepAlive && typeof AbortController !== 'undefined' ? new AbortController() : null
    if (controller) controllers.current.set(id, controller)
    if (mounted.current) { setPending(n => n + 1); setError(null); errorMark.current = -1; if (wantsProgress) setProgress(0) }
    try {
      const callOptions = controller ? { signal: controller.signal } : {}
      if (wantsProgress) {
        callOptions.onUploadProgress = e => {
          if (mounted.current && id === callId.current && e && e.total > 0)
            setProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)))
        }
      }
      const res = await apiCall(callOptions)
      // apiCall is usually `() => api.post(...)`, but callers sometimes do more
      // work in there (claim a resource, navigate) and don't care about the
      // return value — don't crash on `res.data` if apiCall didn't resolve to
      // an axios response.
      if (mounted.current && id === callId.current && errorMark.current < id) setError(null)
      return res?.data
    } catch (err) {
      // A call cancelled on purpose (unmount, or replaced by a newer one) is not an error to display.
      // A FAILURE surfaces even from an earlier-started call (only one a `replace: true` call pushed aside is ignored): only a success is "latest wins" (above). Before,
      // a failed save was swallowed whenever a newer call (a reload) had started, so the person saw no error at all.
      if (!isCancelError(err) && mounted.current && !superseded.current.has(id)) { errorMark.current = callId.current; setError(getErrorMessage(err, fallback)) }
      throw err
    } finally {
      if (wantsProgress && mounted.current && id === callId.current) setProgress(null)
      controllers.current.delete(id)
      superseded.current.delete(id)
      if (mounted.current) setPending(n => Math.max(0, n - 1))
    }
  }, [])

  const reset = useCallback(() => { errorMark.current = -1; setError(null) }, [])

  return { loading: pending > 0, error, progress, execute, reset }
}
