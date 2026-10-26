import { ATS_PASS_THRESHOLD, ATS_BADGE_THRESHOLD, MAX_FIX_RETRIES } from './scoreThresholds'
import { IN_FLIGHT_STATUSES, isLive } from './scanDisplay'

// The dashboard's rules, as pure functions: what a scan needs from its owner next, which stage it is
// at, what to tell them, and which scan deserves the "best next step" card. No React in here so the
// rules can be tested without rendering anything.

// ── Status filters ────────────────────────────────────────────────────────────
// Mirrors backend src/lib/scanSearch.js (SCAN_STATUSES / STATUS_GROUPS): a chip is either one real status
// or a fixed list of them, and the server applies the SAME definition to the list and to "delete these".
export const SCAN_STATUSES = ['PENDING', 'SCANNING', 'COMPLETE_PASS', 'COMPLETE_FAIL', 'FIX_PURCHASED', 'FIX_GENERATING', 'FIX_DELIVERED', 'ERROR']
export const STATUS_GROUPS = {
  IN_PROGRESS: ['PENDING', 'SCANNING', 'FIX_PURCHASED', 'FIX_GENERATING'],
  NEEDS_DECISION: ['COMPLETE_PASS', 'COMPLETE_FAIL'],
}
export const STATUS_FILTERS = [...SCAN_STATUSES, ...Object.keys(STATUS_GROUPS)]

// The chips, in order. '' is "All" (no filter).
export const CHIPS = [
  { key: '', label: 'All' },
  { key: 'NEEDS_DECISION', label: 'Needs a decision' },
  { key: 'IN_PROGRESS', label: 'In progress' },
  { key: 'FIX_DELIVERED', label: 'Delivered' },
  { key: 'ERROR', label: "Didn't finish" },
]

// How many of `scans` a chip would show (exactly what the server would return for it).
export function chipCount(scans, key) {
  if (!key) return scans.length
  const members = STATUS_GROUPS[key] || [key]
  return scans.filter(s => members.includes(s.status)).length
}

// ── Scores ────────────────────────────────────────────────────────────────────
// The number the row shows: the fixed resume's score once a fix is purchased and scored, else the original.
export function displayScore(scan) {
  return scan.fixPurchased && scan.fixAtsScore != null ? scan.fixAtsScore : scan.atsScore
}

// Same test Verify.jsx / the old dashboard used: a code, not revoked, and at or above the badge line.
export function isVerified(scan) {
  const n = displayScore(scan)
  return !!scan.verificationCode && scan.verificationStatus !== 'REVOKED' && n != null && n >= ATS_BADGE_THRESHOLD
}

// Free "Try again" runs still available on a delivered fix (a credential-only purchase has none).
export function retriesLeft(scan) {
  if (scan.status !== 'FIX_DELIVERED' || scan.fixTier === 'BADGE') return 0
  return Math.max(0, MAX_FIX_RETRIES - (scan.fixRetryCount || 0))
}

export const pointsTo = (scan, target) => Math.max(0, target - (displayScore(scan) ?? 0))
const pl = n => `${n} point${n === 1 ? '' : 's'}`

// ── What a scan needs ────────────────────────────────────────────────────────
//   wait      a job is working on it (live)
//   stuck     in flight but untouched for over an hour: the job died; it can be deleted
//   error     did not finish
//   share     fixed and verified
//   retryfix  fixed, below the credential line, free retries left
//   download  fixed (and either verified-without-code, revoked, or out of retries)
//   cred      scored above the credential line: no rewrite needed
//   fix       scored; a fix is the next move
export function scanNeed(scan, now = Date.now()) {
  if (scan.status === 'ERROR') return 'error'
  if (IN_FLIGHT_STATUSES.includes(scan.status)) return isLive(scan, now) ? 'wait' : 'stuck'
  const n = displayScore(scan)
  if (scan.status === 'FIX_DELIVERED') {
    if (isVerified(scan)) return 'share'
    if (n != null && n < ATS_BADGE_THRESHOLD && retriesLeft(scan) > 0) return 'retryfix'
    return 'download'
  }
  if (n != null && n >= ATS_BADGE_THRESHOLD) return 'cred'
  return 'fix'
}

