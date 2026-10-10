import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import api from '../../lib/api'
import { useApi } from '../../hooks/useApi'
import Button from '../../components/ui/Button'
import Input from '../../components/ui/Input'
import Modal from '../../components/ui/Modal'
import Form from '../../components/ui/Form'
import Badge from '../../components/ui/Badge'
import Spinner from '../../components/ui/Spinner'
import Checkbox from '../../components/ui/Checkbox'
import { useToast } from '../../components/ui/Toast'
import { formatCents, formatRate, formatDate, downloadCsv, csvText, withinHours } from '../../lib/utils'
import EmptyState from '../../components/ui/EmptyState'
import ConfirmDialog from '../../components/ui/ConfirmDialog'
import PartnersLookupPanel, { OverviewStrip } from './AdminPartnersLookup'
import { copyToClipboard } from '../../lib/utils'

// A percentage typed by the admin ("25", "12.5") -> the fraction the API stores (0.25, 0.125),
// or null when blank / out of range. Same conversion as the Edit partner modal.
function percentToRate(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || n > 100) return null
  return Math.round(n * 100) / 10000
}
const dollarsToCents = v => Math.round(Number(v) * 100)

// The create/approve calls used to claim "payout-details link sent" unconditionally, even when
// the send was throttled or failed and the partner never got a link. The API now reports it; on
// failure the link is copied so the admin can pass it on by hand.
async function announceDelivery(toast, subject, data) {
  if (data?.emailed === false) {
    const copied = data.payoutUrl ? await copyToClipboard(data.payoutUrl) : false
    toast({ message: `${subject}, but the payout-details email did NOT send.${copied ? ' The link is copied to your clipboard — send it to them yourself.' : ' Use Resend on their page.'}`, type: 'warning' })
  } else {
    toast({ message: `${subject} — payout-details link sent.`, type: 'success' })
  }
}

function AddPartnerModal({ onClose, onCreated }) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [rate, setRate] = useState('')
  const { loading: saving, error, execute } = useApi()

  async function handleCreate() {
    if (!name || !email) {
      await execute(() => Promise.reject(new Error('Name and email are required.')),
        { fallback: 'Name and email are required.' }).catch(() => {})
      return
    }
    const commissionRate = percentToRate(rate)
    if (commissionRate === null) {
      await execute(() => Promise.reject(new Error('Commission rate must be between 0 and 100.')),
        { fallback: 'Commission rate must be between 0 and 100.' }).catch(() => {})
      return
    }
    try {
      const data = await execute(() => api.post('/partners', { name, email, ...(commissionRate !== undefined ? { commissionRate } : {}) }), { fallback: 'Failed to add partner.' })
      await announceDelivery(toast, `${name} added`, data)
      onCreated()
      onClose()
    } catch (_) { /* error already captured by useApi */ }
  }

  return (
    <Modal open onClose={onClose} title="Add partner">
      <Form onSubmit={handleCreate} className="flex flex-col gap-4">
        <Input label="Name" value={name} onChange={e => setName(e.target.value)} />
        <Input label="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} />
        <Input label="Commission rate % (optional — blank uses the default)" type="number" step="0.01" value={rate}
          onChange={e => setRate(e.target.value)} placeholder="25" />
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2 justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={saving}>Add & send link</Button>
        </div>
      </Form>
    </Modal>
  )
}

const PAGE_SIZE = 25
const SORTS = {
  newest:   { label: 'Newest first',        cmp: (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) },
  name:     { label: 'Name (A–Z)',          cmp: (a, b) => a.name.localeCompare(b.name) },
  ready:    { label: 'Most ready to pay',   cmp: (a, b) => (b.readyToPayCents || 0) - (a.readyToPayCents || 0) },
  accruing: { label: 'Most still accruing', cmp: (a, b) => (b.currentCycleAccruedCents || 0) - (a.currentCycleAccruedCents || 0) },
}

