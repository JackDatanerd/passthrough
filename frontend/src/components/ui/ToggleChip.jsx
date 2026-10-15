import { forwardRef } from 'react'
import { cn } from '../../lib/utils'

// FEATURE GAP CLOSED (Shared frontend re-audit, G1): the selectable "filter pill" was hand-rolled in at least six places (the
// dashboard's scan filter, ScanForm's entry-mode switch, three homepage sections, AdminLeads' status filter) with different
// classes and, worse, different accessibility: AdminLeads' five-plus status buttons had no type, no `aria-pressed` and no focus
// ring, so which filter was on was shown by colour alone and a keyboard user could not see where focus was. One component keeps
// the state announced (`aria-pressed`), the focus ring and `type="button"` identical everywhere.
//
//   <div role="group" aria-label="Filter scans" className="flex flex-wrap gap-2">
//     <ToggleChip pressed={status === 'OPEN'} onClick={() => setStatus('OPEN')}>Open (3)</ToggleChip>
//   </div>
//
// `tone`: 'blue' (the dashboard's) or 'dark' (the admin console's). `size`: 'md' (text-sm) or 'sm' (text-xs). Extra props
// (title, disabled, data-*) go to the <button>.
const TONES = {
  blue: { on: 'bg-blue-700 border-blue-700 text-white', off: 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50' },
  dark: { on: 'bg-gray-900 border-gray-900 text-white', off: 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50' },
}
const SIZES = { md: 'px-3 py-1 text-sm font-medium', sm: 'px-3 py-1.5 text-xs' }

const ToggleChip = forwardRef(function ToggleChip({ pressed = false, tone = 'blue', size = 'md', className, children, type = 'button', ...props }, ref) {
  const t = TONES[tone] || TONES.blue
  return (
    <button
      ref={ref}
      type={type}
      aria-pressed={!!pressed}
      className={cn(
        'rounded-full border transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        SIZES[size] || SIZES.md,
        pressed ? t.on : t.off,
        className
      )}
      {...props}
    >
      {children}
    </button>
  )
})

export default ToggleChip
