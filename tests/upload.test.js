import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import uploadResume, { detectType } from '../src/middleware/upload.js'

// Real Request/FormData/File objects — the same primitives Workers give the middleware.

const PDF_BYTES = () => new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF')
async function docxBytes(entries = { 'word/document.xml': '<w:document/>', '[Content_Types].xml': '<Types/>' }) {
  const z = new JSZip(); for (const [k, v] of Object.entries(entries)) z.file(k, v)
  return z.generateAsync({ type: 'uint8array' })
}
function formReq(build, { chunked = false, headers = {} } = {}) {
  const fd = new FormData(); build(fd)
  const req = new Request('https://api.test/api/scan', { method: 'POST', body: fd, headers })
  if (!chunked) return req
  // Re-send the same multipart bytes as a stream with NO content-length (what a chunked upload looks like).
  const ct = req.headers.get('content-type')
  return { rebuild: async () => {
    const bytes = new Uint8Array(await req.arrayBuffer())
    const CH = 64 * 1024; let off = 0; const pulled = { n: 0 }
    const stream = new ReadableStream({ pull(c) { if (off >= bytes.length) return c.close(); const part = bytes.slice(off, off + CH); off += part.length; pulled.n += part.length; c.enqueue(part) } })
    return { request: new Request('https://api.test/api/scan', { method: 'POST', headers: { 'content-type': ct }, body: stream, duplex: 'half' }), pulled, total: bytes.length }
  } }
}
function ctxFor(request) {
  const store = {}
  return { store, req: { header: n => request.headers.get(n), raw: request }, set: (k, v) => { store[k] = v }, json: (body, status) => ({ body, status }) }
}
async function run(request) {
  const c = ctxFor(request); let passed = false
  const res = await uploadResume(c, async () => { passed = true })
  return { res, passed, store: c.store }
}
const file = (bytes, name, type) => new File([bytes], name, { type })
const docxP = docxBytes()

