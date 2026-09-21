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

function normCompany(s) {
  return str(s).toLowerCase().replace(/[.,]/g, '').trim()
}

function diffText(before, after) {
  const b = str(before).trim()
  const a = str(after).trim()
  return { before: b, after: a, changed: b !== a }
}

function diffJob(original, rewritten) {
  const company     = str(original?.company) || str(rewritten?.company)
  const beforeTitle = str(original?.title)
  const afterTitle  = rewritten?.title !== undefined ? str(rewritten.title) : beforeTitle
  const beforeDates = str(original?.dates)
  const afterDates  = rewritten?.dates !== undefined ? str(rewritten.dates) : beforeDates

  const beforeBullets = Array.isArray(original?.bullets) ? original.bullets : []
  const afterBullets  = Array.isArray(rewritten?.bullets) ? rewritten.bullets : []
  const maxLen = Math.max(beforeBullets.length, afterBullets.length)
  const bullets = []
  for (let i = 0; i < maxLen; i++) {
    const before = beforeBullets[i]
    const after  = afterBullets[i]
    if (before !== undefined && after !== undefined) {
      bullets.push({ before: str(before), after: str(after), status: str(before).trim() === str(after).trim() ? 'unchanged' : 'changed' })
    } else if (before !== undefined) {
      bullets.push({ before: str(before), after: null, status: 'removed' })
    } else {
      bullets.push({ before: null, after: str(after), status: 'added' })
    }
  }

  return {
    company,
    beforeTitle, afterTitle, titleChanged: beforeTitle.trim() !== afterTitle.trim(),
    beforeDates, afterDates, datesChanged: beforeDates.trim() !== afterDates.trim(),
    jobStatus: !original ? 'added' : !rewritten ? 'removed' : 'matched',
    bullets
  }
}

function diffExperience(originalJobs, rewrittenJobs) {
  const matched = []
  const usedRewrittenIdx = new Set()

  if (originalJobs.length === rewrittenJobs.length) {
    originalJobs.forEach((job, i) => {
      matched.push({ original: job, rewritten: rewrittenJobs[i] })
      usedRewrittenIdx.add(i)
    })
  } else {
    originalJobs.forEach(job => {
      const idx = rewrittenJobs.findIndex(
        (r, i) => !usedRewrittenIdx.has(i) && normCompany(r.company) === normCompany(job.company)
      )
      if (idx !== -1) {
        matched.push({ original: job, rewritten: rewrittenJobs[idx] })
        usedRewrittenIdx.add(idx)
      } else {
        matched.push({ original: job, rewritten: null })
      }
    })
    rewrittenJobs.forEach((r, i) => {
      if (!usedRewrittenIdx.has(i)) matched.push({ original: null, rewritten: r })
    })
  }

  return matched.map(({ original, rewritten }) => diffJob(original, rewritten))
}

function diffList(before, after) {
  const norm = s => str(s).toLowerCase().trim()
  const beforeSet = new Set(before.map(norm))
  const afterSet  = new Set(after.map(norm))
  return {
    unchanged: before.filter(s => afterSet.has(norm(s))),
    removed:   before.filter(s => !afterSet.has(norm(s))),
    added:     after.filter(s => !beforeSet.has(norm(s)))
  }
}

/**
 * buildResumeDiff(original, rewritten) -> diff object | null
 * Returns null if there's no original data to diff against at all (should
 * only happen if the scan predates Phase 2, or something upstream failed).
 */
export function buildResumeDiff(original, rewritten) {
  if (!original) return null
  return {
    summary:        diffText(original.summary, rewritten?.summary),
    experience:     diffExperience(original.experience || [], rewritten?.experience || []),
    skills:         diffList(original.skills || [], rewritten?.skills || []),
    certifications: diffList(original.certifications || [], rewritten?.certifications || [])
  }
}
