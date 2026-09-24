import { describe, it, expect } from 'vitest'
import { scoreResume, extractKeywords, stem, tokenizeRaw, normalizeTechTerms, displayKeyword } from '../src/services/ats.service.js'
import { decodeHtmlEntities } from '../src/lib/htmlEntities.js'

const RESUME = `Jane Doe
jane@example.com

EXPERIENCE
Engineer - Acme - 2020 - Present
- Built machine learning pipelines in Python and C++
- Shipped services in C# and Go

EDUCATION
BS CS - State University - 2018

SKILLS
Python, C++, C#, ML, AI, Go, R, Node.js, CI/CD, QA, UX`

const kw = jd => { const r = scoreResume(RESUME, jd); return r.detail.keywords }

describe('tech-term tokenising', () => {
  it('keeps symbol-bearing terms as single canonical tokens', () => {
    const t = tokenizeRaw('C++ C# F# .NET CI/CD Objective-C')
    for (const tok of ['cplusplus', 'csharp', 'fsharp', 'dotnet', 'cicd', 'objectivec']) expect(t).toContain(tok)
  })
  it('splits Node.js / Next.js into name + js so "NodeJS" and "Node.js" agree', () => {
    expect(tokenizeRaw('Node.js')).toEqual(tokenizeRaw('NodeJS'))
    expect(tokenizeRaw('Next.js')).toContain('next')
    expect(tokenizeRaw('Next.js')).toContain('js')
  })
  it('recognises R and Go as languages ONLY in skill-list context', () => {
    expect(tokenizeRaw('Skills: Python, Go, R, SQL')).toContain('golang')
    expect(tokenizeRaw('Skills: Python, Go, R, SQL')).toContain('rlang')
    // ...and not in ordinary prose:
    for (const prose of ['Go to market strategy', 'We do R&D here', 'Jane R. Doe joined', 'Plan C is ready', 'Mr. John R. Smith']) {
      const t = tokenizeRaw(prose)
      expect(t).not.toContain('golang')
      expect(t).not.toContain('rlang')
      expect(t).not.toContain('clang')
    }
  })
  // BUG FIX (Scan/ATS section audit): C's list-context regex was missing the
  // end-of-line/end-of-string alternative Go and R both already had, so "C"
  // as the LAST language named in a list — an extremely common way to write
  // one — silently failed to normalize and then got dropped entirely by
  // keepToken() (bare single letters aren't kept). Verified against every
  // position in a list, not just mid-list, since that's exactly the case the
  // old regex missed.
  it('recognises a trailing "C" as the language at the END of a list (not just mid-list)', () => {
    for (const listText of ['Skills: Go, R, C', 'Required: C++, C', 'Languages: Python, Java, C']) {
      expect(tokenizeRaw(listText)).toContain('clang')
    }
    // Still mid-list and still not in ordinary prose — unaffected by the fix.
    expect(tokenizeRaw('Skills: C, Python, Java')).toContain('clang')
    for (const prose of ['Plan C is ready', 'Proficient in C.', 'Vitamin C']) {
      expect(tokenizeRaw(prose)).not.toContain('clang')
    }
  })
  it('keeps unicode letters intact (no "ing" + "nieur" fragments)', () => {
    const t = tokenizeRaw('ingénieur logiciel développement gestión')
    for (const w of ['ingénieur', 'développement', 'gestión']) expect(t).toContain(w)
  })
  it('normalises HTML entities defensively', () => {
    expect(tokenizeRaw('Docker&nbsp;Kubernetes &amp; Terraform')).not.toContain('nbsp')
    expect(tokenizeRaw('Docker&nbsp;Kubernetes &amp; Terraform')).not.toContain('amp')
  })
  it('displayKeyword maps canonical tokens back to real spellings', () => {
    expect(displayKeyword('cplusplus')).toBe('C++')
    expect(displayKeyword('csharp golang')).toBe('C# Go')
    expect(displayKeyword('dotnet')).toBe('.NET')
    expect(displayKeyword('python')).toBe('python')
  })
})

