import { trackerModel } from '../../lib/orderTracker'

// The customer's order tracker: where the order is, in plain words, and when to expect it. Shows nothing it does not know.
export default function OrderTracker({ order, timeZone }) {
  const m = trackerModel(order, { timeZone })
  return (
    <section aria-label="Order progress" className="rounded-lg border border-gray-200 bg-white p-3">
      {m.banner && <p className="font-medium text-gray-800">{m.banner}</p>}
      {m.steps.length > 0 && (
        <ol className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {m.steps.map(s => (
            <li key={s.key} aria-current={s.status === 'current' ? 'step' : undefined} className={s.status === 'current' ? 'font-semibold text-blue-800' : s.status === 'done' ? 'text-gray-800' : 'text-gray-400'}>
              {s.status === 'done' ? '\u2713 ' : ''}{s.label}
            </li>))}
        </ol>)}
      {m.expert && <p className="mt-2 text-sm text-gray-700">Your expert: <span className="font-medium">{m.expert.name}</span>{m.expert.tier ? ` (${m.expert.tier})` : ''}</p>}
      {m.deadline && <p className="mt-1 text-sm text-gray-700">Expected by <span className="font-medium">{m.deadline}</span></p>}
      {m.note && <p className="mt-1 text-xs text-gray-500">{m.note}</p>}
    </section>
  )
}
