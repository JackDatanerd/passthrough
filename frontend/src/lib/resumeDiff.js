// Builds a structured diff between a scan's original and rewritten resume
// data, consumed by DiffView.jsx. Deliberately dependency-free: rather than
// pulling in a text-diff library for word-level highlighting, this does a
// simpler structural comparison — before/after per bullet, per section,
// per skill/cert. Less granular than a true text diff, but honest and
// legible: the whole point is letting the user see nothing was invented,
// not winning a diff-algorithm design contest.
//
// Matching strategy for experience entries: if the original and rewritten
// arrays are the same length (the common case — the rewrite prompt is
// instructed to return the same JSON structure), match positionally.
// Otherwise fall back to matching by normalized company name. Any entry
// that still can't be matched is flagged as fully added/removed — this
// should be rare given detectFabrication() already guards against Claude
// inventing or dropping employers, but the diff renders gracefully either way.

// AUDIT FIX: everything below assumed a bullet/skill/cert/company/title
// field that came back well-SHAPED (right key, right nesting) was also
// well-TYPED (an actual string). The envelope/fabrication checks in
// claude.service.js validate shape, not per-field type — a wrong-typed
// value (a bullet as a number, a skill as a nested object) is well-formed
// JSON and passes those checks, then hits a bare `.trim()`/`.toLowerCase()`
// here and throws, crashing ScanResult.jsx's render for a scan the user
// already paid for. `str()` coerces anything non-string-ish to '' instead
// of throwing, everywhere this file touches an AI-sourced text field.
function str(v) {
  return typeof v === 'string' ? v : ''
}

// Array-ness is not guaranteed either (a skills list that is one string, an entry list that is an
// object) — `x || []` lets those through to `.map`/`.forEach` and the page white-screens.
const arr = v => (Array.isArray(v) ? v : [])

function normCompany(s) {
  return str(s).toLowerCase().replace(/[.,]/g, '').trim()
}

function diffText(before, after) {
  const b = str(before).trim()
  const a = str(after).trim()
  return { before: b, after: a, changed: b !== a }
}

