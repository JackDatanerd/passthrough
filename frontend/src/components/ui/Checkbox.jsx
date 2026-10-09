import { forwardRef, useEffect, useId, useRef } from 'react'
import { cn } from '../../lib/utils'

// Checkbox with an optional label. Seven checkboxes were hand-rolled with different
// sizes, colours and label wiring (two had NO accessible name beyond an aria-label
// typed per call site). With `label`, the whole row is clickable; without it, pass
// `aria-label`. Spread props (checked, onChange, disabled, …) go to the <input>.
const Checkbox = forwardRef(function Checkbox({ label, className, wrapperClassName, id, indeterminate, ...props }, ref) {
  const autoId = useId()
  const inputId = id || autoId
  const innerRef = useRef(null)
  // `indeterminate` (a "select all" box over a partly-selected list) is a DOM property, not an attribute.
  useEffect(() => { if (innerRef.current) innerRef.current.indeterminate = !!indeterminate }, [indeterminate])
  const setRefs = node => {
    innerRef.current = node
    if (typeof ref === 'function') ref(node)
    else if (ref) ref.current = node
  }
  const input = (
    <input
      ref={setRefs}
      id={inputId}
      type="checkbox"
      className={cn('h-4 w-4 rounded border-gray-300 text-blue-700 focus:ring-2 focus:ring-blue-500', className)}
      aria-checked={indeterminate ? 'mixed' : undefined}
      {...props}
    />
  )
  // Without a label the wrapper class (spacing, say) still applies, on a plain span around the box.
  if (!label) return wrapperClassName ? <span className={wrapperClassName}>{input}</span> : input
  return (
    <label htmlFor={inputId} className={cn('flex items-center gap-2 text-sm text-gray-700 cursor-pointer', wrapperClassName)}>
      {input}
      {label}
    </label>
  )
})

export default Checkbox
