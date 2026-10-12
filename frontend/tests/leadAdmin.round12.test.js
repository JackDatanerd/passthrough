import { describe, it, expect } from 'vitest'
import { auditDetailParts } from '../src/lib/auditDetail.js'
import { spreadRepeats, chunk } from '../src/lib/leadImport.js'

describe('auditDetailParts (round 12): no more "[object Object]" in the audit log', () => {
  it('an export with no filters shows nothing for them, with filters shows them readably', () => {
    expect(auditDetailParts({ rows: 40, truncated: false, filters: {}, searched: false })).toEqual(['rows: 40', 'truncated: no', 'searched: no'])
    expect(auditDetailParts({ filters: { status: 'NEW', field: 'sales' } })).toEqual(['filters: status NEW, field sales'])
  })
  it('long id lists are summarised, short ones shown', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `id${i}`)
    expect(auditDetailParts({ ids })).toEqual(['ids: id0, id1, id2 … (2000 in all)'])
    expect(auditDetailParts({ ids: ['a', 'b'] })).toEqual(['ids: a, b'])
    expect(auditDetailParts({ ids: [] })).toEqual([])
  })
  it('keeps booleans, numbers (including 0) and drops empty values; nothing renders as [object Object]', () => {
    const parts = auditDetailParts({ sent: 0, ok: true, none: null, blank: '', nested: { a: { b: 1 } }, list: [{ x: 1 }, { y: 2 }] })
    expect(parts).toEqual(['sent: 0', 'ok: yes', 'nested: a b 1', 'list: 2 items'])
    expect(parts.join(' ')).not.toMatch(/\[object Object\]/)
  })
  it('copes with a missing detail', () => { expect(auditDetailParts(undefined)).toEqual([]); expect(auditDetailParts(null)).toEqual([]) })
})

describe('spreadRepeats (round 12): the import check counts an address once, however the file is batched', () => {
  const row = (email) => ({ name: 'A', company: 'B', email })
  it('keeps the first copy and reports later ones with their original line numbers', () => {
    const { send, lineOf, repeats } = spreadRepeats([row('a@x.com'), row('b@x.com'), row(' A@X.com '), row('c@x.com'), row('b@x.com')])
    expect(send.map(r => r.email)).toEqual(['a@x.com', 'b@x.com', 'c@x.com'])
    expect(lineOf).toEqual([1, 2, 4])
    expect(repeats).toEqual([{ line: 3, email: 'a@x.com' }, { line: 5, email: 'b@x.com' }])
  })
  it('a repeat 300 rows later (a different upload batch) is caught', () => {
    const rows = Array.from({ length: 300 }, (_, i) => row(`u${i}@x.com`)); rows.push(row('u0@x.com'))
    const { send, repeats } = spreadRepeats(rows)
    expect(repeats).toEqual([{ line: 301, email: 'u0@x.com' }])
    expect(chunk(send).flat().filter(r => r.email === 'u0@x.com')).toHaveLength(1)
  })
  it('rows without an address are passed through for the server to call invalid, never merged with each other', () => {
    const { send, repeats } = spreadRepeats([row(''), row(''), { name: 'x' }])
    expect(send).toHaveLength(3); expect(repeats).toEqual([])
  })
})
