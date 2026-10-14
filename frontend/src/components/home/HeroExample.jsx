import { BEFORE_AFTER } from '../../lib/homeContent'
import { scoreTone } from '../../lib/homeFormat'

// A compact preview of what a scan hands you, under the hero's key facts. It fills the column beside the (taller) scan card
// with the thing a first-time visitor most wants to know — "what do I actually get?" — instead of empty space.
//
// Same data and same labelling rules as the full Before/After section further down (BEFORE_AFTER in lib/homeContent.js is an
// illustration, so this says "Illustrative example" too, and links down to the full version).
function Side({ data, good }) {
  return (
    <div className="min-w-0">
      <p className={`font-display text-[30px] font-extrabold leading-none tracking-[-0.03em] ${good ? 'text-green-700' : 'text-red-700'}`}>
        <span className="sr-only">{good ? 'After: score ' : 'Before: score '}</span>
        {data.score}
        <span className="sr-only"> out of 100</span>
      </p>
      <p className="text-[12.5px] font-semibold text-gray-500 mt-0.5 mb-2">{data.verdict}</p>
      <div className="flex flex-col gap-1.5">
        {data.rows.map(([label, v]) => {
          const t = scoreTone(v)
          return (
            <div key={label}>
              <div className="flex justify-between gap-2 text-xs text-ink-2 mb-0.5"><span>{label}</span><span className={`font-bold ${t.text}`}>{v}</span></div>
              <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden" aria-hidden="true">
                <div className={`h-full rounded-full ${t.bar}`} style={{ width: `${v}%` }} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function HeroExample() {
  const { before, after } = BEFORE_AFTER
  return (
    <section
      aria-labelledby="hero-example-h"
      className="mt-5 max-w-[560px] rounded-[14px] border border-gray-200 bg-white px-4 sm:px-[18px] pt-3.5 pb-3 shadow-[0_1px_2px_rgba(10,21,48,.05),0_8px_24px_rgba(10,21,48,.06)]"
    >
      <div className="flex items-center justify-between gap-2.5 mb-2">
        <h2 id="hero-example-h" className="text-sm font-bold text-ink">What a scan shows you</h2>
        <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-gray-500 bg-gray-100 px-2 py-0.5 rounded">Illustrative example</span>
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] gap-2 sm:gap-3 items-start">
        <Side data={before} good={false} />
        <span className="self-center text-[22px] font-bold text-blue-700" aria-hidden="true">→</span>
        <Side data={after} good />
      </div>
      <div className="flex flex-wrap items-center gap-1.5 mt-2.5 pt-2 border-t border-gray-100">
        <span className="text-xs font-semibold text-gray-500 mr-0.5">Missing keywords</span>
        {before.keywords.map(k => (
          <span key={k} className="text-xs font-semibold text-blue-900 bg-blue-50 border border-blue-200 px-2 py-0.5 rounded-full">{k}</span>
        ))}
      </div>
      <a href="#proof" className="inline-block mt-1.5 text-[13px] font-bold text-blue-700 hover:underline">
        See the full before and after <span aria-hidden="true">↓</span>
      </a>
    </section>
  )
}
