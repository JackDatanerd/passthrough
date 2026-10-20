import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),summary,[contenteditable]:not([contenteditable="false"]),[tabindex]:not([tabindex="-1"])'

// Elements the trap should treat as tabbable. In a real browser, anything that takes no space
// (display:none, inside a [hidden] subtree, collapsed) can't hold focus — counting it as the first/last
// stop made Tab escape the dialog when the last "item" was invisible. jsdom does no layout (every
// element reports no boxes), so the visibility test only applies where layout exists.
// A radio group is ONE tab stop (the checked radio, or the first when none is checked) — the arrow keys move within it.
// Counting every radio made the trap's first/last stop a radio Tab never lands on, so Tab walked out of the dialog.
function isTabStop(el, dialog) {
  if (el.tagName !== 'INPUT' || el.type !== 'radio' || !el.name || el.checked) return true
  const group = [...dialog.querySelectorAll('input[type="radio"]')].filter(r => r.name === el.name && r.form === el.form && !r.disabled)
  return !group.some(r => r.checked) && group[0] === el
}

function tabbables(dialog) {
  const all = [...dialog.querySelectorAll(FOCUSABLE)].filter(el => isTabStop(el, dialog))
  if (dialog.getClientRects().length === 0) return all
  return all.filter(el => el.getClientRects().length > 0)
}

