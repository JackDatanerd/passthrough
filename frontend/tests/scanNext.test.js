import { describe, it, expect } from 'vitest'
import {
  CHIPS, STATUS_FILTERS, STATUS_GROUPS, chipCount, displayScore, isVerified, retriesLeft,
  scanNeed, scanMessage, stages, nextSteps, bestTrend,
} from '../src/lib/scanNext'

const NOW = Date.parse('2026-10-12T12:00:00Z')
const recent = '2026-10-12T11:50:00Z'
const old = '2026-10-12T09:00:00Z'   // over an hour before NOW
const scan = (id, over = {}) => ({
  id, status: 'COMPLETE_FAIL', atsScore: 60, fixPurchased: false, fixAtsScore: null, fixTier: null, fixRetryCount: 0,
  verificationCode: null, verificationStatus: null, createdAt: '2026-10-01T10:00:00Z', updatedAt: recent, jobTitle: `Job ${id}`, ...over,
})
const delivered = (id, over = {}) => scan(id, { status: 'FIX_DELIVERED', atsScore: 55, fixPurchased: true, fixAtsScore: 88, fixTier: 'FIX', verificationCode: `C${id}`, ...over })

describe('status filters', () => {
  it('every chip is a valid filter, and a group is only real statuses', () => {
    for (const c of CHIPS) if (c.key) expect(STATUS_FILTERS).toContain(c.key)
    expect(STATUS_GROUPS.IN_PROGRESS).toEqual(['PENDING', 'SCANNING', 'FIX_PURCHASED', 'FIX_GENERATING'])
    expect(STATUS_GROUPS.NEEDS_DECISION).toEqual(['COMPLETE_PASS', 'COMPLETE_FAIL'])
  })
  it('counts exactly what the server would return for a chip', () => {
    const all = [scan('a'), scan('b', { status: 'COMPLETE_PASS' }), scan('c', { status: 'SCANNING' }), scan('d', { status: 'FIX_PURCHASED' }), delivered('e'), scan('f', { status: 'ERROR' })]
    expect(chipCount(all, '')).toBe(6)
    expect(chipCount(all, 'NEEDS_DECISION')).toBe(2)
    expect(chipCount(all, 'IN_PROGRESS')).toBe(2)
    expect(chipCount(all, 'FIX_DELIVERED')).toBe(1)
    expect(chipCount(all, 'ERROR')).toBe(1)
  })
})

describe('scores and verification', () => {
  it('shows the fixed score once a fix is purchased and scored, else the original', () => {
    expect(displayScore(scan('a'))).toBe(60)
    expect(displayScore(delivered('a'))).toBe(88)
    expect(displayScore(scan('a', { fixPurchased: true, fixAtsScore: null }))).toBe(60)
  })
  it('verified needs a code, no revocation, and a score at the credential line', () => {
    expect(isVerified(delivered('a'))).toBe(true)
    expect(isVerified(delivered('a', { verificationCode: null }))).toBe(false)
    expect(isVerified(delivered('a', { verificationStatus: 'REVOKED' }))).toBe(false)
    expect(isVerified(delivered('a', { fixAtsScore: 79 }))).toBe(false)
  })
  it('free retries: two in total, none for a credential-only purchase, none before a delivery', () => {
    expect(retriesLeft(delivered('a', { fixAtsScore: 78 }))).toBe(2)
    expect(retriesLeft(delivered('a', { fixAtsScore: 78, fixRetryCount: 1 }))).toBe(1)
    expect(retriesLeft(delivered('a', { fixAtsScore: 78, fixRetryCount: 5 }))).toBe(0)
    expect(retriesLeft(delivered('a', { fixTier: 'BADGE' }))).toBe(0)
    expect(retriesLeft(scan('a'))).toBe(0)
  })
})

