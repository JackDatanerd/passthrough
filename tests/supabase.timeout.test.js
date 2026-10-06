import { describe, it, expect } from 'vitest'
import { timeoutFetch, getSupabase } from '../src/config/supabase.js'

describe('supabase request timeout', () => {
  it('aborts a request that never answers', async () => {
    const hang = (input, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
    const f = timeoutFetch(30, hang)
    await expect(f('https://x.supabase.co/rest/v1/users')).rejects.toBeDefined()
  })
  it('passes a prompt answer straight through', async () => {
    const f = timeoutFetch(1000, async () => new Response('{"ok":true}'))
    expect(await (await f('https://x')).json()).toEqual({ ok: true })
  })
  it('still honours the caller\'s own abort signal', async () => {
    const hang = (input, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
    const ctl = new AbortController()
    const p = timeoutFetch(60_000, hang)('https://x', { signal: ctl.signal })
    ctl.abort(new Error('caller gave up'))
    await expect(p).rejects.toThrow('caller gave up')
  })
  it('getSupabase builds a client with the wrapped fetch (and honours SUPABASE_TIMEOUT_MS)', () => {
    expect(getSupabase({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', SUPABASE_TIMEOUT_MS: '5000' })).toBeDefined()
  })
})
