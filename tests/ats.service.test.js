import { describe, it, expect } from 'vitest'
import { scoreResume, describeWeakAreas } from '../src/services/ats.service.js'

// This suite exists specifically to lock in fixes found through real,
// hands-on debugging tonight — each describe block below corresponds to an
// actual bug that shipped, was found, and was fixed. The goal isn't
// exhaustive coverage of every possible resume; it's making sure none of
// these specific regressions can silently come back.

describe('scoreResume — keyword matching (stemming + phrase detection)', () => {
  it('credits inflected forms of the same word (was: exact-string-only matching)', () => {
    const jd = 'Looking for someone who can develop and test scalable systems'
    const resumeWithInflections = `
Jane Doe
jane@example.com

EXPERIENCE
Senior Engineer - Acme - 2020-2024
- Developed and tested scalable backend systems for high-traffic workloads
`
    const result = scoreResume(resumeWithInflections, jd)
    // "Developed"/"tested" should credit "develop"/"test" via stemming
    // (gerund/past-tense inflection — one of the specific cases the
    // lightweight stemmer is designed to handle), not require an exact
    // string match.
    expect(result.detail.keywords.matched.length).toBeGreaterThan(0)
  })

  it('does not count job-posting boilerplate as missing keywords', () => {
    const jd = 'Your role requires you to apply your skills. Please provide excellent work. This job requires experience.'
    const resume = `Jane Doe\njane@example.com\n\nEXPERIENCE\nEngineer - Acme - 2020\n- Built things`
    const result = scoreResume(resume, jd)
    const boilerplateWords = ['your', 'role', 'apply', 'provide', 'job', 'work', 'experience']
    for (const word of boilerplateWords) {
      expect(result.detail.keywords.missing).not.toContain(word)
    }
  })

  it('extracts multi-word phrases, not just single words', () => {
    const jd = 'Requires strong quality assurance and machine learning background, quality assurance is critical'
    const resume = `Jane Doe\njane@example.com\n\nSKILLS\nQuality assurance, testing`
    const result = scoreResume(resume, jd)
    const allTerms = [...result.detail.keywords.matched, ...result.detail.keywords.missing]
    expect(allTerms.some(k => k.includes(' '))).toBe(true)
  })
})

describe('scoreResume — content scoring (action verb detection)', () => {
  it('credits a comprehensive set of real resume action verbs, not just a narrow list', () => {
    // These specific verbs were NOT in the original 44-word list and got
    // zero credit before the fix — this is what caused Content scores to
    // land in the 30s-40s on genuinely well-written resumes.
    const resume = `Jane Doe
jane@example.com

EXPERIENCE
Senior Engineer - Acme - 2020-2024
- Wrote comprehensive technical documentation for the platform migration
- Reviewed pull requests and conducted code quality audits weekly
- Supervised a team of 4 junior engineers
- Engineered a validation pipeline that improved reliability

EDUCATION
BS Computer Science - State University - 2018

SKILLS
Python, JavaScript`
    const result = scoreResume(resume, 'Software engineer role')
    expect(result.detail.content.actionVerbRate).toBe(1)
  })

  it('credits tense/inflection variants of a listed verb via stemming', () => {
    const resume = `Jane Doe
jane@example.com

EXPERIENCE
Engineer - Acme - 2020 - Present
- Leading the migration to a new review workflow

EDUCATION
BS CS - State University - 2018`
    const result = scoreResume(resume, 'Engineering role')
    // "Leading" should credit via the same stem as "Led"/"lead"
    expect(result.detail.content.actionVerbRate).toBe(1)
  })

  it('recognizes plain bullet characters, not just numbered lists', () => {
    const resume = `Jane Doe
jane@example.com

EXPERIENCE
Engineer - Acme - 2020
• Built a thing
- Led a team
* Developed a tool

EDUCATION
BS CS - State University - 2018`
    const result = scoreResume(resume, 'Engineering role')
    expect(result.detail.content.actionVerbRate).toBe(1)
  })
})

describe('scoreResume — section scoring', () => {
  it('does not penalize a complete resume for lacking Certifications', () => {
    const resume = `Jane Doe
jane@example.com | Austin, TX

PROFESSIONAL SUMMARY
Experienced engineer with a track record of delivery.

EXPERIENCE
Senior Engineer - Acme - 2020 - Present
- Led the platform migration

EDUCATION
BS Computer Science - State University - 2018

SKILLS
Python, JavaScript, AWS`
    const result = scoreResume(resume, 'Engineering role')
    // Previously capped at 85 purely for lacking Certifications, which
    // most candidates legitimately don't have — this resume has every
    // section that's actually required.
    expect(result.sectionsScore).toBe(100)
  })

  it('still penalizes a genuinely missing required section', () => {
    const resume = `Jane Doe
jane@example.com

EXPERIENCE
Senior Engineer - Acme - 2020 - Present
- Led the platform migration

EDUCATION
BS Computer Science - State University - 2018`
    // No Skills section at all
    const result = scoreResume(resume, 'Engineering role')
    expect(result.sectionsScore).toBeLessThan(100)
    expect(result.detail.sections.missing).toContain('Skills')
  })
})

describe('scoreResume — format scoring', () => {
  it('does not flag common pipe-separated formatting as a table', () => {
    // "Company | Location | Dates" is a standard, ATS-safe resume
    // convention — the old heuristic (count total | characters) flagged
    // this as "Tables detected" purely from separator usage, even though a
    // real DOCX table produces ZERO pipe characters under our extractor.
    const resume = `Jane Doe
jane@example.com | Austin, TX | (512) 555-0100

EXPERIENCE
Senior Engineer | Acme Corp | Austin, TX | 2021 - Present
- Led the platform migration

Engineer | Beta Inc | Remote | 2018 - 2021
- Built the initial system

EDUCATION
BS Computer Science | State University | 2018

SKILLS
Python, JavaScript`
    const result = scoreResume(resume, 'Engineering role')
    expect(result.detail.format.issues).not.toContain('Tables detected — ATS may fail to parse')
  })
})

describe('describeWeakAreas', () => {
  it('produces concrete, actionable feedback rather than a generic message', () => {
    const weak = { keywordScore: 40, contentScore: 30, sectionsScore: 100, formatScore: 100,
      detail: { keywords: { missing: ['kubernetes', 'terraform'] }, content: { actionVerbRate: 0.2 },
        sections: { missing: [] }, format: { issues: [] } } }
    const notes = describeWeakAreas(weak)
    expect(notes.join(' ')).toMatch(/kubernetes|terraform/)
  })
})
