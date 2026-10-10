import { Link } from 'react-router-dom'
import { roleLabel } from '../../lib/roleCategories'
import { avatarColour, initialOf, paragraphs } from '../../lib/homeFormat'

function interviewTag(s) {
  if (s.interviewCount > 1) return `${s.interviewCount} interviews`
  return 'Interview booked'
}

function Story({ s, isSample, badgeThreshold }) {
  const body = paragraphs(s.story)
  const hasScores = Number.isFinite(s.scoreBefore) && Number.isFinite(s.scoreAfter)
  const timeline = []
  if (Number.isFinite(s.scoreBefore)) timeline.push(`Scanned: ${s.scoreBefore}`)
  if (Number.isFinite(s.scoreAfter)) timeline.push(`Fixed: ${s.scoreAfter}${s.scoreAfter >= badgeThreshold ? ', Verified' : ''}`)
  if (Number.isFinite(s.interviewAfterDays)) timeline.push(s.interviewAfterDays === 0 ? 'Interview the same day' : `Interview ${s.interviewAfterDays} day${s.interviewAfterDays === 1 ? '' : 's'} after delivery`)

  return (
    <article className="relative bg-white rounded-xl border border-gray-200 shadow-sm p-5">
      {isSample && (
        <span className="absolute top-2.5 right-3 text-[10px] font-bold uppercase tracking-wide text-amber-800 bg-amber-50 border border-dashed border-amber-400 rounded px-1.5">Sample</span>
      )}
      <div className="flex items-center gap-3 mb-3">
        <div aria-hidden="true" className={`w-10 h-10 rounded-full text-white font-bold flex items-center justify-center ${avatarColour(s.displayName)}`}>{initialOf(s.displayName)}</div>
        <div>
          <p className="font-semibold text-gray-900 leading-tight">{s.displayName}</p>
          {s.roleCategory && <p className="text-xs text-gray-500">{roleLabel(s.roleCategory)}</p>}
        </div>
      </div>
      <div className="flex items-center gap-2 mb-3 text-sm">
        {hasScores && (
          <>
            <span className="text-lg font-extrabold text-red-700" aria-label={`Score before: ${s.scoreBefore}`}>{s.scoreBefore}</span>
            <span className="text-gray-400" aria-hidden="true">→</span>
            <span className="text-lg font-extrabold text-green-700" aria-label={`Score after: ${s.scoreAfter}`}>{s.scoreAfter}</span>
          </>
        )}
        <span className="ml-auto text-xs font-bold bg-green-100 text-green-800 px-2 py-0.5 rounded-full">{interviewTag(s)}</span>
      </div>
      <blockquote className="text-base font-medium text-gray-900 leading-snug">“{s.quote}”</blockquote>

      {(body.length > 0 || timeline.length > 0) && (
        <details className="group mt-3">
          <summary className="cursor-pointer list-none text-sm font-semibold text-blue-700 inline-flex items-center gap-1.5 [&::-webkit-details-marker]:hidden">
            Read my story <span aria-hidden="true" className="font-extrabold group-open:hidden">＋</span><span aria-hidden="true" className="font-extrabold hidden group-open:inline">−</span>
          </summary>
          <div className="mt-3 border-l-[3px] border-blue-200 pl-3.5 flex flex-col gap-2.5 text-sm text-gray-700">
            {body.map((p, i) => <p key={i} className="whitespace-pre-line">{p}</p>)}
            {timeline.length > 0 && (
              <ul className="text-xs text-gray-500 flex flex-col gap-1">
                {timeline.map(t => <li key={t}><span className="text-blue-600" aria-hidden="true">● </span>{t}</li>)}
              </ul>
            )}
          </div>
        </details>
      )}

      {s.credentialCode ? (
        <Link to={`/v/${encodeURIComponent(s.credentialCode)}`}
          className="mt-3.5 inline-flex items-center gap-2 text-xs font-semibold text-green-800 bg-green-50 border border-green-100 rounded-lg px-2.5 py-1.5 hover:bg-green-100">
          <span aria-hidden="true" className="w-4 h-4 rounded-full bg-green-600 text-white text-[10px] flex items-center justify-center">✓</span>
          View {s.displayName.split(' ')[0]}&apos;s Verified credential
        </Link>
      ) : isSample ? (
        <span className="mt-3.5 inline-flex items-center gap-2 text-xs font-semibold text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-1.5">
          <span aria-hidden="true" className="w-4 h-4 rounded-full bg-gray-400 text-white text-[10px] flex items-center justify-center">✓</span>
          Verified credential link appears here
        </span>
      ) : null}
    </article>
  )
}

export default function Stories({ stories, badgeThreshold }) {
  const { list, isSample } = stories
  if (!list.length) return null
  const allLinked = list.every(s => !!s.credentialCode)
  return (
    <section id="stories" className="bg-gray-50 border-y border-gray-100 py-16">
      <div className="max-w-5xl mx-auto px-4">
        <div className="text-center max-w-2xl mx-auto mb-9">
          <p className="text-xs font-bold uppercase tracking-wider text-blue-700 mb-2">Real applicants</p>
          <h2 className="text-3xl font-bold text-gray-900 mb-3">The day the replies started coming</h2>
          <p className="text-gray-500">Open “my story” to read how it happened{allLinked ? ' — and the credential they sent employers' : ''}.</p>
        </div>
        <div className="grid md:grid-cols-3 gap-5 items-start">
          {list.map(s => <Story key={s.id} s={s} isSample={isSample} badgeThreshold={badgeThreshold} />)}
        </div>
        <p className="text-center text-xs text-gray-500 mt-6">
          {allLinked
            ? "Each story links to a live verification page — if the badge doesn't open, the story doesn't run."
            : 'Stories are shared by customers with their permission and reviewed before they appear.'}
        </p>
      </div>
    </section>
  )
}
