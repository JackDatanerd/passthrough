#!/usr/bin/env node
// Runs the REAL model over evals/fixtures.cjs and checks the properties the prompts promise. Costs API tokens, so it is a
// manual gate: run it after ANY change under src/prompts/ or to a guard, before bumping a version in
// src/prompts/constants.js (PROMPT_VERSIONS).
//
//   ANTHROPIC_API_KEY=sk-ant-... npm run eval:prompts                      dev set, 5 score runs per fixture
//   npm run eval:prompts -- --set holdout                                  held-out set: only before a version bump, never tune on it
//   npm run eval:prompts -- --set all --judge                              + pairwise judge win-rate (original vs rewrite)
//   npm run eval:prompts -- --gold                                         extraction vs hand-labelled gold (evals/gold.cjs)
//   npm run eval:prompts -- --calibrate                                    judge vs YOUR labels (evals/judge-calibration.json)
//   npm run eval:prompts -- --update-baseline                              write evals/baseline.json from this run
//   npm run eval:prompts -- --dry-run                                      no API key, no cost: a canned fake model exercises the whole harness
//                                                                          (proves the wiring works; says NOTHING about prompt quality)
//   other flags: --only <id>  --runs N  --model <name>  --json <file>
//
// Exit code 1 on any hard failure OR any regression against evals/baseline.json (a fixture that used to pass and now fails,
// a mean AI score down more than 3 points, a judge win-rate down more than 5 points, a first-pass-clean rate down more than
// 10 points). Roughly 15-20 API calls per fixture: --runs 3 and --only are the cheap ways to iterate.

const fs = require('fs')
const path = require('path')
const claude = require('../src/services/claude.service')
const atsService = require('../src/services/ats.service')
const c = require('../src/config/constants')
const { blended } = require('../src/lib/aiScoreSampling')
const { FIXTURES, checkNoClaimedGaps, checkSummary, checkBulletLengths, checkLetterShape, checkScoreSpread, checkFlips, listAgreement,
  checkSpelling, checkLevelPreserved, checkNoExtraBullets, checkSkills, checkHonorific, checkLetterGaps, openingDuplication, goldScore } = require('../evals/checks.cjs')
const { GOLD } = require('../evals/gold.cjs')
const { judgePair, judgeAgreement } = require('../evals/judge.cjs')
const { findRewriteStyleProblems } = require('../src/lib/rewriteStyle')

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d }
const flag = n => process.argv.includes(`--${n}`)
const only = arg('only', null)
const setName = arg('set', 'dev')
const runs = Number(arg('runs', 5))
const BASELINE = path.resolve(__dirname, '../evals/baseline.json')
if (arg('model', null)) process.env.ANTHROPIC_MODEL = arg('model')
const baseEnv = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL }

function resumeToText(r) {
  const L = [r.name, r.email, r.summary || '', 'SKILLS: ' + (r.skills || []).join(', ')]
  for (const e of r.experience || []) L.push(`${e.title}, ${e.company} (${e.dates})`, ...(e.bullets || []).map(b => '- ' + b))
  for (const e of r.education || []) L.push(`${e.degree}, ${e.institution} (${e.dates})`)
  for (const p of r.projects || []) L.push(`${p.name}: ${p.description}`)
  return L.filter(Boolean).join('\n')
}
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)

