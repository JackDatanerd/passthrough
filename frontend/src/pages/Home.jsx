import { Link } from 'react-router-dom'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'
import ScanForm from '../components/scan/ScanForm'

// ── Demo score mockup ─────────────────────────────────────────────────────────
// Static illustration for the "How it works" section — matches the real
// CategoryScores component's exact keys/labels so this never misrepresents
// what the product actually measures.
function DemoScoreCard() {
  const rows = [
    { label: 'Keyword Match', value: 42, color: 'bg-red-500',   text: 'text-red-700'   },
    { label: 'Formatting',    value: 58, color: 'bg-amber-400', text: 'text-amber-700' },
    { label: 'Sections',      value: 71, color: 'bg-amber-400', text: 'text-amber-700' },
    { label: 'Content',       value: 39, color: 'bg-red-500',   text: 'text-red-700'   },
  ]
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 sm:p-8">
      <div className="flex items-center gap-6 mb-6">
        <div className="relative w-24 h-24 shrink-0">
          <svg width="96" height="96" viewBox="0 0 96 96">
            <circle cx="48" cy="48" r="40" fill="none" stroke="#fee2e2" strokeWidth="10" />
            <circle cx="48" cy="48" r="40" fill="none" stroke="#dc2626" strokeWidth="10"
              strokeLinecap="round" strokeDasharray={`${2 * Math.PI * 40 * 0.52} ${2 * Math.PI * 40}`}
              transform="rotate(-90 48 48)" />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-xl font-bold text-red-700">52</span>
            <span className="text-[10px] text-gray-400">/ 100</span>
          </div>
        </div>
        <div>
          <p className="font-semibold text-gray-900">This resume is failing ATS filters</p>
          <p className="text-sm text-gray-500 mt-0.5">Rejected before a recruiter ever opens it</p>
        </div>
      </div>
      <div className="flex flex-col gap-3">
        {rows.map(({ label, value, color, text }) => (
          <div key={label}>
            <div className="flex justify-between items-center mb-1">
              <span className="text-sm text-gray-600">{label}</span>
              <span className={`text-sm font-semibold ${text}`}>{value}</span>
            </div>
            <div className="h-2 w-full bg-gray-100 rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${color}`} style={{ width: `${value}%` }} />
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-gray-400 mt-5 pt-5 border-t border-gray-100">
        Illustrative example — your actual score and breakdown appear after a real scan.
      </p>
    </div>
  )
}

export default function Home() {
  return (
    <div className="min-h-screen flex flex-col bg-white">
      <Navbar />
      <main className="flex-1">

        {/* ── HERO ──────────────────────────────────────────────────────── */}
        <section className="bg-gradient-to-b from-blue-50 to-white border-b border-gray-100">
          <div className="max-w-5xl mx-auto px-4 py-16 text-center">
            <div className="inline-block bg-blue-100 text-blue-800 text-xs font-semibold px-3 py-1 rounded-full mb-4">
              Free ATS scan — no account needed
            </div>
            <h1 className="text-4xl sm:text-5xl font-bold text-gray-900 leading-tight mb-4">
              Your resume is losing to<br />a robot. Before a human sees it.
            </h1>
            <p className="text-lg text-gray-500 mb-2 max-w-2xl mx-auto">
              Applicant Tracking Systems reject the majority of resumes before a recruiter
              opens the file — including from qualified candidates. Find out if yours is
              one, in 30 seconds.
            </p>
            <p className="text-sm text-gray-400 mb-10">
              Built for how employers actually hire in the US and Europe — Workday,
              Greenhouse, iCIMS, Taleo, Lever, and SuccessFactors.
            </p>
          </div>
        </section>

        {/* ── SCAN FORM ─────────────────────────────────────────────────── */}
        <section className="max-w-2xl mx-auto px-4 -mt-6 pb-8">
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 sm:p-8">
            <h2 className="text-lg font-semibold text-gray-900 mb-5">
              Upload your resume + paste a job description
            </h2>
            <ScanForm />
          </div>
        </section>

        {/* ── FREE TIER LINE ───────────────────────────────────────────── */}
        <section className="max-w-2xl mx-auto px-4 pb-16">
          <div className="flex flex-wrap justify-center gap-x-8 gap-y-2 text-center">
            {[
              '3 free scans every day',
              'No credit card required',
              'Results in about 30 seconds',
            ].map((item) => (
              <div key={item} className="flex items-center gap-1.5 text-sm text-gray-500">
                <span className="text-green-500">✓</span>{item}
              </div>
            ))}
          </div>
        </section>

        {/* ── HOW IT WORKS ─────────────────────────────────────────────── */}
        <section className="bg-gray-50 border-t border-gray-100 py-16">
          <div className="max-w-5xl mx-auto px-4">
            <div className="grid lg:grid-cols-2 gap-12 items-center">
              <div>
                <h2 className="text-2xl font-bold text-gray-900 mb-6">
                  See exactly why you're being rejected
                </h2>
                <div className="flex flex-col gap-6">
                  {[
                    { step: '1', title: 'Upload & scan', body: 'Upload your resume and paste the job description. Our ATS engine scores it in ~30 seconds.' },
                    { step: '2', title: 'Get your score', body: 'A full breakdown — keyword gaps, formatting issues, missing sections, weak content — not just a single number.' },
                    { step: '3', title: 'Fix & verify', body: 'Pay once to get an AI-rewritten resume, an ATS-ready .docx, and a Passthrough Verified credential employers can check.' },
                  ].map(({ step, title, body }) => (
                    <div key={step} className="flex gap-4">
                      <div className="w-8 h-8 rounded-full bg-blue-700 text-white font-bold text-sm flex items-center justify-center shrink-0">
                        {step}
                      </div>
                      <div>
                        <h3 className="font-semibold text-gray-900 mb-1">{title}</h3>
                        <p className="text-sm text-gray-500">{body}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <DemoScoreCard />
            </div>
          </div>
        </section>

        {/* ── THREE WAYS TO START ──────────────────────────────────────── */}
        <section className="py-16">
          <div className="max-w-5xl mx-auto px-4">
            <div className="text-center mb-10">
              <h2 className="text-2xl font-bold text-gray-900 mb-2">
                Don't have a polished resume? Start anywhere.
              </h2>
              <p className="text-gray-500 max-w-xl mx-auto">
                Most ATS tools assume you already have a good resume to fix.
                Passthrough works even if you don't.
              </p>
            </div>
            <div className="grid sm:grid-cols-3 gap-5">
              {[
                {
                  title: 'Upload your resume',
                  body: 'Already have one? Upload it as a PDF or .docx and we\'ll score it against the job.',
                },
                {
                  title: 'Start from scratch',
                  body: 'No resume yet? Paste a brain dump, an old resume, or just describe your background in your own words. We\'ll structure it for you.',
                },
                {
                  title: 'Reuse a saved profile',
                  body: 'Applying to multiple roles? Save your profile once and re-score it against every new job description in seconds.',
                },
              ].map(({ title, body }) => (
                <div key={title} className="rounded-xl border border-gray-200 p-6">
                  <h3 className="font-semibold text-gray-900 mb-2">{title}</h3>
                  <p className="text-sm text-gray-500">{body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── RETRY GUARANTEE ──────────────────────────────────────────── */}
        <section className="bg-blue-700 py-16">
          <div className="max-w-4xl mx-auto px-4 text-center text-white">
            <h2 className="text-2xl sm:text-3xl font-bold mb-4">
              We don't stop until you pass — or your next resume is free.
            </h2>
            <p className="text-blue-100 max-w-2xl mx-auto mb-8 leading-relaxed">
              When you pay for a fix, our AI doesn't just take one pass at your resume.
              It rewrites, re-scores, and rewrites again — multiple attempts internally,
              plus two free retries on your end if the first result isn't strong enough.
              If we still can't get you past the verification threshold, we bank a free
              fix credit on your account for next time. No charge.
            </p>
            <div className="flex flex-wrap justify-center gap-x-10 gap-y-3 text-sm text-blue-100">
              <span>✓ Multiple AI rewrite attempts per fix</span>
              <span>✓ 2 free manual retries included</span>
              <span>✓ Free credit if we still fall short</span>
            </div>
          </div>
        </section>

        {/* ── EMPLOYER VERIFICATION ────────────────────────────────────── */}
        <section id="employers" className="py-16">
          <div className="max-w-5xl mx-auto px-4">
            <div className="grid lg:grid-cols-2 gap-12 items-center">
              <div>
                <div className="inline-block bg-green-100 text-green-800 text-xs font-semibold px-3 py-1 rounded-full mb-4">
                  For employers & hiring managers
                </div>
                <h2 className="text-2xl font-bold text-gray-900 mb-4">
                  Verified once. Trusted everywhere.
                </h2>
                <p className="text-gray-500 mb-4 leading-relaxed">
                  Every Passthrough Verified resume comes with a shareable link that
                  proves the ATS score is real — and that the file hasn't been altered
                  since it was verified. We cryptographically hash the exact document
                  at verification time and re-check it on every view.
                </p>
                <p className="text-gray-500 mb-6 leading-relaxed">
                  No phone calls. No guesswork. Open the link, see the score, the
                  category breakdown, and an integrity check that reads
                  "Unmodified" or "Modified" — instantly.
                </p>
                <p className="text-sm text-gray-400">
                  Every Verified credential includes a link like this one, unique
                  to that candidate's resume.
                </p>
              </div>
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 sm:p-8 text-center">
                <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
                  <span className="text-green-600 text-2xl">✓</span>
                </div>
                <p className="font-semibold text-gray-900 mb-1">Passthrough Verified</p>
                <div className="grid grid-cols-2 gap-3 mt-6 text-sm">
                  <div className="bg-gray-50 rounded-lg p-3">
                    <p className="text-gray-400 text-xs mb-1">ATS Score</p>
                    <p className="font-bold text-lg text-green-700">87</p>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-3">
                    <p className="text-gray-400 text-xs mb-1">Integrity</p>
                    <p className="font-bold text-sm text-green-700">Unmodified</p>
                  </div>
                </div>
                <p className="text-xs text-gray-400 mt-5">
                  Illustrative example of what employers see when they open a
                  candidate's verification link.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ── PRICING TEASER ───────────────────────────────────────────── */}
        <section className="max-w-5xl mx-auto px-4 py-16 border-t border-gray-100">
          <div className="text-center">
            <h2 className="text-2xl font-bold text-gray-900 mb-3">Simple pricing</h2>
            <p className="text-gray-500 mb-8">Scan free, always. Pay once if you want the fix.</p>
            <div className="inline-grid sm:grid-cols-3 gap-4 text-left">
              <div className="rounded-lg border border-gray-200 p-6">
                <div className="text-sm text-gray-500 mb-1">Free forever</div>
                <div className="text-3xl font-bold text-gray-900 mb-1">$0</div>
                <p className="text-sm text-gray-500">3 scans a day. Full score breakdown. No account required.</p>
              </div>
              <div className="rounded-lg border border-gray-200 p-6">
                <div className="text-sm text-gray-500 mb-1">Credential only</div>
                <div className="text-3xl font-bold text-gray-900 mb-1">$39</div>
                <p className="text-sm text-gray-500">Verified credential for resumes already scoring 80+.</p>
              </div>
              <div className="rounded-lg border border-blue-200 bg-blue-50 p-6">
                <div className="text-sm text-blue-600 font-medium mb-1">Full fix</div>
                <div className="text-3xl font-bold text-gray-900 mb-1">$49</div>
                <p className="text-sm text-gray-600">AI rewrite + ATS .docx + PDF + Verified credential. Any score.</p>
              </div>
            </div>
            <Link
              to="/pricing"
              className="inline-block mt-8 text-sm font-medium text-blue-700 hover:text-blue-800 underline underline-offset-2"
            >
              See full pricing details →
            </Link>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  )
}
