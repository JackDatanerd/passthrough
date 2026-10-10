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
function applyScanFilters(query, { search, status, ids } = {}) {
  let q = query
  if (ids && ids.length) q = q.in('id', ids)
  if (search) q = q.or(HISTORY_SEARCH(search))
  if (status && SCAN_STATUSES.includes(status)) q = q.eq('status', status)
  return q
}

// Sort choices for the dashboard list. Every order ends in created_at + id so two scans with
// the same score (or a NULL score) keep a stable position between pages.
const SCAN_SORTS = ['newest', 'oldest', 'score_desc', 'score_asc']
const normalizeSort = (raw) => (SCAN_SORTS.includes(raw) ? raw : 'newest')
function applyScanSort(query, sort) {
  const s = normalizeSort(sort)
  let q = query
  if (s === 'score_desc' || s === 'score_asc') q = q.order('ats_score', { ascending: s === 'score_asc', nullsFirst: false })
  return q.order('created_at', { ascending: s === 'oldest' ? true : false }).order('id', { ascending: s === 'oldest' })
}

// Selected-scan delete: a short list of UUIDs. Anything malformed rejects the whole request.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_SELECTED_IDS = 50
function parseIdList(raw) {
  if (raw === undefined || raw === null || raw === '') return { ids: [] }
  const ids = [...new Set(String(raw).split(',').map(x => x.trim()).filter(Boolean))]
  if (!ids.length || ids.length > MAX_SELECTED_IDS || ids.some(x => !UUID_RE.test(x))) return { error: `Select between 1 and ${MAX_SELECTED_IDS} scans.` }
  return { ids }
}

module.exports = { SCAN_STATUSES, SCAN_SORTS, normalizeSort, sanitizeSearch, HISTORY_SEARCH, applyScanFilters, applyScanSort, parseIdList, MAX_SELECTED_IDS }
