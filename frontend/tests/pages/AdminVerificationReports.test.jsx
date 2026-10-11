// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../../src/lib/api', () => ({ default: { get: vi.fn(), patch: vi.fn() } }))
const toast = vi.fn()
vi.mock('../../src/components/ui/Toast', () => ({ useToast: () => toast }))
import api from '../../src/lib/api'
import VerificationReports from '../../src/pages/admin/VerificationReports'

const report = (over = {}) => ({ id: 'r1', code: 'AB3XY7K2PQ', reason: 'FAKE', details: 'Not the person', reporterEmail: 'a@b.co', status: 'OPEN',
  createdAt: '2026-10-02T00:00:00Z', reviewedAt: null, scanId: 'scan1', pageStatus: 'ACTIVE', pageRevokedReason: null, ...over })
const listing = (...rows) => ({ data: { success: true, data: rows, meta: { page: 1, pageSize: 25, total: rows.length } } })
beforeEach(() => { cleanup(); vi.clearAllMocks() })

describe('admin: open verification reports', () => {
  it('renders nothing when no report is waiting', async () => {
    api.get.mockResolvedValue(listing())
    const { container } = render(<VerificationReports />)
    await waitFor(() => expect(api.get).toHaveBeenCalled())
    await waitFor(() => expect(container.querySelector('section')).toBeNull())
  })
  it('lists a report with its reason, note, reply address and page state', async () => {
    api.get.mockResolvedValue(listing(report()))
    render(<VerificationReports />)
    expect(await screen.findByText('AB3XY7K2PQ')).toBeTruthy()
    expect(screen.getByText('Looks fake / misleading')).toBeTruthy()
    expect(screen.getByText('Not the person')).toBeTruthy()
    expect(screen.getByText(/a@b\.co/)).toBeTruthy()
    expect(api.get).toHaveBeenCalledWith('/admin/verification-reports', { params: { status: 'OPEN', pageSize: 25 } })
  })
  it('Dismiss closes it server-side and drops it from the list', async () => {
    api.get.mockResolvedValue(listing(report()))
    api.patch.mockResolvedValue({ data: { success: true } })
    render(<VerificationReports />)
    fireEvent.click(await screen.findByRole('button', { name: /dismiss/i }))
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/verification-reports/r1', { status: 'DISMISSED' }))
    await waitFor(() => expect(screen.queryByText('AB3XY7K2PQ')).toBeNull())
  })
  it('Revoke page uses the existing scan verification lever, reloads, and tells the parent', async () => {
    api.get.mockResolvedValueOnce(listing(report())).mockResolvedValueOnce(listing())
    api.patch.mockResolvedValue({ data: { success: true } })
    const onChanged = vi.fn()
    render(<VerificationReports onChanged={onChanged} />)
    fireEvent.click(await screen.findByRole('button', { name: /revoke page/i }))
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/admin/scans/scan1/verification', { action: 'revoke' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })
  it('a deleted or already-revoked page offers no Revoke', async () => {
    api.get.mockResolvedValue(listing(report({ pageStatus: 'GONE', scanId: null }), report({ id: 'r2', code: 'ZZ3XY7K2PQ', pageStatus: 'REVOKED' })))
    render(<VerificationReports />)
    await screen.findByText('ZZ3XY7K2PQ')
    expect(screen.queryByRole('button', { name: /revoke page/i })).toBeNull()
    expect(screen.getByText('Page deleted')).toBeTruthy()
  })
})
