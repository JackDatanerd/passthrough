import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import api from '../lib/api'
import Spinner from '../components/ui/Spinner'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'
import usePageTitle from '../hooks/usePageTitle'
import { sha256Hex, fileKindOf, MAX_CHECK_BYTES } from '../lib/fileFingerprint'
import { extractVerificationCode } from '../lib/verificationCode'

// ROUND-3 AUDIT (feature gap, Section 7): the reader-side file check only worked AFTER the
// reader already had a candidate's verification link. An ATS strips links, a printout loses
// them, a forwarded PDF loses the email it came in — and then a genuine Passthrough file was
// a dead end. This is the other direction: hash the file in the browser (nothing is uploaded —
// only the 64-character fingerprint is sent) and be taken to the page it belongs to.
export default function VerifyLookup() {
  usePageTitle('Check a resume')
  const navigate = useNavigate()
  const inputRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)   // { text, tone: 'error' | 'muted' } | null
  const [codeText, setCodeText] = useState('')
  const [codeError, setCodeError] = useState('')

  async function handleFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true); setMessage(null)
    try {
      if (file.size > MAX_CHECK_BYTES) {
        setMessage({ text: 'That file is too large to be a resume — pick the .docx or .pdf you were sent.', tone: 'muted' })
        return
      }
      const hash = await sha256Hex(file)
      const res = await api.get(`/verify/by-hash/${hash}`)
      // ROUND-5 AUDIT FIX (feature gap): the lookup knew WHICH of the page's files this was (current or an
      // earlier delivery) and threw it away on the way to the page, so a reader holding a superseded file
      // landed on a green "Passthrough Verified … not modified" headline that said nothing about THEIR file.
      // The fingerprint rides along in router state (it never leaves the browser except as this request's
      // path, as before) and the page classifies it against the fingerprints it loads.
      const code = res.data.data.code
      navigate(`/v/${encodeURIComponent(code)}`, { state: { fileCheck: { code, hash, kind: fileKindOf(file) } } })
    } catch (err) {
      const status = err.response?.status
      if (status === 404) setMessage({ text: "No Passthrough verification matches that exact file. It may have been edited — but re-saving, converting to PDF or printing a copy changes a file's fingerprint too. Ask the candidate for the original, or look it up by its link or code below.", tone: 'error' })
      else if (status === 429) setMessage({ text: 'Too many lookups from your network just now. Please wait a few minutes and try again.', tone: 'muted' })
      else setMessage({ text: "Couldn't check that file — please try again.", tone: 'muted' })
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  function handleCode(e) {
    e.preventDefault()
    const code = extractVerificationCode(codeText)
    if (!code) { setCodeError("That doesn't look like a Passthrough verification link or code. A code is 10 letters and digits (older ones have 6)."); return }
    setCodeError('')
    navigate(`/v/${encodeURIComponent(code)}`)
  }

  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <Navbar />
      <main className="max-w-2xl mx-auto px-4 py-12 w-full">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-8">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Check a resume</h1>
          <p className="text-sm text-gray-500 mb-6 leading-relaxed">
            Received a resume that says it was verified by Passthrough, but the link is missing? Choose the
            .docx or .pdf you were sent. Your browser computes its fingerprint locally — the file itself is
            never uploaded — and we take you to the verification page for it, if there is one.
          </p>
          <div className="flex items-center gap-3 flex-wrap">
            <input
              ref={inputRef}
              type="file"
              accept=".docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={handleFile}
              disabled={busy}
              aria-label="Choose the .docx or .pdf you were sent"

              className="text-sm text-gray-600 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-blue-50 file:text-blue-700 file:text-sm file:font-medium hover:file:bg-blue-100"
            />
            {busy && <Spinner size="sm" />}
          </div>
          {message && (
            <p role="status" aria-live="polite" className={`text-sm font-medium mt-4 ${message.tone === 'error' ? 'text-red-600' : 'text-gray-500'}`}>
              {message.text}
            </p>
          )}
          <p className="text-xs text-gray-400 mt-6">
            A match means the file is byte-for-byte one Passthrough issued (the current version or an earlier one).
            Open the page it takes you to for the score, the verdict and the version history.{' '}
            <Link to="/" className="underline underline-offset-2 hover:text-gray-600">What is Passthrough?</Link>
          </p>
        </div>

        {/* ROUND-5 AUDIT (feature gap): a printed resume keeps the link as text, not a clickable address —
            the reader can type or paste the code, but had no place to put it. */}
        <form onSubmit={handleCode} className="bg-white rounded-xl border border-gray-200 shadow-sm p-8 mt-6" noValidate>
          <h2 className="text-lg font-semibold text-gray-900 mb-1">Have the link or code instead?</h2>
          <p className="text-sm text-gray-500 mb-4 leading-relaxed">
            Paste the verification link, or type the code printed next to “Passthrough Verified” on the resume.
          </p>
          <div className="flex items-start gap-3 flex-wrap">
            <input
              type="text" value={codeText} onChange={e => { setCodeText(e.target.value); setCodeError('') }}
              aria-label="Verification link or code" placeholder="passthrough.dev/v/… or AB3XY7K2PQ"
              autoComplete="off" spellCheck={false}
              className="flex-1 min-w-[14rem] rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button type="submit" className="rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-sm font-medium px-4 py-2 transition-colors">
              Open page
            </button>
          </div>
          {codeError && <p role="alert" className="text-sm font-medium text-red-600 mt-3">{codeError}</p>}
        </form>
      </main>
      <Footer />
    </div>
  )
}
