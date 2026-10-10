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
})
