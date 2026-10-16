import { useCallback, useEffect, useId, useRef, useState } from 'react'
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

  const items = useCallback(() => (list.current ? Array.from(list.current.querySelectorAll(ITEM)) : []), [])
  const close = useCallback((restoreFocus = true) => {
    setOpen(false)
    if (restoreFocus) btn.current?.focus()
  }, [])

  // Focus the requested item as soon as the menu is in the page; items leave the Tab order (arrows move within the menu).
  useEffect(() => {
    if (!open) return
    list.current?.querySelectorAll('[role="menuitem"]').forEach(el => el.setAttribute('tabindex', '-1'))
    const all = items()
    const target = focusOn.current === 'last' ? all[all.length - 1] : all[0]
    target?.focus()
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
    if (e.key === 'ArrowDown') next = all[(at + 1) % all.length]
    else if (e.key === 'ArrowUp') next = all[(at - 1 + all.length) % all.length]
    else if (e.key === 'Home') next = all[0]
    else if (e.key === 'End') next = all[all.length - 1]
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return }
    else if (e.key === 'Tab') { close(); return }       // focus goes to the trigger FIRST, so Tab carries on from there
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
          onClickCapture={() => close()}
          className={cn('absolute top-9 z-10 min-w-56 rounded-lg border border-gray-200 bg-white p-1 shadow-lg', align === 'left' ? 'left-0' : 'right-0', menuClassName)}
        >{children}</div>
      )}
    </div>
  )
}
