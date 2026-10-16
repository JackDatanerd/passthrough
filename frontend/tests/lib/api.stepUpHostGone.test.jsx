// @vitest-environment jsdom
// B1 (shared frontend): the step-up prompt's host going away must not strand every later admin action.
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { AxiosError } from 'axios'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const hasElevation = c => !!(c.headers?.get ? c.headers.get('X-Admin-Elevation') : c.headers?.['X-Admin-Elevation'])

function adapter(calls = []) {
  return async config => {
    calls.push(config.url)
    if (config.url.includes('elevate')) return { data: { data: { elevationToken: 'tok', expiresInSeconds: 600 } }, status: 200, statusText: 'OK', headers: {}, config }
    if (!hasElevation(config)) {
      const res = { status: 403, statusText: 'Forbidden', data: { code: 'ADMIN_STEP_UP_REQUIRED' }, headers: {}, config }
      throw new AxiosError('403', 'ERR_BAD_REQUEST', config, null, res)
    }
    return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config }
  }
}
// The adapter is the axios DEFAULT: the /admin/elevate call api.js makes itself is a fresh request, so a per-request adapter
// would not reach it.
async function load(ad = adapter()) {
  vi.resetModules()
  localStorage.setItem('passthrough_token', 'a.b.c')
  const mod = await import('../../src/lib/api')
  mod.default.defaults.adapter = ad
  return mod
}

describe('step-up prompt whose host unmounts', () => {
  it('the request waiting on an open prompt is released as cancelled (not left hanging)', async () => {
    const mod = await load()
    mod.setStepUpPrompt(() => new Promise(() => {}))                // a dialog that is never answered
    const first = mod.default.post('/admin/refund', {}).then(() => 'ok', e => e.response?.data?.code)
    await sleep(20)
    mod.setStepUpPrompt(null)                                        // the layout unmounted
    expect(await Promise.race([first, sleep(500).then(() => 'HUNG')])).toBe('ADMIN_STEP_UP_REQUIRED')
  })

  it('a later step-up prompts the NEW host and succeeds', async () => {
    const mod = await load()
    mod.setStepUpPrompt(() => new Promise(() => {}))
    mod.default.post('/admin/refund', {}).catch(() => {})
    await sleep(20)
    mod.setStepUpPrompt(null)
    mod.setStepUpPrompt(async () => 'password')
    const second = mod.default.post('/admin/refund2', {}).then(() => 'ok', () => 'err')
    expect(await Promise.race([second, sleep(1500).then(() => 'HUNG')])).toBe('ok')
  })

  it('swapping to another host mid-prompt also releases the stale one', async () => {
    const mod = await load()
    mod.setStepUpPrompt(() => new Promise(() => {}))
    const first = mod.default.post('/admin/a', {}).then(() => 'ok', () => 'cancelled')
    await sleep(20)
    mod.setStepUpPrompt(async () => 'pw')
    expect(await Promise.race([first, sleep(500).then(() => 'HUNG')])).toBe('cancelled')
  })

  it('re-registering the SAME prompt function does not cancel an open prompt', async () => {
    const mod = await load()
    let answer
    const prompt = () => new Promise(r => { answer = r })
    mod.setStepUpPrompt(prompt)
    const req = mod.default.post('/admin/a', {}).then(() => 'ok', () => 'err')
    await sleep(20)
    mod.setStepUpPrompt(prompt)
    answer('pw')
    expect(await Promise.race([req, sleep(1500).then(() => 'HUNG')])).toBe('ok')
  })

  it('a wrong password then the host going away stops asking instead of throwing', async () => {
    let mod
    let n = 0
    const ad = async config => {
      if (config.url.includes('elevate')) {
        mod.setStepUpPrompt(null)                                    // host unmounts while the password is being checked
        const res = { status: 401, statusText: 'x', data: { code: 'PASSWORD_INCORRECT' }, headers: {}, config }
        throw new AxiosError('401', 'ERR_BAD_REQUEST', config, null, res)
      }
      const res = { status: 403, statusText: 'Forbidden', data: { code: 'ADMIN_STEP_UP_REQUIRED' }, headers: {}, config }
      throw new AxiosError('403', 'ERR_BAD_REQUEST', config, null, res)
    }
    mod = await load(ad)
    mod.setStepUpPrompt(async () => { n++; return 'bad' })
    const out = await mod.default.post('/admin/a', {}).then(() => 'ok', e => e.response?.data?.code || e.message)
    expect(out).toBe('ADMIN_STEP_UP_REQUIRED')
    expect(n).toBe(1)
  })
})

describe('AdminLayout StepUpModal unmount', () => {
  it('unmounting the layout with the password dialog open releases the waiting request', async () => {
    vi.resetModules()
    localStorage.setItem('passthrough_token', 'a.b.c')
    const api = await import('../../src/lib/api')
    api.default.defaults.adapter = adapter()
    const { MemoryRouter } = await import('react-router-dom')
    const { default: AdminLayout } = await import('../../src/pages/admin/AdminLayout')
    const spy = vi.spyOn(api.default, 'get').mockResolvedValue({ data: { data: null } })
    const { unmount } = render(<MemoryRouter><AdminLayout /></MemoryRouter>)
    const req = api.default.post('/admin/refund', {}).then(() => 'ok', () => 'released')
    await screen.findByRole('dialog')
    unmount()
    expect(await Promise.race([req, sleep(800).then(() => 'HUNG')])).toBe('released')
    spy.mockRestore()
  })
})
