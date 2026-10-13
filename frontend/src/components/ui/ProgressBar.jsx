import { cn } from '../../lib/utils'

// Determinate progress (an upload) or, with no `value`, an indeterminate "working" bar. Announced as a progressbar with
// a text value, so a screen reader hears "Uploading 40%" rather than nothing. At 100 the bytes are sent but the server
// may still be working, so the label can change (`doneLabel`) instead of the bar looking stuck.
//
//   <ProgressBar value={progress} label="Uploading your resume" doneLabel="Reading your resume…" />
export default function ProgressBar({ value, label = 'Progress', doneLabel, className }) {
  const known = typeof value === 'number' && Number.isFinite(value)
  const pct = known ? Math.max(0, Math.min(100, Math.round(value))) : null
  const text = pct === 100 && doneLabel ? doneLabel : pct === null ? label : `${label} ${pct}%`
  return (
    <div className={cn('w-full', className)}>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        aria-valuetext={text}
        className="h-2 w-full overflow-hidden rounded-full bg-gray-200"
      >
        <div
          className={cn('h-full rounded-full bg-blue-600 transition-[width] duration-200 motion-reduce:transition-none',
            pct === null && 'w-1/3 animate-pulse')}
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </div>
      <p className="mt-1 text-xs text-gray-600" aria-hidden="true">{text}</p>
    </div>
  )
}
