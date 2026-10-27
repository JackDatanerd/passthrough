import { useState, useEffect, useCallback } from 'react'
import api from '../../lib/api'
import Spinner from '../../components/ui/Spinner'
import DataTable from '../../components/ui/DataTable'
import { useToast } from '../../components/ui/Toast'
import useLatestRequest from '../../hooks/useLatestRequest'
import { formatNumber, formatDateTime } from '../../lib/utils'
import Button from '../../components/ui/Button'
import Input from '../../components/ui/Input'

// DATABASE ROUND 5 (feature gap): every delivered resume fix and cover letter is stamped with the prompt generation that wrote it, and
// people who got an interview (or not) answer a follow-up. The comparison that tells the owner whether a prompt change helped lived in a
// database view nobody could open without SQL. This is the read side: interview rate per prompt generation, with the sample size beside it
// — a rate over a handful of answers is shown, but marked, never presented as a result.
function pct(v) { return v === null || v === undefined ? '—' : `${v}%` }

function table(caption, rows, minResponses) {
  return (
    <DataTable
      caption={caption} density="compact"
      columns={[
        { key: 'version', header: 'Prompt version', cell: r => r.version || 'before versioning' },
        { key: 'responses', header: 'Answers', className: 'text-right', cell: r => formatNumber(r.responses) },
        { key: 'interviews', header: 'Interviews', className: 'text-right', cell: r => formatNumber(r.interviews) },
        { key: 'pct', header: 'Interview rate', className: 'text-right', cell: r => pct(r.interviewPct) },
        { key: 'note', header: '', cell: r => r.smallSample ? <span className="text-xs text-amber-700">under {minResponses} answers — not a result yet</span> : null },
      ]}
      rows={rows} rowKey={r => String(r.version)}
    />
  )
}


// Why is — or isn't — a scan being asked "did it lead to an interview?", and when will it be? The same rule the dashboard and the follow-up
// email use (lib/outcomes.js evaluateAsk), run against the real scan, now and N days ahead — so the conditions can be simulated without
// editing any data.
const REASONS = {
  ASK: 'Asked on the dashboard / My Story now.', REASK_STILL_APPLYING: 'Asked again: "still applying" was answered 30+ days ago.',
  SEND: 'The follow-up email will go out on the next hourly run.', TOO_EARLY: 'Too early — not yet due.', TOO_OLD: 'Too old — past the age limit.',
  ANSWERED: 'Already answered.', REASK_NOT_DUE: 'Answered "still applying"; the re-ask is not due yet.', ALREADY_PROMPTED: 'The email was already sent for this scan.',
  ATTEMPTS_EXHAUSTED: 'The email failed to send too many times.', NOT_PURCHASED: 'No purchased fix on this scan.', NOT_DELIVERED: 'The fix has not been delivered.',
  REWRITE_FAILED: 'The rewrite failed, so the resume was handed back unchanged — nothing to ask about.', PURCHASE_REVERSED: 'The purchase was refunded or is disputed.',
  NO_OWNER: 'The scan has no account.', NO_USER: 'The account could not be read.', NO_EMAIL: 'The account has no email address.', ACCOUNT_DELETED: 'The account was deleted.',
  ACCOUNT_NOT_ACTIVE: 'The account is not active (banned).', EMAIL_UNVERIFIED: 'The email address is not verified.', OPTED_OUT: 'The person switched the follow-up email off.',
  USER_COOLDOWN: 'This person was already emailed about another fix in the last 30 days.', NO_SCAN: 'No such scan.',
}
function Verdict({ label, v }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 text-sm">
      <p className="text-xs uppercase tracking-wide text-gray-400">{label}</p>
      <p className={`font-semibold ${v.ask ? 'text-green-700' : 'text-gray-900'}`}>{v.ask ? 'Asked' : 'Not asked'}</p>
      <p className="text-gray-600">{REASONS[v.reason] || v.reason}</p>
      {v.at && <p className="text-xs text-gray-500 mt-1">Due {formatDateTime(v.at)}</p>}
    </div>
  )
}
function AskSimulator() {
  const [scanId, setScanId] = useState('')
  const [days, setDays] = useState('0')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [res, setRes] = useState(null)
  async function run(e) {
    e.preventDefault()
    setBusy(true); setError(''); setRes(null)
    try {
      const r = await api.get(`/admin/outcome-ask/${encodeURIComponent(scanId.trim())}`, { params: { days: days === '' ? 0 : days } })
      setRes(r.data.data)
    } catch (err) {
      setError(err?.response?.data?.message || 'Could not check that scan.')
    } finally { setBusy(false) }
  }
  return (
    <section className="flex flex-col gap-3 border-t border-gray-100 pt-4 mt-2" aria-label="Interview question simulator">
      <h2 className="text-sm font-semibold text-gray-700">When is a person asked about an interview?</h2>
      <p className="text-xs text-gray-400">Paste a scan id to see whether its owner is asked now, by dashboard and by email, and what changes after N more days. Nothing is written.</p>
      <form onSubmit={run} className="flex flex-wrap items-end gap-3">
        <Input label="Scan id" value={scanId} onChange={e => setScanId(e.target.value)} wrapperClassName="w-96 max-w-full" />
        <Input label="Days ahead" type="number" min={0} max={730} value={days} onChange={e => setDays(e.target.value)} wrapperClassName="w-28" />
        <Button type="submit" size="sm" loading={busy} disabled={!scanId.trim()}>Check</Button>
      </form>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {res && (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-gray-500">
            First delivered {res.facts.firstDeliveredAt ? formatDateTime(res.facts.firstDeliveredAt) : '—'}
            {res.schedule && <> · dashboard from {formatDateTime(res.schedule.dashboardFrom)} · email from {formatDateTime(res.schedule.emailFrom)} · neither after {formatDateTime(res.schedule.askUntil)}</>}
            {res.facts.answer && <> · answered {res.facts.answer}</>}
          </p>
          <div className="grid sm:grid-cols-2 gap-3">
            <Verdict label="Dashboard / My Story — now" v={res.now_verdict.dashboard} />
            <Verdict label="Follow-up email — now" v={res.now_verdict.email} />
            {res.days > 0 && <Verdict label={`Dashboard — in ${res.days} days`} v={res.simulated.dashboard} />}
            {res.days > 0 && <Verdict label={`Email — in ${res.days} days`} v={res.simulated.email} />}
          </div>
        </div>
      )}
    </section>
  )
}

