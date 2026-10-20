// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import api from '../src/lib/api'
import AdminHotCategories from '../src/pages/admin/AdminHotCategories'
import { readPreview } from '../src/hooks/useAdminHotPreview'
import { ROLE_CATEGORIES } from '../src/lib/roleCategories'

const toast = vi.fn()
vi.mock('../src/lib/api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  getErrorMessage: (err, fallback) => err?.response?.data?.message || fallback,
}))
vi.mock('../src/components/ui/Toast', () => ({ useToast: () => toast }))

// A field row exactly as the admin endpoint returns it.
const field = (category, current, over = {}, floor = 10) => ({
  category, current, previous: 0, simulated: 0, effective: current, qualifies: current >= floor, needed: Math.max(0, floor - current),
  rank: null, changePct: null, ...over,
})
const windowOf = (fields, over = {}) => ({
  fields, qualifying: fields.filter(f => f.qualifies).length, uncategorised: 0, interviews: fields.reduce((s, f) => s + f.current, 0),
  showsSample: !fields.some(f => f.qualifies), ...over,
})
const payload = ({ w7 = [], w30 = [], hot7 = [], hot30 = [], threshold = 10, simulated = false, truncated = false, w7over = {} } = {}) => ({ data: { data: {
  threshold, defaultThreshold: 10, windows: [7, 30], simulated, truncated, generatedAt: '2026-10-19T12:00:00Z',
  perWindow: { 7: windowOf(w7, w7over), 30: windowOf(w30) },
  hotCategories: { 7: hot7, 30: hot30, minReports: threshold },
} } })
// The preview's own HotCategories has a 30-day switch too; this page's switch is the first one in the document.
const thirtyDays = () => screen.getAllByRole('button', { name: '30 days' })[0]
// The homepage section labels its placeholder table with this footnote (the corner "Sample" badge was switched off upstream).
const SAMPLE_NOTE = 'Sample numbers shown until enough real reports come in.'
// A table row, found by its field cell (the preview's own list is not a table, so this cannot match it).
const rowFor = (label) => screen.getByText(label, { selector: 'td' }).closest('tr')
const renderPage = () => render(<MemoryRouter><AdminHotCategories /></MemoryRouter>)
beforeEach(() => { api.get.mockReset(); api.post.mockReset(); toast.mockReset(); localStorage.clear() })

describe('AdminHotCategories — the counts', () => {
  it('shows every field against the threshold, and says the homepage is on its sample table when none qualify', async () => {
    api.get.mockResolvedValue(payload({ w7: [field('sales', 4), field('legal', 2)] }))
    renderPage()
    expect(await screen.findByText(/shows its/)).toHaveTextContent(/sample.*no field has 10 interview reports yet/)
    expect(api.get).toHaveBeenCalledWith('/admin/hot-categories', expect.anything())
    const sales = rowFor('Sales')
    expect(within(sales).getByText('Needs 6 more')).toBeInTheDocument()
    expect(within(sales).getByText('4 / 10')).toBeInTheDocument()
    // a field with no reports at all is still listed, so you can see (and simulate) it
    expect(within(rowFor('Design')).getByText('Needs 10 more')).toBeInTheDocument()
    // the preview is the real component, on its sample fallback, with the sample footnote the live page shows
    expect(within(screen.getByTestId('preview')).getByText(SAMPLE_NOTE)).toBeInTheDocument()
  })
  it('says the homepage is on real data once a field qualifies, and previews exactly that', async () => {
    api.get.mockResolvedValue(payload({
      w7: [field('sales', 12, { rank: 1, qualifies: true }), field('legal', 3)],
      hot7: [{ category: 'sales', interviews: 12, changePct: null }],
    }))
    renderPage()
    expect(await screen.findByText(/shows/, { selector: '[role="status"]' })).toHaveTextContent(/real.*1 field is listed/)
    expect(within(rowFor('Sales')).getByText('Listed #1')).toBeInTheDocument()
    const preview = screen.getByTestId('preview')
    expect(within(preview).queryByText(SAMPLE_NOTE)).toBeNull()
    expect(within(preview).getByText('12')).toBeInTheDocument()
  })
  it('reports reports that have no field, since those are not counted', async () => {
    api.get.mockResolvedValue(payload({ w7: [field('sales', 4)], w7over: { uncategorised: 2, interviews: 6 } }))
    renderPage()
    expect(await screen.findByText(/6 interview reports/)).toHaveTextContent(/2 without a field \(not counted\)/)
  })
  it('the period switch shows the other window, with its own counts', async () => {
    api.get.mockResolvedValue(payload({ w7: [field('sales', 4)], w30: [field('sales', 25, { qualifies: true, rank: 1 })], hot30: [{ category: 'sales', interviews: 25, changePct: null }] }))
    renderPage()
    await screen.findByText('Needs 6 more')
    fireEvent.click(thirtyDays())
    expect(within(rowFor('Sales')).getByText('Listed #1')).toBeInTheDocument()
  })
  it('warns when the answer was cut short, and when the load fails', async () => {
    api.get.mockResolvedValueOnce(payload({ truncated: true }))
    renderPage()
    expect(await screen.findByText(/counts below can be too low/)).toBeInTheDocument()
  })
  it('a failed load shows a retry instead of an empty "all clear"', async () => {
    api.get.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(payload({ w7: [field('sales', 4)] }))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Needs 6 more')).toBeInTheDocument()
  })
})