// "Become a partner" applications (public form -> POST /partners/apply).
// Approve opens a dialog to set the rate and (optionally) a first referral code in the same
// step; reject takes an optional reason that is emailed to the applicant. Approved/rejected
// history is browsable (it used to vanish the moment it was reviewed).
function ApproveApplicationModal({ app, onClose, onDone }) {
  const toast = useToast()
  const [rate, setRate] = useState('')
  const [withCode, setWithCode] = useState(false)
  const [code, setCode] = useState('')
  const [fix, setFix] = useState('')
  const [badge, setBadge] = useState('')
  const [plain, setPlain] = useState('')
  const { loading: saving, error, execute } = useApi()

  async function handleApprove() {
    const commissionRate = percentToRate(rate)
    const fail = msg => execute(() => Promise.reject(new Error(msg)), { fallback: msg }).catch(() => {})
    if (commissionRate === null) return fail('Commission rate must be between 0 and 100.')
    const body = commissionRate !== undefined ? { commissionRate } : {}
    if (withCode) {
      const tierPrices = {}
      for (const [key, val] of [['FIX', fix], ['BADGE', badge], ['FIX_PLAIN', plain]]) {
        if (String(val).trim() === '') continue
        const cents = dollarsToCents(val)
        if (!Number.isFinite(cents) || cents <= 0) return fail('Prices must be positive amounts.')
        tierPrices[key] = cents
      }
      if (code.trim().length < 2) return fail('Enter a code (at least 2 characters).')
      if (Object.keys(tierPrices).length === 0) return fail('Give at least one tier a price for the code.')
      body.referralCode = { code: code.trim(), tierPrices }
    }
    try {
      const data = await execute(() => api.post(`/partners/applications/${app.id}/approve`, body), { fallback: 'Failed to approve application.' })
      if (data.emailed === false) {
        await announceDelivery(toast, `${app.name} approved`, data)
        // Round 7 (bug): this branch used to drop `codeError`, so when the email AND the first code both failed
        // only the email problem was shown and the missing code went unnoticed.
        if (data.codeError) toast({ message: `The referral code was not created: ${data.codeError} Add it from their page.`, type: 'warning' })
      } else toast({ message: data.codeError
        ? `${app.name} approved, but: ${data.codeError} Add the code from their page.`
        : `${app.name} approved — payout-details link sent${data.codeCreated ? ` and code ${data.codeCreated.code} created` : ''}.`,
      type: data.codeError ? 'warning' : 'success' })
      onDone()
      onClose()
    } catch (_) { /* captured by useApi */ }
  }

  return (
    <Modal open onClose={onClose} title={`Approve ${app.name}`}>
      <Form onSubmit={handleApprove} className="flex flex-col gap-4">
        <p className="text-sm text-gray-500">Creates the partner and emails them a link to enter payout details.</p>
        <Input label="Commission rate % (optional — blank uses the default)" type="number" step="0.01" value={rate}
          onChange={e => setRate(e.target.value)} placeholder="25" />
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={withCode} onChange={e => setWithCode(e.target.checked)} />
          Also create their first referral code
        </label>
        {withCode && (
          <div className="flex flex-col gap-3 rounded-md bg-gray-50 p-3">
            <Input label="Code" value={code} onChange={e => setCode(e.target.value)} placeholder="ANNA20" />
            <div className="grid grid-cols-3 gap-2">
              <Input label="Fix price" type="number" step="0.01" value={fix} onChange={e => setFix(e.target.value)} />
              <Input label="Badge price" type="number" step="0.01" value={badge} onChange={e => setBadge(e.target.value)} />
              <Input label="Plain fix" type="number" step="0.01" value={plain} onChange={e => setPlain(e.target.value)} />
            </div>
            <p className="text-xs text-gray-400">Prices in the platform currency; leave a tier blank to keep its normal price.</p>
          </div>
        )}
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2 justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={saving}>Approve</Button>
        </div>
      </Form>
    </Modal>
  )
}

function RejectApplicationModal({ app, cooldownDays = 30, onClose, onDone }) {
  const toast = useToast()
  const [reason, setReason] = useState('')
  const { loading: saving, error, execute } = useApi()

  async function handleReject() {
    try {
      const data = await execute(() => api.post(`/partners/applications/${app.id}/reject`, reason.trim() ? { reason: reason.trim() } : {}), { fallback: 'Failed to reject application.' })
      toast({ message: data.emailed ? `${app.name}'s application rejected — they've been emailed.` : `${app.name}'s application rejected (the notification email failed to send).`, type: data.emailed ? 'success' : 'warning' })
      onDone()
      onClose()
    } catch (_) { /* captured by useApi */ }
  }

  return (
    <Modal open onClose={onClose} title={`Reject ${app.name}?`}>
      <Form onSubmit={handleReject} className="flex flex-col gap-4">
        <p className="text-sm text-gray-500">
          {app.name} will be emailed the decision. They can re-apply after {cooldownDays} days.
        </p>
        <Input label="Reason (optional — included in the email)" value={reason} onChange={e => setReason(e.target.value)} maxLength={500}
          placeholder="e.g. We're only onboarding career-coaching audiences right now." />
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2 justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" loading={saving}>Reject & notify</Button>
        </div>
      </Form>
    </Modal>
  )
}

