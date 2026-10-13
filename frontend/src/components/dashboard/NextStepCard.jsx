import { Link } from 'react-router-dom'
import ButtonLink from '../ui/ButtonLink'
import Button from '../ui/Button'
import { ATS_PASS_THRESHOLD, ATS_BADGE_THRESHOLD } from '../../lib/scoreThresholds'
import { scanHeading } from '../../lib/scanDisplay'
import { displayScore, pointsTo, retriesLeft } from '../../lib/scanNext'
import { barColor } from './ScoreRing'

const pl = n => `${n} point${n === 1 ? '' : 's'}`
const ALSO = { cred: 'is ready for a credential', close: 'is close to a credential', retry: 'has a free retry left', fix: 'is below the pass line', error: "didn't finish", stuck: 'looks stuck', busy: 'is in progress' }

function Meter({ n }) {
  return (
    <div className="mt-1">
      <div role="img" aria-label={`Score ${n}. Pass line ${ATS_PASS_THRESHOLD}, credential line ${ATS_BADGE_THRESHOLD}.`} className="relative h-2 max-w-md rounded-full bg-gray-100">
        <i className={`absolute inset-y-0 left-0 rounded-full ${barColor(n)}`} style={{ width: `${n}%` }} />
        {[ATS_PASS_THRESHOLD, ATS_BADGE_THRESHOLD].map(t => <u key={t} aria-hidden="true" className="absolute -top-1 -bottom-1 w-0.5 bg-gray-700 no-underline" style={{ left: `${t}%` }} />)}
      </div>
      <p className="text-xs text-gray-500 mt-1">Now {n} · Pass {ATS_PASS_THRESHOLD} · Credential {ATS_BADGE_THRESHOLD}</p>
    </div>
  )
}

// The one thing worth doing now, plus up to two smaller "also" rows. `steps` comes from nextSteps().
export default function NextStepCard({ steps, hasScans, credits = 0, prices = {}, onBreakdown }) {
  if (!hasScans) return null
  if (!steps.length) {
    return (
      <section aria-label="Next step" className="rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-gray-900">All caught up</h2>
        <p className="text-sm text-gray-600 mt-1">Every scan here has a plan. Check a new posting while it is fresh.</p>
      </section>
    )
  }
  const { kind, scan } = steps[0]
  const name = scanHeading(scan)
  const n = displayScore(scan)
  const to = `/scan/${scan.id}`
  const fixLabel = credits > 0 ? 'Fix with a free credit' : prices.fix ? `Fix for ${prices.fix}` : 'Fix this resume'
  let body
  if (kind === 'cred') {
    body = (<>
      <h2 className="text-lg font-semibold text-gray-900">{name} scored {n}. Turn it into proof.</h2>
      <p className="text-sm text-gray-600">It is already above {ATS_BADGE_THRESHOLD}, so no rewrite is needed. You get a link employers can check.</p>
      <Meter n={n} />
      <div className="flex gap-2 flex-wrap"><ButtonLink to={to}>{prices.badge ? `Get the credential for ${prices.badge}` : 'Get the credential'}</ButtonLink></div>
    </>)
  } else if (kind === 'close') {
    const retry = retriesLeft(scan) > 0 && scan.status === 'FIX_DELIVERED'
    const gap = pointsTo(scan, ATS_BADGE_THRESHOLD)
    body = (<>
      <h2 className="text-lg font-semibold text-gray-900">{name} is {pl(gap)} from a verified credential</h2>
      <p className="text-sm text-gray-600">{retry ? 'A free retry aims at the last gap.' : 'It already passes. A fix is built to close the last gap and issue a link employers can check.'}</p>
      <Meter n={n} />
      <div className="flex gap-2 flex-wrap items-center">
        <ButtonLink to={to}>{retry ? 'Use a free retry' : fixLabel}</ButtonLink>
        <Button variant="secondary" onClick={() => onBreakdown(scan)}>See the breakdown</Button>
        <span className="text-xs text-gray-500">Every fix includes free retries. If it still misses, you get a free fix credit.</span>
      </div>
    </>)
  } else if (kind === 'retry') {
    const left = retriesLeft(scan)
    body = (<>
      <h2 className="text-lg font-semibold text-gray-900">{name} scored {n} after the fix. A free retry is waiting.</h2>
      <p className="text-sm text-gray-600">A retry rewrites it again, aiming at what is still missing. {left} free {left === 1 ? 'retry' : 'retries'} left.</p>
      <Meter n={n} />
      <div className="flex gap-2 flex-wrap"><ButtonLink to={to}>Use a free retry</ButtonLink><Button variant="secondary" onClick={() => onBreakdown(scan)}>See the breakdown</Button></div>
    </>)
  } else if (kind === 'stuck') {
    body = (<>
      <h2 className="text-lg font-semibold text-gray-900">{name} looks stuck</h2>
      <p className="text-sm text-gray-600">It has not moved for over an hour. Open it to check, or delete it from the list and scan again.</p>
      <div className="flex gap-2"><ButtonLink to={to}>Open it</ButtonLink></div>
    </>)
  } else if (kind === 'fix') {
    body = (<>
      <h2 className="text-lg font-semibold text-gray-900">{name} is {pointsTo(scan, ATS_PASS_THRESHOLD)} below the pass line</h2>
      <p className="text-sm text-gray-600">A fix rewrites your resume toward this job.</p>
      <Meter n={n} />
      <div className="flex gap-2 flex-wrap"><ButtonLink to={to}>{fixLabel}</ButtonLink><Button variant="secondary" onClick={() => onBreakdown(scan)}>See the breakdown</Button></div>
    </>)
  } else if (kind === 'error') {
    body = (<>
      <h2 className="text-lg font-semibold text-gray-900">{name} didn’t finish</h2>
      <p className="text-sm text-gray-600">Open it to see what happened.</p>
      <div className="flex gap-2"><ButtonLink to={to}>See what happened</ButtonLink></div>
    </>)
  } else {
    body = (<>
      <h2 className="text-lg font-semibold text-gray-900">{scan.status === 'FIX_PURCHASED' || scan.status === 'FIX_GENERATING' ? 'Writing the fix for' : 'Scanning'} {name}…</h2>
      <p className="text-sm text-gray-600">You can leave this page. The result will be in your list.</p>
      <div role="progressbar" aria-label="Working" className="h-1.5 max-w-xs rounded-full bg-blue-100 overflow-hidden"><div className="h-full w-1/3 rounded-full bg-blue-600 animate-pulse" /></div>
    </>)
  }
  const more = steps.slice(1, 3)
  return (
    <section aria-label="Next step" className="rounded-xl border border-gray-200 border-l-4 border-l-blue-700 bg-white p-5 flex flex-col gap-3">
      <p className="text-xs font-semibold text-blue-700">Your best next step</p>
      {body}
      {more.length > 0 && (
        <div className="border-t border-gray-100 pt-3 flex flex-col gap-2">
          {more.map(s => (
            <div key={s.scan.id} className="flex items-center justify-between gap-3 text-sm text-gray-700">
              <span><b className="font-medium">{scanHeading(s.scan)}</b> {ALSO[s.kind]}</span>
              <Link to={`/scan/${s.scan.id}`} className="text-blue-700 hover:text-blue-900 shrink-0">View</Link>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
