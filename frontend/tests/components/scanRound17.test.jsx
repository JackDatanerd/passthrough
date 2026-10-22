// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import CategoryScores from '../../src/components/scan/CategoryScores'
import DiffView from '../../src/components/scan/DiffView'

describe('CategoryScores - keyword row when the posting had nothing to score', () => {
  const scan = { keywordScore: 88, formatScore: 90, sectionsScore: 100, contentScore: 80 }
  it('says so instead of showing a "Keyword Match" nobody measured', () => {
    render(<CategoryScores scan={{ ...scan, atsDetail: { weights: { keywords: 0, format: 0.3, sections: 0.3, content: 0.4 } } }} />)
    expect(screen.queryByText('Keyword Match')).toBeNull()
    expect(screen.getByText(/not scored for this posting/i)).toBeTruthy()
  })
  it('keeps the normal label otherwise', () => {
    render(<CategoryScores scan={{ ...scan, atsDetail: { weights: { keywords: 0.35 } } }} />)
    expect(screen.getByText('Keyword Match')).toBeTruthy()
  })
  it('keeps the normal label when no weights were sent', () => {
    render(<CategoryScores scan={scan} />)
    expect(screen.getByText('Keyword Match')).toBeTruthy()
  })
})

describe('DiffView - added certifications are flagged like added skills', () => {
  const base = { name: 'A', email: 'a@x.com', experience: [], education: [], skills: ['Go'], certifications: ['PMP'] }
  it('warns when a certification appears that the original did not have', () => {
    render(<DiffView originalResumeData={base} rewrittenResumeData={{ ...base, certifications: ['PMP', 'AWS Certified Solutions Architect'] }} />)
    // collapsed by default - open it
    fireEvent.click(screen.getByRole('button', { name: /see what changed/i }))
    expect(screen.queryByTestId('certs-added-warning')).toBeTruthy()
  })
  it('stays quiet when the certifications are unchanged', () => {
    render(<DiffView originalResumeData={base} rewrittenResumeData={{ ...base }} />)
    fireEvent.click(screen.getByRole('button', { name: /see what changed/i }))
    expect(screen.queryByTestId('certs-added-warning')).toBeNull()
  })
})
