import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import api from '../lib/api'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'
import { ATTRIBUTION_TERMS } from '../lib/partnerTerms'
import { formatCents } from '../lib/utils'

// Section 4 round 6: the partner program had no terms anywhere — an applicant agreed to nothing, and the numbers
// that decide when and how much they are paid (hold period, minimum payout, the payout-details hold) were known
// only to the admin. Public (no token). The live numbers come from GET /api/partners/program so this page can never
// state a hold or minimum that differs from what the payout run actually enforces; if that request fails the page
// still renders, saying where the figures are instead of guessing them.
//
// The terms VERSION a partner accepts is the server's PARTNER_TERMS_VERSION, recorded with the application.

function Section({ title, children }) {
  return (
    <section className="mb-8">
      <h2 className="text-xl font-semibold text-gray-900 mb-3">{title}</h2>
      <div className="text-gray-600 text-sm leading-relaxed flex flex-col gap-3">{children}</div>
    </section>
  )
}

export default function PartnerTerms() {
  const [program, setProgram] = useState(null)

  useEffect(() => {
    let cancelled = false
    api.get('/partners/program')
      .then(res => { if (!cancelled && res?.data?.data) setProgram(res.data.data) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const hold = program?.holdDays
  const min = program?.minPayoutCents
  const detailsHours = program?.payoutDetailsHoldHours
  const cooldown = program?.reapplyCooldownDays

  return (
    <div className="min-h-screen flex flex-col bg-white">
      <Navbar />
      <main className="flex-1 max-w-3xl mx-auto px-4 py-16 w-full" data-testid="partner-terms">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Partner Program Terms</h1>
        <p className="text-sm text-gray-400 mb-10">
          {program?.termsVersion ? `Version ${program.termsVersion}` : 'Current version'}
          {' · '}<Link to="/partner/apply" className="text-blue-700 hover:underline">Apply to become a partner</Link>
        </p>

        <Section title="1. Applying and approval">
          <p>
            Every application is reviewed by hand. Approval is at our discretion; we may decline an application without giving
            a reason{cooldown ? `, and a declined applicant can apply again after ${cooldown} days` : ''}. Applying does not create
            an account, and nothing is owed to you until you are approved and a sale is credited to you.
          </p>
        </Section>

        <Section title="2. Your link, your code and your commission rate">
          <p>
            Once approved you receive a link and one or more referral codes. Your commission rate is set when you are approved
            and shown on your partner dashboard; if it changes we email you. Commission is calculated on the amount the
            customer actually paid, after any discount the code gives.
          </p>
          <p>You may not use your own link or code for your own purchases — a purchase by you is not credited and the code's discount is not applied to it.</p>
        </Section>

        <Section title="3. How a sale is credited to you">
          <ul className="list-disc pl-5 space-y-1">
            {ATTRIBUTION_TERMS.map(t => <li key={t}>{t}</li>)}
            <li>
              Credit follows the browser the visitor used. A sale made on a different device, or after the visitor cleared their
              browser data, is only credited if they enter your code at checkout.
            </li>
            <li>If a visitor follows another partner's link after yours, the most recent click is the one credited.</li>
          </ul>
        </Section>

        <Section title="4. Refunds and chargebacks">
          <p>
            If a purchase credited to you is refunded, or its payment is reversed, the commission on it is reversed too. If it has
            already been paid to you, the reversal is taken from your next payout. A purchase under dispute is held out of
            payouts until the dispute is resolved.
          </p>
        </Section>

        <Section title="5. When you are paid">
          <ul className="list-disc pl-5 space-y-1">
            <li>Commission is grouped into two cycles a month, in UTC: the 1st to the 15th, and the 16th to the end of the month.</li>
            <li>A cycle becomes payable once it has closed. We record each payout on your dashboard and email you when it is sent.</li>
            <li>
              {hold > 0
                ? `Each sale is held for ${hold} day${hold === 1 ? '' : 's'} after it is made (the refund window) before it can be paid.`
                : program ? 'There is currently no extra holding period beyond the cycle itself.' : 'A holding period may apply to each sale; your dashboard shows what is being held and until when.'}
            </li>
            <li>
              {min > 0
                ? `Amounts below ${formatCents(min, program.currency)} are carried forward to the next cycle rather than paid out.`
                : program ? 'There is currently no minimum payout amount.' : 'A minimum payout amount may apply; your dashboard shows any balance being carried forward.'}
            </li>
            <li>Payouts are made by bank transfer or mobile money, to the details you give us.</li>
          </ul>
        </Section>

        <Section title="6. Your payout details">
          <p>
            You add or change your payout details using a private link we email you. Keep that link private — anyone who has it can
            change where your payouts go. Every change is emailed to you, and{' '}
            {detailsHours > 0
              ? `after any change we do not send a payout for at least ${detailsHours} hours unless we have confirmed the change with you directly.`
              : 'we may confirm a recent change with you before sending a payout.'}
            {' '}If you did not make a change you are told about, contact us straight away.
          </p>
        </Section>

        <Section title="7. Conduct, pausing and ending">
          <p>
            Describe Passthrough honestly. Do not mislead people about what it does or costs, and do not generate clicks or purchases
            that are not genuine. We may pause your link or end your membership if these terms are broken. A paused link earns
            nothing and gives no discount; commission already earned before the pause is still paid, less any reversals.
          </p>
        </Section>

        <Section title="8. Changes to these terms">
          <p>
            We may update these terms. The version you accepted when you applied is recorded; if a change matters to you we will
            tell you by email before it applies.
          </p>
        </Section>

        <p className="text-sm text-gray-500">
          Questions? Contact <a href="mailto:support@passthrough.dev" className="text-blue-700 hover:underline">support@passthrough.dev</a>.
        </p>
      </main>
      <Footer />
    </div>
  )
}
