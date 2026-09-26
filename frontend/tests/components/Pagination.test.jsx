// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Pagination from '../../src/components/ui/Pagination'

// Pagination.jsx replaced seven near-identical hand-rolled Prev/Next blocks
// (AdminPayments, AdminScans, AdminUsers, AdminWebhooks, AdminLeads,
// AdminSystemHealth x2, dashboard/Index) — now every one of those pages
// depends on this one small file behaving correctly (Section 12 audit).
describe('Pagination', () => {
  it('renders nothing when there is only one page', () => {
    const { container } = render(<Pagination page={1} totalPages={1} onChange={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the current page and total, and disables Prev on the first page', () => {
    render(<Pagination page={1} totalPages={5} onChange={() => {}} />)
    expect(screen.getByText('Page 1 of 5')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Prev' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next' })).not.toBeDisabled()
  })

  it('disables Next on the last page', () => {
    render(<Pagination page={5} totalPages={5} onChange={() => {}} />)
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Prev' })).not.toBeDisabled()
  })

  it('Prev/Next call onChange with page ± 1', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Pagination page={3} totalPages={5} onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(onChange).toHaveBeenCalledWith(4)
    await user.click(screen.getByRole('button', { name: 'Prev' }))
    expect(onChange).toHaveBeenCalledWith(2)
  })

  it('supports custom labels, for AdminSystemHealth\'s two independent lists on one page', () => {
    render(<Pagination page={1} totalPages={2} onChange={() => {}} prevLabel="← Older" nextLabel="Newer →" />)
    expect(screen.getByRole('button', { name: '← Older' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Newer →' })).toBeInTheDocument()
  })
})
