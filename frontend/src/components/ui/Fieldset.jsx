import { useId } from 'react'
import { cn } from '../../lib/utils'
import FieldError from './FieldError'

// A named group of related controls (a set of checkboxes, a pair of radios): a real <fieldset> with a <legend>, so a screen reader
// announces the group's name when focus enters it, with an optional hint and error tied to the group (aria-describedby). It was
// hand-rolled three times, each with its own legend styling.
//
//   <Fieldset legend="Also hiring in (up to 4)" error={tooMany ? 'Pick at most 4.' : undefined}>
//     <Checkbox label="Design" … />
//   </Fieldset>
// `srOnlyLegend` keeps the name for assistive tech but draws no text (the surrounding UI already says it).
export default function Fieldset({ legend, srOnlyLegend = false, legendClassName, hint, error, className, children }) {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const describedBy = [error && errorId, hint && !error && hintId].filter(Boolean).join(' ') || undefined
  return (
    <fieldset className={className} aria-describedby={describedBy}>
      <legend className={cn(srOnlyLegend ? 'sr-only' : 'text-sm font-medium text-gray-700 mb-1', legendClassName)}>{legend}</legend>
      {hint && !error && <p id={hintId} className="text-xs text-gray-500 mb-1">{hint}</p>}
      {children}
      <FieldError id={errorId}>{error}</FieldError>
    </fieldset>
  )
}
