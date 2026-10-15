// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Link } from 'react-router-dom'
import Button from '../src/components/ui/Button'
import Form from '../src/components/ui/Form'
import FileUpload from '../src/components/ui/FileUpload'
import ToggleChip from '../src/components/ui/ToggleChip'
import useScrollToHash from '../src/hooks/useScrollToHash'

// Shared-frontend section 11 re-audit: one regression test per finding (B1 hash re-click, B2 loading button focus,
// B3 dropzone accessible name, G1 ToggleChip).

describe('Button loading keeps keyboard focus (B2)', () => {
  it('is aria-disabled, not natively disabled, while loading — so it can still hold focus', () => {
    render(<Button loading>Save</Button>)
    const btn = screen.getByRole('button', { name: 'Save' })
    expect(btn).not.toBeDisabled()
    expect(btn).toHaveAttribute('aria-disabled', 'true')
    expect(btn).toHaveAttribute('aria-busy', 'true')
  })

  it('a focused button is still the active element after it starts loading, and after it stops', () => {
    const { rerender } = render(<Button>Save</Button>)
    const btn = screen.getByRole('button', { name: 'Save' })
    btn.focus()
    expect(btn).toHaveFocus()
    rerender(<Button loading>Save</Button>)
    expect(btn).toHaveFocus()
    rerender(<Button>Save</Button>)
    expect(btn).toHaveFocus()
    expect(btn).not.toHaveAttribute('aria-disabled')
  })

  it('swallows clicks while loading (no double fire)', async () => {
    const onClick = vi.fn()
    render(<Button loading onClick={onClick}>Save</Button>)
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onClick).not.toHaveBeenCalled()
  })

  it('a loading submit button does not submit its form (Enter in a field arrives as a click on it)', async () => {
    const onSubmit = vi.fn()
    render(<Form onSubmit={onSubmit}><input aria-label="Name" /><Button type="submit" loading>Save</Button></Form>)
    await userEvent.type(screen.getByLabelText('Name'), 'x{Enter}')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('submits normally when not loading', async () => {
    const onSubmit = vi.fn()
    render(<Form onSubmit={onSubmit}><input aria-label="Name" /><Button type="submit">Save</Button></Form>)
    await userEvent.type(screen.getByLabelText('Name'), 'x{Enter}')
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('an explicit disabled is still natively disabled, and wins over loading', () => {
    render(<Button disabled loading>Save</Button>)
    const btn = screen.getByRole('button', { name: 'Save' })
    expect(btn).toBeDisabled()
    expect(btn).not.toHaveAttribute('aria-disabled')
  })
})

describe('useScrollToHash re-scrolls on a link to the hash already in the URL (B1)', () => {
  let scrollIntoView
  beforeEach(() => {
    scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    window.scrollTo = vi.fn()
  })
  afterEach(() => { delete Element.prototype.scrollIntoView })

  function Page() {
    useScrollToHash()
    return (
      <div>
        <Link to="/#target">same</Link>
        <Link to="/?page=2#target">page2</Link>
        <Link to="/#other">other</Link>
        <section id="target">t</section>
        <section id="other">o</section>
      </div>
    )
  }

  it('clicking the same hash link again scrolls again', async () => {
    render(<MemoryRouter initialEntries={['/#target']}><Page /></MemoryRouter>)
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))
    await userEvent.click(screen.getByText('same'))
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2))
    await userEvent.click(screen.getByText('same'))
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(3))
  })

  it('a different hash still scrolls', async () => {
    render(<MemoryRouter initialEntries={['/#target']}><Page /></MemoryRouter>)
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))
    await userEvent.click(screen.getByText('other'))
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2))
  })

  it('a change of query string that keeps the hash is not a request to scroll', async () => {
    render(<MemoryRouter initialEntries={['/#target']}><Page /></MemoryRouter>)
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))
    await userEvent.click(screen.getByText('page2'))
    await new Promise(r => setTimeout(r, 80))
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })
})

describe('FileUpload accessible name contains its visible text (B3)', () => {
  it('empty: it has no aria-label overriding the on-screen text; the name IS the on-screen text', () => {
    render(<FileUpload />)
    const zone = screen.getByRole('button')
    expect(zone).not.toHaveAttribute('aria-label')
    expect(zone).toHaveAccessibleName(/Drop your resume here or browse\s+PDF or DOCX, max 5MB/)
  })

  it('custom prompt / types / size are reflected', () => {
    render(<FileUpload prompt="Drop the CSV file here" typesText="CSV" maxMB={2} />)
    expect(screen.getByRole('button')).toHaveAccessibleName(/Drop the CSV file here or browse\s+CSV, max 2MB/)
  })

  it('an optional ariaLabel is a description, not a replacement name', () => {
    render(<FileUpload ariaLabel="Used to build your verified resume" />)
    const zone = screen.getByRole('button')
    expect(zone).toHaveAccessibleName(/Drop your resume here or browse/)
    expect(zone).toHaveAccessibleDescription('Used to build your verified resume')
  })

  it('with a file: named from the file name and "Click to replace", exactly as shown', () => {
    const file = new File(['x'], 'cv.pdf', { type: 'application/pdf' })
    render(<FileUpload value={file} />)
    const zone = screen.getByRole('button', { name: /cv\.pdf/ })
    expect(zone).toHaveAccessibleName(/cv\.pdf\s+Click to replace/)
    expect(zone.textContent).toContain('Click to replace')
  })
})

describe('ToggleChip (G1)', () => {
  it('is a type="button" that announces its pressed state', () => {
    const { rerender } = render(<ToggleChip pressed={false}>Open</ToggleChip>)
    const chip = screen.getByRole('button', { name: 'Open' })
    expect(chip).toHaveAttribute('type', 'button')
    expect(chip).toHaveAttribute('aria-pressed', 'false')
    rerender(<ToggleChip pressed>Open</ToggleChip>)
    expect(screen.getByRole('button', { name: 'Open' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('defaults to not pressed and calls onClick', async () => {
    const onClick = vi.fn()
    render(<ToggleChip onClick={onClick}>All</ToggleChip>)
    const chip = screen.getByRole('button', { name: 'All' })
    expect(chip).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(chip)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('has a visible focus ring, per-tone colours, and passes extra props through', () => {
    render(<><ToggleChip pressed tone="dark" size="sm" title="why">Dark</ToggleChip><ToggleChip pressed>Blue</ToggleChip></>)
    const dark = screen.getByRole('button', { name: 'Dark' })
    expect(dark.className).toContain('focus:ring-2')
    expect(dark.className).toContain('bg-gray-900')
    expect(dark.className).toContain('text-xs')
    expect(dark).toHaveAttribute('title', 'why')
    expect(screen.getByRole('button', { name: 'Blue' }).className).toContain('bg-blue-700')
  })

  it('can be driven as a single-select group', async () => {
    function Group() {
      const [s, setS] = useState('')
      return <div role="group" aria-label="Filter">{['', 'OPEN'].map(k => <ToggleChip key={k} pressed={s === k} onClick={() => setS(k)}>{k || 'All'}</ToggleChip>)}</div>
    }
    render(<Group />)
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'OPEN' }))
    expect(screen.getByRole('button', { name: 'OPEN' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false')
  })
})
