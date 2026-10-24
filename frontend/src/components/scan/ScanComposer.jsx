import { useRef } from 'react'
import { Link } from 'react-router-dom'
import { usePricing } from '../../hooks/usePricing'
import { ANON_SCANS_PER_HOUR, FREE_SCANS_PER_DAY } from '../../lib/scoreThresholds'
import Button from '../ui/Button'
import Input from '../ui/Input'
import Select from '../ui/Select'
import Checkbox from '../ui/Checkbox'
import RadioGroup from '../ui/RadioGroup'
import FileUpload from '../ui/FileUpload'
import Form from '../ui/Form'
import Alert from '../ui/Alert'
import ProgressBar from '../ui/ProgressBar'
import ResumeFieldsForm from './ResumeFieldsForm'
import PaperSizeSelect from './PaperSizeSelect'
import useScanForm, { MAX_RESUME_CHARS, MAX_JD_CHARS, MIN_JD_CHARS, MIN_BRAIN_DUMP_CHARS, jdLength } from './useScanForm'
import { formatNumber, formatDate, cn } from '../../lib/utils'
import { resetTimeLabel } from '../../lib/quota'

// The /scan page: the scan as one short desk. A title row (with the allowance drawn as pips, or the honest limits for a visitor),
// a rail that shows the finish line (Resume, Job, Score), two panels side by side, and an action bar that is always on screen and
// always says what is missing. useScanForm holds every rule; this file only lays them out.
// Pressing the button while something is missing does not do nothing: it explains, and takes the person to the first gap.

const labelCls = 'block text-[13px] font-semibold text-gray-700 mb-1'
const fieldCls = 'w-full rounded-[10px] border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900 focus:outline-none focus:border-blue-700 focus:ring-[3px] focus:ring-blue-200'

function Source({ id, checked, onSelect, title, hint, disabled = false }) {
  return (
    <button
      type="button" role="radio" aria-checked={checked} data-tile={id} tabIndex={checked ? 0 : -1} disabled={disabled} onClick={() => onSelect(id)}
      className={cn(
        'flex flex-col gap-0.5 text-left px-3 py-2.5 rounded-xl border-[1.5px] bg-white transition-colors disabled:opacity-60 disabled:cursor-default focus:outline-none focus-visible:ring-[3px] focus-visible:ring-blue-200',
        '[&:last-child:nth-child(odd)]:col-span-2 max-[430px]:[&:last-child:nth-child(odd)]:col-span-1',
        checked ? 'border-blue-700 bg-blue-50 shadow-[inset_0_0_0_1px_#1d4ed8]' : 'border-gray-200 hover:border-blue-200 hover:bg-gray-50',
      )}
    >
      <b className="text-sm text-gray-900">{title}</b>
      <span className="text-xs leading-snug text-gray-500">{hint}</span>
    </button>
  )
}

function Panel({ n, title, ready, innerRef, children }) {
  return (
    <section ref={innerRef} tabIndex={-1} aria-labelledby={`scan-panel-${n}`} className="rounded-2xl border border-gray-200 bg-white p-[18px] shadow-[0_1px_2px_rgba(10,21,48,.04)] focus:outline-none min-w-0">
      <h2 id={`scan-panel-${n}`} className="mb-3 flex items-center gap-2 font-display text-lg font-extrabold tracking-[-0.02em] text-ink">
        <span aria-hidden="true" className="grid h-6 w-6 place-items-center rounded-[7px] bg-blue-700 text-[13px] font-bold text-white font-sans">{n}</span>
        {title}
        {ready && <span className="ml-auto rounded-full bg-green-100 px-2.5 py-0.5 font-sans text-xs font-bold text-green-700">Ready</span>}
      </h2>
      {children}
    </section>
  )
}

function Notice({ children }) {
  return <p role="status" className="mb-2 text-xs text-blue-800 bg-blue-50 border border-blue-100 rounded-md px-3 py-1.5">{children}</p>
}

