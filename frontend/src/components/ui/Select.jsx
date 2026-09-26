import { forwardRef, useId } from 'react'
import { cn } from '../../lib/utils'

// FEATURE GAP CLOSED (Section 11 audit): every filter/admin <select> re-typed
// the same border/padding classes independently — AdminPayments, AdminScans,
// AdminUsers, AdminWebhooks, AdminLeads (four of them), and dashboard/Index —
// exactly the copy-paste Pagination.jsx already called out and fixed ("one
// shared component instead of seven near-identical copies"), just never
// extended to selects. Three of those (AdminPayments, AdminScans, AdminUsers)
// also had a <label> with no htmlFor at all, so clicking the label never
// focused the field and a screen reader had no reliable link between the
// two — using this component closes that for free, the same way Input.jsx's
// useId wiring already does for every text field.
//
// See Input.jsx for what else this mirrors (useId, forwardRef, aria wiring).
// Takes <option>/<optgroup> children exactly like a native <select> — every
// call site's option list was different enough (conditional labels, mixed
// literals + a `.map`) that an `options` array prop would just move that
// same logic into a prop instead of removing it.
//
// `size` (mirrors Button.jsx's sizes) is a real prop, not left to className:
// cn() only concatenates (see its own comment in lib/utils.js), so a caller
// wanting a compact select — AdminLeads' per-row status select, AdminSystem-
// Health's log filter, both `px-2 py-1 text-xs` instead of the default
// `px-3 py-2 text-sm` — would otherwise be fighting three conflicting
// utility pairs at once via className, with the winner decided by stylesheet
// order rather than anything visible at the call site.
const sizes = {
  md: 'px-3 py-2 text-sm',
  sm: 'px-2 py-1 text-xs',
}

const Select = forwardRef(function Select({ label, error, hint, className, id, size = 'md', children, ...props }, ref) {
  const autoId = useId()
  const selectId = id || autoId
  const describedBy = [error && `${selectId}-error`, hint && `${selectId}-hint`].filter(Boolean).join(' ') || undefined

  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={selectId} className="text-sm font-medium text-gray-700">
          {label}
        </label>
      )}
      <select
        ref={ref}
        id={selectId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn(
          'w-full rounded-md border text-gray-900 bg-white',
          'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent',
          sizes[size] || sizes.md,
          error ? 'border-red-400 bg-red-50' : 'border-gray-300',
          className
        )}
        {...props}
      >
        {children}
      </select>
      {hint && !error && <p id={`${selectId}-hint`} className="text-xs text-gray-500">{hint}</p>}
      {error && <p id={`${selectId}-error`} role="alert" className="text-xs text-red-600">{error}</p>}
    </div>
  )
})

export default Select
