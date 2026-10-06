import { describe, it, expect } from 'vitest'
import {
  extractUnquotedContent, isForwardSubject, cleanSubject, isAutomatedMessage, senderEmail, matchGuardianAddress,
} from '@/lib/ai/guardian-email'

// The inbound webhook used to filter quoted text line-by-line: it dropped only the marker line of an
// Outlook reply (leaving the whole quoted thread to be re-classified as a NEW request) and missed
// Gmail's attribution line when the client wrapped it over two lines.
describe('extractUnquotedContent', () => {
  it('cuts an Outlook-style reply at the marker instead of keeping the quoted thread', () => {
    const t = 'Sounds good, please also add a loyalty programme.\n\n-----Original Message-----\nFrom: Jane <j@a.com>\nSent: Monday\nTo: Us\nSubject: Re: kickoff\n\nWe need a blog for the site and a mobile app.\n'
    expect(extractUnquotedContent(t)).toBe('Sounds good, please also add a loyalty programme.')
  })

  it('cuts at a Gmail attribution line wrapped over two lines', () => {
    const t = 'Add SSO please.\n\nOn Mon, Sep 21, 2026 at 10:15 AM Jane Mwangi <jane@acme.example.com>\nwrote:\n\nOld thread text about a mobile app'
    expect(extractUnquotedContent(t)).toBe('Add SSO please.')
  })

  it('cuts at a single-line attribution and drops > quoted lines', () => {
    expect(extractUnquotedContent('Add SSO please.\n\nOn Mon, Sep 21, 2026 at 10:15 AM Jane <j@a.com> wrote:\n> old')).toBe('Add SSO please.')
    expect(extractUnquotedContent('New ask\n> quoted\nmore new')).toBe('New ask\nmore new')
  })

  it('cuts at the Outlook underscore rule', () => {
    expect(extractUnquotedContent('New ask: add a blog.\n\n________________________________\nFrom: Jane\nSent: Monday\nSubject: x\n\nold text')).toBe('New ask: add a blog.')
  })

  it('keeps a FORWARDED client message (the documented workflow) but drops its header block', () => {
    const outlook = 'FYI\n\n-----Original Message-----\nFrom: Jane <j@a.com>\nSent: Monday\nTo: Us\nSubject: FW: kickoff\n\nCan you also build a mobile app?'
    expect(extractUnquotedContent(outlook, { isForward: true })).toBe('FYI\n\nCan you also build a mobile app?')
    const gmail = '---------- Forwarded message ---------\nFrom: Jane <j@a.com>\nDate: Mon\nSubject: Hi\nTo: me\n\nPlease add a Swahili version.\n\nOn Sun, Jane wrote:\n> older'
    expect(extractUnquotedContent(gmail)).toBe('Please add a Swahili version.')
  })

  it('does not delete legitimate lines that merely start with "From:" or "---"', () => {
    expect(extractUnquotedContent('From: my side, we need SSO.\n--- and a blog too')).toBe('From: my side, we need SSO.\n--- and a blog too')
  })

  it('stops at the signature delimiter', () => {
    expect(extractUnquotedContent('Add SSO.\n-- \nJane\nAcme')).toBe('Add SSO.')
  })
})

describe('subjects', () => {
  it('recognises forwards and strips reply chains', () => {
    expect(isForwardSubject('Fwd: quote')).toBe(true)
    expect(isForwardSubject('FW: quote')).toBe(true)
    expect(isForwardSubject('Re: quote')).toBe(false)
    expect(cleanSubject('Re: Fwd: RE: Add a blog')).toBe('Add a blog')
  })

  // FIX (independent pass round 4, section 13): isForwardSubject used to test only the single prefix
  // at the very start — a reply prefix layered in front of a forward marker was missed entirely, which
  // meant a forwarded client request could be treated as a plain reply and have its whole body cut.
  it('recognises a forward marker layered behind a reply prefix', () => {
    expect(isForwardSubject('Re: Fwd: New feature idea')).toBe(true)
    expect(isForwardSubject('Fwd: Re: New feature idea')).toBe(true)
    expect(isForwardSubject('Re: Re: Fwd: New feature idea')).toBe(true)
    expect(isForwardSubject('Re: Re: New feature idea')).toBe(false)
    expect(isForwardSubject('')).toBe(false)
  })
})

