import { useCallback, useEffect, useRef, useState } from 'react'

// A visible "try again in N seconds" timer for actions that send an email.
//   const { remaining, start } = useCooldown(30)
//   start()  -> remaining counts down from 30 to 0, one tick per second
export function useCooldown(seconds) {
  const [remaining, setRemaining] = useState(0)
  const timer = useRef(null)

  const stop = () => { if (timer.current) { clearInterval(timer.current); timer.current = null } }

  const start = useCallback(() => {
    stop()
    setRemaining(seconds)
    timer.current = setInterval(() => {
      setRemaining(n => {
        if (n <= 1) { stop(); return 0 }
        return n - 1
      })
    }, 1000)
  }, [seconds])

  useEffect(() => stop, [])
  return { remaining, start }
}
