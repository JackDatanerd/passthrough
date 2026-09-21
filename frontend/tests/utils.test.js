import { describe, it, expect, afterEach } from 'vitest'
import { formatDate, formatMoney, formatCents, scoreTier, scoreColor, scoreBg, statusLabel, cn, copyToClipboard, downloadBlob } from '../src/lib/utils.js'
import { titleFor, isPrivatePath, DEFAULT_TITLE } from '../src/lib/pageTitles.js'

describe('formatMoney / formatCents', () => {
  it('formats dollars and cents', () => {
    expect(formatCents(4900)).toBe('$49.00')
    expect(formatCents(0)).toBe('$0.00')
    expect(formatCents(1)).toBe('$0.01')
    expect(formatMoney(4900, { decimals: 0 })).toBe('$49')
  })
  // was "$NaN" for undefined and "$0.00" for null
  it('shows a dash for missing / non-numeric amounts instead of $NaN', () => {
    for (const v of [null, undefined, '', NaN, 'abc', Infinity]) expect(formatCents(v)).toBe('—')
  })
  it('handles negatives (refunds / adjustments)', () => {
    expect(formatCents(-500)).toBe('-$5.00')
  })
  it('accepts numeric strings', () => expect(formatCents('4900')).toBe('$49.00'))
})

describe('formatDate', () => {
  it('formats an ISO timestamp', () => {
    expect(formatDate('2026-09-01T12:00:00Z')).toMatch(/Sep 1, 2026/)
  })
  it('shows a dash for missing or invalid dates instead of "Invalid Date"', () => {
    for (const v of [null, undefined, '', 'garbage', 'Invalid Date']) expect(formatDate(v)).toBe('—')
  })
  // "2026-09-01" is UTC midnight when parsed with new Date(); west of UTC that displayed as Aug 31.
  it('renders a date-only string as that exact calendar day in ANY timezone', () => {
    const original = process.env.TZ
    for (const tz of ['America/Los_Angeles', 'Pacific/Honolulu', 'Asia/Tokyo', 'Africa/Nairobi', 'UTC']) {
      process.env.TZ = tz
      expect(formatDate('2026-09-01')).toBe('Sep 1, 2026')
    }
    process.env.TZ = original
  })
})

describe('score helpers', () => {
  it('scoreTier thresholds match the backend pass mark (75) and marginal (50)', () => {
    expect(scoreTier(100)).toBe('pass'); expect(scoreTier(75)).toBe('pass')
    expect(scoreTier(74)).toBe('marginal'); expect(scoreTier(50)).toBe('marginal')
    expect(scoreTier(49)).toBe('fail'); expect(scoreTier(0)).toBe('fail')
  })
  // a missing score used to render in the FAIL colour
  it('a missing score is "unknown", not a failure', () => {
    for (const v of [null, undefined, NaN]) {
      expect(scoreTier(v)).toBe('unknown')
      expect(scoreColor(v)).toBe('text-gray-400')
      expect(scoreBg(v)).toMatch(/gray/)
    }
  })
  it('colours follow the tier', () => {
    expect(scoreColor(90)).toMatch(/green/)
    expect(scoreColor(60)).toMatch(/amber/)
    expect(scoreColor(10)).toMatch(/red/)
  })
})

describe('statusLabel / cn', () => {
  it('labels every scan status the backend can emit', () => {
    const all = ['PENDING', 'SCANNING', 'COMPLETE_PASS', 'COMPLETE_FAIL', 'FIX_PURCHASED', 'FIX_GENERATING', 'FIX_DELIVERED', 'ERROR']
    for (const s of all) expect(statusLabel(s)).not.toBe(s)
    expect(statusLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW')
  })
  it('cn joins truthy classes only', () => {
    expect(cn('a', false, null, undefined, '', 'b')).toBe('a b')
  })
})

describe('page titles', () => {
  it('gives each route its own title, and the default elsewhere', () => {
    expect(titleFor('/pricing')).toBe('Pricing — Passthrough')
    expect(titleFor('/dashboard/settings')).toBe('Settings — Passthrough')
    expect(titleFor('/dashboard')).toBe('Your scans — Passthrough')
    expect(titleFor('/scan/abc')).toBe('Your scan — Passthrough')
    expect(titleFor('/')).toBe(DEFAULT_TITLE)
    expect(titleFor('/nonsense')).toBe(DEFAULT_TITLE)
  })
  it('marks per-user / token pages noindex, but not marketing pages', () => {
    for (const p of ['/scan/1', '/dashboard', '/dashboard/settings', '/admin/partners', '/partner/dashboard', '/payment/success', '/reset-password', '/verify-email'])
      expect(isPrivatePath(p)).toBe(true)
    for (const p of ['/', '/pricing', '/terms', '/privacy', '/login', '/v/ABC']) expect(isPrivatePath(p)).toBe(false)
  })
})

describe('copyToClipboard', () => {
  const realNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const realDoc = globalThis.document
  afterEach(() => {
    if (realNav) Object.defineProperty(globalThis, 'navigator', realNav); else delete globalThis.navigator
    globalThis.document = realDoc
  })
  const setNav = v => Object.defineProperty(globalThis, 'navigator', { value: v, configurable: true, writable: true })

  it('reports success when the async clipboard API works', async () => {
    let written
    setNav({ clipboard: { writeText: async t => { written = t } } })
    expect(await copyToClipboard('hello')).toBe(true)
    expect(written).toBe('hello')
  })
  it('reports FAILURE (false) instead of pretending it copied when every method fails', async () => {
    setNav({ clipboard: { writeText: async () => { throw new Error('denied') } } })
    globalThis.document = undefined
    expect(await copyToClipboard('x')).toBe(false)
  })
  it('falls back to execCommand when the async API is unavailable', async () => {
    setNav({})
    const appended = []
    globalThis.document = {
      createElement: () => ({ style: {}, setAttribute() {}, select() {} }),
      body: { appendChild: e => appended.push(e), removeChild() {} },
      execCommand: cmd => cmd === 'copy',
    }
    expect(await copyToClipboard('x')).toBe(true)
    expect(appended).toHaveLength(1)
  })
})

describe('downloadBlob', () => {
  it('attaches the anchor to the DOM, clicks it, and revokes the URL LATER (not synchronously)', async () => {
    const realDoc = globalThis.document
    const events = []
    const anchor = { style: {}, click() { events.push('click') } }
    globalThis.document = { createElement: () => anchor, body: { appendChild: () => events.push('append'), removeChild: () => events.push('remove') } }
    const realRevoke = URL.revokeObjectURL
    URL.revokeObjectURL = () => events.push('revoke')
    try {
      downloadBlob(new Blob(['hi']), 'resume.pdf')
      expect(anchor.download).toBe('resume.pdf')
      expect(events).toEqual(['append', 'click'])     // nothing revoked/removed yet
      await new Promise(r => setTimeout(r, 1700))
      expect(events).toEqual(['append', 'click', 'remove', 'revoke'])
    } finally {
      URL.revokeObjectURL = realRevoke
      globalThis.document = realDoc
    }
  })
})