const APP_PAGE = 50
const APP_TABS = [['PENDING', 'Waiting'], ['APPROVED', 'Approved'], ['REJECTED', 'Rejected']]

function ApplicationsPanel({ onApproved }) {
  const [tab, setTab] = useState('PENDING')
  const [apps, setApps] = useState([])
  const [pendingCount, setPendingCount] = useState(0)
  const [total, setTotal] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [open, setOpen] = useState(false)
  const [approving, setApproving] = useState(null)
  const [rejecting, setRejecting] = useState(null)
  const [cooldownDays, setCooldownDays] = useState(30)
  const latestTab = useRef(tab)

  // Round 7 (feature gap): the list used to stop at 200 rows with no way to reach older ones, and the "waiting"
  // badge counted that capped list. Pages of 50 with the server's true total; "Show more" appends (de-duplicated,
  // because an offset page can overlap when new applications arrive in between).
  async function load(which = tab, offset = 0) {
    try {
      const res = await api.get(`/partners/applications?status=${which}&limit=${APP_PAGE}&offset=${offset}`)
      const rows = res.data.data
      const count = res.data.total ?? rows.length
      // Ignore an answer for a tab the admin has already left (fast tab flips used to let a
      // slow response overwrite the list now on screen).
      if (which === latestTab.current) {
        setApps(prev => offset ? [...prev, ...rows.filter(r => !prev.some(p => p.id === r.id))] : rows)
        setTotal(count)
      }
      if (which === 'PENDING') setPendingCount(count)
      if (res.data.reapplyCooldownDays) setCooldownDays(res.data.reapplyCooldownDays)
    } catch (_) { /* the panel is optional — the partner list still works without it */ }
  }
  async function showMore() {
    setLoadingMore(true)
    try { await load(tab, apps.length) } finally { setLoadingMore(false) }
  }
  // One effect: it used to fetch PENDING twice on mount (a second effect hard-coded it).
  useEffect(() => { latestTab.current = tab; load(tab) }, [tab])

  const refresh = () => { load(tab); if (tab !== 'PENDING') load('PENDING') }
  const expanded = open || pendingCount > 0

  if (!expanded) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="self-start text-xs text-gray-400 hover:text-gray-600">
        Application history →
      </button>
    )
  }
  return (
    <div className={`border rounded-lg p-4 flex flex-col gap-3 ${tab === 'PENDING' && pendingCount > 0 ? 'border-amber-200 bg-amber-50' : 'border-gray-200 bg-white'}`}>
      <div className="flex items-center gap-4 flex-wrap">
        <h2 className="font-semibold text-gray-900">Applications{pendingCount > 0 ? ` (${pendingCount} waiting)` : ''}</h2>
        <div className="flex gap-3 text-sm">
          {APP_TABS.map(([key, label]) => (
            <button key={key} type="button" onClick={() => setTab(key)}
              className={tab === key ? 'font-medium text-blue-700 underline underline-offset-4' : 'text-gray-500 hover:text-gray-700'}>{label}</button>
          ))}
        </div>
      </div>
      {apps.length === 0 && <p className="text-sm text-gray-400">Nothing here.</p>}
      {apps.map(app => (
        <div key={app.id} className="bg-white border border-gray-200 rounded-md p-3 flex items-start justify-between gap-3 flex-wrap">
          <div className="text-sm min-w-0">
            <div className="font-medium text-gray-900">{app.name} <span className="text-gray-400 font-normal">· {app.email}</span></div>
            <div className="text-xs text-gray-400">
              Applied {formatDate(app.createdAt)}{app.website ? ` · ${app.website}` : ''}
              {app.reviewedAt ? ` · ${app.status === 'APPROVED' ? 'approved' : 'rejected'} ${formatDate(app.reviewedAt)}` : ''}
            </div>
            {app.audience && <p className="text-gray-600 mt-1 whitespace-pre-wrap break-words">{app.audience}</p>}
            {app.message && <p className="text-gray-500 mt-1 whitespace-pre-wrap break-words">{app.message}</p>}
            {app.reviewNote && <p className="text-xs text-gray-500 mt-1">Reason given: {app.reviewNote}</p>}
            {app.status === 'APPROVED' && app.partnerId && (
              <Link to={`/admin/partners/${app.partnerId}`} className="text-xs text-blue-600 hover:underline">Open partner →</Link>
            )}
          </div>
          {app.status === 'PENDING' && (
            <div className="flex gap-2 shrink-0">
              <Button size="sm" variant="secondary" onClick={() => setRejecting(app)}>Reject</Button>
              <Button size="sm" onClick={() => setApproving(app)}>Approve</Button>
            </div>
          )}
        </div>
      ))}
      {apps.length < total && (
        <button type="button" onClick={showMore} disabled={loadingMore}
          className="self-start text-sm text-blue-600 hover:underline disabled:text-gray-400">
          {loadingMore ? 'Loading…' : `Show more (${total - apps.length} older)`}
        </button>
      )}
      {approving && <ApproveApplicationModal app={approving} onClose={() => setApproving(null)} onDone={() => { refresh(); onApproved() }} />}
      {rejecting && <RejectApplicationModal app={rejecting} cooldownDays={cooldownDays} onClose={() => setRejecting(null)} onDone={refresh} />}
    </div>
  )
}

