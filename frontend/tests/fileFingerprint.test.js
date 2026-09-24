import { describe, it, expect } from 'vitest'
import { classifyFingerprint, fileKindOf } from '../src/lib/fileFingerprint.js'

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
  //
  // BUG FIX (traced from Section 9/10 pass — out of scope but found via the
  // full test-suite run): this assertion expected `kind: null` even though
  // the fixture's matched entry has `kind: 'docx'` — a copy-paste from the
  // 'mismatch' case below, which genuinely has no match to take a kind from.
  // classifyFingerprint's own doc comment says `kind` is "which file type
  // matched", independent of whether `at` was recorded, and the
  // implementation already does exactly that (`match.kind || null`). The
  // implementation was correct; only this assertion was wrong.
  it('still reports "previous" when a matched entry has no recorded `at`', () => {
    const fp = { docx: 'cur', pdf: null, previous: [{ kind: 'docx', hash: 'old', at: null }] }
    // The entry names its file type, so that is carried through even without a date.
    expect(classifyFingerprint('old', fp)).toEqual({ status: 'previous', at: null, kind: 'docx' })
  })

  it('carries kind: null through when a superseded entry names neither a date nor a type', () => {
    const fp = { docx: 'cur', pdf: null, previous: [{ hash: 'old' }] }
    expect(classifyFingerprint('old', fp)).toEqual({ status: 'previous', at: null, kind: null })
  })

  it('reports "mismatch" for a hash that matches nothing on file', () => {
    expect(classifyFingerprint('never-seen', fingerprints)).toEqual({ status: 'mismatch', at: null, kind: null })
  })

  it('reports "unavailable" when there are no fingerprints to check against', () => {
    expect(classifyFingerprint('anything', null)).toEqual({ status: 'unavailable', at: null, kind: null })
    expect(classifyFingerprint('anything', { docx: null, pdf: null, previous: [] })).toEqual({ status: 'unavailable', at: null, kind: null })
  })

  // ROUND-2 AUDIT: a PDF delivered before PDFs were fingerprinted has no pdf hash.
  it("says 'unavailable' — not 'mismatch' — for a PDF when no PDF fingerprint exists at all", () => {
    const legacy = { docx: 'cur-docx', pdf: null, previous: [] }
    expect(classifyFingerprint('some-pdf', legacy, 'pdf')).toEqual({ status: 'unavailable', at: null, kind: null, scope: 'type' })
    expect(classifyFingerprint('some-docx', legacy, 'docx')).toEqual({ status: 'mismatch', at: null, kind: null })
    expect(classifyFingerprint('some-pdf', legacy)).toEqual({ status: 'mismatch', at: null, kind: null })
  })

  it("still says 'mismatch' for a PDF when a PDF fingerprint (current or superseded) exists", () => {
    expect(classifyFingerprint('x', { docx: 'a', pdf: 'b', previous: [] }, 'pdf').status).toBe('mismatch')
    expect(classifyFingerprint('x', { docx: 'a', pdf: null, previous: [{ kind: 'pdf', hash: 'old', at: null }] }, 'pdf').status).toBe('mismatch')
  })
})

describe('fileKindOf', () => {
  it('prefers the extension, falls back to the MIME type, else null', () => {
    expect(fileKindOf({ name: 'Ada-Resume.PDF', type: '' })).toBe('pdf')
    expect(fileKindOf({ name: 'r.docx', type: '' })).toBe('docx')
    expect(fileKindOf({ name: 'download', type: 'application/pdf' })).toBe('pdf')
    expect(fileKindOf({ name: 'download', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })).toBe('docx')
    expect(fileKindOf({ name: 'notes.txt', type: 'text/plain' })).toBe(null)
    expect(fileKindOf(null)).toBe(null)
  })
})
