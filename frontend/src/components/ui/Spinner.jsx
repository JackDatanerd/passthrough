import { cn } from '../../lib/utils'

const sizes = { sm: 'h-4 w-4', md: 'h-6 w-6', lg: 'h-10 w-10' }

// `tone="current"` inherits the surrounding text colour (inside a coloured <Button>);
// the default is the brand blue. `decorative` hides it from assistive tech when the
// parent already announces the busy state (Button sets aria-busy).
export default function Spinner({ size = 'md', className, label = 'Loading', tone = 'brand', decorative = false }) {
  return (
    <svg
      {...(decorative ? { 'aria-hidden': true } : { role: 'status', 'aria-label': label })}
      className={cn('animate-spin', tone === 'brand' && 'text-blue-600', sizes[size], className)}
      fill="none" viewBox="0 0 24 24"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10"
        stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  )
}
