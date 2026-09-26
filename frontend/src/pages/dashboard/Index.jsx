import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import api, { getErrorMessage } from '../../lib/api'
import { useAuth } from '../../hooks/useAuth'
import DashboardLayout from '../../components/layout/DashboardLayout'
import Badge from '../../components/ui/Badge'
import Button from '../../components/ui/Button'
import Input from '../../components/ui/Input'
import Select from '../../components/ui/Select'
import Spinner from '../../components/ui/Spinner'
import Pagination from '../../components/ui/Pagination'
import ConfirmDialog from '../../components/ui/ConfirmDialog'
import { formatDate, statusLabel } from '../../lib/utils'
import { ATS_BADGE_THRESHOLD, ATS_PASS_THRESHOLD } from '../../lib/scoreThresholds'
import { createPoller } from '../../lib/poller'
import { isLive, canDeleteScan, scanHeading, scanDetails } from '../../lib/scanDisplay'

// FEATURE GAP CLOSED (Section 6, fixing-time pass): mirrors scan.controller
// .js's SCAN_STATUSES allowlist, for the filter dropdown below.
const SCAN_STATUSES = ['PENDING', 'SCANNING', 'COMPLETE_PASS', 'COMPLETE_FAIL', 'FIX_PURCHASED', 'FIX_GENERATING', 'FIX_DELIVERED', 'ERROR']

function scanBadgeVariant(status) {
  if (['COMPLETE_PASS', 'FIX_DELIVERED'].includes(status)) return 'green'
  if (status === 'COMPLETE_FAIL') return 'red'
  if (['FIX_PURCHASED', 'FIX_GENERATING'].includes(status)) return 'blue'
  if (status === 'ERROR') return 'red'
  return 'gray'
}

const SCANS_PER_PAGE = 20
// How often (ms) the list checks scans that are still being processed. Status
// requests have their own rate-limit budget (unlike the history list, which
// shares the general one), and only a few rows are ever in flight at once.
const LIVE_POLL_MS = 5000
const LIVE_POLL_MAX_SCANS = 5

// What deleting this particular scan takes with it, said before confirming.
function deleteMessage(scan) {
  const paid = scan.fixPurchased || !!scan.verificationCode
  return 'Permanently delete this scan? Its resume file, job description and any rewritten documents are removed.' +
    (paid ? `\n\nThis scan has a purchased fix${scan.verificationCode ? ' and a public verification page — that page will stop working' : ''}. Your payment record is kept.` : '') +
    '\n\nYour saved profile (Settings) is a separate copy and is not affected.'
}