async function runFixture(f) {
  const fails = [], notes = [], m = {}
  const env = { ...baseEnv, __usage: [] }
  let resume = f.resume
  if (!resume) {                                    // brain dump / scrambled upload: the extraction step is part of what is evaluated
    const s = f.kind === 'scrambled' ? await claude.parseResumeStructure(env, f.raw) : await claude.structureFreeformText(env, f.raw)
    if (!s.success) return { id: f.id, fails: [`structuring failed: ${s.error}`], notes, m }
    resume = s.data
    const dump = JSON.stringify(resume).toLowerCase()
    for (const g of f.gaps || []) if (dump.includes(g.toLowerCase())) fails.push(`extraction invented "${g}"`)
    if (s.unverifiedBullets) notes.push(`${s.unverifiedBullets.length} unverified bullet(s)`)
    if (s.questions && s.questions.length) notes.push(`${s.questions.length} question(s)`)
  }
  const text = resumeToText(resume)

  // ── scorer reliability: the requirement list is re-measured each run (cache cleared) so list drift shows up ──
  const rule = atsService.scoreResume(text, f.jd).score
  const scores = [], blends = [], lists = []
  for (let i = 0; i < runs; i++) {
    claude._clearRequirementsCache()
    const r = await claude.scoreResumeWithAI(env, text, f.jd)
    if (!r.success) { fails.push(`scorer failed: ${r.error}`); break }
    const d = claude.extractJson(r.data)
    scores.push(d.aiScore); blends.push(blended(rule, d.aiScore, c)); lists.push(d.checklist.requirements.map(x => x.requirement))
  }
  fails.push(...checkScoreSpread(scores), ...checkFlips(blends, [c.ATS_PASS_THRESHOLD, c.ATS_BADGE_THRESHOLD]))
  let minAgree = 1
  for (let i = 1; i < lists.length; i++) minAgree = Math.min(minAgree, listAgreement(lists[0], lists[i]))
  if (minAgree < 0.85) fails.push(`requirement lists disagree across runs (agreement ${minAgree.toFixed(2)}, min 0.85)`)
  m.scoreMean = mean(scores); m.listAgreement = lists.length > 1 ? minAgree : null
  notes.push(`ai ${scores.join('/')} blend ${blends.join('/')}`)

  // ── rewrite ──
  env.__usage.length = 0
  const rw = await claude.rewriteResumeContent(env, resume, f.jd, null, resume, { jobTitle: f.jobTitle, seniority: f.seniority })
  m.firstPassClean = env.__usage.filter(u => /rewrite/.test(u.label || '')).length <= 1
  if (!rw.success) fails.push(`rewrite failed: ${rw.error}`)
  else {
    fails.push(...checkNoClaimedGaps(f, rw.data), ...checkSummary(rw.data), ...checkBulletLengths(rw.data),
      ...checkLevelPreserved(resume, rw.data), ...checkNoExtraBullets(resume, rw.data), ...checkSkills(resume, rw.data),
      ...checkSpelling(f, JSON.stringify(rw.data), JSON.stringify(resume)))
    fails.push(...findRewriteStyleProblems(resume, rw.data).map(s => `style: ${s}`))
    m.fabricated = checkNoClaimedGaps(f, rw.data).length
    if (flag('judge')) {
      const verdict = await judgePair(claude, baseEnv, { jd: f.jd, original: resume, rewrite: rw.data })
      m.judge = verdict; notes.push(`judge: ${verdict || 'n/a'}`)
    }
  }

  // ── cover letter, with what a paying user could type and the scorer's genuine gaps ──
  const lt = await claude.generateCoverLetter(env, resume, f.jd, { ...(f.application || {}), jobTitle: f.jobTitle, seniority: f.seniority, knownGaps: f.gaps })
  if (!lt.success) fails.push(`letter failed: ${lt.error}`)
  else {
    fails.push(...checkLetterShape(lt.data, { uk: f.locale === 'UK' }), ...checkHonorific(lt.data, f.application), ...checkLetterGaps(f, lt.data),
      ...checkSpelling(f, lt.data, JSON.stringify(resume)))
    m.letter = lt.data
  }
  return { id: f.id, fails, notes, m }
}

async function runGold() {
  let bad = 0
  console.log(`extraction vs gold (${GOLD.length} cases)\n`)
  for (const g of GOLD) {
    const env = { ...baseEnv }
    const s = g.path === 'freeform' ? await claude.structureFreeformText(env, g.raw) : await claude.parseResumeStructure(env, g.raw)
    const fails = []
    if (!s.success) fails.push(`extraction failed: ${s.error}`)
    else {
      const r = goldScore(g.expected, s.data, g.raw)
      if (g.path === 'structure' && r.f1 < 0.9) fails.push(`F1 ${r.f1.toFixed(2)} (min 0.90); missing: ${r.missing.join(', ') || '-'}; extra: ${r.extra.join(', ') || '-'}`)
      if (r.hallucinated.length) fails.push(`hallucinated: ${r.hallucinated.join(', ')}`)
      if (g.path === 'structure' && r.verbatimRate < 0.98) fails.push(`only ${(r.verbatimRate * 100).toFixed(0)}% of bullets are verbatim`)
      const dump = JSON.stringify(s.data).toLowerCase()
      for (const x of g.forbid || []) if (dump.includes(x.toLowerCase())) fails.push(`output contains "${x}"`)
      console.log(`${fails.length ? 'FAIL' : 'ok  '}  ${g.id.padEnd(34)} F1 ${r.f1.toFixed(2)}  verbatim ${(r.verbatimRate * 100).toFixed(0)}%`)
    }
    if (fails.length) { bad++; if (!s.success) console.log(`FAIL  ${g.id}`); for (const m of fails) console.log(`        - ${m}`) }
  }
  console.log(`\n${GOLD.length - bad}/${GOLD.length} gold cases passed`)
  return bad
}

