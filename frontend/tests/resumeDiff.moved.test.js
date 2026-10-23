import { describe, it, expect } from 'vitest'
import { alignBullets } from '../src/lib/resumeDiff.js'

describe('alignBullets: "moved" means a real change of order', () => {
  it('dropping the first bullet does not mark the rest as moved', () => {
    const out = alignBullets(['Built the billing service', 'Led the migration to new cloud', 'Mentored two junior engineers'], ['Led the migration to new cloud', 'Mentored two junior engineers'])
    expect(out.filter(b => b.status === 'unchanged').map(b => !!b.moved)).toEqual([false, false])
  })
  it('adding a bullet at the top does not mark the rest as moved', () => {
    const out = alignBullets(['Built the billing service', 'Led the migration to new cloud'], ['Wrote the onboarding guide', 'Built the billing service', 'Led the migration to new cloud'])
    expect(out.filter(b => b.status === 'unchanged').every(b => !b.moved)).toBe(true)
  })
  it('a swap is still reported as moved', () => {
    const out = alignBullets(['Built the billing service', 'Led the migration to new cloud'], ['Led the migration to new cloud', 'Built the billing service'])
    expect(out.some(b => b.moved)).toBe(true)
  })
})
