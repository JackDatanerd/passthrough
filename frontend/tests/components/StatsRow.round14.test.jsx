// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import StatsRow from '../../src/components/dashboard/StatsRow'

const show = (props) => render(<MemoryRouter><StatsRow best={70} trend={[70, 70]} verifiedCount={0} quota={null} credits={0} {...props} /></MemoryRouter>)

describe('StatsRow best-score note', () => {
  it('does not say "+0 since your first scan" when nothing has improved', () => {
    show({})
    expect(screen.queryByText(/\+0/)).toBeNull()
    expect(screen.getByText('out of 100')).toBeInTheDocument()
  })
  it('still shows a real gain', () => {
    show({ best: 82, trend: [60, 82] })
    expect(screen.getByText('+22 since your first scan')).toBeInTheDocument()
  })
})
