import { useEffect, useState, useRef } from 'react'
import { useParams, useSearchParams, Link, useNavigate } from 'react-router-dom'
import api from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'
import ScoreGauge from '../components/scan/ScoreGauge'
import CategoryScores from '../components/scan/CategoryScores'
import FixBanner from '../components/scan/FixBanner'
import DiffView from '../components/scan/DiffView'
import QuantificationPrompts from '../components/scan/QuantificationPrompts'
import SaveProfilePrompt from '../components/scan/SaveProfilePrompt'
import Spinner from '../components/ui/Spinner'
import Button from '../components/ui/Button'
import { statusLabel, formatDate } from '../lib/utils'

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
const POLL_MS  = 2500

export default function ScanResult() {
  const { id }        = useParams()
  const [params]      = useSearchParams()
  const navigate      = useNavigate()
  const { user, refreshUser } = useAuth()
  const anonToken     = params.get('token') || localStorage.getItem('passthrough_anon_token')
  const [scan,        setScan      ] = useState(null)
  const [loading,     setLoading   ] = useState(true)
  const [payLoading,  setPayLoading] = useState(false)
  const [payError,    setPayError  ] = useState('')
  const [dlError,     setDlError   ] = useState('')
  const [retryLoading, setRetryLoading] = useState(false)
  const [retryError,   setRetryError  ] = useState('')
  const pollRef = useRef(null)

  async function fetchScan() {
    try {
      const url    = `/scan/${id}${anonToken ? `?token=${anonToken}` : ''}`
      const res    = await api.get(url)
      const data   = res.data.data
      setScan(data)
      setLoading(false)
      if (POLLING_STOP.includes(data.status)) {
        clearInterval(pollRef.current)
      }
    } catch (err) {
      setLoading(false)
      clearInterval(pollRef.current)
    }
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
      clearInterval(pollRef.current)
      pollRef.current = setInterval(fetchScan, POLL_MS)
    } catch (err) {
      setRetryError(err.response?.data?.message || 'Could not start a retry — try again in a moment.')
    }
    setRetryLoading(false)
  }

  useEffect(() => {
    fetchScan()
    pollRef.current = setInterval(fetchScan, POLL_MS)
    return () => clearInterval(pollRef.current)
  }, [id])

  async function handlePay(fixTier) {
    if (!user) return navigate(`/register`)
    setPayLoading(true); setPayError('')
    try {
      const res = await api.post('/payments/initialize', { scanId: id, fixTier })
      window.location.href = res.data.data.authorization_url
    } catch (err) {
      setPayError(err.response?.data?.message || 'Payment failed to initialize.')
      setPayLoading(false)
    }
  }

  async function handleRedeemCredit() {
    if (!user) return navigate(`/register`)
    setPayLoading(true); setPayError('')
    try {
      await api.post(`/scan/${id}/redeem-credit`)
      // Unlike handlePay, there's no Paystack redirect/page-reload to
      // naturally restart polling — COMPLETE_PASS/COMPLETE_FAIL are in
      // POLLING_STOP, so it already stopped by the time this button was
      // even visible. Has to be explicitly restarted, same as handleRetryFix.
      await fetchScan()
      clearInterval(pollRef.current)
      pollRef.current = setInterval(fetchScan, POLL_MS)
      refreshUser()  // freeFixCredits just decremented server-side
    } catch (err) {
      setPayError(err.response?.data?.message || 'Could not redeem credit.')
    }
    setPayLoading(false)
  }

  async function handleDownload(type) {
    setDlError('')
    try {
      const res = await api.get(`/scan/${id}/download?type=${type}`, { responseType: 'blob' })
      const url = URL.createObjectURL(res.data)
      const a   = document.createElement('a')
      a.href    = url
      a.download = type === 'ats' ? 'resume-ats.docx' : 'resume-verified.pdf'
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      // With responseType: 'blob', axios applies that same responseType to
      // ERROR responses too — err.response.data is a Blob, not parsed JSON,
      // even though the server sent a normal JSON error body. Reading
      // err.response.data.code directly always returns undefined here,
      // which silently masked the EMAIL_NOT_VERIFIED case behind the
      // generic "Download failed." message. Parse the Blob's text instead.
      let code, message
      const data = err.response?.data
      if (data instanceof Blob) {
        try {
          const parsed = JSON.parse(await data.text())
          code = parsed.code
          message = parsed.message
        } catch (_) { /* not JSON — fall through to generic message */ }
      } else {
        code = data?.code
        message = data?.message
      }
      if (code === 'EMAIL_NOT_VERIFIED') {
        setDlError('Please verify your email before downloading. Check your inbox.')
      } else {
        setDlError(message || 'Download failed.')
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
                <ScoreGauge score={scan.atsScore} />
                <div className="flex-1 w-full">
                  <h2 className="text-lg font-semibold text-gray-900 mb-4">
                    {scan.passed ? 'Your resume passed ATS screening' : 'Your resume is failing ATS filters'}
                  </h2>
                  <CategoryScores scan={scan} />
                </div>
              </div>
            </div>

            {/* Fix generating */}
            {['FIX_PURCHASED', 'FIX_GENERATING'].includes(scan.status) && (
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-6 flex items-center gap-4">
                <Spinner className="shrink-0" />
                <div>
                  <p className="font-medium text-blue-900">Generating your fixed resume…</p>
                  <p className="text-sm text-blue-700 mt-0.5">We'll email you when it's ready. Usually under 2 minutes.</p>
                </div>
              </div>
            )}

            {/* Delivered */}
            {scan.status === 'FIX_DELIVERED' && (
              <div className={`border rounded-xl p-6 ${scan.fixAtsScore >= 80 ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-200'}`}>
                {scan.fixAtsScore >= 80 ? (
                  <p className="font-semibold text-green-900 mb-1">✓ Your Passthrough Verified resume is ready</p>
                ) : (
                  <>
                    <p className="font-semibold text-amber-900 mb-1">Your improved resume is ready</p>
                    <p className="text-sm text-amber-800 mb-3">
                      New ATS score: {scan.fixAtsScore ?? '—'}/100 — below the 80+ threshold for Passthrough Verified status.
                      {scan.quantificationPrompts?.length > 0 && ' Adding the numbers/metrics suggested below would likely push this higher.'}
                    </p>
                    {scan.fixRetryCount < 2 ? (
                      <div className="mb-3">
                        {retryError && (
                          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2 mb-2">
                            {retryError}
                          </p>
                        )}
                        <Button onClick={handleRetryFix} loading={retryLoading} variant="secondary">
                          Try Again — Free ({2 - scan.fixRetryCount} left)
                        </Button>
                      </div>
                    ) : (
                      <p className="text-sm text-amber-800 mb-3">
                        We tried a few times but couldn't get this one past 80. We've added a free fix credit to your
                        account for your next resume — no charge next time.
                      </p>
                    )}
                  </>
                )}
                {scan.fixAtsScore >= 80 && scan.verificationUrl && (
                  <p className="text-sm text-green-800 mb-4">
                    Verification URL:{' '}
                    <a href={scan.verificationUrl} target="_blank" rel="noreferrer"
                      className="underline break-all">
                      {scan.verificationUrl}
                    </a>
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
                to actually save */}
            {scan.status === 'FIX_DELIVERED' && user && scan.originalResumeData && (
              <SaveProfilePrompt scanId={scan.id} />
            )}

            {/* Fix banner — only when not yet purchased */}
            {!scan.fixPurchased && (
              <>
                {payError && (
                  <p className="text-sm text-red-600">{payError}</p>
                )}
                <FixBanner scan={scan} onPay={handlePay} onRedeemCredit={handleRedeemCredit} freeFixCredits={user?.freeFixCredits || 0} />
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
