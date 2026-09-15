import { useState, useEffect } from 'react'
import api from '../../lib/api'
import Button from '../../components/ui/Button'
import Input from '../../components/ui/Input'
import Modal from '../../components/ui/Modal'
import Spinner from '../../components/ui/Spinner'
import { useToast } from '../../components/ui/Toast'

function fmtCents(cents, currency = 'USD') {
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

// amountCents defaults to the partner's pending commission balance
// (computed server-side in adminListPartners) — admin normally just
// confirms this number rather than typing it from scratch. Overriding it
// is still allowed (partial payment, bonus, a payout with no ledger
// backing it), see partners.controller.js's adminRecordPayout comment on
// what happens to the ledger in that case.
function RecordPayoutModal({ partner, onClose, onRecorded }) {
  const toast = useToast()
  const prefill = partner.pendingCommissionCents > 0 ? (partner.pendingCommissionCents / 100).toFixed(2) : ''
  const [amount, setAmount] = useState(prefill)
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
        <div className="rounded-md bg-gray-50 p-3 flex flex-col gap-2">
          <PayoutDetailsSummary partner={partner} />
          <div className="text-sm text-gray-600 border-t border-gray-200 pt-2">
            Pending balance: <span className="font-semibold">{fmtCents(partner.pendingCommissionCents || 0)}</span>
          </div>
        </div>
        <Input label="Amount sent (USD)" type="number" step="0.01" value={amount}
          onChange={e => setAmount(e.target.value)} placeholder="45.00" />
        {partner.pendingCommissionCents > 0 && (
          <p className="text-xs text-gray-400 -mt-2">
            Recording this will mark all of {partner.name}'s outstanding commission as settled,
            regardless of the exact amount entered above.
          </p>
        )}
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
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleCreate() {
    setError('')
    if (!name || !email) return setError('Name and email are required.')
    setSaving(true)
    try {
      await api.post('/partners', { name, email })
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
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2 justify-end">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={handleCreate} loading={saving}>Add & send link</Button>
        </div>
      </div>
    </Modal>
  )
}

// Referral-code pricing is entered in dollars per tier and converted to
// cents on submit — leaving any tier blank means that tier simply isn't
// discounted by this code (see referral.service.js: a tier absent from
// tier_prices falls through to normal promo/standard pricing).
function CreateReferralCodeModal({ partner, onClose, onCreated }) {
  const toast = useToast()
  const [code, setCode] = useState('')
  const [fix, setFix] = useState('')
  const [badge, setBadge] = useState('')
  const [fixPlain, setFixPlain] = useState('')
  const [usageLimit, setUsageLimit] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleCreate() {
    setError('')
    if (!code) return setError('Code is required.')
    const tierPrices = {}
    if (fix)      tierPrices.FIX       = Math.round(Number(fix) * 100)
    if (badge)    tierPrices.BADGE     = Math.round(Number(badge) * 100)
    if (fixPlain) tierPrices.FIX_PLAIN = Math.round(Number(fixPlain) * 100)
    if (Object.keys(tierPrices).length === 0) return setError('Set at least one tier price.')

    setSaving(true)
    try {
      await api.post(`/partners/${partner.id}/referral-codes`, {
        code,
        tierPrices,
        usageLimit: usageLimit ? Number(usageLimit) : undefined
      })
      toast({ message: `Code ${code.toUpperCase()} created — ${partner.name} has been emailed.`, type: 'success' })
      onCreated()
      onClose()
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to create code.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={`New referral code — ${partner.name}`}>
      <div className="flex flex-col gap-4">
        <Input label="Code" value={code} onChange={e => setCode(e.target.value.toUpperCase())}
          placeholder="COACHNAME20" />
        <p className="text-xs text-gray-400 -mt-2">Leave a tier blank to leave it undiscounted.</p>
        <div className="grid grid-cols-3 gap-3">
          <Input label="FIX ($)" type="number" step="0.01" value={fix} onChange={e => setFix(e.target.value)} />
          <Input label="BADGE ($)" type="number" step="0.01" value={badge} onChange={e => setBadge(e.target.value)} />
          <Input label="FIX_PLAIN ($)" type="number" step="0.01" value={fixPlain} onChange={e => setFixPlain(e.target.value)} />
        </div>
        <Input label="Usage limit (optional)" type="number" value={usageLimit}
          onChange={e => setUsageLimit(e.target.value)} placeholder="Unlimited" />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2 justify-end">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={handleCreate} loading={saving}>Create & notify</Button>
        </div>
      </div>
    </Modal>
  )
}

function ReferralCodesList({ partner, onToggled }) {
  const toast = useToast()

  async function toggle(codeRow) {
    try {
      await api.patch(`/partners/referral-codes/${codeRow.id}`, { active: !codeRow.active })
      onToggled()
    } catch (_) {
      toast({ message: 'Failed to update code.', type: 'error' })
    }
  }

  function copyLink(codeRow) {
    const url = `${window.location.origin}/?ref=${codeRow.code}`
    navigator.clipboard.writeText(url)
    toast({ message: 'Link copied.', type: 'success' })
  }

  if (!partner.referralCodes || partner.referralCodes.length === 0) {
    return <span className="text-sm text-gray-400 italic">None yet</span>
  }

  return (
    <ul className="flex flex-col gap-1">
      {partner.referralCodes.map(code => (
        <li key={code.id} className="text-sm flex items-center justify-between gap-2">
          <span className="font-mono">
            {code.code}
            <span className="text-gray-400 ml-2">
              {code.clicks || 0} clicks · {code.usesSoFar || 0} used
            </span>
          </span>
          <span className="flex items-center gap-2">
            <button onClick={() => copyLink(code)} className="text-xs text-blue-600 hover:underline">
              Copy link
            </button>
            <button onClick={() => toggle(code)}
              className={`text-xs px-2 py-0.5 rounded-full ${
                code.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
              {code.active ? 'Active' : 'Inactive'}
            </button>
          </span>
        </li>
      ))}
    </ul>
  )
}

export default function AdminPartners() {
  const toast = useToast()
  const [partners, setPartners] = useState([])
  const [loading, setLoading] = useState(true)
  const [payoutTarget, setPayoutTarget] = useState(null)
  const [codeTarget, setCodeTarget] = useState(null)
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
                  </div>
                  <div className="flex gap-6 text-right">
                    <div>
                      <div className="text-xs text-gray-400">Pending</div>
                      <div className={`font-semibold ${p.pendingCommissionCents > 0 ? 'text-amber-600' : 'text-gray-900'}`}>
                        {fmtCents(p.pendingCommissionCents || 0)}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-400">Paid to date</div>
                      <div className="font-semibold text-gray-900">{fmtCents(totalPaid)}</div>
                    </div>
                  </div>
                </div>

                <div className="mt-4 grid sm:grid-cols-3 gap-4">
                  <div>
                    <div className="text-xs uppercase tracking-wide text-gray-400 mb-1">
                      Payout details
                    </div>
                    <PayoutDetailsSummary partner={p} />
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wide text-gray-400 mb-1">
                      Referral codes
                    </div>
                    <ReferralCodesList partner={p} onToggled={load} />
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

                <div className="mt-4 flex gap-2 flex-wrap">
                  <Button size="sm" onClick={() => setPayoutTarget(p)}>
                    Record payout
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setCodeTarget(p)}>
                    New referral code
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
      {codeTarget && (
        <CreateReferralCodeModal
          partner={codeTarget}
          onClose={() => setCodeTarget(null)}
          onCreated={load}
        />
      )}
      {showAdd && (
        <AddPartnerModal onClose={() => setShowAdd(false)} onCreated={load} />
      )}
    </div>
  )
}
