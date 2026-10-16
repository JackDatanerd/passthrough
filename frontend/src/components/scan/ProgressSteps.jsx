// Step list for the waiting states. Steps before `current` are done, `current`
// spins, the rest are dim. There is no percentage anywhere on purpose.
export default function ProgressSteps({ steps, current }) {
  return (
    <ol className="mt-4 divide-y divide-gray-100">
      {steps.map(([title, detail], i) => {
        const done = i < current, on = i === current
        return (
          <li key={title} className={`flex gap-3 py-2 ${done || on ? 'text-gray-900' : 'text-gray-400'}`}
              aria-current={on ? 'step' : undefined}>
            <span
              aria-hidden="true"
              className={`mt-0.5 h-5 w-5 shrink-0 rounded-full border-2 grid place-items-center text-[11px] text-white ${
                done ? 'bg-green-600 border-green-600'
                  : on ? 'border-blue-600 border-t-transparent motion-safe:animate-spin'
                  : 'border-gray-200'}`}
            >{done ? '✓' : ''}</span>
            <span>
              <span className="block text-sm font-medium">{title}</span>
              <span className="block text-xs text-gray-500">{detail}</span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}
