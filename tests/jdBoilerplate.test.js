import { describe, it, expect } from 'vitest'
import { stripPlatformBoilerplate, isKnownUnreliablePlatform } from '../src/services/jdBoilerplate.js'

// Zero test coverage previously, despite sitting directly in the JD-URL
// scan path — a regression here silently degrades ATS scoring accuracy
// (either leaving noise in that pollutes keyword extraction, or over-
// truncating real job content) with no test to catch it.

describe('isKnownUnreliablePlatform', () => {
  it('flags Workday hosts (and subdomains) as client-side rendered', () => {
    expect(isKnownUnreliablePlatform('acme.myworkdayjobs.com')).toBe(true)
    expect(isKnownUnreliablePlatform('myworkdayjobs.com')).toBe(true)
  })
  it('does not flag Greenhouse/Lever/other hosts', () => {
    expect(isKnownUnreliablePlatform('boards.greenhouse.io')).toBe(false)
    expect(isKnownUnreliablePlatform('jobs.lever.co')).toBe(false)
    expect(isKnownUnreliablePlatform('example.com')).toBe(false)
  })
  it('does not false-positive on a host that merely contains the string', () => {
    expect(isKnownUnreliablePlatform('notmyworkdayjobs.com.evil.example')).toBe(false)
  })
})

describe('stripPlatformBoilerplate — generic (runs on every host)', () => {
  it('strips cross-site noise phrases on an arbitrary host', () => {
    const text = 'Senior Engineer role. Apply now. We use cookies. Similar jobs below.'
    const out = stripPlatformBoilerplate('example.com', text)
    expect(out).not.toMatch(/apply now/i)
    expect(out).not.toMatch(/we use cookies/i)
    expect(out).not.toMatch(/similar jobs/i)
    expect(out).toContain('Senior Engineer role.')
  })

  it('collapses whitespace left behind by stripped phrases', () => {
    const out = stripPlatformBoilerplate('example.com', 'Great role.   Sign in   to apply. More stuff.')
    expect(out).not.toMatch(/\s{2,}/)
  })

  it('leaves ordinary JD prose untouched on a non-Greenhouse/Lever host', () => {
    const text = 'We are looking for a backend engineer with 5+ years of experience in distributed systems.'
    expect(stripPlatformBoilerplate('jobs.acme.com', text)).toBe(text)
  })
})

describe('stripPlatformBoilerplate — Greenhouse/Lever get anchor truncation + form-field stripping', () => {
  it('truncates everything from the first EEO/self-ID anchor phrase onward', () => {
    const text = 'Real job description content here. Voluntary Self-Identification survey follows with demographic questions.'
    const out = stripPlatformBoilerplate('boards.greenhouse.io', text)
    expect(out).toBe('Real job description content here.')
  })

  it('cuts at the EARLIEST matching anchor when more than one appears', () => {
    const text = 'Job content. Equal Employment Opportunity statement. Section 503 of the Rehabilitation Act details.'
    const out = stripPlatformBoilerplate('jobs.lever.co', text)
    expect(out).toBe('Job content.')
  })

  it('strips form-field labels (First Name, Resume/CV, Powered by Greenhouse, etc.)', () => {
    const text = 'Great role for a designer. First Name * Last Name * Resume/CV * Cover Letter Apply for this job * Powered by Greenhouse'
    const out = stripPlatformBoilerplate('boards.greenhouse.io', text)
    expect(out).not.toMatch(/first name/i)
    expect(out).not.toMatch(/resume\/cv/i)
    expect(out).not.toMatch(/powered by greenhouse/i)
    expect(out).toContain('Great role for a designer.')
  })

  it('applies generic stripping too, before the anchor/form-field passes', () => {
    const text = 'Role details. Apply with LinkedIn. Voluntary Self-Identification follows.'
    const out = stripPlatformBoilerplate('jobs.lever.co', text)
    expect(out).not.toMatch(/apply with linkedin/i)
    expect(out).not.toMatch(/voluntary self-identification/i)
    expect(out).toContain('Role details.')
  })

  it('leaves real content intact when no anchor/form-field noise is present', () => {
    const text = 'We need a product manager to own the roadmap for our core platform.'
    expect(stripPlatformBoilerplate('boards.greenhouse.io', text)).toBe(text)
  })
})

describe('stripPlatformBoilerplate — Workday host', () => {
  it('only gets generic stripping (no anchor truncation, since Workday is handled via isKnownUnreliablePlatform separately)', () => {
    const text = 'Some partial content. Voluntary Self-Identification form.'
    const out = stripPlatformBoilerplate('acme.myworkdayjobs.com', text)
    // Workday isn't in GREENHOUSE_HOSTS/LEVER_HOSTS, so it falls into the
    // generic-only branch — the EEO anchor phrase should NOT be truncated
    // away here, only the pure-noise phrases generic stripping targets.
    expect(out).toContain('Voluntary Self-Identification form.')
  })
})
