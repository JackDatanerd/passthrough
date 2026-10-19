// @vitest-environment jsdom
import { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
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
    expect(screen.getByRole('button', { name: 'Prev' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: 'Next' })).not.toHaveAttribute('aria-disabled')
  })

  it('disables Next on the last page', () => {
    render(<Pagination page={5} totalPages={5} onChange={() => {}} />)
    expect(screen.getByRole('button', { name: 'Next' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: 'Prev' })).not.toHaveAttribute('aria-disabled')
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

  // Round 19: native `disabled` on the focused end button dropped keyboard focus.
  it('the end buttons stay enabled and focusable (aria-disabled), and a click on one does nothing', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Pagination page={1} totalPages={3} onChange={onChange} />)
    const prev = screen.getByRole('button', { name: 'Prev' })
    expect(prev).not.toBeDisabled()
    await user.click(prev)
    expect(onChange).not.toHaveBeenCalled()
    cleanup()
    render(<Pagination page={3} totalPages={3} onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps focus on Next after it carries the person onto the last page, and Enter there is a no-op', async () => {
    const user = userEvent.setup()
    const seen = []
    function Demo() {
      const [page, setPage] = useState(2)
      return <Pagination page={page} totalPages={3} onChange={p => { seen.push(p); setPage(p) }} />
    }
    render(<Demo />)
    const next = screen.getByRole('button', { name: 'Next' })
    next.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByText('Page 3 of 3')).toBeInTheDocument()
    expect(document.activeElement).toBe(next)
    await user.keyboard('{Enter}')
    expect(seen).toEqual([3])
  })
})
