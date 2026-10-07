import { useState } from 'react'
import api, { getErrorMessage } from '../../lib/api'
import { downloadBlob, copyToClipboard } from '../../lib/utils'
import Button from '../ui/Button'
import Alert from '../ui/Alert'

// FEATURE GAP CLOSED (Scan/ATS pass): scans.cover_letter_text existed since the first migration
// and nothing wrote it. A cover letter for the same job as the delivered resume, written only
// from that resume's facts (the server rejects a draft that invents a figure). Owner-only.
export default function CoverLetterPanel({ scan, onUpdated }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const letter = scan.coverLetterText

  async function generate() {
    setBusy(true); setError('')
    try {
      const res = await api.post(`/scan/${scan.id}/cover-letter`)
      onUpdated({ coverLetterText: res.data.data.coverLetterText })
    } catch (err) {
      setError(getErrorMessage(err, 'We couldn\'t write the letter just now — try again in a minute.'))
    }
    setBusy(false)
  }

  async function download() {
    setError('')
    try {
      const res = await api.get(`/scan/${scan.id}/cover-letter`, { responseType: 'blob' })
      downloadBlob(res.data, 'cover-letter.docx')
    } catch (err) {
      setError(getErrorMessage(err, 'Could not download the letter — try again.'))
    }
  }

  async function copy() {
    if (await copyToClipboard(letter)) { setCopied(true); setTimeout(() => setCopied(false), 2000) }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6" data-testid="cover-letter">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h3 className="font-semibold text-gray-900">Cover letter for this job</h3>
          <p className="text-sm text-gray-500 mt-0.5">
            Written from your delivered resume and this job description only — it won't claim anything your resume doesn't.
            Read it through and make it yours before you send it.
          </p>
        </div>
        <Button variant={letter ? 'secondary' : 'primary'} size="sm" onClick={generate} loading={busy}>
          {letter ? 'Write a new one' : 'Write my cover letter'}
        </Button>
      </div>
      <Alert className="mt-3">{error}</Alert>
      {letter && (
        <div className="mt-4">
          <pre className="whitespace-pre-wrap font-sans text-sm text-gray-800 bg-gray-50 border border-gray-200 rounded-md p-4">{letter}</pre>
          <div className="flex gap-2 mt-3">
            <Button variant="secondary" size="sm" onClick={copy}>{copied ? 'Copied' : 'Copy text'}</Button>
            <Button variant="secondary" size="sm" onClick={download}>Download (.docx)</Button>
          </div>
        </div>
      )}
    </div>
  )
}
