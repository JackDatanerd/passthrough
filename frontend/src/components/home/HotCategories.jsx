import { useState } from 'react'
import { roleLabel, ROLE_CATEGORIES } from '../../lib/roleCategories'

const SHOWN = 6
const WINDOWS = [7, 30]
const SOMETHING_ELSE = '__else'

const Flame = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5c.4 2.3 3.5 3.6 3.5 7A3.5 3.5 0 0 1 8 12a3.5 3.5 0 0 1-3.5-3.5c0-1.2.6-2 1.2-2.6.1 1 .6 1.6 1.2 1.9C6.6 5.6 7 3.4 8 1.5Z" fill="#e4570b" /></svg>
)

// Fields ranked by interviews applicants reported in the window. The picker on the right is the personal
// hook: choose your field and see where it ranks. A field missing from the list is NOT ranked last — it is
// hidden because it has fewer than `minReports` reports in the period, and the message says exactly that.
export default function HotCategories({ hot, minReports }) {
  const [days, setDays] = useState(7)
  const [all, setAll] = useState(false)
  const [pick, setPick] = useState('')
  const { rows, isSample } = hot[days]
  if (!rows.length) return null
  const max = rows[0].interviews || 1
  const shown = all ? rows : rows.slice(0, SHOWN)
  const period = days === 7 ? 'this week' : 'this month'

  const pickIdx = pick && pick !== SOMETHING_ELSE ? rows.findIndex(r => r.category === pick) : -1
  let pickMsg = 'Pick a field to see where it ranks.'
  if (pick === SOMETHING_ELSE) pickMsg = 'Not on the list? The scan works for any posting.'
  else if (pick && pickIdx >= 0) pickMsg = <><b>{roleLabel(pick)}</b> is #{pickIdx + 1} {period} with {rows[pickIdx].interviews.toLocaleString('en-US')} reported interviews.</>
  else if (pick) pickMsg = <><b>{roleLabel(pick)}</b> doesn&apos;t have {minReports}+ reports {period} yet, so it isn&apos;t ranked.</>

  function choose(value) {
    setPick(value)
    // a field that sits below the fold opens the full list so the highlighted row is actually visible
    const i = rows.findIndex(r => r.category === value)
    if (i >= SHOWN) setAll(true)
  }

  return (
    <section id="hot" className="py-[72px] scroll-mt-4">
      <div className="max-w-[1180px] mx-auto px-4 sm:px-6">
        <div className="text-center max-w-2xl mx-auto mb-10">
          <p className="text-xs font-bold uppercase tracking-wider text-blue-700 mb-2">{days === 7 ? 'This week' : 'This month'}</p>
          <h2 className="text-3xl font-bold text-gray-900 mb-3">Where applicants are landing interviews right now</h2>
          <p className="text-gray-500 text-[17px]">Interviews reported by Passthrough users in the last {days} days, by field.</p>
        </div>
        <div className="grid lg:grid-cols-[1.3fr_.7fr] gap-5 items-start">
          <div className="relative bg-white rounded-xl border border-gray-200 shadow-sm p-5">
            {/* // {isSample && <span className="absolute top-2.5 right-3 text-[11px] font-bold uppercase tracking-wide text-amber-800 bg-amber-50 border border-dashed border-amber-400 rounded px-1.5">Sample</span>} */}
            <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
              <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                <span aria-hidden="true" className="w-2 h-2 rounded-full bg-green-600 animate-pulse motion-reduce:animate-none" />Hot categories
              </h3>
              <div role="group" aria-label="Period" className="inline-flex bg-gray-100 rounded-full p-1 text-sm">
                {WINDOWS.map(d => (
                  <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}
                    className={`px-4 py-2.5 sm:px-3.5 sm:py-1 rounded-full font-semibold ${days === d ? 'bg-white text-gray-900 shadow' : 'text-gray-600'}`}>{d} days</button>
                ))}
              </div>
            </div>
            <ol aria-label="Fields ranked by interviews reported" className="flex flex-col gap-1">
              {shown.map((r, i) => {
                const top = i < 3
                const mine = i === pickIdx
                return (
                  <li key={r.category} data-mine={mine ? 'true' : undefined}>
                    <a href="#scan-form" className={`grid grid-cols-[24px_1fr_64px] sm:grid-cols-[24px_170px_1fr_74px] gap-2.5 items-center px-2 py-2 rounded-lg text-sm ${mine ? 'bg-blue-100 shadow-[inset_3px_0_0_#1d4ed8]' : 'hover:bg-blue-50'}`}>
                      <span className={`text-center font-extrabold ${top ? 'text-[#e4570b]' : 'text-gray-400'}`}>{i + 1}</span>
                      <span className="font-semibold text-gray-900 flex items-center gap-1.5">{roleLabel(r.category)}{top && <Flame />}</span>
                      <span className="hidden sm:block h-2.5 bg-gray-100 rounded-full overflow-hidden" aria-hidden="true">
                        <span className={`block h-full rounded-full ${top ? 'bg-gradient-to-r from-amber-500 to-[#e4570b]' : 'bg-gradient-to-r from-blue-600 to-blue-400'}`} style={{ width: `${Math.round((r.interviews / max) * 100)}%` }} />
                      </span>
                      <span className="text-right tabular-nums font-bold text-gray-900">
                        {r.interviews.toLocaleString('en-US')}
                        <small className={`block text-xs font-semibold ${r.changePct > 0 ? 'text-green-700' : r.changePct < 0 ? 'text-red-700' : 'text-gray-500'}`}>
                          {r.changePct == null ? '—' : `${r.changePct > 0 ? '▲' : r.changePct < 0 ? '▼' : '='} ${Math.abs(r.changePct)}%`}
                        </small>
                      </span>
                    </a>
                  </li>
                )
              })}
            </ol>
            {rows.length > SHOWN && (
              <button type="button" aria-expanded={all} onClick={() => setAll(a => !a)} className="mt-1 px-2 py-3 text-sm font-semibold text-blue-700 hover:underline">
                {all ? `Show top ${SHOWN} ▴` : `Show all ${rows.length} fields ▾`}
              </button>
            )}
            <p className="text-xs text-gray-500 mt-3">
              {isSample
                ? ''
                : `Applicant-reported, refreshed regularly. Fields with fewer than ${minReports} reports in the period aren't shown, and the arrow compares with the period before.`}
            </p>
          </div>
          <aside className="bg-gradient-to-br from-blue-800 to-blue-900 text-white rounded-xl p-6">
            <h3 className="text-xl font-bold mb-2.5 leading-snug">Your field is moving. Is your resume ready?</h3>
            <p className="text-blue-200 text-sm mb-4">Pick your field to see where it ranks, then scan your resume against a real job description and see exactly what is holding it back.</p>
            <label htmlFor="home-pick-field" className="block font-bold text-sm mb-1.5">Which one are you?</label>
            <select id="home-pick-field" value={pick} onChange={e => choose(e.target.value)} className="w-full font-semibold text-base px-3 py-3 rounded-lg bg-white text-gray-900">
              <option value="">Choose your field…</option>
              {ROLE_CATEGORIES.filter(([k]) => k !== 'other').map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              <option value={SOMETHING_ELSE}>Something else</option>
            </select>
            <p aria-live="polite" className="my-3 text-sm min-h-[42px]">{pickMsg}</p>
            <a href="#scan-form" className="inline-block bg-white text-blue-800 font-semibold px-5 py-2.5 rounded-lg hover:bg-blue-50">Scan for my field →</a>
          </aside>
        </div>
      </div>
    </section>
  )
}
