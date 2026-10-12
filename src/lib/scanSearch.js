// What the dashboard's search box and status filter mean, shared by every endpoint that narrows
// "this account's scans" the same way: GET /scan/history (the list) and DELETE /profile/scans
// (delete what the filters currently show). One definition, so "the scans I can see" and "the
// scans that get deleted" can never drift apart.

const SCAN_STATUSES = ['PENDING', 'SCANNING', 'COMPLETE_PASS', 'COMPLETE_FAIL', 'FIX_PURCHASED', 'FIX_GENERATING', 'FIX_DELIVERED', 'ERROR']

// Dashboard chips that stand for SEVERAL statuses. A group is nothing but a fixed list of the real
// statuses above, so the list and the filtered delete (both go through applyScanFilters) still
// agree on exactly which scans a chip means. Keep the lists in step with frontend/src/lib/scanNext.js.
const STATUS_GROUPS = {
  IN_PROGRESS: ['PENDING', 'SCANNING', 'FIX_PURCHASED', 'FIX_GENERATING'],
  NEEDS_DECISION: ['COMPLETE_PASS', 'COMPLETE_FAIL'],
}
// Everything ?status= may be: one real status, or one of the group names.
const STATUS_FILTERS = [...SCAN_STATUSES, ...Object.keys(STATUS_GROUPS)]

// Everything with meaning inside a PostgREST .or() string or an ilike pattern is removed
// (`_` stays — it only widens a match).
const sanitizeSearch = (raw) => String(raw || '').replace(/[,()"%\\*]/g, '').trim()

// What the box matches: everything a row shows as its heading or small print — the uploaded file's
// name, the candidate's first name (brain-dump / saved-profile scans have no file), the job title
// taken from the JD, the role ("Software Engineering" is stored as software_engineering, so spaces
// become `_`, which ilike treats as any one character), the seniority ("Senior"), and the source
// label of scans built without a file ("Built from scratch" / "From saved profile" — input_mode is
// an enum, which ilike cannot search, so those two are matched by equality).
const SOURCE_LABELS = [['built from scratch', 'brain_dump'], ['from saved profile', 'saved_profile']]
const HISTORY_SEARCH = (term) => {
  const t = String(term)
  const parts = [
    `resume_original_name.ilike.%${t}%`, `candidate_first_name.ilike.%${t}%`, `job_title.ilike.%${t}%`,
    `role_category.ilike.%${t.replace(/\s+/g, '_')}%`, `seniority_level.ilike.%${t}%`,
  ]
  const lower = t.toLowerCase()
  if (lower.length >= 3) for (const [label, mode] of SOURCE_LABELS) if (label.includes(lower)) parts.push(`input_mode.eq.${mode}`)
  return parts.join(',')
}

// Narrows a scans query by an already-sanitized search term and an allowlisted status.
function applyScanFilters(query, { search, status, ids } = {}) {
  let q = query
  if (ids && ids.length) q = q.in('id', ids)
  if (search) q = q.or(HISTORY_SEARCH(search))
  if (status && STATUS_GROUPS[status]) q = q.in('status', STATUS_GROUPS[status])
  else if (status && SCAN_STATUSES.includes(status)) q = q.eq('status', status)
  return q
}

// Sort choices for the dashboard list. Score orders use display_score (migration 0076) — the score
// the row actually shows (fixed score once a fix is scored, else the original). Every order ends in created_at + id so two scans with
// the same score (or a NULL score) keep a stable position between pages.
const SCAN_SORTS = ['newest', 'oldest', 'score_desc', 'score_asc']
const normalizeSort = (raw) => (SCAN_SORTS.includes(raw) ? raw : 'newest')
function applyScanSort(query, sort) {
  const s = normalizeSort(sort)
  let q = query
  if (s === 'score_desc' || s === 'score_asc') q = q.order('display_score', { ascending: s === 'score_asc', nullsFirst: false })
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

module.exports = { SCAN_STATUSES, STATUS_GROUPS, STATUS_FILTERS, SCAN_SORTS, normalizeSort, sanitizeSearch, HISTORY_SEARCH, applyScanFilters, applyScanSort, parseIdList, MAX_SELECTED_IDS }
