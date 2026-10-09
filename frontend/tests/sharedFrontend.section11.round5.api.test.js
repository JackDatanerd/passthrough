// @vitest-environment jsdom
// Section 11, round 5 — client timeouts (real axios instance, capturing adapter).
import { describe, it, expect } from 'vitest'
import api, { LONG_REQUEST_TIMEOUT_MS } from '../src/lib/api'
import { humanizeField, getErrorMessage } from '../src/lib/errors'

function capture() {
  const seen = []
  const adapter = cfg => { seen.push({ url: cfg.url, method: cfg.method, timeout: cfg.timeout }); return Promise.resolve({ data: {}, status: 200, statusText: 'OK', headers: {}, config: cfg }) }
  return { seen, adapter }
}

describe('request timeouts (BUG: server runs Claude / PDF work inline for up to 90s, client gave up at 30s)', () => {
  it('POST /structure, /cover-letter and /regenerate-pdf get the long timeout, query string included', async () => {
    const { seen, adapter } = capture()
    await api.post('/scan/abc/structure', undefined, { adapter })
    await api.post('/scan/abc/structure?token=t%201', undefined, { adapter })
    await api.post('/scan/abc/cover-letter', undefined, { adapter })
    await api.post('/scan/abc/regenerate-pdf', undefined, { adapter })
    expect(seen.map(s => s.timeout)).toEqual([LONG_REQUEST_TIMEOUT_MS, LONG_REQUEST_TIMEOUT_MS, LONG_REQUEST_TIMEOUT_MS, LONG_REQUEST_TIMEOUT_MS])
    expect(LONG_REQUEST_TIMEOUT_MS).toBeGreaterThan(90_000 * 1.5)   // two sequential Claude calls fit
  })
  it('everything else keeps 30s; multipart uploads keep 180s; the cover-letter DOWNLOAD (GET) stays quick', async () => {
    const { seen, adapter } = capture()
    await api.get('/scan/abc/cover-letter', { adapter })
    await api.post('/scan/abc/retry-scan', undefined, { adapter })
    await api.post('/scan/abc/structure-other', undefined, { adapter })
    await api.post('/scan', new FormData(), { adapter })
    expect(seen.map(s => s.timeout)).toEqual([30_000, 30_000, 30_000, 180_000])
  })
  it('an explicit caller timeout always wins', async () => {
    const { seen, adapter } = capture()
    await api.post('/scan/abc/structure', undefined, { adapter, timeout: 5_000 })
    await api.post('/scan/abc/structure', undefined, { adapter, timeout: 30_000, __customTimeout: true })
    expect(seen.map(s => s.timeout)).toEqual([5_000, 30_000])
  })
})

describe('humanizeField (BUG: array-item paths were labelled by the index alone)', () => {
  it('names the list and the item instead of "3:" / "0:"', () => {
    expect(humanizeField('extraRoleCategories.1')).toBe('Extra role categories (item 2)')
    expect(humanizeField('ids.0')).toBe('Ids (item 1)')
    expect(humanizeField('experience.1.title')).toBe('Title')
    expect(humanizeField('newPassword')).toBe('New password')
    expect(humanizeField('0')).toBe('')
    expect(humanizeField('')).toBe('')
  })
  it('a validation message is never prefixed with a bare number', () => {
    const err = { isAxiosError: true, response: { status: 400, data: { message: 'Validation failed', errors: [{ field: 'ids.0', message: 'Invalid lead id.' }, { field: '0', message: 'Required' }] } } }
    const msg = getErrorMessage(err)
    expect(msg).toBe('Ids (item 1): Invalid lead id. · Required')
    expect(msg).not.toMatch(/(^|· )\d+:/)
  })
})
