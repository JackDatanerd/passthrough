import { useRef } from 'react'
import { Link } from 'react-router-dom'
import Button from '../ui/Button'
import Input from '../ui/Input'
import Textarea from '../ui/Textarea'
import Select from '../ui/Select'
import Checkbox from '../ui/Checkbox'
import RadioGroup from '../ui/RadioGroup'
import FileUpload from '../ui/FileUpload'
import Form from '../ui/Form'
import Alert from '../ui/Alert'
import ProgressBar from '../ui/ProgressBar'
import ResumeFieldsForm from './ResumeFieldsForm'
import PaperSizeSelect from './PaperSizeSelect'
import useScanForm, { MAX_RESUME_CHARS, MAX_JD_CHARS, MIN_JD_CHARS, jdLength } from './useScanForm'
import { formatNumber, formatDate, cn } from '../../lib/utils'
import { resetTimeLabel } from '../../lib/quota'

// The /scan page's form: the same scan as the homepage card (useScanForm holds every rule) laid out as a short track.
//   1  Your resume   five ways in, as tiles, every one ending in the same scan
//   2  The job       paste the posting or give its link
//   →  a rail that says what is missing and why the button is off, and never lets the button fail silently
// Pressing the button while something is missing does not do nothing: it takes the person to the first gap.

const ICONS = {
  upload: 'M12 16V4m0 0-4 4m4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3',
  reuse: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5',
  saved: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  write: 'M4 20h4L19 9a2.1 2.1 0 0 0-4-4L4 16v4z',
  form: 'M5 5h14M5 12h14M5 19h9',
}

function Tile({ id, checked, onSelect, title, hint }) {
  return (
    <button
      type="button" role="radio" aria-checked={checked} data-tile={id} onClick={() => onSelect(id)}
      className={cn(
        'flex flex-col gap-0.5 text-left p-3 rounded-xl border-[1.5px] bg-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
        checked ? 'border-blue-700 bg-blue-50 ring-[3px] ring-blue-100' : 'border-gray-200 hover:border-gray-300',
      )}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" className={cn('w-[22px] h-[22px] mb-1 fill-none stroke-[1.8]', checked ? 'stroke-blue-700' : 'stroke-gray-500')} strokeLinecap="round" strokeLinejoin="round">
        <path d={ICONS[id]} />
      </svg>
      <span className="text-sm font-semibold text-gray-900">{title}</span>
      <span className="text-[12.5px] leading-snug text-gray-500">{hint}</span>
    </button>
  )
}

// A numbered step on a vertical track: the node fills in once its half of the form is ready.
function Step({ n, done, last, children, innerRef }) {
  return (
    <div className="grid grid-cols-[34px_1fr] gap-3.5 pb-5">
      <div className="relative" aria-hidden="true">
        <div className={cn('w-8 h-8 rounded-full border-2 grid place-items-center text-sm font-extrabold relative z-[1]',
          done ? 'bg-blue-700 border-blue-700 text-white' : 'bg-white border-gray-200 text-gray-500')}>{done ? '✓' : n}</div>
        {!last && <div className={cn('absolute left-[15px] top-9 -bottom-4 w-0.5', done ? 'bg-blue-700' : 'bg-gray-200')} />}
      </div>
      <section ref={innerRef} tabIndex={-1} className="bg-white border border-gray-200 rounded-2xl p-4 sm:p-5 shadow-sm min-w-0 focus:outline-none">{children}</section>
    </div>
  )
}

function Notice({ children }) {
  return <p role="status" className="mb-2 text-xs text-blue-800 bg-blue-50 border border-blue-100 rounded-md px-3 py-1.5">{children}</p>
}

const tileOf = mode => (mode === 'rescan' ? 'reuse' : mode === 'brainDump' ? 'write' : mode === 'manual' ? 'form' : mode === 'savedProfile' ? 'saved' : 'upload')

