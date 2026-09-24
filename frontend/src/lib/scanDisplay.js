import { roleLabel } from './roleCategories.js'

// How the dashboard describes a scan and decides what may be done with it.
// Pure functions so the rules are testable without rendering anything.

// Statuses where a background job is still writing to the scan.
export const IN_FLIGHT_STATUSES = ['PENDING', 'SCANNING', 'FIX_PURCHASED', 'FIX_GENERATING']

// Mirrors SCAN_IN_FLIGHT_WINDOW_MS in the backend's scan.controller.js: the
// server refuses to delete an in-flight scan only while it has been touched
// within this window — untouched for longer means the job died. Keep the two
// in step (the server is the authority; this only decides whether to offer the
// button).
export const IN_FLIGHT_WINDOW_MS = 60 * 60 * 1000

// A scan a job is (as far as anyone can tell) actively working on.
// No usable timestamp = assume live, the safe direction (the button stays off).
export function isLive(scan, now = Date.now()) {
  if (!IN_FLIGHT_STATUSES.includes(scan.status)) return false
  const touched = Date.parse(scan.updatedAt)
  return Number.isFinite(touched) ? now - touched < IN_FLIGHT_WINDOW_MS : true
}

// An in-flight scan that has gone quiet for an hour is dead, not busy — it can
// be deleted like any other (previously the button was disabled for good).
export const canDeleteScan = (scan, now = Date.now()) => !isLive(scan, now)

const humanize = (v) => String(v).replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase())

// "Senior · Software Engineering", "Software Engineering", or '' — from what the
// server derived from the job description. 'mid' is left out on purpose: the
// backend's detectSeniority() answers 'mid' when the text says nothing about
// level, so showing it would state something the job description never did.
export function roleLine(scan) {
  const role = scan.roleCategory ? roleLabel(scan.roleCategory) : ''
  const level = scan.seniorityLevel && scan.seniorityLevel !== 'mid' ? humanize(scan.seniorityLevel) : ''
  return [level, role].filter(Boolean).join(' · ')
}

// Where the resume came from: the uploaded file, or how it was built.
export function scanSource(scan) {
  if (scan.resumeOriginalName) return scan.resumeOriginalName
  if (scan.inputMode === 'brain_dump') return 'Built from scratch'
  if (scan.inputMode === 'saved_profile') return 'From saved profile'
  return 'Resume'
}

// The row's headline: what the scan was FOR (the job), falling back to the role,
// then to where the resume came from. Ten rescans of one resume used to be ten
// identical rows.
export function scanHeading(scan) {
  return scan.jobTitle || roleLine(scan) || scanSource(scan)
}

// The small print under the headline (the date is added by the caller): the
// pieces of information the headline did not already use.
export function scanDetails(scan) {
  if (scan.jobTitle) return [scanSource(scan), roleLine(scan)].filter(Boolean)
  if (roleLine(scan)) return [scanSource(scan)]
  return []
}
