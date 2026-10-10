import EmployerLeadForm from '../lead/EmployerLeadForm'

export default function EmployerSection() {
  return (
    <section id="employers" className="py-16 scroll-mt-4">
      <div className="max-w-5xl mx-auto px-4 grid lg:grid-cols-2 gap-10 items-start">
        <div>
          <div className="inline-block bg-green-100 text-green-800 text-xs font-semibold px-3 py-1 rounded-full mb-3.5">For employers &amp; hiring managers</div>
          <h2 className="text-3xl font-bold text-gray-900 mb-4">Verified once. Trusted everywhere.</h2>
          <p className="text-gray-600 mb-4 leading-relaxed">
            Skip the guesswork on resumes. Every Passthrough Verified link shows the real ATS score, the category
            breakdown, and whether the file has changed since it was verified — we fingerprint the exact document and re-check it on every view.
          </p>
          <ul className="flex flex-col gap-2 text-[15px] text-gray-700">
            {['Open the link — no account, no phone call', 'Integrity check reads “Unmodified” or “Modified”', 'Check any file you were sent against its fingerprint'].map(t => (
              <li key={t}><span aria-hidden="true" className="text-green-600 font-extrabold mr-2">✓</span>{t}</li>
            ))}
          </ul>
        </div>
        <EmployerLeadForm />
      </div>
    </section>
  )
}
