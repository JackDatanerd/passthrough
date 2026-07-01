import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'
import ScanForm from '../components/scan/ScanForm'

export default function Home() {
  return (
    <div className="min-h-screen flex flex-col bg-white">
      <Navbar />
      <main className="flex-1">
        {/* Hero */}
        <section className="bg-gradient-to-b from-blue-50 to-white border-b border-gray-100">
          <div className="max-w-5xl mx-auto px-4 py-16 text-center">
            <div className="inline-block bg-blue-100 text-blue-800 text-xs font-semibold px-3 py-1 rounded-full mb-4">
              Free ATS scan — no account needed
            </div>
            <h1 className="text-4xl sm:text-5xl font-bold text-gray-900 leading-tight mb-4">
              Does your resume pass<br />the ATS filter?
            </h1>
            <p className="text-lg text-gray-500 mb-2 max-w-xl mx-auto">
              75% of resumes are rejected before a recruiter opens the file.
              Find out if yours is one — in 30 seconds.
            </p>
            <p className="text-sm text-gray-400 mb-10">
              Used by job seekers in Nairobi, Lagos, Manila, Bangalore, and beyond.
            </p>
          </div>
        </section>

        {/* Scan form */}
        <section className="max-w-2xl mx-auto px-4 -mt-6 pb-16">
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 sm:p-8">
            <h2 className="text-lg font-semibold text-gray-900 mb-5">
              Upload your resume + paste a job description
            </h2>
            <ScanForm />
          </div>
        </section>

        {/* How it works */}
        <section className="bg-gray-50 border-t border-gray-100 py-16">
          <div className="max-w-5xl mx-auto px-4">
            <h2 className="text-2xl font-bold text-gray-900 text-center mb-10">How it works</h2>
            <div className="grid sm:grid-cols-3 gap-8 text-center">
              {[
                { step: '1', title: 'Upload & scan', body: 'Upload your resume and paste the job description. Our ATS engine scores it in ~30 seconds.' },
                { step: '2', title: 'Get your score', body: 'See exactly why you\'re being rejected — keyword gaps, formatting issues, missing sections.' },
                { step: '3', title: 'Fix & verify', body: 'Pay once to get an AI-rewritten resume with a Passthrough Verified credential employers can check.' },
              ].map(({ step, title, body }) => (
                <div key={step}>
                  <div className="w-10 h-10 rounded-full bg-blue-700 text-white font-bold text-sm flex items-center justify-center mx-auto mb-3">
                    {step}
                  </div>
                  <h3 className="font-semibold text-gray-900 mb-2">{title}</h3>
                  <p className="text-sm text-gray-500">{body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Pricing teaser */}
        <section className="max-w-5xl mx-auto px-4 py-16">
          <div className="text-center">
            <h2 className="text-2xl font-bold text-gray-900 mb-3">Simple pricing</h2>
            <p className="text-gray-500 mb-8">Scan free. Pay once if you want the fix.</p>
            <div className="inline-grid sm:grid-cols-2 gap-4 text-left">
              <div className="rounded-lg border border-gray-200 p-6">
                <div className="text-sm text-gray-500 mb-1">Credential only</div>
                <div className="text-3xl font-bold text-gray-900 mb-1">$39</div>
                <p className="text-sm text-gray-500">Verified credential for resumes scoring 80+. Employer-checkable verification.</p>
              </div>
              <div className="rounded-lg border border-blue-200 bg-blue-50 p-6">
                <div className="text-sm text-blue-600 font-medium mb-1">Full fix</div>
                <div className="text-3xl font-bold text-gray-900 mb-1">$49</div>
                <p className="text-sm text-gray-600">AI rewrite + ATS .docx + beautiful PDF + Verified credential. Any score.</p>
              </div>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  )
}
