// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ExpandableText, { previewOf, PREVIEW_CHARS } from '../../src/components/ui/ExpandableText'

const LONG = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')       // far over the limit

describe('previewOf', () => {
  it('leaves short text alone', () => {
    expect(previewOf('A short story.')).toEqual({ shown: 'A short story.', truncated: false })
    expect(previewOf('')).toEqual({ shown: '', truncated: false })
    expect(previewOf(null)).toEqual({ shown: '', truncated: false })
  })
  it('text exactly at the limit is shown whole; one character over is cut', () => {
    expect(previewOf('a'.repeat(PREVIEW_CHARS)).truncated).toBe(false)
    expect(previewOf('a'.repeat(PREVIEW_CHARS + 1)).truncated).toBe(true)
  })
  it('cuts at a word boundary, never mid-word, and stays within the limit', () => {
    const { shown, truncated } = previewOf(LONG)
    expect(truncated).toBe(true)
    expect(shown.length).toBeLessThanOrEqual(PREVIEW_CHARS)
    expect(LONG.startsWith(shown)).toBe(true)
    expect(LONG[shown.length]).toBe(' ')                 // the next character is a space: a whole word ended the preview
  })
  it('never splits an emoji (a cut by code unit would leave half of one)', () => {
    const text = '👩‍💻'.repeat(300)
    const { shown } = previewOf(text, 101)
    expect(Array.from(shown).length).toBeLessThanOrEqual(101)
    expect(shown).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/)
  })
  it('a long text with no spaces is still cut', () => {
    const { shown, truncated } = previewOf('x'.repeat(500))
    expect(truncated).toBe(true)
    expect(shown.length).toBe(PREVIEW_CHARS)
  })
})

describe('ExpandableText', () => {
  it('short text: shown whole, no control', () => {
    render(<ExpandableText text="Just a few words." />)
    expect(screen.getByText('Just a few words.')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })
  it('nothing to show: renders nothing', () => {
    const { container } = render(<ExpandableText text="" />)
    expect(container).toBeEmptyDOMElement()
  })
  it('long text: a preview with an ellipsis and a "Read full story" control; the rest is not on the page', () => {
    render(<ExpandableText text={LONG} />)
    expect(screen.getByRole('button', { name: 'Read full story' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText(/^word0 word1/)).toHaveTextContent('…')
    expect(screen.queryByText(/word79/)).toBeNull()
  })
  it('clicking opens all of it, and again closes it', () => {
    render(<ExpandableText text={LONG} />)
    fireEvent.click(screen.getByRole('button', { name: 'Read full story' }))
    expect(screen.getByText(/word79/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
    expect(screen.queryByText(/word79/)).toBeNull()
  })
  it('the control points at the paragraph it opens (for screen readers)', () => {
    render(<ExpandableText text={LONG} />)
    const btn = screen.getByRole('button')
    expect(document.getElementById(btn.getAttribute('aria-controls'))).toBeInTheDocument()
  })
  it('reports each toggle to a caller that wants to know', () => {
    const onToggle = vi.fn()
    render(<ExpandableText text={LONG} onToggle={onToggle} />)
    fireEvent.click(screen.getByRole('button', { name: 'Read full story' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
    expect(onToggle.mock.calls).toEqual([[true], [false]])
  })
  it('can be controlled by the caller', () => {
    const onToggle = vi.fn()
    const { rerender } = render(<ExpandableText text={LONG} expanded={false} onToggle={onToggle} />)
    fireEvent.click(screen.getByRole('button', { name: 'Read full story' }))
    expect(screen.queryByText(/word79/)).toBeNull()          // it did not open itself: the caller decides
    rerender(<ExpandableText text={LONG} expanded onToggle={onToggle} />)
    expect(screen.getByText(/word79/)).toBeInTheDocument()
  })
})
