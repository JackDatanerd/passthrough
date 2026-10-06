import { cn } from '../../lib/utils'

// Inline notice box. The red "something failed" box was hand-written, with
// slightly different borders, radii and text colours, in ScanForm, Login,
// ResumeDataEditor, SavedProfileEditor, dashboard/Index, ScanResult (twice) and
// PartnerDetail. One component keeps them identical and gives every one the
// right live-region role: errors are announced assertively, the rest politely.
const variants = {
  error:   'bg-red-50 border-red-200 text-red-800',
  warning: 'bg-amber-50 border-amber-200 text-amber-800',
  success: 'bg-green-50 border-green-200 text-green-800',
  info:    'bg-blue-50 border-blue-200 text-blue-800',
}

export default function Alert({ variant = 'error', className, children, ...props }) {
  if (children === null || children === undefined || children === false || children === '') return null
  return (
    <div
      role={variant === 'error' ? 'alert' : 'status'}
      className={cn('rounded-md border px-3 py-2 text-sm', variants[variant] || variants.error, className)}
      {...props}
    >
      {children}
    </div>
  )
}