describe('AdminHotCategories — the simulator', () => {
  const real = () => payload({ w7: [field('sales', 4)] })
  it('sends the threshold and the pretend reports, then shows the result — including the preview — as a simulation', async () => {
    api.get.mockResolvedValue(real())
    api.post.mockResolvedValue(payload({
      threshold: 3, simulated: true,
      w7: [field('sales', 4, { simulated: 6, effective: 10, qualifies: true, rank: 1, needed: 0 }, 3)],
      hot7: [{ category: 'sales', interviews: 10, changePct: null }],
    }))
    renderPage()
    await screen.findByText('Needs 6 more')
    expect(screen.getByRole('button', { name: 'Run simulation' })).toBeDisabled()   // nothing typed yet
    fireEvent.change(screen.getByLabelText(/Threshold/), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText('Pretend reports for Sales, the last 7 days'), { target: { value: '6' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/hot-categories/simulate', { minReports: 3, adds: [{ category: 'sales', days7: 6, days30: 0 }] }, expect.anything()))
    expect(await screen.findByText('Simulation on')).toBeInTheDocument()
    expect(screen.getByTestId('sim-summary')).toHaveTextContent(/threshold of 3.*\+6 pretend reports in the 7-day window.*real data \(1 field\)/)
    expect(within(screen.getByTestId('preview')).queryByText(SAMPLE_NOTE)).toBeNull()
    expect(screen.getByText('Preview of the simulation')).toBeInTheDocument()
    // the banner above still describes the REAL page, which a simulation never changes
    expect(screen.getByText(/shows its/)).toHaveTextContent(/sample/)
  })
  it('pretend reports typed on the 30-day view go to the 30-day window', async () => {
    api.get.mockResolvedValue(real())
    api.post.mockResolvedValue(payload({ simulated: true }))
    renderPage()
    await screen.findByText('Needs 6 more')
    fireEvent.click(thirtyDays())
    fireEvent.change(screen.getByLabelText('Pretend reports for Legal, the last 30 days'), { target: { value: '12' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/hot-categories/simulate', { adds: [{ category: 'legal', days7: 0, days30: 12 }] }, expect.anything()))
  })
  it('will not send an out-of-range threshold', async () => {
    api.get.mockResolvedValue(real())
    renderPage()
    await screen.findByText('Needs 6 more')
    fireEvent.change(screen.getByLabelText(/Threshold/), { target: { value: '0' } })
    expect(screen.getByRole('button', { name: 'Run simulation' })).toBeDisabled()
    expect(screen.getByText('Use 1–1000')).toBeInTheDocument()
  })
  it('Reset clears the inputs and goes back to the real counts', async () => {
    api.get.mockResolvedValue(real())
    api.post.mockResolvedValue(payload({ threshold: 3, simulated: true, w7: [field('sales', 4, {}, 3)] }))
    renderPage()
    await screen.findByText('Needs 6 more')
    fireEvent.change(screen.getByLabelText(/Threshold/), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }))
    await screen.findByText('Simulation on')
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(screen.queryByText('Simulation on')).toBeNull()
    expect(screen.getByLabelText(/Threshold/)).toHaveValue(null)
    expect(screen.getByText('Preview of the live section')).toBeInTheDocument()
    expect(screen.getByText('Needs 6 more')).toBeInTheDocument()
  })
  it('a failed simulation says so and leaves the real view in place', async () => {
    api.get.mockResolvedValue(real())
    api.post.mockRejectedValue({ response: { data: { message: 'nope' } } })
    renderPage()
    await screen.findByText('Needs 6 more')
    fireEvent.change(screen.getByLabelText(/Threshold/), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ message: 'nope', type: 'error' }))
    expect(screen.queryByText('Simulation on')).toBeNull()
  })
  it('never calls anything but the two admin endpoints: a simulation cannot reach the public page or any write', async () => {
    api.get.mockResolvedValue(real())
    api.post.mockResolvedValue(payload({ simulated: true }))
    renderPage()
    await screen.findByText('Needs 6 more')
    fireEvent.change(screen.getByLabelText(/Threshold/), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }))
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    expect(api.get.mock.calls.every(([url]) => url === '/admin/hot-categories')).toBe(true)
    expect(api.post.mock.calls.every(([url]) => url === '/admin/hot-categories/simulate')).toBe(true)
  })
})

