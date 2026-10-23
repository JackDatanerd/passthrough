import { useState } from 'react'
import api, { getErrorMessage } from '../../lib/api'
import { downloadBlob, filenameFromDisposition } from '../../lib/utils'
import CopyButton from '../ui/CopyButton'
import Button from '../ui/Button'
import Alert from '../ui/Alert'
import Input from '../ui/Input'
import Textarea from '../ui/Textarea'
import Select from '../ui/Select'

// FEATURE GAP CLOSED (Scan/ATS pass): scans.cover_letter_text existed since the first migration
// and nothing wrote it. A cover letter for the same job as the delivered resume, written only
// from that resume's facts (the server rejects a draft that invents a figure). Owner-only.
//
// Optional "tailor it" fields: who it is addressed to, the company, what the letter should lead with, and the tone.
// A letter that names the person and the company, and opens with the thing the applicant most wants read, is the
// difference between a letter that gets read and "Dear Hiring Manager" boilerplate. Nothing here is required; an empty
// form sends no body at all (the server then writes a general letter from the resume and the posting).
// The letter is dated "today" for the applicant, so the server needs their time zone (an unknown zone falls back to UTC there).
const browserTimeZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined } catch { return undefined } }

export default function CoverLetterPanel({ scan, onUpdated }) {
  const [busy, setBusy] = useState(false)
  const [pdfBusy, setPdfBusy] = useState(false)
  const [error, setError] = useState('')
  const [tailor, setTailor] = useState(false)
  const [company, setCompany] = useState('')
  const [recipient, setRecipient] = useState('')
  const [lead, setLead] = useState('')
  const [tone, setTone] = useState('warm')
  // The person's own edit of the letter: the .docx and .pdf are built from the saved text, so an edit only counts once saved.
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmNew, setConfirmNew] = useState(false)
  const letter = scan.coverLetterText
  // How many letters this purchase includes, and how many are used (the server counts them; see constants.COVER_LETTER_LIMITS).
  // Both are absent on a response that predates the limit, in which case no allowance is shown and nothing is disabled.
  const limit = Number.isFinite(scan.coverLetterLimit) ? scan.coverLetterLimit : null
  const used = Number.isFinite(scan.coverLetterCount) ? scan.coverLetterCount : null
  const left = limit !== null && used !== null ? Math.max(0, limit - used) : null
  const atLimit = left === 0
  const letters = n => `${n} letter${n === 1 ? '' : 's'}`

  async function save() {
    setSaving(true); setError('')
    try {
      const res = await api.patch(`/scan/${scan.id}/cover-letter`, { text: draft })
      onUpdated({ coverLetterText: res.data.data.coverLetterText })
      setEditing(false)
    } catch (err) {
      setError(getErrorMessage(err, 'We couldn\'t save your changes — try again.'))
    }
    setSaving(false)
  }

  async function generate() {
    setBusy(true); setError(''); setConfirmNew(false); setEditing(false)
    try {
      const body = {}
      if (company.trim()) body.company = company.trim()
      if (recipient.trim()) body.recipient = recipient.trim()
      if (lead.trim()) body.lead = lead.trim()
      if (tone !== 'warm') body.tone = tone
      const res = Object.keys(body).length
        ? await api.post(`/scan/${scan.id}/cover-letter`, body)
        : await api.post(`/scan/${scan.id}/cover-letter`)
      const d = res.data.data
      onUpdated({ coverLetterText: d.coverLetterText, ...(Number.isFinite(d.coverLetterCount) ? { coverLetterCount: d.coverLetterCount } : {}), ...(Number.isFinite(d.coverLetterLimit) ? { coverLetterLimit: d.coverLetterLimit } : {}) })
    } catch (err) {
      // Another tab (or an earlier request) used the last letter: show the allowance as spent instead of leaving a live button.
      const body = err?.response?.data
      if (body?.code === 'COVER_LETTER_LIMIT' && Number.isFinite(body.coverLetterLimit)) onUpdated({ coverLetterCount: body.coverLetterLimit, coverLetterLimit: body.coverLetterLimit })
      setError(getErrorMessage(err, 'We couldn\'t write the letter just now — try again in a minute.'))
    }
    setBusy(false)
  }

  async function download() {
    setError('')
    try {
      const res = await api.get(`/scan/${scan.id}/cover-letter`, { responseType: 'blob', params: { tz: browserTimeZone() } })
      downloadBlob(res.data, filenameFromDisposition(res.headers, 'cover-letter.docx'))
    } catch (err) {
      setError(getErrorMessage(err, 'Could not download the letter — try again.'))
    }
  }

  // The PDF is the file most people send; it is rendered on demand (a few seconds), so it has its own busy state.
  async function downloadPdf() {
    setError(''); setPdfBusy(true)
    try {
      const res = await api.get(`/scan/${scan.id}/cover-letter-pdf`, { responseType: 'blob', params: { tz: browserTimeZone() } })
      downloadBlob(res.data, filenameFromDisposition(res.headers, 'cover-letter.pdf'))
    } catch (err) {
      setError(getErrorMessage(err, 'Could not download the PDF — try again in a minute, or use the .docx.'))
    }
    setPdfBusy(false)
  }

  return (
    <div className="bg-white rounded-xl border border-blue-200 shadow-sm p-6" data-testid="cover-letter">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="rounded-full bg-blue-700 px-2.5 py-0.5 text-xs font-semibold text-white">Bonus</span>
            <h3 className="font-semibold text-gray-900">Your cover letter for this job</h3>
          </div>
          <p className="text-sm text-gray-500 mt-1">
            Included with your purchase. Written from your delivered resume and this job description only — it won't claim anything your resume doesn't.
            Read it through and edit it until it sounds like you before you send it.
          </p>
          {left !== null && (
            <p className={`text-xs mt-1.5 ${atLimit ? 'text-amber-800' : 'text-gray-600'}`} data-testid="cover-letter-allowance">
              {atLimit
                ? `You've used all ${letters(limit)} that come with this resume. Editing the one you have is still free.`
                : `${left} of ${limit} letters left. Editing a letter by hand doesn't use one.`}
            </p>
          )}
        </div>
        {!confirmNew && !(atLimit && letter) && (
          <Button variant={letter ? 'secondary' : 'primary'} size="sm" loading={busy} disabled={atLimit}
            onClick={() => (letter ? setConfirmNew(true) : generate())}>
            {letter ? 'Write a new one' : 'Write my cover letter'}
          </Button>
        )}
      </div>
      <div className="mt-3">
        <button type="button" onClick={() => setTailor(t => !t)} aria-expanded={tailor}
          className="text-sm font-medium text-blue-700 hover:text-blue-800 focus:outline-none focus:underline">
          {tailor ? 'Hide options' : 'Tailor it (optional)'}
        </button>
        {tailor && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2" data-testid="cover-letter-options">
            <Input label="Company" value={company} onChange={e => setCompany(e.target.value)} maxLength={80} placeholder="Northwind Logistics" />
            <Input label="Hiring manager's name" value={recipient} onChange={e => setRecipient(e.target.value)} maxLength={80} placeholder="Ms. Alvarez" hint="Leave blank for “Dear Hiring Manager”." />
            <Textarea wrapperClassName="sm:col-span-2" label="Lead with" rows={2} value={lead} onChange={e => setLead(e.target.value)} maxLength={300} showCount
              hint="The one thing you most want them to read first — it must already be true of your resume." />
            <Select label="Tone" value={tone} onChange={e => setTone(e.target.value)}>
              <option value="warm">Warm</option>
              <option value="direct">Direct</option>
              <option value="formal">Formal</option>
            </Select>
          </div>
        )}
      </div>
      <Alert className="mt-3">{error}</Alert>
      {confirmNew && (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" data-testid="cover-letter-confirm">
          <p>
            A new letter replaces the one below, including any changes you made to it. Copy it first if you want to keep it.
            {left !== null && <> It uses 1 of your {letters(limit)}; {left - 1} will be left.</>}
          </p>
          <div className="flex gap-2 mt-2">
            <Button size="sm" onClick={generate} loading={busy}>Replace it</Button>
            <Button variant="secondary" size="sm" onClick={() => setConfirmNew(false)}>Keep this one</Button>
          </div>
        </div>
      )}
      {letter && (
        <div className="mt-4">
          {editing ? (
            <>
              <Textarea label="Your letter" rows={16} value={draft} onChange={e => setDraft(e.target.value)} maxLength={4000} showCount
                hint="Change anything you like. The Word and PDF files use the saved text." />
              <div className="flex gap-2 mt-3">
                <Button size="sm" onClick={save} loading={saving} disabled={draft.trim().length < 50}>Save changes</Button>
                <Button variant="secondary" size="sm" onClick={() => { setEditing(false); setError('') }}>Cancel</Button>
              </div>
            </>
          ) : (
            <>
              <pre className="whitespace-pre-wrap font-sans text-sm text-gray-800 bg-gray-50 border border-gray-200 rounded-md p-4">{letter}</pre>
              <p className="text-xs text-gray-500 mt-2">If you edit your resume after this, the letter is cleared (it was written from the earlier version) and a new one uses another of your letters. Copy or download it first if you want to keep it.</p>
              <div className="flex gap-2 mt-3 flex-wrap">
                <CopyButton text={letter} label="Copy text" />
                <Button variant="secondary" size="sm" onClick={() => { setDraft(letter); setEditing(true); setError('') }}>Edit</Button>
                <Button variant="secondary" size="sm" onClick={download}>Download (.docx)</Button>
                <Button variant="secondary" size="sm" onClick={downloadPdf} loading={pdfBusy}>Download (.pdf)</Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
