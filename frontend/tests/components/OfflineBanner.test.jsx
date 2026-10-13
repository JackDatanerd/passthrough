// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import OfflineBanner from '../../src/components/layout/OfflineBanner'

const setOnLine = v => Object.defineProperty(navigator, 'onLine', { value: v, configurable: true })
afterEach(() => setOnLine(true))

describe('OfflineBanner', () => {
  it('renders nothing while online', () => {
    render(<OfflineBanner />)
    expect(screen.queryByRole('status')).toBeNull()
  })
  it('appears when the browser goes offline and disappears when it returns', () => {
    render(<OfflineBanner />)
    act(() => { setOnLine(false); window.dispatchEvent(new Event('offline')) })
    expect(screen.getByRole('status')).toHaveTextContent(/offline/i)
    act(() => { setOnLine(true); window.dispatchEvent(new Event('online')) })
    expect(screen.queryByRole('status')).toBeNull()
  })
  it('shows straight away when the page loads offline', () => {
    setOnLine(false)
    render(<OfflineBanner />)
    expect(screen.getByRole('status')).toBeInTheDocument()
  })
})