// Round 21: the toast stack (components/ui/Toast) is rendered outside every dialog, so its Undo / Retry / Dismiss buttons were out of
// reach of the Tab trap for as long as a dialog was open — a toast fired by a dialog's own action expired before a keyboard user could
// press its button. The stack is treated as the last stop of the trap: Tab runs through the dialog, then the toasts, then wraps.
function toastStack() { return typeof document === 'undefined' ? null : document.querySelector('[data-toast-stack]') }
function toastStops() {
  const stack = toastStack()
  if (!stack) return []
  return [...stack.querySelectorAll('button:not([disabled])')].filter(el => el.getClientRects().length > 0 || stack.getClientRects().length === 0)
}

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
let savedPaddingRight = ''
function lockScroll() {
  if (lockCount === 0) {
    // Hiding the page scrollbar widens the page and shifts everything sideways behind the overlay;
    // pad the body by the scrollbar's width so the layout stays put.
    const cw = document.documentElement.clientWidth
    const gap = cw > 0 ? Math.max(0, window.innerWidth - cw) : 0   // no layout (jsdom): nothing to compensate
    savedPaddingRight = document.body.style.paddingRight
    if (gap > 0) document.body.style.paddingRight = `${gap + (parseFloat(getComputedStyle(document.body).paddingRight) || 0)}px`
    // Section 11 (round 17 audit, bug): the body padding keeps IN-FLOW content still, but anything fixed to the viewport edge
    // (the toast stack, the terms banner) is placed against the viewport, which just grew by the scrollbar's width: with a classic
    // scrollbar every one of them jumped sideways when a dialog opened and back when it closed. The gap is published so those can
    // add it to their own offset (var(--scroll-lock-gap)).
    document.documentElement.style.setProperty('--scroll-lock-gap', `${gap}px`)
    document.body.style.overflow = 'hidden'
  }
  lockCount++
}
function unlockScroll() {
  lockCount = Math.max(0, lockCount - 1)
  if (lockCount === 0) {
    document.body.style.overflow = ''
    document.body.style.paddingRight = savedPaddingRight
    document.documentElement.style.removeProperty('--scroll-lock-gap')
  }
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
//  - `ariaLabel` names a title-less dialog and `describedBy` (an element id inside it) gives assistive
//    tech the body text to read on open — ConfirmDialog uses both.
// size: 'sm' | 'md' (default) | 'lg' | 'xl' — dialog width. Wide content (tables, previews) no longer has to
// hand-roll its own overlay just to escape max-w-md.
const SIZES = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-lg', xl: 'max-w-2xl' }

export default function Modal({ open, onClose, title, children, dismissible = true, ariaLabel, describedBy, size = 'md' }) {
  const titleId = useId()
  // A dialog with neither a title nor an ariaLabel has no accessible name (Select/Switch warn the same way).
  const unnamed = open && !title && !ariaLabel
  useEffect(() => {
    if (unnamed && import.meta.env?.DEV && import.meta.env?.MODE !== 'test')
      console.warn('<Modal> has no accessible name: pass `title` or `ariaLabel`.')
  }, [unnamed])
  const dialogRef = useRef(null)
  const onCloseRef = useRef(onClose)
  const dismissibleRef = useRef(dismissible)
  onCloseRef.current = onClose
  dismissibleRef.current = dismissible
  // The element that had focus BEFORE the dialog opened. Captured during render: by the time the effect runs, React has
  // already honoured an `autoFocus` inside the dialog, so reading it there recorded an element that is about to be
  // unmounted and focus was never handed back to the trigger.
  const triggerRef = useRef(null)
  const wasOpen = useRef(false)
  // Which place this dialog takes in the stack of open ones. Taken in RENDER order, which is parent-before-child: effects run
  // child-first, so an id taken in the effect put a dialog mounted INSIDE another one (same render) underneath its own parent —
  // Escape and Tab then went to the parent while the child was the one on screen.
  const stackId = useRef(0)
  if (open && !wasOpen.current) { wasOpen.current = true; stackId.current = ++nextModalId; triggerRef.current = typeof document !== 'undefined' ? document.activeElement : null }
  else if (!open && wasOpen.current) wasOpen.current = false

  useEffect(() => {
    if (!open) return
    const dialog = dialogRef.current
    const previouslyFocused = triggerRef.current
    lockScroll()

    const id = stackId.current
    // Kept in id order, not in the order the effects happened to run (see stackId).
    modalStack = [...modalStack, id].sort((a, b) => a - b)

    const marked = dialog.querySelector('[data-autofocus]')
    // React has already honoured an `autoFocus` inside the dialog by now; the person who wrote it chose that element,
    // so only an explicit data-autofocus outranks it (the old code always moved focus to the first input).
    const alreadyInside = !marked && document.activeElement && document.activeElement !== dialog && dialog.contains(document.activeElement)
    const initial = alreadyInside ? document.activeElement :
      // Two queries on purpose: one selector list returns the first match in DOCUMENT order, so a
      // checkbox rendered above the buttons would beat `data-autofocus` (the safe default button).
      marked ||
      dialog.querySelector('input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled])') ||
      dialog.querySelector(FOCUSABLE) || dialog
    // Only the dialog on top takes focus: a parent whose effect runs after its child's must not pull focus out from under it.
    if (!alreadyInside && modalStack[modalStack.length - 1] === id) initial.focus()

    function onKeyDown(e) {
      // Only the topmost Modal (the last one pushed, i.e. still on screen
      // above any others) reacts — see the module-level comment above.
      if (modalStack[modalStack.length - 1] !== id) return
      if (e.key === 'Escape') {
        // Escape that confirms/cancels an IME candidate, or that an inner widget (an open menu, a combobox) already
        // handled, must not also close the dialog.
        if (e.isComposing || e.defaultPrevented) return
        if (dismissibleRef.current) { e.stopPropagation(); onCloseRef.current?.() }
        return
      }
      if (e.key !== 'Tab') return
      const own = tabbables(dialog)
      const toasts = toastStops()
      const items = own.concat(toasts)
      if (items.length === 0) { e.preventDefault(); dialog.focus(); return }
      const first = items[0], last = items[items.length - 1]
      const active = document.activeElement
      const stack = toastStack()
      // Focus can end up OUTSIDE the dialog (on <body>) — e.g. after the backdrop
      // is clicked while the dialog is not dismissible, or when a focused button
      // is disabled mid-request. Only wrapping at the edges let Tab walk straight
      // into the page behind the overlay from there, so pull it back in first.
      if (!dialog.contains(active) && !(stack && stack.contains(active))) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return }
      // Toasts on screen: they are the last stops of the trap, reached by an explicit hop (the stack is NOT after the portaled dialog in
      // document order, so the browser's own Tab would never go there). Between two toasts, native order is right.
      if (toasts.length) {
        if (!e.shiftKey) {
          if (own.length && active === own[own.length - 1]) { e.preventDefault(); toasts[0].focus() }
          else if (active === toasts[toasts.length - 1]) { e.preventDefault(); (own[0] || toasts[0]).focus() }
        } else if (active === (own[0] || toasts[0]) || active === dialog) { e.preventDefault(); toasts[toasts.length - 1].focus() }
        else if (active === toasts[0]) { e.preventDefault(); (own[own.length - 1] || toasts[toasts.length - 1]).focus() }
        return
      }
      if (e.shiftKey && (active === first || active === dialog)) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      modalStack = modalStack.filter(x => x !== id)
      unlockScroll()
      // <body> / <html> count as "no opener": that is what document.activeElement is when the opener could not hold focus (a button
      // clicked in Safari or Firefox on a Mac, a dialog opened from a timer or a request). Focusing it does nothing, and it used to
      // satisfy this test, so the <main> fallback below never ran and a keyboard user was left at the top of the document.
      const opener = previouslyFocused && previouslyFocused !== document.body && previouslyFocused !== document.documentElement ? previouslyFocused : null
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
        opener.focus()
      } else {
        // The element that opened the dialog is gone (confirming a delete removed its own row, say): hand focus to the page's
        // <main> rather than dropping a keyboard user on <body>, where the next Tab starts from the top of the document.
        const main = document.querySelector('main')
        if (main) {
          if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1')
          main.focus({ preventScroll: true })
        }
      }
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

  // Rendered into <body>, not where the <Modal> sits in the tree: a dialog opened later is later in the DOM, so it is
  // painted above the ones already open (a password prompt over a refund dialog) — in-tree, two z-50 dialogs were
  // stacked by whichever component happened to come first. It also escapes any transformed/clipped ancestor.
  const node = (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50"
        aria-hidden="true"
        // Stops a click on the backdrop from blurring the dialog to <body>.
        onMouseDown={e => e.preventDefault()}
        onClick={() => { if (dismissible) onClose?.() }}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={!title ? ariaLabel : undefined}
        aria-describedby={describedBy}
        tabIndex={-1}
        // 90dvh tracks the VISIBLE viewport on phones (the URL bar / keyboard shrink it, 90vh doesn't);
        // a browser without dvh drops the inline value and keeps the 90vh class.
        style={{ maxHeight: '90dvh' }}
        className={`relative bg-white rounded-lg shadow-xl w-full ${SIZES[size] || SIZES.md} p-6 z-10 max-h-[90vh] overflow-y-auto focus:outline-none`}
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
  return typeof document === 'undefined' ? node : createPortal(node, document.body)
}
