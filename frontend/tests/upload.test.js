import { describe, it, expect } from 'vitest'
import { validateUpload, normalizeUpload, extensionOf, ALLOWED_UPLOADS } from '../src/lib/upload.js'

const file = (name, size = 1000, type = '') => {
  const f = new File(['x'.repeat(Math.min(size, 10))], name, { type })
  Object.defineProperty(f, 'size', { value: size })
  return f
}

describe('extensionOf', () => {
  it('lowercases and handles edge cases', () => {
    expect(extensionOf('CV.PDF')).toBe('pdf')
    expect(extensionOf('my.resume.final.docx')).toBe('docx')
    expect(extensionOf('noextension')).toBe('')
    expect(extensionOf('')).toBe('')
    expect(extensionOf(undefined)).toBe('')
  })
})

describe('validateUpload', () => {
  it('accepts pdf and docx within the size limit', () => {
    expect(validateUpload(file('cv.pdf'))).toBeNull()
    expect(validateUpload(file('CV.DOCX'))).toBeNull()
  })
  it('rejects other types (including the classic .doc and disguised names)', () => {
    for (const n of ['cv.doc', 'cv.txt', 'cv.pdf.exe', 'cv', 'cv.png'])
      expect(validateUpload(file(n))).toMatch(/only pdf and docx/i)
  })
  it('rejects an empty file (a 0-byte upload used to pass validation)', () => {
    expect(validateUpload(file('cv.pdf', 0))).toMatch(/empty/i)
  })
  it('enforces the size limit exactly at the boundary', () => {
    expect(validateUpload(file('cv.pdf', 5 * 1024 * 1024))).toBeNull()
    expect(validateUpload(file('cv.pdf', 5 * 1024 * 1024 + 1))).toMatch(/too large/i)
    expect(validateUpload(file('cv.pdf', 2 * 1024 * 1024 + 1), 2)).toMatch(/max 2mb/i)
  })
  it('reports no file', () => {
    expect(validateUpload(undefined)).toMatch(/no file/i)
  })
})

// The API validates file.type; some Windows/Android pickers report '' or octet-stream for a good .docx.
describe('normalizeUpload', () => {
  it('re-wraps a file with a missing/generic type using the type that matches its extension', () => {
    for (const t of ['', 'application/octet-stream']) {
      const out = normalizeUpload(file('cv.docx', 100, t))
      expect(out.type).toBe(ALLOWED_UPLOADS.docx)
      expect(out.name).toBe('cv.docx')
    }
    expect(normalizeUpload(file('cv.pdf', 100, '')).type).toBe('application/pdf')
  })
  it('returns the original file untouched when the type already matches', () => {
    const f = file('cv.pdf', 100, 'application/pdf')
    expect(normalizeUpload(f)).toBe(f)
  })
})
