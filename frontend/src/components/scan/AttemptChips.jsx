import { ATS_BADGE_THRESHOLD } from '../../lib/scoreThresholds'

// One chip per real rewrite attempt, with that attempt's real score. `working` adds a chip for the attempt in progress.
export default function AttemptChips({ scores, working, testId = 'fix-attempts' }) {
  const list = Array.isArray(scores) ? scores.filter(n => typeof n === 'number') : []
  if (list.length === 0 && !working) return null
  return (
    <div className="flex flex-wrap gap-2" data-testid={testId}>
      {list.map((n, i) => (
        <span key={i}
          className={`text-xs font-semibold rounded-full border px-2.5 py-0.5 ${n >= ATS_BADGE_THRESHOLD ? 'border-green-600 text-green-700' : 'border-gray-300 text-gray-600'}`}>
          Attempt {i + 1}: {n}
        </span>
      ))}
      {working && (
        <span className="text-xs font-semibold rounded-full border border-blue-300 text-blue-700 px-2.5 py-0.5">{working}</span>
      )}
    </div>
  )
}
