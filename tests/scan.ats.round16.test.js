// Scan/ATS round 16 - source-level guards for two race / outage fixes (behaviour is exercised by the scan suites).
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
const CTRL = fs.readFileSync(new URL('../src/controllers/scan.controller.js', import.meta.url), 'utf8')

describe('structureResume only writes the report it derived while the scan is untouched', () => {
  it('pins the finished free-scan status and updated_at', () => {
    const body = CTRL.slice(CTRL.indexOf('async function structureResume'), CTRL.indexOf('async function structureResume') + 6000)
    expect(body).toMatch(/\.in\('status', \['COMPLETE_PASS', 'COMPLETE_FAIL'\]\)/)
    expect(body).toMatch(/if \(patch\.full_ats_report && scan\.updatedAt\) q = q\.eq\('updated_at', scan\.updatedAt\)/)
  })
})

describe('generateBadge measures the delivered file a second time before giving up on the AI half', () => {
  it('retries once when the first score had no AI half', () => {
    const i = CTRL.indexOf("scoreLikeScan(env, deliveredText, jdText, 'generateBadge')")
    expect(i).toBeGreaterThan(0)
    expect(CTRL.slice(i, i + 700)).toMatch(/if \(!badgeScored\.aiBlended\)[\s\S]*generateBadge \(second try\)[\s\S]*if \(again\.aiBlended\) badgeScored = again/)
  })
})
