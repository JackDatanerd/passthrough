import { useState, useEffect } from 'react'
import api from '../../lib/api'
import Button from '../../components/ui/Button'
import Input from '../../components/ui/Input'
import Modal from '../../components/ui/Modal'
import Spinner from '../../components/ui/Spinner'
import { useToast } from '../../components/ui/Toast'

function fmtCents(cents, currency) {
  return `${(cents / 100).toFixed(2)} ${currency}`
}

function PayoutDetailsSummary({ partner }) {
  if (!partner.payoutMethod) {
    return <span className="text-sm text-gray-400 italic">Not submitted yet</span>
  }
  const d = partner.payoutDetails || {}
  if (partner.payoutMethod === 'BANK') {
    return (
      <div className="text-sm text-gray-700">
        <div>{d.bankName}</div>
        <div>{d.accountName} — {d.accountNumber}</div>
      </div>
    )
  }
  return (
    <div className="text-sm text-gray-700">
      <div>{d.provider}</div>
      <div>{d.accountName} — {d.phoneNumber}</div>
    </div>
  )
}

function RecordPayoutModal({ partner, onClose, onRecorded }) {
  const toast = useToast()
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleRecord() {
    setError('')
    const parsed = Number(amount)
    if (!parsed || parsed <= 0) return setError('Enter a valid amount.')

    setSaving(true)
    try {
      const res = await api.post(`/partners/${partner.id}/payouts`, {
        amountCents: Math.round(parsed * 100),
        currency: 'USD',
        note: note || undefined
      })
      toast({
        message: res.data.emailed
          ? `Payout recorded — ${partner.name} has been emailed.`
          : `Payout recorded, but the confirmation email failed to send.`,
        type: res.data.emailed ? 'success' : 'warning'
      })
      onRecorded()
      onClose()
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to record payout.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={`Record payout — ${partner.name}`}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-gray-500">
          Only use this <strong>after</strong> you've actually sent the money via your bank
          or mobile money app. This just logs it and notifies {partner.name}.
        </p>
        <div className="rounded-md bg-gray-50 p-3">
          <PayoutDetailsSummary partner={partner} />
        </div>
        <Input label="Amount sent (USD)" type="number" step="0.01" value={amount}
          onChange={e => setAmount(e.target.value)} placeholder="45.00" />
        <Input label="Note (optional)" value={note} onChange={e => setNote(e.target.value)}
          placeholder="e.g. September referrals" />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2 justify-end">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={handleRecord} loading={saving}
            disabled={!partner.payoutMethod}>
            Mark paid & notify
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function AddPartnerModal({ onClose, onCreated }) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [referralCode, setReferralCode] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleCreate() {
    setError('')
    if (!name || !email) return setError('Name and email are required.')
    setSaving(true)
    try {
      await api.post('/partners', { name, email, referralCode: referralCode || undefined })
      toast({ message: `${name} added — payout-details link sent.`, type: 'success' })
      onCreated()
      onClose()
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to add partner.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} title="Add partner">
      <div className="flex flex-col gap-4">
        <Input label="Name" value={name} onChange={e => setName(e.target.value)} />
        <Input label="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} />
        <Input label="Referral code (optional)" value={referralCode}
          onChange={e => setReferralCode(e.target.value)} placeholder="COACHNAME20" />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2 justify-end">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={handleCreate} loading={saving}>Add & send link</Button>
        </div>
      </div>
    </Modal>
  )
}

export default function AdminPartners() {
  const toast = useToast()
  const [partners, setPartners] = useState([])
  const [loading, setLoading] = useState(true)
  const [payoutTarget, setPayoutTarget] = useState(null)
  const [showAdd, setShowAdd] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const res = await api.get('/partners')
      setPartners(res.data.data)
    } catch (_) {
      toast({ message: 'Failed to load partners.', type: 'error' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function resendLink(partner) {
    try {
      await api.post(`/partners/${partner.id}/resend-link`)
      toast({ message: `Payout link re-sent to ${partner.name}.`, type: 'success' })
    } catch (_) {
      toast({ message: 'Failed to resend link.', type: 'error' })
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-10">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Partners</h1>
        <Button onClick={() => setShowAdd(true)}>Add partner</Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : partners.length === 0 ? (
        <p className="text-sm text-gray-500">No partners yet.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {partners.map(p => {
            const totalPaid = (p.payouts || [])
              .reduce((sum, payout) => sum + payout.amountCents, 0)
            return (
              <div key={p.id} className="border border-gray-200 rounded-lg p-5 bg-white">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div>
                    <div className="font-semibold text-gray-900">{p.name}</div>
                    <div className="text-sm text-gray-500">{p.email}</div>
                    {p.referralCode && (
                      <div className="text-xs text-gray-400 mt-1">Code: {p.referralCode}</div>
                    )}
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-gray-400">Paid to date</div>
                    <div className="font-semibold text-gray-900">{fmtCents(totalPaid, 'USD')}</div>
                  </div>
                </div>

                <div className="mt-4 grid sm:grid-cols-2 gap-4">
                  <div>
                    <div className="text-xs uppercase tracking-wide text-gray-400 mb-1">
                      Payout details
                    </div>
                    <PayoutDetailsSummary partner={p} />
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wide text-gray-400 mb-1">
                      Payout history
                    </div>
                    {(p.payouts || []).length === 0 ? (
                      <span className="text-sm text-gray-400 italic">None yet</span>
                    ) : (
                      <ul className="text-sm text-gray-600 flex flex-col gap-1">
                        {p.payouts.slice(0, 3).map(payout => (
                          <li key={payout.id}>
                            {fmtCents(payout.amountCents, payout.currency)} —{' '}
                            {new Date(payout.paidAt).toLocaleDateString()}
                            {payout.note ? ` (${payout.note})` : ''}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>

                <div className="mt-4 flex gap-2">
                  <Button size="sm" onClick={() => setPayoutTarget(p)}>
                    Record payout
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => resendLink(p)}>
                    Resend payout-details link
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {payoutTarget && (
        <RecordPayoutModal
          partner={payoutTarget}
          onClose={() => setPayoutTarget(null)}
          onRecorded={load}
        />
      )}
      {showAdd && (
        <AddPartnerModal onClose={() => setShowAdd(false)} onCreated={load} />
      )}
    </div>
  )
}
