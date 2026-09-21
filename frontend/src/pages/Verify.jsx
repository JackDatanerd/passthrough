import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import api from '../lib/api'
import { useApi } from '../hooks/useApi'
import Button from '../components/ui/Button'
import Input from '../components/ui/Input'
import Spinner from '../components/ui/Spinner'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'
import { formatDate, copyToClipboard } from '../lib/utils'

export default function Verify() {
  const { code } = useParams()
  const [data,    setData   ] = useState(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  // Generic failure state — separate from notFound. The old version only
  // ever branched on a 404; anything else (500, timeout, offline) left
  // loading/notFound/data all falsy, so the page silently rendered nothing
  // but the Navbar/Footer with no explanation and no way to retry.
  const [loadError, setLoadError] = useState(false)

  // Hiring manager soft opt-in
  const [hmExpanded,  setHmExpanded ] = useState(false)
  const [name,        setName       ] = useState('')
  const [company,     setCompany    ] = useState('')
  const [role,        setRole       ] = useState('')
  const [email,       setEmail      ] = useState('')
  const [leadSent,    setLeadSent   ] = useState(false)
  const { loading: leadLoading, error: leadErr, execute: executeLead } = useApi()

  const [linkCopied, setLinkCopied] = useState(false)

  function load() {
    setLoading(true); setNotFound(false); setLoadError(false)
    api.get(`/verify/${code}`)
      .then(res => { setData(res.data.data); setLoading(false) })
      .catch(err => {
        setLoading(false)
        if (err.response?.status === 404) setNotFound(true)
        else setLoadError(true)
      })
  }

  useEffect(() => { load() }, [code])

  async function handleLead() {
    if (!name || !company || !email) {
      const msg = 'Name, company, and email required.'
      await executeLead(() => Promise.reject(new Error(msg)), { fallback: msg }).catch(() => {})
      return
    }
    try {
      await executeLead(() => api.post('/employer-leads', {
        name,
        company,
        email,
        roleCategory: role || undefined
      }), { fallback: 'Something went wrong.' })
      setLeadSent(true)
    } catch (_) { /* error already captured by useApi */ }
  }

  async function handleCopyLink() {
    // copyToClipboard reports failure (insecure context, denied permission);
    // only claim "copied" when it actually was.
    if (await copyToClipboard(window.location.href)) {
      setLinkCopied(true)
      setTimeout(() => setLinkCopied(false), 2000)
    }
  }

  const integrityLabel =
    data?.integrityStatus === 'verified' ? 'Unmodified' :
    data?.integrityStatus === 'modified' ? 'Modified'   :
    'Unavailable'
  const integrityClass =
    data?.integrityStatus === 'verified' ? 'text-green-700' :
    data?.integrityStatus === 'modified' ? 'text-red-600'   :
    'text-amber-600'

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
              {data.passed ? (
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
                    Below the Passthrough Verified threshold (80+)
                  </p>
                </>
              )}
              {data.candidateFirstName && (
                <p className="text-gray-500 text-lg mb-4">{data.candidateFirstName}</p>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-6 text-sm">
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
                <div className="bg-gray-50 rounded-lg p-3">
                  <p className="text-gray-400 text-xs mb-1">Verified</p>
                  <p className="font-semibold text-gray-700 text-sm">{formatDate(data.verifiedAt)}</p>
                </div>
              </div>

              {(data.exposeDocx || data.exposePdf) && (
                <div className="flex flex-col sm:flex-row gap-3 mt-6 justify-center">
                  {data.exposeDocx && (
                    <Button
                      variant="secondary"
                      onClick={() => { window.location.href = `${api.defaults.baseURL}/verify/${code}/download?type=docx` }}
                    >
                      Download .docx
                    </Button>
                  )}
                  {data.exposePdf && (
                    <Button
                      onClick={() => window.open(`${api.defaults.baseURL}/verify/${code}/download?type=pdf`, '_blank')}
                    >
                      View / Download PDF
                    </Button>
                  )}
                </div>
              )}
              <p className="text-xs text-gray-400 mt-6">
                {data.passed
                  ? "This resume was scanned by Passthrough's ATS engine and has not been modified since verification."
                  : "This resume was scanned by Passthrough's ATS engine. It has not been modified since this scan, but did not reach the score threshold required for Passthrough Verified status."}
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

            {/* Integrity check explainer — elevated from a stat box to its own
                headline feature. The mechanism itself is unchanged (see
                verify.controller.js — SHA-256 re-hash on every view), this
                only changes how prominently it's explained. */}
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
                    re-checks it against that hash every time this page loads. If the
                    file has changed in any way, this page will say{' '}
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
