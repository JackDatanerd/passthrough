export default function HomeFaq({ items }) {
  // Same questions feed the visible accordion and the FAQPage structured data, so search results can
  // never show an answer the page does not.
  const jsonLd = {
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: items.map(i => ({ '@type': 'Question', name: i.q, acceptedAnswer: { '@type': 'Answer', text: i.a } })),
  }
  return (
    <section id="faq" className="bg-gray-50 border-t border-gray-100 py-16">
      <div className="max-w-3xl mx-auto px-4">
        <h2 className="text-3xl font-bold text-gray-900 text-center mb-8">Questions, answered straight</h2>
        <div className="flex flex-col gap-2.5">
          {items.map(i => (
            <details key={i.id} id={i.id} className="group bg-white rounded-xl border border-gray-200 px-5 scroll-mt-4 target:border-blue-400">
              <summary className="cursor-pointer list-none flex items-center justify-between gap-3 py-4 font-semibold text-gray-900 [&::-webkit-details-marker]:hidden">
                {i.q}
                <span aria-hidden="true" className="text-blue-700 font-extrabold group-open:hidden">＋</span>
                <span aria-hidden="true" className="text-blue-700 font-extrabold hidden group-open:inline">−</span>
              </summary>
              <p className="pb-4 text-gray-600 text-[15px]">{i.a}</p>
            </details>
          ))}
        </div>
      </div>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }} />
    </section>
  )
}