export default function DashboardIndex() {
  const { user, refreshUser } = useAuth()
  const [scans,    setScans   ] = useState([])
  const [loading,  setLoading ] = useState(true)
  const [resending, setResending] = useState(false)
  const [resentOk, setResentOk] = useState(false)
  const [resendError, setResendError] = useState('')
  const [pendingDelete, setPendingDelete] = useState(null)   // scan awaiting confirmation
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  // FEATURE GAP CLOSED (Section 6, fixing-time pass): page/search/status now
  // live in the URL instead of plain component state — refreshing or
  // sharing a link to "page 3, status FIX_DELIVERED" used to always drop
  // you back to page 1 with no filters, since none of it survived a
  // remount.
  const [searchParams, setSearchParams] = useSearchParams()
  const page   = Math.max(parseInt(searchParams.get('page')) || 1, 1)
  const status = searchParams.get('status') || ''
  // Search box needs its own local state so typing doesn't refetch on every
  // keystroke — committed to the URL (and therefore the API call) debounced,
  // same reasoning as AdminUsers.jsx / AdminLeads.jsx's search boxes, which
  // don't debounce because admins type into a small, already-loaded list;
  // this list can be considerably larger, so debouncing avoids a network
  // request per keystroke.
  const [searchInput, setSearchInput] = useState(searchParams.get('search') || '')
  const [total, setTotal] = useState(0)
  // A failed history request used to fall into the same branch as "no scans"
  // and told a user with 50 scans "No scans yet — scan your first resume".
  const [loadError, setLoadError] = useState('')
  const [reloadTick, setReloadTick] = useState(0)
  // A background refresh (a scan finished) re-reads the list WITHOUT the
  // spinner replacing what the person is looking at.
  const [softTick, setSoftTick] = useState(0)
  const softRef = useRef(false)

  // PHASE 4 — retention hook: once a profile is saved, offer a one-click
  // path back into the scan form with that profile pre-selected.
  // true / false, or null when the check itself failed. Not knowing is not the
  // same as "no": hiding the button on a failed request quietly removed the
  // feature for someone who has a saved profile. The server answers a
  // saved-profile scan without one with a clear message, so showing it when
  // unsure is the safe direction.
  const [hasSavedProfile, setHasSavedProfile] = useState(false)

  const search = searchParams.get('search') || ''

  // Keeps the search box in sync with the URL when it changes from outside
  // typing (back/forward navigation, "Clear filters" below) — without this
  // the box could keep showing stale text while the actual results (driven
  // off `search`, not `searchInput`) had already moved on.
  useEffect(() => { setSearchInput(search) }, [search])

  useEffect(() => {
    const handle = setTimeout(() => {
      if (searchInput === search) return
      setSearchParams(prev => {
        const next = new URLSearchParams(prev)
        if (searchInput) next.set('search', searchInput); else next.delete('search')
        next.delete('page') // a new search always starts back at page 1
        return next
      })
    }, 350)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput])

  function setStatus(newStatus) {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (newStatus) next.set('status', newStatus); else next.delete('status')
      next.delete('page')
      return next
    })
  }

  function setPage(newPage) {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (newPage > 1) next.set('page', String(newPage)); else next.delete('page')
      return next
    })
  }

  // Only the newest request may write state: a quick filter change or page
  // click used to let a slower, older response land last and replace the list
  // the user was actually looking at.
  useEffect(() => {
    let cancelled = false
    const soft = softRef.current
    softRef.current = false
    if (!soft) { setLoading(true); setLoadError('') }
    api.get('/scan/history', { params: { page, limit: SCANS_PER_PAGE, search: search || undefined, status: status || undefined } })
      .then(res => {
        if (cancelled) return
        const data = res.data.data
        // A page past the end (scans removed since, a stale bookmark, a hand-
        // edited ?page=): step back to the last page that exists.
        const lastPage = Math.max(Math.ceil((data.total ?? 0) / SCANS_PER_PAGE), 1)
        if (page > lastPage) { setPage(lastPage); return }
        setScans(data.scans)
        setTotal(data.total ?? 0)
        setLoading(false)
      })
      .catch(err => {
        if (cancelled) return
        if (soft) return   // a failed background refresh keeps the list as it was
        setLoadError(getErrorMessage(err, "Couldn't load your scans."))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [page, search, status, reloadTick, softTick])

  // Scans still being processed used to sit at "Scanning" until the page was
  // reloaded by hand. Poll each live one's status (its own rate-limit bucket,
  // adaptive and paused in a background tab — lib/poller.js) and re-read the
  // list once when any of them changes. Stops on its own when none are live.
  useEffect(() => {
    const live = scans.filter(s => isLive(s)).slice(0, LIVE_POLL_MAX_SCANS)
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
  }, [scans])

  useEffect(() => {
    api.get('/profile')
      .then(res => setHasSavedProfile(!!res.data.data.hasSavedProfile))
      .catch(() => setHasSavedProfile(null))

    // Re-sync cached user state (emailVerified in particular) every time the
    // dashboard is visited — not just on app mount. Without this, verifying
    // your email on a different device/tab leaves the "verify your email"
    // banner showing here indefinitely, since this SPA session never
    // otherwise re-fetches /auth/me until a full page reload.
    refreshUser()
  }, [])

  const totalPages = Math.max(Math.ceil(total / SCANS_PER_PAGE), 1)

  async function resendVerification() {
    setResending(true); setResendError('')
    try {
      await api.post('/auth/resend-verification')
      setResentOk(true)
      // Also re-sync user state — covers the case where the account was
      // already verified elsewhere (another device/session) and the local
      // cache just hadn't caught up, which previously looked identical to
      // "resend isn't working" since the banner never went away either way.
      refreshUser()
    } catch (err) {
      // Was swallowed: a rate limit or a mail outage left a button that did
      // nothing and said nothing.
      setResendError(getErrorMessage(err, 'Could not resend the verification email.'))
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
      setDeleteError(getErrorMessage(err, 'Could not delete that scan.'))
      setPendingDelete(null)
    } finally {
      setDeleting(false)
    }
  }

  const hasFilters = !!(search || status)

  return (
    <DashboardLayout>
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h1 className="text-xl font-bold text-gray-900">Your scans</h1>
          <div className="flex items-center gap-3">
            {hasSavedProfile !== false && (
              <Link to="/?mode=savedProfile"
                className="text-sm bg-white border border-gray-300 text-gray-700 px-4 py-2 rounded-md hover:bg-gray-50 transition-colors">
                Rescan with new JD
              </Link>
            )}
            <Link to="/"
              className="text-sm bg-blue-700 text-white px-4 py-2 rounded-md hover:bg-blue-800 transition-colors">
              New scan →
            </Link>
          </div>
        </div>

        {/* Email verification banner */}
        {user && !user.emailVerified && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 flex flex-col sm:flex-row items-start sm:items-center gap-3">
            <div className="flex-1">
              <p className="text-sm font-medium text-amber-900">Verify your email to download files</p>
              <p className="text-xs text-amber-700 mt-0.5">Check your inbox for a verification email.</p>
            </div>
            {resentOk ? (
              <span className="text-xs text-green-700 bg-green-100 px-3 py-1.5 rounded-md">Sent!</span>
            ) : (
              <div className="flex flex-col items-start sm:items-end gap-1">
                <Button size="sm" variant="secondary" onClick={resendVerification} loading={resending}>
                  Resend email
                </Button>
                {resendError && <p role="alert" className="text-xs text-red-600">{resendError}</p>}
              </div>
            )}
          </div>
        )}

        {/* Free fix credit balance — previously only surfaced on a specific
            scan's FixBanner once you happened to land there; shown here too
            so a granted credit is never invisible. */}
        {user?.freeFixCredits > 0 && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 flex items-center gap-3">
            <p className="text-sm text-blue-900">
              You have <span className="font-semibold">{user.freeFixCredits} free fix credit{user.freeFixCredits > 1 ? 's' : ''}</span> — redeem it on any completed scan below, or a new one.
            </p>
          </div>
        )}

        {/* FEATURE GAP CLOSED (Section 6, fixing-time pass): search + status
            filter — the list got real pagination in the previous pass with
            nothing to actually find an older scan once there's more than a
            page of them. Mirrors AdminUsers.jsx / AdminLeads.jsx's pattern.
            Hidden entirely for a user with a single page and no scans yet,
            same "invisible for the common case" reasoning as the pagination
            controls below. */}
        {(total > 0 || hasFilters) && (
          <div className="flex gap-3 flex-wrap items-end">
            <Input placeholder="Search by job, filename or name" value={searchInput}
              onChange={e => setSearchInput(e.target.value)} className="w-64" />
            <Select id="scan-status-filter" label="Status" value={status} onChange={e => setStatus(e.target.value)}>
              <option value="">All</option>
              {SCAN_STATUSES.map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}
            </Select>
          </div>
        )}

        {deleteError && (
          <div role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-3">{deleteError}</div>
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

        {/* BUG FIX (Section 6, fixing-time pass): this used to say "No scans
            yet — scan your first resume" unconditionally whenever the
            current page came back empty — including a page/filter combo
            past the actual results, which would have wrongly told someone
            with real scan history that they had none. Not reachable today
            (nothing currently shrinks a user's scan count or invalidates a
            page mid-session), but became reachable the moment search/status
            filtering was added just above, since a filtered result set can
            legitimately be empty while unfiltered history isn't. */}
        {!loading && !loadError && scans.length === 0 && (
          <div className="text-center py-16 border border-dashed border-gray-200 rounded-xl">
            {hasFilters || page > 1 ? (
              <>
                <p className="text-gray-500 mb-4">No scans match your search.</p>
                <Button size="sm" variant="secondary" onClick={() => setSearchParams({})}>Clear filters</Button>
              </>
            ) : (
              <>
                <p className="text-gray-500 mb-4">No scans yet.</p>
                <Link to="/"
                  className="inline-block bg-blue-700 text-white px-5 py-2.5 rounded-md text-sm font-medium hover:bg-blue-800 transition-colors">
                  Scan your first resume →
                </Link>
              </>
            )}
          </div>
        )}

        {!loading && !loadError && scans.length > 0 && (
          <div className="flex flex-col gap-3">
            {scans.map(scan => (
              <div key={scan.id}
                className="bg-white rounded-lg border border-gray-200 hover:border-blue-300 transition-colors flex items-stretch">
              <Link
                to={`/scan/${scan.id}`}
                className="flex-1 min-w-0 px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-3"
              >
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-900 truncate">
                    {scanHeading(scan)}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5 truncate">
                    {[...scanDetails(scan), formatDate(scan.createdAt)].join(' · ')}
                  </p>
                </div>
                {/* BUG FIX (Section 6, second fixing-time pass): this showed the
                    ORIGINAL score even for a delivered fix (the number that
                    got someone to pay in the first place, not the result they
                    paid for — a scan that went 52 → 88 kept showing a red
                    "52/100" next to "Delivered ✓ Verified"), and showed the
                    Verified chip for ANY row with a code, including a fix
                    that finished below the badge threshold, where the public
                    verification page itself already says "below the Verified
                    threshold". displayScore/isVerified below use the same
                    fixAtsScore-when-purchased and score+revocation-aware logic
                    scan.controller.js and Verify.jsx already use. */}
                <div className="flex items-center gap-3 shrink-0">
                  {(() => {
                    const displayScore = scan.fixPurchased && scan.fixAtsScore != null ? scan.fixAtsScore : scan.atsScore
                    const isVerified = scan.verificationCode
                      && scan.verificationStatus !== 'REVOKED'
                      && displayScore != null && displayScore >= ATS_BADGE_THRESHOLD
                    return (
                      <>
                        {displayScore != null && (
                          <span className={`text-sm font-bold ${displayScore >= ATS_PASS_THRESHOLD ? 'text-green-700' : displayScore >= 50 ? 'text-amber-600' : 'text-red-600'}`}>
                            {displayScore}/100
                          </span>
                        )}
                        <Badge variant={scanBadgeVariant(scan.status)}>
                          {statusLabel(scan.status)}
                        </Badge>
                        {isVerified && (
                          <span className="text-xs bg-green-100 text-green-800 px-2 py-0.5 rounded-full">
                            ✓ Verified
                          </span>
                        )}
                      </>
                    )
                  })()}
                </div>
              </Link>
              <button type="button"
                onClick={() => { setDeleteError(''); setPendingDelete(scan) }}
                disabled={!canDeleteScan(scan)}
                title={!canDeleteScan(scan) ? 'Available once processing finishes' : 'Delete this scan'}
                aria-label={`Delete ${scanHeading(scan)}`}
                className="px-4 text-xs text-gray-400 hover:text-red-600 border-l border-gray-100 disabled:opacity-40 disabled:hover:text-gray-400 disabled:cursor-not-allowed">
                Delete
              </button>
              </div>
            ))}
          </div>
        )}

        {/* AUDIT FIX (Section 6): pagination controls — only shown once
            there's actually more than one page, so this stays invisible for
            the common case of a user with a handful of scans. */}
        {!loading && total > SCANS_PER_PAGE && (
          <Pagination
            page={page} totalPages={totalPages} onChange={p => setPage(p)}
            className="flex items-center justify-between gap-3 pt-2"
            prevLabel="← Previous" nextLabel="Next →"
            countClassName="text-xs text-gray-400"
          />
        )}
      </div>

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