// ── SCAN/ATS ROUND 4 ────────────────────────────────────────────────────────────────────────────────────────
// Bullets used to be matched by POSITION. A rewrite that reorders, merges or splits bullets (routine) shifted every later
// bullet against the wrong partner, so a handful of intact lines showed as "changed" and the last as "removed" — which
// reads as the AI having rewritten, or dropped, work it never touched. They are now paired by how many words they share
// (a bullet and its reworded self share most of theirs), so what you see is what actually changed; a bullet that kept its
// words but moved is marked as moved, and a changed one carries word-level segments so the edit itself is highlighted.
// Still dependency-free: a small LCS over words, capped so a pathological bullet cannot stall the page.
const words = t => str(t).toLowerCase().replace(/[^\p{L}\p{N}%$+#.\s]/gu, ' ').split(/\s+/).filter(Boolean)

function similarity(a, b) {
  const x = new Set(words(a)), y = new Set(words(b))
  if (!x.size || !y.size) return 0
  let shared = 0
  for (const w of x) if (y.has(w)) shared++
  return (2 * shared) / (x.size + y.size)               // Dice coefficient: 1 = same words, 0 = nothing in common
}
const MIN_SIMILARITY = 0.34

// [{ text, type: 'same' | 'del' | 'add' }] — word-level, whitespace preserved on the tokens.
const SEGMENT_TOKEN_CAP = 140
export function wordSegments(before, after) {
  const a = str(before).trim().split(/(\s+)/).filter(t => t !== ''), b = str(after).trim().split(/(\s+)/).filter(t => t !== '')
  if (a.length > SEGMENT_TOKEN_CAP || b.length > SEGMENT_TOKEN_CAP) return null
  const n = a.length, m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const beforeSegments = [], afterSegments = []
  const push = (list, type, text) => { const last = list[list.length - 1]; if (last && last.type === type) last.text += text; else list.push({ type, text }) }
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { push(beforeSegments, 'same', a[i]); push(afterSegments, 'same', b[j]); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push(beforeSegments, 'del', a[i]); i++ }
    else { push(afterSegments, 'add', b[j]); j++ }
  }
  while (i < n) push(beforeSegments, 'del', a[i++])
  while (j < m) push(afterSegments, 'add', b[j++])
  return { beforeSegments, afterSegments }
}

export function alignBullets(beforeList, afterList) {
  const before = beforeList.map(str), after = afterList.map(str)
  const pairOf = new Array(after.length).fill(-1)        // after index -> before index
  const usedBefore = new Set()
  // 1. identical text first (so duplicates and reorders never steal each other's partner)…
  after.forEach((a, j) => {
    const i = before.findIndex((b, bi) => !usedBefore.has(bi) && b.trim() === a.trim())
    if (i !== -1) { pairOf[j] = i; usedBefore.add(i) }
  })
  // 2. …then the best remaining pairs by shared words, best first.
  const cands = []
  after.forEach((a, j) => { if (pairOf[j] === -1) before.forEach((b, i) => { if (!usedBefore.has(i)) { const sim = similarity(b, a); if (sim >= MIN_SIMILARITY) cands.push({ i, j, sim }) } }) })
  cands.sort((x, y) => y.sim - x.sim || Math.abs(x.i - x.j) - Math.abs(y.i - y.j))
  for (const { i, j } of cands) if (pairOf[j] === -1 && !usedBefore.has(i)) { pairOf[j] = i; usedBefore.add(i) }

  const out = []
  after.forEach((a, j) => {
    const i = pairOf[j]
    if (i === -1) { out.push({ before: null, after: a, status: 'added' }); return }
    if (before[i].trim() === a.trim()) { out.push({ before: before[i], after: a, status: 'unchanged', moved: i !== j }); return }
    out.push({ before: before[i], after: a, status: 'changed', moved: i !== j, ...(wordSegments(before[i], a) || {}) })
  })
  before.forEach((b, i) => { if (!usedBefore.has(i)) out.push({ before: b, after: null, status: 'removed' }) })
  return out
}

function diffJob(original, rewritten) {
  const company     = str(original?.company) || str(rewritten?.company)
  const beforeTitle = str(original?.title)
  const afterTitle  = rewritten?.title !== undefined ? str(rewritten.title) : beforeTitle
  const beforeDates = str(original?.dates)
  const afterDates  = rewritten?.dates !== undefined ? str(rewritten.dates) : beforeDates

  const beforeBullets = Array.isArray(original?.bullets) ? original.bullets : []
  const afterBullets  = Array.isArray(rewritten?.bullets) ? rewritten.bullets : []
  const bullets = alignBullets(beforeBullets, afterBullets)

  const beforeLocation = str(original?.location)
  const afterLocation  = rewritten?.location !== undefined ? str(rewritten.location) : beforeLocation

  return {
    company,
    beforeTitle, afterTitle, titleChanged: beforeTitle.trim() !== afterTitle.trim(),
    beforeDates, afterDates, datesChanged: beforeDates.trim() !== afterDates.trim(),
    beforeLocation, afterLocation, locationChanged: beforeLocation.trim() !== afterLocation.trim(),
    jobStatus: !original ? 'added' : !rewritten ? 'removed' : 'matched',
    bullets
  }
}

// SCAN/ATS (fresh pass): entries used to be paired BY POSITION whenever both lists had the same
// length. The fabrication guard deliberately lets the rewrite reorder jobs, and the delivered-resume
// editor lets the owner drop one job and add another — both keep the length equal, so the screen
// that exists to prove nothing was invented reported a title / dates "change" (Analyst -> Consultant)
// between two different employers, with every bullet shown as removed and re-added. Pairing is now
// by identity: same name first, then a near-identical name (a corrected typo / renamed suffix) or a
// shared date range or bullet; only entries that match nothing are shown as added / removed.
const editDistanceAtMost2 = (a, b) => {
  if (Math.abs(a.length - b.length) > 2) return false
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]; prev[0] = i; let rowMin = prev[0]
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = tmp
      if (prev[j] < rowMin) rowMin = prev[j]
    }
    if (rowMin > 2) return false
  }
  return prev[b.length] <= 2
}
const bulletsOf = e => (Array.isArray(e?.bullets) ? e.bullets.map(b => str(b).trim().toLowerCase()).filter(Boolean) : [])
function sameEntry(a, b, keyOf) {
  const ka = normCompany(keyOf(a)), kb = normCompany(keyOf(b))
  if (ka && kb) {
    if (ka === kb) return true
    if (ka.length >= 4 && kb.length >= 4 && (ka.includes(kb) || kb.includes(ka))) return true
    if (ka.length >= 5 && kb.length >= 5 && editDistanceAtMost2(ka, kb)) return true
  }
  const da = str(a?.dates).trim().toLowerCase(), db = str(b?.dates).trim().toLowerCase()
  if (da && da === db) return true
  const ba = bulletsOf(a)
  if (ba.length) { const bb = new Set(bulletsOf(b)); if (ba.some(x => bb.has(x))) return true }
  return false
}
function pairEntries(originalList, rewrittenList, keyOf) {
  const matched = []
  const used = new Set()
  // Pass 1: exact (normalised) name; pass 2: anything that is plainly the same entry, edited.
  const pairOriginal = (item, test) => {
    const idx = rewrittenList.findIndex((r, i) => !used.has(i) && test(r))
    if (idx === -1) return false
    used.add(idx); matched.push({ original: item, rewritten: rewrittenList[idx], idx }); return true
  }
  const paired = new Array(originalList.length).fill(false)
  originalList.forEach((item, n) => {
    const k = normCompany(keyOf(item))
    if (k) paired[n] = pairOriginal(item, r => normCompany(keyOf(r)) === k)
  })
  originalList.forEach((item, n) => {
    if (!paired[n]) paired[n] = pairOriginal(item, r => sameEntry(item, r, keyOf))
  })
  originalList.forEach((item, n) => { if (!paired[n]) matched.push({ original: item, rewritten: null, idx: -1 }) })
  rewrittenList.forEach((r, i) => { if (!used.has(i)) matched.push({ original: null, rewritten: r, idx: -1 }) })
  // Keep the original's order for everything that existed, then the additions.
  const order = new Map(originalList.map((item, n) => [item, n]))
  return matched.sort((x, y) => {
    const ox = x.original ? order.get(x.original) : Infinity, oy = y.original ? order.get(y.original) : Infinity
    return ox - oy
  })
}

