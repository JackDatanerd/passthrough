import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '../../lib/utils'

// A button that opens a MENU of actions / links, with the keyboard model that role="menu" promises (WAI-ARIA menu button):
//   · the trigger opens on click, Enter, Space or ArrowDown (focus lands on the first item) and ArrowUp (the last one);
//   · inside, ArrowDown / ArrowUp move (and wrap), Home / End jump, a letter jumps to the next item starting with it;
//   · Escape closes and hands focus back to the trigger; Tab closes and moves on from the trigger (focus is not left on
//     an item that is about to disappear); a press outside closes; choosing an item closes it.
// Items are plain elements with role="menuitem" (a <button>, a router <Link>, an <a>) — a disabled one is skipped.
// This is for ACTION menus. A button that just reveals a few ordinary links (the navbar's Stories list) is a disclosure,
// not a menu: it keeps aria-expanded + Escape/outside/Tab handling and does not need this component.
const ITEM = '[role="menuitem"]:not(:disabled):not([aria-disabled="true"])'

export default function Menu({
  label, trigger = '⋯', children, align = 'right',
  className, triggerClassName, menuClassName,
}) {
  const [open, setOpen] = useState(false)
  const focusOn = useRef('first')       // which item to focus once the menu has rendered
  const wrap = useRef(null)
  const btn = useRef(null)
  const list = useRef(null)
  const menuId = useId()
  const placeRef = useRef(null)
  const [pos, setPos] = useState(null)   // viewport coordinates once open (see below)

  const items = useCallback(() => (list.current ? Array.from(list.current.querySelectorAll(ITEM)) : []), [])
  const close = useCallback((restoreFocus = true) => {
    setOpen(false)
    if (restoreFocus) btn.current?.focus()
  }, [])

  // The list is positioned against the VIEWPORT (position: fixed), not its parent: inside a scrolling wrapper (a DataTable's
  // overflow-x-auto, a modal body) an absolutely-positioned list is clipped or drags a scrollbar in, worst on the last row.
  // It flips above the trigger when there is no room below, is clamped inside the viewport (and scrolls inside itself when the viewport
  // is shorter than the list - a phone held sideways), re-places itself when the window resizes, and closes when anything else scrolls.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return undefined }
    const place = () => {
      const r = btn.current?.getBoundingClientRect(); if (!r) return
      const MARGIN = 8
      const vh = window.innerHeight
      // Section 11 (round 17 audit, bug): with room neither above nor below the trigger (a short viewport - a phone held sideways)
      // the list was left hanging off the bottom edge: its lower items could not be clicked, and arrowing to one made the browser
      // scroll the PAGE to reveal it, which this component's own scroll listener reads as "something scrolled" and closes. The list
      // is now kept inside the viewport and scrolls inside itself when it is taller than the viewport allows.
      const avail = Math.max(0, vh - 2 * MARGIN)
      const h = Math.min(list.current?.offsetHeight || 0, avail)
      const below = r.bottom + 4
      const wanted = below + h > vh && r.top - 4 - h >= 0 ? r.top - 4 - h : below
      const top = Math.max(MARGIN, Math.min(wanted, vh - h))
      // Clamped so the list never spills past either viewport edge (it is min-w-56 wide, anchored to one side of the trigger).
      const vw = document.documentElement.clientWidth
      // Round 22 (bug): the first placement measured the list while it was still absolutely positioned inside the trigger's (often
      // trigger-wide) wrapper, where it wraps to its min-w; once position: fixed applied it grew to its content width, so the
      // right-alignment and the viewport clamp below were computed from a width the list no longer had. The width is now read in the
      // fixed layout (from left: 0, so a previous placement near the edge cannot squeeze it), and placed again once that layout exists.
      const el = list.current
      const prevLeft = el ? el.style.left : ''
      if (el && el.style.position === 'fixed') el.style.left = '0px'
      const w = el?.offsetWidth || 0
      if (el && el.style.position === 'fixed') el.style.left = prevLeft
      const maxLeft = Math.max(MARGIN, vw - w - MARGIN)
      if (align === 'left') setPos({ top, left: Math.min(Math.max(MARGIN, r.left), maxLeft), maxHeight: avail })
      else {
        const left = Math.min(Math.max(MARGIN, r.right - w), maxLeft)
        setPos({ top, left, maxHeight: avail })
      }
    }
    placeRef.current = place
    place()
    const onScroll = e => { if (!(e.target instanceof Node && list.current?.contains(e.target))) setOpen(false) }   // the target can be window/document
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', place)
    return () => { window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', place) }
  }, [open, align])

  // Second pass: the first placement ran in the pre-fixed layout (see place); once `pos` exists, measure again in the real one.
  const placed = pos !== null
  useLayoutEffect(() => { if (open && placed) placeRef.current?.() }, [open, placed])

  // Focus the requested item as soon as the menu is in the page; items leave the Tab order (arrows move within the menu).
  useEffect(() => {
    if (!open) return
    list.current?.querySelectorAll('[role="menuitem"]').forEach(el => el.setAttribute('tabindex', '-1'))
    const all = items()
    const target = focusOn.current === 'last' ? all[all.length - 1] : all[0]
    // Section 11 (round 16): this effect runs BEFORE the layout effect has moved the list to its fixed, possibly flipped position,
    // so the first item is still laid out below the trigger. A plain focus() scrolls it into view when the trigger sits near the
    // bottom of the viewport (the last table row), and the capture-phase scroll listener above closes the menu on any scroll that
    // does not start in the list - so the menu opened and shut in the same breath. The list is position: fixed once placed, so
    // there is nothing to scroll to.
    target?.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when it opens: a parent re-render must not steal focus back to item 1
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const onDown = e => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false) }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('mousedown', onDown) }
  }, [open])

  function onTriggerKeyDown(e) {
    // SHARED FRONTEND (section 11, round 19, bug): focus can be back on the trigger while the menu is open (a screen reader's
    // virtual cursor, a click that lands on the trigger's edge). Escape did nothing from there and Tab left the list hanging open.
    if (open && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return }
    if (open && e.key === 'Tab') { setOpen(false); return }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      focusOn.current = e.key === 'ArrowUp' ? 'last' : 'first'
      if (open) { const all = items(); (e.key === 'ArrowUp' ? all[all.length - 1] : all[0])?.focus() }
      else setOpen(true)
    }
  }

  function onMenuKeyDown(e) {
    const all = items()
    const at = all.indexOf(document.activeElement)
    let next = null
    // Focus not on an item (at = -1; an aria-disabled item that was clicked, say): ArrowDown goes to the first, ArrowUp to the LAST —
    // the arithmetic alone sent ArrowUp to the second-to-last.
    if (e.key === 'ArrowDown') next = all[(at + 1) % all.length]
    else if (e.key === 'ArrowUp') next = at < 0 ? all[all.length - 1] : all[(at - 1 + all.length) % all.length]
    else if (e.key === 'Home') next = all[0]
    else if (e.key === 'End') next = all[all.length - 1]
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return }
    else if (e.key === 'Tab') { close(); return }       // focus goes to the trigger FIRST, so Tab carries on from there
    else if ((e.key === ' ' || e.key === 'Enter') && at >= 0) {
      // SHARED FRONTEND (section 11, round 19, bug): the WAI-ARIA menu pattern activates an item on Enter AND Space. A <button>
      // does both natively, but a router <Link role="menuitem"> (ScanRow's "Scan this resume against another job") answers only
      // Enter — Space did nothing (and scrolled the page). Anything that is not natively activated by this key is clicked here.
      const el = all[at]
      const native = el.tagName === 'BUTTON' || (el.tagName === 'A' && el.hasAttribute('href') && e.key === 'Enter')
      if (!native) { e.preventDefault(); el.click() }
      return
    }
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ') {
      const ch = e.key.toLowerCase()
      const order = [...all.slice(at + 1), ...all.slice(0, at + 1)]
      next = order.find(el => (el.textContent || '').trim().toLowerCase().startsWith(ch)) || null
      if (next) { e.preventDefault(); next.focus() }
      return
    }
    if (next) { e.preventDefault(); next.focus() }
  }

  return (
    <div ref={wrap} className={cn('relative', className)}>
      <button
        ref={btn} type="button" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        aria-label={label}
        onClick={() => { focusOn.current = 'first'; setOpen(o => !o) }}
        onKeyDown={onTriggerKeyDown}
        className={cn('px-2.5 py-1.5 text-sm rounded-md border border-gray-300 text-gray-600 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500', triggerClassName)}
      >{trigger}</button>
      {open && (
        <div
          ref={list} id={menuId} role="menu" aria-label={label}
          onKeyDown={onMenuKeyDown}
          // Capture: focus is back on the trigger BEFORE the chosen item's own handler runs, so a dialog that item opens
          // remembers the trigger (still on the page) as where to return focus — not the item that is about to unmount.
          onClickCapture={e => { if (e.target instanceof Element && e.target.closest(ITEM)) close() }}
          style={pos ? { position: 'fixed', ...pos } : undefined}
          className={cn(!pos && 'absolute top-9', 'z-30 min-w-56 overflow-y-auto [&_[role=menuitem]:focus]:bg-gray-100 [&_[role=menuitem]:focus]:outline-none [&_[role=menuitem]:focus]:ring-2 [&_[role=menuitem]:focus]:ring-inset [&_[role=menuitem]:focus]:ring-blue-500 rounded-lg border border-gray-200 bg-white p-1 shadow-lg', !pos && (align === 'left' ? 'left-0' : 'right-0'), menuClassName)}
        >{children}</div>
      )}
    </div>
  )
}
