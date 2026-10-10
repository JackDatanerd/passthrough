import { useContext } from 'react'
import ScanForm from '../scan/ScanForm'
import { AuthContext } from '../../context/AuthContext'
import { formatScanCount } from '../../lib/homeFormat'

// The hero carries the page's single job: get the visitor to scan. The proof sits right beside the
// scan card (not three screens below it) because that is where doubt about uploading a resume lives.
export default function HomeHero({ data }) {
  // Null-safe, like usePricing: a bare render must not throw.
  const signedIn = !!useContext(AuthContext)?.user
  const scans = formatScanCount(data.scans.value, { atLeast: data.scans.isFallback })
  const rate = data.rate.pct
  const ticks = signedIn
    ? ['Saved to your dashboard', 'Full breakdown free', 'Pay only if you want the fix']
    : ['No account needed', 'Full breakdown free', 'Pay only if you want the fix']

  return (
    <section className="bg-gradient-to-b from-blue-50 to-white border-b border-gray-100">
      <div className="max-w-5xl mx-auto px-4 pt-12 pb-10 grid lg:grid-cols-[1.05fr_.95fr] gap-10 items-center">
        <div>
          {scans && (
            <div className="inline-flex items-center gap-1.5 bg-blue-100 text-blue-800 text-xs font-semibold px-3 py-1 rounded-full mb-4">
              <span aria-hidden="true">★</span> {scans} resumes scanned
            </div>
          )}
          <h1 className="text-4xl sm:text-5xl font-extrabold text-gray-900 leading-[1.1] tracking-tight mb-4">
            Get past the robot.<br />
            <span className="text-blue-700">Get the interview.</span>
          </h1>
          <p className="text-lg text-gray-600 max-w-xl mb-5">
            Most ATS tools hand you a score and walk away. Passthrough shows exactly why you&apos;re being
            filtered out, fixes it, and gives employers a link that <strong className="text-gray-900">proves</strong> your
            resume is real.
            {rate != null && (
              <> <strong className="text-gray-900">{rate}% of applicants</strong> report an interview<sup><a href="#faq-66" aria-label="Where this figure comes from" className="text-blue-700">*</a></sup>.</>
            )}
          </p>
          <p className="text-sm text-gray-500">
            Built for how employers actually hire — Workday, Greenhouse, iCIMS, Taleo, Lever and SuccessFactors.
          </p>
        </div>

        <div id="scan-form" className="scroll-mt-4 bg-white rounded-xl border border-gray-200 shadow-lg p-5 sm:p-6">
          <h2 className="text-base font-semibold text-gray-900 mb-4">Scan your resume — free, about 30 seconds</h2>
          <ScanForm />
          <ul className="mt-4 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-gray-500">
            {ticks.map(t => <li key={t}><span className="text-green-600 font-bold" aria-hidden="true">✓ </span>{t}</li>)}
          </ul>
        </div>
      </div>
    </section>
  )
}
