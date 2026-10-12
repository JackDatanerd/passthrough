// @vitest-environment jsdom
// Section 11, round 7 — step-up scope (B1/H1) and wrong-password feedback (B2).
import React from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import api, { setStepUpPrompt, clearStepUp, isStepUpUrl } from '../src/lib/api'
import { setToken } from '../src/lib/storage'
import AdminLayout from '../src/pages/admin/AdminLayout'

const res = (cfg, data = { ok: true }) => Promise.resolve({ data, status: 200, statusText: 'OK', headers: {}, config: cfg })
const stepUp403 = cfg => Promise.reject(Object.assign(new Error('403'), { isAxiosError: true, config: cfg, response: { status: 403, data: { code: 'ADMIN_STEP_UP_REQUIRED' }, headers: {}, config: cfg } }))
const wrongPw = cfg => Promise.reject(Object.assign(new Error('403'), { isAxiosError: true, config: cfg, response: { status: 403, data: { code: 'PASSWORD_INCORRECT' }, headers: {}, config: cfg } }))

afterEach(() => { setStepUpPrompt(null); clearStepUp(); delete api.defaults.adapter })

describe('isStepUpUrl', () => {
  it('matches the gated prefixes only', () => {
    for (const u of ['/admin/users/1', '/partners/abc/links', '/payments/ref/refund', '/partners', '/admin?x=1'])
      expect(isStepUpUrl(u)).toBe(true)
    for (const u of ['/scan', '/auth/logout', '/administrator', '/partnersx', '/pricing', '', undefined])
      expect(isStepUpUrl(u)).toBe(false)
  })
})

describe('B1: a step-up-gated GET can succeed', () => {
  it('GET /partners/:id/links is replayed WITH the elevation after the password is accepted', async () => {
    setToken('a.b.c')
    const seen = []
    api.defaults.adapter = cfg => {
      seen.push([cfg.method, cfg.url, cfg.headers['X-Admin-Elevation'] || null])
      if (cfg.url === '/admin/elevate') return res(cfg, { data: { elevationToken: 'ELEV', expiresInSeconds: 600 } })
      return cfg.headers['X-Admin-Elevation'] ? res(cfg) : stepUp403(cfg)
    }
    setStepUpPrompt(() => Promise.resolve('pw'))
    const r = await api.get('/partners/1/links')
    expect(r.data.ok).toBe(true)
    expect(seen.filter(x => x[1] === '/partners/1/links').map(x => x[2])).toEqual([null, 'ELEV'])
  })
  it('once elevated, later gated GETs carry it at once (no second prompt)', async () => {
    setToken('a.b.c')
    let prompts = 0
    api.defaults.adapter = cfg => {
      if (cfg.url === '/admin/elevate') return res(cfg, { data: { elevationToken: 'ELEV', expiresInSeconds: 600 } })
      return cfg.headers['X-Admin-Elevation'] ? res(cfg) : stepUp403(cfg)
    }
    setStepUpPrompt(() => { prompts++; return Promise.resolve('pw') })
    await api.get('/partners/1/links')
    await api.get('/partners/2/links')
    expect(prompts).toBe(1)
  })
})

describe('H1: the elevation does not ride on unrelated requests', () => {
  it('a POST outside the gated prefixes carries no elevation even while one is live', async () => {
    setToken('a.b.c')
    const seen = []
    api.defaults.adapter = cfg => {
      seen.push([cfg.url, cfg.headers['X-Admin-Elevation'] || null])
      if (cfg.url === '/admin/elevate') return res(cfg, { data: { elevationToken: 'ELEV', expiresInSeconds: 600 } })
      return cfg.headers['X-Admin-Elevation'] ? res(cfg) : (cfg.url.startsWith('/partners') ? stepUp403(cfg) : res(cfg))
    }
    setStepUpPrompt(() => Promise.resolve('pw'))
    await api.get('/partners/1/links')          // elevates
    await api.post('/scan', {}); await api.post('/auth/logout', {})
    expect(seen.filter(x => x[0] === '/scan' || x[0] === '/auth/logout').map(x => x[1])).toEqual([null, null])
  })
  it('a gated route OUTSIDE the known prefixes still works: the replay carries the elevation', async () => {
    setToken('a.b.c')
    api.defaults.adapter = cfg => {
      if (cfg.url === '/admin/elevate') return res(cfg, { data: { elevationToken: 'ELEV', expiresInSeconds: 600 } })
      return cfg.headers['X-Admin-Elevation'] ? res(cfg) : stepUp403(cfg)
    }
    setStepUpPrompt(() => Promise.resolve('pw'))
    await expect(api.post('/somewhere/new', {})).resolves.toBeTruthy()
  })
})

describe('B2: a wrong step-up password says so', () => {
  it('re-asks with { incorrect: true } and the modal shows the message; a right password then succeeds', async () => {
    setToken('a.b.c')
    const user = userEvent.setup()
    let elevateCalls = 0
    api.defaults.adapter = cfg => {
      if (cfg.url === '/admin/elevate') {
        elevateCalls++
        return cfg.data && JSON.parse(cfg.data).password === 'right' ? res(cfg, { data: { elevationToken: 'ELEV', expiresInSeconds: 600 } }) : wrongPw(cfg)
      }
      return cfg.headers['X-Admin-Elevation'] ? res(cfg) : stepUp403(cfg)
    }
    render(<MemoryRouter><AdminLayout /></MemoryRouter>)
    let done
    act(() => { done = api.post('/payments/ref/refund', {}) })
    const pw1 = await screen.findByLabelText('Password')
    expect(screen.queryByText(/not correct/i)).toBeNull()
    await user.type(pw1, 'wrong'); await user.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(await screen.findByText(/That password is not correct/)).toBeTruthy()
    await user.type(screen.getByLabelText('Password'), 'right'); await user.click(screen.getByRole('button', { name: 'Confirm' }))
    await act(async () => { await done })
    expect(elevateCalls).toBe(2)
    expect(screen.queryByLabelText('Password')).toBeNull()
  })
  it('the prompt is called with incorrect:false the first time and incorrect:true after a refusal', async () => {
    setToken('a.b.c')
    const calls = []
    api.defaults.adapter = cfg => {
      if (cfg.url === '/admin/elevate') return wrongPw(cfg)
      return stepUp403(cfg)
    }
    setStepUpPrompt(arg => { calls.push(arg); return Promise.resolve(calls.length < 2 ? 'x' : null) })
    await expect(api.post('/admin/users/1', {})).rejects.toBeTruthy()
    expect(calls).toEqual([{ incorrect: false }, { incorrect: true }])
  })
})
