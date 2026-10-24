import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const ats = require('../src/services/ats.service.js')

// Round 21 (B1): the bare "node" unigram was dropped whenever a "node js" bigram existed in the pool, even when that
// bigram ranked below the TOP_BIGRAMS cut and was never scored - the framework then sat in neither list.
describe('js framework keywords are never dropped from both lists', () => {
  const jd = `Senior Backend Engineer
What you'll do
Build cloud infrastructure. Maintain cloud infrastructure. Design distributed systems. Operate distributed systems.
Improve system reliability. Improve system reliability. Own incident response. Own incident response.
Lead code reviews. Lead code reviews. Drive technical strategy. Drive technical strategy.
Write technical documentation. Write technical documentation. Partner with product teams. Partner with product teams.
Requirements
Experience with Node.js and PostgreSQL.`
  const resume = 'Jane Doe\njane@x.com\nExperience\nBackend Engineer, Acme\n- Built Node.js services on PostgreSQL handling 2M requests\nSkills\nNode.js, PostgreSQL\n'
  it('credits a candidate who has Node.js even when its bigram misses the cut', () => {
    const k = ats.scoreResume(resume, jd).detail.keywords
    const all = [...k.matched, ...k.missing].map(x => x.toLowerCase())
    expect(all.some(x => x === 'node' || x === 'node js' || x === 'node.js')).toBe(true)
    expect(k.matched.map(x => x.toLowerCase())).toEqual(expect.arrayContaining(['node']))
  })
  it('tells a candidate without it that it is missing', () => {
    const k = ats.scoreResume('Jane Doe\njane@x.com\nExperience\nEngineer, Acme\n- Built services on PostgreSQL\nSkills\nPostgreSQL\n', jd).detail.keywords
    expect([...k.matched, ...k.missing].map(x => x.toLowerCase()).some(x => x === 'node' || x === 'node js')).toBe(true)
    expect(k.missing.map(x => x.toLowerCase()).some(x => x === 'node' || x === 'node js')).toBe(true)
  })
})

// Round 21 (B2): generateFix treated a score with no AI half (capped under the credential line) as a real score.
describe('generateFix honours an AI-scoring outage', () => {
  const src = fs.readFileSync(new URL('../src/controllers/scan.controller.js', import.meta.url), 'utf8')
  const fix = src.slice(src.indexOf('async function generateFixRun'))
  it('scores baseline and candidates with a second try', () => {
    expect(src).toMatch(/async function scoreLikeScanWithRetry/)
    expect(fix).toMatch(/scoreLikeScanWithRetry\(env, candidateText, jdText, 'generateFix'\)/)
    expect(fix).toMatch(/scoreLikeScanWithRetry\(env, await resumeParser\.extractText\(baseBytes[^)]*\), jdText, 'generateFix \(baseline\)'\)/)
  })
  it('never lets a capped candidate replace a real score', () => {
    expect(fix).toMatch(/\(candidateScore\.aiBlended \|\| !bestAiBlended\) && pickWinner\(/)
    expect(fix).toMatch(/bestAiBlended = candidateScore\.aiBlended/)
  })
})
