import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import api from '../lib/api'
import Button from '../components/ui/Button'
import Input from '../components/ui/Input'
import Spinner from '../components/ui/Spinner'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'

// Public page, reached via the link emailed by adminCreatePartner /
// adminResendPayoutLink — identity is the ?token= in the URL, not a login.
// No account system for partners exists yet; the token IS the auth.

export default function PartnerPayoutDetails() {
  const [params] = useSearchParams()
  const token = params.get('token')

  const [loading,  setLoading ] = useState(true)
  const [invalid,  setInvalid ] = useState(false)
  const [partnerName, setPartnerName] = useState('')
  const [alreadySubmittedAt, setAlreadySubmittedAt] = useState(null)

  const [method, setMethod] = useState('BANK')
  const [bankName, setBankName] = useState('')
  const [accountName, setAccountName] = useState('')
  const [accountNumber, setAccountNumber] = useState('')
  const [provider, setProvider] = useState('')
  const [phoneNumber, setPhoneNumber] = useState('')

  const [saving, setSaving] = useState(false)
  const [saved,  setSaved ] = useState(false)
  const [error,  setError ] = useState('')

  useEffect(() => {
    if (!token) { setInvalid(true); setLoading(false); return }
    api.get(`/partners/payout-details?token=${encodeURIComponent(token)}`)
      .then(res => {
        const p = res.data.data
        setPartnerName(p.name)
        setAlreadySubmittedAt(p.payoutDetailsSubmittedAt)
        if (p.payoutMethod) {
          setMethod(p.payoutMethod)
          const d = p.payoutDetails || {}
          setBankName(d.bankName || '')
          setAccountName(d.accountName || '')
          setAccountNumber(d.accountNumber || '')
          setProvider(d.provider || '')
          setPhoneNumber(d.phoneNumber || '')
        }
      })
      .catch(() => setInvalid(true))
      .finally(() => setLoading(false))
  }, [token])

  async function handleSubmit() {
    setError('')
    const body = method === 'BANK'
      ? { payoutMethod: 'BANK', bankName, accountName, accountNumber }
      : { payoutMethod: 'MOBILE_MONEY', provider, accountName, phoneNumber }

    const missing = Object.values(body).some(v => !v)
    if (missing) return setError('Please fill in every field.')

    setSaving(true)
    try {
      await api.post(`/partners/payout-details?token=${encodeURIComponent(token)}`, body)
      setSaved(true)
    } catch (err) {
      setError(err.response?.data?.message || 'Something went wrong — please try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <Navbar />
      <main className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md bg-white rounded-lg border border-gray-200 shadow-sm p-8">
          {loading ? (
            <div className="flex justify-center py-8"><Spinner /></div>
          ) : invalid ? (
            <div>
              <h1 className="text-xl font-bold text-gray-900 mb-2">Link not valid</h1>
              <p className="text-sm text-gray-600">
                This payout link is invalid or has expired. Ask us to resend it.
              </p>
            </div>
          ) : saved ? (
            <div>
              <h1 className="text-xl font-bold text-gray-900 mb-2">Details saved ✓</h1>
              <p className="text-sm text-gray-600">
                Thanks{partnerName ? `, ${partnerName}` : ''} — we've got your payout details on file.
                You can revisit this link anytime to update them.
              </p>
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

              <div className="flex gap-2 mb-6">
                <button type="button"
                  onClick={() => setMethod('BANK')}
                  className={`flex-1 py-2 rounded-md text-sm font-medium border transition-colors ${
                    method === 'BANK' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-300'}`}>
                  Bank account
                </button>
                <button type="button"
                  onClick={() => setMethod('MOBILE_MONEY')}
                  className={`flex-1 py-2 rounded-md text-sm font-medium border transition-colors ${
                    method === 'MOBILE_MONEY' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-300'}`}>
                  Mobile money
                </button>
              </div>

              <div className="flex flex-col gap-4">
                {method === 'BANK' ? (
                  <>
                    <Input label="Bank name" value={bankName} onChange={e => setBankName(e.target.value)} />
                    <Input label="Account name" value={accountName} onChange={e => setAccountName(e.target.value)} />
                    <Input label="Account number" value={accountNumber} onChange={e => setAccountNumber(e.target.value)} />
                  </>
                ) : (
                  <>
                    <Input label="Provider (e.g. M-Pesa, MTN MoMo)" value={provider} onChange={e => setProvider(e.target.value)} />
                    <Input label="Account name" value={accountName} onChange={e => setAccountName(e.target.value)} />
                    <Input label="Phone number" value={phoneNumber} onChange={e => setPhoneNumber(e.target.value)} />
                  </>
                )}

                {error && <p className="text-sm text-red-600">{error}</p>}

                <Button onClick={handleSubmit} loading={saving} className="w-full">
                  Save payout details
                </Button>
              </div>
            </>
          )}
        </div>
      </main>
      <Footer />
    </div>
  )
}
