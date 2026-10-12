// @vitest-environment jsdom
// Section 11, round 7 — G2: FileUpload is a generic dropzone.
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import FileUpload from '../src/components/ui/FileUpload'
import { validateUpload } from '../src/lib/upload'

const file = (name, type = '', body = 'x') => new File([body], name, { type })
const input = c => c.querySelector('input[type="file"]')

describe('validateUpload extensions', () => {
  it('defaults to the resume pair with the original wording', () => {
    expect(validateUpload(file('a.csv'))).toBe('Only PDF and DOCX files are accepted.')
    expect(validateUpload(file('a.pdf'))).toBeNull()
  })
  it('accepts a custom list and words the refusal from it', () => {
    expect(validateUpload(file('a.csv'), 5, ['csv'])).toBeNull()
    expect(validateUpload(file('a.pdf'), 5, ['csv'])).toBe('Only CSV files are accepted.')
    expect(validateUpload(file('a.txt'), 5, ['csv', 'tsv', 'txt'])).toBeNull()
    expect(validateUpload(file('a.doc'), 5, ['csv', 'tsv', 'txt'])).toBe('Only CSV, TSV and TXT files are accepted.')
  })
})

describe('FileUpload with extensions', () => {
  it('derives the picker filter from extensions, and accepts a .csv while refusing a .pdf', () => {
    const onFile = vi.fn()
    const { container } = render(<FileUpload extensions={['csv']} onFile={onFile} ariaLabel="CSV file" prompt="Drop CSV" typesText="CSV" />)
    expect(input(container).getAttribute('accept')).toBe('.csv')
    fireEvent.change(input(container), { target: { files: [file('leads.csv', 'text/csv')] } })
    expect(onFile).toHaveBeenCalledTimes(1)
    fireEvent.change(input(container), { target: { files: [file('cv.pdf', 'application/pdf')] } })
    expect(onFile).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert').textContent).toBe('Only CSV files are accepted.')
  })
  it('an explicit accept still wins for the picker', () => {
    const { container } = render(<FileUpload extensions={['csv']} accept=".csv,text/csv" onFile={() => {}} />)
    expect(input(container).getAttribute('accept')).toBe('.csv,text/csv')
  })
  it('validate(file) can refuse an otherwise valid file', () => {
    const onFile = vi.fn()
    const { container } = render(<FileUpload extensions={['csv']} validate={f => (f.name.startsWith('x') ? 'Not that one.' : null)} onFile={onFile} />)
    fireEvent.change(input(container), { target: { files: [file('x.csv')] } })
    expect(onFile).not.toHaveBeenCalled(); expect(screen.getByRole('alert').textContent).toBe('Not that one.')
  })
  it('default behaviour is unchanged for resumes', () => {
    const onFile = vi.fn()
    const { container } = render(<FileUpload onFile={onFile} />)
    expect(input(container).getAttribute('accept')).toBe('.pdf,.docx')
    fireEvent.change(input(container), { target: { files: [file('a.docx')] } })
    expect(onFile).toHaveBeenCalledTimes(1)
  })
})

describe('FileUpload drag guard with several instances', () => {
  const over = (el) => { const dt = { types: ['Files'], dropEffect: 'copy', files: [] }; fireEvent.dragOver(el, { dataTransfer: dt }); return dt.dropEffect }
  it('two mounted dropzones both stay droppable', () => {
    const { container } = render(<div><FileUpload ariaLabel="A" /><FileUpload ariaLabel="B" /></div>)
    const [a, b] = container.querySelectorAll('[data-file-dropzone]')
    expect(over(a)).toBe('copy'); expect(over(b)).toBe('copy')
  })
  it('a drag over the rest of the page is still refused', () => {
    const { container } = render(<div><p id="elsewhere">x</p><FileUpload ariaLabel="A" /><FileUpload ariaLabel="B" /></div>)
    expect(over(container.querySelector('#elsewhere'))).toBe('none')
  })
})
