'use strict'
// THROWAWAY. Experts Phase 1 realm and token coexistence spike (product spec 22.4 / engineering spec 21).
// Question: how do realm tokens, sessions and the existing admin checks coexist?
// Pass criteria: (1) cross-realm tokens are rejected, both ways; (2) NO change to the existing admin tests, and the pilot adds no failure to them.
//
// Run:  node docs/experts/spikes/realm-spike.cjs      (from the repo root, with the work applied on top of the base commit)
const fs = require('fs'), path = require('path'), { execFileSync, spawnSync } = require('child_process')
const root = path.join(__dirname, '..', '..', '..')
const run = (cmd, args) => spawnSync(cmd, args, { cwd: root, encoding: 'utf8', timeout: 280000 })
const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '')

// 1. which existing admin / auth / session test files are there, and has the pilot changed ANY of them?
const existing = fs.readdirSync(path.join(root, 'tests')).filter(f => /admin|auth|session|stepup|step-up/i.test(f) && !/human|expert/i.test(f))
const changed = execFileSync('git', ['status', '--porcelain', '--', 'tests', 'frontend/tests'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean).map(l => l.slice(3))
const touchedExisting = changed.filter(f => existing.some(e => f.endsWith(e)) || /admin|auth|session|step/i.test(f) && !/human|expert|migrations\.012/.test(f))

// 2. run them unchanged, in this tree AND in a pristine checkout of the base commit (PRISTINE=<dir>, default /home/claude/base-clone), and compare:
//    the pilot must add NO failure (a test that already fails on the base commit is not the pilot's).
const files = [...existing.map(f => `tests/${f}`), ...fs.readdirSync(path.join(root, 'frontend', 'tests')).filter(f => /admin|auth|session|stepup/i.test(f) && !/human|expert/i.test(f)).map(f => `frontend/tests/${f}`)]
const failing = out => new Set([...strip(out).matchAll(/^ FAIL  (.+)$/gm)].map(m => m[1].trim()))
const r1 = run('npx', ['vitest', 'run', ...files])
const t1 = strip(r1.stdout + r1.stderr)
const m1 = t1.match(/Tests\s+(?:(\d+) failed \| )?(\d+) passed/)
const PRISTINE = process.env.PRISTINE || '/home/claude/base-clone'
let baseFailing = null
if (fs.existsSync(PRISTINE)) { const rb = spawnSync('npx', ['vitest', 'run', ...files], { cwd: PRISTINE, encoding: 'utf8', timeout: 280000 }); baseFailing = failing(rb.stdout + rb.stderr) }
const nowFailing = failing(t1)
const newFailures = baseFailing ? [...nowFailing].filter(x => !baseFailing.has(x)) : null

// 3. the cross-realm tests (a token from one realm is dead in the other; one shared secret refuses to run)
const r2 = run('npx', ['vitest', 'run', 'tests/expert.test.js', '-t', 'realms are separate'])
const t2 = strip(r2.stdout + r2.stderr); const m2 = t2.match(/Tests\s+(?:(\d+) failed \| )?(\d+) passed/)

const res = { existingAdminAuthTestFiles: existing.length, existingTestFilesModifiedByThePilot: touchedExisting, existingRun: { failed: m1 && m1[1] ? Number(m1[1]) : 0, passed: m1 ? Number(m1[2]) : 0, exit: r1.status, failingHere: [...nowFailing], failingOnPristineBase: baseFailing ? [...baseFailing] : 'pristine checkout not found', newFailuresAddedByThePilot: newFailures },
  crossRealmRun: { failed: m2 && m2[1] ? Number(m2[1]) : 0, passed: m2 ? Number(m2[2]) : 0, exit: r2.status },
  claims: ['expert tokens are signed with EXPERT_JWT_SECRET (must differ from JWT_SECRET, at least 32 chars) and carry aud=passthrough-experts, typ=expert, stage', 'the main auth middleware verifies with JWT_SECRET only, so an expert token fails on its signature; the admin area sits behind that middleware',
    'the expert middleware verifies with EXPERT_JWT_SECRET only, so a main-app token (admin included) fails on its signature', 'no shared table, no shared session store, no change to middleware/auth.js, adminOnly.js or lib/jwt.js'] }
res.verdict = touchedExisting.length === 0 && newFailures !== null && newFailures.length === 0 && res.existingRun.passed > 0 && res.crossRealmRun.exit === 0 && res.crossRealmRun.passed >= 4 ? 'PASS' : 'FAIL'
fs.writeFileSync(path.join(__dirname, 'realm-spike-results.json'), JSON.stringify(res, null, 2))
console.log(JSON.stringify(res, null, 2)); console.log(`\nREALM SPIKE: ${res.verdict}`); process.exit(res.verdict === 'PASS' ? 0 : 1)
