// FEATURE (feature gap — Scan/ATS section audit): ats.service.js's
// scoreResume() has always computed real, actionable detail for every scan
// — which JD keywords are missing, which sections are absent, which format
// issues fired — and runAtsScan has always persisted all of it to
// full_ats_report. Nothing anywhere in the app ever rendered it:
// CategoryScores.jsx only ever showed four bare numbers with no explanation
// of WHY. getScan() now returns a presentational subset of that detail as
// scan.atsDetail (see scan.controller.js's buildAtsDetail) instead of
// silently stripping it before it reached the client.
//
// aiMissingKeywords is the other half of the same gap: scoreResumeWithAI's
// prompt has always asked Claude for missingKeywords alongside aiScore —
// only aiScore was ever read back out. That list is semantically aware
// (catches synonyms/related terms the rule-based stemmer can't), so it's
// shown as a distinct, clearly-labeled "also worth considering" group
// rather than merged silently into the rule-based list — the two come from
// different methods and can disagree.
//
// Renders nothing if there's no detail to show (a scan that predates this
// feature, or one that errored before scoring ran).

function Chip({ children, tone = 'amber' }) {
  const tones = {
    amber: 'bg-amber-50 text-amber-800 border-amber-200',
    gray:  'bg-gray-50 text-gray-600 border-gray-200',
  }
  return (
    <span className={`inline-block text-xs px-2 py-1 rounded-full border ${tones[tone]}`}>
      {children}
    </span>
  )
}

// `detail` / `title` let the same panel explain the DELIVERED file's score (scan.fixAtsDetail, round 3)
// as well as the free scan's (scan.atsDetail, the default).
export default function AtsDetailPanel({ scan, detail: detailProp, title = 'Why this score' }) {
  const detail = detailProp ?? scan?.atsDetail
  if (!detail) return null

  const keywords = detail.keywords || {}
  const sections = detail.sections || {}
  const format   = detail.format   || {}
  const content  = detail.content  || {}

  // Don't show an AI-flagged term a second time under a different label if
  // the rule-based pass already caught it.
  const missingLower    = new Set((keywords.missing || []).map(k => k.toLowerCase()))
  const extraAiKeywords = (detail.aiMissingKeywords || []).filter(k => !missingLower.has(k.toLowerCase()))

  const hasMissingKeywords = (keywords.missing?.length || 0) > 0
  const hasExtraAi         = extraAiKeywords.length > 0
  const hasMissingSections = (sections.missing?.length || 0) > 0
  const hasFormatIssues    = (format.issues?.length || 0) > 0
  const hasOptionalNudge   = sections.hasProjects === false || sections.hasCertifications === false
  const hasContentStats    = content.actionVerbRate != null || content.quantifiedCount != null
  const hasMatched         = (keywords.matched?.length || 0) > 0

  // Round 4: why a keyword score was discounted (skills-only matches, copied posting text, hidden text), and the bullets
  // that say what was done but give no number — fixable by hand, for free, before anyone pays for anything.
  const warnings     = keywords.warnings || []
  const unquantified = content.unquantified && content.unquantified.count > 0 && (content.unquantified.examples || []).length > 0 ? content.unquantified : null
  const hasWarnings  = warnings.length > 0

  const hasGaps = hasMissingKeywords || hasExtraAi || hasMissingSections || hasFormatIssues || hasWarnings || !!unquantified

  if (!hasGaps && !hasContentStats && !hasMatched) return null

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
      <p className="text-sm font-semibold text-gray-900 mb-1">{title}</p>

      {!hasGaps && (
        <p className="text-sm text-gray-600 mt-2">
          No obvious keyword, section, or formatting gaps found.
        </p>
      )}

      {hasGaps && (
        <div className="flex flex-col gap-4 mt-3">
          {hasWarnings && (
            <div data-testid="keyword-warnings" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
              <p className="text-xs font-medium text-amber-900 mb-1">Why your keyword score was reduced</p>
              <ul className="flex flex-col gap-1">
                {warnings.map((w, i) => <li key={i} className="text-sm text-amber-900">{w.charAt(0).toUpperCase() + w.slice(1)}.</li>)}
              </ul>
            </div>
          )}

          {unquantified && (
            <div data-testid="unquantified-bullets">
              <p className="text-xs text-gray-500 mb-2">
                {unquantified.count} of {unquantified.total} bullet{unquantified.total === 1 ? '' : 's'} say what you did but give no number
                — add how many, how much or how fast
              </p>
              <ul className="flex flex-col gap-1">
                {unquantified.examples.map((b, i) => (
                  <li key={i} className="text-sm text-gray-800 border-l-2 border-amber-200 pl-3">{b}</li>
                ))}
              </ul>
              {unquantified.count > unquantified.examples.length && (
                <p className="text-xs text-gray-400 mt-1">…and {unquantified.count - unquantified.examples.length} more.</p>
              )}
            </div>
          )}

          {hasMissingKeywords && (
            <div>
              <p className="text-xs text-gray-500 mb-2">
                Keywords from the job description not found in your resume
              </p>
              <div className="flex flex-wrap gap-1.5">
                {keywords.missing.map((kw, i) => <Chip key={i}>{kw}</Chip>)}
              </div>
            </div>
          )}

          {hasExtraAi && (
            <div>
              <p className="text-xs text-gray-500 mb-2">Also worth considering</p>
              <div className="flex flex-wrap gap-1.5">
                {extraAiKeywords.map((kw, i) => <Chip key={i} tone="gray">{kw}</Chip>)}
              </div>
            </div>
          )}

          {hasMissingSections && (
            <div>
              <p className="text-xs text-gray-500 mb-2">Missing sections</p>
              <ul className="flex flex-col gap-1">
                {sections.missing.map((s, i) => (
                  <li key={i} className="text-sm text-gray-800 border-l-2 border-amber-200 pl-3">{s}</li>
                ))}
              </ul>
            </div>
          )}

          {hasFormatIssues && (
            <div>
              <p className="text-xs text-gray-500 mb-2">Formatting</p>
              <ul className="flex flex-col gap-1">
                {format.issues.map((issue, i) => (
                  <li key={i} className="text-sm text-gray-800 border-l-2 border-amber-200 pl-3">{issue}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {hasOptionalNudge && (
        <p className="text-xs text-gray-400 mt-4">
          {sections.hasProjects === false && 'Consider adding a Projects section. '}
          {sections.hasCertifications === false && 'Consider adding relevant certifications, if you have any.'}
        </p>
      )}

      {content.language === 'other' && (
        <p className="text-xs text-gray-500 mt-4" data-testid="language-note">
          The action-verb check only reads English, so it was skipped for your resume. Everything else was scored as usual.
        </p>
      )}

      {hasContentStats && (
        <p className="text-xs text-gray-500 mt-4">
          {content.actionVerbRate != null &&
            `${Math.round(content.actionVerbRate * 100)}% of bullets start with a strong action verb`}
          {content.actionVerbRate != null && content.quantifiedCount != null && ' · '}
          {content.quantifiedCount != null &&
            `${content.quantifiedCount} quantified achievement${content.quantifiedCount === 1 ? '' : 's'} found`}
        </p>
      )}

      {hasMatched && (
        <details className="mt-4">
          <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700">
            {keywords.matched.length} keyword{keywords.matched.length === 1 ? '' : 's'} already matched
          </summary>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {keywords.matched.map((kw, i) => <Chip key={i} tone="gray">{kw}</Chip>)}
          </div>
        </details>
      )}
    </div>
  )
}
