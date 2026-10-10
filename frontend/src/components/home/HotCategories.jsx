import { useState } from 'react'
import { roleLabel } from '../../lib/roleCategories'

const SHOWN = 6
const WINDOWS = [7, 30]

export default function HotCategories({ hot, minReports }) {
  const [days, setDays] = useState(7)
  const [all, setAll] = useState(false)
  const { rows, isSample } = hot[days]
  if (!rows.length) return null
  const max = rows[0].interviews || 1
  const shown = all ? rows : rows.slice(0, SHOWN)

  return (
    <section id="hot" className="py-16">
      <div className="max-w-5xl mx-auto px-4">
        <div className="text-center max-w-2xl mx-auto mb-9">
          <p className="text-xs font-bold uppercase tracking-wider text-blue-700 mb-2">{days === 7 ? 'This week' : 'This month'}</p>
          <h2 className="text-3xl font-bold text-gray-900 mb-3">Where applicants are landing interviews right now</h2>
          <p className="text-gray-500">Interviews reported by Passthrough users in the last {days} days, by field.</p>
        </div>
        <div className="grid lg:grid-cols-[1.3fr_.7fr] gap-5 items-start">
          <div className="relative bg-white rounded-xl border border-gray-200 shadow-sm p-5">
            {isSample && <span className="absolute top-2.5 right-3 text-[10px] font-bold uppercase tracking-wide text-amber-800 bg-amber-50 border border-dashed border-amber-400 rounded px-1.5">Sample</span>}
            <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
              <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                <span aria-hidden="true" className="w-2 h-2 rounded-full bg-green-600 animate-pulse" />Hot categories
              </h3>
              <div role="group" aria-label="Period" className="inline-flex bg-gray-100 rounded-full p-1 text-sm">
                {WINDOWS.map(d => (
                  <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}
                    className={`px-3.5 py-1 rounded-full font-semibold ${days === d ? 'bg-white text-gray-900 shadow' : 'text-gray-600'}`}>{d} days</button>
                ))}
              </div>
            </div>
            <ol className="flex flex-col gap-1">
              {shown.map((r, i) => (
                <li key={r.category}>
                  <a href="#scan-form" className="grid grid-cols-[24px_1fr_64px] sm:grid-cols-[24px_150px_1fr_74px] gap-2.5 items-center px-2 py-2 rounded-lg hover:bg-blue-50 text-sm">
                    <span className={`text-center font-extrabold ${i === 0 ? 'text-amber-500' : 'text-gray-400'}`}>{i + 1}</span>
                    <span className="font-semibold text-gray-900">{roleLabel(r.category)}{i === 0 ? ' 🔥' : ''}</span>
                    <span className="hidden sm:block h-2.5 bg-gray-100 rounded-full overflow-hidden" aria-hidden="true">
                      <span className={`block h-full rounded-full ${i === 0 ? 'bg-gradient-to-r from-amber-500 to-amber-300' : 'bg-gradient-to-r from-blue-600 to-blue-400'}`} style={{ width: `${Math.round((r.interviews / max) * 100)}%` }} />
                    </span>
                    <span className="text-right tabular-nums font-bold text-gray-900">
                      {r.interviews}
                      <small className="block text-[11px] font-semibold text-green-700">
                        {r.changePct == null ? '—' : `${r.changePct > 0 ? '▲' : r.changePct < 0 ? '▼' : '='} ${Math.abs(r.changePct)}%`}
                      </small>
                    </span>
                  </a>
                </li>
              ))}
            </ol>
            {rows.length > SHOWN && (
              <button type="button" onClick={() => setAll(a => !a)} className="mt-2 px-2 py-1.5 text-sm font-semibold text-blue-700 hover:underline">
                {all ? `Show top ${SHOWN} ▴` : `Show all ${rows.length} fields ▾`}
              </button>
            )}
            <p className="text-xs text-gray-500 mt-3">
              {isSample
                ? 'Sample numbers shown until enough real reports come in.'
                : `Applicant-reported, refreshed regularly. Fields with fewer than ${minReports} reports in the period aren't shown, and the arrow compares with the period before.`}
            </p>
          </div>
          <aside className="bg-gradient-to-br from-blue-800 to-blue-900 text-white rounded-xl p-6">
            <h3 className="text-xl font-bold mb-2.5 leading-snug">Your field is moving. Is your resume ready?</h3>
            <p className="text-blue-200 text-sm mb-4">Scan your resume against a real job description and see exactly what is holding it back — free, in about 30 seconds.</p>
            <a href="#scan-form" className="inline-block bg-white text-blue-800 font-semibold px-5 py-2.5 rounded-lg hover:bg-blue-50">Scan for my field →</a>
          </aside>
        </div>
      </div>
    </section>
  )
}
