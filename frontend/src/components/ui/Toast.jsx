import { useState, useEffect, useRef, createContext, useContext, useCallback, useMemo, isValidElement } from 'react'
import { cn } from '../../lib/utils'

const ToastContext = createContext(null)

// Changes vs. the original:
//  - ids come from a counter. `Date.now()` collided when two toasts fired in the
//    same millisecond (duplicate React keys, and removing one removed both).
//  - every auto-dismiss timer is tracked and cleared (on manual close and unmount).
//  - the container is an aria-live region and error toasts are role="alert", so
//    screen-reader users actually hear them.
//  - `animate-fade-in` was referenced but never defined anywhere; it now exists in
//    tailwind.config.js.
//  - toast.success / .error / .info / .warning shortcuts; toast.dismiss(id).
// A message may be text, a number or a React element. Anything else (an Error, an object) used to
// crash the render with "Objects are not valid as a React child"; it is turned into text instead.
function normalizeMessage(m) {
  if (typeof m === 'string' || typeof m === 'number' || isValidElement(m)) return m
  if (m instanceof Error) return m.message || 'Something went wrong.'
  if (m === null || m === undefined) return ''
  try { return String(m) } catch (_) { return '' }
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  // The list lives in a ref and is mirrored into state: show/remove read and write it synchronously, so
  // two toasts fired in the same tick see each other (de-duplication, the cap of 5) and no timer is ever
  // cleared from inside a state updater.
  const list = useRef([])
  const commit = useCallback(next => { list.current = next; setToasts(next) }, [])
  const nextId = useRef(0)
  const timers = useRef(new Map())
  const paused = useRef(false)

  // Each timer entry is { handle, deadline, remaining }. Hovering or focusing the stack pauses every
  // toast's countdown (WCAG 2.2.1: nobody should lose a message mid-read) and leaving resumes it
  // with the time that was left. A toast that ARRIVES while the stack is paused waits too.
  const clearTimer = useCallback(id => {
    const t = timers.current.get(id)
    if (t && t.handle != null) clearTimeout(t.handle)
    timers.current.delete(id)
  }, [])

  const remove = useCallback(id => {
    clearTimer(id)
    commit(list.current.filter(t => t.id !== id))
  }, [clearTimer, commit])

  const arm = useCallback((id, ms) => {
    if (paused.current) { timers.current.set(id, { handle: null, deadline: 0, remaining: ms }); return }
    timers.current.set(id, { handle: setTimeout(() => remove(id), ms), deadline: Date.now() + ms, remaining: ms })
  }, [remove])

  const pause = useCallback(() => {
    paused.current = true
    timers.current.forEach(t => {
      if (t.handle == null) return
      clearTimeout(t.handle)
      t.handle = null
      t.remaining = Math.max(1000, t.deadline - Date.now())
    })
  }, [])

  const resume = useCallback(() => {
    paused.current = false
    timers.current.forEach((t, id) => { if (t.handle == null) arm(id, t.remaining) })
  }, [arm])

  const toast = useMemo(() => {
    // Errors are the messages people most need to read (and often retype from), so they stay up
    // longer by default. `duration: 0` keeps a toast until it is dismissed.
    const show = ({ message, type = 'info', duration = type === 'error' ? 9000 : 4000 }) => {
      const text = normalizeMessage(message)
      // The same text of the same kind already on screen (a retry loop, a double-clicked action) is
      // not stacked again: the one showing just has its countdown restarted.
      if (typeof text === 'string') {
        const dupe = list.current.find(t => t.type === type && t.message === text)
        if (dupe) {
          clearTimer(dupe.id)
          if (duration > 0) arm(dupe.id, duration)
          return dupe.id
        }
      }
      const id = ++nextId.current
      const next = [...list.current, { id, message: text, type }]
      // Cap at 5 on screen; whatever is pushed off loses its timer too.
      const dropped = next.slice(0, Math.max(0, next.length - 5))
      dropped.forEach(t => clearTimer(t.id))
      commit(next.slice(-5))
      if (duration > 0) arm(id, duration)
      return id
    }
    for (const type of ['success', 'error', 'info', 'warning'])
      show[type] = (message, opts = {}) => show({ message, type, ...opts })
    show.dismiss = remove
    return show
  }, [remove, arm, clearTimer, commit])

  useEffect(() => {
    const active = timers.current
    return () => { active.forEach(t => { if (t.handle != null) clearTimeout(t.handle) }); active.clear() }
  }, [])

  const colors = {
    success: 'bg-green-600',
    error:   'bg-red-600',
    info:    'bg-blue-600',
    warning: 'bg-amber-500',
  }

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div
        className="fixed right-4 z-[60] flex flex-col gap-2 pointer-events-none"
        // Sits above anything fixed to the bottom edge (the Terms banner publishes
        // its height as --bottom-inset) so toasts never cover its button.
        style={{ bottom: 'calc(1rem + var(--bottom-inset, 0px))' }}
        aria-live="polite"
        aria-atomic="false"
        onMouseEnter={pause}
        onMouseLeave={resume}
        onFocus={pause}
        onBlur={resume}
      >
        {toasts.map(t => (
          <div
            key={t.id}
            role={t.type === 'error' ? 'alert' : 'status'}
            className={cn(
              'flex items-center gap-3 px-4 py-3 rounded-lg text-white text-sm shadow-lg',
              'pointer-events-auto max-w-sm animate-fade-in',
              colors[t.type] || colors.info
            )}
          >
            <span className="flex-1 min-w-0 break-words">{t.message}</span>
            <button
              type="button"
              onClick={() => remove(t.id)}
              aria-label="Dismiss notification"
              className="opacity-75 hover:opacity-100"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}
