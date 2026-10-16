import { computePointsLost } from '../../lib/pointsLost'
import { ATS_BADGE_THRESHOLD } from '../../lib/scoreThresholds'

// "Where your points went": the three biggest places the score loses points, worst first, each with the plain reason.
// Hidden when the server did not send the weights or the split cannot be made honestly.
export default function PointsLost({ scan }) {
  const res = computePointsLost(scan)
  if (!res || res.items.length === 0) return null
  const toLine = ATS_BADGE_THRESHOLD - scan.atsScore
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6" data-testid="points-lost">
      <h3 className="font-semibold text-gray-900">Where your points went</h3>
      <p className="text-sm text-gray-500 mt-0.5">
        {res.gap} of 100 points are missing{toLine > 0 ? `, and ${toLine} of them stand between you and the ${ATS_BADGE_THRESHOLD}` : ''}. Split by how much each part counts.
      </p>
      <ol className="mt-3 divide-y divide-gray-100">
        {res.items.slice(0, 3).map(i => (
          <li key={i.key} className="flex gap-4 py-2.5">
            <span className="w-10 shrink-0 text-lg font-bold text-red-600 tabular-nums">−{i.points}</span>
            <span>
              <span className="block text-sm font-medium text-gray-900">{i.label}</span>
              {i.reason && <span className="block text-sm text-gray-500">{i.reason}</span>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}
