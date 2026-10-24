// Step list for the waiting states. Steps before `current` are done, `current`
// spins, the rest are dim. There is no percentage anywhere on purpose.
export default function ProgressSteps({ steps, current }) {
  return (
    <ol className="mt-3.5 grid gap-2.5">
      {steps.map(([title, detail], i) => {
        const done = i < current, on = i === current
        return (
          <li key={title} className={`flex items-start gap-2.5 text-sm ${done ? 'text-ink' : on ? 'font-semibold text-ink' : 'text-gray-500'}`}
              aria-current={on ? 'step' : undefined}>
            <span
              aria-hidden="true"
              className={`mt-px grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border-2 text-[10px] text-white ${
                done ? 'border-green-700 bg-green-700'
                  : on ? 'border-blue-700 border-t-transparent motion-safe:animate-spin'
                  : 'border-gray-300'}`}
            >{done ? '\u2713' : ''}</span>
            <span>
              {title}
              <small className="block text-[12.5px] font-normal text-gray-500">{detail}</small>
            </span>
          </li>
        )
      })}
    </ol>
  )
}
