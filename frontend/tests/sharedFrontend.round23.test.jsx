// @vitest-environment jsdom
// Shared frontend round 23: the long-timeout list covers every route that does AI / PDF work inside the request,
// a numeric 0 never draws an empty notice, and the navbar's Stories list survives a click that lands on a link.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// The scan controllers that run a Claude call or a PDF render INSIDE the request (the others queue their work).
// Adding a route here without giving it the long timeout in lib/api.js fails below.
const IN_REQUEST_HEAVY = ['structureResume', 'generateCoverLetter', 'regeneratePdf', 'updateResumeData', 'updateDeliveredResume',
  'downloadDraftPdf', 'downloadCoverLetterPdf', 'rescoreAi']

describe('long timeouts', () => {
  beforeEach(() => { vi.resetModules(); localStorage.clear() })
  const timeoutFor = async (method, url) => {
    const { default: api } = await import('../src/lib/api.js')
    let t
    await api.request({ method, url, adapter: async cfg => { t = cfg.timeout; return { data: {}, status: 200, statusText: 'OK', headers: {}, config: cfg } } })
    return t
  }

  it('every in-request heavy scan route gets the long timeout (read from scan.routes.js)', async () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/routes/scan.routes.js'), 'utf8')
    const found = []
    for (const m of src.matchAll(/router\.(get|post|patch|put)\(\s*'([^']+)'[^\n]*\bc\.(\w+)\)/g)) {
      if (IN_REQUEST_HEAVY.includes(m[3])) found.push([m[1], '/scan' + m[2].replace(':id', 'abc')])
    }
    expect(found.length).toBe(IN_REQUEST_HEAVY.length)
    for (const [method, url] of found) expect([method, url, await timeoutFor(method, url)]).toEqual([method, url, 190_000])
  })

  it('rescore-ai keeps the long timeout with an anonymous ?token= query', async () => {
    expect(await timeoutFor('post', '/scan/abc/rescore-ai?token=x')).toBe(190_000)
  })

  it('routes that queue their work keep the ordinary timeout', async () => {
    expect(await timeoutFor('post', '/scan/abc/retry-scan')).toBe(30_000)
    expect(await timeoutFor('post', '/scan/abc/retry-fix')).toBe(30_000)
  })
})

describe('empty notices', () => {
  it('Alert holding only 0 draws nothing; real text still shows', async () => {
    const { default: Alert } = await import('../src/components/ui/Alert.jsx')
    const { container, rerender } = render(<Alert>{0}</Alert>)
    expect(container).toBeEmptyDOMElement()
    rerender(<Alert>Bad thing</Alert>)
    expect(screen.getByRole('alert')).toHaveTextContent('Bad thing')
  })
  it('FieldError with 0 renders nothing', async () => {
    const { default: FieldError } = await import('../src/components/ui/FieldError.jsx')
    const { container } = render(<FieldError>{0}</FieldError>)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('Navbar Stories list', () => {
  const renderNav = async () => {
    const { default: Navbar } = await import('../src/components/layout/Navbar.jsx')
    const { AuthContext } = await import('../src/context/AuthContext')
    return render(
      <MemoryRouter><AuthContext.Provider value={{ user: null, logout: () => {} }}><Navbar /></AuthContext.Provider></MemoryRouter>
    )
  }
  it('stays open when focus leaves to nothing (Safari does not focus a clicked link), closes on Tab to another element', async () => {
    await renderNav()
    const btn = screen.getByRole('button', { name: /stories/i })
    fireEvent.click(btn)
    expect(screen.getByText('Applicant stories')).toBeInTheDocument()
    fireEvent.blur(btn, { relatedTarget: null })
    expect(screen.getByText('Applicant stories')).toBeInTheDocument()
    fireEvent.blur(btn, { relatedTarget: screen.getByText('Pricing') })
    expect(screen.queryByText('Applicant stories')).toBeNull()
  })
})
