import { forwardRef } from 'react'
import { cn } from '../../lib/utils'
import Spinner from './Spinner'

const variants = {
  primary:   'bg-blue-700 hover:bg-blue-800 text-white',
  secondary: 'bg-white hover:bg-gray-50 text-gray-700 border border-gray-300',
  danger:    'bg-red-600 hover:bg-red-700 text-white',
  ghost:     'bg-transparent hover:bg-gray-100 text-gray-600',
}

const sizes = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2 text-sm',
  lg: 'px-6 py-3 text-base',
}

// Shared with <ButtonLink> so a link styled as a button can never drift from a real one.
export function buttonClasses(variant = 'primary', size = 'md') {
  return cn(
    'inline-flex items-center justify-center gap-2 rounded-md font-medium',
    'transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2',
    'disabled:opacity-50 disabled:cursor-not-allowed',
    // `loading` does not use the native disabled attribute (see <Button>), so the same look hangs off aria-disabled.
    'aria-disabled:opacity-50 aria-disabled:cursor-not-allowed',
    variants[variant],
    sizes[size],
  )
}

// forwardRef so callers can focus a button programmatically (e.g. return focus
// to the control that opened a dialog), like Input/Select/Textarea already allow.
//
// SHARED FRONTEND (section 11 re-audit, bug): `loading` used to set the native `disabled` attribute. A disabled element cannot
// hold focus, so a keyboard or screen-reader user who pressed Save (or Confirm in a dialog) was dropped on <body> the moment the
// request started, and focus never came back when it finished — on every async button in the app. While loading, the button now
// stays focusable and is marked aria-disabled instead; clicks (and the Enter-key submit of the form it belongs to, which arrives
// as a click on a submit button) are swallowed here, so a second press still cannot fire the action twice. An explicit
// `disabled` is unchanged: that one is the caller saying the action is unavailable, not that it is in flight.
const Button = forwardRef(function Button({
  children, variant = 'primary', size = 'md',
  className, disabled, loading, type = 'button', onClick, ...props
}, ref) {
  return (
    <button
      ref={ref}
      type={type}
      onClick={loading ? e => e.preventDefault() : onClick}
      disabled={disabled}
      aria-disabled={loading && !disabled ? true : undefined}
      aria-busy={loading || undefined}
      className={cn(buttonClasses(variant, size), className)}
      {...props}
    >
      {loading && <Spinner size="sm" tone="current" decorative />}
      {children}
    </button>
  )
})

export default Button