export default function ScanComposer() {
  const f = useScanForm({ loadRecent: true })
  const { user, entryMode, rescanSource, recent } = f
  const resumeRef = useRef(null)
  const jobRef = useRef(null)

  // Reusable resumes: the recent list, plus the one a link pointed at when it is older than the list reaches.
  const reusable = [...(recent || [])]
  if (rescanSource && !reusable.some(r => r.id === rescanSource.id)) {
    reusable.unshift({ id: rescanSource.id, label: rescanSource.label, hasImproved: rescanSource.hasImproved, createdAt: null, score: null, jobTitle: null })
  }
  const canReuse = !!user && reusable.length > 0

  function selectTile(id) {
    if (id === 'upload') f.switchEntryMode('upload')
    else if (id === 'write') f.switchEntryMode('brainDump')
    else if (id === 'form') f.switchEntryMode('manual')
    else if (id === 'saved') f.switchEntryMode('savedProfile')
    else if (id === 'reuse') {
      if (!rescanSource && reusable[0]) f.pickRecent(reusable[0])
      else f.switchEntryMode('rescan')
    }
  }

  const resumeReady = !f.resumeIssue
  const jobReady = !f.jobIssue
  const ready = resumeReady && jobReady && !f.quotaExhausted
  // The pill above already says the allowance is used; the line by the button says what happens next.
  const comesBack = resetTimeLabel(f.quota)
  const reason = f.quotaExhausted ? (comesBack ? `Your free scans come back at ${comesBack}.` : 'Your free scans come back tomorrow.') : f.resumeIssue || f.jobIssue || ''

  // What the rail shows for each half: the thing chosen, or that nothing is yet.
  const resumeSummary = !resumeReady ? 'Not added yet'
    : entryMode === 'upload' ? (f.file?.name || 'Your file')
      : entryMode === 'rescan' ? rescanSource?.label
        : entryMode === 'savedProfile' ? 'Your saved profile'
          : entryMode === 'brainDump' ? `${formatNumber(f.brainDumpText.trim().length)} characters` : 'Filled in by you'
  const jobSummary = !jobReady ? 'Not added yet' : f.useUrl ? 'Link added' : `${formatNumber(f.jdText.length)} characters pasted`

  function focusFirstGap() {
    const target = !resumeReady ? resumeRef.current : jobRef.current
    if (!target) return
    target.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    // The first control inside the half that is missing something; the section itself when it holds none.
    const control = target.querySelector('textarea, input:not([type=file]):not([type=radio]), select, [role=button], button[role=radio][aria-checked=true]')
    ;(control || target).focus?.()
  }

  function onAction(e) {
    e.preventDefault()
    if (f.loading) return
    if (ready) return f.handleSubmit(e)
    if (f.quotaExhausted) return
    focusFirstGap()
  }

  const jdCount = jdLength(f.jdText)
  const jdOk = jdCount >= MIN_JD_CHARS

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
        <div>
          <h1 className="font-display text-[clamp(1.6rem,3.2vw,2.1rem)] font-extrabold tracking-[-0.02em] leading-tight text-ink">Check a resume against a job</h1>
          <p className="mt-1 text-sm text-gray-600">Free, about 30 seconds. Scored the way employers’ filters score it.</p>
        </div>
        {user
          ? f.quotaText && (
            <span className={cn('text-[13px] font-semibold px-3 py-1.5 rounded-full', f.quotaExhausted ? 'bg-amber-100 text-amber-800' : 'bg-blue-100 text-blue-800')}>
              {f.quotaText.text}
            </span>
          )
          : <span className="text-[13px] font-semibold px-3 py-1.5 rounded-full bg-blue-100 text-blue-800">No account needed</span>}
      </div>

      <Form onSubmit={onAction} className="grid gap-5 lg:grid-cols-[1fr_320px] lg:items-start">
        <div className="min-w-0">
          <Step n={1} done={resumeReady} innerRef={resumeRef}>
            <h2 className="font-display text-lg font-extrabold text-ink">Your resume</h2>
            <p className="text-xs text-gray-500">Start with what you have. Every route ends in the same scan.</p>
            <div role="radiogroup" aria-label="How do you want to give us your resume?" className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2.5 my-3">
              <Tile id="upload" checked={tileOf(entryMode) === 'upload'} onSelect={selectTile} title="Upload it" hint="PDF or DOCX, up to 5 MB" />
              {canReuse && <Tile id="reuse" checked={tileOf(entryMode) === 'reuse'} onSelect={selectTile} title="Reuse a recent one" hint="Same resume, new job" />}
              {user && f.hasSavedProfile && <Tile id="saved" checked={tileOf(entryMode) === 'saved'} onSelect={selectTile} title="Saved profile" hint={f.extraProfiles.length ? `Main profile and ${f.extraProfiles.length} other${f.extraProfiles.length === 1 ? '' : 's'}` : 'Your saved background'} />}
              <Tile id="write" checked={tileOf(entryMode) === 'write'} onSelect={selectTile} title="Start from scratch" hint="Describe your background" />
              <Tile id="form" checked={tileOf(entryMode) === 'form'} onSelect={selectTile} title="Fill it in myself" hint="Nothing rewritten before scoring" />
            </div>

            {entryMode === 'upload' && <FileUpload value={f.file} onFile={f.setFile} />}

            {entryMode === 'rescan' && (
              <div>
                <RadioGroup
                  legend="Recent resumes" srOnlyLegend value={rescanSource?.id} className="flex flex-col gap-2"
                  onChange={id => f.pickRecent(reusable.find(r => r.id === id))}
                  options={reusable.map(r => ({
                    value: r.id, label: r.label,
                    description: [r.jobTitle ? `Last scored for ${r.jobTitle}` : null, r.createdAt ? formatDate(r.createdAt) : null, r.score != null ? `score ${r.score}` : null].filter(Boolean).join(' · ') || undefined,
                  }))}
                />
                {rescanSource?.hasImproved && (
                  <Checkbox
                    wrapperClassName="mt-3" alignTop checked={f.useImproved} onChange={e => f.setUseImproved(e.target.checked)}
                    data-testid="rescan-use-improved"
                    label="Scan my improved version instead (the fixed resume we delivered, with any edits you made)."
                  />
                )}
                <p className="mt-2 text-xs text-gray-500">This counts as one of your daily free scans. Just add the new job below.</p>
              </div>
            )}

            {entryMode === 'savedProfile' && (
              <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                <p className="text-sm text-gray-700">We’ll use your saved profile. Just add a job description and we’ll translate it fresh.</p>
                {f.extraProfiles.length > 0 && (
                  <Select label="Profile to use" wrapperClassName="mt-2" value={f.profileChoice} onChange={e => f.setProfileChoice(e.target.value)}>
                    {f.primaryAvailable && <option value="">Main profile</option>}
                    {f.extraProfiles.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </Select>
                )}
              </div>
            )}

            {entryMode === 'brainDump' && (
              <div>
                {f.restored && <Notice>We kept what you were writing last time — it’s back in the box below.</Notice>}
                <Textarea
                  aria-label="Your background, in your own words"
                  placeholder="Tell us about your work in your own words — companies, roles, what you actually did. Doesn't need to be tidy, we'll structure it for you."
                  value={f.brainDumpText} rows={8}
                  onChange={e => f.setBrainDumpText(e.target.value.slice(0, MAX_RESUME_CHARS))}
                />
                <div className="mt-1 flex items-start justify-between gap-3">
                  <p className="text-xs text-gray-500">Numbers help: team size, budget, % improved, users served. Links too, if you have them.</p>
                  <span className={cn('shrink-0 text-xs tabular-nums', f.brainDumpText.length >= MAX_RESUME_CHARS ? 'text-red-600 font-medium' : f.brainDumpText.length >= MAX_RESUME_CHARS * 0.9 ? 'text-amber-600' : 'text-gray-400')}>
                    {formatNumber(f.brainDumpText.length)} / {formatNumber(MAX_RESUME_CHARS)}
                  </span>
                </div>
                {f.brainDumpText.length >= MAX_RESUME_CHARS && (
                  <p className="mt-1 text-xs text-red-600">You’ve hit the length limit — anything past this point won’t be included. Trim less-relevant details to make room.</p>
                )}
                {!user && (
                  <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Input placeholder="Your full name" aria-label="Your full name" autoComplete="name" value={f.contactName} onChange={e => f.setContactName(e.target.value)} />
                    <Input type="email" placeholder="Your email" aria-label="Your email" autoComplete="email" value={f.contactEmail} onChange={e => f.setContactEmail(e.target.value)} />
                    <p className="col-span-full text-xs text-gray-500">We ask separately so your resume header isn’t blank, and we email you a link back to your result. It works for 24 hours.</p>
                  </div>
                )}
              </div>
            )}

            {entryMode === 'manual' && (
              <div>
                {f.restoredManual && <Notice>We kept what you were filling in last time — it’s back in the form below.</Notice>}
                <p className="text-xs text-gray-500 mb-3">Fill in what you have. Nothing is guessed or rewritten before your score, and you can add more any time after.</p>
                <div className="flex flex-col gap-5"><ResumeFieldsForm draft={f.manualData} setDraft={f.setManualData} /></div>
                {!user && <p className="mt-3 text-xs text-gray-500">Your name is required. If you add an email we’ll send you a link back to your result; it works for 24 hours.</p>}
              </div>
            )}
          </Step>

          <Step n={2} done={jobReady} last innerRef={jobRef}>
            <h2 className="font-display text-lg font-extrabold text-ink">The job</h2>
            <p className="text-xs text-gray-500 mb-3">The more of the posting we see, the more accurate the score.</p>
            {f.restoredJd && <Notice>We kept the job you were adding last time — it’s back below.</Notice>}
            <div role="group" aria-label="How to add the job" className="inline-flex rounded-md overflow-hidden border border-gray-300 text-sm mb-3">
              <button type="button" aria-pressed={!f.useUrl} onClick={() => f.setUseUrl(false)}
                className={cn('px-3 py-2.5 sm:py-1.5 transition-colors', !f.useUrl ? 'bg-blue-700 text-white' : 'bg-white text-gray-600 hover:bg-gray-50')}>Paste text</button>
              <button type="button" aria-pressed={f.useUrl} onClick={() => f.setUseUrl(true)}
                className={cn('px-3 py-2.5 sm:py-1.5 transition-colors', f.useUrl ? 'bg-blue-700 text-white' : 'bg-white text-gray-600 hover:bg-gray-50')}>Job link</button>
            </div>
            {f.useUrl ? (
              <div>
                <Input label="Link to the employer’s own posting" placeholder="https://jobs.example.com/product-manager-123" value={f.jobUrl} onChange={e => f.setJobUrl(e.target.value)} />
                <p className="mt-1 text-xs text-gray-500">LinkedIn links can’t be read automatically — paste the text instead. A very long posting is trimmed to its role and requirements; your result shows the text that was scored.</p>
              </div>
            ) : (
              <div>
                <Textarea aria-label="Job description" placeholder="Paste the full job description here…" value={f.jdText} onChange={e => f.setJdText(e.target.value)} rows={7} />
                <div className="mt-1 flex items-start justify-between gap-3">
                  <p className={cn('text-xs', f.jdText.length > MAX_JD_CHARS ? 'text-amber-700' : 'text-gray-500')}>
                    {f.jdText.length > MAX_JD_CHARS
                      ? `Longer than ${formatNumber(MAX_JD_CHARS)} characters — we'll trim the company intro, benefits and legal text first and keep the role and requirements. Your result shows what was scored.`
                      : 'Include the requirements and responsibilities.'}
                  </p>
                  <span className="shrink-0 text-xs tabular-nums flex items-center gap-1.5">
                    <span className={cn('font-bold px-2 py-0.5 rounded-full', jdOk ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800')}>{jdOk ? 'Enough to score' : 'Too short'}</span>
                    <span className={cn(f.jdText.length > MAX_JD_CHARS ? 'text-amber-700 font-medium' : 'text-gray-400')}>{formatNumber(f.jdText.length)} / {formatNumber(MAX_JD_CHARS)}</span>
                  </span>
                </div>
              </div>
            )}
            <details className="mt-4 border-t border-gray-200 pt-3">
              <summary className="cursor-pointer text-sm font-semibold text-gray-800">Options</summary>
              <div className="mt-3 grid gap-3">
                <PaperSizeSelect value={f.paperSize} onChange={f.setPaperSize} disabled={f.loading} />
                {!user && entryMode === 'upload' && (
                  <div>
                    <Input type="email" label="Email me the result link (optional)" placeholder="you@example.com" value={f.uploadEmail} onChange={e => f.setUploadEmail(e.target.value)} />
                    <p className="mt-1 text-xs text-gray-500">Without an account your result is only reachable from this browser. We use the address for that link and nothing else.</p>
                  </div>
                )}
              </div>
            </details>
          </Step>
        </div>

        <aside aria-label="Scan summary" className="lg:sticky lg:top-4">
          <div className="bg-white border border-gray-200 rounded-2xl p-4 sm:p-5 shadow-sm">
            <h2 className="text-[13px] font-bold uppercase tracking-wider text-gray-500 mb-3">Your scan</h2>
            <ul className="grid gap-2 mb-4 text-sm">
              {[['Resume', resumeReady, resumeSummary], ['Job', jobReady, jobSummary]].map(([label, ok, text]) => (
                <li key={label} className="flex gap-2.5">
                  <span aria-hidden="true" className={cn('w-5 h-5 mt-0.5 shrink-0 rounded-full border-2 grid place-items-center text-xs font-extrabold text-white', ok ? 'bg-green-700 border-green-700' : 'border-gray-200')}>{ok ? '✓' : ''}</span>
                  <div className="min-w-0"><span className="font-semibold text-gray-900">{label}</span><span className="sr-only">{ok ? ' ready' : ' missing'}</span>
                    <small className="block text-gray-500 truncate">{text}</small></div>
                </li>
              ))}
            </ul>
            <Alert focusOnShow>{f.error}</Alert>
            {/* Sticky to the foot of a phone's screen; part of the rail from lg up. */}
            <div className="sticky bottom-0 -mx-4 sm:-mx-5 px-4 sm:px-5 pt-3 pb-3 bg-white/95 backdrop-blur border-t border-gray-100 lg:static lg:mx-0 lg:px-0 lg:pb-0 lg:bg-transparent lg:border-0 lg:backdrop-blur-none"
              style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom, 0px))' }}>
              <Button type="submit" size="lg" loading={f.loading} aria-describedby="scan-reason"
                {...(!ready && !f.loading ? { 'aria-disabled': true } : {})}
                className={cn('w-full shadow-[0_3px_0_#1e3a8a] active:translate-y-0.5 active:shadow-[0_1px_0_#1e3a8a]', !ready && !f.loading && '!bg-gray-200 hover:!bg-gray-200 !text-gray-600 !shadow-none cursor-not-allowed')}>
                {f.submitLabel}
              </Button>
              {/* Never silently disabled: what is missing is said here, and pressing the button takes the person to it. */}
              <p id="scan-reason" role="status" className={cn('mt-2 min-h-[1.25rem] text-[12.5px]', f.quotaExhausted ? 'text-amber-800 font-semibold' : 'text-gray-500')}>
                {f.loading ? '' : reason}
                {f.quotaExhausted && <> <Link to="/dashboard" className="underline">See your scans</Link></>}
              </p>
              {f.loading && entryMode === 'upload' && f.uploadPct !== null && (
                <div className="flex flex-col gap-1 mt-1">
                  <ProgressBar value={f.uploadPct} label="Uploading your resume" doneLabel="Reading your resume…" />
                  {f.uploadPct < 100 && (
                    <button type="button" onClick={f.cancelUpload} className="self-start text-xs text-gray-600 underline hover:text-red-600">Cancel upload</button>
                  )}
                </div>
              )}
            </div>
            <ul className="mt-4 pt-4 border-t border-gray-200 grid gap-1.5 text-[13.5px] text-ink-2">
              {['A score out of 100', 'The exact reasons you’d be filtered out', 'Free — pay only if you want the fix'].map(t => (
                <li key={t}><span className="text-green-700 font-extrabold" aria-hidden="true">✓ </span>{t}</li>
              ))}
            </ul>
            {!user && <p className="mt-3 text-xs text-gray-500">Without an account, your result is kept for 24 hours. Create a free account to keep it.</p>}
          </div>
        </aside>
      </Form>
    </div>
  )
}
