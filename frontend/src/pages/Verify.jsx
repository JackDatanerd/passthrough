import { useEffect, useState, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import api, { getErrorMessage } from '../lib/api'
import Button from '../components/ui/Button'
import Input from '../components/ui/Input'
import Spinner from '../components/ui/Spinner'
import Form from '../components/ui/Form'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'
import { formatDate, copyToClipboard } from '../lib/utils'
import { ATS_BADGE_THRESHOLD } from '../lib/scoreThresholds'
import { sha256Hex, classifyFingerprint, fileKindOf, MAX_CHECK_BYTES } from '../lib/fileFingerprint'
import { isRoleCategory } from '../lib/roleCategories'
import { RoleFields, LeadConsentNote } from '../components/lead/LeadFormParts'

const SUPPORT_EMAIL = 'support@passthrough.dev'

// ROUND-3 AUDIT (feature gap): a reader who suspects a page is fake, or a candidate whose page
// is wrong, had no way to say so from here. Prefills the code so the report needs no typing.
function reportHref(code, why) {
  const c = String(code || '').toUpperCase()
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`Passthrough verification ${c}: ${why}`)}` +
    `&body=${encodeURIComponent(`Verification page: ${typeof window !== 'undefined' ? window.location.href : c}\n\nWhat looks wrong:\n`)}`
}

function Fingerprint({ label, hash }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-gray-400 w-12 shrink-0">{label}</span>
      <code className="text-gray-600 break-all font-mono">{hash}</code>
      <button type="button"
        onClick={async () => { if (await copyToClipboard(hash)) { setCopied(true); setTimeout(() => setCopied(false), 1500) } }}
        className="text-blue-700 hover:text-blue-800 underline underline-offset-2 shrink-0">
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

// Downloads used window.location.href — on a 403/404 that just navigates the
// whole tab to raw JSON. Fetches as a blob so a failure surfaces on the page
// instead of blanking it, and only ever triggers a save on a real success.
async function downloadFile(code, type, filename) {
  const res = await api.get(`/verify/${encodeURIComponent(code)}/download`, { params: { type }, responseType: 'blob' })
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
  // ROUND-3 AUDIT (feature gap): the owner deleted this page (or their account) — say so, rather
  // than the "not found" that reads like a mistyped code on a printed resume.
  const [removed,  setRemoved ] = useState(false)
  // Generic failure state — separate from notFound. The old version only
  // ever branched on a 404; anything else (500, timeout, offline) left
  // loading/notFound/data all falsy, so the page silently rendered nothing
  // but the Navbar/Footer with no explanation and no way to retry.
  const [loadError, setLoadError] = useState(false)
  // ROUND-2 AUDIT: a rate-limited lookup (429) used to fall into the generic
  // "Something went wrong" — and the visitor had no idea to wait.
  const [rateLimited, setRateLimited] = useState(false)
  const [downloadErr, setDownloadErr] = useState('')

  // Hiring manager soft opt-in
  const [hmExpanded,  setHmExpanded ] = useState(false)
  const [name,        setName       ] = useState('')
  const [company,     setCompany    ] = useState('')
  const [role,        setRole       ] = useState('')   // taxonomy key ('' = not given)
  const [roleTitle,   setRoleTitle  ] = useState('')
  const [email,       setEmail      ] = useState('')
  const [leadSent,    setLeadSent   ] = useState(false)
  const [leadErr,     setLeadErr    ] = useState('')
  const [leadLoading, setLeadLoading] = useState(false)
  const [website,     setWebsite    ] = useState('')  // honeypot — real visitors never see or fill this

  const [linkCopied, setLinkCopied] = useState(false)

  // SECTION 7 AUDIT (feature gap G7-1): let the READER check the actual file
  // they were sent, in their own browser — nothing is uploaded. This is the
  // only check that can ever catch a candidate's edited copy; the server-side
  // integrity badge above can only compare our own stored copy against itself.
  const [checking, setChecking] = useState(false)
  // { status: 'current' | 'previous' | 'mismatch' | 'unavailable' | 'error', at, kind } | null
  const [checkResult, setCheckResult] = useState(null)
  const fileInputRef = useRef(null)
  // ROUND-2 AUDIT (bug): responses used to be applied in whatever order they
  // arrived, so a slow reply for an earlier code could overwrite the page for the
  // current one. Only the newest request may write state.
  const loadSeq = useRef(0)

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
    const seq = ++loadSeq.current
    setLoading(true); setNotFound(false); setLoadError(false); setRateLimited(false); setRevoked(null); setRemoved(false); setData(null)
    setDownloadErr(''); setCheckResult(null)
    setHmExpanded(false); setName(''); setCompany(''); setRole(''); setRoleTitle(''); setEmail(''); setWebsite('')
    setLeadSent(false); setLeadErr('')
    // encodeURIComponent: the code comes straight from the URL; never let it
    // add path segments or a query string to the API call.
    api.get(`/verify/${encodeURIComponent(code)}`)
      .then(res => {
        if (seq !== loadSeq.current) return
        setData(res.data.data)
        setLoading(false)
        // The reader is looking at this candidate, so their field is the most
        // likely answer — pre-selected, but a plain dropdown they can change.
        const cat = res.data.data.roleCategory
        setRole(isRoleCategory(cat) ? cat : '')
      })
      .catch(err => {
        if (seq !== loadSeq.current) return
        setLoading(false)
        const status = err.response?.status
        if (status === 404) setNotFound(true)
        else if (status === 410 && err.response?.data?.code === 'REMOVED') setRemoved(true)
        else if (status === 410) setRevoked({ revokedAt: err.response?.data?.revokedAt || null })
        else if (status === 429) setRateLimited(true)
        else setLoadError(true)
      })
  }

  useEffect(() => { load() }, [code])

  async function handleLead(e) {
    e?.preventDefault?.()
    if (!name || !company || !email) return setLeadErr('Name, company, and email required.')
    setLeadLoading(true); setLeadErr('')
    try {
      await api.post('/employer-leads', {
        name,
        company,
        email,
        roleCategory: role || undefined,
        roleTitle: roleTitle || undefined,
        source: 'verification_page',
        // SECTION 7 AUDIT (feature gap): which candidate's page this lead came
        // from, so the admin list isn't just an undifferentiated pile.
        verificationCode: code,
        website
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
      await downloadFile(code, type, `Passthrough-${String(code).toUpperCase()}.${type}`)
    } catch (err) {
      setDownloadErr(getErrorMessage(err, 'Could not download that file — please try again.'))
    }
  }

  async function handleCheckFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setChecking(true); setCheckResult(null)
    try {
      if (file.size > MAX_CHECK_BYTES) {
        setCheckResult({ status: 'toolarge', at: null, kind: null })
        return
      }
      const hash = await sha256Hex(file)
      setCheckResult(classifyFingerprint(hash, data?.fingerprints, fileKindOf(file)))
    } catch (_) {
      setCheckResult({ status: 'error', at: null, kind: null })
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

  // ROUND-2 AUDIT FIX (bug): "not verified" has THREE causes and this page used
  // to word all of them as "this file no longer matches" — including a transient
  // R2/network failure ('unknown'), which accused a candidate's file of being
  // altered when the check merely could not run. Now: modified → says so;
  // unknown → says the check couldn't complete; otherwise it is the score.
  const notChecked  = !!data && data.passed && data.integrityStatus === 'unknown'
  const isModified  = !!data && data.passed && data.integrityStatus === 'modified'
  // ROUND-3 AUDIT FIX (bug): a page with a PDF that was never fingerprinted (issued before PDF
  // fingerprinting existed) used to read "Unmodified". 'partial' = the Word file checks out,
  // the PDF cannot be checked — never a green tick.
  const isPartial   = !!data && data.passed && data.integrityStatus === 'partial'

  const integrityLabel =
    data?.integrityStatus === 'verified' ? 'Unmodified' :
    data?.integrityStatus === 'modified' ? 'Modified'   :
    data?.integrityStatus === 'partial'  ? 'Partly checked' :
    'Unavailable'
  const integrityClass =
    data?.integrityStatus === 'verified' ? 'text-green-700' :
    data?.integrityStatus === 'modified' ? 'text-red-600'   :
    'text-amber-600'

  // FEATURE GAP CLOSED: a 'previous' match now names WHEN that version was
  // superseded (classifyFingerprint carries the matched entry's `at` through)
  // instead of a flat "an earlier version" with no way to tell which one.
  //
  // FIX (Section 7 audit, gap): classifyFingerprint has always returned WHICH
  // file type matched (`kind: 'docx' | 'pdf'`) but this label never said so —
  // "an earlier version" left the reader unable to tell whether it was an old
  // .docx or an old .pdf that matched, which matters when they have both.
  const kindLabel = checkResult?.kind === 'pdf' ? 'PDF' : checkResult?.kind === 'docx' ? '.docx' : 'version'
  const checkLabel = checkResult && {
    current:     { text: 'Matches — this is the current, unmodified file.', cls: 'text-green-700' },
    previous:    {
      text: checkResult.at
        ? `Matches an earlier ${kindLabel}, current until ${formatDate(checkResult.at)} — not the current one, but not tampered with either.`
        : `Matches an earlier ${kindLabel} — not the current one, but not tampered with either.`,
      cls: 'text-amber-600',
    },
    mismatch:    { text: "Doesn't match anything on file — this file has been edited, or didn't come from Passthrough.", cls: 'text-red-600' },
    unavailable: {
      text: checkResult.scope === 'type'
        ? "This scan has no fingerprint on file for that type of file, so it can't be checked here."
        : 'This scan has no fingerprints to check against.',
      cls: 'text-gray-500',
    },
    toolarge:    { text: 'That file is too large to be a resume — pick the .docx or .pdf you were sent.', cls: 'text-gray-500' },
    error:       { text: "Couldn't check that file — please try again.", cls: 'text-gray-500' },
  }[checkResult.status]

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

        {removed && (
          <div className="text-center py-20">
            <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-4">
              <span className="text-gray-500 text-3xl">⊘</span>
            </div>
            <h1 className="text-xl font-bold text-gray-900 mb-2">This verification page was removed</h1>
            <p className="text-gray-500 text-sm">
              Its owner deleted it. This is not a mistyped link — the page existed, and is no longer available.
            </p>
            <p className="text-xs text-gray-400 mt-4">
              <a href={reportHref(code, 'removed page')} className="underline underline-offset-2 hover:text-gray-600">Report a problem</a>
            </p>
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
            <p className="text-xs text-gray-400 mt-4">
              <a href={reportHref(code, 'revoked page')} className="underline underline-offset-2 hover:text-gray-600">Report a problem</a>
            </p>
          </div>
        )}

        {rateLimited && (
          <div className="text-center py-20">
            <p className="text-gray-600 mb-4">
              Too many lookups from your network just now. Please wait a few minutes and try again.
            </p>
            <Button variant="secondary" onClick={load}>Try again</Button>
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
                    {isModified
                      ? 'This file no longer matches what was verified — see Integrity below.'
                      : isPartial
                        ? "The Word file checks out, but this page has no fingerprint for its PDF — see Integrity below."
                      : notChecked
                        ? "The integrity check couldn't complete just now — refresh in a moment to re-check."
                        : data.passed
                          ? 'Passthrough Verified status is not confirmed for this file — see Integrity below.'
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
                      Download PDF
                    </Button>
                  )}
                </div>
              )}
              {downloadErr && <p className="text-xs text-red-600 mt-3">{downloadErr}</p>}
              <p className="text-xs text-gray-400 mt-6">
                {isVerified
                  ? "This resume was scanned by Passthrough's ATS engine and has not been modified since verification."
                  : isModified
                    ? "This resume reached the Passthrough Verified score, but the stored file no longer matches its verified fingerprint."
                    : isPartial
                      ? "This resume reached the Passthrough Verified score and its Word file is unmodified, but its PDF predates PDF fingerprinting and cannot be checked — so this page does not show a full verification."
                    : notChecked
                      ? "This resume reached the Passthrough Verified score. Its integrity could not be re-checked just now — that is not a sign of tampering."
                      : "This resume was scanned by Passthrough's ATS engine. It did not reach the standard required for Passthrough Verified status."}
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

            {/* ROUND-3 AUDIT (feature gap): the fingerprints were in the JSON all along but the
                page never showed them — a reader who won't put a file into a browser tool could
                not compare anything by hand. `shasum -a 256 file` (or certutil on Windows) gives
                the same value. */}
            {(data.fingerprints?.docx || data.fingerprints?.pdf) && (
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
                <h2 className="font-semibold text-gray-900 mb-1">Fingerprints (SHA-256)</h2>
                <p className="text-sm text-gray-500 mb-3">
                  Prefer to check by hand? Run <code className="font-mono text-xs">shasum -a 256 &lt;file&gt;</code> (macOS/Linux)
                  or <code className="font-mono text-xs">certutil -hashfile &lt;file&gt; SHA256</code> (Windows) on the file
                  you were sent — it should equal one of these.
                </p>
                <div className="flex flex-col gap-2">
                  {data.fingerprints.docx && <Fingerprint label=".docx" hash={data.fingerprints.docx} />}
                  {data.fingerprints.pdf  && <Fingerprint label="PDF"   hash={data.fingerprints.pdf} />}
                </div>
                <p className="text-xs text-gray-400 mt-4">
                  Have a file but not its link?{' '}
                  <Link to="/check" className="underline underline-offset-2 hover:text-gray-600">Find its verification page</Link>
                  {' · '}
                  <a href={reportHref(code, 'reported page')} className="underline underline-offset-2 hover:text-gray-600">Report a problem with this page</a>
                </p>
              </div>
            )}

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
                <p role="status" aria-live="polite" className={`text-sm font-medium mt-3 ${checkLabel.cls}`}>{checkLabel.text}</p>
              )}
            </div>

            {/* Hiring manager soft opt-in — shown above the full form */}
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
              {leadSent ? (
                <p className="text-sm text-green-700 font-medium">
                  Almost there — check your inbox for an email from us and click the link to confirm your address.
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
                <Form onSubmit={handleLead} className="flex flex-col gap-3">
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
                  <RoleFields category={role} onCategory={setRole} title={roleTitle} onTitle={setRoleTitle} />
                  <Input
                    type="email"
                    placeholder="Work email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                  />
                  <LeadConsentNote />
                  {leadErr && <p className="text-xs text-red-600">{leadErr}</p>}
                  {/* Honeypot: invisible to a real person, tempting to a bot filling
                      every field it finds. Off-screen rather than display:none/hidden —
                      some bots skip fields a screen reader would also skip. */}
                  <input type="text" name="website" value={website} onChange={e => setWebsite(e.target.value)}
                    tabIndex={-1} autoComplete="off" aria-hidden="true"
                    style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }} />
                  <div className="flex gap-3">
                    <Button type="submit" loading={leadLoading}>
                      Get early access
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setHmExpanded(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                </Form>
              )}
            </div>
          </div>
        )}
      </main>
      <Footer />
    </div>
  )
}
