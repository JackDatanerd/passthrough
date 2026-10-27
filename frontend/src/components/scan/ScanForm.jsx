import Button from '../ui/Button'
import Input from '../ui/Input'
import Textarea from '../ui/Textarea'
import Select from '../ui/Select'
import Checkbox from '../ui/Checkbox'
import FileUpload from '../ui/FileUpload'
import Form from '../ui/Form'
import Alert from '../ui/Alert'
import ProgressBar from '../ui/ProgressBar'
import ResumeFieldsForm from './ResumeFieldsForm'
import PaperSizeSelect from './PaperSizeSelect'
import useScanForm, { MAX_RESUME_CHARS } from './useScanForm'
import JdMeter from './JdMeter'
import JobLinkFeedback from './JobLinkFeedback'
import { usePricing } from '../../hooks/usePricing'
import { ANON_SCANS_PER_HOUR, FREE_SCANS_PER_DAY } from '../../lib/scoreThresholds'
import { formatNumber } from '../../lib/utils'

// The compact scan card (homepage hero, and anywhere a small form is wanted). All of its state and rules live in
// useScanForm, shared with the full /scan page (ScanComposer.jsx), so the two cannot drift apart.
export default function ScanForm() {
  const {
    user, entryMode, switchEntryMode, file, setFile, uploadEmail, setUploadEmail,
    brainDumpText, setBrainDumpText, restored, contactName, setContactName, contactEmail, setContactEmail,
    manualData, setManualData, restoredManual, rescanSource, useImproved, setUseImproved,
    hasSavedProfile, extraProfiles, profileChoice, setProfileChoice, primaryAvailable,
    useUrl, setUseUrl, jobUrl, setJobUrl, jobLink, jdText, setJdText, restoredJd, paperSize, setPaperSize,
    loading, uploadPct, cancelUpload, error, quotaText, submitLabel, handleSubmit,
  } = useScanForm()
  const { pricing } = usePricing('')
  const anonPerHour = pricing?.anonScansPerHour ?? ANON_SCANS_PER_HOUR
  const freePerDay = pricing?.freeScansPerDay ?? FREE_SCANS_PER_DAY

  return (
    <Form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <div>
        <div className="flex rounded-md overflow-hidden border border-gray-300 text-sm mb-3 w-fit flex-wrap">
          <button type="button"
            onClick={() => switchEntryMode('upload')}
            aria-pressed={entryMode === 'upload'}
            className={`px-3 py-2.5 sm:py-1.5 transition-colors ${entryMode === 'upload' ? 'bg-blue-700 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
          >
            Upload resume
          </button>
          <button type="button"
            onClick={() => switchEntryMode('brainDump')}
            aria-pressed={entryMode === 'brainDump'}
            className={`px-3 py-2.5 sm:py-1.5 transition-colors ${entryMode === 'brainDump' ? 'bg-blue-700 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
          >
            Start from scratch
          </button>
          <button type="button"
            onClick={() => switchEntryMode('manual')}
            aria-pressed={entryMode === 'manual'}
            className={`px-3 py-2.5 sm:py-1.5 transition-colors ${entryMode === 'manual' ? 'bg-blue-700 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
          >
            Fill it in myself
          </button>
          {rescanSource && (
            <button type="button"
              onClick={() => switchEntryMode('rescan')}
            aria-pressed={entryMode === 'rescan'}
              className={`px-3 py-2.5 sm:py-1.5 transition-colors ${entryMode === 'rescan' ? 'bg-blue-700 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
            >
              Same resume
            </button>
          )}
          {hasSavedProfile && (
            <button type="button"
              onClick={() => switchEntryMode('savedProfile')}
            aria-pressed={entryMode === 'savedProfile'}
              className={`px-3 py-2.5 sm:py-1.5 transition-colors ${entryMode === 'savedProfile' ? 'bg-blue-700 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
            >
              Use saved profile
            </button>
          )}
        </div>

        {entryMode === 'upload' && <FileUpload value={file} onFile={setFile} />}

        {entryMode === 'upload' && !user && (
          <div>
            <Input
              type="email"
              placeholder="Email me the result (optional)"
              value={uploadEmail}
              onChange={e => setUploadEmail(e.target.value)}
              aria-label="Email address for a link to your result (optional)"
            />
            <p className="mt-1 text-xs text-gray-500">
              Without an account, your result is only reachable from this browser. Add an address and we'll email
              you a link back — used for that and nothing else.
            </p>
          </div>
        )}

        {entryMode === 'brainDump' && (
          <div>
            {restored && (
              <p role="status" className="mb-2 text-xs text-blue-800 bg-blue-50 border border-blue-100 rounded-md px-3 py-1.5">
                We kept what you were writing last time — it's back in the box below.
              </p>
            )}
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
                brainDumpText.length >= MAX_RESUME_CHARS * 0.9 ? 'text-amber-700' : 'text-gray-500'
              }`}>
                {formatNumber(brainDumpText.length)} / {formatNumber(MAX_RESUME_CHARS)}
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
                  we ask separately so your resume header isn't blank. We'll also email you a
                  link back to your result; it works for 24 hours.
                </p>
              </div>
            )}
          </div>
        )}

        {entryMode === 'manual' && (
          <div>
            {restoredManual && (
              <p role="status" className="mb-2 text-xs text-blue-800 bg-blue-50 border border-blue-100 rounded-md px-3 py-1.5">
                We kept what you were filling in last time — it's back in the form below.
              </p>
            )}
            <p className="text-xs text-gray-500 mb-3">
              Prefer to type it in yourself? Fill in what you have — nothing is guessed or rewritten
              before your score, and you can add more any time after.
            </p>
            <div className="flex flex-col gap-5">
              <ResumeFieldsForm draft={manualData} setDraft={setManualData} />
            </div>
            {!user && (
              <p className="mt-3 text-xs text-gray-500">
                Your name is required. If you add an email we'll send you a link back to your result;
                it works for 24 hours.
              </p>
            )}
          </div>
        )}

        {entryMode === 'rescan' && rescanSource && (
          <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
            <p className="text-sm text-gray-700">
              We'll use <span className="font-medium">{rescanSource.label}</span> again — just add the
              new job description below. This counts as one of your daily free scans.
            </p>
            {rescanSource.hasImproved && (
              <Checkbox
                wrapperClassName="mt-2"
                alignTop
                checked={useImproved}
                onChange={e => setUseImproved(e.target.checked)}
                data-testid="rescan-use-improved"
                label="Scan my improved version instead (the fixed resume we delivered, with any edits you made)."
              />
            )}
          </div>
        )}

        {entryMode === 'savedProfile' && (
          <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
            <p className="text-sm text-gray-700">
              We'll use your saved profile — just add a job description below and we'll translate it fresh.
            </p>
            {extraProfiles.length > 0 && (
              <Select label="Profile to use" wrapperClassName="mt-2" value={profileChoice} onChange={e => setProfileChoice(e.target.value)}>
                {primaryAvailable && <option value="">Main profile</option>}
                {extraProfiles.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
              </Select>
            )}
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center gap-4 mb-3">
          <span className="text-sm font-medium text-gray-700">Job description</span>
          <div className="flex rounded-md overflow-hidden border border-gray-300 text-sm">
            <button type="button"
              onClick={() => setUseUrl(false)}
              aria-pressed={!useUrl}
              className={`px-3 py-2.5 sm:py-1.5 transition-colors ${!useUrl ? 'bg-blue-700 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
            >
              Paste text
            </button>
            <button type="button"
              onClick={() => setUseUrl(true)}
              aria-pressed={useUrl}
              className={`px-3 py-2.5 sm:py-1.5 transition-colors ${useUrl ? 'bg-blue-700 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
            >
              URL
            </button>
          </div>
        </div>

        {restoredJd && (
          <p role="status" className="mb-2 text-xs text-blue-800 bg-blue-50 border border-blue-100 rounded-md px-3 py-1.5">
            We kept the job you were adding last time — it's back below.
          </p>
        )}
        {useUrl ? (
          <div>
            <Input
              placeholder="https://jobs.example.com/software-engineer-123"
              value={jobUrl}
              onChange={e => setJobUrl(e.target.value)}
            />
            <JobLinkFeedback jobLink={jobLink} onSwitchToPaste={() => setUseUrl(false)} />
            <p className="mt-1 text-xs text-gray-500">
              For the most accurate score, use the employer's own posting link rather than a job board aggregator or reposted listing.
              A very long posting is trimmed to its role and requirements (company intro and benefits go first); your result shows the text that was scored.
            </p>
          </div>
        ) : (
          <div>
            <Textarea
              placeholder="Paste the full job description here…"
              value={jdText}
              onChange={e => setJdText(e.target.value)}
              rows={7}
            />
            <JdMeter text={jdText} />
          </div>
        )}
      </div>

      <PaperSizeSelect value={paperSize} onChange={setPaperSize} disabled={loading} />

      <Alert focusOnShow>{error}</Alert>

      <Button type="submit" loading={loading} size="lg" className="w-full sm:w-auto">
        {submitLabel}
      </Button>
      {loading && entryMode === 'upload' && uploadPct !== null && (
        <div className="flex flex-col gap-1">
          <ProgressBar value={uploadPct} label="Uploading your resume" doneLabel="Reading your resume…" />
          {uploadPct < 100 && (
            <button type="button" onClick={cancelUpload}
              className="self-start text-xs text-gray-600 underline hover:text-red-600">
              Cancel upload
            </button>
          )}
        </div>
      )}
      {user && quotaText && (
        <p role="status" className={`text-xs ${quotaText.exhausted ? 'text-amber-700 font-medium' : 'text-gray-500'}`}>
          {quotaText.text}
        </p>
      )}
      <p className="text-xs text-gray-500">
        {user ? 'Results in ~30 seconds.' : <span data-testid="anon-limits">No account needed. Results in ~30 seconds. Without an account: {anonPerHour} free scan{anonPerHour === 1 ? '' : 's'} an hour, result kept for 24 hours. A free account gets {freePerDay} a day, saved for good.</span>}
      </p>
    </Form>
  )
}