async function runCalibrate() {
  const cal = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../evals/judge-calibration.json'), 'utf8'))
  const rows = []
  for (const p of cal.pairs || []) rows.push({ human: p.human, verdict: await judgePair(claude, baseEnv, p) })
  const a = judgeAgreement(rows)
  console.log(`judge agrees with your labels on ${a === null ? 'n/a' : (a * 100).toFixed(0) + '%'} of ${rows.length} pairs`)
  if (rows.length < 20) console.log('WARNING: fewer than 20 labelled pairs - judge win-rates are UNCALIBRATED. See evals/judge-calibration.json.')
  return a !== null && a >= 0.8 && rows.length >= 20 ? 0 : 1
}

function compareBaseline(results, agg) {
  if (!fs.existsSync(BASELINE)) { console.log('\nno evals/baseline.json yet - run with --update-baseline once this run looks right'); return [] }
  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
  const reg = []
  for (const r of results) {
    const b = base.fixtures && base.fixtures[r.id]
    if (!b) continue
    if (b.pass && r.fails.length) reg.push(`${r.id}: passed in the baseline, fails now`)
    if (b.scoreMean != null && r.m.scoreMean != null && b.scoreMean - r.m.scoreMean > 3) reg.push(`${r.id}: mean AI score ${b.scoreMean.toFixed(1)} -> ${r.m.scoreMean.toFixed(1)}`)
  }
  const ba = base.aggregate || {}
  if (ba.judgeWinRate != null && agg.judgeWinRate != null && ba.judgeWinRate - agg.judgeWinRate > 0.05) reg.push(`judge win-rate ${(ba.judgeWinRate * 100).toFixed(0)}% -> ${(agg.judgeWinRate * 100).toFixed(0)}%`)
  if (ba.firstPassCleanRate != null && ba.firstPassCleanRate - agg.firstPassCleanRate > 0.1) reg.push(`first-pass-clean rate ${(ba.firstPassCleanRate * 100).toFixed(0)}% -> ${(agg.firstPassCleanRate * 100).toFixed(0)}%`)
  return reg
}


