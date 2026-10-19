import { useCallback, useEffect, useRef } from 'react'

// "Latest request wins" for data loaders.
//
// A list loader that does `setRows(await api.get(...))` lets a slow EARLIER request land after a
// newer one and overwrite it (page 2's rows under page 3's pager), and lets the first request to
// finish flip `loading` to false while the newer one is still running. Call `begin()` at the top
// of every load: it returns an `isCurrent()` check that is false once a newer load has begun or
// the component has unmounted.
//
//   const begin = useLatestRequest()
//   const load = useCallback(async () => {
//     const isCurrent = begin()
//     setLoading(true)
//     try {
//       const res = await api.get(...)
//       if (!isCurrent()) return
//       setRows(res.data.data)
//     } catch (err) {
//       if (!isCurrent()) return
//       toast(...)
//     } finally {
//       if (isCurrent()) setLoading(false)
//     }
//   }, [...])
//
// Cancelling, not just ignoring: the `isCurrent` check also carries an AbortSignal (`isCurrent.signal`). Pass it as
// `api.get(url, { signal: isCurrent.signal })` and a superseded load (typing in a search box, paging quickly) or an unmount
// cancels the request itself, so the server and the browser stop work nobody will read. The cancelled call rejects with a
// cancel error, and because `isCurrent()` is already false its `catch` returns silently. Not passing the signal still works:
// the response is just ignored, as before.
export default function useLatestRequest() {
  const seq = useRef(0)
  const controller = useRef(null)
  useEffect(() => () => {
    seq.current += 1
    controller.current?.abort()
  }, [])
  return useCallback(() => {
    const mine = ++seq.current
    controller.current?.abort()
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null
    controller.current = ctrl
    const isCurrent = () => mine === seq.current
    isCurrent.signal = ctrl?.signal
    return isCurrent
  }, [])
}
