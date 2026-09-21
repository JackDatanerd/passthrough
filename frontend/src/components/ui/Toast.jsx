import { useState, useEffect, useRef, createContext, useContext, useCallback, useMemo } from 'react'
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
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const nextId = useRef(0)
  const timers = useRef(new Map())

  const remove = useCallback(id => {
    clearTimeout(timers.current.get(id))
    timers.current.delete(id)
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const toast = useMemo(() => {
    const show = ({ message, type = 'info', duration = 4000 }) => {
      const id = ++nextId.current
      setToasts(prev => [...prev.slice(-4), { id, message, type }])   // at most 5 on screen
      if (duration > 0) timers.current.set(id, setTimeout(() => remove(id), duration))
      return id
    }
    for (const type of ['success', 'error', 'info', 'warning'])
      show[type] = (message, opts = {}) => show({ message, type, ...opts })
    show.dismiss = remove
    return show
  }, [remove])

  useEffect(() => {
    const active = timers.current
    return () => { active.forEach(clearTimeout); active.clear() }
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
        className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 pointer-events-none"
        aria-live="polite"
        aria-atomic="false"
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
            <span className="flex-1">{t.message}</span>
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
