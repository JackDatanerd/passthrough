import { useState, useEffect } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import api from '../lib/api'
import { partnerAuth } from '../lib/partnerApi'
import { useApi } from '../hooks/useApi'
import Button from '../components/ui/Button'
import Form from '../components/ui/Form'
import Input from '../components/ui/Input'
import Checkbox from '../components/ui/Checkbox'
import Select from '../components/ui/Select'
import { BANK_COUNTRIES, OTHER_COUNTRY, bankRail, routingInfo, bankProblem, EMAIL_RE } from '../lib/payoutRails'
import Spinner from '../components/ui/Spinner'
import PartnerLayout from '../components/partner/PartnerLayout'
import { formatDateTime } from '../lib/utils'

// Public page, reached via the link emailed by adminCreatePartner /
// adminResendPayoutLink — identity is the ?token= in the URL, not a login.
// No account system for partners exists yet; the token IS the auth.

// Mirrors the server's formats (partners.controller.js: ACCOUNT_NUMBER_RE / PHONE_RE) so a
// typo is caught here with a plain message instead of a round trip — and, together with the
// re-enter-to-confirm fields, before real money is sent to a wrong account later.
const ACCOUNT_NUMBER_RE = /^[A-Za-z0-9][A-Za-z0-9 \-]{3,41}$/
const PHONE_RE          = /^\+?\(?[0-9][0-9 ()\-]{6,19}$/
const squash = v => String(v || '').replace(/\s+/g, '')

export default function PartnerPayoutDetails() {
  const [params] = useSearchParams()
  const token = params.get('token')

  const [loading,  setLoading ] = useState(true)
  const [invalid,  setInvalid ] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [partnerName, setPartnerName] = useState('')
  const [alreadySubmittedAt, setAlreadySubmittedAt] = useState(null)
  // Read-only token for the "view your dashboard" link, so the write-capable token in this
  // page's URL never travels into a dashboard URL.
  const [dashboardToken, setDashboardToken] = useState(null)

  const [method, setMethod] = useState('BANK')
  const [bankName, setBankName] = useState('')
  const [accountName, setAccountName] = useState('')
  const [accountNumber, setAccountNumber] = useState('')
  const [provider, setProvider] = useState('')
  const [phoneNumber, setPhoneNumber] = useState('')
  const [paypalEmail, setPaypalEmail] = useState('')
  // Where the bank account is held decides which routing details are needed (ACH routing number, sort code, BSB, IBAN, SWIFT/BIC).
  const [bankCountry, setBankCountry] = useState('')
  const [otherCountry, setOtherCountry] = useState('')
  const [routingCode, setRoutingCode] = useState('')
  // Canada's routing code is two numbers whose ORDER matters (transit, then institution), so it is two boxes, joined with a dash.
  const [caTransit, setCaTransit] = useState('')
  const [caInstitution, setCaInstitution] = useState('')
  const [swiftBic, setSwiftBic] = useState('')
  const [confirmNumber, setConfirmNumber] = useState('')
  // Round 9: the server returns the saved account / phone as its last four digits only (the link is a bearer
  // credential), so what is on file is shown as a reference and the number has to be typed again to save.
  const [onFile, setOnFile] = useState('')
  // What the server has for the payout destination (apart from the number), so an edit to it is noticed — see handleSubmit.
  const [loadedPayout, setLoadedPayout] = useState(null)
  // Round 20: optional tax details. They are kept with the payout details but are not part of them, so changing them never pauses a payout.
  const [taxCountry, setTaxCountry] = useState('')
  const [taxCountryLoaded, setTaxCountryLoaded] = useState('')   // what the server has, so an untouched field is never re-sent
  const [taxId, setTaxId] = useState('')
  const [taxIdOnFile, setTaxIdOnFile] = useState('')

  const [saved,  setSaved ] = useState(false)
  const [clearTaxId, setClearTaxId] = useState(false)
  const [taxSaved, setTaxSaved] = useState(false)
  const [holdUntil, setHoldUntil] = useState(null)
  const { loading: saving, error, execute, fail: showError } = useApi()

  useEffect(() => {
    if (!token) { setInvalid(true); setLoading(false); return }
    api.get('/partners/payout-details', partnerAuth(token))
      .then(res => {
        const p = res.data.data
        setPartnerName(p.name)
        setAlreadySubmittedAt(p.payoutDetailsSubmittedAt)
        setDashboardToken(p.dashboardToken || null)
        setTaxCountry(p.taxCountry || '')
        setTaxCountryLoaded(p.taxCountry || '')
        setTaxIdOnFile(p.taxIdMasked || '')
        if (p.payoutMethod) {
          setMethod(p.payoutMethod)
          const d = p.payoutDetails || {}
          setBankName(d.bankName || '')
          setAccountName(d.accountName || '')
          setProvider(d.provider || '')
          const savedCountry = d.bankCountry || ''
          const known = BANK_COUNTRIES.some(([code]) => code === savedCountry)
          setBankCountry(!savedCountry ? '' : known ? savedCountry : OTHER_COUNTRY)
          setOtherCountry(savedCountry && !known ? savedCountry : '')
          setRoutingCode(d.routingCode || '')
          if (savedCountry === 'CA') { const dg = String(d.routingCode || '').replace(/\D/g, ''); setCaTransit(dg.slice(0, 5)); setCaInstitution(dg.slice(5, 8)) }
          setSwiftBic(d.swiftBic || '')
          setLoadedPayout({ method: p.payoutMethod, bankName: d.bankName || '', accountName: d.accountName || '', provider: d.provider || '',
            bankCountry: savedCountry, routingCode: d.routingCode || '', swiftBic: d.swiftBic || '' })
          if (p.payoutDetailsMasked) {
            const kind = p.payoutMethod === 'BANK' ? 'Bank account' : p.payoutMethod === 'PAYPAL' ? 'PayPal' : 'Mobile money'
            setOnFile(`${kind} ${d.accountNumber || d.phoneNumber || d.paypalEmail || ''}`.trim())
          } else {
            setAccountNumber(d.accountNumber || '')
            setPhoneNumber(d.phoneNumber || '')
            setPaypalEmail(d.paypalEmail || '')
            setConfirmNumber(d.accountNumber || d.phoneNumber || d.paypalEmail || '')
          }
        }
      })
      .catch(err => {
        // Only a bad/expired link should say so — a 429/500/network drop is transient.
        const status = err?.response?.status
        if (status === 404 || status === 400) setInvalid(true)
        else setLoadError(true)
      })
      .finally(() => setLoading(false))
  }, [token])

  const fail0 = msg => showError(msg)

  const countryCode = bankCountry === OTHER_COUNTRY ? otherCountry.trim().toUpperCase() : bankCountry
  // Round 37: with masked details on file the account number box is empty, so a UK partner whose IBAN is on file was shown the sort-code
  // input until they typed. An on-file UK account with no routing code is an IBAN.
  const onFileIban = !accountNumber && !!onFile && !!loadedPayout && loadedPayout.method === 'BANK' && countryCode === loadedPayout.bankCountry && !loadedPayout.routingCode
  const rail = bankRail(countryCode, onFileIban ? `${countryCode}00AAAA` : accountNumber)
  const routing = routingInfo(countryCode)
  // The one value the partner has to type twice, whatever the method.
  const routingValue = countryCode === 'CA' ? (caTransit.trim() || caInstitution.trim() ? `${caTransit.trim()}-${caInstitution.trim()}` : '') : routingCode.trim()
  const idValue = method === 'BANK' ? accountNumber : method === 'PAYPAL' ? paypalEmail : phoneNumber
  const idLabel = method === 'BANK' ? (rail === 'iban' ? 'IBAN' : 'account number') : method === 'PAYPAL' ? 'PayPal email' : 'phone number'

  async function handleSubmit() {
    // Tax-only save: details are already on file and the partner has not retyped the account number, so only the
    // tax fields are sent (the server leaves the payout destination untouched).
    const numberBlank = !idValue.trim()
    const taxChanged = clearTaxId || taxId.trim() || taxCountry.trim().toUpperCase() !== taxCountryLoaded
    if (onFile && numberBlank && !confirmNumber.trim()) {
      // Round 22: a tax-only save used to swallow edits to the bank / provider / account name (and a switch of method) — it saved
      // the tax fields, said "Tax details saved", and left the edited text on screen as if it had been kept. A change to the
      // payout destination needs the number typed again, so say that instead of dropping it.
      const edited = !!loadedPayout && (
        method !== loadedPayout.method ||
        accountName.trim() !== loadedPayout.accountName ||
        (method === 'BANK' ? (bankName.trim() !== loadedPayout.bankName || countryCode !== loadedPayout.bankCountry ||
          routingValue.replace(/-/g, '') !== loadedPayout.routingCode.replace(/-/g, '') || swiftBic.trim() !== loadedPayout.swiftBic)
          : method === 'MOBILE_MONEY' ? provider.trim() !== loadedPayout.provider : false))
      if (edited) return fail0(`Re-enter your ${idLabel} (twice) to save the change to your payout details.`)
    }
    if (onFile && numberBlank && !confirmNumber.trim() && taxChanged) {
      const c = taxCountry.trim().toUpperCase()
      if (c && !/^[A-Z]{2}$/.test(c)) return fail0('Use the 2-letter country code for your tax country, e.g. US.')
      if (taxId.trim() && taxId.trim().length < 3) return fail0('That tax ID looks too short — enter it in full, or leave it blank.')
      const patch = { ...(c !== taxCountryLoaded ? { taxCountry: c } : {}), ...(clearTaxId ? { taxId: '' } : taxId.trim() ? { taxId: taxId.trim() } : {}) }
      try {
        await execute(() => api.post('/partners/payout-details', patch, partnerAuth(token)), { keepAlive: true, fallback: 'Something went wrong — please try again.' })
        setTaxCountryLoaded(c)
        if (clearTaxId) setTaxIdOnFile('')
        else if (taxId.trim()) setTaxIdOnFile(`\u2026${taxId.trim().replace(/\s+/g, '').slice(-4)}`)
        setTaxId(''); setClearTaxId(false); setTaxSaved(true)
      } catch (_) { /* captured by useApi */ }
      return
    }
    if (onFile && numberBlank && !confirmNumber.trim()) {
      // Nothing was edited and nothing is new to save: say so instead of asking for "every field".
      setSaved(false)
      return fail0('Nothing has changed. To update your details, edit a field and re-enter your '+idLabel+' twice.')
    }
    setTaxSaved(false)
    const body = method === 'BANK'
      ? { payoutMethod: 'BANK', bankName: bankName.trim(), accountName: accountName.trim(), accountNumber: accountNumber.trim(), bankCountry: countryCode,
          ...(rail === 'routing' && routingValue ? { routingCode: routingValue } : {}),
          ...(rail === 'swift' && swiftBic.trim() ? { swiftBic: swiftBic.trim() } : {}) }
      : method === 'PAYPAL'
        ? { payoutMethod: 'PAYPAL', accountName: accountName.trim(), paypalEmail: paypalEmail.trim() }
        : { payoutMethod: 'MOBILE_MONEY', provider: provider.trim(), accountName: accountName.trim(), phoneNumber: phoneNumber.trim() }

    // Tax details are optional and only sent when touched: a blank ID keeps the one on file; a changed country (even to blank) is sent.
    const country = taxCountry.trim().toUpperCase()
    const taxExtra = { ...(country !== taxCountryLoaded ? { taxCountry: country } : {}), ...(clearTaxId ? { taxId: '' } : taxId.trim() ? { taxId: taxId.trim() } : {}) }
    const missing = Object.values(body).some(v => !v)
    if (missing) {
      await showError('Please fill in every field.')
      return
    }

    const fail = msg => showError(msg)
    const number = idValue
    if (method === 'BANK') {
      if (!ACCOUNT_NUMBER_RE.test(body.accountNumber))
        return fail('That account number doesn\'t look right — use 4–42 letters, digits, spaces or dashes.')
      const problem = bankProblem(body)
      if (problem) return fail(problem)
    }
    if (method === 'PAYPAL' && !EMAIL_RE.test(body.paypalEmail)) return fail('Enter the email address of your PayPal account.')
    if (method === 'MOBILE_MONEY' && !PHONE_RE.test(body.phoneNumber))
      return fail('That phone number doesn\'t look right — include the country code, e.g. +1 415 555 0132.')
    if (country && !/^[A-Z]{2}$/.test(country)) return fail('Use the 2-letter country code for your tax country, e.g. US.')
    if (taxId.trim() && taxId.trim().length < 3) return fail('That tax ID looks too short — enter it in full, or leave it blank.')
    if (squash(number).toLowerCase() !== squash(confirmNumber).toLowerCase())
      return fail(`The two ${method === 'BANK' ? (rail === 'iban' ? 'IBANs' : 'account numbers') : method === 'PAYPAL' ? 'PayPal emails' : 'phone numbers'} don't match — please re-enter to confirm.`)

    try {
      const out = await execute(() => api.post('/partners/payout-details', { ...body, ...taxExtra }, partnerAuth(token)),
        { keepAlive: true, fallback: 'Something went wrong — please try again.' })
      // Round 8: a CHANGE pauses payouts for a while (a safeguard if the link was ever leaked). Say so now,
      // not when the partner wonders later why a payout has not arrived.
      setHoldUntil(out?.payoutHoldUntil || null)
      setSaved(true)
    } catch (_) { /* error already captured by useApi */ }
  }

  return (
    <PartnerLayout>
      <div className="flex items-center justify-center py-4">
        <div className="w-full max-w-md bg-white rounded-xl border border-gray-200 shadow-sm p-8">
          {loading ? (
            <div className="flex justify-center py-8"><Spinner /></div>
          ) : loadError ? (
            <div>
              <h1 className="text-xl font-bold text-gray-900 mb-2">Couldn't load this page</h1>
              <p className="text-sm text-gray-600">
                Something went wrong on our side or with your connection — your link is fine. Please refresh in a moment.
              </p>
            </div>
          ) : invalid ? (
            <div>
              <h1 className="text-xl font-bold text-gray-900 mb-2">Link not valid</h1>
              <p className="text-sm text-gray-600">
                This payout link is invalid or has expired.{' '}
                <Link to="/partner/recover" className="text-blue-600 hover:underline">Email me my dashboard link</Link>, then
                use "Email me a payout-details link" there.
              </p>
            </div>
          ) : saved ? (
            <div>
              <h1 className="text-xl font-bold text-gray-900 mb-2">Details saved ✓</h1>
              <p className="text-sm text-gray-600 mb-4">
                Thanks{partnerName ? `, ${partnerName}` : ''} — we've got your payout details on file.
                You can revisit this link anytime to update them.
              </p>
              {holdUntil && (
                <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mb-4" data-testid="payout-hold-note">
                  Because these details were added or changed, your next payout is on hold until about {formatDateTime(holdUntil)}.
                  This protects you if someone else ever got hold of your link.
                </p>
              )}
              {dashboardToken ? (
                <Link to={`/partner/dashboard?token=${encodeURIComponent(dashboardToken)}`} className="text-sm text-blue-600 hover:underline">
                  View your dashboard →
                </Link>
              ) : (
                // Never put this page's write-capable token into a dashboard URL — ask for the dashboard link by email instead.
                <Link to="/partner/recover" className="text-sm text-blue-600 hover:underline">
                  Email me my dashboard link →
                </Link>
              )}
            </div>
          ) : (
            <>
              <h1 className="text-xl font-bold text-gray-900 mb-1">
                {partnerName ? `Hi ${partnerName} — set up your payout` : 'Set up your payout'}
              </h1>
              <p className="text-sm text-gray-500 mb-6">
                {alreadySubmittedAt
                  ? "You've already submitted these — update them below anytime."
                  : "Tell us where to send your payouts. We'll email you every time one goes out."}
              </p>

              {onFile && loadedPayout && method === loadedPayout.method && (
                <p className="text-sm text-gray-600 mb-4 rounded-md bg-gray-50 border border-gray-200 px-3 py-2" data-testid="payout-on-file">
                  On file: <span className="font-medium">{onFile}</span>. For your security the full number isn't shown —
                  re-enter it below to save any change.
                </p>
              )}

              <div className="flex gap-2 mb-6">
                {[['BANK', 'Bank account'], ['PAYPAL', 'PayPal'], ['MOBILE_MONEY', 'Mobile money']].map(([m, text]) => (
                  <button key={m} type="button"
                    onClick={() => { setMethod(m); setConfirmNumber('') }}
                    className={`flex-1 py-2 rounded-md text-sm font-medium border transition-colors ${
                      method === m ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-300'}`}>
                    {text}
                  </button>
                ))}
              </div>

              <Form onSubmit={handleSubmit} className="flex flex-col gap-4">
                {method === 'BANK' ? (
                  <>
                    <Select label="Country your bank account is in" value={bankCountry}
                      onChange={e => { setBankCountry(e.target.value); setConfirmNumber('') }}>
                      <option value="">Select a country…</option>
                      {BANK_COUNTRIES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
                      <option value={OTHER_COUNTRY}>Another country…</option>
                    </Select>
                    {bankCountry === OTHER_COUNTRY && (
                      <Input label="Country code (2 letters)" value={otherCountry} maxLength={2} autoComplete="off"
                        onChange={e => setOtherCountry(e.target.value.toUpperCase())} placeholder="e.g. SG" />
                    )}
                    <Input label="Bank name" value={bankName} onChange={e => setBankName(e.target.value)} />
                    <Input label="Account name" value={accountName} onChange={e => setAccountName(e.target.value)} />
                    {countryCode === 'CA' && rail === 'routing' && (
                      <>
                        <Input label="Transit number (5 digits)" value={caTransit} maxLength={5} inputMode="numeric" autoComplete="off"
                          onChange={e => setCaTransit(e.target.value.replace(/\D/g, ''))} placeholder="12345" />
                        <Input label="Institution number (3 digits)" value={caInstitution} maxLength={3} inputMode="numeric" autoComplete="off"
                          onChange={e => setCaInstitution(e.target.value.replace(/\D/g, ''))} placeholder="678" />
                      </>
                    )}
                    {countryCode && countryCode !== 'CA' && rail === 'routing' && routing && (
                      <Input label={routing.label} value={routingCode} onChange={e => setRoutingCode(e.target.value)}
                        placeholder={routing.placeholder} inputMode="numeric" autoComplete="off" />
                    )}
                    <Input label={rail === 'iban' ? 'IBAN' : 'Account number'} value={accountNumber}
                      onChange={e => setAccountNumber(e.target.value)} inputMode="text" autoComplete="off"
                      placeholder={rail === 'iban' ? 'DE89 3704 0044 0532 0130 00' : rail === 'local' ? '12-3456-7890123-00' : ''} />
                    <Input label={rail === 'iban' ? 'Re-enter IBAN' : 'Re-enter account number'} value={confirmNumber} onChange={e => setConfirmNumber(e.target.value)} autoComplete="off" />
                    {countryCode && rail === 'swift' && (
                      <Input label="SWIFT/BIC code" value={swiftBic} onChange={e => setSwiftBic(e.target.value.toUpperCase())}
                        placeholder="e.g. CHASUS33" autoComplete="off" maxLength={14} hint="International transfers need your bank's SWIFT/BIC code." />
                    )}
                  </>
                ) : method === 'PAYPAL' ? (
                  <>
                    <Input label="Name on the PayPal account" value={accountName} onChange={e => setAccountName(e.target.value)} />
                    <Input label="PayPal email" type="email" value={paypalEmail} onChange={e => setPaypalEmail(e.target.value)}
                      placeholder="you@example.com" autoComplete="off" hint="We send payouts to the email address your PayPal account is registered with." />
                    <Input label="Re-enter PayPal email" type="email" value={confirmNumber} onChange={e => setConfirmNumber(e.target.value)} autoComplete="off" />
                  </>
                ) : (
                  <>
                    <Input label="Provider (e.g. M-Pesa, MTN MoMo)" value={provider} onChange={e => setProvider(e.target.value)} />
                    <Input label="Account name" value={accountName} onChange={e => setAccountName(e.target.value)} />
                    <Input label="Phone number (with country code)" value={phoneNumber} onChange={e => setPhoneNumber(e.target.value)} inputMode="tel" placeholder="+1 415 555 0132" autoComplete="off" />
                    <Input label="Re-enter phone number" value={confirmNumber} onChange={e => setConfirmNumber(e.target.value)} inputMode="tel" autoComplete="off" />
                  </>
                )}

                <fieldset className="flex flex-col gap-4 border-t border-gray-100 pt-4" data-testid="tax-details">
                  <legend className="text-sm font-medium text-gray-700 pr-2">Tax details (optional)</legend>
                  <p className="text-xs text-gray-500 -mt-2">Some countries require us to collect these before paying you. Adding or changing them does not pause your payouts.</p>
                  <Input label="Country of tax residence (2-letter code)" value={taxCountry} maxLength={2} autoComplete="off"
                    onChange={e => setTaxCountry(e.target.value.toUpperCase())} placeholder="US" />
                  <Input label="Tax ID" value={taxId} autoComplete="off" maxLength={40} onChange={e => setTaxId(e.target.value)}
                    hint="Your SSN or EIN (US), UTR (UK), or VAT / GST number: whatever your tax authority calls it. It is stored encrypted."
                    placeholder={taxIdOnFile ? `On file: ${taxIdOnFile} — type a new one to replace it` : ''} disabled={clearTaxId} />
                  {taxIdOnFile && (
                    <Checkbox label="Remove the tax ID we have on file" checked={clearTaxId}
                      onChange={e => { setClearTaxId(e.target.checked); if (e.target.checked) setTaxId('') }} />
                  )}
                  {taxSaved && <p role="status" className="text-sm text-green-700" data-testid="tax-saved">Tax details saved.</p>}
                </fieldset>

                {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

                <Button type="submit" loading={saving} className="w-full">
                  Save payout details
                </Button>
              </Form>
            </>
          )}
        </div>
      </div>
    </PartnerLayout>
  )
}
