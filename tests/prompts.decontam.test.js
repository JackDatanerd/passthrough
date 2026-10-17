import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
import fs from 'fs'
import path from 'path'
const require = createRequire(import.meta.url)
const { FIXTURES } = require('../evals/checks.cjs')
const { GOLD } = require('../evals/gold.cjs')
const { ENTITIES } = require('../evals/promptEntities.cjs')

// An example the eval also contains measures memory, not skill. The prompts' examples (and the model letters) use made-up
// people and domains; none of them may appear in a fixture or a gold case.
const promptFiles = fs.readdirSync(path.resolve(__dirname, '../src/prompts')).filter(f => f.endsWith('.js'))
const promptText = promptFiles.map(f => fs.readFileSync(path.resolve(__dirname, '../src/prompts', f), 'utf8')).join('\n').toLowerCase()
const fixtureText = [...FIXTURES.map(f => JSON.stringify(f)), ...GOLD.map(g => JSON.stringify(g))].join('\n').toLowerCase()

const grams = (t, n) => { const w = t.replace(/[^\p{L}\p{N}']+/gu, ' ').trim().split(' '); const s = new Set(); for (let i = 0; i + n <= w.length; i++) s.add(w.slice(i, i + n).join(' ')); return s }

describe('prompt examples are kept out of the eval set', () => {
  it('every listed entity really appears in a prompt (the list cannot rot)', () => {
    for (const e of ENTITIES) expect(promptText, e).toContain(e.toLowerCase())
  })
  it('no listed entity appears in any fixture or gold case', () => {
    for (const e of ENTITIES) expect(fixtureText, e).not.toContain(e.toLowerCase())
  })
  it('no five-word phrase is shared between a prompt and the eval set (beyond a short allow-list of generic phrases)', () => {
    const ALLOW = new Set([
      'the posting s own words', 'how many patients or calls', 'what was your job title',
    ])
    const fix = grams(fixtureText, 5)
    const shared = [...grams(promptText, 5)].filter(g => fix.has(g) && !ALLOW.has(g))
    expect(shared.slice(0, 5)).toEqual([])
  })
})