describe('upload.js — content sniffing', () => {
  it('accepts a real PDF and reports the type detected from its bytes', async () => {
    const { passed, store } = await run(formReq(fd => { fd.set('resume', file(PDF_BYTES(), 'cv.pdf', 'application/pdf')); fd.set('jobDescriptionText', 'x'.repeat(60)) }))
    expect(passed).toBe(true)
    expect(store.uploadedFile.mimetype).toBe('application/pdf')
    expect(store.uploadedFile.originalname).toBe('cv.pdf')
  })
  it('accepts a real DOCX', async () => {
    const docx = await docxP
    const { passed, store } = await run(formReq(fd => fd.set('resume', file(docx, 'cv.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'))))
    expect(passed).toBe(true)
    expect(store.uploadedFile.mimetype).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  })
  it('accepts a valid DOCX/PDF whose browser label is empty or octet-stream (Windows without Office)', async () => {
    const docx = await docxP
    for (const [bytes, type, expected] of [[docx, '', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
                                            [PDF_BYTES(), 'application/octet-stream', 'application/pdf']]) {
      const { passed, store } = await run(formReq(fd => fd.set('resume', file(bytes, 'cv', type))))
      expect(passed).toBe(true)
      expect(store.uploadedFile.mimetype).toBe(expected)
    }
  })
  it('the bytes win over a lying label: PDF bytes labelled docx are stored as a PDF', async () => {
    const { store } = await run(formReq(fd => fd.set('resume', file(PDF_BYTES(), 'x.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'))))
    expect(store.uploadedFile.mimetype).toBe('application/pdf')
  })
  it('rejects a label that is neither allowed nor generic (415)', async () => {
    const { res, passed } = await run(formReq(fd => fd.set('resume', file(PDF_BYTES(), 'x.png', 'image/png'))))
    expect(passed).toBe(false); expect(res.status).toBe(415)
  })
  it('rejects garbage with a PDF label (415)', async () => {
    const { res, passed } = await run(formReq(fd => fd.set('resume', file(new TextEncoder().encode('MZ\x90 not a pdf'), 'x.pdf', 'application/pdf'))))
    expect(passed).toBe(false); expect(res.status).toBe(415)
  })
  it('rejects a ZIP that is not a Word document (an .xlsx renamed .docx)', async () => {
    const xlsx = await docxBytes({ 'xl/workbook.xml': '<workbook/>', '[Content_Types].xml': '<Types/>' })
    const { res, passed } = await run(formReq(fd => fd.set('resume', file(xlsx, 'x.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'))))
    expect(passed).toBe(false); expect(res.status).toBe(415)
  })
  it('accepts a PDF whose header is not at byte 0 (allowed by the spec, within 1024 bytes)', async () => {
    const lead = new Uint8Array(200).fill(0x0a)
    const bytes = new Uint8Array([...lead, ...PDF_BYTES()])
    expect(detectType(bytes)).toBe('application/pdf')
  })
  it('an empty file is rejected, not crashed on', async () => {
    const { res } = await run(formReq(fd => fd.set('resume', file(new Uint8Array(0), 'e.pdf', 'application/pdf'))))
    expect(res.status).toBe(415)
  })
})
describe('upload.js — size limits (the cap must not depend on a Content-Length header)', () => {
  it('rejects an oversized upload that DECLARES its size (413, body never read)', async () => {
    const c = ctxFor(new Request('https://x', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=b', 'content-length': String(500 * 1024 * 1024) }, body: 'x' }))
    let passed = false
    const res = await uploadResume(c, async () => { passed = true })
    expect(res.status).toBe(413); expect(passed).toBe(false)
  })
  it('rejects a CHUNKED oversized upload (no Content-Length) and stops reading early', async () => {
    const big = new Uint8Array(20 * 1024 * 1024); big.set(PDF_BYTES())
    const built = await formReq(fd => fd.set('resume', file(big, 'big.pdf', 'application/pdf')), { chunked: true }).rebuild()
    expect(built.request.headers.get('content-length')).toBeNull()
    const c = ctxFor(built.request); let passed = false
    const res = await uploadResume(c, async () => { passed = true })
    expect(res.status).toBe(413); expect(passed).toBe(false)
    // it aborted: nowhere near the whole 20MB was pulled into memory
    expect(built.pulled.n).toBeLessThan(built.total / 2)
  })
  it('a file at the limit is fine; one over it is refused', async () => {
    const ok = new Uint8Array(5 * 1024 * 1024); ok.set(PDF_BYTES())
    expect((await run(formReq(fd => fd.set('resume', file(ok, 'ok.pdf', 'application/pdf'))))).passed).toBe(true)
    const over = new Uint8Array(5 * 1024 * 1024 + 10); over.set(PDF_BYTES())
    expect((await run(formReq(fd => fd.set('resume', file(over, 'over.pdf', 'application/pdf'))))).res.status).toBe(413)
  })
})

describe('upload.js — form fields', () => {
  it('passes brain-dump submissions (no file) through', async () => {
    const { passed, store } = await run(formReq(fd => { fd.set('brainDumpText', 'I built things. '.repeat(20)); fd.set('jobDescriptionText', 'y'.repeat(60)) }))
    expect(passed).toBe(true)
    expect(store.uploadedFile).toBeNull()
    expect(store.formFields.brainDumpText.length).toBeGreaterThan(100)
  })
  it('a text field sent as a FILE is a 400, not a TypeError 500 downstream', async () => {
    const { res, passed } = await run(formReq(fd => fd.set('jobDescriptionText', file(new Uint8Array([1, 2, 3]), 'jd.txt', 'text/plain'))))
    expect(passed).toBe(false); expect(res.status).toBe(400)
  })
  it('a wildly long job link is rejected; contact name is clamped; an over-long email is rejected', async () => {
    expect((await run(formReq(fd => fd.set('jobDescriptionUrl', 'https://x.com/' + 'a'.repeat(3000))))).res.status).toBe(400)
    expect((await run(formReq(fd => fd.set('contactEmail', 'a'.repeat(300) + '@x.com')))).res.status).toBe(400)
    const { store } = await run(formReq(fd => fd.set('contactName', 'N'.repeat(5000))))
    expect(store.formFields.contactName).toHaveLength(100)
  })
  it('huge free-text is truncated, not stored whole', async () => {
    const { store } = await run(formReq(fd => fd.set('brainDumpText', 'z'.repeat(400_000))))
    expect(store.formFields.brainDumpText).toHaveLength(100_000)
  })
  it('a client-supplied filename is clamped to 255 chars', async () => {
    const { store } = await run(formReq(fd => fd.set('resume', file(PDF_BYTES(), 'n'.repeat(900) + '.pdf', 'application/pdf'))))
    expect(store.uploadedFile.originalname).toHaveLength(255)
  })
  it('a non-multipart body is a clean 400', async () => {
    const { res } = await run(new Request('https://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))
    expect(res.status).toBe(400)
  })
})
