import { forwardRef, useId } from 'react'
import { cn } from '../../lib/utils'

// Radio with a label — the counterpart of Checkbox (same row layout, sizes and colours). The one hand-rolled pair of
// radios in the app (which version of a resume to save) had no shared component to use. Group them in a <fieldset> with a
// <legend> and give each the same `name`; spread props (checked, onChange, disabled, value, …) go to the <input>.
// `size="sm"` is the compact text-xs row used inside cards.
const Radio = forwardRef(function Radio({ label, description, size = 'md', className, wrapperClassName, id, ...props }, ref) {
  const autoId = useId()
  const inputId = id || autoId
  const disabled = !!props.disabled || props['aria-disabled'] === true || props['aria-disabled'] === 'true'
  const input = (
    <input
      ref={ref}
      id={inputId}
      type="radio"
      className={cn('h-4 w-4 border-gray-300 text-blue-700 focus:ring-2 focus:ring-blue-500', className)}
      {...props}
    />
  )
  if (!label) return wrapperClassName ? <span className={wrapperClassName}>{input}</span> : input
  return (
    <label
      htmlFor={inputId}
      className={cn(
        'inline-flex gap-2 text-gray-700',
        size === 'sm' ? 'text-xs' : 'text-sm',
        description ? 'items-start' : 'items-center',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
        wrapperClassName
      )}
    >
      {description ? <span className="mt-0.5 flex">{input}</span> : input}
      {description ? (
        <span>
          <span className="block">{label}</span>
          <span className="block text-gray-500">{description}</span>
        </span>
      ) : label}
    </label>
  )
})

export default Radio
