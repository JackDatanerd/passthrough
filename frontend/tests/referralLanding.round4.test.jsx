// @vitest-environment jsdom
// Section 4 round 4 (B3): a page that seeds its state from storage while rendering
// (Pricing / ScanResult: useState(getStoredReferralCode())) used to miss a ?ref= it was
// linked with, because the global capture runs in an effect AFTER that first render.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useState } from 'react'
import api from '../src/lib/api'

vi.mock('../src/lib/api', () => ({ default: { post: vi.fn(() => Promise.resolve({})) } }))

const KEY = 'passthrough_referral_code'
async function load(search) {
  // jsdom's window.location is what the synchronous read looks at; MemoryRouter's is what the
  // effect looks at. In the real app (BrowserRouter) they are the same URL — keep them equal.
  window.history.replaceState({}, '', '/pricing' + search)
  vi.resetModules()
  return await import('../src/hooks/useReferralCapture')
}
function mount(mod, search) {
  function Page() { const [code] = useState(mod.getStoredReferralCode()); return <div data-testid="code">[{code}]</div> }
  function App() { mod.useReferralCapture(); return <Page /> }
  return render(<MemoryRouter initialEntries={['/pricing' + search]}><App /></MemoryRouter>)
}

describe('landing directly on a page with ?ref=', () => {
  beforeEach(() => { cleanup(); localStorage.clear(); api.post.mockClear() })

  it('the FIRST render already has the code (was: empty until a reload)', async () => {
    const mod = await load('?ref=coach20')
    mount(mod, '?ref=coach20')
    expect(screen.getByTestId('code').textContent).toBe('[COACH20]')
    expect(JSON.parse(localStorage.getItem(KEY)).code).toBe('COACH20')
  })

  it('a DIFFERENT code than the one already stored wins on first render (was: the stale one)', async () => {
    localStorage.setItem(KEY, JSON.stringify({ code: 'OLD10', capturedAt: Date.now() }))
    const mod = await load('?ref=NEW20')
    mount(mod, '?ref=NEW20')
    expect(screen.getByTestId('code').textContent).toBe('[NEW20]')
  })

  it('the click is still logged exactly once even though the read already stored the code', async () => {
    const mod = await load('?ref=COACH20')
    mount(mod, '?ref=COACH20')
    expect(api.post).toHaveBeenCalledTimes(1)
    expect(api.post).toHaveBeenCalledWith('/partners/track-click', { code: 'COACH20' })
  })

  it('a blank ?ref= never clobbers a stored code', async () => {
    localStorage.setItem(KEY, JSON.stringify({ code: 'KEEP10', capturedAt: Date.now() }))
    const mod = await load('?ref=%20')
    mount(mod, '?ref=%20')
    expect(screen.getByTestId('code').textContent).toBe('[KEEP10]')
    expect(api.post).not.toHaveBeenCalled()
  })

  it('a visitor who clears the code while ?ref= is still in the URL is not silently re-opted-in', async () => {
    const mod = await load('?ref=COACH20')
    expect(mod.getStoredReferralCode()).toBe('COACH20')
    mod.setStoredReferralCode('')
    expect(mod.getStoredReferralCode()).toBe('')
  })

  it('no ?ref= at all: reads storage exactly as before', async () => {
    localStorage.setItem(KEY, JSON.stringify({ code: 'SAVED5', capturedAt: Date.now() }))
    const mod = await load('')
    expect(mod.getStoredReferralCode()).toBe('SAVED5')
  })
})
