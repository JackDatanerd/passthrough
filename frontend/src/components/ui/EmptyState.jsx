import { cn } from '../../lib/utils'

// "Nothing here" line for lists and tables. Eight pages each hand-wrote their own
// `<p className="text-sm text-gray-500">No … found.</p>`, with different colours
// (and one italic). Optional `action` (a Button/link) for "Create the first one".
export default function EmptyState({ children, action, className }) {
  return (
    <div role="status" className={cn('text-sm text-gray-500', className)}>
      <p>{children}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
