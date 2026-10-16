import { describe, it, expect } from 'vitest'
import { scoreResume, CATEGORY_WEIGHTS } from '../src/services/ats.service.js'

// The results page says where a scan's missing points are using CATEGORY_WEIGHTS. If scoreResume's own formula ever
// changes and these drift apart, the page would blame the wrong category, so this reproduces scoreResume from them.
const RESUMES = [
  'Jane Doe\njane@x.com | 555-123-4567\nSUMMARY\nSenior engineer.\nEXPERIENCE\nAcme 2019-2024\n- Led a team of 6 engineers and cut latency 40%\n- Worked on various things\nEDUCATION\nBSc Computer Science\nSKILLS\nPython, SQL, AWS, Docker',
  'Sam Roe\nEXPERIENCE\n- Responsible for tasks\n- Helped with reports\n- Assisted the team',
  'Pat Lee\npat@x.com\nPROFILE\nOperations lead.\nEXPERIENCE\nBeta 2015-2023\n- Managed a $2M budget\n- Reduced costs 18% across 9 sites\nEDUCATION\nMBA\nSKILLS\nBudgeting, Forecasting, Excel',
]
const JDS = [
  'We need a senior engineer with Python, SQL, AWS and Docker experience. Lead engineers and mentor a team. Kubernetes a plus.',
  'Operations manager. Budgeting, forecasting, vendor management, Excel, reporting and cost reduction across multiple sites.',
]

describe('CATEGORY_WEIGHTS', () => {
  it('are frozen and add up to 1', () => {
    expect(Object.isFrozen(CATEGORY_WEIGHTS)).toBe(true)
    expect(Object.values(CATEGORY_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10)
  })
  it('reproduce scoreResume exactly, so the page blames the right category', () => {
    for (const r of RESUMES) for (const jd of JDS) {
      const s = scoreResume(r, jd)
      expect(s.detail.keywords.noKeywords).toBe(false)
      const rebuilt = Math.round(
        s.keywordScore * CATEGORY_WEIGHTS.keywords + s.formatScore * CATEGORY_WEIGHTS.format +
        s.sectionsScore * CATEGORY_WEIGHTS.sections + s.contentScore * CATEGORY_WEIGHTS.content)
      expect(rebuilt).toBe(s.score)
    }
  })
  it('a job description with nothing scoreable drops the keyword category and says so in the detail', () => {
    const s = scoreResume(RESUMES[0], 'the and of to a in is it')
    expect(s.detail.keywords.noKeywords).toBe(true)
  })
})
