import { describe, it, expect } from 'vitest'
import { scanRowToCamel, toClientScan, SERVER_ONLY_SCAN_FIELDS, CLIENT_SCAN_FIELDS } from '../src/lib/mappers.js'

describe('toClientScan — allow-list serializer', () => {
  const keys = Object.keys(scanRowToCamel({ id: 'x' }))
  it('every field scanRowToCamel produces is classified exactly once (a new column forces a decision)', () => {
    const unclassified = keys.filter(k => !SERVER_ONLY_SCAN_FIELDS.includes(k) && !CLIENT_SCAN_FIELDS.includes(k))
    expect(unclassified).toEqual([])
    expect(SERVER_ONLY_SCAN_FIELDS.filter(k => CLIENT_SCAN_FIELDS.includes(k))).toEqual([])
    expect([...SERVER_ONLY_SCAN_FIELDS, ...CLIENT_SCAN_FIELDS].filter(k => !keys.includes(k))).toEqual([])
  })
  it('never lets a server-only field or an unknown future field out', () => {
    const scan = { ...scanRowToCamel({ id: 'x', anon_token: 'hash', resume_path: 'k', full_ats_report: {} }), futureSecret: 's' }
    const out = toClientScan(scan)
    for (const k of SERVER_ONLY_SCAN_FIELDS) expect(out).not.toHaveProperty(k)
    expect(out).not.toHaveProperty('futureSecret')
    expect(out.id).toBe('x')
  })
  it('lets the waiting-screen telemetry out (0088), and reads a row that predates it as null, not undefined', () => {
    const fp = { startedAt: 't', round: 1, phase: 'rewriting', attempt: 2, of: 3, scores: [70] }
    const out = toClientScan(scanRowToCamel({ id: 'x', scan_stage: 'scoring', fix_progress: fp }))
    expect(out.scanStage).toBe('scoring')
    expect(out.fixProgress).toEqual(fp)
    const old = toClientScan(scanRowToCamel({ id: 'y' }))
    expect(old.scanStage).toBeNull()
    expect(old.fixProgress).toBeNull()
  })
})
