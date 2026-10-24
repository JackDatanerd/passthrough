import { forwardRef, useId } from 'react'
import { cn } from '../../lib/utils'
import FieldError from './FieldError'
import { useCharCount, FieldFooter } from './CharCount'

// See Input.jsx for what changed and why (useId, forwardRef, aria wiring).
// `size="sm"` is the compact box for table cells and inline notes (a per-row note field), like Input's and Select's.
// `pending`: see Input.jsx — read-only + aria-disabled instead of the native `disabled`, so focus is kept while a request runs.
const Textarea = forwardRef(function Textarea({ label, error, hint, className, wrapperClassName, id, rows = 5, size = 'md', 'aria-describedby': extraDescribedBy, showCount = false, pending = false, ...props }, ref) {
  const autoId = useId()
  const inputId = id || autoId
  // BUG FIX (Section 11 audit): see Input.jsx — describedBy used to
  // reference `${inputId}-hint` even when the hint <p> wasn't rendered
  // (it only renders when `hint && !error`), a dangling ARIA reference.
  const describedBy = [error && `${inputId}-error`, hint && !error && `${inputId}-hint`].concat(extraDescribedBy || []).filter(Boolean).join(' ') || undefined
  // showCount (with maxLength): an "n/limit" counter that also reports a paste the browser cut short — see CharCount.jsx.
  const { handlers, counter } = useCharCount({ enabled: showCount, maxLength: props.maxLength, value: props.value, defaultValue: props.defaultValue, onChange: props.onChange, onPaste: props.onPaste, onBlur: props.onBlur })
  const ariaLabel = props['aria-label'] ?? (!label && props.placeholder ? props.placeholder : undefined)

  // Width/margin belong on `wrapperClassName`: a `w-*` in `className` lands on the control next to
  // its own `w-full`, and Tailwind emits w-full last, so it silently wins.
  return (
    <div className={cn('flex flex-col gap-1', wrapperClassName)}>
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-gray-700">
          {label}
          {props.required && <span aria-hidden="true" className="text-red-600"> *</span>}
        </label>
      )}
      <textarea
        ref={ref}
        id={inputId}
        rows={rows}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        className={cn(
          'w-full rounded-md border text-gray-900 placeholder-gray-500',
          size === 'sm' ? 'px-2 py-1 text-base sm:text-xs' : 'px-3 py-2 text-base sm:text-sm',
          'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y',
          error ? 'border-red-400 bg-red-50' : 'border-gray-300 bg-white',
        'disabled:bg-gray-100 disabled:text-gray-500 disabled:cursor-not-allowed aria-disabled:bg-gray-100 aria-disabled:text-gray-500',
          className
        )}
        {...props}
        {...handlers}
        {...(pending ? { readOnly: true, 'aria-disabled': true } : {})}
        aria-invalid={error ? true : props['aria-invalid']}   // after the spread: an error always marks the field invalid
      />
      <FieldFooter counter={counter}>
        {hint && !error && <p id={`${inputId}-hint`} className="text-xs text-gray-500">{hint}</p>}
        <FieldError id={`${inputId}-error`}>{error}</FieldError>
      </FieldFooter>
    </div>
  )
})

export default Textarea
