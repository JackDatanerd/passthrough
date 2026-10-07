// What the dashboard's search box and status filter mean, shared by every endpoint that narrows
// "this account's scans" the same way: GET /scan/history (the list) and DELETE /profile/scans
// (delete what the filters currently show). One definition, so "the scans I can see" and "the
// scans that get deleted" can never drift apart.

const SCAN_STATUSES = ['PENDING', 'SCANNING', 'COMPLETE_PASS', 'COMPLETE_FAIL', 'FIX_PURCHASED', 'FIX_GENERATING', 'FIX_DELIVERED', 'ERROR']

// Everything with meaning inside a PostgREST .or() string or an ilike pattern is removed
// (`_` stays — it only widens a match).
const sanitizeSearch = (raw) => String(raw || '').replace(/[,()"%\\*]/g, '').trim()

// What the box matches: the uploaded file's name, the candidate's first name (brain-dump /
// saved-profile scans have no file), and the job title taken from the JD.
const HISTORY_SEARCH = (term) =>
  `resume_original_name.ilike.%${term}%,candidate_first_name.ilike.%${term}%,job_title.ilike.%${term}%`

// Narrows a scans query by an already-sanitized search term and an allowlisted status.
function applyScanFilters(query, { search, status } = {}) {
  let q = query
  if (search) q = q.or(HISTORY_SEARCH(search))
  if (status && SCAN_STATUSES.includes(status)) q = q.eq('status', status)
  return q
}

module.exports = { SCAN_STATUSES, sanitizeSearch, HISTORY_SEARCH, applyScanFilters }
