import { forwardRef, useId } from 'react'
import { cn } from '../../lib/utils'

// See Input.jsx for what changed and why (useId, forwardRef, aria wiring).
const Textarea = forwardRef(function Textarea({ label, error, hint, className, id, rows = 5, ...props }, ref) {
  const autoId = useId()
  const inputId = id || autoId
  // BUG FIX (Section 11 audit): see Input.jsx — describedBy used to
  // reference `${inputId}-hint` even when the hint <p> wasn't rendered
  // (it only renders when `hint && !error`), a dangling ARIA reference.
  const describedBy = [error && `${inputId}-error`, hint && !error && `${inputId}-hint`].filter(Boolean).join(' ') || undefined
  const ariaLabel = props['aria-label'] ?? (!label && props.placeholder ? props.placeholder : undefined)

  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-gray-700">
          {label}
        </label>
      )}
      <textarea
        ref={ref}
        id={inputId}
        rows={rows}
        aria-label={ariaLabel}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn(
          'w-full rounded-md border px-3 py-2 text-sm text-gray-900 placeholder-gray-500',
          'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y',
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

export default Textarea
