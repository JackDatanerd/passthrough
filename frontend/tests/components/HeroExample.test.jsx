// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import HeroExample from '../../src/components/home/HeroExample'
import { BEFORE_AFTER } from '../../src/lib/homeContent'
import { scoreTone } from '../../src/lib/homeFormat'

// The hero's "what a scan shows you" card is a preview of the full Before/After section, so it must show the SAME numbers,
// be labelled as an illustration, and read sensibly without the colours.
describe('HeroExample', () => {
  it('shows the real before/after scores, verdicts and every breakdown row from BEFORE_AFTER', () => {
    render(<HeroExample />)
    const card = screen.getByRole('region', { name: 'What a scan shows you' })
    for (const side of [BEFORE_AFTER.before, BEFORE_AFTER.after]) {
      expect(within(card).getByText(side.verdict)).toBeInTheDocument()
      for (const [label, v] of side.rows) {
        // one label per side, and its number sits next to it
        const row = within(card).getAllByText(label).find(el => el.nextElementSibling?.textContent === String(v))
        expect(row, `${label} ${v}`).toBeTruthy()
      }
    }
  })

  it('is labelled an illustrative example (like the full section) and says which score is before and after', () => {
    render(<HeroExample />)
    expect(screen.getByText('Illustrative example')).toBeInTheDocument()
    expect(screen.getByText(/Before: score/)).toBeInTheDocument()
    expect(screen.getByText(/After: score/)).toBeInTheDocument()
    expect(document.body.textContent).toContain(`${BEFORE_AFTER.before.score}`)
    expect(document.body.textContent).toContain(`${BEFORE_AFTER.after.score}`)
  })

  it('lists the keywords the resume was missing and links down to the full before/after section', () => {
    render(<HeroExample />)
    for (const k of BEFORE_AFTER.before.keywords) expect(screen.getByText(k)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /See the full before and after/ })).toHaveAttribute('href', '#proof')
  })

  it('uses the shared score colours: the same number is the same colour here as in the Before/After section', () => {
    expect(scoreTone(91)).toEqual({ bar: 'bg-green-500', text: 'text-green-700' })
    expect(scoreTone(80).bar).toBe('bg-green-500')
    expect(scoreTone(71)).toEqual({ bar: 'bg-amber-400', text: 'text-amber-700' })
    expect(scoreTone(60).bar).toBe('bg-amber-400')
    expect(scoreTone(58)).toEqual({ bar: 'bg-red-500', text: 'text-red-700' })
    expect(scoreTone(0).bar).toBe('bg-red-500')
    render(<HeroExample />)
    const sevenOne = screen.getAllByText('71').find(el => el.className.includes('font-bold'))
    expect(sevenOne.className).toMatch(/text-amber-700/)
  })
})