describe('what a scan needs', () => {
  it('a scan that is paid for and being written is never offered a fix again', () => {
    for (const status of ['FIX_PURCHASED', 'FIX_GENERATING']) {
      const s = scan('a', { status, fixPurchased: true })
      expect(scanNeed(s, NOW)).toBe('wait')
      expect(scanMessage(s, NOW).tone).toBe('b')
    }
    expect(scanMessage(scan('a', { status: 'FIX_PURCHASED' }), NOW).label).toBe('Payment received')
  })
  it('PENDING and SCANNING are live too; the same scan untouched for over an hour is stuck, not busy', () => {
    expect(scanNeed(scan('a', { status: 'PENDING' }), NOW)).toBe('wait')
    expect(scanNeed(scan('a', { status: 'SCANNING', updatedAt: old }), NOW)).toBe('stuck')
    expect(scanMessage(scan('a', { status: 'SCANNING', updatedAt: old }), NOW).label).toBe('Looks stuck')
  })
  it('covers the scored and delivered cases', () => {
    expect(scanNeed(scan('a', { status: 'ERROR' }), NOW)).toBe('error')
    expect(scanNeed(scan('a', { atsScore: 62 }), NOW)).toBe('fix')
    expect(scanNeed(scan('a', { status: 'COMPLETE_PASS', atsScore: 79 }), NOW)).toBe('fix')
    expect(scanNeed(scan('a', { status: 'COMPLETE_PASS', atsScore: 84 }), NOW)).toBe('cred')
    expect(scanNeed(delivered('a'), NOW)).toBe('share')
    expect(scanNeed(delivered('a', { fixAtsScore: 78 }), NOW)).toBe('retryfix')
    expect(scanNeed(delivered('a', { fixAtsScore: 78, fixRetryCount: 2 }), NOW)).toBe('download')
  })
  it('a revoked link says so instead of "Verified"', () => {
    const s = delivered('a', { verificationStatus: 'REVOKED' })
    expect(scanNeed(s, NOW)).toBe('download')
    expect(scanMessage(s, NOW).label).toBe('Verification removed')
  })
  it('messages say how far a fix still is from the credential, and how many retries remain', () => {
    expect(scanMessage(delivered('a', { fixAtsScore: 78 }), NOW).text).toMatch(/2 points short of 80\. 2 free retries left/)
    expect(scanMessage(delivered('a', { fixAtsScore: 78, fixRetryCount: 1 }), NOW).text).toMatch(/1 free retry left/)
    expect(scanMessage(delivered('a', { fixAtsScore: 78, fixRetryCount: 2 }), NOW).text).toMatch(/No retries left; a free fix credit/)
    expect(scanMessage(scan('a', { atsScore: 41 }), NOW).text).toBe('34 short of 75.')
  })
})

describe('stages', () => {
  it('Scanned → Fixed → Verified', () => {
    expect(stages(scan('a', { status: 'SCANNING' }), NOW)).toEqual(['now', 'todo', 'todo'])
    expect(stages(scan('a', { status: 'ERROR' }), NOW)).toEqual(['todo', 'todo', 'todo'])
    expect(stages(scan('a'), NOW)).toEqual(['done', 'todo', 'todo'])
    expect(stages(scan('a', { status: 'FIX_PURCHASED' }), NOW)).toEqual(['done', 'now', 'todo'])
    expect(stages(scan('a', { status: 'FIX_GENERATING' }), NOW)).toEqual(['done', 'now', 'todo'])
    expect(stages(delivered('a', { fixAtsScore: 78 }), NOW)).toEqual(['done', 'done', 'todo'])
    expect(stages(delivered('a'), NOW)).toEqual(['done', 'done', 'done'])
  })
})

describe('nextSteps', () => {
  it('puts a credential-ready scan first, then the ones closest to the credential, then the best below the pass line', () => {
    const list = [
      scan('low', { atsScore: 62 }), scan('far', { status: 'COMPLETE_PASS', atsScore: 76 }), scan('near', { status: 'COMPLETE_PASS', atsScore: 79 }),
      scan('ready', { status: 'COMPLETE_PASS', atsScore: 85 }), scan('err', { status: 'ERROR' }), scan('busy', { status: 'SCANNING' }),
    ]
    expect(nextSteps(list, NOW).map(s => `${s.kind}:${s.scan.id}`)).toEqual(['cred:ready', 'close:near', 'close:far', 'fix:low', 'error:err', 'busy:busy'])
  })
  it('with nothing to do there are no steps; a scan with free retries left counts as close', () => {
    expect(nextSteps([delivered('a')], NOW)).toEqual([])
    expect(nextSteps([delivered('a', { fixAtsScore: 78 })], NOW)).toEqual([{ kind: 'close', scan: expect.objectContaining({ id: 'a' }) }])
  })
  it('a paid scan that is being written is "busy", never a fix suggestion', () => {
    const steps = nextSteps([scan('a', { status: 'FIX_PURCHASED', atsScore: 60 })], NOW)
    expect(steps.map(s => s.kind)).toEqual(['busy'])
  })
})

describe('bestTrend', () => {
  it('is the best score so far at each scored scan, oldest first, ignoring failures', () => {
    const list = [
      scan('c', { atsScore: 70, createdAt: '2026-10-03T00:00:00Z' }), scan('a', { atsScore: 48, createdAt: '2026-10-01T00:00:00Z' }),
      scan('x', { status: 'ERROR', atsScore: null, createdAt: '2026-10-02T00:00:00Z' }), delivered('d', { createdAt: '2026-10-04T00:00:00Z' }),
    ]
    expect(bestTrend(list)).toEqual([48, 70, 88])
  })
})
