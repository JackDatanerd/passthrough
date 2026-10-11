// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import api from '../src/lib/api'
import ResumeDataEditor from '../src/components/scan/ResumeDataEditor'

describe('ResumeDataEditor — "Preview what we extracted" hands up everything the server returned', () => {
  it('passes the formatted-file detail up with the structured data, so the banner stops asking to check it', async () => {
    const atsDetail = { formattedScore: 82, aiMissingKeywords: [] }
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { data: { originalResumeData: { name: 'Jane', experience: [] }, atsDetail } } })
    const onUpdated = vi.fn()
    render(<ResumeDataEditor scan={{ id: 's1', inputMode: 'file', status: 'COMPLETE_PASS', originalResumeData: null }} onUpdated={onUpdated} />)
    await userEvent.click(await screen.findByRole('button', { name: /preview what we extracted/i }))
    await waitFor(() => expect(onUpdated).toHaveBeenCalled())
    expect(post).toHaveBeenCalledWith('/scan/s1/structure')
    expect(onUpdated).toHaveBeenCalledWith({ originalResumeData: { name: 'Jane', experience: [] }, atsDetail })
    post.mockRestore()
  })
})
