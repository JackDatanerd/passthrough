import { useContext } from 'react'
import ScanForm from '../scan/ScanForm'
import { AuthContext } from '../../context/AuthContext'
import { formatScanCount } from '../../lib/homeFormat'
import { ATS_NAMES } from '../../lib/homeContent'
import TypedText from './TypedText'

const FACES = [['A', 'bg-blue-600'], ['D', 'bg-teal-600'], ['P', 'bg-purple-600'], ['J', 'bg-rose-600'], ['M', 'bg-amber-600']]

// The hero has three blocks — the pitch, the scan card, the proof — in THAT DOM ORDER on purpose:
//   phone:   pitch → scan card → proof. The card is the page's one job, and on a 390×800 phone the old order
//            (pitch → proof → facts → card) put the upload box entirely below the fold. Now its tabs and drop
//            zone are on the first screen.
//   desktop: pitch over proof on the left, the (tall) card spanning both rows on the right, top-aligned so the
//            copy never floats mid-page beside it.
export default function HomeHero({ data, badgeThreshold }) {
  // Null-safe, like usePricing: a bare render must not throw.
  const signedIn = !!useContext(AuthContext)?.user
  const scans = formatScanCount(data.scans.value, { atLeast: data.scans.isFallback })
  const rate = data.rate.pct
  const ticks = signedIn
    ? ['Saved to your dashboard', 'Full breakdown free', 'Pay only if you want the fix']
    : ['No account needed', 'Full breakdown free', 'Pay only if you want the fix']

  return (
    <section className="relative overflow-hidden bg-paper bg-[radial-gradient(900px_420px_at_85%_-10%,#E8EEFF,transparent_70%)] border-b border-gray-100">
      {/* soft dot grid behind the hero, fading out downwards; decorative only */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-55"
        style={{
          backgroundImage: 'radial-gradient(#C5CDE0 1px, transparent 1.2px)',
          backgroundSize: '22px 22px',
          WebkitMaskImage: 'linear-gradient(180deg,#000,transparent 85%)',
          maskImage: 'linear-gradient(180deg,#000,transparent 85%)',
        }}
      />
      <div className="relative max-w-[1180px] mx-auto px-4 sm:px-6 pt-8 sm:pt-12 pb-10 grid lg:grid-cols-[1.05fr_.95fr] lg:grid-rows-[auto_1fr] gap-x-10 gap-y-6 items-start">
        <div className="min-w-0 lg:col-start-1 lg:row-start-1">
          {scans && (
            <div className="inline-flex items-center gap-1.5 bg-blue-100 text-blue-800 text-xs font-semibold px-3 py-1 rounded-full mb-4">
              <span aria-hidden="true">★</span> {scans} resumes scanned
            </div>
          )}
          <h1 className="font-display text-[clamp(2.1rem,4.6vw,3.4rem)] font-extrabold text-ink leading-[1.06] tracking-[-0.03em] mb-3 sm:mb-4">
            Get past the robot.<br />
            <TypedText text="Get the interview." className="text-blue-700" />
          </h1>
          <p className="text-base sm:text-lg text-gray-600 max-w-xl">
            Most ATS tools hand you a score and walk away. Passthrough shows exactly why you&apos;re being
            filtered out, fixes it, and gives employers a link that <strong className="text-gray-900">proves</strong> your
            resume is real.
            {rate != null && (
              <> <strong className="text-gray-900">{rate}% of applicants</strong> report an interview<sup><a href="#faq-66" aria-label="Where this figure comes from" className="text-blue-700">*</a></sup>.</>
            )}
          </p>
        </div>

        <div id="scan-form" className="min-w-0 scroll-mt-4 bg-white rounded-xl border border-gray-200 shadow-lg p-4 sm:p-6 lg:col-start-2 lg:row-start-1 lg:row-span-2">
          <h2 className="text-base font-semibold text-gray-900 mb-4">Scan your resume — free, about 30 seconds</h2>
          <ScanForm />
          <ul className="mt-4 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-gray-500">
            {ticks.map(t => <li key={t}><span className="text-green-600 font-bold" aria-hidden="true">✓ </span>{t}</li>)}
          </ul>
        </div>

        <div className="min-w-0 lg:col-start-1 lg:row-start-2">
          <div className="flex items-center gap-3.5 flex-wrap text-sm text-gray-600">
            {/* Decorative: neither the initials nor the stars are data, so they are hidden from screen readers
                (a row of stars read aloud would sound like a rating). */}
            <div className="flex" aria-hidden="true">
              {FACES.map(([letter, colour]) => (
                <span key={letter} className={`w-[30px] h-[30px] -ml-2 first:ml-0 rounded-full border-2 border-white flex items-center justify-center text-[11px] font-bold text-white ${colour}`}>{letter}</span>
              ))}
            </div>
            <div>
              <span className="text-amber-500 tracking-wide" aria-hidden="true">★★★★★</span>{' '}
              Built for {ATS_NAMES.slice(0, -1).join(', ')} &amp; {ATS_NAMES[ATS_NAMES.length - 1]}
            </div>
          </div>
          <dl className="grid grid-cols-3 sm:flex sm:flex-wrap gap-x-4 sm:gap-x-7 gap-y-3 mt-5 pt-5 border-t border-gray-200">
            {[['Free', 'to scan'], ['~30s', 'to your full score'], [`${badgeThreshold}+`, 'earns the Verified link']].map(([big, small]) => (
              <div key={small}>
                <dt className="text-2xl sm:text-3xl font-extrabold tracking-tight text-gray-900 leading-tight">{big}</dt>
                <dd className="text-[13px] text-gray-500 leading-snug">{small}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  )
}
