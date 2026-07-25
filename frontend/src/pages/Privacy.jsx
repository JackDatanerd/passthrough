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

export default function Privacy() {
  return (
    <div className="min-h-screen flex flex-col bg-white">
      <Navbar />
      <main className="flex-1 max-w-3xl mx-auto px-4 py-16 w-full">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Privacy Policy</h1>
        <p className="text-sm text-gray-400 mb-10">Last updated: {LAST_UPDATED}</p>

        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 mb-10 text-sm text-amber-800">
          This draft describes what Passthrough's systems actually do with your data today. Before
          this goes live, replace [Legal Entity Name] / [jurisdiction] below with your real
          registered details, and have a lawyer confirm what's required for your specific user base
          — for example, GDPR gives EU/UK residents specific rights (access, deletion, portability,
          objection), and other jurisdictions (Nigeria's NDPA, Kenya's DPA, the Philippines' Data
          Privacy Act, US state laws like CCPA) impose their own requirements. This page states our
          actual practices; it isn't legal certification of compliance with any specific law.
        </div>

        <Section title="1. Who We Are">
          <p>
            Passthrough is operated by [Legal Entity Name]. For any privacy question or request,
            contact{' '}
            <a href="mailto:support@passthrough.dev" className="text-blue-600 underline">
              support@passthrough.dev
            </a>.
          </p>
        </Section>

        <Section title="2. What We Collect">
          <p><strong>Account information:</strong> name and email address, when you register.</p>
          <p>
            <strong>Resume content:</strong> the file you upload, or the free text you paste, plus
            any structured resume data we extract or you save to your profile — name, contact
            details, work history, education, skills, and similar fields your resume normally
            contains.
          </p>
          <p>
            <strong>Job description content:</strong> text you paste, or the URL you provide (which
            we fetch and read the page content of).
          </p>
          <p>
            <strong>Payment information:</strong> Paystack processes your payment directly — we
            receive transaction status, amount, and a reference ID, never your card number.
          </p>
          <p>
            <strong>Technical data:</strong> IP address (used for rate-limiting and anonymous scan
            allowances), and basic request logs.
          </p>
        </Section>

        <Section title="3. How We Use It">
          <ul className="list-disc pl-5 flex flex-col gap-1">
            <li>To generate your ATS score, and — if purchased — an AI-rewritten resume tailored to your job description</li>
            <li>To process payments and maintain your purchase/credit history</li>
            <li>To send account, verification, and delivery emails (via Resend)</li>
            <li>To enforce free-tier usage limits and prevent abuse</li>
            <li>To improve the accuracy of our ATS scoring over time</li>
          </ul>
          <p>We don't sell your data, and we don't use your resume content for advertising.</p>
        </Section>

        <Section title="4. Third Parties We Share Data With">
          <p>
            We use a small number of infrastructure and service providers to run Passthrough, each
            processing only what's needed for their specific function:
          </p>
          <ul className="list-disc pl-5 flex flex-col gap-1">
            <li><strong>Anthropic (Claude API):</strong> receives your resume content and job description text to generate the AI rewrite, structure free-text career descriptions, and assist with scoring. Subject to Anthropic's own data-handling terms.</li>
            <li><strong>Supabase:</strong> hosts our database (accounts, scans, resume data, payment records).</li>
            <li><strong>Cloudflare:</strong> hosts our application (Workers), stores uploaded/generated files (R2), and provides rate-limiting infrastructure (KV).</li>
            <li><strong>Paystack:</strong> processes payments.</li>
            <li><strong>Resend:</strong> delivers transactional emails (verification, delivery, receipts).</li>
          </ul>
          <p>We don't share your resume content with any other party, and never with employers directly — the verification link (Section 6) is the one exception, and it's only ever visited by whoever you choose to share it with.</p>
        </Section>

        <Section title="5. Data Retention">
          <p>
            <strong>Anonymous scans</strong> (run without an account) are automatically deleted a
            short time after creation — our system runs an hourly cleanup job specifically for this.
            If you want to keep your results, create an account before the scan expires.
          </p>
          <p>
            <strong>Account-linked scans and resume data</strong> are retained as long as your
            account exists, so your scan history and saved profile stay available to you. You can
            request deletion at any time (Section 7).
          </p>
          <p>
            <strong>Payment records</strong> are retained for accounting and legal purposes even
            after account deletion, as required for financial record-keeping.
          </p>
        </Section>

        <Section title="6. Verification Links Are Public">
          <p>
            If you purchase a Fix or Credential, a public verification page is generated
            (passthrough.dev/v/CODE) showing your ATS score, integrity status, and role/seniority
            category — not your full resume content. Anyone with that link can view this page; it's
            designed to be shared with employers. Don't purchase a credential if you don't want this
            summary information potentially viewable by anyone with the link.
          </p>
        </Section>

        <Section title="7. Your Rights">
          <p>You can, at any time:</p>
          <ul className="list-disc pl-5 flex flex-col gap-1">
            <li>Access the personal data we hold about you</li>
            <li>Correct inaccurate data (via your account settings, or by contacting us)</li>
            <li>Request deletion of your account and associated data</li>
            <li>Export your data in a portable format</li>
          </ul>
          <p>
            To exercise any of these, email{' '}
            <a href="mailto:support@passthrough.dev" className="text-blue-600 underline">
              support@passthrough.dev
            </a>. We'll respond within a reasonable timeframe — if you're in a jurisdiction with a
            legally mandated response window (e.g. GDPR's 30 days), let us know and we'll honor it.
          </p>
        </Section>

        <Section title="8. Security">
          <p>
            Passwords are hashed, not stored in plain text. Payment card details never touch our
            servers — Paystack handles that directly. We use industry-standard access controls on
            our infrastructure, but no system is perfectly secure, and we can't guarantee absolute
            security of data transmitted to us.
          </p>
        </Section>

        <Section title="9. Children">
          <p>
            Passthrough isn't intended for anyone under 16. We don't knowingly collect data from
            children under that age.
          </p>
        </Section>

        <Section title="10. Changes to This Policy">
          <p>
            We may update this policy as the product changes. Material changes will be reflected by
            updating the date at the top of this page.
          </p>
        </Section>

        <Section title="11. Contact">
          <p>
            Privacy questions or requests:{' '}
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
