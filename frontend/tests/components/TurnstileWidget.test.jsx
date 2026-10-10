// @vitest-environment jsdom
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'

// The site key is read at module load (import.meta.env), so each case sets it and
// re-imports the component fresh.
async function load(siteKey) {
  vi.resetModules()
  vi.stubEnv('VITE_TURNSTILE_SITE_KEY', siteKey)
  return import('../../src/components/lead/TurnstileWidget')
}

let turnstile
beforeEach(() => {
  turnstile = { render: vi.fn(() => 'w1'), reset: vi.fn(), remove: vi.fn() }
  window.turnstile = turnstile       // pretend the Cloudflare script has already loaded
})
afterEach(() => { delete window.turnstile; vi.unstubAllEnvs() })

describe('TurnstileWidget', () => {
  it('renders nothing and loads nothing when no site key is configured', async () => {
    const { default: Widget, TURNSTILE_ENABLED } = await load('')
    const { container } = render(<Widget onToken={() => {}} />)
    expect(TURNSTILE_ENABLED).toBe(false)
    expect(container).toBeEmptyDOMElement()
    expect(turnstile.render).not.toHaveBeenCalled()
  })

  it('renders the challenge with the site key and hands tokens (and expiry) to the parent', async () => {
    const { default: Widget, TURNSTILE_ENABLED } = await load('site-123')
    const onToken = vi.fn()
    render(<Widget onToken={onToken} />)
    expect(TURNSTILE_ENABLED).toBe(true)
    expect(screen.getByTestId('turnstile-box')).toBeInTheDocument()
    await waitFor(() => expect(turnstile.render).toHaveBeenCalledTimes(1))
    const opts = turnstile.render.mock.calls[0][1]
    expect(opts.sitekey).toBe('site-123')
    opts.callback('tok-1');  expect(onToken).toHaveBeenLastCalledWith('tok-1')
    opts['expired-callback'](); expect(onToken).toHaveBeenLastCalledWith('')
    opts['error-callback']();   expect(onToken).toHaveBeenLastCalledWith('')
  })

  it('resets the widget and clears the token when the parent bumps resetSignal (tokens are single-use)', async () => {
    const { default: Widget } = await load('site-123')
    const onToken = vi.fn()
    const { rerender } = render(<Widget onToken={onToken} resetSignal={0} />)
    await waitFor(() => expect(turnstile.render).toHaveBeenCalled())
    await act(async () => { rerender(<Widget onToken={onToken} resetSignal={1} />) })
    expect(turnstile.reset).toHaveBeenCalledWith('w1')
    expect(onToken).toHaveBeenLastCalledWith('')
  })

  it('removes the widget on unmount', async () => {
    const { default: Widget } = await load('site-123')
    const { unmount } = render(<Widget onToken={() => {}} />)
    await waitFor(() => expect(turnstile.render).toHaveBeenCalled())
    unmount()
    expect(turnstile.remove).toHaveBeenCalledWith('w1')
  })

  it('tells the person when the Cloudflare script cannot load, and lets them try again', async () => {
    delete window.turnstile
    const { default: Widget } = await load('site-123')
    const onToken = vi.fn()
    // First load attempt fails (script blocked); the retry succeeds.
    let attempts = 0
    const spy = vi.spyOn(document.head, 'appendChild').mockImplementation(el => {
      attempts += 1
      if (attempts === 1) setTimeout(() => el.onerror && el.onerror(), 0)
      else { window.turnstile = turnstile; setTimeout(() => el.onload && el.onload(), 0) }
      return el
    })
    render(<Widget onToken={onToken} />)
    expect((await screen.findByRole('alert')).textContent).toMatch(/couldn't load/i)
    expect(onToken).toHaveBeenLastCalledWith('')
    await userEvent.setup().click(screen.getByRole('button', { name: /try again/i }))
    await waitFor(() => expect(turnstile.render).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alert')).toBeNull()
    spy.mockRestore()
  })
})
