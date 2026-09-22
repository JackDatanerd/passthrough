import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import api, { getErrorMessage } from '../../lib/api'
import { useAuth } from '../../hooks/useAuth'
import Button from '../ui/Button'
import Input from '../ui/Input'
import Textarea from '../ui/Textarea'
import FileUpload from '../ui/FileUpload'
import Form from '../ui/Form'
import { addAnonScanToken } from '../../lib/anonScans'

// Mirrors backend/src/config/constants.js MIN_BRAIN_DUMP_CHARS. No shared
// constants file between frontend/backend in this project (same pattern as
// the existing JD-length check below, which mirrors the backend's own
// hardcoded 50-char minimum) — kept in sync manually, same as that one.
const MIN_BRAIN_DUMP_CHARS = 100
// AUDIT FIX (feature gap — section audit "generate a resume from scratch"):
// mirrors backend/src/config/constants.js MAX_RESUME_CHARS. The backend has
// always silently truncated brainDumpText past this length (createScan /
// structureBrainDump) — there was previously no maxLength, no counter, and
// no warning anywhere in this component, so a detailed multi-role career
// narrative (naturally more verbose per fact than a bullet-formatted resume)
// could lose an entire job or degree off the end with zero indication why
// the AI "forgot" it.
const MAX_RESUME_CHARS = 8000

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
  // Anonymous users describing their background in free text rarely think
  // to state their own name — Claude is correctly instructed never to
  // invent one, which means it's frequently left blank. Logged-in users
  // already have a server-side fallback to their account name/email; this
  // covers the case that fallback can't reach.
  const [contactName,  setContactName ] = useState('')
  const [contactEmail, setContactEmail] = useState('')

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

  async function handleSubmit(e) {
    e?.preventDefault?.()
    if (entryMode === 'upload' && !file)
      return setError('Please upload your resume.')
    if (entryMode === 'brainDump' && brainDumpText.trim().length < MIN_BRAIN_DUMP_CHARS)
      return setError(`Tell us a bit more about your background (min ${MIN_BRAIN_DUMP_CHARS} characters).`)
    if (entryMode === 'brainDump' && !user) {
      if (!contactName.trim())
        return setError('Please enter your name.')
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail.trim()))
        return setError('Please enter a valid email address.')
    }
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
        if (!user) {
          formData.append('contactName', contactName.trim())
          formData.append('contactEmail', contactEmail.trim())
        }
      }
      if (useUrl && jobUrl.trim())
        formData.append('jobDescriptionUrl', jobUrl.trim())
      else
        formData.append('jobDescriptionText', jdText)

      const res = await api.post('/scan', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      })
      const { scanId, anonToken } = res.data.data

      // AUDIT FIX (feature gap): previously overwrote a single localStorage
      // slot, so only the LAST anon scan before registering was ever
      // claimable — see anonScans.js.
      if (anonToken) addAnonScanToken(scanId, anonToken)

      navigate(`/scan/${scanId}`)
    } catch (err) {
      const msg = getErrorMessage(err, 'Something went wrong. Please try again.')
      // AUDIT FIX: this only auto-switched back to paste mode when the
      // backend explicitly marked the failure `blocked: true` (LinkedIn,
      // listing pages, Workday). Every other JD-URL fetch failure — a 404,
      // a timeout, a page that just didn't extract enough text — left the
      // UI sitting in URL mode with the same URL, even though the error
      // message itself says "paste instead" either way. Now any failure
      // that happened while submitting a URL (not a pasted-text submission)
      // switches back to paste mode, so the message and the UI agree.
      if (useUrl) setUseUrl(false)
      setError(msg)
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
    <Form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <div>
        <div className="flex rounded-md overflow-hidden border border-gray-300 text-sm mb-3 w-fit flex-wrap">
          <button type="button"
            onClick={() => switchEntryMode('upload')}
            className={`px-3 py-1.5 transition-colors ${entryMode === 'upload' ? 'bg-blue-700 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
          >
            Upload resume
          </button>
          <button type="button"
            onClick={() => switchEntryMode('brainDump')}
            className={`px-3 py-1.5 transition-colors ${entryMode === 'brainDump' ? 'bg-blue-700 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
          >
            Start from scratch
          </button>
          {hasSavedProfile && (
            <button type="button"
              onClick={() => switchEntryMode('savedProfile')}
              className={`px-3 py-1.5 transition-colors ${entryMode === 'savedProfile' ? 'bg-blue-700 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
            >
              Use saved profile
            </button>
          )}
        </div>

        {entryMode === 'upload' && <FileUpload value={file} onFile={setFile} />}

        {entryMode === 'brainDump' && (
          <div>
            <Textarea
              placeholder="Tell us about your work in your own words — companies, roles, what you actually did. Doesn't need to be tidy, we'll structure it for you."
              value={brainDumpText}
              onChange={e => setBrainDumpText(e.target.value.slice(0, MAX_RESUME_CHARS))}
              rows={8}
            />
            <div className="mt-1 flex items-start justify-between gap-3">
              <p className="text-xs text-gray-500">
                No resume yet? Paste a brain dump, an old resume, or just describe your background —
                we'll turn it into a structured, JD-matched resume.
              </p>
              {/* AUDIT FIX (feature gap): see MAX_RESUME_CHARS comment above —
                  this counter is the only thing standing between a long,
                  detailed background and silent backend truncation. */}
              <span className={`shrink-0 text-xs tabular-nums ${
                brainDumpText.length >= MAX_RESUME_CHARS ? 'text-red-600 font-medium' :
                brainDumpText.length >= MAX_RESUME_CHARS * 0.9 ? 'text-amber-600' : 'text-gray-400'
              }`}>
                {brainDumpText.length.toLocaleString()} / {MAX_RESUME_CHARS.toLocaleString()}
              </span>
            </div>
            {brainDumpText.length >= MAX_RESUME_CHARS && (
              <p className="mt-1 text-xs text-red-600">
                You've hit the length limit — anything past this point won't be included.
                If you have more to add, trim less-relevant details above to make room.
              </p>
            )}
            {/* AUDIT FIX (feature gap): previously the only guidance was one
                generic placeholder sentence — everything the free-text
                extraction can't see (a metric never mentioned, a project
                never described, a link never pasted in) simply doesn't make
                it into the resume, with no hint beforehand about what to
                include. */}
            <div className="mt-3 rounded-lg border border-blue-100 bg-blue-50 px-4 py-3">
              <p className="text-xs font-medium text-blue-900 mb-1">For a stronger resume, mention:</p>
              <ul className="text-xs text-blue-800 list-disc list-inside space-y-0.5">
                <li>Company/organization names and your exact job title at each</li>
                <li>Specific numbers — team size, budget, % improved, users served, revenue</li>
                <li>Projects you built or contributed to, even personal or class ones — not just skills you know</li>
                <li>Links: LinkedIn, portfolio, GitHub, or a personal site, if you have one</li>
              </ul>
            </div>
            {!user && (
              <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Input
                    placeholder="Your full name"
                    value={contactName}
                    onChange={e => setContactName(e.target.value)}
                  />
                </div>
                <div>
                  <Input
                    type="email"
                    placeholder="Your email"
                    value={contactEmail}
                    onChange={e => setContactEmail(e.target.value)}
                  />
                </div>
                <p className="col-span-full text-xs text-gray-500">
                  People describing their own career rarely think to mention their own name —
                  we ask separately so your resume header isn't blank.
                </p>
              </div>
            )}
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
            <button type="button"
              onClick={() => setUseUrl(false)}
              className={`px-3 py-1.5 transition-colors ${!useUrl ? 'bg-blue-700 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
            >
              Paste text
            </button>
            <button type="button"
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
              For the most accurate score, use the employer's own posting link
              rather than a job board aggregator or reposted listing.
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

      <Button type="submit" loading={loading} size="lg" className="w-full sm:w-auto">
        {submitLabel}
      </Button>
      <p className="text-xs text-gray-500">
        No account needed. Results in ~30 seconds.
      </p>
    </Form>
  )
}
