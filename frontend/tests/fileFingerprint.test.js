import { describe, it, expect } from 'vitest'
import { classifyFingerprint } from '../src/lib/fileFingerprint.js'

// SECTION 7 AUDIT (feature gap closed): classifyFingerprint used to collapse
// a 'previous' match down to a bare status string, discarding which entry
// matched and its `at` — the one thing that makes "you have an earlier
// version" actually useful to the reader ("earlier as of when?"). This
// covers the richer { status, at, kind } contract end to end.

describe('classifyFingerprint', () => {
  const fingerprints = {
    docx: 'current-docx-hash',
    pdf:  'current-pdf-hash',
    previous: [
      { kind: 'docx', hash: 'old-docx-1', at: '2026-01-15T00:00:00Z' },
      { kind: 'pdf',  hash: 'old-pdf-1',  at: '2026-02-20T00:00:00Z' },
    ],
  }

  it('reports "current" for either the current docx or pdf hash, with no date/kind', () => {
    expect(classifyFingerprint('current-docx-hash', fingerprints)).toEqual({ status: 'current', at: null, kind: null })
    expect(classifyFingerprint('current-pdf-hash', fingerprints)).toEqual({ status: 'current', at: null, kind: null })
  })

  it('reports "previous" with the matched entry\'s date and file type', () => {
    expect(classifyFingerprint('old-docx-1', fingerprints)).toEqual({ status: 'previous', at: '2026-01-15T00:00:00Z', kind: 'docx' })
    expect(classifyFingerprint('old-pdf-1', fingerprints)).toEqual({ status: 'previous', at: '2026-02-20T00:00:00Z', kind: 'pdf' })
  })

  // A superseded entry with no recorded `at` (older data, or a field that
  // was never backfilled) still reports 'previous' — just without a date,
  // rather than lumping it in with a genuine 'mismatch'.
  it('still reports "previous" when a matched entry has no recorded `at`', () => {
    const fp = { docx: 'cur', pdf: null, previous: [{ kind: 'docx', hash: 'old', at: null }] }
    expect(classifyFingerprint('old', fp)).toEqual({ status: 'previous', at: null, kind: null })
  })

  it('reports "mismatch" for a hash that matches nothing on file', () => {
    expect(classifyFingerprint('never-seen', fingerprints)).toEqual({ status: 'mismatch', at: null, kind: null })
  })

  it('reports "unavailable" when there are no fingerprints to check against', () => {
    expect(classifyFingerprint('anything', null)).toEqual({ status: 'unavailable', at: null, kind: null })
    expect(classifyFingerprint('anything', { docx: null, pdf: null, previous: [] })).toEqual({ status: 'unavailable', at: null, kind: null })
  })
})