// The rail: the logo's own gesture, an arrow passing through two bars. Nodes fill in as each half is ready.
function RailNode({ n, label, state }) {
  return (
    <div className={cn('flex items-center gap-2 whitespace-nowrap', state === 'done' ? 'text-ink' : '')}>
      <i className={cn('grid h-[22px] w-[22px] place-items-center rounded-full border-2 text-[11px] not-italic transition-colors',
        state === 'done' ? 'border-green-700 bg-green-700 text-white' : state === 'next' ? 'border-blue-700 bg-white text-blue-700' : 'border-gray-300 bg-white text-gray-500')}>{state === 'done' ? '\u2713' : n}</i>
      {label}
    </div>
  )
}
function RailLine({ on }) {
  return (
    <div className={cn('relative mx-2.5 h-0.5 min-w-[18px] flex-1', on ? 'bg-[#FFE27A]' : 'bg-gray-200')}>
      {on && <span className="absolute -right-px -top-1 h-[9px] w-[9px] rotate-45 border-r-2 border-t-2 border-[#D9A400]" />}
    </div>
  )
}

function Lamp({ label, on, text }) {
  return (
    <span className={cn('flex min-w-0 items-center gap-2', on ? 'text-ink' : 'text-gray-500')} data-lamp={label.toLowerCase()} data-on={on ? 'true' : 'false'}>
      <i aria-hidden="true" className={cn('h-[9px] w-[9px] shrink-0 rounded-full transition-all', on ? 'bg-green-500 shadow-[0_0_0_3px_#dcfce7]' : 'bg-gray-300')} />
      <span className="min-w-0">
        <b className="block text-[13px]">{label}</b>
        <small className={cn('block max-w-[170px] truncate text-[11.5px] font-medium', on ? 'text-green-700' : 'text-gray-500')}>{text}</small>
        <span className="sr-only">{on ? ' ready' : ' missing'}</span>
      </span>
    </span>
  )
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
  const reuseLoading = !!user && recent === null && !canReuse
  const { pricing } = usePricing('')
  const anonPerHour = pricing?.anonScansPerHour ?? ANON_SCANS_PER_HOUR
  const freePerDay = pricing?.freeScansPerDay ?? FREE_SCANS_PER_DAY

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

  // A radio group moves with the arrow keys (one stop in the Tab order, the chosen tile), like every other radio group.
  function onTileKeys(e) {
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]
    if (!dir) return
    const tiles = [...e.currentTarget.querySelectorAll('[role=radio]:not(:disabled)')]
    const at = tiles.indexOf(document.activeElement)
    if (at < 0) return
    e.preventDefault()
    const next = tiles[(at + dir + tiles.length) % tiles.length]
    next.focus()
    next.click()
  }

  const resumeReady = !f.resumeIssue
  const jobReady = !f.jobIssue
  const ready = resumeReady && jobReady && !f.quotaExhausted
  const comesBack = resetTimeLabel(f.quota)

  const jdCount = jdLength(f.jdText)
  const jdOk = jdCount >= MIN_JD_CHARS
  // The posting meter: short is red and says how many more, thin is amber, a full posting is green.
  const meter = jdCount < MIN_JD_CHARS
    ? { tone: 'bad', msg: jdCount === 0 ? `Paste the posting, at least ${MIN_JD_CHARS} characters` : `${MIN_JD_CHARS - jdCount} more characters needed`, pct: Math.max(3, (jdCount / MIN_JD_CHARS) * 30) }
    : jdCount < 400 ? { tone: 'mid', msg: 'Works, but a full posting scores more accurately', pct: 30 + (jdCount / 400) * 30 }
      : jdCount > MAX_JD_CHARS ? { tone: 'mid', msg: 'Long. We trim the intro and benefits, keep the requirements', pct: 100 }
        : { tone: 'ok', msg: 'Looks like a full posting', pct: Math.min(100, 60 + (jdCount / MAX_JD_CHARS) * 40) }
  const tone = { bad: ['text-red-700', 'bg-red-400'], mid: ['text-amber-700', 'bg-amber-500'], ok: ['text-green-700', 'bg-green-500'] }[meter.tone]

  const resumeSummary = !resumeReady ? 'Not added yet'
    : entryMode === 'upload' ? (f.file?.name || 'Your file')
      : entryMode === 'rescan' ? rescanSource?.label
        : entryMode === 'savedProfile' ? 'Your saved profile'
          : entryMode === 'brainDump' ? `${formatNumber(f.brainDumpText.trim().length)} characters` : 'Filled in by you'
  const jobSummary = !jobReady ? 'Not added yet' : f.useUrl ? 'Link added' : `${formatNumber(jdCount)} characters pasted`

  // The line beside the button: never silent, and in the voice of the page.
  const brainOk = entryMode === 'brainDump' && f.brainDumpText.trim().length >= MIN_BRAIN_DUMP_CHARS
  const remaining = f.quota && Number.isFinite(f.quota.remaining) ? Math.max(0, f.quota.remaining) : null
  let barMsg
  if (f.quotaExhausted) barMsg = <><b className="text-ink">No free scans left today.</b> Pick a next step above.</>
  else if (!resumeReady) {
    barMsg = brainOk && f.resumeIssue ? 'Add your name and a valid email to continue.'
      : entryMode === 'brainDump' ? `Tell us a bit more about your background (${MIN_BRAIN_DUMP_CHARS} characters or more).`
        : entryMode === 'manual' ? 'Add your details to continue.' : 'Add your resume to continue.'
  } else if (!jobReady) {
    barMsg = f.jobLink === 'blocked' ? <><b className="text-ink">That site can’t be read.</b> Switch to paste to continue.</> : f.useUrl && f.jobLink === 'bad' ? 'Fix the link to continue.' : 'Add the job to continue.'
  } else barMsg = <><b className="text-ink">Ready.</b> About 30 seconds{user ? (remaining != null ? `. Uses 1 of your ${remaining} free scan${remaining === 1 ? '' : 's'}.` : '.') : '. No account needed.'}</>

  function focusFirstGap() {
    const target = !resumeReady ? resumeRef.current : jobRef.current
    if (!target) return
    target.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    // The first control inside the half that is missing something, never one of the source cards (they come first in the
    // page and are not what is missing); the panel itself when it holds none.
    const control = [...target.querySelectorAll('textarea, input:not([type=file]):not([type=radio]), select, [role=button], input[type=radio]:checked')]
      .find(el => !el.closest('[data-tiles]'))
    ;(control || target).focus?.()
  }

  function onAction(e) {
    e.preventDefault()
    if (f.loading) return
    if (ready) return f.handleSubmit(e)
    if (f.quotaExhausted) return
    focusFirstGap()
  }

  const limit = f.quota && Number.isFinite(f.quota.limit) ? f.quota.limit : null

  return (
    <div>
      {user ? (
        <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="mb-1 text-[13px] text-gray-500"><Link to="/dashboard" className="hover:underline">Scans</Link> <span aria-hidden="true">›</span> New scan</p>
            <h1 className="font-display text-[clamp(1.6rem,3.4vw,2.2rem)] font-extrabold leading-[1.05] tracking-[-0.02em] text-ink">Check your resume against a job</h1>
            <p className="mt-1.5 max-w-[48ch] text-[15px] text-gray-600">One resume, one posting. Your score and the exact fixes in about 30 seconds.</p>
          </div>
          {limit != null && remaining != null && (
            <div data-testid="quota" className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white px-3.5 py-2.5" aria-live="polite">
              <div aria-hidden="true" className="flex gap-[5px]">
                {Array.from({ length: limit }, (_, i) => <i key={i} className={cn('h-3 w-3 rounded-full transition-colors', i >= remaining ? 'bg-gray-200' : 'bg-blue-700')} />)}
              </div>
              <div>
                <b className="text-[13.5px]">{remaining} of {limit} free scan{limit === 1 ? '' : 's'} left</b>
                <small className="block text-xs leading-tight text-gray-500">{comesBack ? `${remaining === 0 ? 'Back at' : 'Resets at'} ${comesBack}, your time` : 'Resets daily'}</small>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-[clamp(1.7rem,4vw,2.6rem)] font-extrabold leading-[1.05] tracking-[-0.02em] text-ink">Does your resume get past the robot?</h1>
            <p className="mt-1.5 max-w-[48ch] text-[15px] text-gray-600">Add your resume and the job you want. No account, about 30 seconds.</p>
          </div>
          <p data-testid="anon-note" className="max-w-[46ch] rounded-xl border border-blue-100 bg-blue-50 px-3.5 py-2.5 text-[13px] text-blue-900">
            <b>Without an account:</b> {anonPerHour} free scan{anonPerHour === 1 ? '' : 's'} an hour, result kept for 24 hours.{' '}
            <Link to="/register?next=%2Fscan" className="font-bold underline underline-offset-2">Create a free account</Link> for {freePerDay} a day, saved for good.
          </p>
        </div>
      )}

      <div aria-hidden="true" data-testid="rail" className="mb-3.5 mt-0.5 flex items-center text-[12.5px] font-bold text-gray-500">
        <RailNode n={1} label="Resume" state={resumeReady ? 'done' : 'next'} />
        <RailLine on={resumeReady} />
        <RailNode n={2} label="Job" state={resumeReady && jobReady ? 'done' : resumeReady ? 'next' : ''} />
        <RailLine on={resumeReady && jobReady} />
        <RailNode n={3} label="Score" state={resumeReady && jobReady ? 'next' : ''} />
      </div>

      <Form onSubmit={onAction}>
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <Panel n={1} title="Your resume" ready={resumeReady} innerRef={resumeRef}>
            <div role="radiogroup" data-tiles aria-label="Where your resume comes from" onKeyDown={onTileKeys} className="mb-3 grid grid-cols-2 gap-2 max-[430px]:grid-cols-1">
              <Source id="upload" checked={tileOf(entryMode) === 'upload'} onSelect={selectTile} title="Upload a file" hint="PDF or DOCX, up to 5 MB" />
              {reuseLoading && (
                <div aria-hidden="true" data-testid="reuse-loading" className="flex flex-col gap-0.5 rounded-xl border-[1.5px] border-gray-200 bg-white px-3 py-2.5 opacity-60">
                  <b className="text-sm text-gray-900">Reuse a recent one</b>
                  <span className="text-xs leading-snug text-gray-500">Loading your resumes…</span>
                </div>
              )}
              {canReuse && <Source id="reuse" checked={tileOf(entryMode) === 'reuse'} onSelect={selectTile} title="Reuse a recent one" hint="Same resume, new job. No upload" />}
              {user && f.hasSavedProfile && <Source id="saved" checked={tileOf(entryMode) === 'saved'} onSelect={selectTile} title="Use my saved profile" hint={f.extraProfiles.length ? `Main profile and ${f.extraProfiles.length} other${f.extraProfiles.length === 1 ? '' : 's'}` : 'Your main profile'} />}
              <Source id="write" checked={tileOf(entryMode) === 'write'} onSelect={selectTile} title="Start from scratch" hint="Describe your background, we build it" />
              <Source id="form" checked={tileOf(entryMode) === 'form'} onSelect={selectTile} title="Fill it in myself" hint="Jobs, schools, skills, nothing rewritten" />
            </div>

            {entryMode === 'upload' && (
              <div>
                <FileUpload look="card" value={f.file} onFile={f.setFile} prompt="Drop your resume here" />
                {!user && (
                  <p className="mt-2 text-[12.5px] text-gray-500">
                    Optional: <input type="email" aria-label="Email me the result link (optional)" placeholder="email me the link" value={f.uploadEmail} onChange={e => f.setUploadEmail(e.target.value)}
                      className="ml-1 inline-block w-auto min-w-0 rounded-[10px] border border-gray-300 px-2 py-1 text-[12.5px] focus:outline-none focus:border-blue-700 focus:ring-[3px] focus:ring-blue-200" />
                    <span className="mt-1 block">Without an account your result is only reachable from this browser. We use the address for that link and nothing else.</span>
                  </p>
                )}
              </div>
            )}

            {entryMode === 'rescan' && (
              <div>
                <RadioGroup
                  legend="Recent resumes" srOnlyLegend value={rescanSource?.id} className="grid gap-2"
                  onChange={id => f.pickRecent(reusable.find(r => r.id === id))}
                  optionClassName={(o, checked) => cn('!flex w-full rounded-xl border-[1.5px] px-3 py-2.5', checked ? 'border-blue-700 bg-blue-50' : 'border-gray-200 bg-white')}
                  options={reusable.map(r => ({
                    value: r.id, label: r.label,
                    description: [r.jobTitle ? `Last scored for ${r.jobTitle}` : null, r.createdAt ? formatDate(r.createdAt) : null, r.score != null ? `scored ${r.score}` : null].filter(Boolean).join(' \u00b7 ') || undefined,
                  }))}
                />
                {rescanSource?.hasImproved && (
                  <Checkbox
                    wrapperClassName="mt-3" alignTop checked={f.useImproved} onChange={e => f.setUseImproved(e.target.checked)}
                    data-testid="rescan-use-improved"
                    label="Scan my improved version instead (the fixed resume we delivered, with any edits you made)."
                  />
                )}
                <p className="mt-2 text-[12.5px] text-gray-500">This counts as one of your daily free scans. Just add the new job.</p>
              </div>
            )}

            {entryMode === 'savedProfile' && (
              <div>
                {f.extraProfiles.length > 0 && (
                  <>
                    <Select label="Profile to use" value={f.profileChoice} onChange={e => f.setProfileChoice(e.target.value)}>
                      {f.primaryAvailable && <option value="">Main profile</option>}
                      {f.extraProfiles.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                    </Select>
                  </>
                )}
                <p className="mt-2 text-[12.5px] text-gray-500">We’ll use your saved profile and translate it fresh against the job you add next.</p>
              </div>
            )}

            {entryMode === 'brainDump' && (
              <div>
                {f.restored && <Notice>We kept what you were writing last time. It’s back in the box below.</Notice>}
                <textarea
                  aria-label="Your background, in your own words" rows={5} className={cn(fieldCls, 'min-h-[132px] resize-y')}
                  placeholder="Companies, roles, what you actually did. It doesn’t need to be tidy."
                  value={f.brainDumpText} onChange={e => f.setBrainDumpText(e.target.value.slice(0, MAX_RESUME_CHARS))}
                />
                <div className="mt-1.5 flex justify-between gap-2.5 text-[12.5px]">
                  <span className={cn('font-semibold', brainOk ? 'text-green-700' : 'text-gray-500')}>
                    {brainOk ? 'Good, that’s enough to build from' : `${MIN_BRAIN_DUMP_CHARS - f.brainDumpText.trim().length} more characters to go`}
                  </span>
                  <span className={cn('tabular-nums', f.brainDumpText.length >= MAX_RESUME_CHARS ? 'font-medium text-red-600' : 'text-gray-500')}>{formatNumber(f.brainDumpText.length)} / {formatNumber(MAX_RESUME_CHARS)}</span>
                </div>
                <p className="mt-1 text-[12.5px] text-gray-500">Numbers help: team size, budget, % improved, users served. Links too, if you have them.</p>
                {f.brainDumpText.length >= MAX_RESUME_CHARS && (
                  <p className="mt-1 text-xs text-red-600">You’ve hit the length limit. Anything past this point won’t be included. Trim less-relevant details to make room.</p>
                )}
                {!user && (
                  <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    <div><label className={labelCls} htmlFor="scan-c-name">Your full name</label><input id="scan-c-name" className={fieldCls} autoComplete="name" value={f.contactName} onChange={e => f.setContactName(e.target.value)} /></div>
                    <div><label className={labelCls} htmlFor="scan-c-mail">Your email</label><input id="scan-c-mail" type="email" className={fieldCls} autoComplete="email" inputMode="email" value={f.contactEmail} onChange={e => f.setContactEmail(e.target.value)} /></div>
                    <p className="col-span-full text-[12.5px] text-gray-500">So your resume header isn’t blank, and so we can email you a link back to the result (works for 24 hours).</p>
                  </div>
                )}
              </div>
            )}

            {entryMode === 'manual' && (
              <div>
                {f.restoredManual && <Notice>We kept what you were filling in last time. It’s back in the form below.</Notice>}
                <p className="mb-3 text-[12.5px] text-gray-500">Type your details into a form. Nothing is guessed or rewritten before your score, and you can add more any time after.</p>
                <div className="flex flex-col gap-5"><ResumeFieldsForm draft={f.manualData} setDraft={f.setManualData} /></div>
                {!user && <p className="mt-3 text-[12.5px] text-gray-500">Your name is required. If you add an email we’ll send you a link back to your result; it works for 24 hours.</p>}
              </div>
            )}
          </Panel>

          <Panel n={2} title="The job" ready={jobReady} innerRef={jobRef}>
            {f.restoredJd && <Notice>We kept the job you were adding last time. It’s back below.</Notice>}
            <div role="group" aria-label="How to add the job" className="mb-2.5 inline-flex overflow-hidden rounded-[9px] border border-gray-300 text-[13px] font-semibold">
              <button type="button" aria-pressed={!f.useUrl} onClick={() => f.setUseUrl(false)}
                className={cn('px-3.5 py-1.5 transition-colors', !f.useUrl ? 'bg-blue-700 text-white' : 'bg-white text-gray-600 hover:bg-gray-50')}>Paste text</button>
              <button type="button" aria-pressed={f.useUrl} onClick={() => f.setUseUrl(true)}
                className={cn('px-3.5 py-1.5 transition-colors', f.useUrl ? 'bg-blue-700 text-white' : 'bg-white text-gray-600 hover:bg-gray-50')}>From a link</button>
            </div>
            {f.useUrl ? (
              <div>
                <input aria-label="Job posting link" placeholder="https://jobs.example.com/product-manager" value={f.jobUrl} onChange={e => f.setJobUrl(e.target.value)}
                  inputMode="url" autoComplete="off" aria-invalid={f.jobLink === 'bad' || f.jobLink === 'blocked' ? true : undefined} className={fieldCls} />
                {f.jobLink === 'blocked' && (
                  <p role="alert" data-testid="link-blocked" className="mt-2 rounded-[10px] border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
                    <b>LinkedIn can’t be read automatically.</b> Copy the posting text instead.{' '}
                    <button type="button" onClick={() => f.setUseUrl(false)} className="text-[13px] text-blue-700 underline underline-offset-2">Switch to paste</button>
                  </p>
                )}
                {f.jobLink === 'bad' && <p role="alert" data-testid="link-bad" className="mt-2 rounded-[10px] border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-900">That doesn’t look like a web address.</p>}
                {f.jobLink === 'ok' && <p data-testid="link-ok" className="mt-2 rounded-[10px] border border-green-200 bg-green-50 px-3 py-2 text-[13px] text-green-900">Looks good. We’ll read the page when you scan. If it can’t be read, you come straight back here with everything you entered.</p>}
                <p className="mt-2 text-[12.5px] text-gray-500">Best results: the employer’s own posting, not a job-board repost.</p>
              </div>
            ) : (
              <div>
                <textarea aria-label="Job description" placeholder="Paste the full job description here…" rows={7} value={f.jdText} onChange={e => f.setJdText(e.target.value)} className={cn(fieldCls, 'min-h-[132px] resize-y')} />
                <div aria-hidden="true" className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-100"><i className={cn('block h-full transition-[width,background-color] duration-200', tone[1])} style={{ width: `${meter.pct}%` }} /></div>
                <div className="mt-1.5 flex justify-between gap-2.5 text-[12.5px]">
                  <span data-testid="jd-meter-msg" className={cn('font-semibold', tone[0])}>{meter.msg}</span>
                  <span className={cn('tabular-nums', jdCount > MAX_JD_CHARS ? 'font-medium text-amber-700' : 'text-gray-500')}>{formatNumber(jdCount)} / {formatNumber(MAX_JD_CHARS)}</span>
                </div>
                <span className="sr-only">{jdOk ? 'Enough to score' : 'Too short'}</span>
              </div>
            )}
            <details className="mt-3 text-[13px] text-gray-600">
              <summary className="cursor-pointer font-semibold">Options</summary>
              <div className="mt-2"><PaperSizeSelect value={f.paperSize} onChange={f.setPaperSize} disabled={f.loading} /></div>
            </details>
          </Panel>
        </div>

        {f.quotaExhausted && (
          <div role="status" data-testid="spent" className="mt-4 rounded-[14px] border border-amber-200 bg-amber-50 p-4">
            <b className="block text-[15px] text-amber-900">That’s today’s {limit ?? 3} free scans.</b>
            <p className="mb-2.5 mt-1 text-[13.5px] text-amber-800">They come back at {comesBack || 'midnight UTC'}{comesBack ? ', your time' : ''}. In the meantime your results are waiting.</p>
            <div className="flex flex-wrap gap-2.5">
              <Link to="/dashboard" className="rounded-[9px] border border-gray-300 bg-white px-3.5 py-2 text-[13.5px] font-semibold text-gray-700 hover:bg-gray-50">Review my scans</Link>
              <Link to="/dashboard" className="rounded-[9px] border border-gray-300 bg-white px-3.5 py-2 text-[13.5px] font-semibold text-gray-700 hover:bg-gray-50">Fix a scan I already ran</Link>
            </div>
          </div>
        )}

        <Alert focusOnShow className="mt-4">{f.error}</Alert>

        {/* Always on screen, always says what is missing; the button is never silently grey. */}
        <div className="sticky bottom-0 z-[3] -mx-4 mt-4 flex flex-wrap items-center gap-x-4 gap-y-2.5 border-t border-gray-200 bg-white/95 px-4 pt-3 backdrop-blur"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom, 0px))' }}>
          <div className="flex gap-[18px]" aria-label="What is ready">
            <Lamp label="Resume" on={resumeReady} text={resumeSummary} />
            <Lamp label="Job" on={jobReady} text={jobSummary} />
          </div>
          <p id="scan-reason" role="status" aria-live="polite" className="min-w-[140px] flex-1 text-[13px] text-gray-600 max-sm:order-3 max-sm:basis-full max-sm:text-center">{f.loading ? '' : barMsg}</p>
          <Button type="submit" size="lg" loading={f.loading} aria-describedby="scan-reason"
            {...(!ready && !f.loading ? { 'aria-disabled': true } : {})}
            className={cn('shadow-[0_3px_0_#1e3a8a] active:translate-y-0.5 active:shadow-[0_1px_0_#1e3a8a] max-sm:w-full', !ready && !f.loading && '!bg-gray-300 hover:!bg-gray-300 !text-white !shadow-[0_3px_0_#b6bcc6] cursor-not-allowed')}>
            {f.submitLabel} <span aria-hidden="true">→</span>
          </Button>
          {f.loading && entryMode === 'upload' && f.uploadPct !== null && (
            <div className="flex basis-full flex-col gap-1">
              <ProgressBar value={f.uploadPct} label="Uploading your resume" doneLabel="Reading your resume" />
              {f.uploadPct < 100 && (
                <button type="button" onClick={f.cancelUpload} className="self-start text-xs text-gray-600 underline hover:text-red-600">Cancel upload</button>
              )}
            </div>
          )}
        </div>
      </Form>

      <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1.5 pb-5 pt-3.5 text-xs text-gray-500">
        {[user ? 'Saved to your dashboard' : 'No account needed', 'Full breakdown free', 'Pay only if you want the fix'].map(t => (
          <li key={t}><span aria-hidden="true" className="font-extrabold text-green-600">✓ </span>{t}</li>
        ))}
      </ul>

      {!user && (
        <div className="grid gap-2.5 pb-6 sm:grid-cols-3">
          {[['1 · See your score', 'Free', 'Keyword gaps and formatting problems, specific and fixable.'],
            ['2 · See what’s wrong', 'Free', 'Scored the way Workday, Greenhouse, iCIMS and others filter.'],
            ['3 · Fix & verify', '', 'Rewrite, ATS-ready files, and a link employers can check.']].map(([h, tag, t]) => (
            <div key={h} className="rounded-xl border border-gray-200 bg-white p-3 text-[13px] text-gray-600">
              <b className="mb-0.5 block text-sm text-ink">{h}{tag && <em className="ml-1.5 rounded-full bg-green-100 px-2 py-px text-[11px] font-bold not-italic text-green-700">{tag}</em>}</b>{t}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
