// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Select from '../../src/components/ui/Select'

// The shared label/error/hint/id/ref contract is covered in
// FormFields.test.jsx alongside Input and Textarea. This covers what's
// specific to Select: rendering real <option> children, firing onChange,
// and the `size` prop — added specifically so a compact select (AdminLeads'
// per-row status select, AdminSystemHealth's log filter) doesn't have to
// fight the default padding/text-size classes via className string
// concatenation (see Select.jsx's own comment on why).
describe('Select', () => {
  it('renders its option children and reports the selected value via onChange', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <Select label="Status" value="NEW" onChange={onChange}>
        <option value="NEW">New</option>
        <option value="DONE">Done</option>
      </Select>
    )
    await user.selectOptions(screen.getByRole('combobox'), 'DONE')
    expect(onChange).toHaveBeenCalled()
    expect(onChange.mock.calls[0][0].target.value).toBe('DONE')
  })

  it('size="md" (the default) uses the normal padding/text size; size="sm" uses the compact one', () => {
    const { rerender } = render(<Select label="X"><option>a</option></Select>)
    expect(screen.getByRole('combobox').className).toContain('px-3 py-2 text-sm')
    rerender(<Select label="X" size="sm"><option>a</option></Select>)
    expect(screen.getByRole('combobox').className).toContain('px-2 py-1 text-xs')
  })

  it('an unrecognized size falls back to the default rather than rendering no size classes', () => {
    render(<Select label="X" size="xl"><option>a</option></Select>)
    expect(screen.getByRole('combobox').className).toContain('px-3 py-2 text-sm')
  })
})
