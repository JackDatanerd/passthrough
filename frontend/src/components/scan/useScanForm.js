import { useState, useEffect, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import api, { getErrorMessage } from '../../lib/api'
import { describeQuota } from '../../lib/quota'
import { useAuth } from '../../hooks/useAuth'
import { addAnonScanToken } from '../../lib/anonScans'
import { isCancelError } from '../../lib/errors'
import { loadBrainDumpDraft, saveBrainDumpDraft, markDraftSent } from '../../lib/brainDumpDraft'
import { loadJdDraft, saveJdDraft, clearJdDraft } from '../../lib/scanJdDraft'
import { manualHasContent, filled, EMPTY_MANUAL } from '../../lib/resumeForm'

// Everything a scan form knows and does, with no opinion about how it looks. Two faces use it: the compact card on
// the homepage and the dashboard (ScanForm.jsx) and the full /scan page (ScanComposer.jsx). Before this they could
// not share logic, so the page would have had to copy 270 lines of it, and the two copies would have drifted.

// Mirrors backend/src/config/constants.js MIN_BRAIN_DUMP_CHARS. There is no shared constants file between the
// frontend and backend, so these are kept in sync by hand.
export const MIN_BRAIN_DUMP_CHARS = 100
// Mirrors MAX_RESUME_CHARS. The backend silently truncates a longer background, so the counter is the only warning.
export const MAX_RESUME_CHARS = 12000
// Mirrors MAX_JD_CHARS. Since round 3 the backend FITS a longer posting (company intro and legal text go first),
// so this is a heads-up, not a hard stop, and the result page shows the text that was scored.
export const MAX_JD_CHARS = 5000
// Mirrors the backend's minimum for a posting, which it applies after trimming and collapsing whitespace.
export const MIN_JD_CHARS = 50

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// Statuses a finished resume can be scanned again from (the same set the results page offers the button for).
export const RESCANNABLE = ['COMPLETE_PASS', 'COMPLETE_FAIL', 'FIX_PURCHASED', 'FIX_GENERATING', 'FIX_DELIVERED']

// Characters the backend will count: whitespace runs collapse to one space, the ends are trimmed.
export const jdLength = text => text.replace(/\s+/g, ' ').trim().length

function sourceLabel(scan) {
  return scan.resumeOriginalName
    || (scan.inputMode === 'brain_dump' ? 'the background you wrote' : scan.inputMode === 'file' ? 'the resume you uploaded' : 'your saved profile')
}

// `loadRecent`: also fetch the person's earlier scans so the page can offer "reuse a recent one". The compact card
// does not ask, so the homepage makes no extra request.
export default function useScanForm({ loadRecent = false } = {}) {
  const navigate  = useNavigate()
  const { user }  = useAuth()
  const [params]  = useSearchParams()
  const userId = user?.id || null
  // What was being typed when the page was last left (a failed scan, a closed tab) comes back, see lib/brainDumpDraft.js
  // and lib/scanJdDraft.js. Dropped once that scan's result exists.
  const [draft0] = useState(() => loadBrainDumpDraft(userId))
  const [jdDraft0] = useState(() => loadJdDraft(userId))

  // 'upload' | 'brainDump' | 'manual' | 'savedProfile' | 'rescan'. Opens where the person left off: a kept background or a
  // half-filled form brings its own tab forward (an explicit ?mode= or ?from= link, handled below, still wins).
  const [entryMode, setEntryMode] = useState(() =>
    params.get('mode') || params.get('from') ? 'upload'
      : draft0?.text?.trim() ? 'brainDump' : draft0?.manual ? 'manual' : 'upload')
  // A signed-in person starts with their account name and email in the (visible, editable) fields instead of the
  // server adding them behind their back to a form they left blank.
  const [manualData, setManualData] = useState(() => draft0?.manual
    ? { ...EMPTY_MANUAL, ...draft0.manual }
    : { ...EMPTY_MANUAL, name: user?.name || '', email: user?.email || '' })
  const restoredManual = !!draft0?.manual
  // "Scan this same resume against another job": arrives as /scan?from=<scanId>, or is picked from the recent list.
  // Holds the earlier scan's label once it has loaded.
  const [rescanSource, setRescanSource] = useState(null)
  const [useImproved, setUseImproved] = useState(false)
  const [file, setFile] = useState(null)
  // Whose draft this is. Set once and never reset to null when the session ends while the form is open, otherwise the
  // next keystroke would re-save the last person's text as an unowned draft.
  const draftOwner = useRef(userId)
  const [brainDumpText, setBrainDumpText] = useState(() => (draft0?.text || '').slice(0, MAX_RESUME_CHARS))
  const [hasSavedProfile, setHasSavedProfile] = useState(false)
  // Additional named profiles (Settings): '' means the primary profile.
  const [extraProfiles, setExtraProfiles] = useState([])
  const [profileChoice, setProfileChoice] = useState('')
  const [primaryAvailable, setPrimaryAvailable] = useState(true)
  // Today's free-scan allowance (signed-in only).
  const [quota, setQuota] = useState(null)
  // Earlier scans that can be reused: null until loaded (or never asked), [] when there are none.
  const [recent, setRecent] = useState(null)
  // Someone describing their background in free text rarely states their own name, and Claude is correctly told never to
  // invent one. A signed-in person has a server-side fallback to the account name; this covers the case it cannot reach.
  const [contactName,  setContactName ] = useState(draft0?.name || '')
  const [contactEmail, setContactEmail] = useState(draft0?.email || '')
  // Optional address for an anonymous FILE upload, so the result link can be emailed back.
  const [uploadEmail, setUploadEmail] = useState('')
  const restored = !!(draft0 && draft0.text.trim())

  const [useUrl,  setUseUrl ] = useState(() => jdDraft0?.useUrl === true)
  const [jobUrl,  setJobUrl ] = useState(() => jdDraft0?.url || '')
  const [jdText,  setJdText ] = useState(() => jdDraft0?.text || '')
  const restoredJd = !!jdDraft0
  const [paperSize, setPaperSize] = useState('')   // '' = Automatic; 'letter' | 'a4' = the person's choice
  const [loading, setLoading] = useState(false)
  // Upload progress (0-100) and the controller that cancels it: a 5 MB resume on a slow phone link takes over a minute.
  const [uploadPct, setUploadPct] = useState(null)
  const uploadAbort = useRef(null)
  useEffect(() => () => uploadAbort.current?.abort(), [])
  const [error, setError] = useState('')

  // Who is in the form decides what can be offered. When the person changes (or signs out) nothing chosen for the last
  // one carries over: a profile id from another account used to stay selected and be sent with the next scan, and a
  // slow answer for the previous person could land after the new one's. `cancelled` drops such a late answer.
  useEffect(() => {
    setHasSavedProfile(false); setExtraProfiles([]); setPrimaryAvailable(true); setProfileChoice(''); setQuota(null)
    setRecent(null)
    if (!userId) return undefined
    let cancelled = false
    api.get('/profile')
      .then(res => {
        if (cancelled) return
        const d = res.data.data
        const extras = d.extraProfiles || []
        setExtraProfiles(extras)
        setPrimaryAvailable(!!d.hasSavedProfile)
        setHasSavedProfile(!!d.hasSavedProfile || extras.length > 0)
        if (!d.hasSavedProfile && extras.length) setProfileChoice(extras[0].id)
        const wanted = params.get('profile')
        if (wanted && extras.some(x => x.id === wanted)) setProfileChoice(wanted)
        setQuota(d.quota || null)
      })
      .catch(() => {}) // fail silently: worst case the saved-profile option just doesn't show
    return () => { cancelled = true }
  }, [userId])

  useEffect(() => {
    if (!loadRecent || !userId) return undefined
    let cancelled = false
    api.get('/scan/history', { params: { limit: 30 } })
      .then(res => {
        if (cancelled) return
        const rows = (res.data.data?.scans || []).filter(s => RESCANNABLE.includes(s.status))
        // One row per resume would be ideal, but the list is a person's own history: newest first, and they know their files.
        setRecent(rows.map(s => ({
          id: s.id, label: sourceLabel(s), jobTitle: s.jobTitle || null, createdAt: s.createdAt,
          score: s.fixAtsScore ?? s.atsScore ?? null,
          hasImproved: s.status === 'FIX_DELIVERED' && !!s.fixPurchased,
        })))
      })
      .catch(() => { if (!cancelled) setRecent([]) })
    return () => { cancelled = true }
  }, [userId, loadRecent])

  // Signed out while a mode that only exists for an account is open: fall back, rather than show a mode with nothing behind it.
  useEffect(() => {
    if (!userId && (entryMode === 'savedProfile' || entryMode === 'rescan')) { setEntryMode('upload'); setRescanSource(null) }
  }, [userId])

  useEffect(() => {
    if (userId && !draftOwner.current) draftOwner.current = userId
    saveBrainDumpDraft({ text: brainDumpText, name: contactName, email: contactEmail, manual: manualData, owner: draftOwner.current })
  }, [brainDumpText, contactName, contactEmail, manualData, userId])

  useEffect(() => {
    saveJdDraft({ text: jdText, url: jobUrl, useUrl, owner: draftOwner.current })
  }, [jdText, jobUrl, useUrl, userId])

  // Deep links from the landing page's "three ways to start" cards: /scan?mode=brainDump | manual.
  useEffect(() => {
    const m = params.get('mode')
    if (m === 'brainDump' || m === 'manual') setEntryMode(m)
  }, [])

  // The dashboard's "Rescan with new JD" button links here with ?mode=savedProfile. Pre-select that tab once we have
  // confirmed the profile actually exists (avoids selecting a mode that would just fail server-side).
  useEffect(() => {
    if (params.get('mode') === 'savedProfile' && hasSavedProfile) setEntryMode('savedProfile')
  }, [hasSavedProfile])

  // /scan?from=<scanId>: the earlier scan must belong to this (signed-in) user; if it can't be loaded the form just
  // stays on its normal upload mode.
  const fromScanId = params.get('from')
  useEffect(() => {
    if (!userId || !fromScanId) return undefined
    let cancelled = false
    api.get(`/scan/${encodeURIComponent(fromScanId)}`)
      .then(res => {
        const d = res.data.data
        if (cancelled || !d || !RESCANNABLE.includes(d.status)) return
        setRescanSource({
          id: d.id,
          // A delivered paid resume can be scanned instead of the original upload.
          hasImproved: d.status === 'FIX_DELIVERED' && !!d.fixPurchased && !!(d.userEditedResumeData || d.rewrittenResumeData),
          paperSize: d.paperSize || '',
          label: d.resumeOriginalName
            || (d.inputMode === 'brain_dump' ? 'the background you wrote' : d.inputMode === 'file' ? 'the resume you uploaded' : 'your saved profile'),
        })
        setPaperSize(d.paperSize || '')
        setEntryMode('rescan')
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [userId, fromScanId])

  function switchEntryMode(mode) {
    setEntryMode(mode)
    setError('')
  }

  // Picks one of the recent resumes as the source of a rescan.
  function pickRecent(item) {
    setRescanSource({ id: item.id, hasImproved: item.hasImproved, paperSize: '', label: item.label })
    setUseImproved(false)
    setEntryMode('rescan')
    setError('')
  }

  // ── What is missing, per half of the form ────────────────────────────────────────────────────────
  // `resumeIssue` and `jobIssue` are the first thing wrong with each half (null when it is ready). The page shows them as
  // the readiness lamps; submit uses the same two so the button and the lamps can never disagree.
  const needsContact = entryMode === 'brainDump' && !user
  let resumeIssue = null
  if (entryMode === 'upload' && !file) resumeIssue = 'Please upload your resume.'
  else if (entryMode === 'rescan' && !rescanSource) resumeIssue = 'We could not load that earlier scan. Upload your resume instead.'
  else if (entryMode === 'brainDump' && brainDumpText.trim().length < MIN_BRAIN_DUMP_CHARS)
    resumeIssue = `Tell us a bit more about your background (min ${MIN_BRAIN_DUMP_CHARS} characters).`
  else if (entryMode === 'manual' && !manualHasContent(manualData))
    resumeIssue = 'Add at least one job, school, project, skill or a summary first.'
  else if (entryMode === 'manual' && !user && !filled(manualData.name)) resumeIssue = 'Please enter your name.'
  else if (entryMode === 'manual' && !user && filled(manualData.email) && !EMAIL_RE.test(manualData.email.trim()))
    resumeIssue = 'Please enter a valid email address.'
  else if (entryMode === 'upload' && !user && uploadEmail.trim() && !EMAIL_RE.test(uploadEmail.trim()))
    resumeIssue = 'Please enter a valid email address, or leave it blank.'
  else if (needsContact && !contactName.trim()) resumeIssue = 'Please enter your name.'
  else if (needsContact && !EMAIL_RE.test(contactEmail.trim())) resumeIssue = 'Please enter a valid email address.'

  let jobIssue = null
  if (!useUrl && jdLength(jdText) < MIN_JD_CHARS) jobIssue = `Job description too short (min ${MIN_JD_CHARS} characters).`
  else if (useUrl && !jobUrl.trim()) jobIssue = 'Please enter a job posting URL.'

  // The free allowance is a gate, not advice: with none left the button says so instead of letting the person meet a 429.
  // A stale page can still be showing "0 left" after the clock has passed the reset, so the reset time is honoured.
  const quotaText = describeQuota(quota)
  const resetAt = quota?.resetsAt ? new Date(quota.resetsAt).getTime() : NaN
  const quotaExhausted = !!(user && quotaText?.exhausted && !(Number.isFinite(resetAt) && Date.now() >= resetAt))

  async function handleSubmit(e) {
    e?.preventDefault?.()
    if (resumeIssue) return setError(resumeIssue)
    if (jobIssue) return setError(jobIssue)
    if (quotaExhausted) return setError(quotaText.text)

    setError('')
    setLoading(true)
    const controller = new AbortController()
    uploadAbort.current = controller
    setUploadPct(0)
    try {
      const formData = new FormData()
      if (entryMode === 'upload') {
        formData.append('resume', file)
        if (!user && uploadEmail.trim()) formData.append('contactEmail', uploadEmail.trim())
      } else if (entryMode === 'savedProfile') {
        formData.append('useSavedProfile', 'true')
        if (profileChoice) formData.append('savedProfileId', profileChoice)
      } else if (entryMode === 'rescan') {
        formData.append('sourceScanId', rescanSource.id)
        if (rescanSource.hasImproved && useImproved) formData.append('rescanVersion', 'delivered')
      } else if (entryMode === 'manual') {
        formData.append('resumeDataJson', JSON.stringify(manualData))
      } else {
        formData.append('brainDumpText', brainDumpText.trim())
        if (!user) {
          formData.append('contactName', contactName.trim())
          formData.append('contactEmail', contactEmail.trim())
        }
      }
      // Only sent when it says something: a rescan whose source was set to a size and is now back on Automatic says so explicitly.
      if (paperSize) formData.append('paperSize', paperSize)
      else if (entryMode === 'rescan' && rescanSource?.paperSize) formData.append('paperSize', 'auto')
      if (useUrl && jobUrl.trim())
        formData.append('jobDescriptionUrl', jobUrl.trim())
      else
        formData.append('jobDescriptionText', jdText)

      const res = await api.post('/scan', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        signal: controller.signal,
        onUploadProgress: ev => { if (ev && ev.total > 0) setUploadPct(Math.min(100, Math.round((ev.loaded / ev.total) * 100))) },
      })
      const { scanId, anonToken } = res.data.data

      // Every anonymous scan keeps its own token, so more than the last one can be claimed on sign-up (anonScans.js).
      if (anonToken) addAnonScanToken(scanId, anonToken)
      // Which scan this draft produced: only that scan's result clears it (lib/brainDumpDraft.js).
      if (entryMode === 'brainDump') markDraftSent(scanId, 'text')
      else if (entryMode === 'manual') markDraftSent(scanId, 'manual')
      // The job was sent with the scan, so it is no longer waiting to be recovered.
      clearJdDraft()

      navigate(`/scan/${scanId}`)
    } catch (err) {
      // The person pressed "Cancel upload": nothing failed, so nothing is shown (the form keeps everything they entered).
      if (isCancelError(err)) { setError(''); return }
      const msg = getErrorMessage(err, 'Something went wrong. Please try again.')
      // A JD-URL fetch failure is always a 400 that the server names explicitly (code JD_URL_FAILED): only then did the
      // link itself fail, so only then is URL mode left. A 429 (the daily cap) or a 413 (file too large) says nothing about
      // the link, and flipping out of URL mode there threw away a perfectly good one.
      if (useUrl && err.response?.status === 400 && err.response?.data?.code === 'JD_URL_FAILED') setUseUrl(false)
      setError(msg)
    } finally {
      setLoading(false)
      setUploadPct(null)
      uploadAbort.current = null
    }
  }

  const submitLabel = entryMode === 'upload'
    ? 'Scan My Resume — Free'
    : entryMode === 'savedProfile'
      ? 'Score My Profile Against This JD — Free'
      : entryMode === 'rescan'
        ? 'Scan Against This Job — Free'
        : entryMode === 'manual'
          ? 'Score My Resume — Free'
          : 'Build & Score My Resume — Free'

  return {
    user, params,
    entryMode, switchEntryMode, setEntryMode,
    file, setFile, uploadEmail, setUploadEmail,
    brainDumpText, setBrainDumpText, restored,
    contactName, setContactName, contactEmail, setContactEmail,
    manualData, setManualData, restoredManual,
    rescanSource, useImproved, setUseImproved, pickRecent, recent,
    hasSavedProfile, extraProfiles, profileChoice, setProfileChoice, primaryAvailable,
    useUrl, setUseUrl, jobUrl, setJobUrl, jdText, setJdText, restoredJd,
    paperSize, setPaperSize,
    loading, uploadPct, cancelUpload: () => uploadAbort.current?.abort(),
    error, setError,
    quota, quotaText, quotaExhausted,
    resumeIssue, jobIssue, needsContact,
    submitLabel, handleSubmit,
  }
}