// Round 8: the readiness figures add raw cents, which only means something in one currency. A partner whose unpaid
// ledger spans currencies is left out of the run (the server would refuse the payout anyway) and flagged instead.
const isPayable = p => (p.readyToPayCents || 0) > 0 && p.payoutMethod && !p.mixedCurrency

// One row per partner that is actually payable right now and has somewhere to send it — the
// sheet an admin works through for a payout run. Clamped/zero/no-details partners are left out
// (their figures are on the page); details come straight from the list payload.
function exportPayoutRun(partners) {
  const payable = partners.filter(isPayable)
  const rows = [['Partner', 'Email', 'Method', 'Bank / provider', 'Account name', 'Account / phone', 'Amount', 'Currency', 'Details submitted']]
  for (const p of payable) {
    const d = p.payoutDetails || {}
    rows.push([
      p.name, p.email, p.payoutMethod, d.bankName || d.provider || '', d.accountName || '',
      csvText(d.accountNumber || d.phoneNumber || ''), ((p.readyToPayCents || 0) / 100).toFixed(2), p.currency || '',
      p.payoutDetailsSubmittedAt || ''
    ])
  }
  downloadCsv(`payout-run-${new Date().toISOString().slice(0, 10)}.csv`, rows)
  return payable.length
}

// Section 4 round 6 (feature gap): "Export payout run" produced a CSV to pay from, but each payout then had to be
// recorded one partner at a time. This records the whole run once the money has been sent. It sends exactly the
// amounts the list showed as ready to pay; the server re-checks each one (amount still right, payout details
// unchanged since this list loaded, not inside the post-change hold, currency) and reports per partner, so one
// stale row never blocks the rest and a partner is never recorded as paid for an amount that moved.
const RUN_CHUNK = 25   // the server's per-request cap

