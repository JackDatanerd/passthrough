import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import api from '../lib/api'
import Spinner from '../components/ui/Spinner'
import Navbar from '../components/layout/Navbar'
import Footer from '../components/layout/Footer'
import usePageTitle from '../hooks/usePageTitle'
import { sha256Hex, MAX_CHECK_BYTES } from '../lib/fileFingerprint'

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
      navigate(`/v/${encodeURIComponent(res.data.data.code)}`)
    } catch (err) {
      const status = err.response?.status
      if (status === 404) setMessage({ text: "No Passthrough verification matches that file. It has been edited since it was issued, or it didn't come from Passthrough.", tone: 'error' })
      else if (status === 429) setMessage({ text: 'Too many lookups from your network just now. Please wait a few minutes and try again.', tone: 'muted' })
      else setMessage({ text: "Couldn't check that file — please try again.", tone: 'muted' })
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
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
      </main>
      <Footer />
    </div>
  )
}
