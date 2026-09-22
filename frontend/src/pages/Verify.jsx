import { useEffect, useState, useRef } from 'react'
import { useParams } from 'react-router-dom'
import api, { getErrorMessage } from '../lib/api'
import Button from '../components/ui/Button'
import Input from '../components/ui/Input'
import Spinner from '../components/ui/Spinner'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'
import { formatDate, copyToClipboard } from '../lib/utils'
import { ATS_BADGE_THRESHOLD } from '../lib/scoreThresholds'
import { sha256Hex, classifyFingerprint } from '../lib/fileFingerprint'

// FEATURE GAP CLOSED (Section 5): the "role you're hiring for" field used
// to always start blank, even though this page already fetches and shows
// data.roleCategory for the exact candidate being viewed — asking a hiring
// manager to retype what's already on the screen was pure friction.
function humanizeRoleCategory(cat) {
  if (!cat) return ''
  return cat.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, ch => ch.toUpperCase())
}

// Downloads used window.location.href — on a 403/404 that just navigates the
// whole tab to raw JSON. Fetches as a blob so a failure surfaces on the page
// instead of blanking it, and only ever triggers a save on a real success.
async function downloadFile(code, type, filename) {
  const res = await api.get(`/verify/${code}/download`, { params: { type }, responseType: 'blob' })
  const url = URL.createObjectURL(res.data)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function Verify() {
  const { code } = useParams()
  const [data,    setData   ] = useState(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [revoked,  setRevoked ] = useState(null)   // { revokedAt } | null
  // Generic failure state — separate from notFound. The old version only
  // ever branched on a 404; anything else (500, timeout, offline) left
  // loading/notFound/data all falsy, so the page silently rendered nothing
  // but the Navbar/Footer with no explanation and no way to retry.
  const [loadError, setLoadError] = useState(false)
  const [downloadErr, setDownloadErr] = useState('')

  // Hiring manager soft opt-in
  const [hmExpanded,  setHmExpanded ] = useState(false)
  const [name,        setName       ] = useState('')
  const [company,     setCompany    ] = useState('')
  const [role,        setRole       ] = useState('')
  const [email,       setEmail      ] = useState('')
  const [leadSent,    setLeadSent   ] = useState(false)
  const [leadErr,     setLeadErr    ] = useState('')
  const [leadLoading, setLeadLoading] = useState(false)

  const [linkCopied, setLinkCopied] = useState(false)

  // SECTION 7 AUDIT (feature gap G7-1): let the READER check the actual file
  // they were sent, in their own browser — nothing is uploaded. This is the
  // only check that can ever catch a candidate's edited copy; the server-side
  // integrity badge above can only compare our own stored copy against itself.
  const [checking, setChecking] = useState(false)
  const [checkResult, setCheckResult] = useState(null)   // 'current' | 'previous' | 'mismatch' | 'unavailable' | 'error'
  const fileInputRef = useRef(null)

  // SECTION 7 AUDIT (bug): this used to reset only the status flags
  // (notFound/loadError/revoked), never `data` itself. Nothing in this app
  // currently links between two different /v/:code pages without a full
  // page reload, so it was unreachable in practice — but the `code` dependency
  // on the effect below exists specifically so this component CAN be reused
  // across codes, and the moment anything ever does that (a "next candidate"
  // link, browser back/forward within the SPA), a failed or in-flight refetch
  // would leave the PREVIOUS candidate's full card — score, name, download
  // links — rendered underneath a "Verification not found" / revoked message
  // for the code actually in the URL. `data && (...)` and `notFound && (...)`
  // etc. are independent conditions, not mutually exclusive branches, so
  // both rendered at once. Clearing every piece of per-candidate state
  // (including the hiring-manager lead form, which is scoped to whichever
  // candidate the visitor thinks they're looking at) closes that.
  function load() {
    setLoading(true); setNotFound(false); setLoadError(false); setRevoked(null); setData(null)
    setDownloadErr(''); setCheckResult(null)
    setHmExpanded(false); setName(''); setCompany(''); setRole(''); setEmail('')
    setLeadSent(false); setLeadErr('')
    api.get(`/verify/${code}`)
      .then(res => {
        setData(res.data.data)
        setLoading(false)
        setRole(humanizeRoleCategory(res.data.data.roleCategory))
      })
      .catch(err => {
        setLoading(false)
        const status = err.response?.status
        if (status === 404) setNotFound(true)
        else if (status === 410) setRevoked({ revokedAt: err.response?.data?.revokedAt || null })
        else setLoadError(true)
      })
  }

  useEffect(() => { load() }, [code])

  async function handleLead() {
    if (!name || !company || !email) return setLeadErr('Name, company, and email required.')
    setLeadLoading(true); setLeadErr('')
    try {
      await api.post('/employer-leads', {
        name,
        company,
        email,
        roleCategory: role || undefined,
        source: 'verification_page',
        // SECTION 7 AUDIT (feature gap): which candidate's page this lead came
        // from, so the admin list isn't just an undifferentiated pile.
        verificationCode: code
      })
      setLeadSent(true)
    } catch (err) {
      setLeadErr(getErrorMessage(err, 'Something went wrong.'))
    } finally {
      setLeadLoading(false)
    }
  }

  async function handleCopyLink() {
    // copyToClipboard reports failure (insecure context, denied permission);
    // only claim "copied" when it actually was.
    if (await copyToClipboard(window.location.href)) {
      setLinkCopied(true)
      setTimeout(() => setLinkCopied(false), 2000)
    }
  }

  async function handleDownload(type) {
    setDownloadErr('')
    try {
      await downloadFile(code, type, `Passthrough-${code}.${type}`)
    } catch (err) {
      setDownloadErr(getErrorMessage(err, 'Could not download that file — please try again.'))
    }
  }

  async function handleCheckFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setChecking(true); setCheckResult(null)
    try {
      const hash = await sha256Hex(file)
      setCheckResult(classifyFingerprint(hash, data?.fingerprints))
    } catch (_) {
      setCheckResult('error')
    } finally {
      setChecking(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // SECTION 7 AUDIT (bug B7-1): the headline must reflect BOTH the score and
  // the integrity check — `data.passed` alone kept a green "Verified" up even
  // when the file didn't match its own hash. `data.verified` is the one flag
  // this page is allowed to key its headline off.
  const isVerified = !!data?.verified

  const integrityLabel =
    data?.integrityStatus === 'verified' ? 'Unmodified' :
    data?.integrityStatus === 'modified' ? 'Modified'   :
    'Unavailable'
  const integrityClass =
    data?.integrityStatus === 'verified' ? 'text-green-700' :
    data?.integrityStatus === 'modified' ? 'text-red-600'   :
    'text-amber-600'

  const checkLabel = {
    current:     { text: 'Matches — this is the current, unmodified file.', cls: 'text-green-700' },
    previous:    { text: 'Matches an earlier version — not the current one, but not tampered with either.', cls: 'text-amber-600' },
    mismatch:    { text: "Doesn't match anything on file — this file has been edited, or didn't come from Passthrough.", cls: 'text-red-600' },
    unavailable: { text: 'This scan has no fingerprints to check against.', cls: 'text-gray-500' },
    error:       { text: "Couldn't check that file — please try again.", cls: 'text-gray-500' },
  }[checkResult]

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <Navbar />
      <main className="max-w-2xl mx-auto px-4 py-12 w-full">
        {loading && (
          <div className="flex justify-center py-20">
            <Spinner size="lg" />
          </div>
        )}

        {notFound && (
          <div className="text-center py-20">
            <p className="text-gray-600">Verification not found.</p>
          </div>
        )}

        {revoked && (
          <div className="text-center py-20">
            <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-4">
              <span className="text-gray-500 text-3xl">⊘</span>
            </div>
            <h1 className="text-xl font-bold text-gray-900 mb-2">This verification has been revoked</h1>
            <p className="text-gray-500 text-sm">
              {revoked.revokedAt ? `Revoked on ${formatDate(revoked.revokedAt)}. ` : ''}
              It is no longer valid and cannot be restored from this page.
            </p>
          </div>
        )}

        {loadError && (
          <div className="text-center py-20">
            <p className="text-gray-600 mb-4">
              Something went wrong loading this verification page.
            </p>
            <Button variant="secondary" onClick={load}>Try again</Button>
          </div>
        )}

        {data && (
          <div className="flex flex-col gap-6">
            {/* Verification card */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-8 text-center">
              {isVerified ? (
                <>
                  <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
                    <span className="text-green-600 text-3xl">✓</span>
                  </div>
                  <h1 className="text-2xl font-bold text-gray-900 mb-1">
                    Passthrough Verified
                  </h1>
                </>
              ) : (
                <>
                  <div className="w-16 h-16 rounded-full bg-amber-100 flex items-center justify-center mx-auto mb-4">
                    <span className="text-amber-600 text-3xl">○</span>
                  </div>
                  <h1 className="text-2xl font-bold text-gray-900 mb-1">
                    Passthrough Scan Report
                  </h1>
                  <p className="text-sm text-amber-700 mb-1">
                    {data.passed
                      ? 'This file no longer matches what was verified — see Integrity below.'
                      : `Below the Passthrough Verified threshold (${ATS_BADGE_THRESHOLD}+)`}
                  </p>
                </>
              )}
              {data.candidateFirstName && (
                <p className="text-gray-500 text-lg mb-4">{data.candidateFirstName}</p>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 mt-6 text-sm">
                <div className="bg-gray-50 rounded-lg p-3">
                  <p className="text-gray-400 text-xs mb-1">ATS Score</p>
                  <p className={`font-bold text-xl ${data.passed ? 'text-green-700' : 'text-red-600'}`}>
                    {data.atsScore}
                  </p>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <p className="text-gray-400 text-xs mb-1">Integrity</p>
                  <p className={`font-bold text-sm ${integrityClass}`}>
                    {integrityLabel}
                  </p>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <p className="text-gray-400 text-xs mb-1">Field</p>
                  <p className="font-semibold text-gray-700 capitalize text-sm">
                    {data.roleCategory?.replace(/_/g, ' ') || '—'}
                  </p>
                </div>
                {/* SECTION 7 AUDIT (feature gap): seniorityLevel has always been
                    computed (atsService.detectSeniority) and returned by
                    GET /api/verify/:code — nothing ever rendered it. */}
                <div className="bg-gray-50 rounded-lg p-3">
                  <p className="text-gray-400 text-xs mb-1">Seniority</p>
                  <p className="font-semibold text-gray-700 capitalize text-sm">
                    {data.seniorityLevel || '—'}
                  </p>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <p className="text-gray-400 text-xs mb-1">Verified</p>
                  <p className="font-semibold text-gray-700 text-sm">{formatDate(data.verifiedAt)}</p>
                </div>
              </div>

              {(data.exposeDocx || data.exposePdf) && (
                <div className="flex flex-col sm:flex-row gap-3 mt-6 justify-center">
                  {data.exposeDocx && (
                    <Button variant="secondary" onClick={() => handleDownload('docx')}>
                      Download .docx
                    </Button>
                  )}
                  {data.exposePdf && (
                    <Button onClick={() => handleDownload('pdf')}>
                      View / Download PDF
                    </Button>
                  )}
                </div>
              )}
              {downloadErr && <p className="text-xs text-red-600 mt-3">{downloadErr}</p>}
              <p className="text-xs text-gray-400 mt-6">
                {isVerified
                  ? "This resume was scanned by Passthrough's ATS engine and has not been modified since verification."
                  : "This resume was scanned by Passthrough's ATS engine. It did not reach (or no longer meets) the standard required for Passthrough Verified status."}
              </p>
              <div className="flex items-center justify-center gap-3 mt-4">
                {typeof data.verificationViews === 'number' && (
                  <p className="text-xs text-gray-400">
                    Viewed {data.verificationViews} time{data.verificationViews === 1 ? '' : 's'}
                  </p>
                )}
                <button
                  onClick={handleCopyLink}
                  className="text-xs font-medium text-blue-700 hover:text-blue-800 underline underline-offset-2 transition-colors"
                >
                  {linkCopied ? 'Link copied' : 'Copy link'}
                </button>
              </div>
            </div>

            {/* Integrity check explainer */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
                  <span className="text-blue-700 text-lg">🔒</span>
                </div>
                <div>
                  <h2 className="font-semibold text-gray-900 mb-1">
                    Cryptographically verified — not just a badge
                  </h2>
                  <p className="text-sm text-gray-500 leading-relaxed">
                    Most "resume checker" badges are just an image — nothing stops a
                    candidate from editing the file after the fact and keeping the badge.
                    Passthrough hashes the exact document at verification time and
                    re-checks our own stored copy against that hash every time this page loads. If our
                    copy has changed in any way, this page will say{' '}
                    <strong className="text-red-600">Modified</strong> instead of{' '}
                    <strong className="text-green-700">Unmodified</strong> — automatically,
                    with no way for the candidate to control it.
                    {data.integrityStatus === 'unknown' && (
                      <>
                        {' '}The check couldn't run just now, so this page is showing{' '}
                        <strong className="text-amber-600">Unavailable</strong> rather than
                        guessing — refresh in a moment to re-check.
                      </>
                    )}
                  </p>
                </div>
              </div>
            </div>

            {/* SECTION 7 AUDIT (feature gap): check the file YOU were sent, not
                just our stored copy — this is the only check that can catch a
                candidate's edited copy. Runs entirely in your browser. */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
              <h2 className="font-semibold text-gray-900 mb-1">Received a file from this candidate?</h2>
              <p className="text-sm text-gray-500 mb-3">
                Check whether the .docx or .pdf you were sent matches what's on file. This
                happens entirely in your browser — the file is never uploaded anywhere.
              </p>
              <div className="flex items-center gap-3 flex-wrap">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  onChange={handleCheckFile}
                  className="text-sm text-gray-600 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-blue-50 file:text-blue-700 file:text-sm file:font-medium hover:file:bg-blue-100"
                />
                {checking && <Spinner size="sm" />}
              </div>
              {checkLabel && (
                <p className={`text-sm font-medium mt-3 ${checkLabel.cls}`}>{checkLabel.text}</p>
              )}
            </div>

            {/* Hiring manager soft opt-in — shown above the full form */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
              {leadSent ? (
                <p className="text-sm text-green-700 font-medium">
                  You're on the list.
                </p>
              ) : !hmExpanded ? (
                /* Collapsed trigger */
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <p className="text-sm text-gray-500">Are you a hiring manager?</p>
                  <button
                    onClick={() => setHmExpanded(true)}
                    className="text-sm font-medium text-blue-700 hover:text-blue-800 underline underline-offset-2 transition-colors"
                  >
                    Get early access to Verified candidates →
                  </button>
                </div>
              ) : (
                /* Expanded form */
                <div className="flex flex-col gap-3">
                  <div>
                    <h2 className="font-semibold text-gray-900 mb-0.5">Get early access to Verified candidates</h2>
                    <p className="text-sm text-gray-500">We'll reach out when we have candidates matching your role.</p>
                  </div>
                  <Input
                    placeholder="Your name"
                    value={name}
                    onChange={e => setName(e.target.value)}
                  />
                  <Input
                    placeholder="Company"
                    value={company}
                    onChange={e => setCompany(e.target.value)}
                  />
                  <Input
                    placeholder="Role you're hiring for (e.g. Senior Engineer)"
                    value={role}
                    onChange={e => setRole(e.target.value)}
                  />
                  <Input
                    type="email"
                    placeholder="Work email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                  />
                  {leadErr && <p className="text-xs text-red-600">{leadErr}</p>}
                  <div className="flex gap-3">
                    <Button onClick={handleLead} loading={leadLoading}>
                      Get early access
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setHmExpanded(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
      <Footer />
    </div>
  )
}