function PayoutRunModal({ partners, holdHours, onClose, onDone }) {
  const toast = useToast()
  const rows = partners.filter(isPayable)
  const held = p => holdHours > 0 && withinHours(p.payoutDetailsSubmittedAt, holdHours)
  // A partner whose details changed inside the hold window starts unselected; ticking them requires the confirmation.
  const [selected, setSelected] = useState(() => new Set(rows.filter(p => !held(p)).map(p => p.id)))
  const [confirmed, setConfirmed] = useState(() => new Set())
  const [sentAll, setSentAll] = useState(false)
  const [note, setNote] = useState('')
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState(null)

  const chosen = rows.filter(p => selected.has(p.id))
  const unconfirmedHeld = chosen.filter(p => held(p) && !confirmed.has(p.id))
  const totalCents = chosen.reduce((sum, p) => sum + p.readyToPayCents, 0)
  const currency = rows[0]?.currency
  const toggle = (set, setter, id) => setter(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  const nameOf = id => rows.find(p => p.id === id)?.name || id

  async function run() {
    setRunning(true)
    const all = []
    const items = chosen.map(p => ({
      partnerId: p.id, amountCents: p.readyToPayCents, expectedDetailsSubmittedAt: p.payoutDetailsSubmittedAt ?? null,
      ...(held(p) ? { confirmedWithPartner: true } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    }))
    for (let i = 0; i < items.length; i += RUN_CHUNK) {
      const chunk = items.slice(i, i + RUN_CHUNK)
      try {
        const res = await api.post('/partners/payouts/batch', { items: chunk })
        all.push(...res.data.data.results)
      } catch (_) {
        // The request itself failed — we cannot know whether any of this chunk was recorded.
        all.push(...chunk.map(c => ({ partnerId: c.partnerId, ok: false, unknown: true,
          message: 'Request failed — check this partner\'s payout history before recording again.' })))
      }
    }
    setResults(all)
    setRunning(false)
    const ok = all.filter(r => r.ok).length
    toast({ message: `${ok} of ${all.length} payout(s) recorded.`, type: ok === all.length ? 'success' : 'warning' })
  }

  if (results) {
    return (
      <Modal open onClose={() => { onDone(); onClose() }} title="Payout run recorded">
        <div className="flex flex-col gap-3" data-testid="run-results">
          <ul className="flex flex-col gap-1 text-sm">
            {results.map(r => (
              <li key={r.partnerId} className={r.ok ? 'text-green-700' : 'text-red-700'}>
                {r.ok ? '✓' : '✗'} {nameOf(r.partnerId)}
                {!r.ok && r.message ? ` — ${r.message}` : ''}
                {r.ok && r.ledgerSettlementFailed ? ' — recorded, but marking commissions paid failed; check the ledger.' : ''}
                {r.ok && r.emailed === false ? ' — recorded, but the confirmation email failed.' : ''}
              </li>
            ))}
          </ul>
          <div className="flex justify-end"><Button onClick={() => { onDone(); onClose() }}>Done</Button></div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal open onClose={onClose} title="Record payout run">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-gray-500">
          Only use this <strong>after</strong> you've sent the money. Each selected partner is marked paid for the amount shown
          (the completed cycles' commission, net of refund credits) and emailed.
        </p>
        <div className="border border-gray-200 rounded-md divide-y divide-gray-100 max-h-72 overflow-y-auto">
          {rows.map(p => (
            <div key={p.id} className="px-3 py-2 flex flex-col gap-1">
              <div className="flex items-center justify-between gap-3">
                <Checkbox label={p.name} checked={selected.has(p.id)} onChange={() => toggle(selected, setSelected, p.id)} />
                <span className="text-sm font-medium">{formatCents(p.readyToPayCents, p.currency)}</span>
              </div>
              {held(p) && selected.has(p.id) && (
                <div className="ml-6 text-xs text-red-700" data-testid={`held-${p.id}`}>
                  Payout details changed {formatDate(p.payoutDetailsSubmittedAt)} (inside the {holdHours}-hour hold).
                  <Checkbox wrapperClassName="mt-1 text-xs" label={`I confirmed the change with ${p.name} directly`}
                    checked={confirmed.has(p.id)} onChange={() => toggle(confirmed, setConfirmed, p.id)} />
                </div>
              )}
              {held(p) && !selected.has(p.id) && (
                <div className="ml-6 text-xs text-gray-400">Held — details changed {formatDate(p.payoutDetailsSubmittedAt)}.</div>
              )}
            </div>
          ))}
        </div>
        <Input label="Note to partners (optional — shown on their dashboard)" value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. September referrals" />
        <div className="text-sm text-gray-700" data-testid="run-total">
          {chosen.length} partner{chosen.length === 1 ? '' : 's'} · <span className="font-semibold">{formatCents(totalCents, currency)}</span>
        </div>
        <Checkbox label="I have sent every selected payment" checked={sentAll} onChange={e => setSentAll(e.target.checked)} />
        <div className="flex gap-2 justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="button" loading={running} onClick={run}
            disabled={chosen.length === 0 || !sentAll || unconfirmedHeld.length > 0}>
            Mark {chosen.length} paid & notify
          </Button>
        </div>
      </div>
    </Modal>
  )
}

export default function AdminPartners() {
  const toast = useToast()
  const [partners, setPartners] = useState([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [showRun, setShowRun] = useState(false)
  const [holdHours, setHoldHours] = useState(48)
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState('newest')
  const [page, setPage] = useState(0)

  async function load() {
    setLoading(true)
    try {
      const res = await api.get('/partners')
      setPartners(res.data.data)
      if (typeof res.data.payoutDetailsHoldHours === 'number') setHoldHours(res.data.payoutDetailsHoldHours)
    } catch (_) {
      toast({ message: 'Failed to load partners.', type: 'error' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const needle = query.trim().toLowerCase()
  const filtered = partners
    .filter(p => !needle || p.name.toLowerCase().includes(needle) || p.email.toLowerCase().includes(needle))
    .sort(SORTS[sortKey].cmp)
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const visible = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)

  // readyToPayCents is already clamped at 0 per partner by the server (a refund credit is not
  // payable and must not net against another partner's real payable); credits are separate.
  const totalReadyToPay = partners.reduce((sum, p) => sum + Math.max(0, p.readyToPayCents || 0), 0)
  const payableCount = partners.filter(isPayable).length
  const mixedCurrencyCount = partners.filter(p => p.mixedCurrency && (p.readyToPayCents || 0) > 0).length
  // Round 8: partners who have not accepted the current terms version (admin-created ones never did).
  const termsOutstanding = partners.filter(p => p.status === 'ACTIVE' && p.termsCurrent === false && !String(p.email || '').endsWith('@removed.invalid')).length
  const [confirmTerms, setConfirmTerms] = useState(false)
  async function sendTermsNotice() {
    const res = await api.post('/partners/terms-notice')
    const d = res.data
    toast({ message: `Terms notice sent to ${d.sent} partner(s)${d.failed ? `, ${d.failed} failed` : ''}${d.remaining ? ` - ${d.remaining} still to go, run it again.` : '.'}`, type: d.failed ? 'error' : 'success' })
    setConfirmTerms(false)
    load()
  }
  const totalAccruing   = partners.reduce((sum, p) => sum + (p.currentCycleAccruedCents || 0), 0)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Partners</h1>
        <div className="flex gap-2">
          <Button variant="secondary" disabled={payableCount === 0}
            onClick={() => toast({ message: `Exported ${exportPayoutRun(partners)} payable partner(s).`, type: 'success' })}>
            Export payout run
          </Button>
          <Button variant="secondary" disabled={payableCount === 0} onClick={() => setShowRun(true)}>
            Record payout run
          </Button>
          {termsOutstanding > 0 && (
            <Button variant="secondary" onClick={() => setConfirmTerms(true)}>
              Send terms notice ({termsOutstanding})
            </Button>
          )}
          <Button onClick={() => setShowAdd(true)}>Add partner</Button>
        </div>
      </div>

      {mixedCurrencyCount > 0 && (
        <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2" data-testid="mixed-currency-list">
          {mixedCurrencyCount} partner{mixedCurrencyCount === 1 ? ' has' : 's have'} unpaid commission in more than one currency and
          {mixedCurrencyCount === 1 ? ' is' : ' are'} left out of the payout run. Open them individually to settle each currency.
        </p>
      )}
      <ConfirmDialog open={confirmTerms} danger={false} title="Send terms notice?"
        message={`Email the ${termsOutstanding} active partner${termsOutstanding === 1 ? '' : 's'} who haven't accepted the current partner terms. Each gets one email per terms version (up to 40 per run).`}
        confirmLabel="Send notice" onConfirm={sendTermsNotice} onCancel={() => setConfirmTerms(false)} />

      {showRun && <PayoutRunModal partners={partners} holdHours={holdHours} onClose={() => setShowRun(false)} onDone={load} />}
      <ApplicationsPanel onApproved={load} />
      <OverviewStrip />
      <PartnersLookupPanel />

      {!loading && partners.length > 0 && (
        <div className="grid sm:grid-cols-3 gap-4">
          <div className="border border-gray-200 rounded-lg p-4 bg-white">
            <div className="text-xs uppercase tracking-wide text-gray-400">Ready to pay now</div>
            {/* AUDIT FIX (Section 3/4 pass, bug): formatCents(totalReadyToPay)
                with no currency argument always rendered as USD regardless of
                env.PAYSTACK_CURRENCY — commission_ledger has no currency
                column of its own, so this now comes from the partner rows,
                which all carry the one platform-wide currency (see
                adminListPartners). Same convention as currentCycleLabel
                below. */}
            <div className="text-2xl font-bold text-amber-600">{formatCents(totalReadyToPay, partners[0]?.currency)}</div>
            <div className="text-xs text-gray-400 mt-1">Completed cycles, unpaid</div>
          </div>
          <div className="border border-gray-200 rounded-lg p-4 bg-white">
            <div className="text-xs uppercase tracking-wide text-gray-400">Still accruing</div>
            <div className="text-2xl font-bold text-gray-900">{formatCents(totalAccruing, partners[0]?.currency)}</div>
            <div className="text-xs text-gray-400 mt-1">Current cycle, not yet payable</div>
          </div>
          <div className="border border-gray-200 rounded-lg p-4 bg-white">
            <div className="text-xs uppercase tracking-wide text-gray-400">Active partners</div>
            <div className="text-2xl font-bold text-gray-900">{partners.filter(p => p.status === 'ACTIVE').length}</div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : partners.length === 0 ? (
        <EmptyState>No partners yet.</EmptyState>
      ) : (
        <>
        <div className="flex items-center gap-3 flex-wrap">
          <input type="search" value={query} onChange={e => { setQuery(e.target.value); setPage(0) }}
            placeholder="Search name or email" aria-label="Search partners"
            className="text-sm border border-gray-300 rounded-md px-3 py-1.5 w-64 focus:outline-none focus:ring-2 focus:ring-blue-500" />
          <select value={sortKey} onChange={e => { setSortKey(e.target.value); setPage(0) }} aria-label="Sort partners"
            className="text-sm border border-gray-300 rounded-md px-2 py-1.5">
            {Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <span className="text-xs text-gray-400">{filtered.length} of {partners.length}</span>
        </div>
        {filtered.length === 0 && <EmptyState>No partners match “{query}”.</EmptyState>}
        <div className="border border-gray-200 rounded-lg bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Partners</caption>
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-gray-200">
                <th scope="col" className="px-4 py-3">Partner</th>
                <th scope="col" className="px-4 py-3">Status</th>
                <th scope="col" className="px-4 py-3">Rate</th>
                <th scope="col" className="px-4 py-3 text-right">Ready to pay</th>
                <th scope="col" className="px-4 py-3 text-right">Accruing ({partners[0]?.currentCycleLabel})</th>
                <th scope="col" className="px-4 py-3"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {visible.map(p => (
                <tr key={p.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">{p.name}</div>
                    <div className="text-gray-400 text-xs">{p.email}</div>
                    {p.payoutLinkEmail && p.payoutLinkEmail.status !== 'sent' && (
                      <div className="text-xs text-red-500 mt-0.5" title={`Latest payout-link email: ${p.payoutLinkEmail.status}`}>
                        Setup email {p.payoutLinkEmail.status === 'throttled' ? 'was throttled' : p.payoutLinkEmail.status === 'suppressed' ? 'was suppressed' : 'failed'} — resend or copy the link
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={p.status === 'ACTIVE' ? 'green' : 'gray'}>{p.status}</Badge>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{formatRate(p.commissionRate)}</td>
                  <td className="px-4 py-3 text-right">
                    <span className={p.readyToPayCents > 0 ? 'font-semibold text-amber-600' : 'text-gray-400'}>
                      {formatCents(p.readyToPayCents || 0, p.currency)}
                    </span>
                    {p.readyToPayCents > 0 && !p.payoutMethod && (
                      <div className="text-xs text-red-500 mt-0.5">No payout details yet</div>
                    )}
                    {p.heldCents > 0 && (
                      <div className="text-xs text-gray-400 mt-0.5">{formatCents(p.heldCents, p.currency)} held</div>
                    )}
                    {p.belowMinimum && (
                      <div className="text-xs text-amber-600 mt-0.5">{formatCents(p.carriedForwardCents, p.currency)} below minimum — carried forward</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-500">
                    {formatCents(p.currentCycleAccruedCents || 0, p.currency)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link to={`/admin/partners/${p.id}`} className="text-blue-600 hover:underline text-xs font-medium">
                      Manage →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {pageCount > 1 && (
          <div className="flex items-center justify-between text-sm text-gray-500">
            <Button size="sm" variant="secondary" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>← Previous</Button>
            <span>Page {safePage + 1} of {pageCount}</span>
            <Button size="sm" variant="secondary" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>Next →</Button>
          </div>
        )}
        </>
      )}

      {showAdd && <AddPartnerModal onClose={() => setShowAdd(false)} onCreated={load} />}
    </div>
  )
}
