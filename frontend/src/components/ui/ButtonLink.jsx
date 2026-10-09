import { forwardRef } from 'react'
import { Link } from 'react-router-dom'
import { cn } from '../../lib/utils'
import { buttonClasses } from './Button'

// A router <Link> that looks exactly like <Button> (same variants and sizes), for
// navigation that should read as a button without being a <button> that calls navigate().
// `disabled` renders an inert, announced-as-disabled element instead of a live link (a link has no
// disabled state of its own). forwardRef so callers can focus it, like <Button>.
const ButtonLink = forwardRef(function ButtonLink({ variant = 'primary', size = 'md', className, disabled = false, children, ...props }, ref) {
  if (disabled) {
    return (
      <span ref={ref} role="link" aria-disabled="true"
        className={cn(buttonClasses(variant, size), 'opacity-50 cursor-not-allowed', className)}>
        {children}
      </span>
    )
  }
  return <Link ref={ref} className={cn(buttonClasses(variant, size), className)} {...props}>{children}</Link>
})

export default ButtonLink
