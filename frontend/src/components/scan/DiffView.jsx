import { useState } from 'react'
import { buildResumeDiff } from '../../lib/resumeDiff'

// Rendered in ScanResult.jsx once a fix/badge has been delivered. Two
// distinct states:
//   1. No rewrittenResumeData at all (badge-only purchase — generateBadge
//      never calls the AI rewrite by design) → a calm info panel explaining
//      that content wasn't changed, only formatted and verified.
//   2. A real diff (full fix purchase) → collapsible before/after view,
//      defaulting to collapsed so it doesn't compete with the download
//      buttons for attention, but available for anyone who wants to verify
//      nothing was fabricated.
//
// Scope note: this visually FLAGS AI-added skills/certifications (the
// anti-fabrication trust signal called for in the product spec) but does
// not implement click-to-accept gating that would exclude unaccepted
// additions from the exported files — that would require an edit-and-
// regenerate loop, which is a larger feature deferred past this phase.
// This ships the transparency half, not the interactivity half.

function BulletRow({ bullet }) {
  if (bullet.status === 'unchanged') {
    return <li className="text-sm text-gray-700 py-1">{bullet.before}</li>
  }
  if (bullet.status === 'added') {
    return (
      <li className="text-sm py-1">
        <span className="inline-block text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded px-1.5 py-0.5 mr-2 align-middle">
          added
        </span>
        <span className="text-gray-700">{bullet.after}</span>
      </li>
    )
  }
  if (bullet.status === 'removed') {
    return (
      <li className="text-sm py-1">
        <span className="inline-block text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded px-1.5 py-0.5 mr-2 align-middle">
          removed
        </span>
        <span className="text-gray-400 line-through">{bullet.before}</span>
      </li>
    )
  }
  // changed
  return (
    <li className="text-sm py-1.5">
      <div className="text-gray-400 line-through mb-0.5">{bullet.before}</div>
      <div className="text-gray-800">{bullet.after}</div>
    </li>
  )
}

function TagList({ items, variant }) {
  if (!items.length) return null
  const styles = {
    unchanged: 'bg-gray-50 text-gray-600 border-gray-200',
    added:     'bg-amber-50 text-amber-800 border-amber-200',
    removed:   'bg-gray-50 text-gray-400 border-gray-200 line-through'
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item, i) => (
        <span key={i} className={`text-xs px-2 py-1 rounded-full border ${styles[variant]}`}>
          {item}
        </span>
      ))}
    </div>
  )
}

function DiffContent({ diff }) {
  const hasSkillChanges = diff.skills.added.length > 0 || diff.skills.removed.length > 0
  const hasCertChanges  = diff.certifications.added.length > 0 || diff.certifications.removed.length > 0

  return (
    <div className="flex flex-col gap-6">
      {diff.skills.added.length > 0 && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
          Skills marked "added" below were introduced by the AI rewrite based on your experience.
          Double-check these are accurate before applying for roles.
        </p>
      )}

      {diff.summary.changed && (
        <div>
          <h4 className="text-sm font-semibold text-gray-800 mb-2">Summary</h4>
          <div className="text-sm text-gray-400 line-through mb-1">{diff.summary.before || '(none)'}</div>
          <div className="text-sm text-gray-800">{diff.summary.after}</div>
        </div>
      )}

      {diff.experience.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold text-gray-800 mb-3">Experience</h4>
          <div className="flex flex-col gap-4">
            {diff.experience.map((job, i) => (
              <div key={i} className="border-l-2 border-gray-100 pl-4">
                <div className="flex flex-wrap items-baseline gap-x-2 mb-1">
                  <span className="text-sm font-medium text-gray-900">{job.company}</span>
                  {job.jobStatus === 'added' && (
                    <span className="text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded px-1.5 py-0.5">new entry</span>
                  )}
                  {job.jobStatus === 'removed' && (
                    <span className="text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded px-1.5 py-0.5">removed entry</span>
                  )}
                </div>
                {job.titleChanged ? (
                  <div className="text-xs mb-1">
                    <span className="text-gray-400 line-through mr-2">{job.beforeTitle}</span>
                    <span className="text-gray-600">{job.afterTitle}</span>
                  </div>
                ) : (
                  <div className="text-xs text-gray-500 mb-1">{job.afterTitle}</div>
                )}
                <ul>
                  {job.bullets.map((b, bi) => <BulletRow key={bi} bullet={b} />)}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}

      {(diff.skills.unchanged.length > 0 || hasSkillChanges) && (
        <div>
          <h4 className="text-sm font-semibold text-gray-800 mb-2">Skills</h4>
          <div className="flex flex-col gap-2">
            <TagList items={diff.skills.unchanged} variant="unchanged" />
            <TagList items={diff.skills.added} variant="added" />
            <TagList items={diff.skills.removed} variant="removed" />
          </div>
        </div>
      )}

      {(diff.certifications.unchanged.length > 0 || hasCertChanges) && (
        <div>
          <h4 className="text-sm font-semibold text-gray-800 mb-2">Certifications</h4>
          <div className="flex flex-col gap-2">
            <TagList items={diff.certifications.unchanged} variant="unchanged" />
            <TagList items={diff.certifications.added} variant="added" />
            <TagList items={diff.certifications.removed} variant="removed" />
          </div>
        </div>
      )}
    </div>
  )
}

export default function DiffView({ originalResumeData, rewrittenResumeData, fixTier }) {
  const [expanded, setExpanded] = useState(false)

  if (!originalResumeData) return null

  // Badge-only purchases never run the AI rewrite — rewrittenResumeData
  // stays null by design (see generateBadge in scan.controller.js). Show
  // an honest "nothing was changed" panel instead of an empty/fake diff.
  const isCredentialOnly = !rewrittenResumeData

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-6 py-4 text-left"
      >
        <div>
          <p className="text-sm font-semibold text-gray-900">
            {isCredentialOnly ? 'What was verified' : 'See what changed'}
          </p>
          <p className="text-xs text-gray-500 mt-0.5">
            {isCredentialOnly
              ? 'Your content was formatted and verified — nothing was rewritten'
              : 'Compare your original background against the rewritten resume'}
          </p>
        </div>
        <svg
          className={`h-5 w-5 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <div className="px-6 pb-6 border-t border-gray-100 pt-5">
          {isCredentialOnly ? (
            <p className="text-sm text-gray-500">
              You purchased the Verified credential only. Your resume content was formatted into
              an ATS-friendly document and verified as submitted — no wording was changed. If
              you'd like an AI-rewritten version tailored to a specific job description, you can
              upgrade to the full fix from any scan.
            </p>
          ) : (
            <DiffContent diff={buildResumeDiff(originalResumeData, rewrittenResumeData)} />
          )}
        </div>
      )}
    </div>
  )
}
