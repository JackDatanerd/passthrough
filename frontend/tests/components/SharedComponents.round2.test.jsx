// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import Input from '../../src/components/ui/Input'
import Select from '../../src/components/ui/Select'
import Textarea from '../../src/components/ui/Textarea'
import EmptyState from '../../src/components/ui/EmptyState'
import Checkbox from '../../src/components/ui/Checkbox'
import ButtonLink from '../../src/components/ui/ButtonLink'
import Button, { buttonClasses } from '../../src/components/ui/Button'
import Spinner from '../../src/components/ui/Spinner'

// A `w-*` passed in className lands on the control beside its own `w-full`, and Tailwind emits
// `.w-full` AFTER `.w-56/.w-64/.w-auto` — so nine admin filters silently ignored their width.
// The wrapper is where layout classes belong.
describe('wrapperClassName', () => {
  it.each([
    ['Input', props => <Input label="L" {...props} />, 'textbox'],
    ['Select', props => <Select label="L" {...props}><option>a</option></Select>, 'combobox'],
    ['Textarea', props => <Textarea label="L" {...props} />, 'textbox'],
  ])('%s puts wrapperClassName on the outer div and className on the control', (_n, make, role) => {
    render(make({ wrapperClassName: 'w-56', className: 'font-mono' }))
    const control = screen.getByRole(role)
    expect(control.className).toMatch(/font-mono/)
    expect(control.className).not.toMatch(/\bw-56\b/)
    expect(control.parentElement.className).toMatch(/\bw-56\b/)
  })
})

// Static guard: nobody passes a width/margin utility into an Input/Select/Textarea className again.
describe('no dead width overrides', () => {
  it('no page or component passes w-* / max-w-* / flex-1 in className of Input, Select or Textarea', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const root = join(process.cwd(), 'frontend/src')
    const files = []
    const walk = d => readdirSync(d).forEach(n => { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : /\.jsx$/.test(n) && files.push(p) })
    walk(root)
    // The opening tag's end is the first `>` outside {...} and quotes — a naive [^>]* stops at the `=>`
    // inside onChange={e => ...} and never reaches className.
    const openingTag = (src, start) => {
      let depth = 0, quote = null
      for (let i = start; i < src.length; i++) {
        const ch = src[i]
        if (quote) { if (ch === quote) quote = null; continue }
        if (depth === 0 && (ch === '"' || ch === "'")) { quote = ch; continue }
        if (ch === '{') depth++
        else if (ch === '}') depth--
        else if (ch === '>' && depth === 0) return src.slice(start, i + 1)
      }
      return src.slice(start)
    }
    const offenders = []
    let scanned = 0
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      for (const m of src.matchAll(/<(Input|Select|Textarea)\b/g)) {
        scanned++
        const tag = openingTag(src, m.index)
        const cls = /\bclassName="([^"]*)"/.exec(tag)?.[1] || ''
        if (/(^|\s)(w-|max-w-|min-w-|flex-1|m[trblxy]?-)/.test(cls)) offenders.push(`${f.replace(root, '')}: ${tag.slice(0, 90)}`)
      }
    }
    expect(scanned).toBeGreaterThan(30)   // the scanner really is looking at the call sites
    expect(offenders).toEqual([])
  })
})

describe('EmptyState', () => {
  it('announces its text and optionally shows an action', () => {
    render(<EmptyState action={<button>Add one</button>}>No leads found.</EmptyState>)
    expect(screen.getByRole('status')).toHaveTextContent('No leads found.')
    expect(screen.getByRole('button', { name: 'Add one' })).toBeInTheDocument()
  })
})

describe('Checkbox', () => {
  it('with a label, clicking the label toggles it', async () => {
    let checked = false
    render(<Checkbox label="Show more" checked={checked} onChange={e => { checked = e.target.checked }} />)
    await userEvent.setup().click(screen.getByText('Show more'))
    expect(checked).toBe(true)
    expect(screen.getByRole('checkbox', { name: 'Show more' })).toBeInTheDocument()
  })
  it('without a label it is just the input, named by aria-label', () => {
    render(<Checkbox aria-label="Select row" checked={false} onChange={() => {}} />)
    const box = screen.getByRole('checkbox', { name: 'Select row' })
    expect(box.closest('label')).toBeNull()
  })
})

describe('ButtonLink', () => {
  it('is a real link that carries the exact classes of a Button', () => {
    render(<MemoryRouter><ButtonLink to="/pricing" variant="secondary" size="sm">See pricing</ButtonLink></MemoryRouter>)
    const a = screen.getByRole('link', { name: 'See pricing' })
    expect(a).toHaveAttribute('href', '/pricing')
    for (const c of buttonClasses('secondary', 'sm').split(' ')) expect(a.className).toContain(c)
  })
})

describe('Spinner / Button loading', () => {
  it('a standalone spinner is a labelled status', () => {
    render(<Spinner label="Saving" />)
    expect(screen.getByRole('status', { name: 'Saving' })).toBeInTheDocument()
  })
  it('a decorative spinner is hidden from assistive tech and inherits text colour', () => {
    const { container } = render(<Spinner decorative tone="current" />)
    const svg = container.querySelector('svg')
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).not.toHaveAttribute('role')
    expect(svg.getAttribute('class')).not.toMatch(/text-blue-600/)
  })
  it('a loading Button shows one hidden spinner, is busy and disabled — not a second "status"', () => {
    render(<Button loading>Save</Button>)
    const btn = screen.getByRole('button', { name: 'Save' })
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('aria-busy', 'true')
    expect(btn.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.queryByRole('status')).toBeNull()
  })
})
