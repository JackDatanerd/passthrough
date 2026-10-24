// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import FileUpload from '../../src/components/ui/FileUpload'
import ScanStrip from '../../src/components/scan/ScanStrip'
import PassAnim from '../../src/components/scan/PassAnim'
import ProgressSteps from '../../src/components/scan/ProgressSteps'

const pdf = (name = 'cv.pdf', size = 184 * 1024) => new File([new Uint8Array(size)], name, { type: 'application/pdf' })

describe('FileUpload, card look', () => {
  it('is a plain dashed drop area until a file is held, then a green chip with Replace and Remove', () => {
    const { rerender } = render(<FileUpload look="card" value={null} onFile={vi.fn()} />)
    expect(screen.getByRole('button', { name: /Drop your resume here/ })).toBeInTheDocument()
    expect(screen.queryByTestId('file-chip')).toBeNull()
    rerender(<FileUpload look="card" value={pdf('My Resume.pdf')} onFile={vi.fn()} />)
    const chip = screen.getByTestId('file-chip')
    expect(chip).toHaveTextContent('My Resume.pdf')
    expect(chip).toHaveTextContent('184 KB')
    expect(within(chip).getByText('PDF')).toBeInTheDocument()
    expect(within(chip).getByRole('button', { name: 'Replace' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Drop your resume here/ })).toBeNull()
  })

  it('Remove clears the file and puts focus back on the drop area once it is on the page', () => {
    function Holder() {
      const [f, setF] = React.useState(pdf())
      return <FileUpload look="card" value={f} onFile={setF} />
    }
    render(<Holder />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove file' }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Drop your resume here/ }))
  })

  it('refuses a file of the wrong kind with its reason, and keeps what it had', () => {
    const onFile = vi.fn()
    render(<FileUpload look="card" value={null} onFile={onFile} />)
    const input = document.querySelector('input[type=file]')
    fireEvent.change(input, { target: { files: [new File(['x'], 'cv.exe', { type: 'application/octet-stream' })] } })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(onFile).not.toHaveBeenCalled()
  })
})

describe('ScanStrip', () => {
  const base = { atsScore: 62, passed: false }
  it('before a fix: the score as scanned, Scanned done, the rest waiting', () => {
    render(<ScanStrip scan={base} stage="scored" />)
    const strip = screen.getByTestId('scan-strip')
    expect(strip).toHaveTextContent('62 out of 100')
    expect(strip).toHaveTextContent('Scored against this job')
    expect(within(strip).getByText('Scanned').closest('li')).toHaveClass('border-green-700')
    expect(within(strip).getByText('Rewritten').closest('li')).not.toHaveAttribute('aria-current')
  })
  it('while the rewrite runs: Rewritten is the current step', () => {
    render(<ScanStrip scan={base} stage="rewriting" />)
    expect(screen.getByTestId('scan-strip')).toHaveTextContent('Being rewritten now')
    expect(within(screen.getByTestId('scan-strip')).getByText('Rewritten').closest('li')).toHaveAttribute('aria-current', 'step')
  })
  it('delivered under 80: the fixed score, the old one, and what Verified still needs', () => {
    render(<ScanStrip scan={{ ...base, fixAtsScore: 77, verificationUrl: null }} stage="delivered" />)
    const strip = screen.getByTestId('scan-strip')
    expect(strip).toHaveTextContent('77 out of 100, after the fix')
    expect(strip).toHaveTextContent('Scored 62 before')
    expect(within(strip).getByText('Verified').closest('li')).toHaveTextContent('at 80')
  })
  it('shows nothing before there is a score', () => {
    const { container } = render(<ScanStrip scan={{}} stage="scored" />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('waiting pieces', () => {
  it('the animation says nothing to a screen reader', () => {
    render(<PassAnim />)
    expect(screen.getByTestId('pass-anim')).toHaveAttribute('aria-hidden', 'true')
  })
  it('steps: done before, current spinning, the rest dim; nothing claims a percentage', () => {
    render(<ProgressSteps steps={[['A', 'a'], ['B', 'b'], ['C', 'c']]} current={1} />)
    expect(document.querySelector('[aria-current="step"]')).toHaveTextContent('B')
    expect(document.querySelectorAll('ol li .bg-green-700')).toHaveLength(1)
    expect(document.body.textContent).not.toMatch(/%/)
  })
})
