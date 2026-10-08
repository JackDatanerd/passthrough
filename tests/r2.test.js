import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { deleteObjects, R2_BATCH } from '../src/lib/r2.js'

// lib/r2.js — shared bulk R2 deletion (Auth round 4, B1).
let realErr
beforeEach(() => { realErr = console.error; console.error = () => {} })
afterEach(() => { console.error = realErr })

const bucket = (impl) => { const calls = []; return { calls, RESUMES_BUCKET: { delete: async k => { calls.push(k); if (impl) await impl(k) } } } }

describe('deleteObjects', () => {
  it('sends one list per call, de-duplicated and without empty keys', async () => {
    const env = bucket()
    const r = await deleteObjects(env, ['a', 'b', 'a', null, '', undefined, 'c'])
    expect(env.calls).toEqual([['a', 'b', 'c']])
    expect(r).toEqual({ deleted: 3, failed: [] })
  })
  it('splits a large list into batches of at most R2_BATCH', async () => {
    const env = bucket()
    await deleteObjects(env, Array.from({ length: R2_BATCH * 2 + 5 }, (_, i) => `k${i}`))
    expect(env.calls.map(c => c.length)).toEqual([R2_BATCH, R2_BATCH, 5])
  })
  it('does nothing (and never touches the bucket) for no keys or no bucket', async () => {
    const env = bucket()
    expect(await deleteObjects(env, [])).toEqual({ deleted: 0, failed: [] })
    expect(await deleteObjects(env, null)).toEqual({ deleted: 0, failed: [] })
    expect(await deleteObjects({}, ['a'])).toEqual({ deleted: 0, failed: [] })
    expect(env.calls).toHaveLength(0)
  })
  it('falls back to key-by-key when a bulk call throws, and reports only the keys that still fail', async () => {
    const env = bucket(k => { if (Array.isArray(k) || k === 'bad') throw new Error('nope') })
    const r = await deleteObjects(env, ['a', 'bad', 'c'])
    expect(r).toEqual({ deleted: 2, failed: ['bad'] })
    expect(env.calls.slice(1)).toEqual(['a', 'bad', 'c'])
  })
  it('never throws', async () => {
    const env = bucket(() => { throw new Error('down') })
    await expect(deleteObjects(env, ['a', 'b'])).resolves.toEqual({ deleted: 0, failed: ['a', 'b'] })
  })
})
