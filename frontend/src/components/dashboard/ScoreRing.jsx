import { ATS_PASS_THRESHOLD } from '../../lib/scoreThresholds'
import { cn } from '../../lib/utils'

// The score as a ring. Colour follows the same bands the rest of the app uses (pass / marginal / low).
export const scoreBand = n => (n == null ? 'none' : n >= ATS_PASS_THRESHOLD ? 'good' : n >= 50 ? 'mid' : 'low')
const STROKE = { good: 'stroke-green-600', mid: 'stroke-amber-500', low: 'stroke-red-600', none: 'stroke-gray-300' }
const BAR = { good: 'bg-green-600', mid: 'bg-amber-500', low: 'bg-red-600', none: 'bg-gray-300' }
export const barColor = n => BAR[scoreBand(n)]

export default function ScoreRing({ score, size = 'md', className }) {
  const band = scoreBand(score)
  const big = size === 'lg'
  return (
    <div role="img" aria-label={score == null ? 'No score yet' : `Score ${score} out of 100`}
      className={cn('relative shrink-0', big ? 'h-16 w-16' : 'h-12 w-12', className)}>
      <svg viewBox="0 0 36 36" className="h-full w-full -rotate-90" aria-hidden="true">
        <circle cx="18" cy="18" r="15.9" fill="none" strokeWidth="3.5" className="stroke-gray-200" />
        {score != null && (
          <circle cx="18" cy="18" r="15.9" fill="none" strokeWidth="3.5" strokeLinecap="round" pathLength="100"
            strokeDasharray={`${Math.max(0, Math.min(100, score))} 100`} className={STROKE[band]} />
        )}
      </svg>
      <span className={cn('absolute inset-0 flex items-center justify-center font-bold text-gray-900', big ? 'text-lg' : 'text-sm')}>
        {score ?? '·'}
      </span>
    </div>
  )
}
