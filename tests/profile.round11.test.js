import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { HISTORY_SEARCH, applyScanSort } = require('../src/lib/scanSearch')
const constants = require('../src/config/constants')
const rl = require('../src/middleware/rateLimiter')
const routes = fs.readFileSync(path.join(__dirname, '../src/routes/profile.routes.js'), 'utf8')
const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0076_profile_dashboard_round11.sql'), 'utf8')

describe('round 11: score sort follows the displayed score', () => {
  it('orders by display_score, not ats_score', () => {
    const o = []; const q = { order(c, opts) { o.push([c, opts.ascending]); return q } }
    applyScanSort(q, 'score_desc')
    expect(o[0][0]).toBe('display_score')
  })
  it('display_score is the fixed score once a fix is scored, else the original (same rule as Index.jsx)', () => {
    expect(sql).toMatch(/case when fix_purchased and fix_ats_score is not null then fix_ats_score else ats_score end/)
    expect(sql.trimEnd().split('\n').slice(-3).join('\n')).toMatch(/'version', 76/)
    expect(constants.EXPECTED_SCHEMA_VERSION).toBe(76)
  })
})

describe('round 11: search matches what a row shows', () => {
  it('role label words match the snake_case role_category (spaces become _)', () => {
    expect(HISTORY_SEARCH('software engineering')).toContain('role_category.ilike.%software_engineering%')
  })
  it('source labels match input_mode by equality, only for 3+ characters', () => {
    expect(HISTORY_SEARCH('scratch')).toContain('input_mode.eq.brain_dump')
    expect(HISTORY_SEARCH('saved')).toContain('input_mode.eq.saved_profile')
    expect(HISTORY_SEARCH('sa')).not.toContain('input_mode')
    expect(HISTORY_SEARCH('zzz')).not.toContain('input_mode')
  })
})

describe('round 11: profile downloads have their own rate-limit buckets', () => {
  it('routes use profilePdf / profileDocx, not the scan buckets', () => {
    expect(routes).toMatch(/download-docx.*rl\.profileDocx/)
    expect(routes).toMatch(/download-pdf.*rl\.profilePdf/)
    expect(routes).not.toMatch(/rl\.(pdfRegen|draftDownload)/)
    expect(rl.profilePdf).toBeTypeOf('function'); expect(rl.profileDocx).toBeTypeOf('function')
  })
})
