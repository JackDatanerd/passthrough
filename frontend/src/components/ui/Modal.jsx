import { useEffect, useId, useRef } from 'react'

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'

// BUG FIX (audit): background-scroll locking used to save/restore
// document.body.style.overflow per Modal instance — `previousOverflow` was
// whatever it was when THAT instance mounted. If two modals were ever open
// at once (nested, or two triggered in quick succession), closing the OUTER
// one would restore overflow to its own pre-open value ('') while the INNER
// one was still open, silently unlocking background scroll underneath it.
// No usage in this codebase currently nests Modals, but it's a shared
// primitive — the bug would only show up the first time someone did. Fixed
// with a module-level open-count: overflow is locked on the first Modal to
// open and restored only when the last one closes, so nesting (now or in
// the future) is safe by construction rather than by convention.
let lockCount = 0
function lockScroll() {
  if (lockCount === 0) document.body.style.overflow = 'hidden'
  lockCount++
}
function unlockScroll() {
  lockCount = Math.max(0, lockCount - 1)
  if (lockCount === 0) document.body.style.overflow = ''
}

// BUG FIX (audit): the scroll-lock counter above made nesting SAFE for
// background scroll, but Escape/Tab were still handled per-instance, each
// registering its own document-level 'keydown' listener. Two Modals open at
// once (still no live call site today, but ConfirmDialog nests inside Modal
// content in the general case, and this is a shared primitive) meant every
// listener fired for the SAME keydown — stopPropagation() only stops
// bubbling to ancestors, it does nothing to sibling listeners on the same
// `document` target — so pressing Escape once closed every open Modal
// simultaneously, and Tab-trapping from two dialogs fought over
// document.activeElement in the same keystroke.
// A module-level stack fixes this the same way lockCount fixed scrolling:
// each Modal instance pushes its own id on open and pops it on close, and
// the shared keydown handler only acts for the id on TOP of the stack — so
// only the most-recently-opened (visually topmost) Modal ever responds to
// Escape or Tab, and closing it correctly hands control back to whichever
// Modal is now on top.
let modalStack = []
let nextModalId = 0

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
    lockScroll()

    const id = ++nextModalId
    modalStack.push(id)

    const initial =
      dialog.querySelector('[data-autofocus], input:not([disabled]), textarea:not([disabled]), select:not([disabled])') ||
      dialog.querySelector(FOCUSABLE) || dialog
    initial.focus()

    function onKeyDown(e) {
      // Only the topmost Modal (the last one pushed, i.e. still on screen
      // above any others) reacts — see the module-level comment above.
      if (modalStack[modalStack.length - 1] !== id) return
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
      modalStack = modalStack.filter(x => x !== id)
      unlockScroll()
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
