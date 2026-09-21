import { useState, useCallback, useRef, useEffect } from 'react'
import { getErrorMessage } from '../lib/api'

// Thin wrapper for "run an API call, track loading + error". Previously this
// hook existed but nothing imported it, and it had real flaws had anyone adopted it:
//  - a single boolean `loading`, so with two overlapping calls the FIRST to
//    finish flipped it to false while the second was still running;
//  - state updates after unmount;
//  - errors reduced to `.message`, so Zod field errors ("Validation failed")
//    and network failures were reported wrongly.
//
//   const { loading, error, execute, reset } = useApi()
//   const data = await execute(() => api.post('/scan', formData))   // returns res.data; rethrows on failure
export function useApi() {
  const [pending, setPending] = useState(0)
  const [error, setError] = useState(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const execute = useCallback(async (apiCall, { fallback } = {}) => {
    if (mounted.current) { setPending(n => n + 1); setError(null) }
    try {
      const res = await apiCall()
      // apiCall is usually `() => api.post(...)`, but callers sometimes do more
      // work in there (claim a resource, navigate) and don't care about the
      // return value — don't crash on `res.data` if apiCall didn't resolve to
      // an axios response.
      return res?.data
    } catch (err) {
      if (mounted.current) setError(getErrorMessage(err, fallback))
      throw err
    } finally {
      if (mounted.current) setPending(n => Math.max(0, n - 1))
    }
  }, [])

  const reset = useCallback(() => setError(null), [])

  return { loading: pending > 0, error, execute, reset }
}
