import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'

const LAST_UPDATED = 'July 24, 2026'

function Section({ title, children }) {
  return (
    <section className="mb-8">
      <h2 className="text-xl font-semibold text-gray-900 mb-3">{title}</h2>
      <div className="text-gray-600 text-sm leading-relaxed flex flex-col gap-3">{children}</div>
    </section>
  )
}

export default function Terms() {
  return (
    <div className="min-h-screen flex flex-col bg-white">
      <Navbar />
      <main className="flex-1 max-w-3xl mx-auto px-4 py-16 w-full">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Terms of Service</h1>
        <p className="text-sm text-gray-400 mb-10">Last updated: {LAST_UPDATED}</p>

        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 mb-10 text-sm text-amber-800">
          Passthrough is operated by Saltern Studio.
        </div>

        <Section title="1. What Passthrough Is">
          <p>
            Passthrough ("we," "us," "the Service") is an automated resume-scanning and rewriting
            tool. You upload a resume (or describe your background as free text) and a job
            description (or its URL), and we return an estimated Applicant Tracking System (ATS)
            compatibility score, and — if purchased — an AI-rewritten version of your resume
            tailored to that job description, an ATS-optimized .docx file, a formatted PDF, and a
            public verification link.
          </p>
          <p>
            The ATS score is an estimate produced by our own scoring logic and, where applicable,
            an AI model. It is not affiliated with, endorsed by, or guaranteed to match the results
            of any specific employer's actual applicant tracking system (e.g. Workday, Taleo,
            Greenhouse, iCIMS). Different ATS platforms parse and rank resumes differently, and no
            score — from us or from any competitor — can guarantee how a specific employer's system
            will treat your resume.
          </p>
        </Section>

        <Section title="2. Accounts">
          <p>
            You can run a limited number of free scans without an account. Purchasing a resume fix,
            downloading generated files, or accessing your scan history requires creating an account
            with a valid email address. You're responsible for keeping your login credentials
            secure and for all activity under your account. You must be at least 16 years old to use
            Passthrough — if we learn an account belongs to someone younger, we'll close it.
          </p>
        </Section>

        <Section title="3. What You're Paying For">
          <p>
            Passthrough charges one-time, per-resume fees — not a subscription. Current pricing is
            shown on our <a href="/pricing" className="text-blue-600 underline">Pricing page</a>,
            which is the authoritative source; nothing here should be read as a fixed price
            commitment, since pricing may change for future purchases.
          </p>
          <p>
            <strong>Fix ($49 at time of writing):</strong> a full AI rewrite of your resume tailored
            to the job description you provided, delivered as an ATS-optimized .docx and a
            formatted PDF, plus a public verification link. If the first attempt doesn't reach our
            80+ "Passthrough Verified" score threshold, the system automatically retries with
            specific feedback about what fell short, up to the limits described in Section 4. You
            always receive the resume, regardless of whether it reaches the threshold.
          </p>
          <p>
            <strong>Verified Credential only:</strong> issues a verification badge and public link
            for your existing resume content, without an AI rewrite. Only available if your resume
            already scores at or above the Verified threshold.
          </p>
          <p>
            Payments are processed by Paystack. We do not store your card details — Paystack handles
            that directly, subject to their own terms and security practices.
          </p>
        </Section>

        <Section title="4. Retries and Free Credits">
          <p>
            If a Fix doesn't reach the Passthrough Verified score threshold, you can retry it for
            free, building on the improved version rather than starting over, up to twice per
            purchase. If both free retries still don't reach the threshold, we automatically credit
            your account with one free Fix, usable on a future resume, at no additional charge. This
            is not a cash refund — it's service credit, and it doesn't expire unless we notify you
            otherwise.
          </p>
          <p>
            We don't currently offer cash refunds for a Fix that doesn't reach the target score,
            given the free retry and credit mechanism above. If something went genuinely wrong on
            our end (a failed delivery, a technical error, a duplicate charge), contact{' '}
            <a href="mailto:support@passthrough.dev" className="text-blue-600 underline">
              support@passthrough.dev
            </a>{' '}
            and we'll make it right.
          </p>
        </Section>

        <Section title="5. Your Content">
          <p>
            You own your resume, your job description text, and anything else you submit to
            Passthrough. We don't claim any ownership over it. You grant us a limited license to
            process, store, and transmit that content — including to third-party AI providers (see
            Section 6) — solely to provide the Service to you.
          </p>
          <p>
            You're responsible for the accuracy of what you submit. Our AI rewrite is instructed not
            to invent employers, credentials, dates, or metrics you didn't provide — but you're
            responsible for reviewing the final output before sending it to an employer, the same as
            you would with any resume you write yourself. We're not liable for consequences of
            inaccurate information you originally provided, even if it appears in the rewritten
            output.
          </p>
        </Section>

        <Section title="6. AI Processing">
          <p>
            Generating the AI rewrite and structuring free-text career descriptions involves sending
            your resume content and job description text to Anthropic's Claude API for processing.
            Anthropic processes this data under their own API terms and data-handling policies. See
            our <a href="/privacy" className="text-blue-600 underline">Privacy Policy</a> for more on
            what's shared and why.
          </p>
        </Section>

        <Section title="7. Verification Links">
          <p>
            A purchased Fix or Credential includes a public verification link
            (passthrough.dev/v/CODE) that anyone with the link — including an employer — can visit
            to see your ATS score, integrity status, and basic role/seniority category. This link is
            public by design; it's meant to be shared with employers. Don't purchase a verification
            credential for content you don't want a third party to potentially view via that link.
          </p>
        </Section>

        <Section title="8. Acceptable Use">
          <p>You agree not to:</p>
          <ul className="list-disc pl-5 flex flex-col gap-1">
            <li>Submit someone else's resume or personal information without their consent</li>
            <li>Use the Service to generate fraudulent, deceptive, or intentionally misleading credentials or work history</li>
            <li>Attempt to reverse-engineer, scrape, or overload the Service beyond normal individual use</li>
            <li>Use the Service for any unlawful purpose</li>
          </ul>
        </Section>

        <Section title="9. No Guarantee of Employment Outcomes">
          <p>
            Passthrough estimates ATS compatibility and helps improve resume content — it does not
            guarantee interviews, job offers, or any specific employment outcome. Hiring decisions
            depend on many factors outside our control.
          </p>
        </Section>

        <Section title="10. Service Availability">
          <p>
            We aim for reliable uptime but don't guarantee the Service will be available
            uninterrupted or error-free. We may modify, suspend, or discontinue features with or
            without notice.
          </p>
        </Section>

        <Section title="11. Limitation of Liability">
          <p>
            To the maximum extent permitted by law, Passthrough and its operators aren't liable for
            indirect, incidental, or consequential damages arising from your use of the Service,
            including — but not limited to — lost job opportunities, lost income, or reliance on an
            ATS score that doesn't match a specific employer's actual system behavior. Our total
            liability for any claim is limited to the amount you paid us in the 12 months before the
            claim arose.
          </p>
        </Section>

        <Section title="12. Changes to These Terms">
          <p>
            We may update these terms from time to time. Material changes will be reflected by
            updating the date at the top of this page. Continued use of the Service after an update
            means you accept the revised terms.
          </p>
        </Section>

        <Section title="13. Contact">
          <p>
            Questions about these terms:{' '}
            <a href="mailto:support@passthrough.dev" className="text-blue-600 underline">
              support@passthrough.dev
            </a>
          </p>
        </Section>
      </main>
      <Footer />
    </div>
  )
}
