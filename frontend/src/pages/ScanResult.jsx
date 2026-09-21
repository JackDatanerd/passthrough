import { useEffect, useState, useRef } from 'react'
import { useParams, useSearchParams, Link, useNavigate } from 'react-router-dom'
import api, { getErrorMessage } from '../lib/api'
import { createPoller } from '../lib/poller'
import { downloadBlob } from '../lib/utils'
import PaystackPop from '@paystack/inline-js'
import { useAuth } from '../hooks/useAuth'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'
import ScoreGauge from '../components/scan/ScoreGauge'
import CategoryScores from '../components/scan/CategoryScores'
import AtsDetailPanel from '../components/scan/AtsDetailPanel'
import FixBanner from '../components/scan/FixBanner'
import { getStoredReferralCode, setStoredReferralCode } from '../hooks/useReferralCapture'
import DiffView from '../components/scan/DiffView'
import ResumeDataEditor from '../components/scan/ResumeDataEditor'
import QuantificationPrompts from '../components/scan/QuantificationPrompts'
import SaveProfilePrompt from '../components/scan/SaveProfilePrompt'
import Spinner from '../components/ui/Spinner'
import Button from '../components/ui/Button'
import { statusLabel, formatDate } from '../lib/utils'
import { ATS_BADGE_THRESHOLD, MAX_FIX_RETRIES } from '../lib/scoreThresholds'
import { getAnonScanToken } from '../lib/anonScans'

// These used to be a single `TERMINAL` array serving two different jobs at
// once: "when should we stop polling" and "which statuses render the
// results section". FIX_GENERATING belonged in the second list but not the
// first — including it in a single shared array meant polling stopped the
// instant a fix started generating, before the backend (which can take a
// minute or two: two Claude calls + a PDF render) had actually finished.
// The UI would then sit on "Generating your fixed resume…" forever, even
// after the backend completed successfully.
//
// POLLING_STOP: true terminal states — nothing will change without the user
// taking an action (paying) or starting a new scan. Deliberately excludes
// FIX_PURCHASED and FIX_GENERATING, which the backend transitions through
// automatically without any user input.
const POLLING_STOP = ['COMPLETE_PASS', 'COMPLETE_FAIL', 'FIX_DELIVERED', 'ERROR']
// RESULTS_READY: statuses where the score/results section should render at
// all (as opposed to the plain "Scanning your resume…" placeholder).
const RESULTS_READY = ['COMPLETE_PASS', 'COMPLETE_FAIL', 'FIX_PURCHASED', 'FIX_GENERATING', 'FIX_DELIVERED']
// Polling cadence lives in lib/poller.js (adaptive backoff, pauses in background tabs).

