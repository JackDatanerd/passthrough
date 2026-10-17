import { forwardRef, useEffect } from 'react'
import { cn } from '../../lib/utils'

// An on/off setting that takes effect immediately (a notification preference), as opposed to a Checkbox that is submitted with a
// form. role="switch" + aria-checked, named by `label` (read by assistive tech; draw the visible text next to it yourself).
// `onChange(next)` gets the NEW state; the parent owns `checked`, so a save that fails can leave the switch where it was.
//
//   <Switch label="Email me for each sale" checked={on} onChange={toggle} disabled={saving} />
const Switch = forwardRef(function Switch({ checked, onChange, label, disabled = false, className, ...props }, ref) {
  const unnamed = !label && !props['aria-label'] && !props['aria-labelledby']
  useEffect(() => {
    if (unnamed && import.meta.env?.DEV && import.meta.env?.MODE !== 'test')
      console.warn('<Switch> has no accessible name: pass `label`, `aria-label` or `aria-labelledby`.')
  }, [unnamed])
  const on = !!checked
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => { if (!disabled) onChange?.(!on) }}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors motion-reduce:transition-none',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2',
        on ? 'bg-blue-600' : 'bg-gray-300',
        'disabled:opacity-60 disabled:cursor-not-allowed',
        className
      )}
      {...props}
    >
      {label && <span className="sr-only">{label}</span>}
      <span className={cn('inline-block h-5 w-5 transform rounded-full bg-white transition-transform motion-reduce:transition-none', on ? 'translate-x-5' : 'translate-x-0.5')} />
    </button>
  )
})

export default Switch