// Scanned → Fixed → Verified, each 'done' | 'now' | 'todo'.
export function stages(scan, now = Date.now()) {
  const need = scanNeed(scan, now)
  if (need === 'error') return scan.fixPurchased ? ['done', 'todo', 'todo'] : ['todo', 'todo', 'todo']   // a paid fix that failed: the scan itself finished
  if (['PENDING', 'SCANNING'].includes(scan.status)) return ['now', 'todo', 'todo']
  const fixed = scan.status === 'FIX_DELIVERED' ? 'done' : ['FIX_PURCHASED', 'FIX_GENERATING'].includes(scan.status) ? 'now' : 'todo'
  return ['done', fixed, isVerified(scan) ? 'done' : 'todo']
}

// The passage a row shows, by what was bought: a credential-only purchase rewrites nothing (Scanned, Verified); a plain fix has no
// credential to earn (Scanned, Fixed); the full fix is all three, and so is a scan nobody has paid for yet (that is what is on offer).
export function passage(scan, now = Date.now()) {
  const [scanned, fixed, verified] = stages(scan, now)
  const bought = !!scan.fixPurchased || ['FIX_PURCHASED', 'FIX_GENERATING', 'FIX_DELIVERED'].includes(scan.status)
  if (bought && scan.fixTier === 'BADGE') return [{ name: 'Scanned', state: scanned }, { name: 'Verified', state: fixed === 'now' ? 'now' : verified }]
  if (bought && scan.fixTier === 'FIX_PLAIN') return [{ name: 'Scanned', state: scanned }, { name: 'Fixed', state: fixed }]
  return [{ name: 'Scanned', state: scanned }, { name: 'Fixed', state: fixed }, { name: 'Verified', state: verified }]
}

// One line for the row: { tone: 'g'|'a'|'r'|'b', label, text }.
export function scanMessage(scan, now = Date.now()) {
  const need = scanNeed(scan, now)
  const n = displayScore(scan)
  switch (need) {
    case 'wait':
      if (scan.status === 'FIX_PURCHASED') return { tone: 'b', label: 'Payment received', text: scan.fixTier === 'BADGE' ? 'Starting your verification.' : 'Starting your fix.' }
      if (scan.status === 'FIX_GENERATING') return scan.fixTier === 'BADGE'
        ? { tone: 'b', label: 'Verifying', text: `Score ${scan.atsScore ?? ''}. You can leave this page; we email you when your link is ready.` }
        : { tone: 'b', label: 'Writing your fix', text: `Original score ${scan.atsScore ?? '—'}. You can leave this page; we email you when it is ready.` }
      return { tone: 'b', label: 'Scanning', text: 'Usually about a minute. You can leave this page.' }
    case 'stuck':
      return { tone: 'a', label: 'Looks stuck', text: 'This has not moved for over an hour. You can delete it and scan again.' }
    case 'error':
      return { tone: 'r', label: "Didn't finish", text: 'Open it to see what happened.' }
    case 'share':
      if (scan.fixTier === 'BADGE') return { tone: 'g', label: '\u2713 Verified', text: `Score ${scan.fixAtsScore}. Employers can open your link.` }
      return { tone: 'g', label: '✓ Verified', text: `${scan.atsScore ?? '—'} → ${scan.fixAtsScore}. Employers can open your link.` }
    case 'retryfix': {
      const left = retriesLeft(scan)
      return { tone: 'a', label: 'Fix delivered', text: `${scan.atsScore ?? '—'} → ${n}, ${pl(pointsTo(scan, ATS_BADGE_THRESHOLD))} short of ${ATS_BADGE_THRESHOLD}. ${left} free ${left === 1 ? 'retry' : 'retries'} left.` }
    }
    case 'download': {
      if (scan.verificationStatus === 'REVOKED') return { tone: 'r', label: 'Verification removed', text: 'Your public link no longer works.' }
      // A credential-only delivery fixes nothing: it either issued the link or it did not, and there are no retries to speak of.
      if (scan.fixTier === 'BADGE') {
        return n != null && n < ATS_BADGE_THRESHOLD
          ? { tone: 'a', label: 'Credential not issued', text: `The formatted file scored ${n}, under ${ATS_BADGE_THRESHOLD}. A free fix credit is on your account.` }
          : { tone: 'g', label: 'Files ready', text: `Score ${n}.` }
      }
      const gain = `${scan.atsScore ?? '—'} → ${n}`
      if (n != null && n < ATS_BADGE_THRESHOLD)
        return { tone: 'a', label: 'Fix delivered', text: `${gain}, ${pl(pointsTo(scan, ATS_BADGE_THRESHOLD))} short of ${ATS_BADGE_THRESHOLD}. No retries left; a free fix credit covers your next fix.` }
      return { tone: 'g', label: 'Fix delivered', text: `${gain}.` }
    }
    case 'cred':
      return { tone: 'g', label: 'Passed', text: `Already above ${ATS_BADGE_THRESHOLD}, so no rewrite is needed to get the credential.` }
    default:
      if (n != null && n >= ATS_PASS_THRESHOLD) return { tone: 'a', label: 'Passed', text: `${pl(pointsTo(scan, ATS_BADGE_THRESHOLD))} from the credential.` }
      if (n == null) return { tone: 'a', label: 'Scanned', text: 'Open it to see the result.' }
      return { tone: 'r', label: 'Below the pass line', text: `${pointsTo(scan, ATS_PASS_THRESHOLD)} short of ${ATS_PASS_THRESHOLD}.` }
  }
}

