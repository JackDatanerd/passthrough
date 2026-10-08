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
export default function useLatestRequest() {
  const seq = useRef(0)
  useEffect(() => () => { seq.current += 1 }, [])
  return useCallback(() => {
    const mine = ++seq.current
    return () => mine === seq.current
  }, [])
}
