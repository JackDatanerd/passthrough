// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useState } from 'react'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { AuthContext } from '../src/context/AuthContext'
import Navbar from '../src/components/layout/Navbar'
import DashboardLayout from '../src/components/layout/DashboardLayout'
import Modal from '../src/components/ui/Modal'
import { useUnsavedChangesWarning } from '../src/hooks/useUnsavedChangesWarning'
import { allowNextLeave, confirmDiscardUnsaved, resetLeaveGuard, SIGN_OUT_MESSAGE } from '../src/lib/unsavedGuard'
import { getToken, setToken } from '../src/lib/storage'

vi.mock('../src/lib/needsDecision', () => ({ useNeedsDecisionCount: () => 0, loadNeedsDecision: () => {} }))

function Editor({ dirty = true }) {
  useUnsavedChangesWarning(dirty)
  return <p>editor</p>
}

// logout() as AuthProvider does it: the token is gone the moment it is called.
function auth(onLogout) {
  return { user: { id: 'u1', email: 'a@b.c', role: 'USER' }, logout: () => { onLogout(); setToken(null); return Promise.resolve() } }
}

const pages = [
  ['Navbar', dirty => <><Navbar /><Editor dirty={dirty} /></>],
  ['DashboardLayout', dirty => <DashboardLayout><Editor dirty={dirty} /></DashboardLayout>],
]

beforeEach(() => { localStorage.clear(); setToken('tok'); resetLeaveGuard() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function mount(Page, dirty, onLogout) {
  const router = createMemoryRouter(
    [{ path: '/dashboard/settings', element: Page(dirty) }, { path: '/', element: <p>home</p> }],
    { initialEntries: ['/dashboard/settings'] },
  )
  render(<AuthContext.Provider value={auth(onLogout)}><RouterProvider router={router} /></AuthContext.Provider>)
  return router
}

describe.each(pages)('sign out with unsaved work — %s', (_n, Page) => {
  it('"Stay" leaves the person signed in, on the page, with the draft keys untouched', async () => {
    const logout = vi.fn()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const router = mount(Page, true, logout)
    await userEvent.click(screen.getAllByRole('button', { name: 'Sign out' })[0])
    expect(confirm).toHaveBeenCalledWith(SIGN_OUT_MESSAGE)
    expect(logout).not.toHaveBeenCalled()
    expect(getToken()).toBe('tok')
    expect(router.state.location.pathname).toBe('/dashboard/settings')
  })

  it('"Leave" signs out and goes home after exactly ONE prompt', async () => {
    const logout = vi.fn()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const router = mount(Page, true, logout)
    await userEvent.click(screen.getAllByRole('button', { name: 'Sign out' })[0])
    await screen.findByText('home')
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(logout).toHaveBeenCalledTimes(1)
    expect(router.state.location.pathname).toBe('/')
  })

  it('a clean page signs out without any prompt', async () => {
    const logout = vi.fn()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    mount(Page, false, logout)
    await userEvent.click(screen.getAllByRole('button', { name: 'Sign out' })[0])
    await screen.findByText('home')
    expect(confirm).not.toHaveBeenCalled()
    expect(logout).toHaveBeenCalledTimes(1)
  })
})

describe('the route blocker and an answered question', () => {
  function Go() {
    const [n, setN] = useState(0)
    return <button onClick={() => setN(n + 1)}>{`n${n}`}</button>
  }
  it('allowNextLeave() lets the very next navigation through without asking (account deletion)', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const router = createMemoryRouter(
      [{ path: '/dashboard/settings', element: <Editor /> }, { path: '/', element: <p>home</p> }],
      { initialEntries: ['/dashboard/settings'] })
    render(<RouterProvider router={router} />)
    allowNextLeave()
    await router.navigate('/')
    expect(confirm).not.toHaveBeenCalled()
    expect(router.state.location.pathname).toBe('/')
  })

  it('the allowance expires: a later navigation is guarded again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
      const router = createMemoryRouter(
        [{ path: '/dashboard/settings', element: <Editor /> }, { path: '/', element: <p>home</p> }],
        { initialEntries: ['/dashboard/settings'] })
      render(<RouterProvider router={router} />)
      allowNextLeave()
      vi.setSystemTime(Date.now() + 5000)
      await act(async () => { router.navigate('/') })
      expect(confirm).toHaveBeenCalledTimes(1)
      expect(router.state.location.pathname).toBe('/dashboard/settings')
    } finally { vi.useRealTimers() }
  })

  it('confirmDiscardUnsaved() asks nothing when nothing is unsaved', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    expect(confirmDiscardUnsaved()).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })
})

describe('Modal: a dialog mounted inside another one in the SAME render is the one that answers Escape and holds focus', () => {
  it('Escape closes the inner dialog only, and focus starts in it', async () => {
    function Both() {
      const [outer, setOuter] = useState(true)
      const [inner, setInner] = useState(true)
      return (
        <Modal open={outer} onClose={() => setOuter(false)} title="Outer">
          <input aria-label="outer-field" />
          <Modal open={inner} onClose={() => setInner(false)} title="Inner">
            <input aria-label="inner-field" />
          </Modal>
        </Modal>
      )
    }
    render(<Both />)
    expect(document.activeElement).toBe(screen.getByLabelText('inner-field'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByLabelText('inner-field')).toBeNull()
    expect(screen.queryByLabelText('outer-field')).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByLabelText('outer-field')).toBeNull()
    expect(document.body.style.overflow).toBe('')
  })
})
