import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkUrlIsSafeToFetch } from '../src/lib/ssrfGuard.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = f => fs.readFileSync(path.join(root, f), 'utf8')

describe('ssrfGuard ::/8 (round 7)', () => {
  const blocked = ['http://[::2]/', 'http://[::ffff]/', 'http://[::7f00:1]/', 'http://[::ffff:7f00:1]/', 'http://[::1]/']
  for (const u of blocked) it(`refuses ${u}`, async () => { expect(await checkUrlIsSafeToFetch(u)).not.toBeNull() })
  it('still allows a public IPv4-mapped literal', async () => {
    expect(await checkUrlIsSafeToFetch('http://[::ffff:808:808]/')).toBeNull()
  })
})

describe('resume limiter split (round 7)', () => {
  it('cover letters and structure have their own buckets', () => {
    const routes = read('src/routes/scan.routes.js')
    expect(routes).toMatch(/\/:id\/cover-letter',\s+auth, rl\.coverLetter/)
    expect(routes).toMatch(/\/:id\/structure',\s+rl\.resumeStructure/)
    expect(routes).not.toMatch(/cover-letter[^\n]*rl\.resumeEdit/)
  })
  it('both are exported with distinct prefixes', () => {
    const src = read('src/middleware/rateLimiter.js')
    expect(src).toMatch(/keyPrefix: 'rl:coverletter'/)
    expect(src).toMatch(/keyPrefix: 'rl:resumestructure'/)
    expect(src).toMatch(/resumeEdit, coverLetter, resumeStructure/)
  })
})
