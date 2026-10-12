import { cn } from '../../lib/utils'

// "Nothing here" line for lists and tables. Eight pages each hand-wrote their own
// `<p className="text-sm text-gray-500">No … found.</p>`, with different colours
// (and one italic). Optional `action` (a Button/link) for "Create the first one".
//
// cn() only concatenates, so a caller's own text colour used to sit NEXT TO the default one and lose to it
// (the later class in the stylesheet wins, and gray-500 is emitted after gray-400). The default colour is dropped
// when the caller supplies theirs — same approach as Alert's text size.
const TEXT_COLOR = /(?:^|\s)text-(?:white|black|(?:gray|slate|red|green|amber|blue|emerald)-\d{2,3})(?:\s|$)/

export default function EmptyState({ children, action, className }) {
  // Text goes in a <p>; a block-level node (DataTable's `empty` prop accepts one) must not be nested inside it.
  const inline = typeof children === 'string' || typeof children === 'number' || Array.isArray(children)
  const Body = inline ? 'p' : 'div'
  return (
    <div role="status" className={cn('text-sm', !TEXT_COLOR.test(className || '') && 'text-gray-500', className)}>
      <Body>{children}</Body>
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
