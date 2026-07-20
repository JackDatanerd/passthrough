import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import api from '../../lib/api'
import { useAuth } from '../../hooks/useAuth'
import Button from '../ui/Button'
import Input from '../ui/Input'
import Textarea from '../ui/Textarea'
import FileUpload from '../ui/FileUpload'

// Mirrors backend/src/config/constants.js MIN_BRAIN_DUMP_CHARS. No shared
// constants file between frontend/backend in this project (same pattern as
// the existing JD-length check below, which mirrors the backend's own
// hardcoded 50-char minimum) — kept in sync manually, same as that one.
const MIN_BRAIN_DUMP_CHARS = 100

export default function ScanForm() {
  const navigate  = useNavigate()
  const { user }  = useAuth()
  const [params]  = useSearchParams()

  // PHASE 1 — entry mode toggle: upload an existing resume, or start from
  // a pasted brain dump when the user doesn't have a polished resume yet.
  // PHASE 4 — a third mode, 'savedProfile', only available (and only shown
  // as an option) to a logged-in user who has previously saved one.
  const [entryMode, setEntryMode] = useState('upload') // 'upload' | 'brainDump' | 'savedProfile'
  const [file,          setFile         ] = useState(null)
  const [brainDumpText, setBrainDumpText] = useState('')
  const [hasSavedProfile, setHasSavedProfile] = useState(false)

  const [useUrl,  setUseUrl ] = useState(false)
  const [jobUrl,  setJobUrl ] = useState('')
  const [jdText,  setJdText ] = useState('')
  const [loading, setLoading] = useState(false)
  const [error,   setError  ] = useState('')

  // PHASE 4 — check whether this user has a saved profile, so the third
  // toggle option can be shown. Anonymous visitors skip this entirely —
  // there's no account to have saved a profile to.
  useEffect(() => {
    if (!user) return
    api.get('/profile')
      .then(res => setHasSavedProfile(!!res.data.data.hasSavedProfile))
      .catch(() => {}) // fail silently — worst case the toggle just doesn't show
  }, [user])

  // PHASE 4 — the dashboard's "Rescan with new JD" button links here with
  // ?mode=savedProfile. Pre-select that tab once we've confirmed the
  // profile actually exists (avoids selecting a mode that would just
  // immediately fail server-side if the profile was deleted elsewhere).
  useEffect(() => {
    if (params.get('mode') === 'savedProfile' && hasSavedProfile) {
      setEntryMode('savedProfile')
    }
  }, [hasSavedProfile])

  function switchEntryMode(mode) {
    setEntryMode(mode)
    setError('')
  }

  async function handleSubmit() {
    if (entryMode === 'upload' && !file)
      return setError('Please upload your resume.')
    if (entryMode === 'brainDump' && brainDumpText.trim().length < MIN_BRAIN_DUMP_CHARS)
      return setError(`Tell us a bit more about your background (min ${MIN_BRAIN_DUMP_CHARS} characters).`)
    if (!useUrl && jdText.length < 50)
      return setError('Job description too short (min 50 characters).')
    if (useUrl  && !jobUrl.trim())
      return setError('Please enter a job posting URL.')

    setError('')
    setLoading(true)
    try {
      const formData = new FormData()
      if (entryMode === 'upload') {
        formData.append('resume', file)
      } else if (entryMode === 'savedProfile') {
        formData.append('useSavedProfile', 'true')
      } else {
        formData.append('brainDumpText', brainDumpText.trim())
      }
      if (useUrl && jobUrl.trim())
        formData.append('jobDescriptionUrl', jobUrl.trim())
      else
        formData.append('jobDescriptionText', jdText)

      const res = await api.post('/scan', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      })
      const { scanId, anonToken } = res.data.data

      // CRITICAL: store anonToken so postRegisterActions can claim this scan
      if (anonToken) localStorage.setItem('passthrough_anon_token', anonToken)

      navigate(`/scan/${scanId}`)
    } catch (err) {
      const msg = err.response?.data?.message || 'Something went wrong. Please try again.'
      if (err.response?.data?.blocked) {
        setUseUrl(false)
        setError(msg)
      } else {
        setError(msg)
      }
    } finally {
      setLoading(false)
    }
  }

  const submitLabel = entryMode === 'upload'
    ? 'Scan My Resume — Free'
    : entryMode === 'savedProfile'
      ? 'Score My Profile Against This JD — Free'
      : 'Build & Score My Resume — Free'

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="flex rounded-md overflow-hidden border border-gray-300 text-sm mb-3 w-fit flex-wrap">
          <button
            onClick={() => switchEntryMode('upload')}
            className={`px-3 py-1.5 transition-colors ${entryMode === 'upload' ? 'bg-blue-700 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
          >
            Upload resume
          </button>
          <button
            onClick={() => switchEntryMode('brainDump')}
            className={`px-3 py-1.5 transition-colors ${entryMode === 'brainDump' ? 'bg-blue-700 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
          >
            Start from scratch
          </button>
          {hasSavedProfile && (
            <button
              onClick={() => switchEntryMode('savedProfile')}
              className={`px-3 py-1.5 transition-colors ${entryMode === 'savedProfile' ? 'bg-blue-700 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
            >
              Use saved profile
            </button>
          )}
        </div>

        {entryMode === 'upload' && <FileUpload onFile={setFile} />}

        {entryMode === 'brainDump' && (
          <div>
            <Textarea
              placeholder="Tell us about your work in your own words — companies, roles, what you actually did. Doesn't need to be tidy, we'll structure it for you."
              value={brainDumpText}
              onChange={e => setBrainDumpText(e.target.value)}
              rows={8}
            />
            <p className="mt-1 text-xs text-gray-500">
              No resume yet? Paste a brain dump, an old resume, or just describe your background —
              we'll turn it into a structured, JD-matched resume.
            </p>
          </div>
        )}

        {entryMode === 'savedProfile' && (
          <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
            <p className="text-sm text-gray-700">
              We'll use your saved profile — just add a job description below and we'll translate it fresh.
            </p>
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center gap-4 mb-3">
          <span className="text-sm font-medium text-gray-700">Job description</span>
          <div className="flex rounded-md overflow-hidden border border-gray-300 text-sm">
            <button
              onClick={() => setUseUrl(false)}
              className={`px-3 py-1.5 transition-colors ${!useUrl ? 'bg-blue-700 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
            >
              Paste text
            </button>
            <button
              onClick={() => setUseUrl(true)}
              className={`px-3 py-1.5 transition-colors ${useUrl ? 'bg-blue-700 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
            >
              URL
            </button>
          </div>
        </div>

        {useUrl ? (
          <div>
            <Input
              placeholder="https://jobs.example.com/software-engineer-123"
              value={jobUrl}
              onChange={e => setJobUrl(e.target.value)}
            />
            <p className="mt-1 text-xs text-gray-500">
              LinkedIn URLs cannot be read automatically — paste the text instead.
            </p>
          </div>
        ) : (
          <Textarea
            placeholder="Paste the full job description here…"
            value={jdText}
            onChange={e => setJdText(e.target.value)}
            rows={7}
          />
        )}
      </div>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      <Button onClick={handleSubmit} loading={loading} size="lg" className="w-full sm:w-auto">
        {submitLabel}
      </Button>
      <p className="text-xs text-gray-500">
        No account needed. Results in ~30 seconds.
      </p>
    </div>
  )
}
