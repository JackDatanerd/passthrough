export default function ScoreGauge({ score }) {
  const radius = 54
  const circ   = 2 * Math.PI * radius
  const pct    = Math.max(0, Math.min(100, score ?? 0)) / 100
  const dash   = pct * circ
  const gap    = circ - dash

  const color = score >= 75 ? '#16a34a' : score >= 50 ? '#d97706' : '#dc2626'
  const label = score >= 75 ? 'Pass' : score >= 50 ? 'Marginal' : 'Fail'

  return (
    <div className="flex flex-col items-center gap-2">
      <svg width="140" height="140" viewBox="0 0 140 140">
        {/* Track */}
        <circle cx="70" cy="70" r={radius} fill="none"
          stroke="#e5e7eb" strokeWidth="12" />
        {/* Progress — starts at top (−90°) */}
        <circle cx="70" cy="70" r={radius} fill="none"
          stroke={color} strokeWidth="12"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${gap}`}
          transform="rotate(-90 70 70)"
          style={{ transition: 'stroke-dasharray 0.6s ease' }}
        />
        {/* Score */}
        <text x="70" y="66" textAnchor="middle"
          fontSize="28" fontWeight="700" fill={color}>
          {score ?? '—'}
        </text>
        <text x="70" y="84" textAnchor="middle"
          fontSize="12" fill="#6b7280">
          / 100
        </text>
      </svg>
      <span className="text-sm font-semibold" style={{ color }}>
        {label}
      </span>
    </div>
  )
}
