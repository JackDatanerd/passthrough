import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { ROLE_CATEGORIES, isRoleCategory, roleLabel } from '../src/lib/roleCategories.js'

const backend = createRequire(import.meta.url)('../../src/config/constants.js')

describe('roleCategories', () => {
  it('lists exactly the backend taxonomy keys, in the same order', () => {
    expect(ROLE_CATEGORIES.map(([k]) => k)).toEqual(backend.ROLE_CATEGORIES)
  })
  it('labels a key, humanises legacy text and tolerates empty values', () => {
    expect(roleLabel('data_science')).toBe('Data Science')
    expect(roleLabel('senior_engineer')).toBe('Senior Engineer')
    expect(roleLabel(null)).toBe('')
    expect(isRoleCategory('sales')).toBe(true)
    expect(isRoleCategory('Sales')).toBe(false)
  })
})
