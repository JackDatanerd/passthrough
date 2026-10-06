import { Link } from 'react-router-dom'
import { cn } from '../../lib/utils'
import { buttonClasses } from './Button'

// A router <Link> that looks exactly like <Button> (same variants and sizes), for
// navigation that should read as a button without being a <button> that calls navigate().
export default function ButtonLink({ variant = 'primary', size = 'md', className, ...props }) {
  return <Link className={cn(buttonClasses(variant, size), className)} {...props} />
}
