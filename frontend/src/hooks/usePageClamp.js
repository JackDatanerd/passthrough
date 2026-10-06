import { useEffect } from 'react'
import { clampPage } from '../lib/pagination'

// Pulls `page` back into range once a fresh `total` shows it no longer exists.
// Waits for `loading` to be false so it never acts on a total that is about to
// be replaced, and does nothing while the page is already valid.
//
//   usePageClamp({ page, total, pageSize: PAGE_SIZE, setPage, loading })
export default function usePageClamp({ page, total, pageSize, setPage, loading = false }) {
  useEffect(() => {
    if (loading) return
    const clamped = clampPage(page, total, pageSize)
    if (clamped !== page) setPage(clamped)
  }, [page, total, pageSize, loading, setPage])
}