describe('isAutomatedMessage', () => {
  it('flags auto-responders, bulk mail and bounces', () => {
    expect(isAutomatedMessage({ Headers: [{ Name: 'Auto-Submitted', Value: 'auto-replied' }] })).toBe(true)
    expect(isAutomatedMessage({ Headers: [{ Name: 'Precedence', Value: 'bulk' }] })).toBe(true)
    expect(isAutomatedMessage({ From: 'MAILER-DAEMON@mx.example.com' })).toBe(true)
  })
  it('lets a normal message and Auto-Submitted: no through', () => {
    expect(isAutomatedMessage({ Headers: [{ Name: 'Auto-Submitted', Value: 'no' }], From: 'jane@acme.com' })).toBe(false)
    expect(isAutomatedMessage({})).toBe(false)
  })
})

describe('senderEmail / matchGuardianAddress', () => {
  it('extracts a lower-cased sender', () => {
    expect(senderEmail({ FromFull: { Email: 'Jane@Acme.com' } })).toBe('jane@acme.com')
    expect(senderEmail({ From: 'Jane <JANE@acme.com>' })).toBe('jane@acme.com')
  })
  it('matches the WHOLE guardian address only', () => {
    expect(matchGuardianAddress('Jane <proj-ab12cd34@guard.scopegov.app>', 'guard.scopegov.app')).toBe('ab12cd34')
    expect(matchGuardianAddress('evilproj-ab12cd34@guard.scopegov.app', 'guard.scopegov.app')).toBeNull()
    expect(matchGuardianAddress('proj-ab12cd34@guard.scopegov.app.evil.com', 'guard.scopegov.app')).toBeNull()
  })
})

describe('pass 16 regressions', () => {
  it('B-A: localized header words in a forwarded body are not swallowed', () => {
    const t = 'FYI\n\n---------- Forwarded message ---------\nFrom: Jane <j@a.com>\nDate: Mon, Sep 1, 2026 at 10:00 AM\nSubject: Hi\nTo: me\n\nA: add a store\nB: add a blog'
    const r = extractUnquotedContent(t)
    expect(r).toContain('A: add a store')
    expect(r).toContain('B: add a blog')
    expect(extractUnquotedContent('Fwd\n\n---------- Forwarded message ---------\nFrom: J <j@a.com>\nTo: x@y.com\n\nDe: nada, solo queremos un blog', { isForward: true })).toContain('De: nada')
  })
  it('B-A: a real localized To/A line with an address is still dropped as a header', () => {
    const r = extractUnquotedContent('Hi\n\n---------- Forwarded message ---------\nDe: Jane <j@a.com>\nA: yo <y@a.com>\n\nQuiero un blog.')
    expect(r).not.toContain('A: yo')
    expect(r).toContain('Quiero un blog.')
  })
  it('B-B: a bare -- separator keeps an unpunctuated second request, but still ends at a signature', () => {
    expect(extractUnquotedContent('Please add dark mode\n--\nAlso add a Spanish version')).toContain('Spanish version')
    expect(extractUnquotedContent('Please add dark mode\n--\nJack Smith\nAcme Inc')).toBe('Please add dark mode')
    expect(extractUnquotedContent('Please add dark mode\n--\nBest regards\nJack')).toBe('Please add dark mode')
  })
  it('B-C: prose From:/Date: lines are not an Outlook header block', () => {
    const r = extractUnquotedContent('We need an app.\nFrom: the design team we want more\nDate: Monday is the deadline\nthanks')
    expect(r).toContain('thanks')
    expect(r).toContain('Monday is the deadline')
  })
})
