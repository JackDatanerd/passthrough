import { describe, it, expect } from 'vitest'
import { randomSimulation } from '../src/lib/hotSimulation'
import { ROLE_CATEGORIES } from '../src/lib/roleCategories'

const CATS = ROLE_CATEGORIES.map(([k]) => k)
// A deterministic "random" source: cycles through the given values.
const seq = (...vals) => { let i = 0; return () => vals[i++ % vals.length] }
// A small seeded generator (mulberry32) for the property-style checks.
function seeded(seed) { let a = seed; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const effective = (sim, w, c, real = {}) => ((real[w] && real[w][c]) ? real[w][c].current : 0) + sim.adds[w][c]

describe('randomSimulation', () => {
  it('gives every field a number in both windows, for both the current and the previous period', () => {
    const sim = randomSimulation({ categories: CATS, threshold: 10, rng: seeded(1) })
    for (const w of [7, 30]) for (const c of CATS) {
      expect(Number.isInteger(sim.adds[w][c]) && sim.adds[w][c] >= 0, `adds ${w} ${c}`).toBe(true)
      expect(Number.isInteger(sim.prevAdds[w][c]) && sim.prevAdds[w][c] >= 0, `prev ${w} ${c}`).toBe(true)
    }
  })
  it('across many rolls: 3 to 11 fields clear the line in the 7-day window and at least one stays under it', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const sim = randomSimulation({ categories: CATS, threshold: 10, rng: seeded(seed) })
      const over = CATS.filter(c => effective(sim, 7, c) >= 10).length
      expect(over, `seed ${seed}`).toBeGreaterThanOrEqual(3)
      expect(over, `seed ${seed}`).toBeLessThanOrEqual(CATS.length - 1)
      expect(over).toBe(sim.hotCount)
    }
  })
  it('the month is never smaller than the week for any field', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const sim = randomSimulation({ categories: CATS, threshold: 7, rng: seeded(seed) })
      for (const c of CATS) expect(effective(sim, 30, c)).toBeGreaterThanOrEqual(effective(sim, 7, c))
    }
  })
  it('exercises every arrow kind across rolls: up, down, and too small to quote', () => {
    const kinds = new Set()
    for (let seed = 1; seed <= 50; seed++) {
      const sim = randomSimulation({ categories: CATS, threshold: 10, rng: seeded(seed) })
      for (const c of CATS) {
        const cur = effective(sim, 7, c), prev = sim.prevAdds[7][c]
        if (cur < 10) continue                          // only listed fields show an arrow
        if (prev < 5) kinds.add('none'); else kinds.add(cur > prev ? 'up' : cur < prev ? 'down' : 'flat')
      }
    }
    expect([...kinds]).toEqual(expect.arrayContaining(['up', 'down', 'none']))
  })
  it('adds only what is missing: a field already past its target gets nothing, and real counts are respected', () => {
    const real = { 7: { sales: { current: 500, previous: 500 } }, 30: { sales: { current: 500, previous: 500 } } }
    const sim = randomSimulation({ categories: CATS, threshold: 10, real, rng: seeded(3) })
    expect(sim.adds[7].sales).toBe(0)
    expect(sim.prevAdds[7].sales).toBe(0)
    expect(sim.adds[7].legal).toBeGreaterThanOrEqual(0)
  })
  it('is deterministic for a pinned random source (and re-rolls differ)', () => {
    const a = randomSimulation({ categories: CATS, threshold: 10, rng: seeded(42) })
    const b = randomSimulation({ categories: CATS, threshold: 10, rng: seeded(42) })
    const c = randomSimulation({ categories: CATS, threshold: 10, rng: seeded(43) })
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
  })
  it('works with a threshold of 1 and with very few fields', () => {
    const one = randomSimulation({ categories: CATS, threshold: 1, rng: seeded(9) })
    expect(CATS.filter(c => effective(one, 7, c) >= 1).length).toBeGreaterThanOrEqual(3)
    const two = randomSimulation({ categories: ['sales', 'legal'], threshold: 10, rng: seeded(9) })
    expect(Object.keys(two.adds[7])).toEqual(['sales', 'legal'])
    expect(randomSimulation({ categories: [], threshold: 10, rng: seq(0.5) }).hotCount).toBe(0)
  })
})