function diffExperience(originalJobs, rewrittenJobs) {
  return pairEntries(originalJobs, rewrittenJobs, j => j?.company).map(({ original, rewritten }) => diffJob(original, rewritten))
}

// AUDIT FIX (bug — Scan/ATS section audit): this file's own header comment
// above declares the point of `str()` as coercing every AI-sourced text
// field so a wrong-typed value from Claude's output degrades to '' instead
// of crashing the render — and diffText/diffJob do that correctly. This
// function did not: it used str() only internally, for the norm()
// comparison used to bucket items into unchanged/removed/added, but
// returned the RAW, un-coerced original array elements. DiffView.jsx's
// TagList renders those directly as `{item}` in JSX with no further
// coercion — so a non-string skill/certification entry (nothing enforces
// array-of-strings on the AI's rewrite output before it reaches here)
// would throw "Objects are not valid as a React child" and blank the
// entire delivered-fix results page for a scan the user already paid for.
// Mapping through str() on the way out closes that gap the same way every
// other AI-sourced field in this file already is.
function diffList(before, after) {
  const norm = s => str(s).toLowerCase().trim()
  // Coerce first, then drop anything that coerces down to blank — a
  // malformed entry (an object, null, a number) degrading to '' is safe to
  // render but has zero informational value as a chip, and worse, two
  // UNRELATED malformed entries on either side would both normalize to the
  // same '' key and spuriously match each other as "unchanged," which is
  // its own small but real correctness bug on top of the crash this exists
  // to prevent.
  const beforeStr = before.map(str).filter(s => s.trim())
  const afterStr  = after.map(str).filter(s => s.trim())
  const beforeSet = new Set(beforeStr.map(norm))
  const afterSet  = new Set(afterStr.map(norm))
  return {
    unchanged: beforeStr.filter(s => afterSet.has(norm(s))),
    removed:   beforeStr.filter(s => !afterSet.has(norm(s))),
    added:     afterStr.filter(s => !beforeSet.has(norm(s)))
  }
}

