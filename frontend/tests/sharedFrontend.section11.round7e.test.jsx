// @vitest-environment jsdom
// Section 11, round 7 — G1: DataTable matches the pages it replaces and does what they need.
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import DataTable from '../src/components/ui/DataTable'

const cols = [
  { key: 'name', header: 'Name', cell: r => <b>{r.name}</b>, cellClassName: 'text-gray-600' },
  { key: 'amt', header: 'Amount', className: 'text-right', cell: r => `$${r.amt}` },
  { key: 'act', header: <span className="sr-only">Actions</span>, cell: r => <button>Open {r.id}</button> },
]
const rows = [{ id: 1, name: 'A', amt: 5 }, { id: 2, name: 'B', amt: 9 }]

describe('DataTable', () => {
  it('renders a captioned table with scoped headers and the pages\' look', () => {
    const { container } = render(<DataTable caption="Things" columns={cols} rows={rows} rowKey={r => r.id} />)
    expect(container.querySelector('caption').textContent).toBe('Things')
    const ths = container.querySelectorAll('thead th'); expect(ths).toHaveLength(3)
    ths.forEach(th => expect(th.getAttribute('scope')).toBe('col'))
    expect(ths[0].className).toContain('px-4'); expect(ths[0].className).toContain('py-3')
    expect(container.querySelector('thead tr').className).toContain('text-gray-400')
    expect(container.querySelector('tbody').className).toContain('divide-y')
    expect(container.firstChild.className).toContain('overflow-x-auto')
  })
  it('an sr-only node header still names the column', () => {
    render(<DataTable caption="T" columns={cols} rows={rows} rowKey={r => r.id} />)
    expect(screen.getByRole('columnheader', { name: 'Actions' })).toBeTruthy()
  })
  it('className reaches header and cell; cellClassName only the cell; headerClassName only the header', () => {
    const { container } = render(<DataTable caption="T" columns={[{ key: 'a', header: 'A', className: 'text-right', headerClassName: 'HH', cellClassName: 'CC' }]} rows={[{ a: 1 }]} />)
    const th = container.querySelector('th'), td = container.querySelector('td')
    expect(th.className).toContain('text-right'); expect(th.className).toContain('HH'); expect(th.className).not.toContain('CC')
    expect(td.className).toContain('text-right'); expect(td.className).toContain('CC'); expect(td.className).not.toContain('HH')
  })
  it('compact density uses px-3 py-2', () => {
    const { container } = render(<DataTable caption="T" density="compact" columns={cols} rows={rows} />)
    expect(container.querySelector('td').className).toContain('px-3'); expect(container.querySelector('td').className).toContain('py-2')
  })
  it('default cell is row[col.key]; renderCell is used when there is no cell', () => {
    const { container } = render(<DataTable caption="T" columns={[{ key: 'name', header: 'N' }, { key: 'x', header: 'X' }]} rows={[{ name: 'Zed' }]} renderCell={(r, c) => (c.key === 'x' ? 'custom' : r[c.key])} />)
    expect([...container.querySelectorAll('td')].map(t => t.textContent)).toEqual(['Zed', 'custom'])
  })
  it('rowClassName works as a string or a function', () => {
    const { container, rerender } = render(<DataTable caption="T" columns={cols} rows={rows} rowClassName={r => (r.id === 2 ? 'bg-gray-50' : '')} />)
    const trs = container.querySelectorAll('tbody tr'); expect(trs[1].className).toBe('bg-gray-50'); expect(trs[0].className).toBe('')
    rerender(<DataTable caption="T" columns={cols} rows={rows} rowClassName="X" />)
    expect(container.querySelector('tbody tr').className).toBe('X')
  })
  it('expandedRow adds a full-width detail row under only that row', () => {
    const { container } = render(<DataTable caption="T" columns={cols} rows={rows} rowKey={r => r.id} expandedRow={r => (r.id === 1 ? <pre>detail</pre> : null)} />)
    const trs = container.querySelectorAll('tbody tr'); expect(trs).toHaveLength(3)
    expect(trs[1].querySelector('td').getAttribute('colspan')).toBe('3'); expect(trs[1].textContent).toBe('detail')
    expect(trs[2].textContent).toContain('B')
  })
  it('loading with no rows shows a spinner; with rows it dims and is aria-busy; empty shows the message', () => {
    const { container, rerender } = render(<DataTable caption="T" columns={cols} rows={[]} loading />)
    expect(screen.getByRole('status', { name: /loading/i })).toBeTruthy()
    rerender(<DataTable caption="T" columns={cols} rows={rows} loading />)
    expect(container.firstChild.getAttribute('aria-busy')).toBe('true'); expect(container.firstChild.className).toContain('opacity-60')
    rerender(<DataTable caption="T" columns={cols} rows={[]} empty="Nothing here." />)
    expect(screen.getByText('Nothing here.')).toBeTruthy()
    rerender(<DataTable caption="T" columns={cols} rows={[]} />)
    expect(container.firstChild).toBeNull()
  })
})

// Guard: tables go through DataTable (caption, scoped headers, one look). It had no caller for a long time because pages
// kept copying the markup; this keeps the copies from coming back.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
function walk(dir) { return readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.jsx') ? [p] : [] }) }
describe('no hand-rolled <table> outside DataTable', () => {
  it('finds none', () => {
    const offenders = walk('frontend/src').filter(f => !f.endsWith(join('components', 'ui', 'DataTable.jsx'))).filter(f => /<table[\s>]/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})
