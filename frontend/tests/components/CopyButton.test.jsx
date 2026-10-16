// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import CopyButton from '../../src/components/ui/CopyButton'

const live = () => document.querySelector('[data-announcer]')

describe('CopyButton', () => {
  afterEach(() => { vi.useRealTimers(); delete navigator.clipboard })

  it('copies the text, shows the copied label, then reverts', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<CopyButton text="https://x.test/v/ABC" label="Copy link" resetMs={500} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy())
    expect(writeText).toHaveBeenCalledWith('https://x.test/v/ABC')
    await act(async () => { vi.advanceTimersByTime(600) })
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy()
  })

  it('evaluates a function value at click time', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    let v = 'one'
    render(<CopyButton text={() => v} label="Copy" />)
    v = 'two'
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('two'))
  })

  it('reports a refused clipboard write instead of claiming "Copied"', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(() => Promise.reject(new Error('denied'))) }, configurable: true })
    document.execCommand = vi.fn(() => false)
    render(<CopyButton text="x" label="Copy" failedLabel="Copy failed" />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy failed' })).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull()
  })

  it('announces the outcome through one shared live region, success and failure', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(() => Promise.resolve()) }, configurable: true })
    render(<><CopyButton text="a" label="A" /><CopyButton text="b" label="B" /></>)
    fireEvent.click(screen.getByRole('button', { name: 'A' }))
    await waitFor(() => expect(live()?.textContent).toMatch(/copied to the clipboard/i))
    fireEvent.click(screen.getByRole('button', { name: 'B' }))
    await waitFor(() => expect(live()?.textContent).toMatch(/copied to the clipboard/i))
    expect(document.querySelectorAll('[data-announcer]').length).toBe(1)
    // it is a live region but not role=status, so it never collides with a page's own status message
    expect(live().getAttribute('aria-live')).toBe('polite')
    expect(live().getAttribute('role')).toBeNull()
  })

  it('announces a failure', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(() => Promise.reject(new Error('no'))) }, configurable: true })
    document.execCommand = vi.fn(() => false)
    render(<CopyButton text="x" />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(live()?.textContent).toMatch(/could not copy/i))
  })

  it('link variant renders a bare button with the caller\'s classes, and passes aria-label through', () => {
    render(<CopyButton variant="link" className="x-link" text="t" label="Copy" aria-label="Copy PDF fingerprint" />)
    const b = screen.getByRole('button', { name: 'Copy PDF fingerprint' })
    expect(b.className).toBe('x-link')
    expect(b.getAttribute('type')).toBe('button')
  })

  it('runs onCopied only on success', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(() => Promise.resolve()) }, configurable: true })
    const onCopied = vi.fn()
    render(<CopyButton text="t" onCopied={onCopied} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(onCopied).toHaveBeenCalledTimes(1))
  })
})
