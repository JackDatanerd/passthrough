import { describe, it, expect } from 'vitest'
import { spawnSync } from 'child_process'
import path from 'path'

// The live eval costs money, so its HARNESS is exercised offline with a canned fake model (--dry-run). This proves the wiring
// (fixtures -> extraction -> two-pass scorer -> rewrite -> letter -> checks -> aggregates) works end to end; it says nothing
// about prompt quality. A typo in scripts/prompt-eval.cjs or evals/ would otherwise surface only when someone paid for a run.
const run = args => spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/prompt-eval.cjs'), '--dry-run', ...args], { encoding: 'utf8', timeout: 120000, env: { ...process.env, ANTHROPIC_API_KEY: '' } })

describe('prompt eval runner (dry run)', () => {
  it('runs a fixture end to end and passes the checks the canned model can pass', () => {
    const r = run(['--only', 'strong-ops-analyst', '--runs', '2'])
    expect(r.stdout + r.stderr).toMatch(/1\/1 fixtures passed/)
    expect(r.stdout).toMatch(/fabricated gaps: 0/)
    expect(r.stdout).toMatch(/requirement-list agreement: 1\.00/)
    expect(r.status).toBe(0)
  })
  it('runs the extraction paths (a brain dump and a scrambled two-column upload) and the pairwise judge', () => {
    for (const id of ['brain-dump-bakery', 'scrambled-two-column']) {
      const r = run(['--only', id, '--runs', '2', '--judge'])
      expect(r.stdout + r.stderr, id).toMatch(/1\/1 fixtures passed/)
      expect(r.stdout, id).toMatch(/judge win-rate/)
    }
  })
  it('runs the gold extraction scorer', () => {
    const r = run(['--gold'])
    expect(r.stdout).toMatch(/gold cases passed/)      // the fake model extracts nothing, so most cases FAIL - the point is that the scorer ran
  })
  it('refuses to run without a key and without --dry-run', () => {
    const r = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/prompt-eval.cjs')], { encoding: 'utf8', env: { ...process.env, ANTHROPIC_API_KEY: '' } })
    expect(r.status).toBe(2)
  })
})
