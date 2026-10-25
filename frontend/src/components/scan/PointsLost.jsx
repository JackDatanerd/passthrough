import { Link } from 'react-router-dom'
import { computePointsLost } from '../../lib/pointsLost'

// "The three biggest reasons" (or, with `all`, "Every point lost"): the places the score loses points, worst first, each with the
// plain reason. Hidden when the server did not send the weights or the split cannot be made honestly.
export default function PointsLost({ scan, all = false, seeAllTo = null }) {
  const res = computePointsLost(scan)
  if (!res || res.items.length === 0) return null
  const items = all ? res.items : res.items.slice(0, 3)
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm" data-testid="points-lost">
      <h3 className="mb-2.5 text-lg font-semibold text-gray-900">{all ? 'Every point lost' : 'The three biggest reasons'}</h3>
      <ol>
        {items.map(i => (
          <li key={i.key} className="flex items-start gap-3 border-t border-gray-100 py-[11px] first:border-t-0">
            <span className="min-w-[46px] flex-none rounded-lg bg-red-50 px-2 py-[3px] text-center text-sm font-bold tabular-nums text-red-700">{'\u2212'}{i.points}</span>
            <span>
              <b className="block text-sm text-gray-900">{i.label}</b>
              {i.reason && <span className="text-sm text-gray-600">{i.reason}</span>}
            </span>
          </li>
        ))}
      </ol>
      {!all && seeAllTo && res.items.length > 3 && (
        <p className="mt-2"><Link to={seeAllTo} className="text-sm font-bold text-blue-700 underline underline-offset-2">See all {res.items.length} reasons →</Link></p>
      )}
    </div>
  )
}
