import { forwardRef, useId } from 'react'
import { cn } from '../../lib/utils'
import FieldError from './FieldError'
import { useCharCount, FieldFooter } from './CharCount'

// Changes vs. the original:
//  - id comes from useId(), not the label text. Two inputs with the same label
//    on one page used to get the same id (label clicks focused the wrong field,
//    and `.toLowerCase()` on a non-string label crashed the render).
//  - forwardRef, so callers can focus a field programmatically (e.g. the first
//    invalid one).
//  - `error` is wired to aria-invalid / aria-describedby and announced.
//  - an unlabeled input falls back to aria-label = placeholder, so it still has
//    an accessible name (several forms used placeholder-only fields).
// `size="sm"` is the compact field used in toolbars and inline forms (search boxes, a rename field) — those had hand-rolled
// `<input>`s because the only size here was the full form-field one. (It shadows the native `size` attribute, as Select's does.)
const Input = forwardRef(function Input({ label, error, hint, className, wrapperClassName, id, endAdornment, size = 'md', 'aria-describedby': extraDescribedBy, showCount = false, ...props }, ref) {
  const autoId = useId()
  const inputId = id || autoId
  // BUG FIX (Section 11 audit): this used to include `${inputId}-hint`
  // whenever `hint` was truthy, with no check for `error` — but the hint
  // <p> below only renders when `hint && !error`. Passing both props at
  // once (no call site does yet, but nothing stopped a future one) left
  // aria-describedby pointing at an id that didn't exist in the DOM: a
  // dangling ARIA reference, exactly what axe/screen readers flag.
  const describedBy = [error && `${inputId}-error`, hint && !error && `${inputId}-hint`].concat(extraDescribedBy || []).filter(Boolean).join(' ') || undefined
  // showCount (with maxLength): an "n/limit" counter that also reports a paste the browser cut short — see CharCount.jsx.
  const { handlers, counter } = useCharCount({ enabled: showCount, maxLength: props.maxLength, value: props.value, defaultValue: props.defaultValue, onChange: props.onChange, onPaste: props.onPaste, onBlur: props.onBlur })
  const ariaLabel = props['aria-label'] ?? (!label && props.placeholder ? props.placeholder : undefined)

  const control = (
    <input
      ref={ref}
      id={inputId}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      className={cn(
        'w-full rounded-md border px-3 text-gray-900 placeholder-gray-500',
        size === 'sm' ? 'py-1.5 text-base sm:text-sm' : 'py-2.5 text-base sm:py-2 sm:text-sm',
        'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent',
        error ? 'border-red-400 bg-red-50' : 'border-gray-300 bg-white',
        'disabled:bg-gray-100 disabled:text-gray-500 disabled:cursor-not-allowed',
        className
      )}
      {...props}
      {...handlers}
      aria-invalid={error ? true : props['aria-invalid']}   // after the spread: an error always marks the field invalid
    />
  )

  // `endAdornment` (e.g. PasswordInput's Show/Hide button) is positioned over the control's right edge.
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
      {endAdornment ? (
        <div className="relative">
          {control}
          {endAdornment}
        </div>
      ) : control}
      <FieldFooter counter={counter}>
        {hint && !error && <p id={`${inputId}-hint`} className="text-xs text-gray-500">{hint}</p>}
        <FieldError id={`${inputId}-error`}>{error}</FieldError>
      </FieldFooter>
    </div>
  )
})

export default Input
