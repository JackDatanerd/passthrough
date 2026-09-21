import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import api, { getErrorMessage } from '../../lib/api'
import Button from '../../components/ui/Button'
import Input from '../../components/ui/Input'
import Modal from '../../components/ui/Modal'
import Badge from '../../components/ui/Badge'
import Spinner from '../../components/ui/Spinner'
import { useToast } from '../../components/ui/Toast'
import { formatCents, formatDate, cn, copyToClipboard } from '../../lib/utils'

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

// Referral links point at the public marketing site, not wherever this
// admin SPA happens to be loaded from — those are the same host in
// production today, but weren't guaranteed to be (staging, localhost, or
// any future split would silently copy a broken link). Falls back to
// window.location.origin only if the env var isn't set, so this never
// breaks a build that hasn't configured it yet.
function siteOrigin() {
  return import.meta.env.VITE_PUBLIC_SITE_URL || window.location.origin
}

// AUDIT FIX (feature gap): expiration is fully enforced server-side
// (referral.service.js's isCodeUsable checks expires_at) and both the
// create and update schemas already accept expiresAt, but nothing in this
// admin UI ever set it — there was no way to create a time-limited code
// without a raw API call. <input type="date"> only gives a YYYY-MM-DD
// string; the API requires a full ISO datetime (z.string().datetime()), so
// treat the picked date as the LAST moment the code is usable — end of
// that day, UTC — which is the intuitive reading of "expires on this date".
function dateToExpiresAt(dateStr) {
  if (!dateStr) return null
  return new Date(`${dateStr}T23:59:59.999Z`).toISOString()
}
function expiresAtToDateInput(expiresAt) {
  return expiresAt ? expiresAt.slice(0, 10) : ''
}

function EditPartnerModal({ partner, onClose, onSaved }) {
  const toast = useToast()
  const [name, setName] = useState(partner.name)
  const [email, setEmail] = useState(partner.email)
  const [rate, setRate] = useState(String(Math.round(partner.commissionRate * 100)))
  const [status, setStatus] = useState(partner.status)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSave() {
    setError('')
    // AUDIT FIX (Admin panel re-audit): `!rateNum` rejected an intentional
    // 0% rate — the backend/DB both explicitly allow commissionRate === 0
    // (see partners.controller.js's updatePartnerSchema, min(0)), so this
    // was stricter than what the system actually supports. Check for a
    // genuinely empty/invalid field instead of falsy-zero.
    if (rate.trim() === '') return setError('Enter a commission rate.')
    const rateNum = Number(rate) / 100
    if (!name || !email) return setError('Name and email are required.')
    if (Number.isNaN(rateNum) || rateNum < 0 || rateNum > 1) return setError('Commission rate must be between 0 and 100%.')

    setSaving(true)
    try {
      await api.patch(`/partners/${partner.id}`, { name, email, commissionRate: rateNum, status })
      toast({ message: 'Partner updated.', type: 'success' })
      onSaved()
      onClose()
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to update partner.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} title="Edit partner">
      <div className="flex flex-col gap-4">
        <Input label="Name" value={name} onChange={e => setName(e.target.value)} />
        <Input label="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} />
        <Input label="Commission rate (%)" type="number" step="1" min="0" max="100" value={rate}
          onChange={e => setRate(e.target.value)} />
        <p className="text-xs text-gray-400 -mt-2">
          Only applies going forward — past conversions keep the rate they were earned at.
        </p>
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-gray-700">Status</label>
          <div className="flex gap-2">
            {['ACTIVE', 'PAUSED'].map(s => (
              <button key={s} type="button" onClick={() => setStatus(s)}
                className={cn('px-3 py-1.5 rounded-md text-sm border',
                  status === s ? 'bg-blue-50 border-blue-300 text-blue-700' : 'border-gray-300 text-gray-600')}>
                {s}
              </button>
            ))}
          </div>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2 justify-end">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} loading={saving}>Save</Button>
        </div>
      </div>
    </Modal>
  )
}

