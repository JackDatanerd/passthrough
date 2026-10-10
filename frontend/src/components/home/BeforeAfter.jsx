import { useState } from 'react'
import useReveal, { useCountUp } from '../../hooks/useReveal'
import { BEFORE_AFTER } from '../../lib/homeContent'

const R = 40
const C = 2 * Math.PI * R
const tone = (v) => (v >= 80 ? { bar: 'bg-green-500', text: 'text-green-700' } : v >= 60 ? { bar: 'bg-amber-400', text: 'text-amber-700' } : { bar: 'bg-red-500', text: 'text-red-700' })

function Panel({ title, badge, badgeClass, data, good, active, className }) {
  const n = useCountUp(data.score, active)
  const ring = good ? { track: '#dcfce7', arc: '#16a34a', text: 'text-green-700' } : { track: '#fee2e2', arc: '#dc2626', text: 'text-red-700' }
  return (
    <div className={`bg-white rounded-xl border shadow-sm p-6 ${good ? 'border-green-200' : 'border-gray-200'} ${className}`}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">{title}</h3>
        <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${badgeClass}`}>{badge}</span>
      </div>
      <div className="flex items-center gap-5 mb-5">
        <div className="relative w-24 h-24 shrink-0">
          <svg width="96" height="96" viewBox="0 0 96 96" className="-rotate-90" aria-hidden="true">
            <circle cx="48" cy="48" r={R} fill="none" stroke={ring.track} strokeWidth="10" />
            <circle cx="48" cy="48" r={R} fill="none" stroke={ring.arc} strokeWidth="10" strokeLinecap="round"
              strokeDasharray={`${C} ${C}`} strokeDashoffset={active ? C * (1 - data.score / 100) : C}
              style={{ transition: 'stroke-dashoffset 1.2s cubic-bezier(.2,.8,.2,1)' }} />
          </svg>
          <div className={`absolute inset-0 flex flex-col items-center justify-center ${ring.text}`}>
            <span className="text-2xl font-extrabold leading-none">{n}</span>
            <span className="text-[10px] text-gray-400">/ 100</span>
          </div>
        </div>
        <div>
          <p className="font-semibold text-gray-900">{data.verdict}</p>
          <p className="text-sm text-gray-500 mt-0.5">{data.sub}</p>
        </div>
      </div>
      <div className="flex flex-col gap-3">
        {data.rows.map(([label, v]) => {
          const t = tone(v)
          return (
            <div key={label}>
              <div className="flex justify-between mb-1 text-sm"><span className="text-gray-600">{label}</span><span className={`font-semibold ${t.text}`}>{v}</span></div>
              <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                <div className={`h-full rounded-full ${t.bar}`} style={{ width: active ? `${v}%` : 0, transition: 'width 1.1s cubic-bezier(.2,.8,.2,1)' }} />
              </div>
            </div>
          )
        })}
      </div>
      <div className="mt-5 pt-4 border-t border-gray-100 flex flex-wrap gap-1.5">
        <p className="w-full text-xs text-gray-500 mb-1">
          {good ? 'Same keywords, now matched truthfully to real experience:' : 'Keywords the job asks for that this resume is missing:'}
        </p>
        {data.keywords.map(k => (
          <span key={k} className={`text-xs font-semibold px-2.5 py-0.5 rounded-full border ${good ? 'bg-green-50 text-green-700 border-green-100' : 'bg-red-50 text-red-700 border-red-100'}`}>{k}</span>
        ))}
      </div>
    </div>
  )
}

export default function BeforeAfter() {
  const [ref, shown] = useReveal({ threshold: 0.25 })
  // Phones show one panel at a time (both stacked is a very long scroll); wider screens show both.
  const [which, setWhich] = useState('after')
  const { before, after } = BEFORE_AFTER
  return (
    <section id="proof" className="py-16">
      <div className="max-w-5xl mx-auto px-4">
        <div className="text-center max-w-2xl mx-auto mb-8">
          <p className="text-xs font-bold uppercase tracking-wider text-blue-700 mb-2">Before &amp; after</p>
          <h2 className="text-3xl font-bold text-gray-900 mb-3">Same person. Same experience. Different result.</h2>
          <p className="text-gray-500">Nothing about the work history changed. The way the ATS reads it did.</p>
        </div>

        <div className="md:hidden flex justify-center mb-5">
          <div role="group" aria-label="Show" className="inline-flex bg-gray-100 rounded-full p-1">
            {[['before', 'Before'], ['after', 'After']].map(([k, label]) => (
              <button key={k} type="button" aria-pressed={which === k} onClick={() => setWhich(k)}
                className={`px-5 py-2 rounded-full text-sm font-semibold ${which === k ? 'bg-white text-gray-900 shadow' : 'text-gray-600'}`}>{label}</button>
            ))}
          </div>
        </div>

        <div ref={ref} className="grid md:grid-cols-2 gap-5">
          <Panel title="Before" badge="Filtered out" badgeClass="bg-red-50 text-red-700" data={before} good={false} active={shown}
            className={which === 'before' ? '' : 'hidden md:block'} />
          <Panel title="After" badge="✓ Verified" badgeClass="bg-green-100 text-green-800" data={after} good active={shown}
            className={which === 'after' ? '' : 'hidden md:block'} />
        </div>
        <p className="text-center text-xs text-gray-500 mt-4">Illustrative example — your actual score and breakdown appear after a real scan.</p>
        <div className="text-center mt-6">
          <a href="#scan-form" className="inline-block bg-blue-700 text-white font-semibold px-6 py-3 rounded-lg hover:bg-blue-800 transition-colors">See my own score free →</a>
        </div>
      </div>
    </section>
  )
}
