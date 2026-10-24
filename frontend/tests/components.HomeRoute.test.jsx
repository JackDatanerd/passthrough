// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'

vi.mock('../src/pages/Home', () => ({ default: () => <p>the homepage</p> }))
import { HomeRoute } from '../src/App'

function Where() { const l = useLocation(); return <p>at {l.pathname}{l.search}</p> }
const go = path => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes><Route path="/" element={<HomeRoute />} /><Route path="/scan" element={<Where />} /></Routes>
  </MemoryRouter>)

describe('old homepage scan links', () => {
  it('a bare / is the homepage', () => { go('/'); expect(screen.getByText('the homepage')).toBeInTheDocument() })
  it.each(['/?from=abc', '/?mode=manual', '/?mode=savedProfile&profile=p1'])('%s lands on /scan with the query intact', p => {
    go(p)
    expect(screen.getByText(`at /scan${p.slice(1)}`)).toBeInTheDocument()
  })
  it('unrelated params stay on the homepage', () => { go('/?utm_source=x'); expect(screen.getByText('the homepage')).toBeInTheDocument() })
})