// ── --dry-run: a canned fake model, so the harness itself can be tested offline (tests/prompts.runner.test.js) ──────────
function installDryRunFetch() {
  const between = (t, tag) => { const m = String(t).match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`)); return m ? m[1] : '' }
  const body = text => ({ ok: true, status: 200, headers: new Map(), text: async () => '', json: async () => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } }) })
  const filler = 'I keep every report traceable to its source and agree what each figure means with the people who read it, so that decisions rest on numbers everyone trusts. '
  globalThis.fetch = async (url, init) => {
    const b = JSON.parse(init.body), sys = String(b.system || ''), user = String(b.messages[0].content)
    if (/You read ONE job posting/.test(sys)) {
      const words = [...new Set((between(user, 'job_description').match(/[A-Za-z][A-Za-z+#.]{3,}/g) || []))].slice(0, 5)
      return body(JSON.stringify({ requirements: words.map((w, i) => ({ requirement: w, priority: i < 2 ? 'must' : 'nice', cue: i < 2 ? `${w} required` : '', years: null })) }))
    }
    if (/ATS screening analyst/.test(sys)) {
      const list = JSON.parse(between(user, 'requirements') || '[]')
      return body(JSON.stringify({ results: list.map(r => ({ id: r.id, status: 'missing', evidence: '' })), seniority: 'match', title: 'partial' }))
    }
    if (/executive resume writer/.test(sys)) {
      const resume = JSON.parse(between(user, 'resume_data'))
      if (resume.summary) resume.summary = 'Reliable analyst who keeps every report traceable to its source and agrees what each figure means with its readers before anything ships to the business, so that decisions rest on numbers everyone trusts.'
      return body(JSON.stringify({ resume, provenance: [], skillRenames: [], quantificationOpportunities: [] }))
    }
    if (/You write the cover letter/.test(sys)) {
      const name = (JSON.parse(between(user, 'resume_data') || '{}').name) || 'Candidate'
      return body(`Dear Hiring Manager,\n\n${filler.repeat(8)}\n\nSincerely,\n${name}`)
    }
    if (/hiring manager screening resumes/.test(sys)) return body(JSON.stringify({ winner: 'B', reason: 'dry run' }))
    // extraction: echo the first line as the name and nothing else
    const raw = between(user, 'resume') || between(user, 'background') || user
    return body(JSON.stringify({ name: 'Alex Morgan', email: null, experience: [], education: [], skills: [], warnings: [], questions: [], sourceSpans: [] }))
  }
}

;(async () => {
  if (flag('dry-run')) { baseEnv.ANTHROPIC_API_KEY = 'dry-run'; installDryRunFetch() }
  if (!baseEnv.ANTHROPIC_API_KEY) { console.error('Set ANTHROPIC_API_KEY to run the prompt eval.'); process.exit(2) }
  if (flag('gold')) process.exit((await runGold()) ? 1 : 0)
  if (flag('calibrate')) process.exit(await runCalibrate())
  const list = FIXTURES.filter(f => (!only || f.id === only) && (setName === 'all' || f.set === setName))
  console.log(`prompt versions ${claude.PROMPT_VERSION} / ${claude.LETTER_PROMPT_VERSION}, model ${process.env.ANTHROPIC_MODEL || '(default)'}, set ${setName}: ${list.length} fixtures, ${runs} score runs each\n`)
  const results = []
  for (const f of list) {
    let res
    try { res = await runFixture(f) } catch (e) { res = { id: f.id, fails: [`threw: ${e.message}`], notes: [], m: {} } }
    results.push(res)
    console.log(`${res.fails.length ? 'FAIL' : 'ok  '}  ${res.id.padEnd(28)} ${res.notes.join('  ')}`)
    for (const m of res.fails) console.log(`        - ${m}`)
  }
  const done = results.filter(r => r.m && Object.keys(r.m).length)
  const verdicts = done.map(r => r.m.judge).filter(Boolean)
  const wins = verdicts.filter(v => v === 'rewrite').length, ties = verdicts.filter(v => v === 'tie').length
  const agg = {
    fixtures: results.length, failed: results.filter(r => r.fails.length).length,
    fabricated: done.reduce((n, r) => n + (r.m.fabricated || 0), 0),
    firstPassCleanRate: done.filter(r => r.m.firstPassClean !== undefined).length ? done.filter(r => r.m.firstPassClean).length / done.filter(r => r.m.firstPassClean !== undefined).length : 1,
    judgeWinRate: verdicts.length ? (wins + ties / 2) / verdicts.length : null,
    openingDuplication: openingDuplication(done.map(r => r.m.letter).filter(Boolean)),
    meanListAgreement: mean(done.map(r => r.m.listAgreement).filter(x => x != null)),
  }
  console.log(`\n${results.length - agg.failed}/${results.length} fixtures passed`)
  console.log(`fabricated gaps: ${agg.fabricated} (must be 0)   first-pass-clean rewrites: ${(agg.firstPassCleanRate * 100).toFixed(0)}% (target 90%+)`)
  console.log(`letter opening duplication: ${(agg.openingDuplication * 100).toFixed(0)}% (target 20% or less)   requirement-list agreement: ${agg.meanListAgreement == null ? 'n/a' : agg.meanListAgreement.toFixed(2)} (target 0.85+)`)
  if (agg.judgeWinRate != null) console.log(`judge win-rate, rewrite vs original: ${(agg.judgeWinRate * 100).toFixed(0)}% over ${verdicts.length} (UNCALIBRATED until --calibrate passes)`)
  let bad = agg.failed + (agg.fabricated ? 1 : 0) + (agg.openingDuplication > 0.2 ? 1 : 0)
  const reg = compareBaseline(results, agg)
  if (reg.length) { console.log('\nREGRESSIONS vs evals/baseline.json:'); reg.forEach(r => console.log('  - ' + r)); bad += reg.length }
  if (arg('json', null)) fs.writeFileSync(arg('json'), JSON.stringify({ agg, results: results.map(({ m, ...r }) => ({ ...r, m: { ...m, letter: undefined } })) }, null, 2))
  if (flag('update-baseline')) {
    const fx = {}; for (const r of results) fx[r.id] = { pass: !r.fails.length, scoreMean: r.m.scoreMean ?? null }
    fs.writeFileSync(BASELINE, JSON.stringify({ meta: { date: new Date().toISOString().slice(0, 10), promptVersion: claude.PROMPT_VERSION, letterVersion: claude.LETTER_PROMPT_VERSION, model: process.env.ANTHROPIC_MODEL || 'default', set: setName, runs }, fixtures: fx, aggregate: agg }, null, 2) + '\n')
    console.log('\nwrote evals/baseline.json')
  }
  process.exit(bad ? 1 : 0)
})()