export default function ScanResult() {
  const { id }        = useParams()
  const [params]      = useSearchParams()
  const navigate      = useNavigate()
  const { user, refreshUser } = useAuth()
  // AUDIT FIX: this read a single global 'passthrough_anon_token' key —
  // broke the moment anonScans.js started tracking more than one pending
  // anon scan (see that file), since there was no longer one universal
  // "the" token to fall back to. getAnonScanToken(id) looks up the token
  // for THIS specific scan by id instead.
  const anonToken     = params.get('token') || getAnonScanToken(id)
  const [scan,        setScan      ] = useState(null)
  const [loading,     setLoading   ] = useState(true)
  const [payLoading,  setPayLoading] = useState(false)
  // BUGFIX: this used to exist alongside payLoading but neither was ever
  // passed to FixBanner or its buttons — payLoading was set throughout
  // handlePay but never actually consumed anywhere, so nothing stopped a
  // double-click (or clicking a second tier) from firing handlePay again
  // while a payment was already initializing, opening the door to the
  // duplicate-payment scenario fixed server-side in payments.controller.js.
  // payingTier additionally drives which specific button shows the spinner.
  const [payingTier,  setPayingTier] = useState(null)
  const [payError,    setPayError  ] = useState('')
  const [dlError,     setDlError   ] = useState('')
  const [visibilityError, setVisibilityError] = useState('')
  const [retryLoading, setRetryLoading] = useState(false)
  const [retryError,   setRetryError  ] = useState('')
  const [pollError,    setPollError   ] = useState('')
  // Initialized from storage (auto-captured ?ref= link), but this is now
  // real state — not just a read at render time — so a code typed by hand
  // in FixBanner's entry field (see handleApplyReferralCode below) updates
  // the price shown immediately, not just on next page load.
  const [referralCode, setReferralCode] = useState(getStoredReferralCode())
  const pollRef     = useRef(null)
  // Plain ref, not state — fetchScan is captured once by the poller
  // created in the mount effect below, so a `scan` state read inside it would
  // always see the stale value from that render. This needs to reflect
  // "have we EVER gotten a successful response", checked live, across every
  // tick of that same long-lived interval closure.
  const hasLoadedRef = useRef(false)

  async function fetchScan() {
    try {
      const url    = `/scan/${id}${anonToken ? `?token=${anonToken}` : ''}`
      const res    = await api.get(url)
      const data   = res.data.data
      hasLoadedRef.current = true
      setScan(data)
      setLoading(false)
      setPollError('')
      if (POLLING_STOP.includes(data.status)) {
        pollRef.current?.stop()
      }
      return true
    } catch (err) {
      const status = err.response?.status
      // Only stop polling for errors that genuinely mean "this will never
      // succeed" — not found, or access revoked/denied.
      const terminal = status === 404 || status === 403 || status === 401
      if (terminal) {
        pollRef.current?.stop()
        setLoading(false)
        return
      }
      // FIX: previously ANY error here — including a 429 — cleared the poll
      // interval outright. This app's own status-polling loop (every 2.5s)
      // can trip the general API rate limiter on its own during a slow fix
      // generation (retries + a real PDF render can run past the window),
      // and the UI would then silently freeze on "Generating your fixed
      // resume…" forever with zero indication anything had gone wrong.
      // Transient failures (429, network blips, 5xx) now just surface a
      // small non-blocking notice and keep polling instead.
      setPollError(
        status === 429
          ? "Checking status is temporarily rate-limited — we'll keep trying automatically."
          : "Having trouble checking status — retrying automatically…"
      )
      // Don't drop into the loading-spinner-forever state OR the "Scan not
      // found" branch (that's for real 404/403s) if this was a transient
      // failure on the very first fetch — just let the next poll tick try
      // again while the initial spinner stays up.
      if (hasLoadedRef.current) {
        setLoading(false)
      }
      return false   // tells the poller this tick failed -> it backs off instead of hammering
    }
  }

  // (Re)starts status polling after an action that moves the scan back into a
  // non-terminal state. Callers have just fetched, so don't tick immediately.
  function restartPolling() {
    pollRef.current?.stop()
    pollRef.current = createPoller(fetchScan)
    pollRef.current.start({ immediate: false })
  }

  async function handleRetryFix() {
    setRetryError('')
    setRetryLoading(true)
    try {
      await api.post(`/scan/${id}/retry-fix`)
      // Status just went back to FIX_GENERATING server-side, but polling
      // already stopped once FIX_DELIVERED was reached (POLLING_STOP) —
      // has to be explicitly restarted, not just re-fetched once.
      await fetchScan()
      restartPolling()
    } catch (err) {
      setRetryError(getErrorMessage(err, 'Could not start a retry — try again in a moment.'))
    }
    setRetryLoading(false)
  }

  useEffect(() => {
    pollRef.current = createPoller(fetchScan)
    pollRef.current.start()              // first tick runs immediately
    return () => pollRef.current?.stop()
  }, [id])

  // Storage stays the source of truth ACROSS page loads/navigation;
  // this state is the source of truth WITHIN this page's lifetime, so a
  // manually-typed code (FixBanner's entry field) is reflected instantly
  // without needing a reload to re-read storage.
  function handleApplyReferralCode(code) {
    setStoredReferralCode(code)
    setReferralCode(getStoredReferralCode())  // re-read: normalizes casing/trim, empty string if cleared
  }

  async function handlePay(fixTier) {
    if (!user) return navigate(`/register`)
    // Re-entrancy guard — belt-and-suspenders alongside the buttons now
    // being disabled while payLoading is true (see FixBanner). Without
    // this, a click that lands between render and the disabled state
    // taking effect could still double-fire.
    if (payLoading) return
    setPayLoading(true); setPayingTier(fixTier); setPayError('')
    try {
      const res = await api.post('/payments/initialize', {
        scanId: id, fixTier, referralCode: referralCode || undefined
      })
      const { access_code, reference } = res.data.data

      const popup = new PaystackPop()
      popup.resumeTransaction(access_code, {
        onSuccess: async () => {
          try {
            // Same verify endpoint the old redirect-based flow used — just
            // called directly here instead of via a callback_url redirect.
            // The webhook (webhooks.controller.js) still fires independently
            // as a redundant confirmation path either way.
            await api.get(`/payments/verify?reference=${reference}`)
          } catch (_) {
            // Swallow — the webhook will still confirm this independently
            // even if this specific client-side call fails (e.g. the tab
            // closing right after payment). Not worth blocking on.
          }
          // Status just moved past COMPLETE_PASS/COMPLETE_FAIL, which are
          // in POLLING_STOP — no page reload here (unlike the old redirect
          // flow) to naturally restart polling, so it has to be explicit.
          await fetchScan()
          restartPolling()
          setPayLoading(false); setPayingTier(null)
        },
        onCancel: () => { setPayLoading(false); setPayingTier(null) },
        onError: () => {
          setPayError('Payment failed. Please try again.')
          setPayLoading(false); setPayingTier(null)
        }
      })
    } catch (err) {
      setPayError(getErrorMessage(err, 'Payment failed to initialize.'))
      setPayLoading(false); setPayingTier(null)
    }
  }

  async function handleRedeemCredit() {
    if (!user) return navigate(`/register`)
    if (payLoading) return
    setPayLoading(true); setPayError('')
    try {
      await api.post(`/scan/${id}/redeem-credit`)
      // Unlike handlePay, there's no Paystack redirect/page-reload to
      // naturally restart polling — COMPLETE_PASS/COMPLETE_FAIL are in
      // POLLING_STOP, so it already stopped by the time this button was
      // even visible. Has to be explicitly restarted, same as handleRetryFix.
      await fetchScan()
      restartPolling()
      refreshUser()  // freeFixCredits just decremented server-side
    } catch (err) {
      setPayError(getErrorMessage(err, 'Could not redeem credit.'))
    }
    setPayLoading(false)
  }

  async function handleToggleExposure(stateField, apiField, value) {
    setVisibilityError('')
    // Optimistic update — toggles feel bad with a round-trip lag, and this
    // is a low-stakes, easily-reversible action.
    setScan(prev => ({ ...prev, [stateField]: value }))
    try {
      await api.patch(`/scan/${id}/verify-visibility`, { [apiField]: value })
    } catch (err) {
      setScan(prev => ({ ...prev, [stateField]: !value }))  // revert on failure
      setVisibilityError(getErrorMessage(err, 'Could not update visibility.'))
    }
  }

  async function handleDownload(type) {
    setDlError('')
    try {
      const res = await api.get(`/scan/${id}/download?type=${type}`, { responseType: 'blob' })
      downloadBlob(res.data, type === 'ats' ? 'resume-ats.docx' : 'resume-verified.pdf')
    } catch (err) {
      // With responseType: 'blob', axios would normally hand back error bodies
      // as an unparsed Blob (see normalizeBlobError in lib/errors.js) instead
      // of the JSON the server actually sent. That's already fixed centrally:
      // the shared axios instance in lib/api.js runs every failed response
      // through normalizeBlobError before it reaches here, so err.response.data
      // is a plain object by the time this catch block sees it.
      const data = err.response?.data
      if (data?.code === 'EMAIL_NOT_VERIFIED') {
        setDlError('Please verify your email before downloading. Check your inbox.')
      } else {
        setDlError(data?.message || 'Download failed.')
      }
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col bg-gray-50">
        <Navbar />
        <main className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <Spinner size="lg" className="mx-auto mb-4" />
            <p className="text-gray-500 text-sm">Loading scan…</p>
            {pollError && (
              <p className="text-xs text-amber-600 mt-2">{pollError}</p>
            )}
          </div>
        </main>
        <Footer />
      </div>
    )
  }

  if (!scan) {
    return (
      <div className="min-h-screen flex flex-col bg-gray-50">
        <Navbar />
        <main className="flex-1 flex items-center justify-center px-4">
          <div className="text-center">
            <p className="text-gray-600 mb-4">Scan not found or access denied.</p>
            <Link to="/" className="text-blue-600 hover:underline text-sm">Start a new scan</Link>
          </div>
        </main>
        <Footer />
      </div>
    )
  }

  // Explicit allowlist rather than a negation against another list — the
  // previous double-negative (!TERMINAL.includes(...)) was exactly the kind
  // of indirection that let FIX_GENERATING's dual meaning slip through
  // unnoticed. PENDING/SCANNING are the only states with no results yet.
  const scanning = ['PENDING', 'SCANNING'].includes(scan.status)

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <Navbar />
      <main className="max-w-3xl mx-auto px-4 py-10 w-full">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">
            {scan.resumeOriginalName || (
              scan.inputMode === 'brain_dump'   ? 'Resume from scratch' :
              scan.inputMode === 'saved_profile' ? 'Resume from saved profile' :
              'Resume scan'
            )}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {formatDate(scan.createdAt)} · {statusLabel(scan.status)}
          </p>
        </div>

        {/* Scanning state */}
        {scanning && (
          <div className="bg-white rounded-xl border border-gray-200 p-10 text-center shadow-sm">
            <Spinner size="lg" className="mx-auto mb-4" />
            <p className="font-medium text-gray-700">Scanning your resume…</p>
            <p className="text-sm text-gray-400 mt-1">This takes about 30 seconds</p>
            {pollError && (
              <p className="text-xs text-amber-600 mt-2">{pollError}</p>
            )}
          </div>
        )}

        {/* Error state */}
        {scan.status === 'ERROR' && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-center">
            <p className="font-medium text-red-800 mb-1">Scan failed</p>
            <p className="text-sm text-red-600">
              {scan.inputMode === 'brain_dump'
                ? "We couldn't structure your background. Try adding more detail — company names, roles, and what you did."
                : "We couldn't parse your resume. Try uploading a text-based PDF or .docx."}
            </p>
            <Link to="/" className="mt-4 inline-block text-sm text-blue-600 hover:underline">Try again</Link>
          </div>
        )}

        {/* Results */}
        {RESULTS_READY.includes(scan.status) && (
          <div className="flex flex-col gap-6">
            {/* Score card */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 sm:p-8">
              <div className="flex flex-col sm:flex-row items-center gap-8">
                <ScoreGauge score={scan.atsScore} passed={scan.passed} />
                <div className="flex-1 w-full">
                  <h2 className="text-lg font-semibold text-gray-900 mb-4">
                    {scan.passed ? 'Your resume passed ATS screening' : 'Your resume is failing ATS filters'}
                  </h2>
                  <CategoryScores scan={scan} />
                </div>
              </div>
            </div>

            {/* FEATURE (feature gap — Scan/ATS section audit): see
                AtsDetailPanel.jsx for the full reasoning. Placed right after
                the score card and before the resume editor below — explains
                the number the person just saw before offering to let them
                act on it. */}
            <AtsDetailPanel scan={scan} />

            {/* AUDIT FIX (feature gap — section audit "generate a resume from
                scratch"): previously nothing on this page ever showed a
                brain-dump/saved-profile user what was actually extracted
                from their text, and there was no way to correct it or get a
                free copy of it — see ResumeDataEditor.jsx for the full
                reasoning. Scoped to before a fix is purchased: once a fix
                exists, retryFix's feedback loop is the intended way to
                iterate, and the backend endpoints this drives
                (resume-data / download-draft) enforce the same gate. */}
            {['brain_dump', 'saved_profile'].includes(scan.inputMode) &&
              scan.originalResumeData && !scan.fixPurchased &&
              ['COMPLETE_PASS', 'COMPLETE_FAIL'].includes(scan.status) && (
                <ResumeDataEditor
                  scan={scan}
                  anonToken={anonToken}
                  onUpdated={updated => setScan(prev => ({ ...prev, ...updated }))}
                />
            )}

            {/* Fix generating */}
            {['FIX_PURCHASED', 'FIX_GENERATING'].includes(scan.status) && (
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-6 flex items-center gap-4">
                <Spinner className="shrink-0" />
                <div>
                  <p className="font-medium text-blue-900">
                    {scan.fixTier === 'BADGE'
                      ? 'Verifying and formatting your resume…'
                      : 'Generating your fixed resume…'}
                  </p>
                  <p className="text-sm text-blue-700 mt-0.5">We'll email you when it's ready. Usually under 2 minutes.</p>
                  {pollError && (
                    <p className="text-xs text-amber-600 mt-1">{pollError}</p>
                  )}
                </div>
              </div>
            )}

            {/* Delivered */}
            {scan.status === 'FIX_DELIVERED' && (
              <div className={`border rounded-xl p-6 ${scan.fixAtsScore >= ATS_BADGE_THRESHOLD ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-200'}`}>
                {scan.fixAtsScore >= ATS_BADGE_THRESHOLD ? (
                  <>
                    <p className="font-semibold text-green-900 mb-1">
                      {scan.fixTier === 'FIX_PLAIN'
                        ? '✓ Your fixed resume is ready'
                        : '✓ Your Passthrough Verified resume is ready'}
                    </p>
                    {scan.fixTier === 'BADGE' && (
                      <p className="text-sm text-green-800 mb-1">
                        Your score was already {ATS_BADGE_THRESHOLD}+, so nothing was rewritten — this verifies and formats your existing content as a Passthrough Verified document.
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <p className="font-semibold text-amber-900 mb-1">Your improved resume is ready</p>
                    <p className="text-sm text-amber-800 mb-3">
                      New ATS score: {scan.fixAtsScore ?? '—'}/100{scan.fixTier === 'FIX_PLAIN'
                        ? ` — below our target score of ${ATS_BADGE_THRESHOLD}.`
                        : ` — below the ${ATS_BADGE_THRESHOLD}+ threshold for Passthrough Verified status.`}
                      {scan.quantificationPrompts?.length > 0 && ' Adding the numbers/metrics suggested below would likely push this higher.'}
                    </p>
                    {scan.fixRetryCount < MAX_FIX_RETRIES ? (
                      <div className="mb-3">
                        {retryError && (
                          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2 mb-2">
                            {retryError}
                          </p>
                        )}
                        <Button onClick={handleRetryFix} loading={retryLoading} variant="secondary">
                          Try Again — Free ({MAX_FIX_RETRIES - scan.fixRetryCount} left)
                        </Button>
                      </div>
                    ) : (
                      <p className="text-sm text-amber-800 mb-3">
                        We tried a few times but couldn't get this one past {ATS_BADGE_THRESHOLD}. We've added a free fix credit to your
                        account for your next resume — no charge next time.
                      </p>
                    )}
                  </>
                )}
                {scan.fixAtsScore >= ATS_BADGE_THRESHOLD && scan.verificationUrl && (
                  <p className="text-sm text-green-800 mb-4">
                    Verification URL:{' '}
                    <a href={scan.verificationUrl} target="_blank" rel="noreferrer"
                      className="underline break-all">
                      {scan.verificationUrl}
                    </a>
                    {typeof scan.verificationViews === 'number' && scan.verificationViews > 0 && (
                      <span className="text-green-700">
                        {' '}— viewed {scan.verificationViews} time{scan.verificationViews === 1 ? '' : 's'}
                      </span>
                    )}
                  </p>
                )}
                {dlError && (
                  <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2 mb-3">
                    {dlError}
                  </p>
                )}
                <div className="flex flex-col sm:flex-row gap-3">
                  <Button onClick={() => handleDownload('ats')} variant="secondary">
                    Download .docx (ATS)
                  </Button>
                  <Button onClick={() => handleDownload('pdf')}>
                    Download PDF (beautiful)
                  </Button>
                </div>

                {/* Public document visibility — off by default (see
                    0007_verify_document_visibility.sql). The verification
                    page always shows the score; these two toggles
                    separately control whether the actual files are
                    downloadable from that same public page, e.g. so an
                    employer can get a clean, malware-free copy via the link
                    instead of an email attachment. */}
                {scan.verificationUrl && (
                  <div className="mt-4 pt-4 border-t border-green-200">
                    <p className="text-xs font-medium text-green-900 mb-2">
                      Let anyone with your verification link also download the file itself
                    </p>
                    {visibilityError && (
                      <p className="text-xs text-red-600 mb-2">{visibilityError}</p>
                    )}
                    <div className="flex flex-col gap-2">
                      <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={!!scan.verifyExposeDocx}
                          onChange={e => handleToggleExposure('verifyExposeDocx', 'exposeDocx', e.target.checked)}
                          className="rounded border-gray-300"
                        />
                        Allow public .docx download
                      </label>
                      <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={!!scan.verifyExposePdf}
                          onChange={e => handleToggleExposure('verifyExposePdf', 'exposePdf', e.target.checked)}
                          className="rounded border-gray-300"
                        />
                        Allow public PDF download
                      </label>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Diff view — only meaningful once a fix/badge has been delivered */}
            {scan.status === 'FIX_DELIVERED' && (
              <DiffView
                originalResumeData={scan.originalResumeData}
                rewrittenResumeData={scan.rewrittenResumeData}
                fixTier={scan.fixTier}
              />
            )}

            {/* Quantification prompts — renders nothing if the array is empty/null,
                which is always true for badge-only purchases (no AI rewrite ran) */}
            {scan.status === 'FIX_DELIVERED' && (
              <QuantificationPrompts prompts={scan.quantificationPrompts} />
            )}

            {/* Save profile for reuse — logged-in users only (anonymous visitors
                have no account to save to), and only if there's structured data
                to actually save.
                BUG FIX (Section 6): this used to also require
                scan.status === 'FIX_DELIVERED', which is a real technical
                requirement for file-upload scans (structuring only happens
                during fix generation for that mode) but not for brain-dump
                or saved-profile-mode scans, where originalResumeData is
                already populated right after the free scan completes
                (runAtsScan, scan.controller.js). The backend's own
                POST /profile/save has no such status check — it only cares
                that originalResumeData exists — so the old gate was hiding
                this feature from every free-tier brain-dump/saved-profile
                user for no reason tied to the data actually being ready.
                Checking originalResumeData alone is the correct, mode-
                agnostic signal: it's simply never populated yet for a
                file-upload scan that hasn't had a fix generated. */}
            {user && scan.originalResumeData && (
              <SaveProfilePrompt scanId={scan.id} />
            )}

            {/* Fix banner — only when not yet purchased */}
            {!scan.fixPurchased && (
              <>
                {payError && (
                  <p className="text-sm text-red-600">{payError}</p>
                )}
                <FixBanner scan={scan} onPay={handlePay} onRedeemCredit={handleRedeemCredit} freeFixCredits={user?.freeFixCredits || 0} referralCode={referralCode} onApplyReferralCode={handleApplyReferralCode} payLoading={payLoading} payingTier={payingTier} />
              </>
            )}

            {/* Register nudge for anon users */}
            {!user && !scan.fixPurchased && (
              <div className="bg-gray-50 border border-gray-200 rounded-xl p-5 text-sm text-gray-600">
                <p className="font-medium text-gray-800 mb-1">Save your results</p>
                <p className="mb-3">Create a free account to keep your scan history and buy a fix.</p>
                <Link to="/register"
                  className="inline-block bg-blue-700 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-800 transition-colors">
                  Create free account →
                </Link>
              </div>
            )}
          </div>
        )}
      </main>
      <Footer />
    </div>
  )
}
