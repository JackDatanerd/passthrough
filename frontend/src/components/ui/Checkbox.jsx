import { forwardRef, useId } from 'react'
import { cn } from '../../lib/utils'

// Checkbox with an optional label. Seven checkboxes were hand-rolled with different
// sizes, colours and label wiring (two had NO accessible name beyond an aria-label
// typed per call site). With `label`, the whole row is clickable; without it, pass
// `aria-label`. Spread props (checked, onChange, disabled, …) go to the <input>.
const Checkbox = forwardRef(function Checkbox({ label, className, wrapperClassName, id, ...props }, ref) {
  const autoId = useId()
  const inputId = id || autoId
  const input = (
    <input
      ref={ref}
      id={inputId}
      type="checkbox"
      className={cn('h-4 w-4 rounded border-gray-300 text-blue-700 focus:ring-2 focus:ring-blue-500', className)}
      {...props}
    />
  )
  if (!label) return input
  return (
    <label htmlFor={inputId} className={cn('flex items-center gap-2 text-sm text-gray-700 cursor-pointer', wrapperClassName)}>
      {input}
      {label}
    </label>
  )
})

export default Checkbox
