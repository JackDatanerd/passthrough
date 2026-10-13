import { useEffect, useState } from 'react'

// Whether the browser believes it has a network connection. `navigator.onLine` can say true on a dead link (a captive
// portal, a dropped mobile signal), so this is only a hint for a banner — lib/api.js still reports real failures itself.
export default function useOnlineStatus() {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean') ? true : navigator.onLine)
  useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    // Missed an event between render and effect.
    setOnline(typeof navigator.onLine === 'boolean' ? navigator.onLine : true)
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down) }
  }, [])
  return online
}
