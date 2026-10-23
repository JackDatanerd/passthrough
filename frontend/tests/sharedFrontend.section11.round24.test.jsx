// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act, renderHook, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Modal from '../src/components/ui/Modal'
import Button from '../src/components/ui/Button'
import OfflineBanner from '../src/components/layout/OfflineBanner'
import RouteAnnouncer from '../src/components/layout/RouteAnnouncer'
import SkipLink from '../src/components/layout/SkipLink'
import { ToastProvider } from '../src/components/ui/Toast'
import { useApi } from '../src/hooks/useApi'
import { useUnsavedChangesWarning } from '../src/hooks/useUnsavedChangesWarning'
import { allowNextLeave, resetLeaveGuard } from '../src/lib/unsavedGuard'
import { filenameFromDisposition, dateStamp, csvCell } from '../src/lib/utils'

afterEach(() => resetLeaveGuard())

describe('B1: live regions stay live while a dialog is open', () => {
  it('route announcer and offline banner are not made inert', () => {
    const Shell = ({ open }) => (
      <MemoryRouter><ToastProvider>
        <RouteAnnouncer /><OfflineBanner /><main><button>app</button></main>
        <Modal open={open} onClose={() => {}} title="T"><button>in</button></Modal>
      </ToastProvider></MemoryRouter>
    )
    const { rerender } = render(<Shell open={false} />)
    rerender(<Shell open />)
    expect(document.querySelector('[data-route-announcer]').hasAttribute('inert')).toBe(false)
    expect(document.querySelector('[data-live-region]:not([data-route-announcer])').hasAttribute('inert')).toBe(false)
    expect(document.querySelector('main').hasAttribute('inert')).toBe(true)
  })
})

describe('B2: an agreed discard does not trigger the browser prompt', () => {
  function Dirty() { useUnsavedChangesWarning(true); return null }
  it('beforeunload is not cancelled inside the allowed window', () => {
    render(<Dirty />)
    const ev = () => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented }
    expect(ev()).toBe(true)
    allowNextLeave()
    expect(ev()).toBe(false)
  })
})

describe('B3: Button pending keeps focus and swallows clicks', () => {
  it('is focusable, aria-disabled, no spinner, click ignored', () => {
    const onClick = vi.fn()
    render(<Button pending onClick={onClick}>Go</Button>)
    const b = screen.getByRole('button', { name: 'Go' })
    expect(b).not.toBeDisabled()
    expect(b).toHaveAttribute('aria-disabled', 'true')
    expect(b.querySelector('svg')).toBeNull()
    b.focus(); fireEvent.click(b)
    expect(document.activeElement).toBe(b)
    expect(onClick).not.toHaveBeenCalled()
  })
})

describe('B4: utils edge cases', () => {
  it('download names', () => {
    const h = v => ({ get: () => v })
    expect(filenameFromDisposition(h("attachment; filename*=UTF-8''a%0Ab.pdf"), 'x')).toBe('x')
    expect(filenameFromDisposition(h('attachment; filename=..'), 'x')).toBe('x')
    expect(filenameFromDisposition(h('attachment; filename="ok name.pdf"'), 'x')).toBe('ok name.pdf')
  })
  it('dateStamp(null) is empty, omitted is today', () => {
    expect(dateStamp(null)).toBe('')
    expect(dateStamp()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
  it('a lone dash is not quoted, a dash-led sentence still is', () => {
    expect(csvCell('-')).toBe('-')
    expect(csvCell('- item')).toBe("'- item")
  })
})

describe('G2: useApi.fail', () => {
  it('shows a message without a request or a loading flicker', () => {
    const { result } = renderHook(() => useApi())
    act(() => result.current.fail('Enter a valid amount.'))
    expect(result.current.error).toBe('Enter a valid amount.')
    expect(result.current.loading).toBe(false)
  })
})

describe('G4: shared skip link', () => {
  it('moves focus into <main>', () => {
    render(<><SkipLink /><main id="main">x</main></>)
    fireEvent.click(screen.getByText('Skip to content'))
    expect(document.activeElement).toBe(document.querySelector('main'))
  })
})
