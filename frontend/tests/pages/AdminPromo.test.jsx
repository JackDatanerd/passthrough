// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastProvider } from '../../src/components/ui/Toast'
import api from '../../src/lib/api'
import AdminPromo from '../../src/pages/admin/AdminPromo'

vi.mock('../../src/lib/api', async () => {
  const errors = await import('../../src/lib/errors')
  return { default: { get: vi.fn(), put: vi.fn(), delete: vi.fn() }, getErrorMessage: errors.getErrorMessage }
})

const effective = (over = {}) => ({
  currency: 'USD', active: false, startsAt: null, endsAt: '2026-11-22T23:59:59Z', label: 'Introductory price', source: 'deploy',
  standardCents: { FIX: 4900, BADGE: 3900, FIX_PLAIN: 3900 }, promoCents: { FIX: 2900, BADGE: 900, FIX_PLAIN: 1900 }, ...over,
})
const payload = (over = {}) => ({ data: { data: { saved: null, effective: effective(), deploy: { active: true, endsAt: '2026-11-22T23:59:59Z' }, limits: { labelMax: 40, minPriceCents: 100 }, ...over } } })
const renderPage = () => render(<ToastProvider><AdminPromo /></ToastProvider>)

beforeEach(() => { api.get.mockReset(); api.put.mockReset(); api.delete.mockReset() })

describe('AdminPromo', () => {
  it('shows what is in force and prefills the form from the deploy settings when nothing is saved', async () => {
    api.get.mockResolvedValue(payload())
    renderPage()
    expect(await screen.findByText('Standard pricing')).toBeInTheDocument()
    expect(screen.getByLabelText('Full fix price')).toHaveValue('29')
    expect(screen.getByLabelText('Verified badge price')).toHaveValue('9')
    expect(screen.queryByRole('button', { name: /revert to deploy/i })).toBeNull()
  })

  it('saves prices in minor units with the name, then reflects the new effective promo', async () => {
    api.get.mockResolvedValue(payload())
    const saved = { active: true, label: 'Black Friday', startsAt: null, endsAt: '2026-12-01T00:00:00.000Z', prices: { FIX: 2500, FIX_PLAIN: 1500, BADGE: 700 }, updatedAt: '2026-11-01T00:00:00Z' }
    api.put.mockResolvedValue({ data: { data: { saved, effective: effective({ active: true, label: 'Black Friday', source: 'admin' }) } } })
    renderPage()
    const user = userEvent.setup()
    await screen.findByText('Standard pricing')
    await user.click(screen.getByRole('switch', { name: 'Promotion on' }))
    await user.type(screen.getByLabelText(/Name shown/), 'Black Friday')
    const fix = screen.getByLabelText('Full fix price')
    await user.clear(fix); await user.type(fix, '25')
    await user.click(screen.getByRole('button', { name: 'Save promotion' }))
    await waitFor(() => expect(api.put).toHaveBeenCalled())
    const [url, body] = api.put.mock.calls[0]
    expect(url).toBe('/admin/promo')
    expect(body).toMatchObject({ active: true, label: 'Black Friday', prices: { FIX: 2500, FIX_PLAIN: 1900, BADGE: 900 } })
    expect(await screen.findByText('Black Friday running')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /revert to deploy/i })).toBeInTheDocument()
  })

  it('puts the server\'s per-field message under the field it names', async () => {
    api.get.mockResolvedValue(payload())
    api.put.mockRejectedValue({ response: { status: 400, data: { success: false, message: 'too high', errors: [{ field: 'prices.FIX', message: 'Full fix must be below its standard price (4900), or the promo would raise it.' }] } } })
    renderPage()
    const user = userEvent.setup()
    await screen.findByText('Standard pricing')
    await user.click(screen.getByRole('button', { name: 'Save promotion' }))
    expect((await screen.findAllByText(/must be below its standard price/)).length).toBeGreaterThan(0)
    expect(screen.getByLabelText('Full fix price')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('Verified badge price')).not.toHaveAttribute('aria-invalid', 'true')
  })

  it('reverts to the deploy settings after confirmation', async () => {
    api.get.mockResolvedValue(payload({ saved: { active: true, label: 'X', startsAt: null, endsAt: '2026-12-01T00:00:00.000Z', prices: { FIX: 2500, FIX_PLAIN: 1500, BADGE: 700 } }, effective: effective({ active: true, source: 'admin' }) }))
    api.delete.mockResolvedValue({ data: { data: { saved: null, effective: effective() } } })
    renderPage()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /revert to deploy/i }))
    await user.click(await screen.findByRole('button', { name: 'Revert' }))
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/admin/promo'))
    await waitFor(() => expect(screen.queryByRole('button', { name: /revert to deploy/i })).toBeNull())
  })

  it('offers a retry when the settings cannot be loaded', async () => {
    api.get.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(payload())
    renderPage()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Standard pricing')).toBeInTheDocument()
  })

  it('reads "29,50" and "$29" as money, and refuses junk before sending anything', async () => {
    api.get.mockResolvedValue(payload())
    api.put.mockResolvedValue({ data: { data: { saved: null, effective: effective() } } })
    renderPage()
    const user = userEvent.setup()
    await screen.findByText('Standard pricing')
    const fix = screen.getByLabelText('Full fix price'), badge = screen.getByLabelText('Verified badge price')
    await user.clear(fix); await user.type(fix, '29,50')
    await user.clear(badge); await user.type(badge, '$9')
    await user.click(screen.getByRole('button', { name: 'Save promotion' }))
    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(api.put.mock.calls[0][1].prices).toMatchObject({ FIX: 2950, BADGE: 900 })

    api.put.mockClear()
    await user.clear(fix); await user.type(fix, 'abc')
    await user.click(screen.getByRole('button', { name: 'Save promotion' }))
    expect(await screen.findByText('Enter an amount like 29 or 29.50.')).toBeInTheDocument()
    expect(api.put).not.toHaveBeenCalled()
  })

  it('keeps the seconds of an end time so a 23:59:59 deadline is not shortened on save', async () => {
    api.get.mockResolvedValue(payload({ effective: effective({ endsAt: '2026-11-22T23:59:59Z' }) }))
    renderPage()
    await screen.findByText('Standard pricing')
    expect(screen.getByLabelText("Ends").value).toMatch(/:59(\.000)?$/)
  })
})
