// @vitest-environment jsdom
// Section 11, round 7 — G3: Radio, Input size, and no raw radios/checkboxes/search inputs left.
import React, { useState } from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import Radio from '../src/components/ui/Radio'
import Input from '../src/components/ui/Input'

describe('Radio', () => {
  function Pair() {
    const [v, setV] = useState('a')
    return <fieldset><legend>Version</legend>
      <Radio label="Original" name="v" checked={v === 'a'} onChange={() => setV('a')} />
      <Radio label="Fixed" description="The improved copy" name="v" checked={v === 'b'} onChange={() => setV('b')} /></fieldset>
  }
  it('is a labelled radio: clicking the label selects, the group is one-of', () => {
    render(<Pair />)
    expect(screen.getByRole('radio', { name: 'Original' }).checked).toBe(true)
    fireEvent.click(screen.getByText('Fixed'))
    expect(screen.getByRole('radio', { name: /Fixed/ }).checked).toBe(true)
    expect(screen.getByRole('radio', { name: 'Original' }).checked).toBe(false)
  })
  it('a description is part of the accessible name; disabled dims the row', () => {
    render(<Radio label="Only" description="Extra" disabled name="x" />)
    expect(screen.getByRole('radio', { name: /Only/ }).disabled).toBe(true)
    expect(screen.getByText('Only').closest('label').className).toContain('cursor-not-allowed')
  })
  it('without a label it is the bare input (aria-label from the caller)', () => {
    render(<Radio aria-label="Pick" name="y" />)
    expect(screen.getByRole('radio', { name: 'Pick' })).toBeTruthy()
  })
  it('two instances never share an id', () => {
    const { container } = render(<><Radio label="A" name="z" /><Radio label="B" name="z" /></>)
    const ids = [...container.querySelectorAll('input')].map(i => i.id); expect(new Set(ids).size).toBe(2)
  })
})

describe('Input size', () => {
  it('sm is the compact field; the default is unchanged', () => {
    const { container, rerender } = render(<Input aria-label="a" size="sm" />)
    expect(container.querySelector('input').className).toContain('py-1.5'); expect(container.querySelector('input').className).not.toContain('py-2.5')
    rerender(<Input aria-label="a" />)
    expect(container.querySelector('input').className).toContain('py-2.5')
  })
  it('does not leak size onto the DOM input', () => {
    const { container } = render(<Input aria-label="a" size="sm" />)
    expect(container.querySelector('input').hasAttribute('size')).toBe(false)
  })
})

// A guard so the hand-rolled controls do not creep back: outside the shared components, radios and checkboxes go through
// Radio / Checkbox. (Honeypots, the range slider, read-only copy fields and hidden file inputs are different elements.)
function walk(dir) { return readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.jsx') ? [p] : [] }) }
describe('no raw radios or checkboxes outside components/ui', () => {
  it('finds none', () => {
    const offenders = walk('frontend/src').filter(f => !f.includes(join('components', 'ui'))).filter(f => /<input[^>]*type=["']?(radio|checkbox)/s.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})
