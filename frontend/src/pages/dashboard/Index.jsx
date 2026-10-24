import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import api, { getErrorMessage } from '../../lib/api'
import { useAuth } from '../../hooks/useAuth'
import { usePricing, fmtPrice } from '../../hooks/usePricing'
import DashboardLayout from '../../components/layout/DashboardLayout'
import Button from '../../components/ui/Button'
import Input from '../../components/ui/Input'
import Select from '../../components/ui/Select'
import Checkbox from '../../components/ui/Checkbox'
import Spinner from '../../components/ui/Spinner'
import Pagination from '../../components/ui/Pagination'
import ConfirmDialog from '../../components/ui/ConfirmDialog'
import Alert from '../../components/ui/Alert'
import OutcomeCard from '../../components/account/OutcomeCard'
import ScanRow from '../../components/dashboard/ScanRow'
import NextStepCard from '../../components/dashboard/NextStepCard'
import StatsRow from '../../components/dashboard/StatsRow'
import WelcomeOfferCard from '../../components/dashboard/WelcomeOfferCard'
import { useWelcomeOffer } from '../../hooks/useWelcomeOffer'
import BreakdownModal from '../../components/dashboard/BreakdownModal'
import { statusLabel } from '../../lib/utils'
import ToggleChip from '../../components/ui/ToggleChip'
import { createPoller } from '../../lib/poller'
import { loadNeedsDecision } from '../../lib/needsDecision'
import { describeQuota } from '../../lib/quota'
import { canDeleteScan, isLive, effectiveSearch } from '../../lib/scanDisplay'
import { isAlreadyVerified } from '../../lib/resendVerification'
import { purgeScans, partialDeleteNote } from '../../lib/purgeScans'
import { CHIPS, STATUS_FILTERS, chipCount, nextSteps, bestTrend, displayScore, isVerified } from '../../lib/scanNext'

const SCANS_PER_PAGE = 20
// The summary above the list (next step, best score, credentials) looks at the newest scans the API will
// return in one go, independent of the page / filters below it.
const OVERVIEW_LIMIT = 100
const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'score_desc', label: 'Highest score' },
  { value: 'score_asc', label: 'Lowest score' },
]
// How often (ms) the page checks scans that are still being processed. Status requests have their own
// rate-limit budget (unlike the history list, which shares the general one), and only a few rows are ever
// in flight at once. 3 scans every 6s is 450 status requests per 15 minutes, under the status endpoint's
// per-IP budget of 600, which the scan page's own polling shares. More than 3 in flight are picked up as
// these finish.
const LIVE_POLL_MS = 6000
const LIVE_POLL_MAX_SCANS = 3

// What deleting this particular scan takes with it, said before confirming.
function deleteMessage(scan) {
  const paid = scan.fixPurchased || !!scan.verificationCode
  return 'Permanently delete this scan? Its resume file, job description and any rewritten documents are removed.' +
    (paid ? `\n\nThis scan has a purchased fix${scan.verificationCode ? ' and a public verification page — that page will stop working' : ''}. Your payment record is kept. A success story you shared about it is taken down (your interview answer stays, anonymously).` : '') +
    '\n\nYour saved profile (Settings) is a separate copy and is not affected.'
}

const chipLabel = key => CHIPS.find(c => c.key === key)?.label || statusLabel(key)

