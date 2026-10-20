import { useEffect } from 'react'

// A file dropped a little OUTSIDE a dropzone makes the browser open it in this tab, replacing the app — and with it whatever was typed
// into the page. While a component using this is mounted, a file drag anywhere else is cancelled (the cursor shows "not allowed") so a
// near-miss does nothing instead of destroying the page. Drags that are not files (text, links) and anything over an element marked
// `data-file-dropzone` are left to their own handlers. Shared by <FileUpload> and the verify page's own dropzone (round 21: that one had
// no guard of its own).
export default function useFileDropGuard() {
  useEffect(() => {
    const guard = e => {
      const types = Array.from(e.dataTransfer?.types || [])
      if (!types.includes('Files')) return
      // Over ANY dropzone (not just one instance's): with two mounted, each guard used to cancel drops over the other's zone.
      if (e.target instanceof Element && e.target.closest('[data-file-dropzone]')) return
      e.preventDefault()
      if (e.type === 'dragover' && e.dataTransfer) e.dataTransfer.dropEffect = 'none'
    }
    window.addEventListener('dragover', guard)
    window.addEventListener('drop', guard)
    return () => { window.removeEventListener('dragover', guard); window.removeEventListener('drop', guard) }
  }, [])
}
