// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useEffect, useState } from 'react'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider, Outlet, useLocation, Link } from 'react-router-dom'
import RouteAnnouncer from '../src/components/layout/RouteAnnouncer'
import useScrollToHash from '../src/hooks/useScrollToHash'

function Shell() {
  const { pathname } = useLocation()
  useEffect(() => { document.title = `Title for ${pathname}` }, [pathname])
  return <><RouteAnnouncer /><Outlet /></>
}
const Page = ({ name }) => <main><h1>{name}</h1><a href="#x">in main</a></main>
const announcer = () => document.querySelector('[data-route-announcer]')

function mount(extraRoutes = []) {
  const router = createMemoryRouter([{
    element: <Shell />,
    children: [
      { path: '/', element: <Page name="Home" /> },
      { path: '/pricing', element: <Page name="Pricing" /> },
      { path: '/scan/:id', element: <Page name="Scan" /> },
      { path: '/login', element: <main><input aria-label="email" autoFocus /></main> },
      ...extraRoutes,
    ],
  }], { initialEntries: ['/'] })
  render(<RouterProvider router={router} />)
  return router
}
const go = async (router, to) => { await act(async () => { await router.navigate(to) }); await act(async () => { await new Promise(r => setTimeout(r, 30)) }) }

beforeEach(() => { document.title = 'start' })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('RouteAnnouncer', () => {
  it('does nothing on the first load', async () => {
    mount()
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
    expect(announcer().textContent).toBe('')
    expect(document.activeElement).toBe(document.body)
  })

  it('after a change of path: focus moves to <main>, and the new title is announced', async () => {
    const router = mount()
    await go(router, '/pricing')
    expect(document.activeElement).toBe(document.querySelector('main'))
    expect(document.querySelector('main').getAttribute('tabindex')).toBe('-1')
    expect(announcer().textContent.trim()).toBe('Title for /pricing')
  })

  it('announces again when two pages in a row share a title', async () => {
    const router = mount([])
    await go(router, '/scan/a')
    const first = announcer().textContent
    await go(router, '/scan/b')
    expect(announcer().textContent.trim()).toBe('Title for /scan/b')
    expect(announcer().textContent).not.toBe(first)
  })

  it('leaves a same-page change (query string only) alone', async () => {
    const router = mount()
    await go(router, '/pricing')
    const before = announcer().textContent
    document.activeElement.blur?.()
    await go(router, '/pricing?x=1')
    expect(announcer().textContent).toBe(before)
    expect(document.activeElement).toBe(document.body)
  })

  it('does not take focus when the navigation carries a #hash (useScrollToHash owns that)', async () => {
    const router = mount()
    await go(router, '/pricing#plans')
    expect(document.activeElement).toBe(document.body)
    expect(announcer().textContent.trim()).toBe('Title for /pricing')   // still announced
  })

  it('respects a field the page focused itself (autoFocus)', async () => {
    const router = mount()
    await go(router, '/login')
    expect(document.activeElement).toBe(screen.getByLabelText('email'))
  })

  it('does not pull focus out of an open dialog', async () => {
    const router = mount()
    const d = document.createElement('div'); d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true'); document.body.appendChild(d)
    await go(router, '/pricing')
    expect(document.activeElement).toBe(document.body)
    d.remove()
  })

  it('waits for a lazily loaded page: <main> appears later, focus follows, and the title is the NEW page\'s', async () => {
    function Lazy() {
      const [ready, setReady] = useState(false)
      useEffect(() => { const t = setTimeout(() => { document.title = 'Lazy page loaded'; setReady(true) }, 250); return () => clearTimeout(t) }, [])
      return ready ? <main><h1>Lazy</h1></main> : <p>loading…</p>
    }
    const router = mount([{ path: '/lazy', element: <Lazy /> }])
    await act(async () => { await router.navigate('/lazy') })
    expect(document.querySelector('main')).toBeNull()
    // Not inside act(): React holds state updates made within an act scope until it ends, so the page would never "load".
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector('main')), { timeout: 2000 })
    await waitFor(() => expect(announcer().textContent.trim()).toBe('Lazy page loaded'))
  })

  it('a second navigation before the first page is ready cancels the first one\'s wait', async () => {
    const router = mount([{ path: '/never', element: <p>no main here</p> }])
    await act(async () => { await router.navigate('/never') })
    await go(router, '/pricing')
    expect(document.activeElement).toBe(document.querySelector('main'))
    expect(announcer().textContent.trim()).toBe('Title for /pricing')
  })
})

describe('useScrollToHash now also moves focus to the anchor target', () => {
  it('focuses the fragment target (tabindex added), like a browser does', async () => {
    function Page() {
      useScrollToHash()
      return <main><section id="employers">Employers</section><a href="/">x</a></main>
    }
    Element.prototype.scrollIntoView = vi.fn()
    const router = createMemoryRouter([{ path: '/', element: <Page /> }], { initialEntries: ['/#employers'] })
    render(<RouterProvider router={router} />)
    await act(async () => { await new Promise(r => setTimeout(r, 60)) })
    const el = document.getElementById('employers')
    expect(el.getAttribute('tabindex')).toBe('-1')
    expect(document.activeElement).toBe(el)
  })
})
