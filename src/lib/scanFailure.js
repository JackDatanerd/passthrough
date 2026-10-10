// SCAN/ATS ROUND 4: why a scan failed, as data the UI can act on.
//
// `full_ats_report.error` used to be a free-text string that buildAtsDetail() discarded, so every failed scan
// showed the same generic paragraph and a "Try again" button — even when trying again could never work (a scanned
// PDF is still a scanned PDF). A failure now carries a code; the code decides the copy and whether retrying makes
// sense. Stored inside full_ats_report (jsonb) so it needs no migration.
const { MAX_PDF_PAGES } = require('../services/pdf.inspect')

const FAILURE_MESSAGES = {
  NO_TEXT:          'This PDF has no selectable text — it looks like a scan or a picture of a page, which employer ATS systems read as blank. Export it again from Word or Google Docs as a text-based PDF, or upload a .docx instead.',
  TOO_SHORT:        'We found almost no text in this file. Check that you uploaded the right resume, then try again with a new upload.',
  ENCRYPTED_PDF:    'This PDF is password-protected, so we cannot read it. Remove the password (or export a fresh copy) and upload it again.',
  TOO_MANY_PAGES:   `This PDF is longer than ${MAX_PDF_PAGES} pages. A resume is one to three — upload the resume itself, not a portfolio or a combined document.`,
  UNREADABLE_FILE:  'We could not open this file. It may be damaged — export it again and upload the new copy.',
  NEEDS_MORE_DETAIL: 'Tell us a little more about your roles and what you did in them, then try again.',
  STRUCTURE_FAILED: 'We could not turn your background into a resume this time. Nothing was counted against today\'s allowance — try again, and add a little more detail about each role if you can.',
  SYSTEM:           'Something went wrong on our side while scoring this resume.',
}

// Failures that happen again with the same input. Retrying one only spends effort; the person has to change
// the file instead.
const DETERMINISTIC_FAILURES = new Set(['NO_TEXT', 'TOO_SHORT', 'ENCRYPTED_PDF', 'TOO_MANY_PAGES', 'UNREADABLE_FILE', 'NEEDS_MORE_DETAIL'])

function failureMessage(code) { return FAILURE_MESSAGES[code] || FAILURE_MESSAGES.SYSTEM }
function isRetryable(code) { return !DETERMINISTIC_FAILURES.has(code) }

module.exports = { FAILURE_MESSAGES, DETERMINISTIC_FAILURES, failureMessage, isRetryable }
