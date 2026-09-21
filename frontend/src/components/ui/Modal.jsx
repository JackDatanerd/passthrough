import { useEffect, useId, useRef } from 'react'

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'

// Changes vs. the original (which was only a styled div + Escape handler):
//  - role="dialog" / aria-modal / aria-labelledby, so assistive tech treats it as a dialog.
//  - Focus moves INTO the dialog on open, is trapped while open (Tab used to walk
//    through the page behind the overlay), and returns to the trigger on close.
//  - Background scroll is locked while open.
//  - Tall content scrolls inside the dialog (max-h + overflow) — before, a tall
//    form on a short viewport or with the mobile keyboard up overflowed off-screen
//    and its buttons were unreachable.
//  - A close button is always present (a title-less modal had none).
//  - `dismissible={false}` blocks Esc / backdrop / X while work is in flight, so a
//    request can't be orphaned by closing mid-way.
export default function Modal({ open, onClose, title, children, dismissible = true }) {
  const titleId = useId()
  const dialogRef = useRef(null)
  const onCloseRef = useRef(onClose)
  const dismissibleRef = useRef(dismissible)
  onCloseRef.current = onClose
  dismissibleRef.current = dismissible

  useEffect(() => {
    if (!open) return
    const dialog = dialogRef.current
    const previouslyFocused = document.activeElement
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const initial =
      dialog.querySelector('[data-autofocus], input:not([disabled]), textarea:not([disabled]), select:not([disabled])') ||
      dialog.querySelector(FOCUSABLE) || dialog
    initial.focus()

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        if (dismissibleRef.current) { e.stopPropagation(); onCloseRef.current?.() }
        return
      }
      if (e.key !== 'Tab') return
      const items = [...dialog.querySelectorAll(FOCUSABLE)]
      if (items.length === 0) { e.preventDefault(); dialog.focus(); return }
      const first = items[0], last = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === dialog)) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      if (previouslyFocused && typeof previouslyFocused.focus === 'function' && document.contains(previouslyFocused))
        previouslyFocused.focus()
    }
  }, [open])

  if (!open) return null

  const closeButton = dismissible && (
    <button
      type="button"
      onClick={() => onClose?.()}
      aria-label="Close"
      className="text-gray-400 hover:text-gray-600 transition-colors"
    >
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50"
        aria-hidden="true"
        onClick={() => { if (dismissible) onClose?.() }}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className="relative bg-white rounded-lg shadow-xl w-full max-w-md p-6 z-10 max-h-[90vh] overflow-y-auto focus:outline-none"
      >
        {title ? (
          <div className="flex items-center justify-between mb-4">
            <h2 id={titleId} className="text-lg font-semibold text-gray-900">{title}</h2>
            {closeButton}
          </div>
        ) : (
          closeButton && <div className="absolute top-4 right-4">{closeButton}</div>
        )}
        {children}
      </div>
    </div>
  )
}
