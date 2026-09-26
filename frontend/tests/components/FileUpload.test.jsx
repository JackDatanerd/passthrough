// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FileUpload from '../../src/components/ui/FileUpload'

// FileUpload.jsx's own comments list several hand-found bugs: dragging over a
// CHILD element inside the dropzone used to flicker the highlight off (fixed
// with a drag-depth counter), a disabled dropzone still lit up on drag-over,
// and the component used to keep a private copy of the file so an unmounted-
// then-remounted parent could show the old file's name after `value` had
// already changed. None of that had a regression test before this (Section
// 12 audit).
//
// The dropzone's accessible name (aria-label) lives on the wrapping
// role="button" div, not on the real <input type="file"> — it's visually
// hidden and only reachable by querying for it directly, the same way a real
// user never touches it either (they interact with the dropzone).
function pdf(name = 'resume.pdf', { size, type = 'application/pdf' } = {}) {
  const file = new File([size ? new Uint8Array(1) : 'content'], name, { type })
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size })
  return file
}

function getFileInput(container) {
  return container.querySelector('input[type="file"]')
}

describe('FileUpload', () => {
  it('shows the empty-state prompt, then the file name once one is selected', async () => {
    const onFile = vi.fn()
    const { container } = render(<FileUpload onFile={onFile} />)
    expect(screen.getByText(/Drop your resume here/)).toBeInTheDocument()

    const user = userEvent.setup()
    await user.upload(getFileInput(container), pdf('resume.pdf'))

    expect(onFile).toHaveBeenCalledTimes(1)
    expect(onFile.mock.calls[0][0].name).toBe('resume.pdf')
    expect(screen.getByText('resume.pdf')).toBeInTheDocument()
  })

  it('re-wraps a file whose reported MIME type does not match its extension', async () => {
    const onFile = vi.fn()
    const { container } = render(<FileUpload onFile={onFile} />)
    const user = userEvent.setup()
    // A Windows picker reporting a generic type for a real .docx.
    await user.upload(getFileInput(container), pdf('resume.docx', { type: 'application/octet-stream' }))
    expect(onFile.mock.calls[0][0].type).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
  })

  it('rejects a disallowed extension without calling onFile', async () => {
    const onFile = vi.fn()
    const { container } = render(<FileUpload onFile={onFile} />)
    const user = userEvent.setup()
    await user.upload(getFileInput(container), pdf('resume.txt', { type: 'text/plain' }))
    expect(onFile).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Only PDF and DOCX files are accepted.')
  })

  it('rejects an empty file', async () => {
    const onFile = vi.fn()
    const { container } = render(<FileUpload onFile={onFile} />)
    const user = userEvent.setup()
    await user.upload(getFileInput(container), pdf('empty.pdf', { size: 0 }))
    expect(onFile).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('That file is empty.')
  })

  it('rejects a file over the size limit', async () => {
    const onFile = vi.fn()
    const { container } = render(<FileUpload onFile={onFile} maxMB={5} />)
    const user = userEvent.setup()
    await user.upload(getFileInput(container), pdf('big.pdf', { size: 6 * 1024 * 1024 }))
    expect(onFile).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('File too large. Max 5MB.')
  })

  it('Remove clears the file and calls onFile(null)', async () => {
    const onFile = vi.fn()
    const { container } = render(<FileUpload onFile={onFile} />)
    const user = userEvent.setup()
    await user.upload(getFileInput(container), pdf())
    await user.click(screen.getByText('Remove file'))
    expect(onFile).toHaveBeenLastCalledWith(null)
    expect(screen.queryByText('Remove file')).toBeNull()
    expect(screen.getByText(/Drop your resume here/)).toBeInTheDocument()
  })

  it('is a controlled component when `value` is passed — the parent decides what shows', () => {
    const file = pdf('from-parent.pdf')
    const { rerender } = render(<FileUpload onFile={() => {}} value={file} />)
    expect(screen.getByText('from-parent.pdf')).toBeInTheDocument()
    rerender(<FileUpload onFile={() => {}} value={null} />)
    expect(screen.queryByText('from-parent.pdf')).toBeNull()
    expect(screen.getByText(/Drop your resume here/)).toBeInTheDocument()
  })

  it('dragging over a child element does not flicker the highlight off (depth counter)', () => {
    render(<FileUpload onFile={() => {}} />)
    const dropzone = screen.getByRole('button')
    const child = dropzone.querySelector('svg')

    fireEvent.dragEnter(dropzone)
    expect(dropzone.className).toMatch(/border-blue-400/)
    fireEvent.dragEnter(child) // bubbles to dropzone's listener too — depth now 2
    fireEvent.dragLeave(child) // depth back to 1 — must still be highlighted
    expect(dropzone.className).toMatch(/border-blue-400/)
    fireEvent.dragLeave(dropzone) // depth 0 — now it should clear
    expect(dropzone.className).not.toMatch(/border-blue-400/)
  })

  it('a disabled dropzone does not light up on drag-over', () => {
    render(<FileUpload onFile={() => {}} disabled />)
    const dropzone = screen.getByRole('button')
    fireEvent.dragEnter(dropzone)
    expect(dropzone.className).not.toMatch(/border-blue-400/)
    expect(dropzone).toHaveAttribute('aria-disabled', 'true')
    expect(dropzone).toHaveAttribute('tabIndex', '-1')
  })

  it('dropping a file on the dropzone selects it, same as picking one', () => {
    const onFile = vi.fn()
    render(<FileUpload onFile={onFile} />)
    const dropzone = screen.getByRole('button')
    const file = pdf('dropped.pdf')
    fireEvent.drop(dropzone, { dataTransfer: { files: [file] } })
    expect(onFile.mock.calls[0][0].name).toBe('dropped.pdf')
  })

  it('Enter/Space on the focused dropzone opens the file picker', async () => {
    const { container } = render(<FileUpload onFile={() => {}} />)
    const dropzone = screen.getByRole('button')
    const input = getFileInput(container)
    const clickSpy = vi.spyOn(input, 'click')
    dropzone.focus()
    const user = userEvent.setup()
    await user.keyboard('{Enter}')
    expect(clickSpy).toHaveBeenCalledTimes(1)
    await user.keyboard(' ')
    expect(clickSpy).toHaveBeenCalledTimes(2)
  })
})
