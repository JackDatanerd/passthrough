// @vitest-environment jsdom
// What the SPA does to <head> at runtime must agree with what the search-indexing build wrote into the static HTML.
import { describe, it, expect, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import usePageTitle from '../src/hooks/usePageTitle'

function Probe() { usePageTitle(); return null }
const at = (path) => render(<MemoryRouter initialEntries={[path]}><Probe /></MemoryRouter>)
const robots = () => document.querySelector('meta[name="robots"]')?.getAttribute('content') ?? null
const canon = () => document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null
beforeEach(() => { document.head.querySelectorAll('link[rel="canonical"],meta[name="robots"]').forEach(n => n.remove()) })

describe('runtime head vs the registry', () => {
  it.each(['/partner/apply', '/partner/terms'])('%s is indexable: no noindex stamped on it, and it keeps a canonical', p => {
    at(p)
    expect(robots()).toBeNull()
    expect(canon()).toBe(`${window.location.origin}${p}`)
  })

  it('the token pages under /partner are still noindex with no canonical', () => {
    for (const p of ['/partner/dashboard', '/partner/payout-details', '/partner/recover']) {
      document.head.querySelectorAll('link[rel="canonical"],meta[name="robots"]').forEach(n => n.remove())
      at(p)
      expect(robots(), p).toBe('noindex,nofollow')
      expect(canon(), p).toBeNull()
    }
  })

  it('a registered page is canonical at its registered path however the URL was typed', () => {
    at('/Pricing/?utm_source=x')
    expect(canon()).toBe(`${window.location.origin}/pricing`)
  })

  it('sets the registry title as the tab title', () => {
    at('/partner/apply')
    expect(document.title).toBe('Become a partner — Passthrough')
  })
})