// AUDIT FIX (Auth/Scan round): education and projects went through the same
// rewrite and the same fabrication guard (claude.service.js's detectFabrication
// now checks degree level and dates on education too) as experience, but this
// file never diffed them — a promoted degree or an added/removed project was
// invisible on the one screen meant to show the person everything the AI
// changed. Reuses the same job-diff shape (institution/name stands in for
// company) since a degree entry has no bullet list.
function diffEducation(original, rewritten) {
  const company     = str(original?.institution) || str(rewritten?.institution)
  const beforeTitle = str(original?.degree)
  const afterTitle  = rewritten?.degree !== undefined ? str(rewritten.degree) : beforeTitle
  const beforeDates = str(original?.dates)
  const afterDates  = rewritten?.dates !== undefined ? str(rewritten.dates) : beforeDates
  const beforeDetails = str(original?.details)
  const afterDetails  = rewritten?.details !== undefined ? str(rewritten.details) : beforeDetails
  return {
    company,
    beforeTitle, afterTitle, titleChanged: beforeTitle.trim() !== afterTitle.trim(),
    beforeDates, afterDates, datesChanged: beforeDates.trim() !== afterDates.trim(),
    beforeDetails, afterDetails, detailsChanged: beforeDetails.trim() !== afterDetails.trim(),
    entryStatus: !original ? 'added' : !rewritten ? 'removed' : 'matched',
  }
}
function diffEntryList(originalList, rewrittenList, diffFn, matchKey) {
  return pairEntries(originalList, rewrittenList, matchKey).map(({ original, rewritten }) => diffFn(original, rewritten))
}
function diffProject(original, rewritten) {
  const name = str(original?.name) || str(rewritten?.name)
  const beforeDesc = str(original?.description)
  const afterDesc  = rewritten?.description !== undefined ? str(rewritten.description) : beforeDesc
  return {
    name,
    descChanged: beforeDesc.trim() !== afterDesc.trim(), beforeDesc, afterDesc,
    technologies: diffList(Array.isArray(original?.technologies) ? original.technologies : [], Array.isArray(rewritten?.technologies) ? rewritten.technologies : []),
    entryStatus: !original ? 'added' : !rewritten ? 'removed' : 'matched',
  }
}

// AUDIT FIX (Auth/Scan round): the rewrite prompt is told the header (name,
// email, phone, location, links) must stay in the same schema, but nothing
// ever compared it — a wrong or dropped contact detail (the one thing that
// actually breaks an employer's ability to reach the candidate) had no
// visibility on this screen at all.
function diffContact(original, rewritten) {
  const fields = ['name', 'email', 'phone', 'location', 'linkedin', 'portfolio']
  const changed = fields.map(f => ({ field: f, ...diffText(original?.[f], rewritten?.[f]) })).filter(f => f.changed)
  return { changed }
}

// Volunteer work has the same shape as a job (organization / role / dates / bullets), so it is diffed as one.
const volunteerAsJob = v => (v && typeof v === 'object' ? { company: v.organization, title: v.role, dates: v.dates, bullets: v.bullets } : v)

/**
 * buildResumeDiff(original, rewritten) -> diff object | null
 * Returns null if there's no original data to diff against at all (should
 * only happen if the scan predates Phase 2, or something upstream failed).
 */
export function buildResumeDiff(original, rewritten) {
  if (!original) return null
  return {
    contact:        diffContact(original, rewritten),
    summary:        diffText(original.summary, rewritten?.summary),
    experience:     diffExperience(arr(original?.experience), arr(rewritten?.experience)),
    education:      diffEntryList(arr(original?.education), arr(rewritten?.education), diffEducation, e => e?.institution),
    projects:       diffEntryList(arr(original?.projects), arr(rewritten?.projects), diffProject, p => p?.name),
    skills:         diffList(arr(original?.skills), arr(rewritten?.skills)),
    certifications: diffList(arr(original?.certifications), arr(rewritten?.certifications)),
    // Round 4: sections the owner can now edit in the delivered-resume editor were invisible here.
    languages:      diffList(arr(original?.languages), arr(rewritten?.languages)),
    awards:         diffList(arr(original?.awards), arr(rewritten?.awards)),
    publications:   diffList(arr(original?.publications), arr(rewritten?.publications)),
    volunteer:      diffEntryList(arr(original?.volunteer).map(volunteerAsJob), arr(rewritten?.volunteer).map(volunteerAsJob), diffJob, j => j?.company)
  }
}