export default function DashboardIndex() {
  const { user, refreshUser } = useAuth()
  const { pricing, byTier } = usePricing()
  const welcomeOffer = useWelcomeOffer(user)
  const [scans,    setScans   ] = useState([])
  const [loading,  setLoading ] = useState(true)
  const [resending, setResending] = useState(false)
  const [resentOk, setResentOk] = useState(false)
  const [everResent, setEverResent] = useState(false)
  const [resendError, setResendError] = useState('')
  const [pendingDelete, setPendingDelete] = useState(null)   // scan awaiting confirmation
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  // "Delete these N scans": removes what the current search / status filter shows, in batches.
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkRunning, setBulkRunning] = useState(false)
  const [bulkCount, setBulkCount] = useState(0)
  const [bulkError, setBulkError] = useState('')
  const [bulkResult, setBulkResult] = useState(null)   // { deleted, remaining }
  const [breakdown, setBreakdown] = useState(null)     // scan whose breakdown is open
  const navigate = useNavigate()

  // page / search / status / sort live in the URL: refreshing or sharing a link to "page 3, Delivered"
  // keeps the view.
  const [searchParams, setSearchParams] = useSearchParams()
  const page   = Math.max(parseInt(searchParams.get('page')) || 1, 1)
  // A hand-edited ?status=FOO used to leave the filter showing "All" while the empty state claimed one was
  // active. Anything that is not a real status (or chip group) is no filter at all.
  const rawStatus = searchParams.get('status') || ''
  const status = STATUS_FILTERS.includes(rawStatus) ? rawStatus : ''
  // Order of the list. 'newest' is the default and is kept out of the URL.
  const rawSort = searchParams.get('sort') || ''
  const sort = SORT_OPTIONS.some(o => o.value === rawSort) ? rawSort : 'newest'
  // Hand-picked scans (checkboxes) on the CURRENT page only; cleared whenever the list changes.
  const [selected, setSelected] = useState(() => new Set())
  const [selectOpen, setSelectOpen] = useState(false)
  const [selectRunning, setSelectRunning] = useState(false)
  // The search box keeps its own text so typing doesn't refetch on every keystroke; it is committed to the
  // URL (and so to the API call) after a pause.
  const [searchInput, setSearchInput] = useState(searchParams.get('search') || '')
  const [total, setTotal] = useState(0)
  // A failed history request used to fall into the same branch as "no scans".
  const [loadError, setLoadError] = useState('')
  const [reloadTick, setReloadTick] = useState(0)
  // A background refresh (a scan finished) re-reads the list WITHOUT the spinner replacing what the person is
  // looking at.
  const [softTick, setSoftTick] = useState(0)
  const softRef = useRef(false)
  // A foreground load (spinner on) that was cancelled before it finished. A background refresh that takes over
  // from it has to finish the job: clear the spinner and report a failure.
  const hardPendingRef = useRef(false)
  // The newest scans, for the next-step card and the stats. null until read (or if that read failed).
  const [overview, setOverview] = useState(null)   // { scans, total }
  // Today's free-scan allowance (from the /profile read). Not knowing is not an error.
  const [quota, setQuota] = useState(null)

  const search = searchParams.get('search') || ''
  // What the server will really match on (see effectiveSearch).
  const effSearch = effectiveSearch(search)

  // The last search text THIS box wrote to the URL. The URL -> box sync below must only act when the URL
  // changed from somewhere else (Back/forward, "Clear filters").
  const committedSearch = useRef(search)
  useEffect(() => {
    if (search === committedSearch.current) return
    committedSearch.current = search
    setSearchInput(search)
  }, [search])

  useEffect(() => {
    const handle = setTimeout(() => {
      if (searchInput === search) return
      committedSearch.current = searchInput
      clearNotices()
      // replace: a pause in typing is not a place to come back to.
      setSearchParams(prev => {
        const next = new URLSearchParams(prev)
        if (searchInput) next.set('search', searchInput); else next.delete('search')
        next.delete('page') // a new search always starts back at page 1
        return next
      }, { replace: true })
    }, 350)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput])

  // The last delete's result / error lines describe THAT list; a filter, sort or page the person picks makes them stale.
  function clearNotices() { setBulkResult(null); setBulkError(''); setDeleteError('') }

  function setStatus(newStatus) {
    clearNotices()
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (newStatus) next.set('status', newStatus); else next.delete('status')
      next.delete('page')
      return next
    })
  }

  function setSort(newSort) {
    clearNotices()
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (newSort && newSort !== 'newest') next.set('sort', newSort); else next.delete('sort')
      next.delete('page')
      return next
    })
  }

  function setPage(newPage, options) {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (newPage > 1) next.set('page', String(newPage)); else next.delete('page')
      return next
    }, options)
  }

  // Only the newest request may write state: a quick filter change or page click used to let a slower, older
  // response land last and replace the list the user was actually looking at.
  useEffect(() => {
    let cancelled = false
    const soft = softRef.current && !hardPendingRef.current
    softRef.current = false
    if (!soft) { hardPendingRef.current = true; setLoading(true); setLoadError('') }
    api.get('/scan/history', { params: { page, limit: SCANS_PER_PAGE, search: effSearch || undefined, status: status || undefined, sort: sort !== 'newest' ? sort : undefined } })
      .then(res => {
        if (cancelled) return
        const data = res.data.data
        // A page past the end (scans removed since, a stale bookmark, a hand-edited ?page=): step back to the last page.
        const lastPage = Math.max(Math.ceil((data.total ?? 0) / SCANS_PER_PAGE), 1)
        // replace: the out-of-range page is not somewhere Back should return to.
        if (page > lastPage) { setPage(lastPage, { replace: true }); return }
        hardPendingRef.current = false
        setScans(data.scans)
        setTotal(data.total ?? 0)
        setLoading(false)
      })
      .catch(err => {
        if (cancelled) return
        hardPendingRef.current = false
        if (soft) return   // a failed background refresh keeps the list as it was
        setLoadError(getErrorMessage(err, "Couldn't load your scans."))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [page, effSearch, status, sort, reloadTick, softTick])

  // The summary reads the newest scans once per (re)load; a failure just leaves it as it was.
  useEffect(() => {
    let cancelled = false
    api.get('/scan/history', { params: { limit: OVERVIEW_LIMIT } })
      .then(res => { if (!cancelled) setOverview({ scans: res.data.data.scans || [], total: res.data.data.total ?? 0 }) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [reloadTick, softTick])

  // Scans still being processed used to sit at "Scanning" until the page was reloaded by hand. Poll each live
  // one's status (its own rate-limit bucket, adaptive and paused in a background tab, see lib/poller.js) and
  // re-read the lists once when any of them changes. Watches the visible page AND the summary, so a scan on
  // another page still moves the next-step card. Stops on its own when none are live.
  useEffect(() => {
    const seen = new Set()
    const pool = [...scans, ...(overview?.scans || [])].filter(s => (seen.has(s.id) ? false : (seen.add(s.id), true)))
    const live = pool.filter(s => isLive(s)).slice(0, LIVE_POLL_MAX_SCANS)
    if (live.length === 0) return
    const poller = createPoller(async () => {
      const latest = await Promise.all(live.map(s =>
        api.get(`/scan/status/${s.id}`).then(res => res.data.data.status, () => null)))
      if (latest.some(st => st === null)) return false   // a failed tick: the poller backs off
      if (latest.some((st, i) => st !== live[i].status)) {
        softRef.current = true
        setSoftTick(t => t + 1)
      }
      return true
    }, { schedule: [[Infinity, LIVE_POLL_MS]] })
    poller.start({ immediate: false })
    return () => poller.stop()
  }, [scans, overview])

  useEffect(() => {
    api.get('/profile/quota')   // just the counter: /profile also reads every saved resume
      .then(res => setQuota(res.data.data.quota || null))
      .catch(() => {})
    // Re-sync cached user state (emailVerified in particular) every time the dashboard is visited, not just on
    // app mount: verifying your email on another device would otherwise leave the banner here indefinitely.
    refreshUser()
  }, [])

  // The "Scans" tab's count follows this list: any reload, background refresh or delete re-reads it.
  // AUDIT FIX (Profile & Dashboard, B2): on first mount the tab strip (DashboardLayout, a child, so its effect runs first)
  // has already asked for the count; forcing here queued a SECOND identical request on every cold dashboard load.
  // The first run joins what is already out; later ticks (a reload, a background refresh, a delete) force as before.
  const needsFirstRun = useRef(true)
  useEffect(() => {
    const first = needsFirstRun.current
    needsFirstRun.current = false
    loadNeedsDecision(user?.id, { force: true, coalesce: first })
  }, [user?.id, reloadTick, softTick])

  const totalPages = Math.max(Math.ceil(total / SCANS_PER_PAGE), 1)

  // "Sent!" is shown for a moment, then the button comes back so a lost email can be asked for again.
  useEffect(() => {
    if (!resentOk) return undefined
    const t = setTimeout(() => setResentOk(false), 30000)
    return () => clearTimeout(t)
  }, [resentOk])

  async function resendVerification() {
    setResending(true); setResendError('')
    try {
      await api.post('/auth/resend-verification')
      setResentOk(true); setEverResent(true)
      refreshUser()
    } catch (err) {
      setResendError(getErrorMessage(err, 'Could not resend the verification email.'))
      // "Already verified." means verified elsewhere meanwhile: re-sync so this banner goes away.
      if (isAlreadyVerified(err)) refreshUser()
    }
    setResending(false)
  }

  async function confirmDeleteScan() {
    setDeleting(true); setDeleteError('')
    try {
      await api.delete(`/scan/${pendingDelete.id}`)
      setPendingDelete(null)
      setReloadTick(t => t + 1)   // the page may now be short or empty; the load effect steps back if so
    } catch (err) {
      setPendingDelete(null)
      if (err.response?.status === 404) {
        // Already gone (deleted from another tab or device): the goal is met. Just drop the stale row.
        setReloadTick(t => t + 1)
      } else {
        setDeleteError(getErrorMessage(err, 'Could not delete that scan.'))
      }
    } finally {
      setDeleting(false)
    }
  }

  // A selection belongs to the page it was made on: any new page, filter, sort or reload drops it.
  useEffect(() => { setSelected(new Set()) }, [page, effSearch, status, sort, reloadTick])
  // Rows still on screen (a background refresh may have removed some).
  useEffect(() => {
    setSelected(prev => {
      if (!prev.size) return prev
      const live = new Set(scans.filter(s => canDeleteScan(s)).map(x => x.id))
      const next = new Set([...prev].filter(id => live.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [scans])
  const selectableIds = scans.filter(s => canDeleteScan(s)).map(x => x.id)
  const allSelected = selectableIds.length > 0 && selectableIds.every(id => selected.has(id))
  function toggleOne(id) {
    setSelected(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }
  function toggleAll() { setSelected(allSelected ? new Set() : new Set(selectableIds)) }

  async function confirmSelectedDelete() {
    setSelectRunning(true); setBulkError(''); setBulkResult(null)
    try {
      const res = await api.delete('/profile/scans', { params: { ids: [...selected].join(',') } })
      setBulkResult(res.data.data)
    } catch (err) {
      setBulkError(getErrorMessage(err, 'Could not delete those scans.'))
    } finally {
      setSelectRunning(false); setSelectOpen(false)
      setReloadTick(t => t + 1)
    }
  }

  const hasFilters = !!(effSearch || status)
  // "Delete these N" only for a filter that means something to delete: the In progress chip alone is skipped
  // (the server keeps scans that are still working, so it could only ever delete the stuck ones).
  const canBulkDelete = hasFilters && !(status === 'IN_PROGRESS' && !effSearch)

  // What the filters currently show, in words, for the confirmation ("status Failed and “pm”").
  const filterWords = [status && `status ${chipLabel(status)}`, effSearch && `“${effSearch}”`].filter(Boolean).join(' and ')

  async function confirmBulkDelete() {
    setBulkRunning(true); setBulkError(''); setBulkResult(null); setBulkCount(0)
    try {
      setBulkResult(await purgeScans(api, { status, search: effSearch, onProgress: setBulkCount }))
    } catch (err) {
      setBulkError(getErrorMessage(err, 'Could not delete those scans.') + partialDeleteNote(err.purgeDeleted))
    } finally {
      setBulkRunning(false); setBulkOpen(false)
      setReloadTick(t => t + 1)   // the list is shorter now; the load effect steps back a page if needed
    }
  }

  // A new scan has a page of its own (/scan, inside this same header): the form used to open in a collapsed panel
  // here, and was a second home for the same form that the homepage already had.
  function openComposer() { navigate('/scan') }

  const now = Date.now()
  const credits = user?.freeFixCredits || 0
  const currency = pricing?.currency || 'USD'
  const prices = { fix: fmtPrice(byTier('FIX').amount, currency), badge: fmtPrice(byTier('BADGE').amount, currency) }
  const q = describeQuota(quota)
  const ov = overview?.scans || []
  const partialOverview = !!overview && overview.total > ov.length
  const best = ov.reduce((m, s) => { const n = displayScore(s); return n != null && s.status !== 'ERROR' && (m == null || n > m) ? n : m }, null)
  const steps = nextSteps(ov, now)
  const showCounts = !!overview && !partialOverview
  const firstVisit = !loading && !loadError && !hasFilters && page === 1 && total === 0

  return (
    <DashboardLayout>
      <div className="flex flex-col gap-6">
        {/* Asks, 14 days after a fix landed, whether it led to an interview. */}
        <OutcomeCard showStories={false} />
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Your scans</h1>
            {total > 0 && <p className="text-sm text-gray-500 mt-0.5">{overview ? `${overview.total} scan${overview.total === 1 ? '' : 's'} in total.` : ''}</p>}
          </div>
          <Button onClick={openComposer}>New scan</Button>
        </div>

        {/* Webhooks round 14 (G1): the mail provider reported this address as bouncing / a spam complaint. Security mail still goes
            there and will not arrive, so say so (cleared when the address is changed). */}
        {user?.emailBounce && (
          <div role="status" data-testid="email-bounce-banner" className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
            <p className="text-sm font-medium text-amber-900">We can't reach your email address</p>
            <p className="text-xs text-amber-700 mt-0.5">
              {user.emailBounce.type === 'complaint'
                ? 'A message to this address was reported as spam, so we have stopped sending optional email to it.'
                : 'Messages to this address are being returned.'}{' '}
              Sign-in codes, password resets and receipts may not arrive. <a className="underline" href="/dashboard/settings">Update your email in Settings</a>.
            </p>
          </div>
        )}

        {/* Email verification banner */}
        {user && !user.emailVerified && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 flex flex-col sm:flex-row items-start sm:items-center gap-3">
            <div className="flex-1">
              <p className="text-sm font-medium text-amber-900">Verify your email to download files</p>
              <p className="text-xs text-amber-700 mt-0.5">
                Check your inbox for a verification email.
                {pricing?.welcomePercentOff > 0 && <> Verifying also unlocks {pricing.welcomePercentOff}% off your first full fix.</>}
              </p>
            </div>
            {resentOk ? (
              <span className="text-xs text-green-700 bg-green-100 px-3 py-1.5 rounded-md">Sent!</span>
            ) : (
              <div className="flex flex-col items-start sm:items-end gap-1">
                <Button size="sm" variant="secondary" onClick={resendVerification} loading={resending}>
                  {everResent ? 'Resend again' : 'Resend email'}
                </Button>
                {resendError && <p role="alert" className="text-xs text-red-600">{resendError}</p>}
              </div>
            )}
          </div>
        )}

        {/* The welcome code, for a new account: shown here as well as in the email. Only once verified (the code is issued then). */}
        {user?.emailVerified && <WelcomeOfferCard offer={welcomeOffer} onScan={openComposer} />}

        {/* The allowance in words: a callout once it is used up, otherwise read by screen readers (the stats card shows it). */}
        {q && (
          <p role="status" data-testid="scan-quota"
            className={q.exhausted ? 'text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3' : 'sr-only'}>
            {q.text}
          </p>
        )}

        {!firstVisit && !loadError && overview && (
          <NextStepCard steps={steps} hasScans={ov.length > 0} credits={credits} prices={prices} onBreakdown={setBreakdown} />
        )}

        {!loadError && (
          <StatsRow best={best} trend={bestTrend(ov)} verifiedCount={ov.filter(isVerified).length}
            quota={quota} credits={credits} partial={partialOverview} />
        )}

        {/* Chips, search and sort. Hidden entirely for a person with no scans and no filter. */}
        {(total > 0 || hasFilters) && (
          <div className="flex flex-col gap-3">
            <div role="group" aria-label="Filter scans" className="flex flex-wrap gap-2">
              {CHIPS.map(c => {
                const active = c.key === status
                return (
                  <ToggleChip key={c.key || 'all'} pressed={active} onClick={() => setStatus(c.key)}>
                    {c.label}{showCounts && <span className="ml-1.5 opacity-70">{chipCount(ov, c.key)}</span>}
                  </ToggleChip>
                )
              })}
            </div>
            <div className="flex gap-3 flex-wrap items-end">
              <Input placeholder="Search by job, filename or name" aria-label="Search scans" value={searchInput}
                onChange={e => setSearchInput(e.target.value)} wrapperClassName="w-64" />
              <Select id="scan-sort" label="Sort" value={sort} onChange={e => setSort(e.target.value)}>
                {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
              {selectableIds.length > 0 && !loading && !loadError && (
                <Checkbox label="Select page" wrapperClassName="pb-2" checked={allSelected} indeterminate={selected.size > 0 && !allSelected} onChange={toggleAll} />
              )}
              {selected.size > 0 && (
                <Button size="sm" variant="secondary" onClick={() => { setBulkError(''); setBulkResult(null); setSelectOpen(true) }}>
                  Delete {selected.size} selected
                </Button>
              )}
              {/* Clearing out e.g. every failed scan used to mean deleting them one at a time. */}
              {canBulkDelete && total > 0 && !loading && !loadError && (
                <Button size="sm" variant="secondary" onClick={() => { setBulkError(''); setBulkResult(null); setBulkOpen(true) }}>
                  Delete these {total} scan{total === 1 ? '' : 's'}
                </Button>
              )}
            </div>
          </div>
        )}

        <Alert>{deleteError}</Alert>
        <Alert>{bulkError}</Alert>
        {bulkResult && (
          <p role="status" className="text-sm text-gray-700">
            {bulkResult.deleted === 0 && bulkResult.remaining === 0
              ? 'No scans matched.'
              : `Deleted ${bulkResult.deleted} scan${bulkResult.deleted === 1 ? '' : 's'}.`}
            {bulkResult.remaining > 0 && ` ${bulkResult.remaining} ${bulkResult.remaining === 1 ? 'is' : 'are'} still being processed and ${bulkResult.remaining === 1 ? 'was' : 'were'} kept — try again in a few minutes.`}
          </p>
        )}

        {loading && (
          <div className="flex justify-center py-12">
            <Spinner size="lg" />
          </div>
        )}

        {!loading && loadError && (
          <div role="alert" className="text-center py-12 border border-red-200 bg-red-50 rounded-xl">
            <p className="text-sm text-red-700 mb-4">{loadError}</p>
            <Button size="sm" variant="secondary" onClick={() => setReloadTick(t => t + 1)}>Try again</Button>
          </div>
        )}

        {/* An empty page is only "no scans yet" when nothing narrows it: a filtered or out-of-range page can be
            empty while the history is not. */}
        {!loading && !loadError && scans.length === 0 && (
          <div className="text-center py-16 border border-dashed border-gray-200 rounded-xl">
            {hasFilters || page > 1 ? (
              <>
                <p className="text-gray-500 mb-4">No scans match your search.</p>
                <Button size="sm" variant="secondary" onClick={() => { clearNotices(); setSearchParams({}) }}>Clear filters</Button>
              </>
            ) : (
              <>
                <p className="text-gray-500 mb-4">No scans yet. You will see exactly what an ATS reads, and what to fix.</p>
                <Button onClick={openComposer}>Scan your first resume</Button>
              </>
            )}
          </div>
        )}

        {!loading && !loadError && scans.length > 0 && (
          <ul className="flex flex-col gap-3" aria-label="Your scans">
            {scans.map(scan => (
              <ScanRow key={scan.id} scan={scan} now={now} credits={credits} prices={prices}
                selected={selected.has(scan.id)} onToggle={toggleOne} onBreakdown={setBreakdown}
                onDelete={s => { setDeleteError(''); setPendingDelete(s) }} />
            ))}
          </ul>
        )}

        {/* Pagination controls: only shown once there is more than one page. */}
        {!loading && total > SCANS_PER_PAGE && (
          <Pagination
            page={page} totalPages={totalPages} onChange={p => { clearNotices(); setPage(p) }}
            className="flex items-center justify-between gap-3 pt-2"
            prevLabel="← Previous" nextLabel="Next →"
            countClassName="text-xs text-gray-400"
          />
        )}
      </div>

      <BreakdownModal scan={breakdown} now={now} onClose={() => setBreakdown(null)} />

      <ConfirmDialog
        open={bulkOpen}
        title="Delete these scans"
        message={bulkRunning
          ? `Deleting… ${bulkCount} scan${bulkCount === 1 ? '' : 's'} removed so far.`
          : `Permanently delete the ${total} scan${total === 1 ? '' : 's'} matching ${filterWords}? Each scan's resume file, job description and rewritten documents are removed, and any public verification page you purchased for them stops working. A success story you shared about one of them is taken down with it (your interview answer stays, anonymously). Payment records and your saved profile are kept.\n\nScans that are still being processed are skipped.`}
        confirmLabel={`Delete ${total} scan${total === 1 ? '' : 's'}`}
        loading={bulkRunning}
        onConfirm={confirmBulkDelete}
        onCancel={() => setBulkOpen(false)}
      />

      <ConfirmDialog
        open={selectOpen}
        title="Delete selected scans"
        message={`Permanently delete the ${selected.size} scan${selected.size === 1 ? '' : 's'} you selected? Each scan's resume file, job description and rewritten documents are removed, and any public verification page you purchased for them stops working. A success story you shared about one of them is taken down with it (your interview answer stays, anonymously). Payment records and your saved profile are kept.`}
        confirmLabel={`Delete ${selected.size} scan${selected.size === 1 ? '' : 's'}`}
        loading={selectRunning}
        onConfirm={confirmSelectedDelete}
        onCancel={() => setSelectOpen(false)}
      />

      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete scan"
        message={pendingDelete ? deleteMessage(pendingDelete) : ''}
        confirmLabel="Delete scan"
        loading={deleting}
        onConfirm={confirmDeleteScan}
        onCancel={() => setPendingDelete(null)}
      />
    </DashboardLayout>
  )
}