// ── Best next step ────────────────────────────────────────────────────────────
// Ordered [{ kind, scan }]: already credential-ready first, then the scans closest to the credential,
// then a delivered fix that is still below the pass line but has free retries left (a free move beats paying
// again), then the best of the ones below the pass line, then anything that failed, went quiet for over an
// hour (`stuck`) or is still running. Every scan whose row asks the person to act has a place here — a list
// with none of them is genuinely "all caught up".
// (Interview follow-ups are not in here: <OutcomeCard> owns that question and its 14-day timing.)
export function nextSteps(scans, now = Date.now()) {
  const byNewest = (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || 0
  const needOf = new Map(scans.map(s => [s.id, scanNeed(s, now)]))
  const out = []
  const cred = scans.filter(s => needOf.get(s.id) === 'cred').sort(byNewest)[0]
  if (cred) out.push({ kind: 'cred', scan: cred })
  scans
    .filter(s => ['fix', 'retryfix'].includes(needOf.get(s.id)) && displayScore(s) >= ATS_PASS_THRESHOLD && displayScore(s) < ATS_BADGE_THRESHOLD)
    .sort((a, b) => pointsTo(a, ATS_BADGE_THRESHOLD) - pointsTo(b, ATS_BADGE_THRESHOLD) || byNewest(a, b))
    .slice(0, 2).forEach(scan => out.push({ kind: 'close', scan }))
  // 'retryfix' is only ever a delivered fix with a score, so the score test below cannot meet a null. Between the
  // pass line and the credential line the scan is already a 'close' step above.
  const retry = scans
    .filter(s => needOf.get(s.id) === 'retryfix' && displayScore(s) < ATS_PASS_THRESHOLD)
    .sort((a, b) => displayScore(b) - displayScore(a) || byNewest(a, b))[0]
  if (retry) out.push({ kind: 'retry', scan: retry })
  const low = scans
    .filter(s => needOf.get(s.id) === 'fix' && displayScore(s) != null && displayScore(s) < ATS_PASS_THRESHOLD)
    .sort((a, b) => displayScore(b) - displayScore(a) || byNewest(a, b))[0]
  if (low) out.push({ kind: 'fix', scan: low })
  const err = scans.filter(s => needOf.get(s.id) === 'error').sort(byNewest)[0]
  if (err) out.push({ kind: 'error', scan: err })
  const stuck = scans.filter(s => needOf.get(s.id) === 'stuck').sort(byNewest)[0]
  if (stuck) out.push({ kind: 'stuck', scan: stuck })
  const busy = scans.filter(s => needOf.get(s.id) === 'wait').sort(byNewest)[0]
  if (busy) out.push({ kind: 'busy', scan: busy })
  return out
}

// The best score so far at each scored scan, oldest first: the line under "Best score".
export function bestTrend(scans) {
  const pts = []
  let best = null
  ;[...scans].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).forEach(s => {
    const n = displayScore(s)
    if (n == null || s.status === 'ERROR') return
    best = best == null ? n : Math.max(best, n)
    pts.push(best)
  })
  return pts
}
