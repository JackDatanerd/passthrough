// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { createRef } from 'react'
import Modal from '../../src/components/ui/Modal'
import ConfirmDialog from '../../src/components/ui/ConfirmDialog'
import Button from '../../src/components/ui/Button'
import Footer from '../../src/components/layout/Footer'
import TermsUpdateBanner from '../../src/components/layout/TermsUpdateBanner'
import { ToastProvider } from '../../src/components/ui/Toast'
import { AuthContext } from '../../src/context/AuthContext'
import { ReferralCodeEntry } from '../../src/components/ui/ReferralCodeEntry'

afterEach(() => { vi.restoreAllMocks() })

describe('Modal focus trap', () => {
  // A control BEHIND the overlay: without it there is nowhere for escaped focus to go, and the test
  // could not tell a working trap from a broken one.
  const open = () => render(
    <>
      <button>behind the overlay</button>
      <Modal open title="T" onClose={() => {}}>
        <input placeholder="one" /><input placeholder="two" />
      </Modal>
    </>
  )

  // Focus can leave the dialog for <body> (backdrop click while not dismissible, a focused
  // button disabled mid-request). Tab used to walk straight into the page behind the overlay.
  it('Tab from <body> pulls focus back inside the dialog', async () => {
    open()
    const dialog = screen.getByRole('dialog')
    document.activeElement.blur()
    expect(document.body).toHaveFocus()
    await userEvent.setup().tab()
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(screen.getByRole('button', { name: 'behind the overlay' })).not.toHaveFocus()
  })
  it('Shift+Tab from <body> lands on the last element', async () => {
    open()
    document.activeElement.blur()
    await userEvent.setup().tab({ shift: true })
    expect(screen.getByPlaceholderText('two')).toHaveFocus()
  })
  it('a mousedown on the backdrop is cancelled so it cannot blur the dialog to <body>', () => {
    open()
    const backdrop = document.querySelector('.bg-black\\/50')
    expect(fireEvent.mouseDown(backdrop)).toBe(false)   // false = preventDefault() was called
  })
})

describe('ConfirmDialog initial focus', () => {
  it('a destructive confirmation starts on Cancel, not the header X or Confirm', () => {
    render(<ConfirmDialog open message="Delete?" onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
  })
  it('a non-destructive one starts on Confirm', () => {
    render(<ConfirmDialog open danger={false} message="Go?" onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.getByRole('button', { name: 'Confirm' })).toHaveFocus()
  })
})

describe('Button', () => {
  it('forwards a ref to the underlying <button>', () => {
    const ref = createRef()
    render(<Button ref={ref}>Go</Button>)
    expect(ref.current).toBe(screen.getByRole('button', { name: 'Go' }))
  })
})

describe('Footer', () => {
  it('lets its links wrap — seven links in a no-wrap row overflow a phone-width screen', () => {
    render(<MemoryRouter><Footer /></MemoryRouter>)
    expect(screen.getByRole('link', { name: 'Pricing' }).parentElement.className).toMatch(/\bflex-wrap\b/)
  })
})

describe('TermsUpdateBanner does not sit on top of the page', () => {
  const renderBanner = user => render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user, acceptTerms: vi.fn() }}>
        <ToastProvider><TermsUpdateBanner /></ToastProvider>
      </AuthContext.Provider>
    </MemoryRouter>
  )

  it('reserves its own height as body padding and publishes it for the toast stack, then cleans up', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 72 })
    const { unmount } = renderBanner({ termsCurrent: false })
    expect(document.body.style.paddingBottom).toBe('72px')
    expect(document.documentElement.style.getPropertyValue('--bottom-inset')).toBe('72px')
    unmount()
    expect(document.body.style.paddingBottom).toBe('')
    expect(document.documentElement.style.getPropertyValue('--bottom-inset')).toBe('')
  })
  it('reserves nothing when there is no banner', () => {
    renderBanner({ termsCurrent: true })
    expect(document.body.style.paddingBottom).toBe('')
  })
})

describe('Toast stack', () => {
  it('is positioned above the bottom inset so it cannot cover the banner button', () => {
    const { container } = render(<ToastProvider><span /></ToastProvider>)
    const live = container.querySelector('[aria-live]')
    expect(live.getAttribute('style') || '').toMatch(/--bottom-inset/)
  })
})

describe('ReferralCodeEntry', () => {
  const pricing = { referralApplied: true, discountApplied: true }

  it('has an accessible name (it is a placeholder-only field otherwise)', () => {
    render(<ReferralCodeEntry referralCode="" pricing={null} onApply={() => {}} />)
    expect(screen.getByRole('textbox', { name: 'Referral code' })).toBeInTheDocument()
  })
  it('Enter on a blank field does NOT call onApply (it used to silently wipe an applied code)', async () => {
    const onApply = vi.fn()
    render(<ReferralCodeEntry referralCode="" pricing={null} onApply={onApply} />)
    await userEvent.setup().type(screen.getByRole('textbox'), '   {Enter}')
    expect(onApply).not.toHaveBeenCalled()
  })
  it('sends the trimmed code', async () => {
    const onApply = vi.fn()
    render(<ReferralCodeEntry referralCode="" pricing={null} onApply={onApply} />)
    await userEvent.setup().type(screen.getByRole('textbox'), '  COACH20 {Enter}')
    expect(onApply).toHaveBeenCalledWith('COACH20')
  })
  it('clearing is an explicit action: "remove" on an applied code', async () => {
    const onApply = vi.fn()
    render(<ReferralCodeEntry referralCode="COACH20" pricing={pricing} onApply={onApply} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'remove' }))
    expect(onApply).toHaveBeenCalledWith('')
  })
  it('an invalid or self-referral code can be cleared too ("clear it to continue")', async () => {
    const onApply = vi.fn()
    render(<ReferralCodeEntry referralCode="MINE" pricing={{ referralApplied: false, selfReferral: true }} onApply={onApply} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Remove' }))
    expect(onApply).toHaveBeenCalledWith('')
  })
  it('follows the code when the parent changes it (late ?ref= capture, normalised casing)', () => {
    const { rerender } = render(<ReferralCodeEntry referralCode="" pricing={null} onApply={() => {}} />)
    rerender(<ReferralCodeEntry referralCode="LATE1" pricing={{ referralApplied: true }} onApply={() => {}} />)
    expect(screen.getByText('LATE1')).toBeInTheDocument()
  })
})
