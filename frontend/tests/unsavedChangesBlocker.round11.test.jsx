// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { createMemoryRouter, RouterProvider, Link, MemoryRouter } from 'react-router-dom'
import { useUnsavedChangesWarning } from '../src/hooks/useUnsavedChangesWarning'

function Editor({ dirty }) {
  useUnsavedChangesWarning(dirty)
  return <div>editor<Link to="/other">go</Link><Link to="/edit?x=1">same page</Link></div>
}
const mount = (dirty) => {
  const router = createMemoryRouter([
    { path: '/edit', element: <Editor dirty={dirty} /> },
    { path: '/other', element: <div>other page</div> },
  ], { initialEntries: ['/edit'] })
  render(<RouterProvider router={router} />)
  return router
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('useUnsavedChangesWarning blocks in-app navigation while dirty', () => {
  it('stays on the page when the person cancels the confirm', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const router = mount(true)
    fireEvent.click(screen.getByText('go'))
    await Promise.resolve()
    expect(window.confirm).toHaveBeenCalledTimes(1)
    expect(router.state.location.pathname).toBe('/edit')
  })
  it('leaves when the person confirms', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const router = mount(true)
    fireEvent.click(screen.getByText('go'))
    await screen.findByText('other page')
    expect(router.state.location.pathname).toBe('/other')
  })
  it('never prompts when the draft is clean, or for same-page query changes', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    mount(false); fireEvent.click(screen.getByText('go')); await screen.findByText('other page')
    cleanup()
    const router = mount(true)
    fireEvent.click(screen.getByText('same page')); await Promise.resolve()
    expect(router.state.location.search).toBe('?x=1')
    expect(confirm).not.toHaveBeenCalled()
  })
  it('still works (beforeunload only) outside a data router', () => {
    render(<MemoryRouter><Editor dirty /></MemoryRouter>)
    const ev = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
  })
})

import { Routes, Route } from 'react-router-dom'
describe('the App.jsx shape: one splat route wrapping <Routes>', () => {
  it('descendant routes still match and the blocker still guards them', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const Shell = () => (
      <Routes>
        <Route path="/dashboard/settings" element={<Editor dirty />} />
        <Route path="/other" element={<div>other page</div>} />
        <Route path="*" element={<div>not found</div>} />
      </Routes>
    )
    const router = createMemoryRouter([{ path: '*', element: <Shell /> }], { initialEntries: ['/dashboard/settings'] })
    render(<RouterProvider router={router} />)
    expect(screen.getByText('editor')).toBeTruthy()
    fireEvent.click(screen.getByText('go')); await Promise.resolve()
    expect(window.confirm).toHaveBeenCalled()
    expect(router.state.location.pathname).toBe('/dashboard/settings')
  })
})