export default function AdminPromptOutcomes() {
  const toast = useToast()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [notReady, setNotReady] = useState(false)
  const begin = useLatestRequest()

  const load = useCallback(async () => {
    const isCurrent = begin()
    setLoading(true)
    setNotReady(false)
    try {
      const res = await api.get('/admin/prompt-outcomes')
      if (!isCurrent()) return
      setData(res.data.data)
    } catch (err) {
      if (!isCurrent()) return
      if (err?.response?.status === 503) setNotReady(true)
      else toast({ message: 'Failed to load prompt outcomes.', type: 'error' })
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold text-gray-900">Prompt outcomes</h1>
      <p className="text-xs text-gray-400">
        Interview rate by the prompt generation that wrote the delivered file. "Still applying" answers are left out of the rate.
      </p>
      {loading ? (
        <div className="flex justify-center py-8"><Spinner size="sm" /></div>
      ) : notReady ? (
        <p className="text-sm text-amber-700">Apply migration 0100 to see prompt outcomes.</p>
      ) : !data || (data.fix.length === 0 && data.letter.length === 0) ? (
        <p className="text-sm text-gray-400 italic">No interview answers recorded yet.</p>
      ) : (
        <>
          <h2 className="text-sm font-semibold text-gray-700 mt-2">Resume fix</h2>
          {data.fix.length ? table('Interview rate by resume prompt version', data.fix, data.minResponses) : <p className="text-sm text-gray-400 italic">No answers yet.</p>}
          <h2 className="text-sm font-semibold text-gray-700 mt-2">Cover letter</h2>
          {data.letter.length ? table('Interview rate by cover letter prompt version', data.letter, data.minResponses) : <p className="text-sm text-gray-400 italic">No answers yet.</p>}
        </>
      )}
      <AskSimulator />
    </div>
  )
}
