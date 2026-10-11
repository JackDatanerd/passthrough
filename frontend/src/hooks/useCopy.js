import { useState, useRef, useEffect, useCallback } from 'react'
import { copyToClipboard } from '../lib/utils'

// "Copy" button feedback in one place. Each screen used to hand-roll `setCopied(true); setTimeout(() => setCopied(false), N)`:
// the timer outlived the component, and a second click did not restart it, so "Copied" vanished early.
//   const { copied, failed, copy } = useCopy()
//   <Button onClick={() => copy(text)}>{copied ? 'Copied' : 'Copy'}</Button>
// copy() resolves true/false (the clipboard write can be refused: insecure context, permission).
export function useCopy(resetMs = 2000) {
  const [status, setStatus] = useState(null)   // null | 'copied' | 'failed'
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = useCallback(async text => {
    const ok = await copyToClipboard(text)
    clearTimeout(timer.current)
    setStatus(ok ? 'copied' : 'failed')
    timer.current = setTimeout(() => setStatus(null), resetMs)
    return ok
  }, [resetMs])
  return { copied: status === 'copied', failed: status === 'failed', copy }
}

export default useCopy