describe('keyword scoring on tech JDs (the old tokenizer made these invisible)', () => {
  it('extracts 2-letter tech terms: ML, AI, QA, UX', () => {
    const k = Object.keys(extractKeywords('We need ML and AI expertise plus QA and UX skills'))
    for (const t of ['ml', 'ai', 'qa', 'ux']) expect(k).toContain(t)
  })
  it('matches C++, C#, Go, R, ML, AI, CI/CD, Node against a resume that has them', () => {
    const m = kw('Required: C++, C#, Go and R. Nice: ML, AI, CI/CD, Node.js experience.').matched
    for (const t of ['C++', 'C#', 'Go', 'R', 'ml', 'ai', 'CI/CD', 'node']) expect(m).toContain(t)
  })
  it('reports a MISSING skill using its real spelling', () => {
    const missing = kw('Must know Kubernetes, Terraform and F#.').missing
    expect(missing).toContain('kubernetes')
    expect(missing).toContain('F#')
  })
  it('never surfaces internal canonical tokens or entity junk to the user', () => {
    const d = kw('Kubernetes&nbsp;Docker &amp; C++ &quot;microservices&quot; .NET').matched.concat(kw('Kubernetes&nbsp;Docker &amp; C++ &quot;microservices&quot; .NET').missing)
    for (const bad of ['nbsp', 'amp', 'quot', 'cplusplus', 'dotnet', 'csharp']) expect(d).not.toContain(bad)
  })
  it('a resume WITHOUT the required language scores lower on keywords than one with it', () => {
    const withCpp = scoreResume(RESUME, 'C++ C++ C++ developer').keywordScore
    const without = scoreResume(RESUME.replace(/C\+\+/g, ''), 'C++ C++ C++ developer').keywordScore
    expect(withCpp).toBeGreaterThan(without)
  })
})

// The original "credits inflected forms" test was vacuous: "scalable" and "systems"
// match literally, and it only asserted matched.length > 0, so it passed with stemming deleted.
describe('stemming (non-vacuous)', () => {
  it('stem() unifies inflections of the same word', () => {
    expect(stem('developing')).toBe(stem('developed'))
    expect(stem('developed')).toBe(stem('develops'))
    expect(stem('managed')).toBe(stem('managing'))
    expect(stem('tested')).toBe(stem('testing'))
  })
  it('a JD verb is matched by a DIFFERENT inflection in the resume, and ONLY because of stemming', () => {
    const resume = 'Jane Doe\njane@example.com\n\nEXPERIENCE\nEngineer - Acme - 2020 - Present\n- Managed distributed deployments\n'
    const r = scoreResume(resume, 'Experience managing deployments')
    expect(r.detail.keywords.matched).toContain('managing')   // resume only has "Managed"
  })
  it('does not stem protected tokens (short tech terms / canonical forms)', () => {
    for (const t of ['cplusplus', 'golang', 'rlang', 'js', 'ml', 'ai']) expect(stem(t)).toBe(t)
  })
})

describe('decodeHtmlEntities', () => {
  it('decodes common named and numeric entities', () => {
    expect(decodeHtmlEntities('a&nbsp;b &amp; c &lt;d&gt; &quot;e&quot; &#39;f&#39; &#x41; &#65;')).toBe('a b & c <d> "e" \'f\' A A')
  })
  it('replaces unknown entities with a space instead of leaving junk tokens', () => {
    expect(decodeHtmlEntities('x&foobar;y')).toBe('x y')
  })
  it('does not throw on invalid code points', () => {
    expect(decodeHtmlEntities('&#0;&#55296;&#9999999;')).toBe('   ')
  })
  it('leaves text without entities (and non-strings) alone', () => {
    expect(decodeHtmlEntities('R&D at AT&T')).toBe('R&D at AT&T')
    expect(decodeHtmlEntities(undefined)).toBeUndefined()
  })
})
