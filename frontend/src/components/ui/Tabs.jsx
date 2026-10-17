import { useRef } from 'react'
import { cn } from '../../lib/utils'

// Tabs with the keyboard model role="tablist" promises (WAI-ARIA tabs, automatic activation): one tab stop (the selected tab; the
// others are tabindex -1), Left / Right move AND select (wrapping), Home / End jump to the first / last. It was hand-rolled once
// (the homepage's "where to put your link"), so the next tab strip would have had to redo all of it.
//
//   <Tabs idPrefix="home" ariaLabel="Where to put your link" tabs={[{ id: 'a', label: 'A' }, …]} value={active} onChange={setActive}
//     tabClassName={on => (on ? 'text-blue-700 border-blue-700' : 'text-gray-500 border-transparent')} />
//   <TabPanel idPrefix="home" value={active}>…the selected tab's content…</TabPanel>
// ids are `${idPrefix}-tab-${id}` / `${idPrefix}-panel-${id}` (tabId / panelId), so the pair stays wired without bookkeeping.
export const tabId = (prefix, id) => `${prefix}-tab-${id}`
export const panelId = (prefix, id) => `${prefix}-panel-${id}`

export function Tabs({ tabs, value, onChange, idPrefix, ariaLabel, className, tabClassName }) {
  const refs = useRef({})
  const enabled = tabs.filter(t => !t.disabled)

  function onKeyDown(e, id) {
    const at = enabled.findIndex(t => t.id === id)
    let next = null
    if (e.key === 'ArrowRight') next = enabled[(at + 1) % enabled.length]
    else if (e.key === 'ArrowLeft') next = enabled[(at - 1 + enabled.length) % enabled.length]
    else if (e.key === 'Home') next = enabled[0]
    else if (e.key === 'End') next = enabled[enabled.length - 1]
    if (!next) return
    e.preventDefault()
    onChange?.(next.id)
    refs.current[next.id]?.focus()
  }

  return (
    <div role="tablist" aria-label={ariaLabel} className={className}>
      {tabs.map(t => {
        const on = t.id === value
        return (
          <button
            key={t.id}
            ref={el => { refs.current[t.id] = el }}
            type="button"
            role="tab"
            id={tabId(idPrefix, t.id)}
            aria-selected={on}
            aria-controls={panelId(idPrefix, t.id)}
            tabIndex={on ? 0 : -1}
            disabled={t.disabled}
            onClick={() => onChange?.(t.id)}
            onKeyDown={e => onKeyDown(e, t.id)}
            className={typeof tabClassName === 'function' ? tabClassName(on, t) : tabClassName}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

export function TabPanel({ idPrefix, value, className, children }) {
  return (
    <div role="tabpanel" id={panelId(idPrefix, value)} aria-labelledby={tabId(idPrefix, value)} className={className}>
      {children}
    </div>
  )
}

export default Tabs