// Handles both cycle-scoped payouts (cycle passed in, from the Cycles tab)
// and ad hoc ones (cycle is null — pays down the ENTIRE unpaid balance,
// e.g. a bonus or a catch-up payment). See adminRecordPayout's comment in
// partners.controller.js for exactly what settling means in each case.
function RecordPayoutModal({ partner, cycle, onClose, onRecorded }) {
  const toast = useToast()
  const defaultCents = cycle ? cycle.unpaidCents : partner.pendingCommissionCents
  const [amount, setAmount] = useState(defaultCents > 0 ? (defaultCents / 100).toFixed(2) : '')
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
        note: note || undefined,
        ...(cycle ? { periodStart: cycle.start, periodEnd: cycle.end } : {})
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
      setError(getErrorMessage(err, 'Failed to record payout.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={cycle ? `Record payout — ${cycle.label}` : `Record ad hoc payout — ${partner.name}`}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-gray-500">
          Only use this <strong>after</strong> you've actually sent the money via your bank
          or mobile money app. This just logs it and notifies {partner.name}.
        </p>
        <div className="rounded-md bg-gray-50 p-3 flex flex-col gap-2">
          <PayoutDetailsSummary partner={partner} />
          <div className="text-sm text-gray-600 border-t border-gray-200 pt-2">
            {cycle ? `Owed for ${cycle.label}` : 'Total unpaid balance'}:{' '}
            <span className="font-semibold">{formatCents(defaultCents || 0)}</span>
          </div>
        </div>
        <Input label="Amount sent (USD)" type="number" step="0.01" value={amount}
          onChange={e => setAmount(e.target.value)} placeholder="45.00" />
        <p className="text-xs text-gray-400 -mt-2">
          {cycle
            ? `Recording this settles every conversion in ${cycle.label}, regardless of the exact amount entered above.`
            : `Recording this settles ${partner.name}'s ENTIRE outstanding balance (all cycles), regardless of the exact amount entered above.`}
        </p>
        <Input label="Note (optional)" value={note} onChange={e => setNote(e.target.value)}
          placeholder="e.g. September referrals" />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2 justify-end">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={handleRecord} loading={saving} disabled={!partner.payoutMethod}>
            Mark paid & notify
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function CreateReferralCodeModal({ partner, onClose, onCreated }) {
  const toast = useToast()
  const [code, setCode] = useState('')
  const [fix, setFix] = useState('')
  const [badge, setBadge] = useState('')
  const [fixPlain, setFixPlain] = useState('')
  const [usageLimit, setUsageLimit] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
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
        code, tierPrices, usageLimit: usageLimit ? Number(usageLimit) : undefined,
        // createReferralCodeSchema's expiresAt is optional but NOT
        // nullable — omit the key entirely rather than send null when no
        // date was picked.
        ...(expiresAt ? { expiresAt: dateToExpiresAt(expiresAt) } : {})
      })
      toast({ message: `Code ${code.toUpperCase()} created — ${partner.name} has been emailed.`, type: 'success' })
      onCreated()
      onClose()
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to create code.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={`New referral code — ${partner.name}`}>
      <div className="flex flex-col gap-4">
        <Input label="Code" value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="COACHNAME20" />
        <p className="text-xs text-gray-400 -mt-2">Leave a tier blank to leave it undiscounted.</p>
        <div className="grid grid-cols-3 gap-3">
          <Input label="FIX ($)" type="number" step="0.01" value={fix} onChange={e => setFix(e.target.value)} />
          <Input label="BADGE ($)" type="number" step="0.01" value={badge} onChange={e => setBadge(e.target.value)} />
          <Input label="FIX_PLAIN ($)" type="number" step="0.01" value={fixPlain} onChange={e => setFixPlain(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label="Usage limit (optional)" type="number" value={usageLimit}
            onChange={e => setUsageLimit(e.target.value)} placeholder="Unlimited" />
          <Input label="Expires on (optional)" type="date" value={expiresAt}
            onChange={e => setExpiresAt(e.target.value)} />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2 justify-end">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={handleCreate} loading={saving}>Create & notify</Button>
        </div>
      </div>
    </Modal>
  )
}

// Edits an EXISTING code's pricing/limits in place — previously the only
// way to change a wrong tier price was to deactivate the code and create a
// brand new one, losing the original code string (already handed out) and
// its accumulated clicks/uses.
function EditReferralCodeModal({ partner, codeRow, onClose, onSaved }) {
  const toast = useToast()
  const tp = codeRow.tierPrices || {}
  const [fix, setFix] = useState(tp.FIX != null ? (tp.FIX / 100).toFixed(2) : '')
  const [badge, setBadge] = useState(tp.BADGE != null ? (tp.BADGE / 100).toFixed(2) : '')
  const [fixPlain, setFixPlain] = useState(tp.FIX_PLAIN != null ? (tp.FIX_PLAIN / 100).toFixed(2) : '')
  const [usageLimit, setUsageLimit] = useState(codeRow.usageLimit != null ? String(codeRow.usageLimit) : '')
  const [expiresAt, setExpiresAt] = useState(expiresAtToDateInput(codeRow.expiresAt))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSave() {
    setError('')
    const tierPrices = {}
    if (fix)      tierPrices.FIX       = Math.round(Number(fix) * 100)
    if (badge)    tierPrices.BADGE     = Math.round(Number(badge) * 100)
    if (fixPlain) tierPrices.FIX_PLAIN = Math.round(Number(fixPlain) * 100)
    if (Object.keys(tierPrices).length === 0) return setError('Set at least one tier price.')

    setSaving(true)
    try {
      await api.patch(`/partners/referral-codes/${codeRow.id}`, {
        tierPrices,
        usageLimit: usageLimit ? Number(usageLimit) : null,
        // updateReferralCodeSchema's expiresAt is nullable — unlike create,
        // an explicit null here is how an admin clears an existing
        // expiration, same convention as usageLimit right above.
        expiresAt: expiresAt ? dateToExpiresAt(expiresAt) : null
      })
      toast({ message: `Code ${codeRow.code} updated.`, type: 'success' })
      onSaved()
      onClose()
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to update code.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={`Edit ${codeRow.code}`}>
      <div className="flex flex-col gap-4">
        <p className="text-xs text-gray-400">
          The code string itself, clicks, and usage history stay unchanged — only pricing and limits update.
        </p>
        <div className="grid grid-cols-3 gap-3">
          <Input label="FIX ($)" type="number" step="0.01" value={fix} onChange={e => setFix(e.target.value)} />
          <Input label="BADGE ($)" type="number" step="0.01" value={badge} onChange={e => setBadge(e.target.value)} />
          <Input label="FIX_PLAIN ($)" type="number" step="0.01" value={fixPlain} onChange={e => setFixPlain(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label="Usage limit (blank = unlimited)" type="number" value={usageLimit}
            onChange={e => setUsageLimit(e.target.value)} placeholder="Unlimited" />
          <Input label="Expires on (blank = never)" type="date" value={expiresAt}
            onChange={e => setExpiresAt(e.target.value)} />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2 justify-end">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} loading={saving}>Save</Button>
        </div>
      </div>
    </Modal>
  )
}

function ReferralCodesTab({ partner, onChanged }) {
  const toast = useToast()
  const [showCreate, setShowCreate] = useState(false)
  const [editTarget, setEditTarget] = useState(null)

  async function toggle(codeRow) {
    try {
      await api.patch(`/partners/referral-codes/${codeRow.id}`, { active: !codeRow.active })
      onChanged()
    } catch (_) {
      toast({ message: 'Failed to update code.', type: 'error' })
    }
  }

  async function copyLink(codeRow) {
    const url = `${siteOrigin()}/?ref=${codeRow.code}`
    // Only claim "copied" when it actually was (it used to toast success even when the write failed).
    if (await copyToClipboard(url)) toast({ message: 'Link copied.', type: 'success' })
    else toast({ message: `Couldn't copy automatically — ${url}`, type: 'error', duration: 8000 })
  }

  const codes = partner.referralCodes || []

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setShowCreate(true)}>New referral code</Button>
      </div>
      {codes.length === 0 ? (
        <p className="text-sm text-gray-400 italic">None yet.</p>
      ) : (
        <div className="border border-gray-200 rounded-lg bg-white divide-y divide-gray-100">
          {codes.map(code => (
            <div key={code.id} className="p-3 flex items-center justify-between gap-3 flex-wrap">
              <div>
                <span className="font-mono font-medium">{code.code}</span>
                <span className="text-gray-400 text-xs ml-2">
                  {code.clicks || 0} clicks · {code.usesSoFar || 0} used{code.usageLimit ? ` / ${code.usageLimit}` : ''}
                </span>
                <div className="text-xs text-gray-400 mt-0.5">
                  {['FIX', 'BADGE', 'FIX_PLAIN'].filter(t => code.tierPrices?.[t] != null).map(t =>
                    `${t}: ${formatCents(code.tierPrices[t])}`).join(' · ')}
                </div>
                {code.expiresAt && (
                  <div className={cn('text-xs mt-0.5', new Date(code.expiresAt) < new Date() ? 'text-red-500' : 'text-gray-400')}>
                    {new Date(code.expiresAt) < new Date() ? 'Expired' : 'Expires'} {formatDate(code.expiresAt)}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => copyLink(code)} className="text-xs text-blue-600 hover:underline">Copy link</button>
                <button onClick={() => setEditTarget(code)} className="text-xs text-blue-600 hover:underline">Edit</button>
                <button onClick={() => toggle(code)}
                  className={cn('text-xs px-2 py-0.5 rounded-full',
                    code.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500')}>
                  {code.active ? 'Active' : 'Inactive'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {showCreate && <CreateReferralCodeModal partner={partner} onClose={() => setShowCreate(false)} onCreated={onChanged} />}
      {editTarget && (
        <EditReferralCodeModal partner={partner} codeRow={editTarget} onClose={() => setEditTarget(null)} onSaved={onChanged} />
      )}
    </div>
  )
}

function CyclesTab({ partner, onChanged }) {
  const [payoutCycle, setPayoutCycle] = useState(null)
  const [showAdHoc, setShowAdHoc] = useState(false)
  const cycles = partner.cyclesSummary || []

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-gray-900">Twice-monthly cycles</h3>
          <Button size="sm" variant="secondary" onClick={() => setShowAdHoc(true)}>Record ad hoc payout</Button>
        </div>
        <div className="border border-gray-200 rounded-lg bg-white divide-y divide-gray-100">
          {cycles.map(c => (
            <div key={c.key} className="p-3 flex items-center justify-between gap-3 flex-wrap">
              <div>
                <div className="font-medium text-gray-900 flex items-center gap-2">
                  {c.label}
                  {c.isCurrent && <Badge variant="blue">Current — still accruing</Badge>}
                </div>
                <div className="text-xs text-gray-400">
                  {c.ledgerCount} conversion{c.ledgerCount === 1 ? '' : 's'} · {formatCents(c.commissionCents)} commission
                  {c.paidCents > 0 && ` · ${formatCents(c.paidCents)} already paid`}
                </div>
              </div>
              <div className="flex items-center gap-3">
                {c.unpaidCents > 0 ? (
                  c.isCurrent ? (
                    <span className="text-sm text-gray-400">{formatCents(c.unpaidCents)} (not payable yet)</span>
                  ) : (
                    <Button size="sm" onClick={() => setPayoutCycle(c)}>Pay {formatCents(c.unpaidCents)}</Button>
                  )
                ) : (
                  <span className="text-sm text-gray-400 italic">{c.ledgerCount > 0 ? 'Settled' : 'Nothing owed'}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="font-semibold text-gray-900 mb-3">Payout history</h3>
        {(partner.payouts || []).length === 0 ? (
          <p className="text-sm text-gray-400 italic">None yet.</p>
        ) : (
          <div className="border border-gray-200 rounded-lg bg-white divide-y divide-gray-100">
            {partner.payouts.map(payout => (
              <div key={payout.id} className="p-3 flex items-center justify-between gap-3 text-sm">
                <div>
                  <span className="font-medium text-gray-900">{formatCents(payout.amountCents, payout.currency)}</span>
                  <span className="text-gray-400 ml-2">{formatDate(payout.paidAt || payout.createdAt)}</span>
                  {payout.periodStart && (
                    <span className="text-gray-400 ml-2">· {formatDate(payout.periodStart)}–{formatDate(payout.periodEnd)}</span>
                  )}
                  {payout.note && <span className="text-gray-400 ml-2">({payout.note})</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {payoutCycle && (
        <RecordPayoutModal partner={partner} cycle={payoutCycle} onClose={() => setPayoutCycle(null)} onRecorded={onChanged} />
      )}
      {showAdHoc && (
        <RecordPayoutModal partner={partner} cycle={null} onClose={() => setShowAdHoc(false)} onRecorded={onChanged} />
      )}
    </div>
  )
}

function ConversionsTab({ partner }) {
  const ledger = partner.commissionLedger || []
  if (ledger.length === 0) return <p className="text-sm text-gray-400 italic">No conversions yet.</p>

  return (
    <div className="border border-gray-200 rounded-lg bg-white overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-200">
            <th className="px-4 py-3">Date</th>
            <th className="px-4 py-3 text-right">Gross sale</th>
            <th className="px-4 py-3 text-right">Rate</th>
            <th className="px-4 py-3 text-right">Commission</th>
            <th className="px-4 py-3">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {ledger.map(l => (
            <tr key={l.id}>
              <td className="px-4 py-3 text-gray-600">{formatDate(l.createdAt)}</td>
              <td className="px-4 py-3 text-right">{formatCents(l.grossAmountCents)}</td>
              <td className="px-4 py-3 text-right text-gray-400">{(l.commissionRate * 100).toFixed(0)}%</td>
              <td className="px-4 py-3 text-right font-medium">{formatCents(l.commissionAmountCents)}</td>
              <td className="px-4 py-3">
                <Badge variant={l.payoutId ? 'green' : 'amber'}>{l.payoutId ? 'Paid' : 'Unpaid'}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const TABS = [
  { key: 'overview',  label: 'Overview' },
  { key: 'cycles',    label: 'Cycles & Payouts' },
  { key: 'conversions', label: 'Conversions' },
  { key: 'codes',     label: 'Referral Codes' },
]

export default function PartnerDetail() {
  const { id } = useParams()
  const toast = useToast()
  const [partner, setPartner] = useState(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('overview')
  const [showEdit, setShowEdit] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const res = await api.get(`/partners/${id}`)
      setPartner(res.data.data)
    } catch (_) {
      toast({ message: 'Failed to load partner.', type: 'error' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [id])

  async function resendLink() {
    try {
      const res = await api.post(`/partners/${id}/resend-link`)
      // AUDIT FIX (feature gap): email is still the primary channel, but it
      // was the ONLY one — if Resend bounces, spam-filters it, or the
      // address on file is stale, there was no way to get the partner
      // their link short of a raw DB query. The endpoint now also returns
      // the URL; copy it to the clipboard as a fallback so it's on hand to
      // hand off manually (support chat, a different email, etc.) even
      // when the send itself failed.
      const copied = res.data.payoutUrl ? await copyToClipboard(res.data.payoutUrl) : false
      toast({
        message: res.data.success
          ? `Payout link re-sent to ${partner.name}.${copied ? ' Also copied to your clipboard.' : ''}`
          : `Email failed to send.${copied ? ' Link copied to your clipboard instead.' : ''}`,
        type: res.data.success ? 'success' : 'warning'
      })
    } catch (_) {
      toast({ message: 'Failed to resend link.', type: 'error' })
    }
  }

  async function regenerateLink() {
    if (!window.confirm(`This invalidates ${partner.name}'s current payout link immediately and emails a new one. Continue?`)) return
    try {
      const res = await api.post(`/partners/${id}/regenerate-link`)
      const copied = res.data.payoutUrl ? await copyToClipboard(res.data.payoutUrl) : false
      toast({
        message: (res.data.emailed ? 'Link reset — new link emailed.' : 'Link reset, but the notification email failed.')
          + (copied ? ' Also copied to your clipboard.' : ''),
        type: res.data.emailed ? 'success' : 'warning'
      })
    } catch (_) {
      toast({ message: 'Failed to regenerate link.', type: 'error' })
    }
  }

  if (loading) return <div className="flex justify-center py-16"><Spinner /></div>
  if (!partner) return <p className="text-sm text-red-600">Partner not found.</p>

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link to="/admin/partners" className="text-xs text-gray-400 hover:text-gray-600">← All partners</Link>
        <div className="flex items-start justify-between gap-4 flex-wrap mt-1">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{partner.name}</h1>
            <div className="text-sm text-gray-500">{partner.email}</div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={partner.status === 'ACTIVE' ? 'green' : 'gray'}>{partner.status}</Badge>
            <Button size="sm" variant="secondary" onClick={() => setShowEdit(true)}>Edit</Button>
          </div>
        </div>
      </div>

      <div className="grid sm:grid-cols-3 gap-4">
        <div className="border border-gray-200 rounded-lg p-4 bg-white">
          <div className="text-xs uppercase tracking-wide text-gray-400">Total pending</div>
          <div className="text-xl font-bold text-amber-600">{formatCents(partner.pendingCommissionCents || 0)}</div>
        </div>
        <div className="border border-gray-200 rounded-lg p-4 bg-white">
          <div className="text-xs uppercase tracking-wide text-gray-400">Commission rate</div>
          <div className="text-xl font-bold text-gray-900">{(partner.commissionRate * 100).toFixed(0)}%</div>
        </div>
        <div className="border border-gray-200 rounded-lg p-4 bg-white">
          <div className="text-xs uppercase tracking-wide text-gray-400 mb-1">Payout details</div>
          <PayoutDetailsSummary partner={partner} />
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        <Button size="sm" variant="secondary" onClick={resendLink}>Resend payout-details link</Button>
        <Button size="sm" variant="secondary" onClick={regenerateLink}>Regenerate link (revoke old one)</Button>
      </div>

      <div className="border-b border-gray-200 flex gap-4 overflow-x-auto">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={cn('px-1 pb-2 text-sm font-medium border-b-2 whitespace-nowrap',
              tab === t.key ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-700')}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="text-sm text-gray-600">
          Added {formatDate(partner.createdAt)}. Use the tabs above to record payouts by cycle,
          review every conversion behind the balance, or manage referral codes.
        </div>
      )}
      {tab === 'cycles' && <CyclesTab partner={partner} onChanged={load} />}
      {tab === 'conversions' && <ConversionsTab partner={partner} />}
      {tab === 'codes' && <ReferralCodesTab partner={partner} onChanged={load} />}

      {showEdit && <EditPartnerModal partner={partner} onClose={() => setShowEdit(false)} onSaved={load} />}
    </div>
  )
}
