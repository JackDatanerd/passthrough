import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const cs = require('../src/services/claude.service.js')

// Scan/ATS round 8: "3x" / "10x" multiplier claims are figures the fabrication guard must see.
describe('numbersIn — multiplier claims', () => {
  it('counts 3x and 10x as figures, and reads 3× and "3x" as the same value', () => {
    expect([...cs.numbersIn('10x faster builds, 3x growth')].sort((a, b) => a - b)).toEqual([3, 10])
    expect([...cs.numbersIn('3×')]).toEqual([...cs.numbersIn('3x')])
  })
  it('still treats a digit glued to letters (S3, EC2, B2B, 1920x1080) as a name, not a figure', () => {
    expect([...cs.numbersIn('S3 EC2 B2B Web3 1920x1080')]).toEqual([])
  })
})
describe('inventedNumbers — multipliers', () => {
  const resume = summary => ({ summary, experience: [] })
  it('flags an invented 10x', () => {
    expect(cs.inventedNumbers(resume('Faster builds'), resume('Delivered 10x faster builds'))).toEqual([10])
  })
  it('accepts a restated multiplier', () => {
    expect(cs.inventedNumbers(resume('Built 3x faster pipelines'), resume('Delivered 3× faster pipelines, three times the throughput'))).toEqual([])
  })
})
