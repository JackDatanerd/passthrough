// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import OfflineBanner from '../../src/components/layout/OfflineBanner'

const setOnLine = v => Object.defineProperty(navigator, 'onLine', { value: v, configurable: true })
afterEach(() => setOnLine(true))

describe('OfflineBanner', () => {
  it('renders nothing while online', () => {
    render(<OfflineBanner />)
    expect(screen.queryByText(/offline/i)).toBeNull()
  })
  it('appears when the browser goes offline and disappears when it returns', () => {
    render(<OfflineBanner />)
    act(() => { setOnLine(false); window.dispatchEvent(new Event('offline')) })
    expect(screen.getByRole('status')).toHaveTextContent(/offline/i)
    act(() => { setOnLine(true); window.dispatchEvent(new Event('online')) })
    expect(screen.queryByText(/offline/i)).toBeNull()
  })
  it('shows straight away when the page loads offline', () => {
    setOnLine(false)
    render(<OfflineBanner />)
    expect(screen.getByRole('status')).toBeInTheDocument()
  })
  it('keeps ONE live region in the page for good and only swaps its content (an inserted status region is often not announced)', () => {
    const { container } = render(<OfflineBanner />)
    const region = screen.getByRole('status')
    expect(region).toBeEmptyDOMElement()
    act(() => { setOnLine(false); window.dispatchEvent(new Event('offline')) })
    expect(screen.getByRole('status')).toBe(region)
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1)
  })
})
