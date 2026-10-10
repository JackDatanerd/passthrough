// @vitest-environment jsdom
// index.html is shared by every route, so the canonical link is set per route here — a static one in the
// HTML would tell search engines that /pricing IS the homepage.
import { describe, it, expect, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import usePageTitle from '../src/hooks/usePageTitle'

function Probe() { usePageTitle(); return null }
const at = (path) => render(<MemoryRouter initialEntries={[path]}><Probe /></MemoryRouter>)
const canon = () => document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null
beforeEach(() => { document.head.querySelectorAll('link[rel="canonical"],meta[name="robots"]').forEach(n => n.remove()) })

describe('canonical link', () => {
  it('the homepage is canonical at "/" — without the ?ref= / ?mode= query it was visited with', () => {
    at('/?ref=COACH20&mode=brainDump')
    expect(canon()).toBe(`${window.location.origin}/`)
  })
  it('a public page canonicalises to itself, trailing slash removed', () => {
    at('/pricing/')
    expect(canon()).toBe(`${window.location.origin}/pricing`)
  })
  it('private pages get none (they are noindex)', () => {
    at('/pricing'); expect(canon()).not.toBeNull()
    document.head.querySelectorAll('link[rel="canonical"]').forEach(n => n.remove())
    at('/dashboard'); expect(canon()).toBeNull()
    at('/v/ABCDEFGH23'); expect(canon()).toBeNull()
  })
  it('never leaves two canonical links behind', () => {
    at('/'); at('/pricing')
    expect(document.querySelectorAll('link[rel="canonical"]')).toHaveLength(1)
  })
})
