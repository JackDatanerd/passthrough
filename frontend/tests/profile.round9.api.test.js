// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import api, { LONG_REQUEST_TIMEOUT_MS } from '../src/lib/api'

// Profile & Dashboard round 9: the saved-profile PDF renders in a browser inside the request, exactly like
// the draft PDF — long timeout, never auto-retried (a retry started a second render).
const ok = cfg => Promise.resolve({ data: {}, status: 200, statusText: 'OK', headers: {}, config: cfg })

describe('saved-profile PDF download', () => {
  it('gets the long timeout; the .docx and other profile reads keep 30s', async () => {
    const seen = []
    const adapter = cfg => { seen.push(cfg.timeout); return ok(cfg) }
    await api.get('/profile/download-pdf', { adapter, params: { profileId: 'p1' } })
    await api.get('/profile/download-docx', { adapter })
    await api.get('/profile', { adapter })
    expect(seen).toEqual([LONG_REQUEST_TIMEOUT_MS, 30_000, 30_000])
  })
  it('a timeout on it is not retried', async () => {
    let calls = 0
    const adapter = cfg => { calls++; return Promise.reject(Object.assign(new Error('timeout'), { isAxiosError: true, code: 'ECONNABORTED', config: cfg })) }
    await expect(api.get('/profile/download-pdf', { adapter })).rejects.toBeTruthy()
    expect(calls).toBe(1)
  })
})
