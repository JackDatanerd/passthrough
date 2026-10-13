import { describe, it, expect } from 'vitest'
import { nextSteps, scanNeed } from '../src/lib/scanNext'

// Profile & Dashboard round 12 (B1): a scan that needs the person's action must never fall through
// nextSteps() into "All caught up".
const NOW = Date.parse('2026-10-12T12:00:00Z')
const recent = '2026-10-12T11:50:00Z'
const old = '2026-10-12T09:00:00Z'   // over an hour before NOW
const scan = (id, over = {}) => ({
  id, status: 'COMPLETE_FAIL', atsScore: 60, fixPurchased: false, fixAtsScore: null, fixTier: null, fixRetryCount: 0,
  verificationCode: null, verificationStatus: null, createdAt: '2026-10-01T10:00:00Z', updatedAt: recent, jobTitle: `Job ${id}`, ...over,
})
const delivered = (id, over = {}) => scan(id, { status: 'FIX_DELIVERED', atsScore: 40, fixPurchased: true, fixAtsScore: 62, fixTier: 'FIX', ...over })
const kinds = (scans) => nextSteps(scans, NOW).map(s => `${s.kind}:${s.scan.id}`)

describe('a delivered fix that is still below the pass line, with free retries left', () => {
  it('is its own next step (it used to vanish, leaving "All caught up")', () => {
    expect(scanNeed(delivered('a'), NOW)).toBe('retryfix')
    expect(kinds([delivered('a')])).toEqual(['retry:a'])
  })
  it('is not offered once the retries are used up (nothing left to do on that scan)', () => {
    expect(kinds([delivered('a', { fixRetryCount: 2 })])).toEqual([])
  })
  it('a badge-only purchase has no retries, so it is not offered either', () => {
    expect(kinds([delivered('a', { fixTier: 'BADGE' })])).toEqual([])
  })
  it('between the pass line and the credential line it stays a "close" step, not a second entry', () => {
    expect(kinds([delivered('a', { fixAtsScore: 78 })])).toEqual(['close:a'])
  })
  it('a free retry ranks ahead of paying for another fix on a different scan', () => {
    expect(kinds([scan('low', { atsScore: 50 }), delivered('a')])).toEqual(['retry:a', 'fix:low'])
  })
  it('when several qualify the best-scoring one is picked, newest on a tie', () => {
    const a = delivered('a', { fixAtsScore: 55 }), b = delivered('b', { fixAtsScore: 70 }), c = delivered('c', { fixAtsScore: 70, createdAt: '2026-10-05T10:00:00Z' })
    expect(kinds([a, b, c])[0]).toBe('retry:c')
  })
})

describe('a scan stuck in progress for over an hour', () => {
  it('is surfaced (it used to leave "All caught up" next to a "Looks stuck" row)', () => {
    expect(scanNeed(scan('s', { status: 'SCANNING', updatedAt: old }), NOW)).toBe('stuck')
    expect(kinds([scan('s', { status: 'SCANNING', updatedAt: old })])).toEqual(['stuck:s'])
  })
  it('sits after a failed scan and before one that is genuinely running', () => {
    const err = scan('e', { status: 'ERROR' }), stuck = scan('s', { status: 'SCANNING', updatedAt: old }), busy = scan('b', { status: 'SCANNING' })
    expect(kinds([busy, stuck, err])).toEqual(['error:e', 'stuck:s', 'busy:b'])
  })
  it('a live scan is still just "busy"', () => {
    expect(kinds([scan('b', { status: 'SCANNING' })])).toEqual(['busy:b'])
  })
})

describe('what already worked is unchanged', () => {
  it('credential-ready first, then close, then the best low scan, then error, then busy', () => {
    const cred = scan('cred', { status: 'COMPLETE_PASS', atsScore: 85 }), close = scan('close', { atsScore: 77 }), low = scan('low', { atsScore: 50 })
    const err = scan('err', { status: 'ERROR' }), busy = scan('busy', { status: 'SCANNING' })
    expect(kinds([busy, err, low, close, cred])).toEqual(['cred:cred', 'close:close', 'fix:low', 'error:err', 'busy:busy'])
  })
  it('nothing needing action is an empty list', () => {
    expect(kinds([delivered('a', { fixAtsScore: 90, verificationCode: 'C1' })])).toEqual([])
  })
})
