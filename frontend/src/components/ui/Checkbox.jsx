import { forwardRef, useEffect, useId, useRef } from 'react'
import { cn } from '../../lib/utils'

// Checkbox with an optional label. Seven checkboxes were hand-rolled with different
// sizes, colours and label wiring (two had NO accessible name beyond an aria-label
// typed per call site). With `label`, the whole row is clickable; without it, pass
// `aria-label`. Spread props (checked, onChange, disabled, …) go to the <input>.
//
// `description` is a second, quieter line under the label (what the option actually does) and `error`
// a message tied to the box (aria-invalid + aria-describedby, announced when it appears) — the two
// things the hand-rolled consent / preference checkboxes (Register's terms, Settings' email opt-in)
// had to build themselves because this component had neither. Both need a `label`.
const Checkbox = forwardRef(function Checkbox({ label, description, error, alignTop, className, wrapperClassName, id, indeterminate, ...props }, ref) {
  const autoId = useId()
  const inputId = id || autoId
  const noteId = `${inputId}-note`
  const showError = !!(label && error)   // description lives inside the <label>, so it is part of the name
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
      aria-invalid={showError ? true : undefined}
      aria-describedby={showError ? noteId : undefined}
      {...props}
    />
  )
  // Without a label the wrapper class (spacing, say) still applies, on a plain span around the box.
  if (!label) return wrapperClassName ? <span className={wrapperClassName}>{input}</span> : input
  // Multi-line text (a description, or a long consent sentence — `alignTop`) keeps the box on the first line.
  const top = !!description || !!alignTop
  const disabled = !!props.disabled
  const row = (
    <label
      htmlFor={inputId}
      className={cn(
        'flex gap-2 text-sm text-gray-700',
        top ? 'items-start' : 'items-center',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
        !showError && wrapperClassName
      )}
    >
      {top ? <span className="mt-0.5 flex">{input}</span> : input}
      {description ? (
        <span>
          <span className="block">{label}</span>
          <span className="block text-gray-500">{description}</span>
        </span>
      ) : label}
    </label>
  )
  if (!showError) return row
  // The error sits outside the <label> so clicking it doesn't toggle the box; it is the live region.
  return (
    <div className={wrapperClassName}>
      {row}
      <p id={noteId} role="alert" className="mt-1 text-sm text-red-600">{error}</p>
    </div>
  )
})

export default Checkbox
