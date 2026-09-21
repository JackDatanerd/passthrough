import { useState } from 'react'
import api, { getErrorMessage } from '../../lib/api'
import Button from '../ui/Button'

// Phase 4 — explicit opt-in only. Profile data (name, email, phone, work
// history) is PII; nothing in this app persists it beyond a single scan's
// own record without the user actively choosing to. This mirrors the
// consent-forward pattern used throughout — e.g. AI-added skills in
// DiffView are flagged for the user's own judgment rather than silently
// trusted, and here saving anything long-lived is a deliberate action,
// never a side effect of viewing a result.
//
// Rendered only for logged-in users with structured resume data on the
// scan (ScanResult.jsx gates on both). Saving POSTs just the scanId — see
// profile.controller.js for why the server derives the data server-side
// rather than trusting a client-supplied payload here.

export default function SaveProfilePrompt({ scanId }) {
  const [status, setStatus] = useState('idle') // idle | saving | saved | error
  const [error,  setError ] = useState('')

  async function handleSave() {
    setStatus('saving')
    setError('')
    try {
      await api.post('/profile/save', { scanId })
      setStatus('saved')
    } catch (err) {
      setError(getErrorMessage(err, 'Could not save profile.'))
      setStatus('error')
    }
  }

  if (status === 'saved') {
    return (
      <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-sm text-green-800">
        Profile saved — next time, translate it against a new job in one step from your dashboard.
      </div>
    )
  }

  return (
    <div className="bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div>
        <p className="text-sm font-medium text-gray-800">Save this profile for next time</p>
        <p className="text-xs text-gray-500 mt-0.5">
          Reuse your background against a new job description in one step — no re-uploading.
        </p>
        {status === 'error' && <p className="text-xs text-red-600 mt-1">{error}</p>}
      </div>
      <Button onClick={handleSave} loading={status === 'saving'} variant="secondary" size="sm" className="shrink-0">
        Save profile
      </Button>
    </div>
  )
}
