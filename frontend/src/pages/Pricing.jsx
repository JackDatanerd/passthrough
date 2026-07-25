import { Link } from 'react-router-dom'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'

export default function Pricing() {
  return (
    <div className="min-h-screen flex flex-col bg-white">
      <Navbar />
      <main className="flex-1 max-w-3xl mx-auto px-4 py-16">
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold text-gray-900 mb-3">Pricing</h1>
          <p className="text-gray-500">Scan free, always. Pay once if you want the fix. No subscriptions.</p>
        </div>

        <div className="grid sm:grid-cols-3 gap-6">
          {/* Free */}
          <div className="rounded-xl border border-gray-200 p-6 flex flex-col">
            <div className="text-sm text-gray-500 mb-1">Free forever</div>
            <div className="text-4xl font-bold text-gray-900 mb-1">$0</div>
            <p className="text-sm text-gray-500 mb-6">3 scans per day</p>
            <ul className="flex flex-col gap-2 text-sm text-gray-600 mb-8 flex-1">
              {['ATS score out of 100','Keyword gap analysis','Format & section check','Content quality score','No account required'].map(f => (
                <li key={f} className="flex items-start gap-2">
                  <span className="text-green-500 mt-0.5">✓</span>{f}
                </li>
              ))}
            </ul>
            <Link to="/"
              className="text-center bg-white border border-gray-300 text-gray-700 px-4 py-2 rounded-md text-sm font-medium hover:bg-gray-50 transition-colors">
              Start scanning
            </Link>
          </div>

          {/* Badge */}
          <div className="rounded-xl border border-gray-200 p-6 flex flex-col">
            <div className="text-sm text-gray-500 mb-1">Credential only</div>
            <div className="text-4xl font-bold text-gray-900 mb-1">$39</div>
            <p className="text-sm text-gray-500 mb-6">Score 80+ required</p>
            <ul className="flex flex-col gap-2 text-sm text-gray-600 mb-8 flex-1">
              {['Passthrough Verified credential','Employer-checkable verification','Cryptographic integrity check','ATS-optimised .docx','Beautiful PDF'].map(f => (
                <li key={f} className="flex items-start gap-2">
                  <span className="text-green-500 mt-0.5">✓</span>{f}
                </li>
              ))}
            </ul>
            <Link to="/"
              className="text-center bg-blue-700 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-800 transition-colors">
              Scan first →
            </Link>
          </div>

          {/* Fix */}
          <div className="rounded-xl border-2 border-blue-600 p-6 flex flex-col relative">
            <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-blue-600 text-white text-xs px-3 py-1 rounded-full">
              Most popular
            </div>
            <div className="text-sm text-blue-600 font-medium mb-1">Full fix</div>
            <div className="text-4xl font-bold text-gray-900 mb-1">$49</div>
            <p className="text-sm text-gray-500 mb-6">Any score</p>
            <ul className="flex flex-col gap-2 text-sm text-gray-600 mb-8 flex-1">
              {['Full AI rewrite','ATS-optimised .docx','Beautiful designer PDF','Passthrough Verified credential','Cryptographic integrity check','Employer-checkable verification'].map(f => (
                <li key={f} className="flex items-start gap-2">
                  <span className="text-green-500 mt-0.5">✓</span>{f}
                </li>
              ))}
            </ul>
            <Link to="/"
              className="text-center bg-blue-700 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-800 transition-colors">
              Scan first →
            </Link>
          </div>
        </div>

        {/* Retry guarantee callout */}
        <div className="mt-10 bg-blue-50 border border-blue-200 rounded-xl p-6 text-center">
          <p className="font-semibold text-blue-900 mb-1">
            Included with every fix: we don't stop until you pass.
          </p>
          <p className="text-sm text-blue-700 leading-relaxed max-w-xl mx-auto">
            Multiple AI rewrite attempts, two free manual retries, and if we still can't
            get you past the verification threshold, a free credit for your next resume.
          </p>
        </div>

        <p className="text-center text-sm text-gray-400 mt-8">
          Payments processed by Paystack. One-time charge — no subscriptions, no surprise fees.
        </p>

        {/* Employer link */}
        <div className="mt-12 pt-8 border-t border-gray-100 text-center">
          <p className="text-sm text-gray-500 mb-1">Hiring, not job hunting?</p>
          <Link to="/#employers" className="text-sm font-medium text-blue-700 hover:text-blue-800 underline underline-offset-2">
            See how employers verify candidates →
          </Link>
        </div>
      </main>
      <Footer />
    </div>
  )
}
