import { cn } from '../../lib/utils'

// A show/hide section built on the native <details>/<summary> (keyboard, find-in-page and no-JS behaviour for free). What was missing
// across the six hand-written ones is a visible keyboard focus ring on the summary — this adds it, and nothing else about the look:
// `className` styles the box, `summaryClassName` the clickable line.
//
//   <Disclosure summary="How crediting works" className="text-sm text-gray-500" summaryClassName="text-gray-600">…</Disclosure>
// Extra props (open, onToggle, id, data-*) go to the <details>.
export default function Disclosure({ summary, children, className, summaryClassName, ...props }) {
  return (
    <details className={className} {...props}>
      <summary className={cn('cursor-pointer rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500', summaryClassName)}>{summary}</summary>
      {children}
    </details>
  )
}
