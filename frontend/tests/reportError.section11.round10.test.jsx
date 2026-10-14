// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import ErrorBoundary from '../src/components/ErrorBoundary'
import { reportClientError, installGlobalErrorReporting, resetErrorReporting, shouldReport, classify } from '../src/lib/reportError'

let fetchMock
beforeEach(() => {
  resetErrorReporting()
  fetchMock = vi.fn(() => Promise.resolve({ ok: true }))
  globalThis.fetch = fetchMock
  window.history.replaceState({}, '', '/scan/11111111-1111-4111-8111-111111111111?token=SECRET#frag')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const sent = () => fetchMock.mock.calls.map(([url, init]) => ({ url, init, body: JSON.parse(init.body) }))

describe('reportClientError', () => {
  it('posts one plain, credential-free report: path only (no query / hash), no auth, keepalive', () => {
    const e = new TypeError("Cannot read properties of undefined (reading 'map')")
    expect(reportClientError('render', e, { componentStack: '\n at Foo' })).toBe(true)
    const [{ url, init, body }] = sent()
    expect(url).toBe('/api/client-errors')
    expect(init.method).toBe('POST')
    expect(init.keepalive).toBe(true)
    expect(init.credentials).toBe('omit')
    expect(Object.keys(init.headers)).toEqual(['Content-Type'])
    expect(body).toMatchObject({ kind: 'render', message: e.message, path: '/scan/11111111-1111-4111-8111-111111111111', componentStack: '\n at Foo' })
    expect(JSON.stringify(body)).not.toMatch(/SECRET|frag/)
  })

  it('never reports the same error twice, and stops at five reports per page load', () => {
    const same = new Error('same thing')
    expect(reportClientError('error', same)).toBe(true)
    expect(reportClientError('error', same)).toBe(false)
    for (let i = 0; i < 10; i++) reportClientError('error', new Error(`different ${'x'.repeat(i)}y${'z'.repeat(i)}`))
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('treats a changing number as the same error', () => {
    reportClientError('error', new Error('Item 12 missing')); reportClientError('error', new Error('Item 98 missing'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('stays silent for what is not our bug', () => {
    const cancel = Object.assign(new Error('c'), { code: 'ERR_CANCELED' })
    const axiosFail = Object.assign(new Error('Network Error'), { isAxiosError: true })
    const ext = Object.assign(new Error('injected'), { stack: 'Error: injected\n at chrome-extension://abc/content.js:1:1' })
    expect(shouldReport(cancel)).toBe(false)
    expect(shouldReport(axiosFail)).toBe(false)
    expect(shouldReport(ext)).toBe(false)
    expect(shouldReport(new Error('ResizeObserver loop completed with undelivered notifications.'))).toBe(false)
    expect(shouldReport({ message: 'Script error.' })).toBe(false)
    expect(shouldReport(null)).toBe(false)
    expect(shouldReport(undefined)).toBe(false)
    reportClientError('error', cancel); reportClientError('error', axiosFail); reportClientError('error', ext)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stays silent while the device is offline', () => {
    const spy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    expect(reportClientError('render', new Error('Failed to fetch dynamically imported module: /assets/x.js'))).toBe(false)
    spy.mockRestore()
  })

  it('classifies a lazy chunk that would not load', () => {
    expect(classify(new Error('Failed to fetch dynamically imported module: /assets/Pricing-abc.js'), 'render')).toBe('chunk')
    expect(classify(new Error('Loading chunk 7 failed.'), 'unhandledrejection')).toBe('chunk')
    expect(classify(new Error('boom'), 'render')).toBe('render')
  })

  it('never throws, whatever goes wrong', () => {
    globalThis.fetch = () => { throw new Error('fetch itself exploded') }
    expect(() => reportClientError('render', new Error('a'))).not.toThrow()
    globalThis.fetch = () => Promise.reject(new Error('offline'))
    expect(() => reportClientError('render', new Error('b'))).not.toThrow()
    const circular = {}; circular.self = circular
    expect(() => reportClientError('error', circular, { componentStack: circular })).not.toThrow()
  })
})

describe('what feeds it', () => {
  it('the error boundary reports a render crash once, with the component stack, and still shows its recovery screen', () => {
    function Bomb() { throw new Error('render exploded') }
    render(<ErrorBoundary><Bomb /></ErrorBoundary>)
    expect(screen.getByText('Something went wrong')).toBeTruthy()
    const calls = sent()
    expect(calls).toHaveLength(1)
    expect(calls[0].body.kind).toBe('render')
    expect(calls[0].body.message).toBe('render exploded')
    expect(calls[0].body.componentStack).toMatch(/Bomb/)
  })

  it('window "error" and "unhandledrejection" events are reported, and uninstalling stops it', () => {
    const off = installGlobalErrorReporting()
    window.dispatchEvent(Object.assign(new Event('error'), { error: new Error('uncaught in a handler'), message: 'uncaught in a handler' }))
    const rej = new Event('unhandledrejection'); rej.reason = new Error('nobody caught this')
    window.dispatchEvent(rej)
    expect(sent().map(c => c.body.kind)).toEqual(['error', 'unhandledrejection'])
    off()
    const again = new Event('unhandledrejection'); again.reason = new Error('after uninstall')
    window.dispatchEvent(again)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a non-Error rejection (a string) is reported as text rather than crashing the reporter', () => {
    const off = installGlobalErrorReporting()
    const rej = new Event('unhandledrejection'); rej.reason = 'plain string reason'
    window.dispatchEvent(rej)
    expect(sent()[0].body.message).toBe('plain string reason')
    off()
  })
})
