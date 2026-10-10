const STEPS = [
  { title: 'Upload & scan', free: true, body: 'Upload your resume and paste the job description. Your score lands in about 30 seconds, with a full breakdown.' },
  { title: "See what's wrong", free: true, body: 'Keyword gaps, formatting problems, missing sections, weak content — specific and fixable, not one vague number.' },
  { title: 'Fix & verify', free: false, body: 'An AI-rewritten resume, an ATS-ready .docx and PDF, and a Verified link employers can check.' },
]

export default function HowItWorks() {
  return (
    <section id="how" className="py-16">
      <div className="max-w-5xl mx-auto px-4">
        <div className="text-center max-w-2xl mx-auto mb-9">
          <p className="text-xs font-bold uppercase tracking-wider text-blue-700 mb-2">How it works</p>
          <h2 className="text-3xl font-bold text-gray-900">See it free. Pay only when you want it fixed.</h2>
        </div>
        <ol className="grid md:grid-cols-3 gap-5">
          {STEPS.map((s, i) => (
            <li key={s.title} className="relative bg-white rounded-xl border border-gray-200 shadow-sm p-5">
              <div aria-hidden="true" className="w-8 h-8 rounded-full bg-blue-700 text-white font-bold flex items-center justify-center mb-3">{i + 1}</div>
              {s.free && <span className="absolute top-4 right-4 text-xs font-semibold bg-green-100 text-green-800 px-2.5 py-1 rounded-full">Free</span>}
              <h3 className="font-semibold text-gray-900 text-lg mb-1.5">{s.title}</h3>
              <p className="text-sm text-gray-500">{s.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}
