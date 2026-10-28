// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import CategoryScores from '../../src/components/scan/CategoryScores'

describe('CategoryScores - an unscored keyword row shows no invented number', () => {
  const scan = { keywordScore: 88, formatScore: 90, sectionsScore: 100, contentScore: 80 }
  it('shows a dash, not the blended 88, and the other rows keep their numbers', () => {
    const { container } = render(<CategoryScores scan={{ ...scan, atsDetail: { weights: { keywords: 0, format: 0.3, sections: 0.3, content: 0.4 } } }} />)
    expect(screen.getByText(/not scored for this posting/i)).toBeTruthy()
    expect(screen.queryByText('88')).toBeNull()
    expect(screen.getByText('—')).toBeTruthy()
    expect(screen.getByText('90')).toBeTruthy()
    expect(container.querySelectorAll('[style*="width: 0%"]').length).toBe(1)
  })
  it('a scored keyword row still shows its number', () => {
    render(<CategoryScores scan={{ ...scan, atsDetail: { weights: { keywords: 0.4, format: 0.2, sections: 0.2, content: 0.2 } } }} />)
    expect(screen.getByText('88')).toBeTruthy()
    expect(screen.queryByText('—')).toBeNull()
  })
})
