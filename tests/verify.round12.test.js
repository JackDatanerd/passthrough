// Verify round 12 — admin report queue order, and public first-name parsing.
import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
const require = createRequire(import.meta.url)

// A stub that really applies .eq / .order / .range, unlike the shared in-memory double.
function sortingDb(reports) {
  return {
    from(table) {
      let rows = table === 'verification_reports' ? [...reports] : []
      const orders = []
      const q = {
        select() { return q },
        eq(col, val) { rows = rows.filter(r => r[col] === val); return q },
        in() { return q },
        order(col, { ascending = true } = {}) { orders.push([col, ascending]); return q },
        range(from, to) {
          for (const [col, asc] of [...orders].reverse()) rows = [...rows].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1))
          return Promise.resolve({ data: rows.slice(from, to + 1), error: null, count: rows.length })
        },
        then(res, rej) { return Promise.resolve({ data: [], error: null }).then(res, rej) },
      }
      return q
    },
  }
}

describe('admin verification-report queue order (round 12)', () => {
  const mk = (id, day, status = 'OPEN') => ({ id, code: 'AAAAAAAAAA', reason: 'FAKE', details: null, reporter_email: null, status, created_at: `2026-10-${day}T00:00:00Z`, reviewed_at: null })
  const reports = [mk('new', '09'), mk('old', '01'), mk('mid', '05'), mk('tieB', '05'), mk('c-old', '01', 'DISMISSED'), mk('c-new', '09', 'DISMISSED')]
  function run(query) {
    const { mod, restore } = loadWithStubs('controllers/admin.controller.js', { 'config/supabase.js': { getSupabase: () => sortingDb(reports) } })
    const ctx = { env: {}, req: { query: k => query[k], param: () => undefined }, get: () => null, json: (data, status = 200) => ({ status, data }) }
    return mod.adminListVerificationReports(ctx).finally(restore)
  }
  it('lists OPEN reports oldest first', async () => {
    const r = await run({})
    expect(r.data.data.map(x => x.id)).toEqual(['old', 'mid', 'tieB', 'new'])
  })
  it('a short first page holds the OLDEST open reports, not the newest', async () => {
    const r = await run({ pageSize: '2' })
    expect(r.data.data.map(x => x.id)).toEqual(['old', 'mid'])
  })
  it('lists closed reports newest first', async () => {
    const r = await run({ status: 'DISMISSED' })
    expect(r.data.data.map(x => x.id)).toEqual(['c-new', 'c-old'])
  })
})

describe('public first name: surname-first with titles and particles (round 12)', () => {
  const { publicFirstName } = require('../src/lib/text')
  const cases = [
    ['Dr. Doe, John', 'John'],               // a leading title no longer hides the comma
    ['Smith, Dr. John', 'John'],
    ['van der Berg, Jan', 'Jan'],            // was "van"
    ['De La Cruz, Maria', 'Maria'],
    ['de Souza, Ana', 'Ana'],
    ['Van Dyke, Dick', 'Dick'],
    ['Smith,John', 'John'],
    ['Doe, John', 'John'],                   // unchanged: the original rule
    ['Wanjiku, Mary Nelson', 'Mary'],
    ['John Smith, PhD', 'John'],             // a trailing qualification is not surname-first
    ['John, PhD', 'John'],                   // was null
    ['Reynolds, Jr.', 'Reynolds'],
    ['Nelson Kamau, CPA(K)', 'Nelson'],
    ['Jane Doe, Senior Engineer', 'Jane'],   // a job title after a comma is not a surname-first marker
    ['Van Persie', 'Van'],                   // particles without a comma are left alone
    ['Mba Chukwuemeka', 'Mba'],              // Mba is a name, not a credential...
    ['MBA Grace', 'Grace'],                  // ...unless it is written as one
    ['Dr. Doe,', null],                      // a surname-first leftover is no name
    ['Adhiambo,', null],
    ['Doe, Dr.', null],
  ]
  it.each(cases)('%s -> %s', (input, expected) => {
    expect(publicFirstName(input)).toBe(expected)
  })
})
