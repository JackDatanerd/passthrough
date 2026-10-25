// Step list for the waiting states. Steps before `current` are done, `current`
// spins, the rest are dim. There is no percentage anywhere on purpose.
export default function ProgressSteps({ steps, current }) {
  return (
    <ol className="mt-3.5 grid gap-2.5">
      {steps.map(([title, detail], i) => {
        const done = i < current, on = i === current
        return (
          <li key={title} className={`flex items-start gap-2.5 text-sm ${done ? 'text-gray-900' : on ? 'font-semibold text-gray-900' : 'text-gray-500'}`}
              aria-current={on ? 'step' : undefined}>
            <span
              aria-hidden="true"
              className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 text-xs text-white ${
                done ? 'border-green-700 bg-green-700'
                  : on ? 'border-blue-700 border-t-transparent motion-safe:animate-spin'
                  : 'border-gray-300'}`}
            >{done ? '\u2713' : ''}</span>
            <span>
              {title}
              <small className="block text-xs font-normal text-gray-500">{detail}</small>
            </span>
          </li>
        )
      })}
    </ol>
  )
}