describe('AdminHotCategories — randomize', () => {
  const real = () => payload({ w7: [field('sales', 4)] })
  it('one click fills pretend numbers on every field for both windows and both periods, and runs the simulation', async () => {
    api.get.mockResolvedValue(real())
    api.post.mockResolvedValue(payload({ simulated: true, threshold: 10 }))
    let seed = 7; const rnd = vi.spyOn(Math, 'random').mockImplementation(() => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 })
    renderPage()
    await screen.findByText('Needs 6 more')
    fireEvent.click(screen.getByRole('button', { name: 'Randomize all fields' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
    rnd.mockRestore()
    const [url, body] = api.post.mock.calls[0]
    expect(url).toBe('/admin/hot-categories/simulate')
    expect(body.minReports).toBeUndefined()   // the threshold was left at the live one
    const sent = new Set(body.adds.map(a => a.category))
    const known = ROLE_CATEGORIES.map(([k]) => k)
    expect(body.adds.every(a => known.includes(a.category))).toBe(true)
    expect(sent.size).toBeGreaterThanOrEqual(9)                                   // nearly every field gets something
    expect(body.adds.some(a => a.days7 >= 10)).toBe(true)                         // some clear the live threshold
    expect(body.adds.some(a => a.days30 > 0)).toBe(true)
    expect(body.adds.some(a => a.prev7 > 0 || a.prev30 > 0)).toBe(true)           // the "before" period is randomized as well
    expect(await screen.findByText('Simulation on')).toBeInTheDocument()
    // the typed inputs show what was generated, so the scenario can be tweaked by hand and run again
    const filled = known.filter(k => body.adds.some(a => a.category === k && a.days7 > 0))
    expect(filled.length).toBeGreaterThan(0)
  })
  it('every click is a new roll, and an out-of-range threshold blocks it', async () => {
    api.get.mockResolvedValue(real())
    api.post.mockResolvedValue(payload({ simulated: true }))
    renderPage()
    await screen.findByText('Needs 6 more')
    fireEvent.click(screen.getByRole('button', { name: 'Randomize all fields' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Randomize all fields' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2))
    expect(api.post.mock.calls[0][1]).not.toEqual(api.post.mock.calls[1][1])
    fireEvent.change(screen.getByLabelText(/Threshold/), { target: { value: '0' } })
    expect(screen.getByRole('button', { name: 'Randomize all fields' })).toBeDisabled()
  })
  it('uses the threshold you typed, so the scenario is built around it', async () => {
    api.get.mockResolvedValue(real())
    api.post.mockResolvedValue(payload({ simulated: true, threshold: 40 }))
    renderPage()
    await screen.findByText('Needs 6 more')
    fireEvent.change(screen.getByLabelText(/Threshold/), { target: { value: '40' } })
    fireEvent.click(screen.getByRole('button', { name: 'Randomize all fields' }))
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    const body = api.post.mock.calls[0][1]
    expect(body.minReports).toBe(40)
    expect(Math.max(...body.adds.map(a => a.days7))).toBeGreaterThanOrEqual(40)
  })
  it('"+ Before" inputs are sent as prev7 / prev30 and only when filled', async () => {
    api.get.mockResolvedValue(real())
    api.post.mockResolvedValue(payload({ simulated: true }))
    renderPage()
    await screen.findByText('Needs 6 more')
    fireEvent.change(screen.getByLabelText('Pretend reports for Sales in the period before the last 7 days'), { target: { value: '9' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/hot-categories/simulate', { adds: [{ category: 'sales', days7: 0, days30: 0, prev7: 9 }] }, expect.anything()))
  })
})

describe('AdminHotCategories — show it on my homepage', () => {
  const real = () => payload({ w7: [field('sales', 4)] })
  const simulated = () => payload({
    threshold: 10, simulated: true,
    w7: [field('sales', 4, { simulated: 8, effective: 12, qualifies: true, rank: 1, needed: 0 })],
    hot7: [{ category: 'sales', interviews: 12, changePct: 20 }], hot30: [],
  })
  it('a finished simulation is put on this browser\'s homepage by default, and the screen says so', async () => {
    api.get.mockResolvedValue(real())
    api.post.mockResolvedValue(simulated())
    renderPage()
    await screen.findByText('Needs 6 more')
    expect(readPreview()).toBeNull()
    fireEvent.change(screen.getByLabelText(/Threshold/), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }))
    expect(await screen.findByTestId('home-active')).toHaveTextContent(/on your homepage right now/)
    expect(readPreview().hotCategories[7]).toEqual([{ category: 'sales', interviews: 12, changePct: 20 }])
    expect(screen.getByRole('link', { name: /Open my homepage/ })).toHaveAttribute('href', '/#hot')
  })
  it('with the switch off nothing reaches the homepage, and turning it off removes what was put there', async () => {
    api.get.mockResolvedValue(real())
    api.post.mockResolvedValue(simulated())
    renderPage()
    await screen.findByText('Needs 6 more')
    const sw = screen.getByRole('switch', { name: 'Show the simulation on my homepage' })
    fireEvent.click(sw)                                         // off
    fireEvent.change(screen.getByLabelText(/Threshold/), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }))
    await screen.findByText('Simulation on')
    expect(readPreview()).toBeNull()
    fireEvent.click(sw)                                         // on again: the existing simulation is applied
    expect(readPreview()).not.toBeNull()
    fireEvent.click(sw)                                         // off: it is taken back
    expect(readPreview()).toBeNull()
    expect(screen.queryByTestId('home-active')).toBeNull()
  })
  it('Reset ends the homepage preview too, and "End it" does the same without touching the simulation', async () => {
    api.get.mockResolvedValue(real())
    api.post.mockResolvedValue(simulated())
    renderPage()
    await screen.findByText('Needs 6 more')
    fireEvent.change(screen.getByLabelText(/Threshold/), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }))
    await screen.findByTestId('home-active')
    fireEvent.click(screen.getByRole('button', { name: 'End it' }))
    expect(readPreview()).toBeNull()
    expect(screen.getByText('Simulation on')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: 'Show the simulation on my homepage' }))   // off
    fireEvent.click(screen.getByRole('switch', { name: 'Show the simulation on my homepage' }))   // on: back
    expect(readPreview()).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(readPreview()).toBeNull()
    expect(screen.queryByText('Simulation on')).toBeNull()
  })
  it('a preview left from an earlier visit is shown as active so it can be ended', async () => {
    localStorage.setItem('pt:admin-hot-preview', JSON.stringify({ hotCategories: { 7: [{ category: 'sales', interviews: 12, changePct: null }], 30: [], minReports: 10 }, threshold: 10, savedAt: Date.now() }))
    api.get.mockResolvedValue(real())
    renderPage()
    expect(await screen.findByTestId('home-active')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'End it' }))
    expect(readPreview()).toBeNull()
  })
})

