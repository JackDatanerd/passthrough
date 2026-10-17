#!/usr/bin/env node
// Runs the REAL model over evals/fixtures.cjs and checks the properties the prompts promise. Costs API tokens, so it is
// a manual gate: run it after ANY change under src/prompts/ or to a guard, before bumping PROMPT_VERSION.
//
//   ANTHROPIC_API_KEY=sk-ant-... npm run eval:prompts            (all fixtures, 3 score runs each)
//   ANTHROPIC_API_KEY=... npm run eval:prompts -- --only injection-jd --runs 5
//
// Exit code 1 if any fixture fails a hard check. Scores are printed so a prompt change can be compared with the last run.

const claude = require('../src/services/claude.service')
const { FIXTURES, checkNoClaimedGaps, checkSummary, checkBulletLengths, checkLetterShape, checkScoreSpread } = require('../evals/checks.cjs')
const { findRewriteStyleProblems } = require('../src/lib/rewriteStyle')

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d }
const only = arg('only', null)
const runs = Number(arg('runs', 3))
const env = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL }

function resumeToText(r) {
  const L = [r.name, r.email, r.summary || '', 'SKILLS: ' + (r.skills || []).join(', ')]
  for (const e of r.experience || []) L.push(`${e.title}, ${e.company} (${e.dates})`, ...(e.bullets || []).map(b => '- ' + b))
  for (const e of r.education || []) L.push(`${e.degree}, ${e.institution} (${e.dates})`)
  for (const p of r.projects || []) L.push(`${p.name}: ${p.description}`)
  return L.filter(Boolean).join('\n')
}

async function runFixture(f) {
  const fails = [], notes = []
  let resume = f.resume
  if (!resume) {                                    // brain-dump: the extraction step is part of what is evaluated
    const s = await claude.structureFreeformText(env, f.raw)
    if (!s.success) return { id: f.id, fails: [`structuring failed: ${s.error}`], notes }
    resume = s.data
    for (const g of f.gaps || []) if (JSON.stringify(resume).toLowerCase().includes(g.toLowerCase())) fails.push(`extraction invented "${g}"`)
  }
  const text = resumeToText(resume)
  const scores = []
  for (let i = 0; i < runs; i++) {
    const r = await claude.scoreResumeWithAI(env, text, f.jd)
    if (!r.success) { fails.push(`scorer failed: ${r.error}`); break }
    scores.push(claude.extractJson(r.data).aiScore)
  }
  fails.push(...checkScoreSpread(scores))
  notes.push(`score ${scores.join('/')}`)

  const rw = await claude.rewriteResumeContent(env, resume, f.jd, null, resume, { jobTitle: '', seniority: null })
  if (!rw.success) fails.push(`rewrite failed: ${rw.error}`)
  else {
    fails.push(...checkNoClaimedGaps(f, rw.data), ...checkSummary(rw.data), ...checkBulletLengths(rw.data))
    const style = findRewriteStyleProblems(resume, rw.data)
    if (style.length) fails.push(...style.map(s => `style: ${s}`))
  }
  const lt = await claude.generateCoverLetter(env, resume, f.jd, {})
  if (!lt.success) fails.push(`letter failed: ${lt.error}`)
  else {
    fails.push(...checkLetterShape(lt.data))
    fails.push(...checkNoClaimedGaps(f, { letter: lt.data }))
  }
  return { id: f.id, fails, notes }
}

;(async () => {
  if (!env.ANTHROPIC_API_KEY) { console.error('Set ANTHROPIC_API_KEY to run the prompt eval.'); process.exit(2) }
  const list = FIXTURES.filter(f => !only || f.id === only)
  let bad = 0
  console.log(`prompt version ${claude.PROMPT_VERSION}, ${list.length} fixtures, ${runs} score runs each\n`)
  for (const f of list) {
    let res
    try { res = await runFixture(f) } catch (e) { res = { id: f.id, fails: [`threw: ${e.message}`], notes: [] } }
    if (res.fails.length) bad++
    console.log(`${res.fails.length ? 'FAIL' : 'ok  '}  ${res.id.padEnd(18)} ${res.notes.join('  ')}`)
    for (const m of res.fails) console.log(`        - ${m}`)
  }
  console.log(`\n${list.length - bad}/${list.length} fixtures passed`)
  process.exit(bad ? 1 : 0)
})()
