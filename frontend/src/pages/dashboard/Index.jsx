import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import api, { getErrorMessage } from '../../lib/api'
import { useAuth } from '../../hooks/useAuth'
import DashboardLayout from '../../components/layout/DashboardLayout'
import Badge from '../../components/ui/Badge'
import Button from '../../components/ui/Button'
import Input from '../../components/ui/Input'
import Spinner from '../../components/ui/Spinner'
import { formatDate, statusLabel } from '../../lib/utils'

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

// PHASE 1/4 — a scan's list label depends on how it was created; there's no
// resumeOriginalName for brain-dump or saved-profile scans since neither
// involves an uploaded file.
function scanLabel(scan) {
  if (scan.resumeOriginalName) return scan.resumeOriginalName
  if (scan.inputMode === 'brain_dump') return 'Built from scratch'
  if (scan.inputMode === 'saved_profile') return 'From saved profile'
  return 'Resume'
}

const SCANS_PER_PAGE = 20

export default function DashboardIndex() {
  const { user, refreshUser } = useAuth()
  const [scans,    setScans   ] = useState([])
  const [loading,  setLoading ] = useState(true)
  const [resending, setResending] = useState(false)
  const [resentOk, setResentOk] = useState(false)

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

  // PHASE 4 — retention hook: once a profile is saved, offer a one-click
  // path back into the scan form with that profile pre-selected.
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

  useEffect(() => {
    setLoading(true); setLoadError('')
    api.get('/scan/history', { params: { page, limit: SCANS_PER_PAGE, search: search || undefined, status: status || undefined } })
      .then(res => {
        setScans(res.data.data.scans)
        setTotal(res.data.data.total ?? 0)
        setLoading(false)
      })
      .catch(err => {
        setLoadError(getErrorMessage(err, "Couldn't load your scans."))
        setLoading(false)
      })
  }, [page, search, status, reloadTick])

  useEffect(() => {
    api.get('/profile')
      .then(res => setHasSavedProfile(!!res.data.data.hasSavedProfile))
      .catch(() => {})

    // Re-sync cached user state (emailVerified in particular) every time the
    // dashboard is visited — not just on app mount. Without this, verifying
    // your email on a different device/tab leaves the "verify your email"
    // banner showing here indefinitely, since this SPA session never
    // otherwise re-fetches /auth/me until a full page reload.
    refreshUser()
  }, [])

  const totalPages = Math.max(Math.ceil(total / SCANS_PER_PAGE), 1)

  async function resendVerification() {
    setResending(true)
    try {
      await api.post('/auth/resend-verification')
      setResentOk(true)
      // Also re-sync user state — covers the case where the account was
      // already verified elsewhere (another device/session) and the local
      // cache just hadn't caught up, which previously looked identical to
      // "resend isn't working" since the banner never went away either way.
      refreshUser()
    } catch (_) {}
    setResending(false)
  }

  const hasFilters = !!(search || status)

  return (
    <DashboardLayout>
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h1 className="text-xl font-bold text-gray-900">Your scans</h1>
          <div className="flex items-center gap-3">
            {hasSavedProfile && (
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
              <Button size="sm" variant="secondary" onClick={resendVerification} loading={resending}>
                Resend email
              </Button>
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
            <Input placeholder="Search by filename or name" value={searchInput}
              onChange={e => setSearchInput(e.target.value)} className="w-64" />
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-gray-500">Status</label>
              <select value={status} onChange={e => setStatus(e.target.value)}
                className="rounded-md border border-gray-300 px-3 py-2 text-sm">
                <option value="">All</option>
                {SCAN_STATUSES.map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}
              </select>
            </div>
          </div>
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
              <Link
                key={scan.id}
                to={`/scan/${scan.id}`}
                className="bg-white rounded-lg border border-gray-200 px-5 py-4 hover:border-blue-300 transition-colors flex flex-col sm:flex-row sm:items-center gap-3"
              >
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-900 truncate">
                    {scanLabel(scan)}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">{formatDate(scan.createdAt)}</p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {scan.atsScore != null && (
                    <span className={`text-sm font-bold ${scan.atsScore >= 75 ? 'text-green-700' : scan.atsScore >= 50 ? 'text-amber-600' : 'text-red-600'}`}>
                      {scan.atsScore}/100
                    </span>
                  )}
                  <Badge variant={scanBadgeVariant(scan.status)}>
                    {statusLabel(scan.status)}
                  </Badge>
                  {scan.verificationCode && (
                    <span className="text-xs bg-green-100 text-green-800 px-2 py-0.5 rounded-full">
                      ✓ Verified
                    </span>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}

        {/* AUDIT FIX (Section 6): pagination controls — only shown once
            there's actually more than one page, so this stays invisible for
            the common case of a user with a handful of scans. */}
        {!loading && total > SCANS_PER_PAGE && (
          <div className="flex items-center justify-between gap-3 pt-2">
            <Button
              variant="secondary" size="sm"
              disabled={page <= 1}
              onClick={() => setPage(Math.max(page - 1, 1))}
            >
              ← Previous
            </Button>
            <p className="text-xs text-gray-400">Page {page} of {totalPages}</p>
            <Button
              variant="secondary" size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage(Math.min(page + 1, totalPages))}
            >
              Next →
            </Button>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
