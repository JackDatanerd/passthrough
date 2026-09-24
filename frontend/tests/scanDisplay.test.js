import { describe, it, expect } from 'vitest'
import { isLive, canDeleteScan, roleLine, scanSource, scanHeading, scanDetails, IN_FLIGHT_WINDOW_MS } from '../src/lib/scanDisplay.js'

const NOW = Date.parse('2026-09-24T12:00:00Z')
const ago = ms => new Date(NOW - ms).toISOString()
const MIN = 60 * 1000

describe('isLive / canDeleteScan — the server\'s one-hour rule, mirrored', () => {
  it('a finished scan is never live and is always deletable', () => {
    for (const status of ['COMPLETE_PASS', 'COMPLETE_FAIL', 'FIX_DELIVERED', 'ERROR']) {
      expect(isLive({ status, updatedAt: ago(1000) }, NOW)).toBe(false)
      expect(canDeleteScan({ status, updatedAt: ago(1000) }, NOW)).toBe(true)
    }
  })
  it('an in-flight scan touched recently is live and NOT deletable', () => {
    for (const status of ['PENDING', 'SCANNING', 'FIX_PURCHASED', 'FIX_GENERATING']) {
      expect(canDeleteScan({ status, updatedAt: ago(5 * MIN) }, NOW)).toBe(false)
      expect(isLive({ status, updatedAt: ago(59 * MIN) }, NOW)).toBe(true)
    }
  })
  it('an in-flight scan untouched for an hour or more is dead, not busy — deletable (it used to be disabled forever)', () => {
    expect(canDeleteScan({ status: 'PENDING', updatedAt: ago(IN_FLIGHT_WINDOW_MS + 1) }, NOW)).toBe(true)
    expect(canDeleteScan({ status: 'FIX_PURCHASED', updatedAt: ago(3 * 60 * MIN) }, NOW)).toBe(true)
    expect(isLive({ status: 'SCANNING', updatedAt: ago(2 * 60 * MIN) }, NOW)).toBe(false)
  })
  it('exactly at the window is dead (the server uses "older than the window")', () => {
    expect(isLive({ status: 'SCANNING', updatedAt: ago(IN_FLIGHT_WINDOW_MS) }, NOW)).toBe(false)
  })
  it('with no usable timestamp an in-flight scan is assumed live (button stays off, as before)', () => {
    for (const updatedAt of [undefined, null, 'not a date', '']) expect(isLive({ status: 'SCANNING', updatedAt }, NOW)).toBe(true)
  })
})

describe('labels', () => {
  it('roleLine joins seniority and role, tolerating either being absent', () => {
    expect(roleLine({ roleCategory: 'software_engineering', seniorityLevel: 'senior' })).toBe('Senior · Software Engineering')
    expect(roleLine({ roleCategory: 'sales' })).toBe('Sales')
    expect(roleLine({ seniorityLevel: 'lead' })).toBe('Lead')
    // 'mid' is the backend's "the JD did not say" default — never shown as if it were a finding
    expect(roleLine({ roleCategory: 'sales', seniorityLevel: 'mid' })).toBe('Sales')
    expect(roleLine({})).toBe('')
  })
  it('scanSource names the file, or how a fileless scan was made', () => {
    expect(scanSource({ resumeOriginalName: 'cv.pdf', inputMode: 'file' })).toBe('cv.pdf')
    expect(scanSource({ inputMode: 'brain_dump' })).toBe('Built from scratch')
    expect(scanSource({ inputMode: 'saved_profile' })).toBe('From saved profile')
    expect(scanSource({})).toBe('Resume')
  })
  it('the headline is the job when known, else the role, else the source', () => {
    const base = { inputMode: 'saved_profile' }
    expect(scanHeading({ ...base, jobTitle: 'Data Analyst', roleCategory: 'data_science' })).toBe('Data Analyst')
    expect(scanHeading({ ...base, roleCategory: 'data_science', seniorityLevel: 'senior' })).toBe('Senior · Data Science')
    expect(scanHeading(base)).toBe('From saved profile')
  })
  it('two rescans of one saved profile against different JDs are distinguishable', () => {
    const a = scanHeading({ inputMode: 'saved_profile', jobTitle: 'Data Analyst' })
    const b = scanHeading({ inputMode: 'saved_profile', jobTitle: 'Product Manager' })
    expect(a).not.toBe(b)
  })
  it('the small print carries only what the headline did not use', () => {
    expect(scanDetails({ inputMode: 'file', resumeOriginalName: 'cv.pdf', jobTitle: 'Analyst', roleCategory: 'data_science' })).toEqual(['cv.pdf', 'Data Science'])
    expect(scanDetails({ inputMode: 'file', resumeOriginalName: 'cv.pdf', roleCategory: 'data_science' })).toEqual(['cv.pdf'])
    expect(scanDetails({ inputMode: 'file', resumeOriginalName: 'cv.pdf' })).toEqual([])
  })
})
