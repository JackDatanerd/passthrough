import { forwardRef, useId } from 'react'
import { cn } from '../../lib/utils'

// Changes vs. the original:
//  - id comes from useId(), not the label text. Two inputs with the same label
//    on one page used to get the same id (label clicks focused the wrong field,
//    and `.toLowerCase()` on a non-string label crashed the render).
//  - forwardRef, so callers can focus a field programmatically (e.g. the first
//    invalid one).
//  - `error` is wired to aria-invalid / aria-describedby and announced.
//  - an unlabeled input falls back to aria-label = placeholder, so it still has
//    an accessible name (several forms used placeholder-only fields).
const Input = forwardRef(function Input({ label, error, hint, className, id, ...props }, ref) {
  const autoId = useId()
  const inputId = id || autoId
  const describedBy = [error && `${inputId}-error`, hint && `${inputId}-hint`].filter(Boolean).join(' ') || undefined
  const ariaLabel = props['aria-label'] ?? (!label && props.placeholder ? props.placeholder : undefined)

  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-gray-700">
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={inputId}
        aria-label={ariaLabel}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn(
          'w-full rounded-md border px-3 py-2 text-sm text-gray-900 placeholder-gray-500',
          'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent',
          error ? 'border-red-400 bg-red-50' : 'border-gray-300 bg-white',
          className
        )}
        {...props}
      />
      {hint && !error && <p id={`${inputId}-hint`} className="text-xs text-gray-500">{hint}</p>}
      {error && <p id={`${inputId}-error`} role="alert" className="text-xs text-red-600">{error}</p>}
    </div>
  )
})

export default Input
