// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { previewOf } from '../src/components/ui/ExpandableText'
import { safeNext, isProtectedPath } from '../src/lib/session'
import { humanizeField, getErrorMessage, shouldRetryRequest } from '../src/lib/errors'
import { isPrivatePath } from '../src/lib/pageTitles'
import Modal from '../src/components/ui/Modal'
import { ToastProvider, useToast } from '../src/components/ui/Toast'

afterEach(() => { cleanup(); vi.useRealTimers() })

describe('round 24', () => {
  it('previewOf keeps the last word when the cut lands on a word boundary', () => {
    expect(previewOf('aaaa bbbb cccc', 9).shown).toBe('aaaa bbbb')
    expect(previewOf('aaaa bbbb cccc', 7).shown).toBe('aaaa')
    expect(previewOf('aaaabbbbcccc', 5).shown).toBe('aaaab')
  })

  it('login and protected-path checks ignore case and a hash', () => {
    expect(safeNext('/Login')).toBeNull()
    expect(safeNext('/login#x')).toBeNull()
    expect(safeNext('/dashboard?x=1')).toBe('/dashboard?x=1')
    expect(isProtectedPath('/Dashboard')).toBe(true)
    expect(isProtectedPath('/ADMIN/users')).toBe(true)
    expect(isProtectedPath('/dashboardx')).toBe(false)
    expect(isPrivatePath('/Dashboard')).toBe(true)
  })

  it('humanizeField names the list item for a nested field', () => {
    expect(humanizeField('experience.2.bullets.1.text')).toBe('Text (bullets item 2)')
    expect(humanizeField('items.0.name')).toBe('Name (items item 1)')
    expect(humanizeField('email')).toBe('Email')
    expect(humanizeField('roles.1')).toBe('Roles (item 2)')
  })

  it('a 503 with Retry-After is retried after that wait and explained', () => {
    expect(shouldRetryRequest({ method: 'get', status: 503, hasResponse: true, retryAfterSeconds: 3 })).toEqual({ retry: true, delayMs: 3000 })
    expect(shouldRetryRequest({ method: 'get', status: 503, hasResponse: true, retryAfterSeconds: 120 })).toEqual({ retry: true, delayMs: 800 })
    const err = { isAxiosError: true, response: { status: 503, data: {}, headers: { 'retry-after': '90' } } }
    expect(getErrorMessage(err)).toBe('The service is briefly unavailable. Try again in about 2 minutes.')
  })

  it('an open dialog makes the page behind it inert and restores it', () => {
    const page = document.createElement('div'); page.id = 'page'; document.body.appendChild(page)
    const { rerender } = render(<Modal open onClose={() => {}} title="T"><button>in</button></Modal>)
    expect(page.hasAttribute('inert')).toBe(true)
    rerender(<Modal open={false} onClose={() => {}} title="T"><button>in</button></Modal>)
    expect(page.hasAttribute('inert')).toBe(false)
    page.remove()
  })

  it('keeps the toast stack live while a dialog is open', () => {
    function Open() { return <Modal open onClose={() => {}} title="T"><button>in</button></Modal> }
    const { container } = render(<ToastProvider><main>app</main><Open /></ToastProvider>)
    const stack = document.querySelector('[data-toast-stack]')
    expect(stack.closest('[inert]')).toBeNull()
    expect(container.querySelector('main').hasAttribute('inert')).toBe(true)
  })

  it('a mouseenter that follows a touch does not pause the toasts', () => {
    vi.useFakeTimers()
    let api
    function Grab() { api = useToast(); return null }
    render(<ToastProvider><Grab /></ToastProvider>)
    act(() => { api('hello', 'info') })
    const stack = document.querySelector('[data-toast-stack]')
    fireEvent.touchStart(stack)
    fireEvent.mouseEnter(stack)
    act(() => { vi.advanceTimersByTime(8000) })
    expect(screen.queryByText('hello')).toBeNull()
  })
})
