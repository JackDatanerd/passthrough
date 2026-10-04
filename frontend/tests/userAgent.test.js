import { describe, it, expect } from 'vitest'
import { describeUserAgent } from '../src/lib/userAgent.js'

describe('describeUserAgent', () => {
  const cases = [
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36', 'Chrome on Windows'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0', 'Edge on Windows'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Version/17.0 Mobile/15E148 Safari/604.1', 'Safari on iOS'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36', 'Chrome on Android'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/121.0', 'Firefox on macOS'],
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36', 'Chrome on Linux'],
  ]
  it.each(cases)('%s -> %s', (ua, label) => expect(describeUserAgent(ua)).toBe(label))
  // Impersonating UA strings: iPhone contains "Mac OS X", Android contains "Linux", Edge contains "Chrome".
  it('falls back to a plain label rather than echoing an unrecognised agent', () => {
    expect(describeUserAgent('curl/8.0')).toBe('Unknown device')
    expect(describeUserAgent('')).toBe('Unknown device')
    expect(describeUserAgent(null)).toBe('Unknown device')
  })
})
