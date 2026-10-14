import { Link } from 'react-router-dom'
import { ATS_PASS_THRESHOLD } from '../../lib/scoreThresholds'
import { resetTimeLabel } from '../../lib/quota'

function Card({ label, children, note }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
      <p className="text-xs text-gray-500">{label}</p>
      <div className="text-2xl font-bold text-gray-900 leading-tight">{children}</div>
      {note && <p className="text-xs text-gray-500 mt-0.5">{note}</p>}
    </div>
  )
}

function Spark({ points }) {
  if (points.length < 2) return null
  const y = v => (28 - (v / 100) * 28).toFixed(1)
  const xy = points.map((v, i) => `${((i * 100) / (points.length - 1)).toFixed(1)},${y(v)}`)
  const [ex, ey] = xy[xy.length - 1].split(',')
  return (
    <svg viewBox="0 0 100 30" className="mt-1 h-7 w-full text-gray-400" role="img" aria-label={`Best score rose from ${points[0]} to ${points[points.length - 1]}`}>
      <line x1="0" x2="100" y1={y(ATS_PASS_THRESHOLD)} y2={y(ATS_PASS_THRESHOLD)} stroke="currentColor" strokeOpacity=".4" strokeDasharray="2 3" />
      <polyline points={xy.join(' ')} fill="none" stroke="#1d4ed8" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={ex} cy={ey} r="2.6" fill="#1d4ed8" />
    </svg>
  )
}

// Four small facts. Best score / credentials come from the newest scans (see Index.jsx), the allowance from /profile/quota.
export default function StatsRow({ best, trend, verifiedCount, quota, credits, partial }) {
  const hasQuota = quota && Number.isFinite(quota.limit) && Number.isFinite(quota.remaining)
  const left = hasQuota ? Math.max(0, Math.min(quota.limit, quota.remaining)) : 0
  const time = hasQuota ? resetTimeLabel(quota) : null
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <Card label="Best score" note={best != null && trend.length > 1 && best > trend[0] ? `+${best - trend[0]} since your first scan${partial ? ' (latest 100 scans)' : ''}` : 'out of 100'}>
        {best ?? '–'}<Spark points={trend} />
      </Card>
      <Card label="Verified links" note={<>{partial && <span>In your latest 100 scans · </span>}<Link to="/dashboard/proof" className="text-blue-700 hover:text-blue-900">Open Proof</Link></>}>{verifiedCount}</Card>
      {hasQuota && (
        <Card label="Free scans today" note={time ? `${left ? 'Resets' : 'Back'} at ${time}` : undefined}>
          {left} <span className="text-sm font-semibold text-gray-400">of {quota.limit}</span>
        </Card>
      )}
      <Card label="Free fix credits" note={credits > 0 ? 'Use on any completed scan' : 'None right now'}>{credits}</Card>
    </div>
  )
}
